import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const server=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const client=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');

test('all paid safety features are in one verified tier, but SOS is free',()=>{
 assert.match(server,/const familyActive = user => premiumActive\(user\)/);
 assert.match(server,/const planFeatures = user => \(\{sos:true,pickpocket:premiumActive\(user\)/);
 assert.match(server,/pickAdvanced:premiumActive\(user\)/);
 assert.match(server,/remoteControl:familyActive\(user\)/);
 assert.match(server,/sosAudio:familyActive\(user\)/);
 assert.match(server,/journey:familyActive\(user\)/);
 const sos=server.slice(server.indexOf("app.post('/api/sos/start'"),server.indexOf("app.post('/api/sos/stop'"));
 assert.match(sos,/const recipients=/);
 assert.doesNotMatch(sos,/!premiumActive\(req\.user\)/);
});
test('remote commands stay blocked unless explicitly authorized during Pick Pocket',()=>{
 const access=server.slice(server.indexOf('function remoteAccessFor('),server.indexOf('function sosAudioAccessFor('));
 assert.match(access,/ring\.includes\(id\) && familyActive\(owner\)/);
 assert.match(access,/lock\.includes\(id\) && familyActive\(owner\)/);
 const req=server.slice(server.indexOf("app.post('/api/pickpocket/remote/request'"),server.indexOf("app.post('/api/pickpocket/remote/consume'"));
 const consume=server.slice(server.indexOf("app.post('/api/pickpocket/remote/consume'"),server.indexOf("app.post('/api/pickpocket/start'"));
 assert.match(req,/remoteAccessFor\(owner,req\.user\.id\)\[action\]/);
 assert.match(consume,/familyActive\(req\.user\)/);
 assert.match(consume,/remoteAccessFor\(req\.user,command\.by\)\[command\.action\]/);
 assert.match(server,/req\.user\.pickRemoteEnabled/);
});
test('client allows GPS and SOS consent without Plus and keeps remote controls behind the paid tier',()=>{
 assert.match(client,/\(\(type==='ring'\|\|type==='lock'\)\&\&!family\)/);
 assert.match(client,/Con ZYRO Plus: durante un vero allarme Pick Pocket/);
 assert.match(client,/Con ZYRO Plus: richiede anche l’autorizzazione amministratore Android/);
 assert.match(client,/addToggle\('gps'/);
 assert.match(client,/addToggle\('sos'/);
 assert.match(client,/addToggle\('audio'/);
 assert.match(client,/consentSosAudio:kind==='audio'&&target\.checked/);
});
test('storefront offers one Plus plan with truthful emergency and remote action terms',()=>{
 assert.match(html,/id="zyroPlusTitle">ZYRO Plus/);
 assert.match(html,/2,99 €/);
 assert.match(html,/SOS sempre gratuito/);
 assert.match(html,/Squillo e blocco da remoto/);
 assert.ok(!html.includes('id="zyroPersonalTitle"'));
 assert.ok(!html.includes('id="zyroFamilyTitle"'));
 assert.match(html,/previa autorizzazione Android/);
});
