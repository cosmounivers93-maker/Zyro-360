import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/zyro-help-final-v3.css',import.meta.url),'utf8');
const mapCss=readFileSync(new URL('../public/zyro-journey-address-v1.css',import.meta.url),'utf8');
const map=readFileSync(new URL('../public/zyro-journey-address-v1.js',import.meta.url),'utf8');

test('admin Family entitlement remains server-owned and unrelated to retired fall detection',()=>{
  assert.match(server,/process\.env\.ZYRO_ADMIN_USER_ID/);
  assert.match(server,/if\(isAdmin\(user\)\|\|user\?\.premiumGiftLifetime===true\)return 'family'/);
  assert.match(server,/const familyActive = user => premiumPlan\(user\)==='family'/);
  assert.match(server,/creatorPremium:isAdmin\(me\)/);
  assert.doesNotMatch(server,/lifeGuardFall:familyActive/);
});
test('updated guide preserves Accompagnami, Check-in and high contrast while removing falls',()=>{
  for(const fragment of ['LifeGuard 360','Check-in','Apri sulla mappa','Annulla destinazione','Scegli il piano adatto','Premium, 3,99 €','Family, 6,99 €']){
    assert.ok(html.includes(fragment),fragment);
  }
  assert.doesNotMatch(html,/cadut|zyroHelpLifeGuardFall|lifeGuardFallPanel/i);
  assert.match(css,/color:#3d586e!important/);
  assert.match(css,/#profileSettingsDrawer #zyroHelp/);
});
test('map approval still displays above GPS and SOS buttons',()=>{
  assert.match(map,/document\.body\.append\(bar\)/);
  assert.match(map,/window\.innerHeight-r\.top\+18/);
  assert.match(mapCss,/#zyroJourneyMapConfirm\.zyro-journey-map-confirm/);
  assert.match(mapCss,/position:fixed!important/);
  assert.match(mapCss,/z-index:2147483000!important/);
});
