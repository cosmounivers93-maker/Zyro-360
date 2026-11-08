import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
let deps=true;
try{require.resolve('express');require.resolve('ws');}catch{deps=false;}
const root=fileURLToPath(new URL('../',import.meta.url));
const ui=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');

test('Chat creates no second group: Circles manages creation and Chat shows both room types',()=>{
 assert.match(html,/id="chatManageCirclesButton"/);
 assert.match(ui,/chatManageCirclesButton'\)\.addEventListener\('click',\(\)=>showView\('circles'\)/);
 assert.doesNotMatch(html,/id="chatGroupCreateForm"|id="chatGroupJoinForm"|id="chatGroupCreateOpen"|id="chatGroupJoinOpen"/);
 assert.match(ui,/data-chatdirect/);
 assert.match(ui,/data-chatcircle/);
 assert.match(ui,/openChat\('direct',b\.dataset\.chatdirect\)/);
 assert.match(ui,/openChat\('circle',b\.dataset\.chatcircle\)/);
 assert.match(ui,/view==='chats'&&!chatRoom&&current/);
 assert.match(ui,/chatSearch=''/);
 assert.match(ui,/roomList\._zyroSig=''/);
 assert.match(ui,/void refresh\(\)\.catch/);
 assert.match(ui,/refreshChatDirectory\(\)/);
 assert.match(ui,/circle\?\.kind==='chat'&&circle\?\.mine/);
 assert.match(html,/app\.js\?v=81\.0/);
 assert.match(server,/app\.post\('\/api\/circles', requireAuth/);
 assert.match(server,/function chatSummaryFor\(userId\)/);
});

test('Joining a circle creates both authorized direct and shared group chat endpoints, with no GPS grant',{
 timeout:40000,skip:deps?false:'Install dependencies before integration'
},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'zyro-chat-unified-'));
 const port=await new Promise((resolve,reject)=>{
  const sock=createServer();sock.once('error',reject).listen(0,'127.0.0.1',()=>{
   const p=sock.address().port;sock.close(()=>resolve(p));
  });
 });
 writeFileSync(join(dir,'zyro360.json'),JSON.stringify({users:{},sessions:{},circles:{},memberships:[],invites:{},profileInvites:{},alerts:{},messages:{},chatViews:{},journeys:{},checkins:{},adminAudit:[],userReports:[]}));
 const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{
  ...process.env,PORT:String(port),DATA_DIR:dir,DATABASE_URL:'',ZYRO_REQUIRE_PERSISTENT_DB:'false',
  GOOGLE_PLAY_BILLING_ENABLED:'false',FIREBASE_SERVICE_ACCOUNT_JSON:'',VAPID_PUBLIC_KEY:'',VAPID_PRIVATE_KEY:''
 },stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',d=>logs+=d.toString());child.stderr.on('data',d=>logs+=d.toString());
 const base='http://127.0.0.1:'+port;
 async function req(method,path,data,cookie){
  const r=await fetch(base+path,{method,headers:{...(data?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},...(data?{body:JSON.stringify(data)}:{})});
  let body={};try{body=await r.json();}catch{}
  return {status:r.status,body,cookie:(r.headers.get('set-cookie')||'').split(';')[0]};
 }
 try{
  let ready=false;for(let n=0;n<130;n++){
   try{if((await req('GET','/api/health')).status===200){ready=true;break;}}catch{}
   if(child.exitCode!==null)break;
   await new Promise(resolve=>setTimeout(resolve,70));
  }
  assert.ok(ready,'Server not ready: '+logs.slice(-1200));
  async function register(name){
   const r=await req('POST','/api/register',{name,email:name.toLowerCase()+'@example.test',password:'safe-password-2026'});
   assert.equal(r.status,200,JSON.stringify(r.body));
   return r.cookie;
  }
  const owner=await register('Anna'),member=await register('Bruno');
  const group=await req('POST','/api/circles',{name:'La famiglia',kind:'group'},owner);
  assert.equal(group.status,200,JSON.stringify(group.body));
  const code=await req('POST','/api/circles/group-code',{circleId:group.body.circleId},owner);
  assert.equal(code.status,200,JSON.stringify(code.body));
  const joinResult=await req('POST','/api/circles/group-code/join',{code:code.body.code},member);
  assert.equal(joinResult.status,200,JSON.stringify(joinResult.body));
  const ownerState=(await req('GET','/api/state',null,owner)).body;
  const memberState=(await req('GET','/api/state',null,member)).body;
  const circle=ownerState.circles.find(c=>c.id===group.body.circleId);
  assert.equal(circle.members.length,2);
  assert.equal(memberState.circles.find(c=>c.id===circle.id).members.length,2);
  assert.deepEqual(memberState.me.gpsRecipients,[]);
  const ownerId=ownerState.me.id,memberId=memberState.me.id;
  const myRooms=(await req('GET','/api/chat/summary',null,owner)).body.rooms;
  const theirRooms=(await req('GET','/api/chat/summary',null,member)).body.rooms;
  assert.equal(myRooms.find(r=>r.type==='circle'&&r.id===circle.id)?.title,'La famiglia');
  assert.equal(myRooms.find(r=>r.type==='circle'&&r.id===circle.id)?.memberCount,2);
  assert.equal(myRooms.find(r=>r.type==='direct'&&r.id===memberId)?.title,'Bruno');
  for(const [rooms,otherId] of [[myRooms,memberId],[theirRooms,ownerId]]){
   assert.ok(rooms.some(r=>r.type==='circle'&&r.id===circle.id),'Group chat not available after join');
   assert.ok(rooms.some(r=>r.type==='direct'&&r.id===otherId),'1:1 chat not available after join');
  }
  const msg1=await req('POST','/api/chat/direct/'+memberId,{text:'Ciao Bruno'},owner);
  assert.equal(msg1.status,200,JSON.stringify(msg1.body));
  const receive1=await req('GET','/api/chat/direct/'+ownerId,null,member);
  assert.equal(receive1.status,200);
  assert.ok(receive1.body.messages.some(m=>m.text==='Ciao Bruno'));
  const msg2=await req('POST','/api/chat/circle/'+circle.id,{text:'Ciao famiglia'},member);
  assert.equal(msg2.status,200,JSON.stringify(msg2.body));
  const receive2=await req('GET','/api/chat/circle/'+circle.id,null,owner);
  assert.equal(receive2.status,200);
  assert.ok(receive2.body.messages.some(m=>m.text==='Ciao famiglia'));
  const exit=await req('POST','/api/circles/leave',{circleId:circle.id},member);
  assert.equal(exit.status,200);
  const revoked=await req('GET','/api/chat/direct/'+ownerId,null,member);
  assert.equal(revoked.status,403,'Leaving all shared circles revokes access to private chat');
  const revokedGroup=await req('GET','/api/chat/circle/'+circle.id,null,member);
  assert.equal(revokedGroup.status,403,'Leaving group revokes access to group messages');
  // Joining an explicit two-person circle restores only the 1:1 conversation.
  const invite=await req('POST','/api/profile-invites',{profileId:memberState.me.profileId,mode:'direct'},owner);
  assert.equal(invite.status,200,JSON.stringify(invite.body));
  const accepted=await req('POST','/api/profile-invites/respond',{inviteId:invite.body.inviteId,decision:'accept'},member);
  assert.equal(accepted.status,200,JSON.stringify(accepted.body));
  const afterPrivate=(await req('GET','/api/state',null,owner)).body;
  const privateCircle=afterPrivate.circles.find(c=>c.kind==='direct'&&c.members.some(m=>m.id===memberId));
  assert.ok(privateCircle,'Accepted two-person circle should exist');
  const privateRooms=(await req('GET','/api/chat/summary',null,owner)).body.rooms;
  assert.ok(privateRooms.some(r=>r.type==='direct'&&r.id===memberId),'Private chat should appear');
  assert.ok(!privateRooms.some(r=>r.type==='circle'&&r.id===privateCircle.id),
    'Do not create duplicate group room for a direct circle');
 }finally{
  child.kill('SIGTERM');
  await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(resolve,1000)});
  rmSync(dir,{recursive:true,force:true});
 }
});
