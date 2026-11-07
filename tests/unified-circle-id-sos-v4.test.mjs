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
let deps=false;try{require.resolve('express');require.resolve('ws');deps=true;}catch{}
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const ui=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/zyro-final-circle-status-v4.css',import.meta.url),'utf8');

test('SOS rapido runs the real authenticated SOS endpoint; provider acceptance is not delivery confirmation',()=>{
 assert.match(ui,/\$\('sosButton'\)\.addEventListener\('click',\(\)=>action\(startSOS\)\)/);
 assert.match(ui,/post\('\/api\/sos\/start',\{location:/);
 assert.match(ui,/GPS non disponibile/);
 assert.match(server,/app\.post\('\/api\/sos\/start', requireAuth/);
 assert.match(server,/if \(!premiumActive\(req\.user\)\)/);
 assert.match(server,/if\(!recipients\.length&&!alert\)/);
 assert.match(server,/const push=await sendEventPush\(recipients/);
 assert.match(ui,/ricezione non garantita/);
 assert.match(html,/SOS rapido: invia un avviso/);
 assert.match(html,/Chiama 112/);
});

test('group circle is the same group for map and chat, with opt-in GPS and limit 20',()=>{
 assert.match(server,/const MAX_GROUP_MEMBERS = 20/);
 assert.match(server,/db\.circles\[id\]=\{id,name,ownerId:req\.user\.id,kind:'group'/);
 assert.match(server,/memberIds\(group\.id\)\.length>=MAX_GROUP_MEMBERS/);
 assert.match(server,/return !!owner\?\.sharing && gpsRecipientsFor\(owner\)\.includes\(viewerId\)/);
 assert.match(ui,/group\.kind!=='direct'/);
 assert.match(html,/stessa cerchia/);
});

test('direct invite creates private two-person circle only after acceptance, no GPS grants',()=>{
 assert.match(server,/invite\.kind==='direct'&&!invite\.circleId/);
 assert.match(server,/circle=\{id,name:cleanText\(sender\.name\+'/);
 assert.match(server,/circleCapacity = circle => circle\?\.kind === 'direct' \? 2/);
 assert.match(ui,/mode==='direct'\?\{profileId,mode:'direct'\}/);
 assert.match(html,/cerchia privata si crea automaticamente/);
});
test('glass status and single planned 2,99 subscription are visible but Play migration remains separate',()=>{
 assert.match(css,/header\.topbar > \.connection-pill/);
 assert.match(css,/#connectionDot\.connected/);
 assert.match(html,/2,99 €/);
 assert.doesNotMatch(html,/ZYRO Family<\/h3>/);
 assert.match(html,/prodotto e il prezzo devono ancora essere attivati definitivamente in Google Play/);
 assert.match(server,/const familyActive = user => premiumActive\(user\)/);
 assert.match(server,/premiumGiftLifetime/);
});

test('authenticated direct and group memberships: consent, cap and no automatic GPS', {timeout:30000,skip:deps?false:'Needs npm dependencies in CI'},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'zyro-group-v4-'));const port=await new Promise((resolve,reject)=>{
 const s=createServer();s.once('error',reject).listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))});
 });
 writeFileSync(join(dir,'zyro360.json'),JSON.stringify({users:{},sessions:{},circles:{},memberships:[],invites:{},profileInvites:{},alerts:{},messages:{},chatViews:{},journeys:{},checkins:{},adminAudit:[],userReports:[]}));
 const child=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,PORT:String(port),DATA_DIR:dir,DATABASE_URL:'',ZYRO_REQUIRE_PERSISTENT_DB:'false',GOOGLE_PLAY_BILLING_ENABLED:'false',FIREBASE_SERVICE_ACCOUNT_JSON:'',VAPID_PUBLIC_KEY:'',VAPID_PRIVATE_KEY:''},stdio:['ignore','pipe','pipe']});
 let logs='';child.stderr.on('data',d=>logs+=d.toString());child.stdout.on('data',d=>logs+=d.toString());
 const base='http://127.0.0.1:'+port;
 async function req(method,path,data,cookie){
  const res=await fetch(base+path,{method,headers:{...(data?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},...(data?{body:JSON.stringify(data)}:{})});
  let body={};try{body=await res.json()}catch{}
  return {status:res.status,body,cookie:(res.headers.get('set-cookie')||'').split(';')[0]};
 }
 async function register(name){
  const r=await req('POST','/api/register',{name,email:name.toLowerCase()+'@example.test',password:'safe-password-2026'});
  assert.equal(r.status,200,JSON.stringify(r.body));return r.cookie;
 }
 try{
  let ready=false;
  for(let n=0;n<120;n++){
   try{if((await req('GET','/api/health')).status===200){ready=true;break}}catch{}
   if(child.exitCode!==null)break;
   await new Promise(resolve=>setTimeout(resolve,65));
  }
  assert.ok(ready,'Server not ready '+logs.slice(-1500));
  const owner=await register('Anna'),bob=await register('Bruno'),carl=await register('Carlo');
  const bState=(await req('GET','/api/state',null,bob)).body;
  const invite=await req('POST','/api/profile-invites',{profileId:bState.me.profileId,mode:'direct'},owner);
  assert.equal(invite.status,200,JSON.stringify(invite.body));
  let before=(await req('GET','/api/state',null,owner)).body;
  assert.equal(before.circles.length,0,'Never create the private circle before acceptance');
  const yes=await req('POST','/api/profile-invites/respond',{inviteId:invite.body.inviteId,decision:'accept'},bob);
  assert.equal(yes.status,200,JSON.stringify(yes.body));
  const after=(await req('GET','/api/state',null,owner)).body;
  const priv=after.circles.find(c=>c.kind==='direct');
  assert.ok(priv,'Private circle not created');
  assert.equal(priv.members.length,2);
  assert.equal(priv.memberLimit,2);
  assert.deepEqual(after.me.gpsRecipients,[]);
  const group=await req('POST','/api/chat/groups',{name:'La famiglia'},owner);
  assert.equal(group.status,200,JSON.stringify(group.body));
  const state=(await req('GET','/api/state',null,owner)).body;
  const family=state.circles.find(c=>c.id===group.body.groupId);
  assert.equal(family.kind,'group','Chat created a real group circle');
  assert.equal(family.memberLimit,20);
  const code=await req('POST','/api/chat/groups/invite',{groupId:group.body.groupId},owner);
  assert.equal(code.status,200,JSON.stringify(code.body));
  for(const cookie of [bob,carl]){
   const join=await req('POST','/api/chat/groups/join',{code:code.body.code},cookie);
   assert.equal(join.status,200,JSON.stringify(join.body));
  }
  const three=(await req('GET','/api/state',null,owner)).body.circles.find(c=>c.id===group.body.groupId);
  assert.equal(three.members.length,3,'Same group membership shared by map and chat');
  assert.equal((await req('GET','/api/state',null,carl)).body.me.sharing,false,'Joining must not activate GPS');
  assert.equal((await req('GET','/api/state',null,bob)).body.me.sharing,false);
  const noPlan=await req('POST','/api/sos/start',{},bob);
  assert.equal(noPlan.status,402,'No SOS without verified entitlement');
  assert.match(noPlan.body.error,/112/);
 }finally{
  child.kill('SIGTERM');
  await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(resolve,1000)});
  rmSync(dir,{recursive:true,force:true});
 }
});