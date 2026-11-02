import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const feature=readFileSync(new URL('../public/zyro-lifeguard-v1.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/zyro-lifeguard-v1.css',import.meta.url),'utf8');

test('LifeGuard panel is one organized section, without modifying Pick Pocket or SOS',()=>{
  assert.match(html, /id="lifeguardPanel"/);
  assert.match(html, /id="lifeGuardFallPanel"/);
  assert.match(html, /id="pickPanel"/);
  assert.match(html, /id="sosRecipientsPanel"/);
  assert.match(html, /id="journeyPanel"/);
  assert.match(html, /id="checkinPanel"/);
  assert.equal((html.match(/id="lifeguardPanel"/g)||[]).length,1);
  assert.equal((html.match(/id="lifeGuardFallToggle"/g)||[]).length,1);
  assert.ok(html.indexOf('id="lifeguardPanel"') < html.indexOf('id="lifeGuardFallPanel"'));
  assert.ok(html.indexOf('id="lifeGuardFallPanel"') < html.indexOf('id="zyroModeContacts"'));
});

test('Base gets optional missed-check-in SOS; Family retains audio and fall monitoring',()=>{
  assert.match(server,/journey:premiumActive\(user\),checkin:premiumActive\(user\),lifeGuard:premiumActive\(user\),lifeGuardFall:familyActive\(user\)/);
  assert.match(server,/sosAudio:familyActive\(user\)/);
  assert.match(server,/req\.body\.autoSos===true/g);
  assert.match(server,/record\.status!=='late'/);
  assert.match(server,/t<record\.dueAt\+120000/);
  assert.match(html,/id="journeyAutoSos" type="checkbox"/);
  assert.match(html,/id="checkinAutoSos" type="checkbox"/);
  assert.match(app,/requireLifeGuardPlan\(\)/);
});

test('Fall alert is not a free or remotely enabled service',()=>{
  assert.match(server,/app\.post\('\/api\/lifeguard\/fall\/settings',requireAuth,limit/);
  assert.match(server,/app\.post\('\/api\/lifeguard\/fall',requireAuth,limit/);
  assert.match(server,/!familyActive\(req\.user\)\|\|req\.user\.lifeGuardFallEnabled!==true/);
  assert.match(server,/req\.user\.sosRecipients\|\|\[\]/);
  assert.match(server,/!recipients\.length/);
  assert.match(server,/currentAlert\(userId\)/);
  assert.match(server,/sharedCircle\(userId,id\)/);
  assert.match(feature,/await post\('\/api\/lifeguard\/fall\/settings',\{enabled:true\}\)/);
  assert.match(feature,/await commandNative\(true\)/);
});

test('No unqualified protection claims or misleading experimental label on the interface',()=>{
  for(const content of [html,feature,css]){
    assert.doesNotMatch(content,/sperimentale/i);
  }
  assert.match(html,/non può riconoscere ogni caduta/);
  assert.match(feature,/monitoraggio Android non confermato/);
  assert.match(html,/La consegna delle notifiche non è garantita/);
});
