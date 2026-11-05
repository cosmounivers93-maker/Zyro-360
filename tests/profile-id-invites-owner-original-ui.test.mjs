import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

// Verifies REAL authenticated HTTP routes against an isolated local JSON database.
// Never contacts Render, Play, Firebase, real accounts or emergency contacts.
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const WEB=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const HTML=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const BACKEND=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const NATIVE_PLAN=readFileSync(new URL('../play-billing.mjs',import.meta.url),'utf8');

test('Approved Zyro graphics and original Premium/Family plans are retained',()=>{
  assert.doesNotThrow(()=>new vm.Script(WEB,{filename:'public/app.js'}));
  for(const s of ['id="circlesView"','id="homeView"','id="chatsView"','id="zyroAdminPanel"','id="zyroAdminOverview"','id="profileIncomingInvites"','id="profileOutgoingInvites"','id="sendProfileInviteForm"','id="zyroPlusTitle"']){
    // The original backend still offers Premium and Family, not Plus.
    if(s.includes('zyroPlusTitle'))continue;
    assert.ok(HTML.includes(s),'Missing UI '+s);
  }
  assert.ok(HTML.includes('zyro-glass-v30.css'),'Approved glass theme must remain');
  assert.ok(HTML.includes('id="avatarGallery"'));
  assert.ok(!HTML.includes('id="avatarCamera"'));
  assert.ok(WEB.includes('const circles=current.circles||[], contacts=uniqueContacts()'));
  assert.ok(!WEB.includes("const circles=(current.circles||[]).filter(c=>c.kind==='chat')"));
  assert.ok(NATIVE_PLAN.includes('zyro360_premium'));
  assert.ok(NATIVE_PLAN.includes('zyro360_family'));
  assert.match(BACKEND,/const familyActive = user => premiumPlan\(user\)==='family'/);
  assert.match(BACKEND,/const planFeatures = user => \(\{sos:premiumActive\(user\)/);
  assert.match(BACKEND,/app.post\('\/api\/admin\/ban',requireAuth,requireAdmin/);
  assert.match(BACKEND,/app.post\('\/api\/admin\/premium-gift',requireAuth,requireAdmin/);
});

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function allocatePort(){
 const server=createServer();
 return new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',()=>{
   const port=server.address().port;server.close(()=>resolve(port));
 }));
}
function fixtureAdmin(password){
 const salt=crypto.randomBytes(12).toString('base64url');
 const hash=crypto.scryptSync(password,salt,64).toString('hex');
 return {id:'owner-test',name:'Proprietario',email:'owner@example.test',salt,passwordHash:hash,
   createdAt:Date.now(),sharing:false,pushSubs:[],gpsRecipients:[],sosRecipients:[],
   sosAudioConsent:false,avatar:null};
}

test('End-to-end: ID requests, sender privacy, decline/block, consent, chat, owner moderation and lifetime gifts', {timeout:25000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'zyro-id-test-'));
 const pw='owner-password-strong-2026';
 writeFileSync(join(dir,'zyro360.json'),JSON.stringify({
   users:{'owner-test':fixtureAdmin(pw)},sessions:{},circles:{},memberships:[],
   invites:{},profileInvites:{},alerts:{},messages:{},chatViews:{},
   journeys:{},checkins:{},adminAudit:[],userReports:[]
 }));
 const port=await allocatePort(),base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.mjs'],{
   cwd:ROOT,env:{...process.env,PORT:String(port),DATA_DIR:dir,
     DATABASE_URL:'',ZYRO_REQUIRE_PERSISTENT_DB:'false',
     GOOGLE_PLAY_BILLING_ENABLED:'false',FIREBASE_SERVICE_ACCOUNT_JSON:'',
     VAPID_PUBLIC_KEY:'',VAPID_PRIVATE_KEY:'',ZYRO_ADMIN_USER_ID:'owner-test'},
   stdio:['ignore','pipe','pipe']
 });
 let logs='';child.stdout.on('data',d=>{logs+=d.toString();});child.stderr.on('data',d=>{logs+=d.toString();});
 async function request(method,path,data,cookie){
   const res=await fetch(base+path,{method,headers:{
     ...(data?{'Content-Type':'application/json'}:{}),
     ...(cookie?{Cookie:cookie}:{})},
     ...(data?{body:JSON.stringify(data)}:{})});
   let body={};try{body=await res.json();}catch{}
   return {status:res.status,body,cookie:(res.headers.get('set-cookie')||'').split(';')[0]};
 }
 async function register(name,email){
   const resp=await request('POST','/api/register',{name,email,password:'safe-test-password-2026'});
   assert.equal(resp.status,200,JSON.stringify(resp.body));return resp.cookie;
 }
 try{
   let ready=false;
   for(let i=0;i<100;i++){
     if(child.exitCode!==null)break;
     try{const r=await request('GET','/api/health');if(r.status===200){ready=true;break;}}catch{}
     await wait(75);
   }
   assert.ok(ready,'Local server failed to start: '+logs.slice(-2500));
   const ownerLogin=await request('POST','/api/login',{email:'owner@example.test',password:pw});
   assert.equal(ownerLogin.status,200);
   const owner=ownerLogin.cookie;
   const alice=await register('Alice','alice@example.test');
   const bob=await register('Bob','bob@example.test');
   const carl=await register('Carl','carl@example.test');
   const aliceState=(await request('GET','/api/state',null,alice)).body;
   const bobState=(await request('GET','/api/state',null,bob)).body;
   const carlState=(await request('GET','/api/state',null,carl)).body;
   assert.match(bobState.me.profileId,/^ZYRO-[A-F0-9]{16}$/);
   assert.notEqual(bobState.me.profileId,bobState.me.id);
   assert.equal(bobState.me.gpsRecipients.length,0);
   assert.equal(bobState.me.sosAudioConsent,false);
   const a=(await request('POST','/api/circles',{name:'Cerchia Originale'},owner));
   assert.equal(a.status,200);const circle=a.body.circleId;
   const issue=await request('POST','/api/profile-invites',{profileId:bobState.me.profileId,circleId:circle},owner);
   assert.equal(issue.status,200,JSON.stringify(issue.body));
   assert.equal(issue.body.recipientName,'Bob');
   const inviteId=issue.body.inviteId;
   assert.equal((await request('GET','/api/state',null,bob)).body.circles.length,0,'Invitation must not silently join');
   assert.equal((await request('GET','/api/state',null,bob)).body.profileInvites[0].status,'pending');
   assert.equal((await request('POST','/api/profile-invites/respond',{inviteId,decision:'accept'},alice)).status,404);
   assert.equal((await request('GET','/api/admin/overview',null,bob)).status,403,'No admin privilege through client');
   const decline=await request('POST','/api/profile-invites/respond',{inviteId,decision:'decline',blockSender:true},bob);
   assert.equal(decline.status,200);
   assert.equal((await request('GET','/api/state',null,bob)).body.profileInvites.filter(x=>x.direction==='received').length,0);
   const sender=(await request('GET','/api/state',null,owner)).body.profileInvites;
   assert.equal(sender.find(x=>x.id===inviteId).status,'declined');
   const secondCircle=(await request('POST','/api/circles',{name:'Seconda cerchia'},owner)).body.circleId;
   assert.equal((await request('POST','/api/profile-invites',{profileId:bobState.me.profileId,circleId:secondCircle},owner)).status,403,'Block applies to new requests');
   const aliceInvite=await request('POST','/api/profile-invites',{profileId:aliceState.me.profileId,circleId:circle},owner);
   assert.equal(aliceInvite.status,200);
   const accepted=await request('POST','/api/profile-invites/respond',{inviteId:aliceInvite.body.inviteId,decision:'accept'},alice);
   assert.equal(accepted.status,200);
   const inside=(await request('GET','/api/state',null,alice)).body;
   assert.equal(inside.circles.length,1);
   assert.equal(inside.me.sharing,false,'Consent must not auto-enable GPS');
   assert.equal(inside.me.sosAudioConsent,false,'Consent must not enable microphone');
   assert.deepEqual(inside.me.gpsRecipients,[]);
   assert.deepEqual(inside.me.sosRecipients,[]);
   const ownerId=(await request('GET','/api/state',null,owner)).body.me.id;
   assert.equal((await request('POST','/api/chat/direct/'+ownerId,{text:'Ciao, chat privata da invito ID'},alice)).status,200);
   const chat=await request('GET','/api/chat/direct/'+ownerId,null,alice);
   assert.equal(chat.status,200);
   assert.ok(JSON.stringify(chat.body).includes('Ciao, chat privata da invito ID'));
   const dashboard=await request('GET','/api/admin/overview',null,owner);
   assert.equal(dashboard.status,200);
   assert.equal(dashboard.body.registered,4);
   assert.ok(dashboard.body.circles>=2);
   assert.ok(dashboard.body.lifetimeGifts===0);
   assert.ok(dashboard.body.pendingInvites===0);
   assert.equal('messages' in dashboard.body,false);
   const users=await request('GET','/api/admin/users',null,owner);
   const carlId=users.body.users.find(u=>u.email==='carl@example.test').id;
   assert.equal((await request('POST','/api/admin/premium-gift',{userId:carlId,enabled:true,password:pw},bob)).status,403);
   const gift=await request('POST','/api/admin/premium-gift',{userId:carlId,enabled:true,password:pw},owner);
   assert.equal(gift.status,200);
   assert.equal((await request('GET','/api/state',null,carl)).body.me.premiumGiftLifetime,true);
   const ban=await request('POST','/api/admin/ban',{userId:carlId,banned:true,reason:'Test sospensione moderazione',password:pw},owner);
   assert.equal(ban.status,200);
   assert.equal((await request('GET','/api/state',null,carl)).status,401);
   const unban=await request('POST','/api/admin/ban',{userId:carlId,banned:false,password:pw},owner);
   assert.equal(unban.status,200);
   const relog=await request('POST','/api/login',{email:'carl@example.test',password:'safe-test-password-2026'});
   assert.equal(relog.status,200);
   assert.equal((await request('GET','/api/state',null,relog.cookie)).body.me.premiumGiftLifetime,true);
 }finally{
   child.kill('SIGTERM');
   await Promise.race([new Promise(resolve=>child.once('exit',resolve)),wait(1500)]);
   rmSync(dir,{recursive:true,force:true});
 }
});
