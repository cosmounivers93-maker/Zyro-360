import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');

test('premium and family each include advanced Pick Pocket capabilities',()=>{
 assert.match(source,/pickAdvanced:premiumActive\(user\)/);
 assert.match(source,/premiumActive\(owner\)/);
});
test('remote rights are default-off, selected by the owner only',()=>{
 assert.match(source,/pickRemoteEnabled===true/);
 assert.match(source,/pickRemoteContacts\|\|\[\]/);
 assert.match(source,/req\.user\.pickRemoteEnabled=enabled/);
 assert.match(source,/req\.user\.pickRemoteContacts=enabled\?authorized:\[\]/);
 assert.match(source,/sharedCircle\(id,req\.user\.id\)/);
});
test('only explicit alert recipients with consent can request a command',()=>{
 const p=source.slice(source.indexOf("app.post('/api/pickpocket/remote/request'"),source.indexOf("app.post('/api/pickpocket/remote/consume'"));
 assert.match(p,/req\.user\.id===ownerId/);
 assert.match(p,/!sharedCircle\(ownerId,req\.user\.id\)/);
 assert.match(p,/owner\.pickRemoteEnabled!==true/);
 assert.match(p,/owner\.pickRemoteContacts\.includes\(req\.user\.id\)/);
 assert.match(p,/alert\.kind!=='pickpocket'/);
 assert.match(p,/alert\.recipients\?\.includes\(req\.user\.id\)/);
 assert.match(p,/entries\.length!==1/);
 assert.match(p,/pickRemoteCooldown/);
 assert.match(p,/90000/);
 assert.match(p,/firebaseAdmin\.messaging\(\)\.send/);
 assert.match(p,/data:\{kind:'pick-remote',commandId:id\}/);
 assert.match(p,/deliveryConfirmed:false/);
});
test('server verifies commands on consumption and prevents replay',()=>{
 const p=source.slice(source.indexOf("app.post('/api/pickpocket/remote/consume'"),source.indexOf("app.post('/api/pickpocket/start'"));
 assert.match(p,/requireAuth/);
 assert.match(p,/delete db\.pickRemoteCommands\[req\.user\.id\]/);
 assert.match(p,/command\.expiresAt>now\(\)/);
 assert.match(p,/alert\.id===command\.alertId/);
 assert.match(p,/premiumActive\(req\.user\)/);
 assert.match(p,/req\.user\.pickRemoteContacts\?\.includes\(command\.by\)/);
 assert.match(p,/alert\.recipients\?\.includes\(command\.by\)/);
});
test('alarm closure revokes pending remote commands',()=>{
 assert.match(source,/delete db\.pickRemoteCommands\[req\.user\.id\]/);
 assert.match(source,/alert\.active=false;alert\.endedAt=now\(\)/);
});
