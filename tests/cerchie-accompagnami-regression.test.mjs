import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const client=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
function route(path,next,context){
  const begin=server.indexOf("app.post('"+path+"'");
  const end=server.indexOf("app.post('"+next+"'",begin+1);
  assert.ok(begin>=0&&end>begin,'route section found: '+path);
  const handlers={};
  vm.runInNewContext(server.slice(begin,end),{
    app:{post:(path,...args)=>handlers[path]=args.at(-1)},
    requireAuth:()=>{},limit:()=>{},MAX_USER_CIRCLES:12,...context
  });
  assert.equal(typeof handlers[path],'function');
  return handlers[path];
}
function response(){
  return {code:200,data:null,status(code){this.code=code;return this;},
    json(data){this.data=data;return this;}};
}
test('group invite is consumed by the first successful member only',()=>{
  const code='G'+'A'.repeat(18);
  const db={circles:{group:{id:'group',kind:'chat',ownerId:'owner'}},
    memberships:[{circleId:'group',userId:'owner'}],
    invites:{[code]:{kind:'group',circleId:'group',createdBy:'owner',expiresAt:200}}};
  const handler=route('/api/chat/groups/join','/api/circles',{
    db,hash:x=>x,now:()=>100,save:()=>{},refreshRelated:()=>{},
    memberIds:id=>db.memberships.filter(m=>m.circleId===id).map(m=>m.userId),
    userCircles:id=>db.memberships.filter(m=>m.userId===id)
  });
  const first=response();
  handler({body:{code},user:{id:'guest1'}},first);
  assert.equal(first.code,200);
  assert.equal(first.data.groupId,'group');
  assert.equal(db.invites[code],undefined);
  assert.equal(db.memberships.length,2);
  const second=response();
  handler({body:{code},user:{id:'guest2'}},second);
  assert.equal(second.code,400);
  assert.equal(db.memberships.length,2);
});

test('circle invite returns joined circle ID and cannot be reused',()=>{
  const code='B'.repeat(18);
  const db={circles:{circle:{id:'circle',ownerId:'owner'}},
    memberships:[{circleId:'circle',userId:'owner'}],
    invites:{[code]:{circleId:'circle',createdBy:'owner',expiresAt:200}}};
  const handler=route('/api/invites/join','/api/circles/leave',{
    db,hash:x=>x,now:()=>100,save:()=>{},refreshRelated:()=>{},
    memberIds:id=>db.memberships.filter(m=>m.circleId===id).map(m=>m.userId),
    userCircles:id=>db.memberships.filter(m=>m.userId===id)
  });
  const first=response();
  handler({body:{code},user:{id:'guest1'}},first);
  assert.equal(first.code,200);
  assert.equal(first.data.circleId,'circle');
  assert.equal(db.invites[code],undefined);
  const second=response();
  handler({body:{code},user:{id:'guest2'}},second);
  assert.equal(second.code,400);
});

test('all circles have shared chat entries, and join opens the new conversation',()=>{
  assert.match(client,/const circles=current\.circles\|\|\[\], contacts=uniqueContacts\(\)/);
  assert.match(client,/data-chatcircle/);
  assert.match(client,/if\(result\.circleId\)openChat\('circle',result\.circleId\)/);
  assert.match(client,/syncConsumedInviteCodes\(prev,data\)/);
  assert.match(html,/CODICE GRUPPO MONOUSO/);
});

test('incoming Accompagnami request supports explicit acceptance and refusal',()=>{
  assert.match(client,/function renderJourneyInvitePrompt\(/);
  assert.match(client,/data-incoming-choice="accept"/);
  assert.match(client,/data-incoming-choice="decline"/);
  assert.match(server,/sendEventPush\(recipients,'🚶 Richiesta Accompagnami'/);
  assert.match(server,/requestPushStatus=outcome\.accepted>0\?'provider-accepted':'not-accepted'/);
});
