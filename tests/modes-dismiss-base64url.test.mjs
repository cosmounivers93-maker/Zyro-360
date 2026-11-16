import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const server=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const start=server.indexOf("app.post('/api/modes/dismiss'");
const end=server.indexOf('setInterval(overdueCheck',start);
assert.ok(start>=0 && end>start,'Completed-mode dismissal route is present');

function createFixture({type='checkin',status='confirmed',viewer='friend',recipient=true,shared=true,id='AZ-_bbCCddEEff'}={}){
 const record={id,userId:'owner',status,recipients:recipient?['friend']:[],completedAt:123,endedAt:123};
 const db={journeys:{},checkins:{},modeDismissals:{}};
 db[type==='journey'?'journeys':'checkins'].owner=record;
 const state={saved:0,pushed:[],shared};
 const routes={};
 const context={
  app:{post:(route,...middlewareAndHandler)=>{routes[route]=middlewareAndHandler.at(-1)}},
  requireAuth:()=>{},limit:()=>{},db,
  sharedCircle:(a,b)=>shared && a==='owner' && b==='friend',
  now:()=>1730000000000,
  save:()=>{state.saved++},
  pushState:(id)=>state.pushed.push(id)
 };
 vm.runInNewContext(server.slice(start,end),context);
 function dismiss(request={type,id},actor=viewer){
  const response={statusCode:200,body:null,status(code){this.statusCode=code;return this;},json(data){this.body=data;return this;}};
  routes['/api/modes/dismiss']({body:request,user:{id:actor}},response);
  return response;
 }
 return {record,db,state,dismiss};
}

test('new token(10) base64url identifier with - and _ can be dismissed by invited recipient',()=>{
 const testCase=createFixture();
 const response=testCase.dismiss();
 assert.equal(response.statusCode,200);
 assert.equal(response.body.ok,true);
 assert.equal(testCase.db.modeDismissals.friend.checkins['AZ-_bbCCddEEff'],1730000000000);
 assert.equal(testCase.record.status,'confirmed','dismissal must not undo confirmation');
 assert.equal(testCase.db.checkins.owner,testCase.record,'owner event is retained');
 assert.equal(testCase.state.saved,1);
 assert.deepEqual(testCase.state.pushed,['friend']);
});
test('completed Accompagnami card is dismissible, without deleting journey',()=>{
 const x=createFixture({type:'journey',status:'arrived',id:'fYGH8-_AAaaBbC'});
 const response=x.dismiss({type:'journey',id:x.record.id});
 assert.equal(response.statusCode,200);
 assert.equal(x.db.modeDismissals.friend.journeys[x.record.id],1730000000000);
 assert.equal(x.db.journeys.owner.status,'arrived');
});
test('legacy hex identifier remains compatible',()=>{
 const id='abc123def4567890';
 const x=createFixture({id,status:'cancelled'});
 assert.equal(x.dismiss({type:'checkin',id}).statusCode,200);
});
test('non-recipient, owner, missing shared circle and active records are rejected',()=>{
 const scenarios=[
  {recipient:false},{viewer:'owner'},{shared:false},{status:'pending'}
 ];
 for(const scenario of scenarios){
  const x=createFixture(scenario);
  const response=x.dismiss();
  assert.equal(response.statusCode,403,JSON.stringify(scenario));
  assert.equal(x.state.saved,0);
  assert.equal(x.db.modeDismissals.friend,undefined);
 }
});
test('invalid input is rejected without mutation',()=>{
 const x=createFixture();
 for(const id of ['', '../../secret', 'abc?def', '<script>', 'a'.repeat(120)]){
  const response=x.dismiss({type:'checkin',id});
  assert.equal(response.statusCode,400,id);
 }
 assert.equal(x.dismiss({type:'other',id:x.record.id}).statusCode,400);
 assert.equal(x.state.saved,0);
});
test('UI handles the X using the existing server route and state is per-recipient',()=>{
 assert.match(app,/data-dismiss-mode="checkin"/);
 assert.match(app,/data-dismiss-mode="journey"/);
 assert.match(app,/post\('\/api\/modes\/dismiss',\{type,id\}\)/);
 assert.match(server,/db\.modeDismissals\?\.\[id\]\?\.checkins\?\.\[c\.id\]/);
 assert.match(server,/db\.modeDismissals\?\.\[id\]\?\.journeys\?\.\[j\.id\]/);
});
