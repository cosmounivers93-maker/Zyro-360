import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const js=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../public/zyro-modes-organized-v56.css',import.meta.url),'utf8');
const modes=html.slice(html.indexOf('<section id="modesView"'),html.indexOf('<section id="chatsView"'));
test('protections and settings appear in clear, safer order',()=>{
 const ids=['activeAlerts','pickPanel','journeyPanel','checkinPanel','premiumPanel'];
 for(const id of ids)assert.equal((modes.match(new RegExp('id="'+id+'"','g'))||[]).length,1,id);
 const idx=(id)=>modes.indexOf('id="'+id+'"');
 assert.ok(idx('activeAlerts')<idx('sosRecipientsPanel'));
 assert.ok(idx('sosRecipientsPanel')<idx('pickPanel'));
 assert.ok(idx('pickPanel')<idx('journeyPanel'));
 assert.ok(idx('journeyPanel')<idx('checkinPanel'));
 assert.ok(idx('checkinPanel')<idx('premiumPanel'));
 assert.ok(modes.indexOf('class="emergency-card"')<idx('pickPanel'));
});
test('all primary ids and controls remain unique',()=>{
 for(const id of ['sosRecipientList','saveSOSRecipients','pickArm','pickTest',
  'pickSensitivity','pickNotify','pickRecipients','pickRecipientsList',
  'journeyStart','journeyArrived','journeyCancel','journeySetTarget',
  'checkinStart','checkinConfirm','checkinCancel','premiumStatus',
  'zyroRestorePurchases','premiumDetails','contactsList','totalMembers',
  'totalCircles','myLocationText','greetingName','myAvatar']){
   assert.equal((modes.match(new RegExp('id="'+id+'"','g'))||[]).length,1,id);
 }
});
test('quick navigation has four working destinations and accessible disclosures',()=>{
 for(const target of ['sosRecipientsPanel','pickPanel','journeyPanel','checkinPanel'])
   assert.match(modes,new RegExp('data-mode-target="'+target+'"'));
 for(const id of ['zyroSosOptions','zyroPickOptions','zyroJourneyOptions','zyroCheckinOptions','zyroModeContacts','zyroPlanOptions'])
   assert.equal((modes.match(new RegExp('id="'+id+'"','g'))||[]).length,1,id);
 assert.match(js,/button\[data-mode-target\]/);
 assert.match(js,/scrollIntoView\(\{behavior:'auto',block:'start'\}\)/);
 assert.match(css,/focus-visible/);
});
test('Pick Pocket activation is visible before optional settings',()=>{
 assert.ok(modes.indexOf('id="pickArm"')<modes.indexOf('id="zyroPickOptions"'));
 assert.ok(modes.indexOf('id="zyroPickOptions"')<modes.indexOf('id="pickSensitivity"'));
 assert.ok(modes.indexOf('id="zyroPickOptions"')<modes.indexOf('id="pickNotify"'));
});
test('new style is last, preserving other sections and supported visuals',()=>{
 assert.ok(html.lastIndexOf('/zyro-modes-organized-v56.css')<html.indexOf('</head>'));
 assert.ok(html.lastIndexOf('/zyro-modes-organized-v56.css')>html.lastIndexOf('/zyro-welcome-v64.css'));
 assert.match(css,/#modesView/);
 assert.match(html,/id="circlesView"/);
 assert.match(html,/id="chatsView"/);
 assert.match(html,/id="settingsView"/);
});
