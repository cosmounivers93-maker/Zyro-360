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

test('Emergency location is opt-in and guarded on server and client',()=>{
 assert.doesNotThrow(()=>new vm.Script(ui));
 assert.match(html,/id="emergencyConsentRegister"/);
 assert.match(html,/id="emergencyCenterToggle"/);
 assert.match(html,/id="adminEmergencies"/);
 assert.match(server,/app.get\('\/api\/admin\/emergencies',requireAuth,requireAdmin/);
 assert.match(server,/emergencyCenterConsent === true/);
 assert.match(server,/ADMIN_SOS_RETENTION_MS = 24/);
});

test('Private SOS center: allow only opted-in SOS, keep last position, revoke without circle', {skip:dependencies?false:'Requires npm install',timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'zyro-emergency-test-'));
 const ownerPassword='local-test-owner-password-2026',salt=crypto.randomBytes(12).toString('base64url');
 const pwHash=crypto.scryptSync(ownerPassword,salt,64).toString('hex');
 const owner={id:'owner-test',name:'Owner',email:'owner@example.test',salt,passwordHash:pwHash,
  createdAt:Date.now(),sharing:false,pushSubs:[],gpsRecipients:[],sosRecipients:[],avatar:null};
 writeFileSync(join(dir,'zyro360.json'),JSON.stringify({
   users:{'owner-test':owner},sessions:{},circles:{},memberships:[],invites:{},
   alerts:{},messages:{},chatViews:{},journeys:{},checkins:{},profileInvites:{},adminAudit:[],userReports:[]
 }));
 const port=await new Promise((resolve,reject)=>{
  const socket=createServer();socket.once('error',reject).listen(0,'127.0.0.1',()=>{
   const assigned=socket.address().port;socket.close(()=>resolve(assigned));
  });
 });
 const base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,
   PORT:String(port),DATA_DIR:dir,DATABASE_URL:'',ZYRO_REQUIRE_PERSISTENT_DB:'false',
   GOOGLE_PLAY_BILLING_ENABLED:'false',FIREBASE_SERVICE_ACCOUNT_JSON:'',
   VAPID_PUBLIC_KEY:'',VAPID_PRIVATE_KEY:'',ZYRO_ADMIN_USER_ID:'owner-test',
   ZYRO_SOS_GEOCODER_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',x=>logs+=x.toString());child.stderr.on('data',x=>logs+=x.toString());
 async function request(method,path,data,cookie){
  const r=await fetch(base+path,{method,headers:{...(data?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},
   ...(data?{body:JSON.stringify(data)}:{})});
  let body={};try{body=await r.json();}catch{}
  return {status:r.status,body,cookie:(r.headers.get('set-cookie')||'').split(';')[0]};
 }
 try{
  let ready=false;
  for(let i=0;i<130;i++){
   try{if((await request('GET','/api/health')).status===200){ready=true;break}}catch{}
   if(child.exitCode!==null)break;
   await new Promise(resolve=>setTimeout(resolve,70));
  }
  assert.ok(ready,'Server unavailable '+logs.slice(-1200));
  const admin=await request('POST','/api/login',{email:owner.email,password:ownerPassword});
  assert.equal(admin.status,200);
  const consented=await request('POST','/api/register',{name:'Consent',email:'consent@example.test',
    password:'safe-password-2026',emergencyCenterConsent:true});
  const privateUser=await request('POST','/api/register',{name:'Private',email:'private@example.test',
    password:'safe-password-2026',emergencyCenterConsent:false});
  assert.equal(consented.status,200);assert.equal(privateUser.status,200);
  const stateA=(await request('GET','/api/state',null,consented.cookie)).body;
  const stateB=(await request('GET','/api/state',null,privateUser.cookie)).body;
  assert.equal(stateA.me.emergencyCenterConsent,true);
  assert.equal(stateB.me.emergencyCenterConsent,false);
  for(const id of [stateA.me.id,stateB.me.id]){
   const gift=await request('POST','/api/admin/premium-gift',{password:ownerPassword,userId:id,enabled:true},admin.cookie);
   assert.equal(gift.status,200,JSON.stringify(gift.body));
  }
  const bad=await request('POST','/api/sos/start',{location:{lat:45.46,lon:9.19,accuracy:9}},privateUser.cookie);
  assert.equal(bad.status,400,'A non-consenting user cannot silently send an SOS to the owner.');
  const start=await request('POST','/api/sos/start',{location:{lat:45.46,lon:9.19,accuracy:12}},consented.cookie);
  assert.equal(start.status,200,JSON.stringify(start.body));
  const nonAdmin=await request('GET','/api/admin/emergencies',null,privateUser.cookie);
  assert.equal(nonAdmin.status,403,'Only the pinned admin identity may view.');
  let feed=await request('GET','/api/admin/emergencies',null,admin.cookie);
  assert.equal(feed.status,200);assert.equal(feed.body.emergencies.length,1);
  assert.equal(feed.body.emergencies[0].lastPosition.lat,45.46);
  const gps=await request('POST','/api/position',{lat:45.47,lon:9.20,accuracy:15},consented.cookie);
  assert.equal(gps.status,200,JSON.stringify(gps.body));
  feed=await request('GET','/api/admin/emergencies',null,admin.cookie);
  assert.equal(feed.body.emergencies[0].lastPosition.lat,45.47);
  const stop=await request('POST','/api/sos/stop',{},consented.cookie);
  assert.equal(stop.status,200);
  feed=await request('GET','/api/admin/emergencies',null,admin.cookie);
  assert.equal(feed.body.emergencies[0].active,false);
  assert.equal(feed.body.emergencies[0].lastPosition.lon,9.2);
  const revoke=await request('POST','/api/settings/emergency-center',{enabled:false},consented.cookie);
  assert.equal(revoke.status,200);
  feed=await request('GET','/api/admin/emergencies',null,admin.cookie);
  assert.deepEqual(feed.body.emergencies,[],'Revocation must immediately remove owner access.');
 }finally{
  child.kill('SIGTERM');
  await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(resolve,1000);});
  rmSync(dir,{recursive:true,force:true});
 }
});
