import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const client=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');

test('after leaving or removing a member, stale permissions are revoked server-side',()=>{
 for(const endpoint of ["'/api/circles/leave'","'/api/circles/remove'","'/api/circles/delete'"]){
   const pos=source.indexOf(endpoint);
   assert.ok(pos>0,endpoint);
   assert.match(source.slice(pos,pos+1000),/pruneDisconnectedPermissions\(\)/);
 }
 assert.match(source,/function pruneDisconnectedPermissions\(\)/);
 for(const name of ['gpsRecipients','sosRecipients','sosAudioRecipients',
   'pickRemoteContacts','pickRemoteRingContacts','pickRemoteLockContacts'])
   assert.ok(source.includes("'"+name+"'"),name);
 assert.match(source,/owner\[key\]\.filter\(id=>id!==owner\.id&&sharedCircle\(owner\.id,id\)\)/);
 assert.match(source,/delete db\.pickRemoteCommands\[owner\]/);
});
test('owner can set independent GPS SOS microphone ring lock permissions per member',()=>{
 const section=source.slice(source.indexOf("app.post('/api/settings/contact-access'"),
   source.indexOf('// Per-account opt-in:'));
 for(const key of ['shareGps','receiveSos','listenSosAudio','remoteRing','remoteLock'])
   assert.ok(section.includes(key),key);
 assert.match(section,/sharedCircle\(req\.user\.id,otherId\)/);
 assert.match(section,/!premiumActive\(req\.user\)/);
 assert.match(section,/!familyActive\(req\.user\)/);
 assert.match(section,/req\.user\.sosAudioRecipients/);
 assert.match(section,/req\.user\.pickRemoteRingContacts/);
 assert.match(section,/req\.user\.pickRemoteLockContacts/);
 assert.match(section,/req\.user\.pickRemoteEnabled=req\.user\.pickRemoteContacts\.length>0/);
});
test('microphone access is gated by owner consent, selected recipient and Family',()=>{
 const pos=source.indexOf('function sosAudioAccessFor(owner,id)');
 assert.ok(pos>0);
 const block=source.slice(pos,pos+500);
 assert.match(block,/owner\.sosAudioConsent===true/);
 assert.match(block,/familyActive\(owner\)/);
 assert.match(block,/sosAudioRecipients\.includes\(id\)/);
 assert.match(block,/sosRecipients\|\|\[\]/);
 assert.match(source,/authorizedAudioRelay\(self,owner,a\)/);
 assert.match(source,/authorizedAudioRelay\(self===a\.userId\?target:self,a\.userId,a\)/);
 assert.match(source,/hasAudio:Boolean\(a\.hasAudio\) && \(a\.userId===id \|\| sosAudioAccessFor/);
});
test('remote ring and lock actions require distinct authorization',()=>{
 assert.match(source,/function remoteAccessFor\(owner,id\)/);
 assert.match(source,/remoteAccessFor\(owner,req\.user\.id\)\[action\]/);
 assert.match(source,/remoteAccessFor\(req\.user,command\.by\)\[command\.action\]/);
 assert.match(source,/remoteActionsAuthorized:a\.kind==='pickpocket'/);
});
test('profile permission page lists all five specific toggles and SOS global microphone',()=>{
 for(const t of ['Può vedere il mio GPS','Riceve i miei SOS',
  'Può ascoltare il mio microfono durante SOS',
  'Può far squillare il mio telefono','Può bloccare il mio telefono da remoto',
  'Abilita microfono durante SOS'])assert.ok(client.includes(t),t);
 for(const prop of ['sosAudioRecipients','pickRemoteRingContacts','pickRemoteLockContacts'])
   assert.ok(client.includes('current.me.'+prop),prop);
 assert.match(client,/uniqueContacts\(\)\.some\(c=>c\.id===id\)/);
 assert.match(client,/\/api\/settings\/contact-access/);
});
