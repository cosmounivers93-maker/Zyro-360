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

test('Family microphone has one per-contact consent, original plans remain unchanged',()=>{
  assert.match(invitees,/addToggle\('audio'/);
  assert.doesNotMatch(invitees,/consentToggle\.dataset\.sosAudioConsent='true'/);
  assert.match(invitees,/consentSosAudio:kind==='audio'&&target\.checked/);
  assert.match(invitees,/consentSosAudio:enabled&&family/);
  assert.match(app,/title:'Consenso ascolto microfono SOS'/);
  assert.match(inviteesCss,/zyro-contact-audio-consent/);
});

test('subscription selector is collapsed and displays one complete monthly plan',()=>{
  assert.match(html,/<details id="zyroPlanOptions" class="zyro-mode-details zyro-mode-plans-details">/);
  assert.match(html,/<summary><span class="zyro-mode-summary-label"><strong>Seleziona abbonamenti<\/strong>/);
  assert.ok(html.indexOf('<header class="zyro-modes-group-title"><span aria-hidden="true">04</span>')<html.indexOf('Seleziona abbonamenti'));
  assert.match(html,/id="zyroUnicoTitle">ZYRO 360/);
  assert.match(html,/2,99 €/);
  assert.doesNotMatch(html,/id="zyroPersonalTitle"|id="zyroFamilyTitle"/);
  assert.match(html,/Audio SOS soltanto con consenso esplicito/);
  assert.match(html,/Accompagnami e Check-in/);
  assert.match(html,/Squillo e blocco da remoto soltanto con autorizzazione/);
  assert.equal((html.match(/data-billing-open/g)||[]).length,1);
  assert.match(html,/id="zyroOpenSubscriptionPlans"/);
  assert.match(app,/\$\('zyroOpenSubscriptionPlans'\)\?\.addEventListener\('click',\(\)=>openProfileSettings\('premium'\)\)/);
  assert.match(plansCss,/zyro-plan-family/);
});
