import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/zyro-lifeguard-v1.css',import.meta.url),'utf8');

test('LifeGuard stays organized with Accompagnami and Check-in, all other features untouched',()=>{
  for(const id of ['lifeguardPanel','journeyPanel','checkinPanel','pickPanel','sosRecipientsPanel','journeySeePin','journeyCancelDestination','journeyResume']){
    assert.match(html,new RegExp('id="'+id+'"'));
  }
  assert.equal((html.match(/id="lifeguardPanel"/g)||[]).length,1);
  assert.match(css,/#lifeguardPanel/);
  assert.match(app,/ZyroJourneyRestore/);
});
test('retired sensor monitoring is removed, including marketing and help',()=>{
  assert.doesNotMatch(html,/rilevamento cadute|monitoraggio cadute|sensibilità sensori|lifeGuardFallPanel|zyroHelpLifeGuardFall/i);
  assert.doesNotMatch(html,/lifeGuardFallToggle|lifeGuardFallLevels/i);
  assert.doesNotMatch(server,/lifeGuardFall:familyActive/);
  assert.doesNotMatch(server,/lifeGuardFallEnabled:familyActive/);
  assert.doesNotMatch(server,/startLifeGuardAlert\(req\.user\.id,recipients,'fall'/);
  assert.match(server,/app\.post\(\['\/api\/lifeguard\/fall\/settings','\/api\/lifeguard\/fall'\]/);
  assert.match(server,/res\.status\(410\)/);
  assert.equal(existsSync(new URL('../public/zyro-lifeguard-v1.js',import.meta.url)),false);
});
test('Base and Family retain their other entitlements and opt-in missed-confirmation SOS',()=>{
  assert.match(server,/journey:premiumActive\(user\),checkin:premiumActive\(user\),lifeGuard:premiumActive\(user\)/);
  assert.match(server,/sosAudio:familyActive\(user\)/);
  assert.match(server,/req\.body\.autoSos===true/g);
  assert.match(html,/id="journeyAutoSos" type="checkbox"/);
  assert.match(html,/id="checkinAutoSos" type="checkbox"/);
  assert.match(app,/requireLifeGuardPlan\(\)/);
});
