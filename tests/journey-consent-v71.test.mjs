import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const server=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const client=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');

function consentModel(){
 const from=server.indexOf('function journeyDecision(');
 const to=server.indexOf('const publicCheckin =',from);
 assert.ok(from>0&&to>from,'consent helpers present');
 const now=Date.now();
 const journey={id:'j1',userId:'owner',recipients:['friend'],
  destination:'Casa',destinationPoint:{lat:45.4,lon:9.1},
  startedAt:now,dueAt:now+600000,status:'active',responseBy:{}};
 const context={db:{journeys:{owner:journey},users:{
  owner:{id:'owner',name:'Proprietario',sharing:true},friend:{id:'friend',name:'Amico'}}},
  locations:new Map([['owner',{lat:45.2,lon:9.2,updatedAt:now}]]),
  sharedCircle:(a,b)=>a==='owner'&&b==='friend',now:()=>now};
 const helpers=vm.runInNewContext(server.slice(from,to)+';({publicJourney,journeyAccessFor})',context);
 return {journey,context,...helpers};
}

test('pending follower may read invitation only, never location or destination coordinates',()=>{
 const x=consentModel();
 const pending=x.publicJourney(x.journey,'friend');
 assert.equal(pending.response,'pending');
 assert.equal(pending.destination,'Casa');
 assert.equal(pending.destinationPoint,null);
 assert.equal(pending.currentPoint,null);
 assert.equal(x.journeyAccessFor('owner','friend'),false);
 assert.equal(x.publicJourney(x.journey,'stranger'),null);
});

test('only accepting recipient gets temporary route location, revocable at any time',()=>{
 const x=consentModel();
 x.journey.responseBy.friend='accepted';
 const accepted=x.publicJourney(x.journey,'friend');
 assert.deepEqual({...accepted.destinationPoint},{lat:45.4,lon:9.1});
 assert.deepEqual({...accepted.currentPoint},{lat:45.2,lon:9.2,updatedAt:x.context.now()});
 assert.equal(x.journeyAccessFor('owner','friend'),true);
 x.journey.responseBy.friend='declined';
 assert.equal(x.journeyAccessFor('owner','friend'),false);
 assert.equal(x.publicJourney(x.journey,'friend'),null);
});

test('sharing ends after cancellation or GPS disabled',()=>{
 const x=consentModel();
 x.journey.responseBy.friend='accepted';
 x.context.db.users.owner.sharing=false;
 assert.equal(x.journeyAccessFor('owner','friend'),false);
 assert.equal(x.publicJourney(x.journey,'friend').currentPoint,null);
 x.context.db.users.owner.sharing=true;x.journey.status='cancelled';
 assert.equal(x.journeyAccessFor('owner','friend'),false);
 assert.equal(x.publicJourney(x.journey,'friend').currentPoint,null);
});

test('request acceptance is authenticated, scoped and does not start a new SOS',()=>{
 const pos=server.indexOf("app.post('/api/journey/respond'");
 assert.ok(pos>=0);
 const section=server.slice(pos,server.indexOf("app.post('/api/journey/end'",pos));
 for(const rule of ['requireAuth','journeyId','recipients||[]','sharedCircle','responseBy','accept','refreshRelated'])assert.ok(section.includes(rule),rule);
 assert.ok(!section.includes("'/api/sos/start'"));
 assert.ok(server.includes("'🚶 Richiesta Accompagnami'"));
});

test('UI has separate explicit groups, direct chats and fresh destination steps',()=>{
 assert.ok(client.includes("const circles=current.circles||[], contacts=uniqueContacts()"),'Personal circles and optional chat groups must both be visible in Chat');
 assert.ok(client.includes("title:enabled?'Autorizza tutte le funzioni':'Revoca tutte le autorizzazioni'"));
 for(const id of ['journeyFindAddress','journeyAddressResults','journeyViewMap','journeyPreviewCancel','journeyPreviewSet'])
  assert.ok(html.includes('id="'+id+'"'),id);
 assert.ok(!html.includes('Riattiva Accompagnami'));
 assert.ok(client.includes("data-journey-answer"));
 assert.ok(client.includes("Apri navigazione stradale"));
});
