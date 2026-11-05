import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('Gallery, invitation acceptance, one-time codes, direct/group chat and free SOS',async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'zyro-user-flows-'));
  process.env.DATA_DIR=folder;
  process.env.ZYRO_REQUIRE_PERSISTENT_DB='false';
  process.env.GOOGLE_PLAY_BILLING_ENABLED='false';
  process.env.NODE_ENV='test';
  const {server,initializeStorage}=await import('../server.mjs');
  await initializeStorage();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const request=async(method,uri,payload,cookie)=>{
    const res=await fetch(base+uri,{
      method,headers:{...(payload?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},
      ...(payload?{body:JSON.stringify(payload)}:{})
    });
    return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
  };
  try {
    const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
    assert.ok(html.includes('id="avatarGallery"'));
    assert.ok(!html.includes('id="avatarCamera"'));
    assert.ok(html.includes('id="circleInviteDialog"'));
    assert.ok(html.includes('id="chatGroupRecipient"'));
    const alice=await request('POST','/api/register',{name:'Ada Alfa',email:'ada@example.test',password:'abc123456789'});
    const bob=await request('POST','/api/register',{name:'Bruno Beta',email:'bruno@example.test',password:'abc123456789'});
    assert.equal(alice.status,200);assert.equal(bob.status,200);
    const a=alice.cookie,b=bob.cookie;
    const as=await request('GET','/api/state',null,a);
    const bs=await request('GET','/api/state',null,b);
    assert.equal(as.data.me.features.sos,true);
    assert.equal(as.data.me.premiumActive,false);
    const circle=await request('POST','/api/circles',{name:'Cerchia fidata'},a);
    assert.equal(circle.status,200);
    const invite=await request('POST','/api/invites',{circleId:circle.data.circleId},a);
    assert.equal(invite.status,200);
    const outstanding=await request('POST','/api/invites/status',{codes:[invite.data.code]},a);
    assert.deepEqual(outstanding.data.activeCodes,[invite.data.code]);
    const notIssuer=await request('POST','/api/invites/status',{codes:[invite.data.code]},b);
    assert.deepEqual(notIssuer.data.activeCodes,[],'Other users cannot inspect a sender\'s invitations');
    const preview=await request('GET','/api/invites/preview?code='+encodeURIComponent(invite.data.code),null,b);
    assert.equal(preview.status,200);
    assert.equal(preview.data.inviterName,'Ada Alfa');
    assert.equal(preview.data.circleName,'Cerchia fidata');
    const stillOutside=await request('GET','/api/state',null,b);
    assert.equal(stillOutside.data.circles.length,0,'Preview must not enroll a user');
    const joined=await request('POST','/api/invites/join',{code:invite.data.code},b);
    assert.equal(joined.status,200);
    const consumed=await request('POST','/api/invites/status',{codes:[invite.data.code]},a);
    assert.deepEqual(consumed.data.activeCodes,[],'Offline sender must remove consumed code on next refresh');
    assert.equal((await request('GET','/api/invites/preview?code='+invite.data.code,null,b)).status,400);
    assert.equal((await request('POST','/api/invites/join',{code:invite.data.code},b)).status,400);
    const aliceState=await request('GET','/api/state',null,a);
    const bobState=await request('GET','/api/state',null,b);
    assert.equal(aliceState.data.circles[0].members.length,2);
    const aliceId=aliceState.data.me.id,bobId=bobState.data.me.id;
    const message=await request('POST','/api/chat/direct/'+bobId,{text:'Ciao Bruno'},a);
    assert.equal(message.status,200,'An accepted circle member must be direct-messagable');
    const incoming=await request('GET','/api/chat/direct/'+aliceId,null,b);
    assert.equal(incoming.status,200);
    assert.ok(incoming.data.messages.some(x=>x.text==='Ciao Bruno'));
    const group=await request('POST','/api/chat/groups',{name:'Amici vicini'},a);
    assert.equal(group.status,200);
    const groupInvite=await request('POST','/api/chat/groups/invite',{groupId:group.data.groupId},a);
    assert.equal(groupInvite.status,200);
    const groupJoin=await request('POST','/api/chat/groups/join',{code:groupInvite.data.code},b);
    assert.equal(groupJoin.status,200);
    const groupMsg=await request('POST','/api/chat/circle/'+group.data.groupId,{text:'Siamo in gruppo'},a);
    assert.equal(groupMsg.status,200);
    const groupIncoming=await request('GET','/api/chat/circle/'+group.data.groupId,null,b);
    assert.ok(groupIncoming.data.messages.some(m=>m.text==='Siamo in gruppo'));
    // Paid-only microphone must remain blocked even when SOS itself is free.
    const notAllowed=await request('POST','/api/settings/contact-access',
      {userId:bobId,shareGps:false,receiveSos:true,listenSosAudio:true,consentSosAudio:true},a);
    assert.equal(notAllowed.status,400);
    const recipients=await request('POST','/api/settings/sos-recipients',{recipients:[bobId]},a);
    assert.equal(recipients.status,200);
    const sos=await request('POST','/api/sos/start',{},a);
    assert.equal(sos.status,200,'Manual SOS must work for a free account');
    assert.equal(sos.data.serverRecorded,true);
    assert.ok((await request('GET','/api/state',null,b)).data.alerts.some(x=>x.userId===aliceId));
    assert.equal((await request('POST','/api/sos/stop',{},a)).status,200);
  }finally{
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(folder,{recursive:true,force:true});
  }
});
