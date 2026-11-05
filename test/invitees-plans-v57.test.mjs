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

test('a single contact switch explicitly permits SOS live audio only after confirmation',()=>{
  assert.match(invitees,/addToggle\('audio','Può ascoltare il mio microfono durante SOS'/);
  assert.doesNotMatch(invitees,/consentToggle\.dataset\.sosAudioConsent/);
  assert.match(app,/confirmCircleInvitation/);
  assert.match(app,/consentSosAudio:kind==='audio'&&target\.checked/);
  assert.match(app,/title:'Ascolto in diretta durante SOS'/);
});

test('subscription selector shows exactly one Plus offer and keeps SOS free',()=>{
  assert.match(html,/<details id="zyroPlanOptions" class="zyro-mode-details zyro-mode-plans-details">/);
  assert.match(html,/id="zyroPlusTitle">ZYRO Plus/);
  assert.match(html,/2,99 €/);
  assert.match(html,/SOS sempre gratuito/);
  assert.ok(!html.includes('id="zyroPersonalTitle"'));
  assert.ok(!html.includes('id="zyroFamilyTitle"'));
  assert.equal((html.match(/data-billing-open/g)||[]).length,1);
  assert.match(html,/Check-in intelligente/);
  assert.match(html,/Pick Pocket avanzato/);
  assert.match(html,/Ascolto microfono in diretta/);
  assert.match(html,/Blocco schermo/);
  assert.match(html,/id="zyroOpenSubscriptionPlans"/);
  assert.match(app,/\$\('zyroOpenSubscriptionPlans'\)\?\.addEventListener/);
  assert.match(plansCss,/zyro-plan/);
});
