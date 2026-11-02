import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/zyro-help-final-v3.css',import.meta.url),'utf8');
const mapCss=readFileSync(new URL('../public/zyro-journey-address-v1.css',import.meta.url),'utf8');
const map=readFileSync(new URL('../public/zyro-journey-address-v1.js',import.meta.url),'utf8');
const life=readFileSync(new URL('../public/zyro-lifeguard-v1.js',import.meta.url),'utf8');

test('admin Family entitlement derives from server-only id, never client flag',()=>{
 assert.match(server,/process\.env\.ZYRO_ADMIN_USER_ID/);
 assert.match(server,/process\.env\.ZYRO_CREATOR_USER_ID/);
 assert.match(server,/if\(isAdmin\(user\)\|\|user\?\.premiumGiftLifetime===true\)return 'family'/);
 assert.match(server,/const familyActive = user => premiumPlan\(user\)==='family'/);
 assert.match(server,/creatorPremium:isAdmin\(me\)/);
 assert.match(server,/lifeGuardFall:familyActive\(user\)/);
 assert.match(server,/app\.post\('\/api\/lifeguard\/fall\/settings',requireAuth,limit/);
 assert.match(server,/if\(!familyActive\(req\.user\)\)return res\.status\(402\)/);
});
test('fall detection can be enabled separately from Check-in and journeys',()=>{
 assert.match(html,/Rilevamento cadute e impatti/);
 assert.match(html,/Si attiva e si disattiva quando vuoi, indipendentemente/);
 assert.match(html,/LifeGuard 360: rilevamento cadute attivabile autonomamente/);
 assert.match(life,/zyroNativeRequest\('lifeguard'/);
 assert.match(life,/post\('\/api\/lifeguard\/fall\/settings'/);
});
test('complete how it works, with Family and creator role, is updated and readable',()=>{
 for(const phrase of ['id="zyroHelpLifeGuardFall"','sensibilità','Bassa','Elevata','45 secondi','Sto bene','indipendente','ID amministratore','ZYRO Family','Apri sulla mappa','Imposta','Annulla destinazione'])assert.ok(html.includes(phrase),phrase);
 assert.match(html,/Check-in: conferma che va tutto bene/);
 assert.match(html,/Incluso in Base e Family/);
 assert.match(css,/color:#3d586e!important/);
 assert.match(css,/#profileSettingsDrawer #zyroHelp/);
 assert.match(html,/zyro-help-final-v3.css\?v=1/);
});
test('map modal is above GPS and SOS buttons, never clipped by map',()=>{
 assert.match(map,/document\.body\.append\(bar\)/);
 assert.match(map,/window\.innerHeight-r\.top\+18/);
 assert.match(map,/positionMapActions/);
 assert.match(mapCss,/#zyroJourneyMapConfirm\.zyro-journey-map-confirm/);
 assert.match(mapCss,/position:fixed!important/);
 assert.match(mapCss,/z-index:2147483000!important/);
});
