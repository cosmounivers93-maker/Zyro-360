import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const server = fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const client = fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html = fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const safetyStart=server.indexOf('const journeySosPushInFlight=new Set();');
const safetyEnd=server.indexOf("\napp.get('/api/premium/status'",safetyStart);
assert.ok(safetyStart>=0&&safetyEnd>safetyStart);

function safetyFixture({deadline=-1000, authorized=true, withJourney=false}={}){
 let time=Date.now();let serial=0;
 const pushes=[],events=[];
 const owner={id:'owner',name:'Marco',sosRecipients:authorized?['friend']:[]};
 const db={
  users:{owner,friend:{id:'friend',name:'Anna'}},alerts:{},
  journeys:withJourney?{owner:{id:'abc',userId:'owner',destination:'Casa',
    recipients:['friend'],responseBy:{friend:'accepted'},dueAt:time+deadline,status:'active'}}:{},
  checkins:withJourney?{}:{owner:{id:'def',userId:'owner',recipients:['friend'],dueAt:time+deadline,status:'pending'}}
 };
 const env={db,now:()=>time,token:()=>String(++serial),
  sharedCircle:(a,b)=>a==='owner'&&b==='friend',
  journeyDecision:(j,id)=>j.responseBy?.[id]||'pending',
  currentAlert:id=>Object.values(db.alerts).find(a=>a.userId===id&&a.active)||null,
  save:()=>events.push('saved'),refreshRelated:()=>events.push('refresh'),
  pushState:()=>events.push('state'),
  sendEventPush:async(ids,title,body,kind)=>{
   pushes.push({ids:[...ids],title,body,kind});
   return {attempted:ids.length,accepted:ids.length};
  },
  console:{error:()=>{}}
 };
 const overdueCheck=vm.runInNewContext(server.slice(safetyStart,safetyEnd)+'\noverdueCheck',env);
 return {db,pushes,events,tick:overdueCheck,flush:()=>new Promise(r=>setImmediate(r)),setTime:v=>{time=v}};
}

test('check-in pending before due time does not generate SOS',()=>{
 const x=safetyFixture({deadline:600000});x.tick();
 assert.equal(x.db.checkins.owner.status,'pending');
 assert.equal(Object.keys(x.db.alerts).length,0);
});
test('expired authorized check-in activates one SOS and sends high priority notification',async()=>{
 const x=safetyFixture();x.tick();await x.flush();
 assert.equal(x.db.checkins.owner.status,'late');
 const alerts=Object.values(x.db.alerts);
 assert.equal(alerts.length,1);
 assert.equal(alerts[0].kind,'sos');
 assert.equal(alerts[0].source,'checkin-deadline');
 assert.equal(alerts[0].checkinId,'def');
 assert.equal(x.db.checkins.owner.autoSosPushStatus,'provider-accepted');
 assert.equal(x.pushes.length,1);
 assert.deepEqual(x.pushes[0].ids,['friend']);
 assert.equal(x.pushes[0].kind,'sos');
 x.tick();await x.flush();
 assert.equal(Object.keys(x.db.alerts).length,1);
 assert.equal(x.pushes.length,1);
});
test('check-in never shares SOS with contacts missing per-person emergency authorization',async()=>{
 const x=safetyFixture({authorized:false});x.tick();await x.flush();
 assert.equal(Object.keys(x.db.alerts).length,0);
 assert.equal(x.db.checkins.owner.autoSosPushStatus,'no-authorized-recipient');
 assert.equal(x.pushes.length,0);
});
test('Accompagnami missed deadline remains protected from duplicate alerts',async()=>{
 const x=safetyFixture({withJourney:true});
 x.tick();await x.flush();
 assert.equal(x.db.journeys.owner.status,'late');
 assert.equal(Object.keys(x.db.alerts).length,1);
 assert.equal(x.db.alerts[Object.keys(x.db.alerts)[0]].source,'journey-deadline');
 x.tick();await x.flush();
 assert.equal(Object.keys(x.db.alerts).length,1);
});
test('GPS arrival requires movement outside destination and at least two accurate samples',()=>{
 const section=server.slice(server.indexOf("app.post('/api/position'"),server.indexOf('const configuredPush',server.indexOf("app.post('/api/position'")));
 assert.match(section,/observedOutsideDestination/);
 assert.match(section,/accuracy<=60/);
 assert.match(section,/t-j.lastNearAt>=8000/);
 assert.match(section,/j.nearCount>=2/);
 assert.match(section,/status='arrived'/);
 assert.match(section,/è arrivato a destinazione/);
 const start=server.slice(server.indexOf("app.post('/api/journey/start'"),server.indexOf("app.post('/api/journey/respond'"));
 assert.match(start,/autoArrival:!!point/);
});
test('requests are visible in Home and accept or decline without opening a section',()=>{
 assert.match(html,/id="homeJourneyRequests"/);
 assert.match(client,/renderHomeJourneyRequests\(\)/);
 assert.match(client,/richiede di potergli fare compagnia nel suo viaggio/);
 assert.match(client,/data-journey-answer="yes"/);
 assert.match(client,/data-journey-answer="no"/);
 assert.match(server,/Puoi iniziare il percorso/);
});
test('only finished recipient cards can be dismissed independently',()=>{
 const endpoint=server.slice(server.indexOf("app.post('/api/modes/dismiss'"),server.indexOf('setInterval(overdueCheck',server.indexOf("app.post('/api/modes/dismiss'")));
 assert.match(endpoint,/requireAuth/);
 assert.match(endpoint,/finished/);
 assert.match(endpoint,/sharedCircle/);
 assert.match(endpoint,/record.userId===req.user.id/);
 assert.match(server,/db.modeDismissals\?\.\[id\]/);
 assert.match(client,/data-dismiss-mode="journey"/);
 assert.match(client,/data-dismiss-mode="checkin"/);
});
test('mode instructions and Come funziona cover all new behaviors without redesigning Home',()=>{
 assert.match(html,/è arrivato a destinazione/);
 assert.match(html,/richiede di potergli fare compagnia/);
 assert.match(html,/SOS automatico/);
 assert.match(html,/schede concluse/);
 assert.match(html,/zyro-modes-v190\.css/);
});
