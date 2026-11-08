import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const server=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const client=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../public/style.css',import.meta.url),'utf8');
test('the Family plan alone grants ring or lock from another account',()=>{
 assert.match(server,/pickAdvanced:premiumActive\(user\),remoteControl:familyActive\(user\)/);
 const section=server.slice(server.indexOf('function remoteAccessFor('),server.indexOf('function sosAudioAccessFor('));
 assert.match(section,/ring\.includes\(id\) && familyActive\(owner\)/);
 assert.match(section,/lock\.includes\(id\) && familyActive\(owner\)/);
 assert.ok(!section.includes('premiumActive(owner)'));
});
test('server refuses Premium and Free requests, command consumption and opt-in',()=>{
 const req=server.slice(server.indexOf("app.post('/api/pickpocket/remote/request'"),server.indexOf("app.post('/api/pickpocket/remote/consume'"));
 const consume=server.slice(server.indexOf("app.post('/api/pickpocket/remote/consume'"),server.indexOf("app.post('/api/pickpocket/start'"));
 const grants=server.slice(server.indexOf("app.post('/api/settings/contact-access'"),server.indexOf("// Per-account opt-in"));
 const legacy=server.slice(server.indexOf("app.post('/api/pickpocket/remote/settings'"),server.indexOf("app.post('/api/pickpocket/remote/request'"));
 assert.match(req,/!familyActive\(owner\)/);
 assert.match(req,/remoteAccessFor\(owner,req\.user\.id\)\[action\]/);
 assert.match(consume,/familyActive\(req\.user\)/);
 assert.match(consume,/remoteAccessFor\(req\.user,command\.by\)\[command\.action\]/);
 assert.match(grants,/remoteRing===true\|\|req\.body\.remoteLock===true\)&&!familyActive\(req\.user\)/);
 assert.match(legacy,/req\.body\?\.enabled===true&&!familyActive\(req\.user\)/);
 assert.match(server,/remoteControl:familyActive\(user\)/);
});
test('Premium maintains optional automatic screen lock and other safety features',()=>{
 assert.match(server,/pickpocket:premiumActive\(user\)/);
 assert.match(server,/pickAdvanced:premiumActive\(user\)/);
 assert.match(server,/sos:premiumActive\(user\)/);
 assert.match(server,/sosAudio:familyActive\(user\)/);
 assert.match(server,/journey:familyActive\(user\)/);
});
test('client disables remote contact switches for non-Family without blocking GPS/SOS',()=>{
 assert.match(client,/\(\(type==='ring'\|\|type==='lock'\)\&\&!family\)/);
 assert.match(client,/Piano unico ZYRO 360: durante un allarme Pick Pocket attivo e con consenso/);
 assert.match(client,/Piano unico ZYRO 360: richiede il permesso di amministratore Android/);
 assert.match(client,/addToggle\('gps'/);
 assert.match(client,/addToggle\('sos'/);
});
test('single 2,99 store plan lists remote and local Pick Pocket, not old tiers',()=>{
 assert.match(html,/id="zyroUnicoTitle">ZYRO 360/);
 assert.match(html,/2,99 €/);
 assert.match(html,/Pick Pocket avanzata e blocco schermo locale/);
 assert.match(html,/Squillo e blocco da remoto/);
 assert.doesNotMatch(html,/id="zyroFamilyTitle"/);
});
