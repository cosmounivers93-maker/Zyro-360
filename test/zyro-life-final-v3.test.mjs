import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/zyro-help-final-v3.css',import.meta.url),'utf8');
const mapCss=readFileSync(new URL('../public/zyro-journey-address-v1.css',import.meta.url),'utf8');
const map=readFileSync(new URL('../public/zyro-journey-address-v1.js',import.meta.url),'utf8');

test('administrator Family entitlement remains exclusively server-owned',()=>{
 assert.match(server,/process\.env\.ZYRO_ADMIN_USER_ID/);
 assert.match(server,/if\(isAdmin\(user\)\|\|user\?\.premiumGiftLifetime===true\)return 'family'/);
 assert.match(server,/const familyActive = user => premiumPlan\(user\)==='family'/);
 assert.match(server,/creatorPremium:isAdmin\(me\)/);
});
test('complete guide explains Accompagnami and Check-in, not obsolete brand',()=>{
 for(const fragment of ['Percorsi e conferme','Check-in','Apri sulla mappa','Annulla destinazione','Scegli il piano adatto','Premium, 3,99 €','Family, 6,99 €'])assert.ok(html.includes(fragment),fragment);
 assert.doesNotMatch(html,/LifeGuard|cadut|zyroHelpLifeGuardFall|lifeGuardFallPanel/i);
 assert.match(css,/color:#3d586e!important/);
 assert.match(css,/#profileSettingsDrawer #zyroHelp/);
});
test('map confirm buttons remain visible above Home GPS/SOS controls',()=>{
 assert.match(map,/document\.body\.append\(bar\)/);
 assert.match(map,/window\.innerHeight-r\.top\+18/);
 assert.match(mapCss,/#zyroJourneyMapConfirm\.zyro-journey-map-confirm/);
 assert.match(mapCss,/position:fixed!important/);
 assert.match(mapCss,/z-index:2147483000!important/);
});
