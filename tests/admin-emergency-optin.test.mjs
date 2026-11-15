import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const require=createRequire(import.meta.url);
let dependencies=true;
try{require.resolve('express');require.resolve('ws');}catch{dependencies=false;}
const root=fileURLToPath(new URL('../',import.meta.url));
const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const ui=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');

test('Admin SOS locations removed while normal SOS and chat are preserved',()=>{
 assert.doesNotThrow(()=>new vm.Script(ui));
 assert.doesNotMatch(html,/adminEmergencies|emergencyCenterToggle|emergencyConsentRegister/);
 assert.doesNotMatch(ui,/adminEmergencies|emergencyCenterToggle|emergencyConsentRegister/);
 assert.doesNotMatch(server,/app.get\('\/api\/admin\/emergencies'/);
 assert.doesNotMatch(server,/app.post\('\/api\/settings\/emergency-center'/);
 assert.doesNotMatch(server,/emergencyCenterEnabled\(/);
 assert.match(server,/app.post\('\/api\/sos\/start', requireAuth/);
 assert.match(server,/if\(!recipients\.length&&!alert\)return res\.status\(400\)/);
 assert.match(server,/const pushTargets=recipients/);
 assert.match(server,/app.get\('\/api\/chat\/summary', requireAuth/);
 assert.match(server,/app.get\('\/api\/chat\/:type\/:target', requireAuth/);
 assert.match(html,/id="chatForm"/);
 assert.match(html,/id="sosButton"/);
 assert.match(ui,/\$\('chatForm'\)\.addEventListener\('submit'/);
});

test('SOS remains visible to authorized circle members alongside their chat', {skip:dependencies?false:'Requires npm install',timeout:40000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'zyro-no-admin-gps-'));
 const ownerPassword='local-owner-password-for-tests-2026';
 const salt=crypto.randomBytes(12).toString('base64url');
 const owner={id:'owner-test',name:'Owner',email:'owner@example.test',salt,
  passwordHash:crypto.scryptSync(ownerPassword,salt,64).toString('hex'),
  createdAt:Date.now(),sharing:false,pushSubs:[],gpsRecipients:[],sosRecipients:[],avatar:null};
 writeFileSync(join(dir,'zyro360.json'),JSON.stringify({
  users:{'owner-test':owner},sessions:{},circles:{},memberships:[],invites:{},
  alerts:{},messages:{},chatViews:{},journeys:{},checkins:{},profileInvites:{},adminAudit:[],userReports:[]
 }));
 const port=await new Promise((resolve,reject)=>{
  const sock=createServer();sock.once('error',reject).listen(0,'127.0.0.1',()=>{
   const p=sock.address().port;sock.close(()=>resolve(p));
  });
 });
 const base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,
  PORT:String(port),DATA_DIR:dir,DATABASE_URL:'',ZYRO_REQUIRE_PERSISTENT_DB:'false',
  GOOGLE_PLAY_BILLING_ENABLED:'false',FIREBASE_SERVICE_ACCOUNT_JSON:'',
  VAPID_PUBLIC_KEY:'',VAPID_PRIVATE_KEY:'',ZYRO_ADMIN_USER_ID:'owner-test',
  ZYRO_SOS_GEOCODER_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',d=>logs+=d.toString());child.stderr.on('data',d=>logs+=d.toString());
 async function req(method,path,data,cookie){
  const r=await fetch(base+path,{method,headers:{...(data?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},
   ...(data?{body:JSON.stringify(data)}:{})});
  let body={};try{body=await r.json()}catch{}
  return {status:r.status,body,cookie:(r.headers.get('set-cookie')||'').split(';')[0]};
 }
 try{
  let ready=false;
  for(let i=0;i<130;i++){
   try{if((await req('GET','/api/health')).status===200){ready=true;break}}catch{}
   if(child.exitCode!==null)break;
   await new Promise(resolve=>setTimeout(resolve,70));
  }
  assert.ok(ready,'Server unavailable: '+logs.slice(-1200));
  const admin=await req('POST','/api/login',{email:owner.email,password:ownerPassword});
  assert.equal(admin.status,200);
  const alice=await req('POST','/api/register',{name:'Alice',email:'alice@example.test',
   password:'safe-password-2026',emergencyCenterConsent:true});
  const bob=await req('POST','/api/register',{name:'Bob',email:'bob@example.test',password:'safe-password-2026'});
  assert.equal(alice.status,200);assert.equal(bob.status,200);
  const aState=(await req('GET','/api/state',null,alice.cookie)).body;
  const bState=(await req('GET','/api/state',null,bob.cookie)).body;
  assert.equal(aState.me.emergencyCenterConsent,undefined,'Forged legacy opt-in cannot enable removed feature');
  const gift=await req('POST','/api/admin/premium-gift',{password:ownerPassword,userId:aState.me.id,enabled:true},admin.cookie);
  assert.equal(gift.status,200,JSON.stringify(gift.body));
  const circle=await req('POST','/api/circles',{name:'La nostra cerchia'},alice.cookie);
  assert.equal(circle.status,200,JSON.stringify(circle.body));
  const invite=await req('POST','/api/circles/group-code',{circleId:circle.body.circleId},alice.cookie);
  assert.equal(invite.status,200);
  const join=await req('POST','/api/circles/group-code/join',{code:invite.body.code},bob.cookie);
  assert.equal(join.status,200);
  const recipients=await req('POST','/api/settings/sos-recipients',{recipients:[bState.me.id]},alice.cookie);
  assert.equal(recipients.status,200);
  const alert=await req('POST','/api/sos/start',{location:{lat:45.46,lon:9.19,accuracy:15}},alice.cookie);
  assert.equal(alert.status,200,JSON.stringify(alert.body));
  assert.equal(alert.body.recipientCount,1,'Only Bob is an SOS recipient; no extra admin recipient');
  const bobAfter=(await req('GET','/api/state',null,bob.cookie)).body;
  assert.ok(bobAfter.alerts.some(a=>a.userId===aState.me.id && a.kind==='sos'),'Authorized user must see SOS');
  const rooms=(await req('GET','/api/chat/summary',null,bob.cookie)).body.rooms;
  assert.ok(rooms.some(r=>r.type==='circle' && r.id===circle.body.circleId),'Circle chat must remain available');
  const chat=await req('POST','/api/chat/circle/'+circle.body.circleId,{text:'Ti vedo nella chat'},alice.cookie);
  assert.equal(chat.status,200,JSON.stringify(chat.body));
  const messages=await req('GET','/api/chat/circle/'+circle.body.circleId,null,bob.cookie);
  assert.equal(messages.status,200);
  assert.ok(messages.body.messages.some(m=>m.text==='Ti vedo nella chat'));
  const stop=await req('POST','/api/sos/stop',{},alice.cookie);
  assert.equal(stop.status,200);
 }finally{
  child.kill('SIGTERM');
  await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(resolve,1000);});
  rmSync(dir,{recursive:true,force:true});
 }
});
