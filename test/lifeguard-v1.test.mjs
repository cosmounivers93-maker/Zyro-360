import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/zyro-journey-address-v1.css',import.meta.url),'utf8');

test('Accompagnami and Check-in remain fully independent, no obsolete wrapper',()=>{
  for(const id of ['journeyPanel','checkinPanel','pickPanel','sosRecipientsPanel','journeySeePin','journeyCancelDestination','journeyResume','journeyAutoSos','checkinAutoSos'])assert.match(html,new RegExp('id="'+id+'"'));
  assert.match(html,/Percorsi e conferme/);
  assert.match(html,/data-mode-target="journeyPanel"/);
  assert.doesNotMatch(html,/LifeGuard|lifeguardPanel|lifeGuardFallPanel/i);
  assert.match(css,/#journeyPanel \.zyro-life-consent/);
  assert.match(css,/#checkinPanel \.zyro-life-consent/);
  assert.match(app,/ZyroJourneyRestore/);
  assert.doesNotMatch(app,/LifeGuard|lifeguardPanel/i);
});
test('retired fall monitoring remains disabled server-side',()=>{
  assert.doesNotMatch(html,/rilevamento cadute|monitoraggio cadute|sensibilità sensori/i);
  assert.doesNotMatch(server,/lifeGuardFall:familyActive/);
  assert.match(server,/app\.post\(\['\/api\/lifeguard\/fall\/settings','\/api\/lifeguard\/fall'\]/);
  assert.match(server,/res\.status\(410\)/);
  assert.equal(existsSync(new URL('../public/zyro-lifeguard-v1.js',import.meta.url)),false);
  assert.equal(existsSync(new URL('../public/zyro-lifeguard-v1.css',import.meta.url)),false);
});
test('premium plans keep Accompagnami, Check-in and optional overdue SOS',()=>{
  assert.match(html,/Accompagnami e Check-in, con SOS dopo mancata conferma/);
  assert.match(server,/journey:premiumActive\(user\),checkin:premiumActive\(user\)/);
  assert.match(server,/sosAudio:familyActive\(user\)/);
  assert.match(server,/req\.body\.autoSos===true/g);
  assert.match(html,/id="journeyAutoSos" type="checkbox"/);
  assert.match(html,/id="checkinAutoSos" type="checkbox"/);
  assert.match(app,/requireJourneyOrCheckinPlan\(\)/);
});
