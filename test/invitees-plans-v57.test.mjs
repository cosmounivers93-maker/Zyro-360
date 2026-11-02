import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const plansCss=readFileSync(new URL('../public/zyro-modes-organized-v56.css',import.meta.url),'utf8');
const inviteesCss=readFileSync(new URL('../public/zyro-chat-groups-invitees-v1.css',import.meta.url),'utf8');
const invitees=app.slice(app.indexOf('function renderInvitedPeople()'),app.indexOf('async function copyAccountId('));

test('people invited show a single clear introduction without the old microphone card',()=>{
  assert.match(app,/Da qui puoi decidere chi e cosa vuoi abilitare della tua cerchia/);
  assert.doesNotMatch(invitees,/Consenso microfono SOS <small>/);
  assert.match(invitees,/addToggle\('gps'/);
  assert.match(invitees,/addToggle\('sos'/);
  assert.match(invitees,/addToggle\('audio'/);
  assert.match(invitees,/addToggle\('ring'/);
  assert.match(invitees,/addToggle\('lock'/);
});

test('explicit Family microphone consent is inside contact options, not the all switch',()=>{
  assert.match(invitees,/if\(family\)\{[\s\S]*?consentToggle\.dataset\.sosAudioConsent='true'/);
  assert.match(invitees,/consentToggle\.checked=current\.me\.sosAudioConsent===true/);
  assert.match(app,/e\.target\.matches\('input\[data-sos-audio-consent\]'\)/);
  assert.match(app,/post\('\/api\/settings\/sos-audio',\{enabled\}\)/);
  assert.match(inviteesCss,/zyro-contact-audio-consent/);
});

test('two subscription cards are visible by default and keep Google Play buttons',()=>{
  assert.match(html,/<details id="zyroPlanOptions"[^>]* open>/);
  assert.match(html,/id="zyroPersonalTitle">ZYRO Base/);
  assert.match(html,/id="zyroFamilyTitle">ZYRO Family/);
  assert.match(html,/3,99 €/);
  assert.match(html,/6,99 €/);
  assert.match(html,/Audio SOS in diretta, con il tuo consenso/);
  assert.match(html,/Accompagnami e segui percorso/);
  assert.equal((html.match(/data-billing-open/g)||[]).length,2);
  assert.match(plansCss,/zyro-plan-family/);
});
