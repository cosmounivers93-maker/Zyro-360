import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
test('Admin frontend has valid JavaScript',()=>{
 assert.doesNotThrow(()=>new vm.Script(app,{filename:'public/app.js'}));
});
test('Admin status is deterministic and exits pending on success or failure',()=>{
 assert.match(app,/let adminLoadPending = false/);
 assert.match(app,/if\(!current\?\.me\?\.isAdmin \|\| adminLoadPending\)return/);
 assert.match(app,/const controller=new AbortController\(\)/);
 assert.match(app,/setTimeout\(\(\)=>controller\.abort\(\),15000\)/);
 assert.match(app,/Dati aggiornati alle/);
 assert.match(app,/Caricamento non riuscito:/);
 assert.match(app,/adminLoaded=false/);
 assert.match(app,/clearTimeout\(timeout\)/);
 assert.match(app,/adminLoadPending=false/);
 assert.doesNotMatch(app,/account registrati\. Aggiornamento in tempo reale/);
});
test('Owner diagnostics initialize without requiring a WebSocket event',()=>{
 assert.match(app,/if\(admin && !adminLoaded && !adminLoadPending/);
 assert.match(app,/scheduleAdminUsersRefresh\(\)/);
 assert.match(app,/async function adminLoad\(\)/);
});