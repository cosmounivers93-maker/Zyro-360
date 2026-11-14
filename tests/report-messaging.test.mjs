import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {installReportMessaging} from '../report-messaging.mjs';

function harness(){
 const routes=new Map(), db={users:{
  owner:{id:'owner',name:'Owner'},alice:{id:'alice',name:'Alice'},
  bob:{id:'bob',name:'Bob'},eve:{id:'eve',name:'Eve'}
 },userReports:[],adminAudit:[]};
 const app={get:(path,...handlers)=>routes.set('GET '+path,handlers),
   post:(path,...handlers)=>routes.set('POST '+path,handlers)};
 const auth=()=>{},admin=()=>{},limit=()=>{};
 let seq=0,saves=0;const notices=[];
 const service=installReportMessaging({app,getDb:()=>db,requireAuth:auth,
  requireAdmin:admin,limit,now:()=>1730000000000,token:()=>String(++seq),
  cleanText:(value,max)=>typeof value==='string'?value.trim().slice(0,max):'',
  save:()=>{saves++;},recordAction:(...args)=>db.adminAudit.push(args),
  isAdmin:u=>u?.id==='owner',notify:(...args)=>notices.push(args)});
 async function invoke(method,path,user,body={}){
  const handlers=routes.get(method+' '+path);
  assert.ok(handlers,'Route must exist');
  const req={user:db.users[user],body};
  const res={code:200,data:null,status(code){this.code=code;return this;},
   set(){return this;},json(value){this.data=value;return this;}};
  await handlers.at(-1)(req,res);
  return res;
 }
 return {db,routes,service,auth,admin,limit,invoke,notices,get saves(){return saves;}};
}

test('Report lifecycle automatically acknowledges and updates reporter',async()=>{
 const h=harness(),r={id:'case1',reporterId:'alice',userId:'bob',reason:'Messaggi offensivi',at:1730000000000,status:'open'};
 h.db.userReports.push(r);
 h.service.onCreated(r);
 assert.equal(r.messages.length,1);
 assert.equal(r.messages[0].to,'reporter');
 const own=await h.invoke('GET','/api/reports/mine','alice');
 assert.equal(own.data.reports.length,1);
 assert.equal(own.data.reports[0].reason,'Messaggi offensivi');
 const hidden=await h.invoke('GET','/api/reports/mine','bob');
 assert.deepEqual(hidden.data.reports,[]);
 r.status='in_review';h.service.onStatusChanged(r);
 assert.equal(r.messages[1].type,'automatic');
 assert.equal(r.messages[1].to,'reporter');
 assert.equal(h.notices.length,2);
});

test('Only the addressed user sees messages, without reporter identity',async()=>{
 const h=harness(),r={id:'case2',reporterId:'alice',userId:'bob',reason:'Dettagli riservati',at:1730000000000,status:'open'};
 h.db.userReports.push(r);h.service.onCreated(r);
 const route=h.routes.get('POST /api/admin/report-message');
 assert.equal(route[1],h.admin);
 const sent=await h.invoke('POST','/api/admin/report-message','owner',{
  reportId:'case2',recipient:'reported',body:'Stiamo verificando una segnalazione.'});
 assert.equal(sent.code,200);
 const target=await h.invoke('GET','/api/reports/mine','bob');
 assert.equal(target.data.reports.length,1);
 const serialized=JSON.stringify(target.data);
 assert.doesNotMatch(serialized,/alice|Dettagli riservati|reporterId|reason/);
 assert.match(serialized,/Stiamo verificando/);
 const unknown=await h.invoke('GET','/api/reports/mine','eve');
 assert.deepEqual(unknown.data.reports,[]);
 const denied=await h.invoke('POST','/api/reports/reply','eve',{reportId:'case2',body:'Salve'});
 assert.equal(denied.code,404);
 const replied=await h.invoke('POST','/api/reports/reply','bob',{reportId:'case2',body:'Posso spiegare'});
 assert.equal(replied.code,200);
 assert.equal(r.messages.at(-1).to,'admin');
 const seen=await h.invoke('POST','/api/reports/read','bob',{reportId:'case2'});
 assert.equal(seen.code,200);
 assert.ok(r.messages.find(m=>m.to==='reported').seenAt);
});

test('Frontend and backend JavaScript parse and the private inbox is linked',()=>{
 const frontend=readFileSync(new URL('../public/zyro-moderation-v1.js',import.meta.url),'utf8');
 assert.doesNotThrow(()=>new vm.Script(frontend));
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 assert.match(html,/id="zyroMyReports"/);
 assert.match(html,/zyro-moderation-v1\.js/);
 const syntax=spawnSync(process.execPath,['--check',new URL('../server.mjs',import.meta.url).pathname],{encoding:'utf8'});
 assert.equal(syntax.status,0,syntax.stderr);
});
