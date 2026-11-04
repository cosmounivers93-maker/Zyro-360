import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const server=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const client=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const start=server.indexOf('const journeySosPushInFlight=new Set();');
const end=server.indexOf("\napp.get('/api/premium/status'",start);
assert.ok(start>=0&&end>start);

function fixture({status='active',delay=60000,recipients=['friend','declined']}={}){
 let time=Date.now();
 const pushes=[],states=[],db={users:{
  owner:{id:'owner',name:'Persona protetta'},
  friend:{id:'friend',name:'Amico'},
  declined:{id:'declined',name:'Rifiutato'}
 },journeys:{owner:{id:'journey1',userId:'owner',destination:'Casa',recipients,
  responseBy:{friend:'accepted',declined:'declined'},dueAt:time+delay,status}},alerts:{},checkins:{}};
 let counter=0,saves=0;
 const env={
  now:()=>time,db,
  sharedCircle:(a,b)=>a==='owner'&&['friend','declined'].includes(b),
  journeyDecision:(j,id)=>j.responseBy?.[id]||'pending',
  currentAlert:(id)=>Object.values(db.alerts).find(a=>a.userId===id&&a.active)||null,
  token:()=>String(++counter),save:()=>{saves++;},
  refreshRelated:id=>states.push(id),pushState:id=>states.push(id),
  alertAudience:a=>new Set([a.userId,...a.recipients]),
  connections:()=>[],sendSocket:()=>{},
  sendEventPush:async(ids,title,body,kind)=>{
   pushes.push({ids:[...ids],title,body,kind});
   return {attempted:ids.length,accepted:ids.length,configured:true};
  },
  console:{error(){}}
 };
 const tick=vm.runInNewContext(server.slice(start,end)+'\noverdueCheck',env);
 const flush=()=>new Promise(resolve=>setImmediate(resolve));
 return {env,db,pushes,states,tick,flush,get time(){return time},set time(v){time=v},get saves(){return saves}};
}

test('before the selected ETA, no automatic SOS is created',()=>{
 const x=fixture({delay:15*60000});x.tick();
 assert.equal(Object.keys(x.db.alerts).length,0);
 assert.equal(x.db.journeys.owner.status,'active');
 assert.equal(x.pushes.length,0);
});
test('missed ETA creates one SOS to chosen, non-declining circle contacts',async()=>{
 const x=fixture({delay:-60000});x.tick();await x.flush();
 const j=x.db.journeys.owner,alerts=Object.values(x.db.alerts);
 assert.equal(j.status,'late');assert.equal(alerts.length,1);
 assert.equal(alerts[0].kind,'sos');assert.equal(alerts[0].source,'journey-deadline');
 assert.deepEqual(Array.from(alerts[0].recipients),['friend']);
 assert.equal(j.autoSosAlertId,alerts[0].id);
 assert.equal(x.pushes.length,1);assert.deepEqual(x.pushes[0].ids,['friend']);
 assert.equal(x.pushes[0].kind,'sos');assert.match(x.pushes[0].body,/non ha confermato/);
 assert.equal(j.autoSosPushStatus,'provider-accepted');
 x.tick();await x.flush();
 assert.equal(Object.keys(x.db.alerts).length,1,'no duplicated SOS');
 assert.equal(x.pushes.length,1,'no duplicate notifications after acceptance');
});
test('already arrived/cancelled trips cannot trigger an overdue SOS',()=>{
 for(const status of ['arrived','cancelled']){
  const x=fixture({status,delay:-60000});x.tick();
  assert.equal(Object.keys(x.db.alerts).length,0,status);
  assert.equal(x.pushes.length,0,status);
 }
});
test('no new SOS is created if another alarm already exists',async()=>{
 const x=fixture({delay:-60000});
 x.db.alerts.existing={id:'existing',userId:'owner',active:true,kind:'pickpocket',recipients:['friend']};
 x.tick();await x.flush();
 assert.equal(Object.keys(x.db.alerts).length,1);
 assert.equal(x.db.journeys.owner.autoSosPushStatus,'existing-alert');
 assert.equal(x.pushes.length,0);
});
test('deadline is explicit, bounded and does not inherit legacy automatic GPS arrival',()=>{
 const start=server.slice(server.indexOf("app.post('/api/journey/start'"),server.indexOf("app.post('/api/journey/respond'"));
 assert.match(start,/Number\(req\.body\?\.dueAt\)/);
 assert.match(start,/dueAt,autoArrival:false/);
 assert.match(start,/storageKind!=='postgres'/);
 assert.match(start,/ZYRO_JOURNEY_SOS_ALWAYS_ON/);
 assert.match(start,/!fcmReady&&!configuredPush/);
 assert.match(html,/type="datetime-local"/);
 assert.doesNotMatch(html,/id="journeyAuto"/);
 assert.match(client,/post\('\/api\/journey\/start',\{destination,recipients,destinationPoint:journeyTarget,dueAt\}\)/);
});
