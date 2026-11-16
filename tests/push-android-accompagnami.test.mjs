import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const web=fs.readFileSync(new URL('../public/app.js', import.meta.url),'utf8');
const server=fs.readFileSync(new URL('../server.mjs', import.meta.url),'utf8');

test('Android FCM token is linked only after login, and refresh is idempotent',async()=>{
 const start=web.indexOf("let zyroFcmRegisteredFor=''");
 const end=web.indexOf("let zyroPendingPushKind=''",start);
 assert.ok(start>0&&end>start,'FCM registration routine is present');
 const listeners=new Map(),calls=[];
 const context=vm.createContext({
  console:{warn:()=>{}},
  Event:class{constructor(type){this.type=type;}},
  window:{
   ZyroAndroidPush:{platform:'android',token:'T'.repeat(128)},
   addEventListener:(name,fn)=>listeners.set(name,fn),
   dispatchEvent:()=>{}
  },
  post:async(path,payload)=>{
   calls.push({path,payload});
   return {ok:true,linkedToCurrentSession:true};
  },
  api:async()=>({firebaseConfigured:true,linkedToCurrentSession:true})
 });
 vm.runInContext('let current = null;\n'+web.slice(start,end),context);
 await vm.runInContext('zyroRegisterAndroidPush()',context);
 assert.equal(calls.length,0,'no FCM subscription before auth');
 vm.runInContext("current={me:{id:'member-a'}}",context);
 await vm.runInContext('zyroRegisterAndroidPush()',context);
 assert.equal(calls.length,1);
 assert.equal(calls[0].path,'/api/push/android/register');
 assert.equal(calls[0].payload.token.length,128);
 await vm.runInContext('zyroRegisterAndroidPush()',context);
 assert.equal(calls.length,1,'same token must not be posted each refresh');
 await vm.runInContext('zyroRegisterAndroidPush(true)',context);
 assert.equal(calls.length,2,'explicit reconnect retries subscription');
 vm.runInContext("window.ZyroAndroidPush.token='V'.repeat(128)",context);
 await vm.runInContext('zyroRegisterAndroidPush()',context);
 assert.equal(calls.length,3,'rotating token is registered');
});

test('important events have their own server push paths',()=>{
 assert.match(server,/sendEventPush\(chat\.members\.filter\(id=>id!==req\.user\.id\)/);
 assert.match(server,/,'chat'\)/);
 assert.match(server,/,'journey-request'\)/);
 assert.match(server,/,'checkin'\)/);
 assert.match(server,/,'invite'\)/);
 assert.match(server,/const fcm=await sendFcm\(ids,title,body,kind\)/);
 assert.match(server,/channelId:kind==='sos'/);
});

test('the route bar requires accepted journey and active status',()=>{
 assert.match(web,/j\.response==='accepted'&&\['active','late'\]\.includes\(j\.status\)/);
 assert.match(web,/showView\('home'\);zyroRefreshFollowJourney\(\)/);
 assert.match(web,/zyroFollowJourneyBar/);
 assert.match(web,/destinationPoint\.lat/);
});
