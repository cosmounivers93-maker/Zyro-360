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
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/zyro-group-circle-code-v5.css',import.meta.url),'utf8');

test('group invitation code is dedicated, multi-use, owner-only and revocable',()=>{
 for(const suffix of ['/api/circles/group-code','/api/circles/group-code/revoke','/api/circles/group-code/join'])
   assert.ok(server.includes("app.post('"+suffix+"'"),'Missing route '+suffix);
 assert.match(server,/invite\.kind!=='circle-group'/);
 assert.match(server,/circle\.kind!=='group'/);
 assert.match(server,/circle\.ownerId!==req\.user\.id/);
 assert.match(server,/memberIds\(circle\.id\)\.length>=MAX_GROUP_MEMBERS/);
 assert.match(server,/invite\.expiresAt<=now\(\)/);
 assert.match(server,/inv\.kind==='circle-group'/);
 assert.match(server,/db\.memberships\.push\(\{circleId:circle\.id,userId:req\.user\.id/);
 assert.match(server,/inv\.kind==='group' \|\| inv\.kind==='circle-group'/);
});

test('owner sends group-circle code from Circles and recipients enter same room with consent',()=>{
 for(const name of ['zyroGroupCodeJoinForm','zyroGroupCodeInput','zyroGroupCodeIssued','zyroGroupCodeIssuedValue','zyroGroupCodeCopy','zyroGroupCodeShare','zyroGroupCodeRevoke'])
   assert.ok(html.includes('id="'+name+'"'),'Missing '+name);
 assert.match(app,/data-group-code/);
 assert.match(app,/post\('\/api\/circles\/group-code',\{circleId\}\)/);
 assert.match(app,/post\('\/api\/circles\/group-code\/join',\{code\}\)/);
 assert.match(app,/post\('\/api\/circles\/group-code\/revoke'/);
 assert.match(html,/la stessa mappa e alla stessa chat/);
 assert.match(html,/non viene condivisa automaticamente/);
 assert.match(css,/zyro-group-code-panel/);
});

test('Home removes redundant ZYRO wordmark, other sections keep it',()=>{
 assert.match(app,/document\.body\.classList\.toggle\('zyro-home-no-brand',view==='home'\)/);
 assert.match(css,/body\.zyro-home-no-brand #appScreen > header\.topbar > \.brand/);
 assert.match(html,/<div class="brand zyro-neon-wordmark"/);
 assert.match(html,/id="connectionText"/);
 assert.match(html,/2,99 €/);
});

test('authenticated group codes support multiple family members, revocation, rotation and no implicit GPS', {
 timeout:30000,skip:deps?false:'Integration dependencies installed in CI'
},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'zyro-circle-code-v5-'));
 const port=await new Promise((resolve,reject)=>{
  const sock=createServer();sock.once('error',reject).listen(0,'127.0.0.1',()=>{
   const p=sock.address().port;sock.close(()=>resolve(p));
  });
 });
 writeFileSync(join(dir,'zyro360.json'),JSON.stringify({users:{},sessions:{},circles:{},memberships:[],invites:{},profileInvites:{},alerts:{},messages:{},chatViews:{},journeys:{},checkins:{},adminAudit:[],userReports:[]}));
 const child=spawn(process.execPath,['server.mjs'],{
  cwd:ROOT,env:{...process.env,PORT:String(port),DATA_DIR:dir,DATABASE_URL:'',
   ZYRO_REQUIRE_PERSISTENT_DB:'false',GOOGLE_PLAY_BILLING_ENABLED:'false',
   FIREBASE_SERVICE_ACCOUNT_JSON:'',VAPID_PUBLIC_KEY:'',VAPID_PRIVATE_KEY:''},
  stdio:['ignore','pipe','pipe']
 });
 let logs='';child.stdout.on('data',d=>logs+=d.toString());child.stderr.on('data',d=>logs+=d.toString());
 const base='http://127.0.0.1:'+port;
 async function req(method,path,data,cookie){
  const res=await fetch(base+path,{
   method,
   headers:{...(data?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},
   ...(data?{body:JSON.stringify(data)}:{})
  });
  let body={};try{body=await res.json();}catch{}
  return {status:res.status,body,cookie:(res.headers.get('set-cookie')||'').split(';')[0]};
 }
 async function register(name){
  const r=await req('POST','/api/register',{name,email:name.toLowerCase()+'@example.test',password:'strong-test-password-2026'});
  assert.equal(r.status,200,JSON.stringify(r.body));return r.cookie;
 }
 try{
  let ready=false;
  for(let i=0;i<110;i++){
   try{if((await req('GET','/api/health')).status===200){ready=true;break;}}catch{}
   if(child.exitCode!==null)break;
   await new Promise(resolve=>setTimeout(resolve,75));
  }
  assert.ok(ready,'Server did not start: '+logs.slice(-1500));
  const owner=await register('Anna'),a=await register('Bruno'),b=await register('Carlo'),c=await register('Daria');
  const created=await req('POST','/api/circles',{name:'Famiglia',kind:'group'},owner);
  assert.equal(created.status,200,JSON.stringify(created.body));
  const circleId=created.body.circleId;
  const unauthorized=await req('POST','/api/circles/group-code',{circleId},a);
  assert.equal(unauthorized.status,403);
  const createdCode=await req('POST','/api/circles/group-code',{circleId},owner);
  assert.equal(createdCode.status,200,JSON.stringify(createdCode.body));
  assert.match(createdCode.body.code,/^C[A-F0-9]{18}$/);
  assert.equal(createdCode.body.multipleUses,true);
  const code=createdCode.body.code;
  // A dedicated circle code cannot enter through the old single-use generic endpoint.
  assert.notEqual((await req('POST','/api/invites/join',{code},a)).status,200);
  assert.equal((await req('POST','/api/circles/group-code/join',{code},a)).status,200);
  assert.equal((await req('POST','/api/circles/group-code/join',{code},b)).status,200);
  const state=(await req('GET','/api/state',null,owner)).body;
  const group=state.circles.find(q=>q.id===circleId);
  assert.equal(group.kind,'group');
  assert.equal(group.members.length,3);
  assert.equal(group.memberLimit,20);
  for(const cookie of [a,b]){
   const result=(await req('GET','/api/state',null,cookie)).body;
   assert.equal(result.me.sharing,false,'Joining must not activate position sharing');
   assert.deepEqual(result.me.gpsRecipients,[],'Joining must not authorize GPS');
   assert.deepEqual(result.me.sosRecipients,[],'Joining must not authorize SOS');
   assert.ok(result.circles.some(x=>x.id===circleId),'One shared circle is visible to every member');
  }
  const rotated=await req('POST','/api/circles/group-code',{circleId},owner);
  assert.equal(rotated.status,200,JSON.stringify(rotated.body));
  assert.notEqual(rotated.body.code,code);
  assert.notEqual((await req('POST','/api/circles/group-code/join',{code},c)).status,200);
  assert.equal((await req('POST','/api/circles/group-code/revoke',{circleId},owner)).status,200);
  assert.notEqual((await req('POST','/api/circles/group-code/join',{code:rotated.body.code},c)).status,200);
  const newCode=await req('POST','/api/circles/group-code',{circleId},owner);
  assert.equal(newCode.status,200);
  assert.equal((await req('POST','/api/circles/group-code/join',{code:newCode.body.code},c)).status,200);
  const group4=(await req('GET','/api/state',null,owner)).body.circles.find(x=>x.id===circleId);
  assert.equal(group4.members.length,4);
 }finally{
  child.kill('SIGTERM');
  await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(resolve,1200)});
  rmSync(dir,{recursive:true,force:true});
 }
});