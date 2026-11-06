import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/zyro-circle-modes-v2.css',import.meta.url),'utf8');

test('Original layout and subscription panels are retained',()=>{
  assert.doesNotThrow(()=>new vm.Script(app,{filename:'public/app.js'}));
  assert.ok(html.includes('zyro-glass-v30.css'),'Original glass stylesheet must remain');
  for(const id of ['homeView','circlesView','modesView','chatsView','zyroAdminPanel','chatConversation','journeyPanel'])
    assert.ok(html.includes('id="'+id+'"'),'Missing existing panel '+id);
  assert.ok(server.includes("premiumPlan = user"));
  assert.ok(html.includes('/zyro-circle-modes-v2.css?v=2'));
});

test('Separate private and shared circles, plus matching chat categories',()=>{
  for(const id of ['circleType','circleName','profileInviteMode','profileInviteCircle','profileInviteId'])
    assert.ok(html.includes('id="'+id+'"'),'Missing input '+id);
  for(const category of ['direct','group'])assert.ok(html.includes('value="'+category+'"'));
  for(const filter of ['direct','group'])
    assert.ok(html.includes('data-chat-filter="'+filter+'"'));
  assert.ok(html.includes('Chat singole'));
  assert.ok(html.includes('Chat di gruppo'));
  assert.match(app,/c\.kind!=='chat'/);
  assert.match(app,/group\.kind!=='direct'/);
  assert.match(app,/name:\$\('circleName'\)\.value,kind/);
});

test('Server enforces 2-person private circle, 20-member group and consent',()=>{
  assert.match(server,/const MAX_GROUP_MEMBERS = 20;/);
  assert.match(server,/circle\?\.kind === 'direct' \? 2 : MAX_GROUP_MEMBERS/);
  assert.match(server,/memberIds\(circleId\)\.length>=circleCapacity\(circle\)/);
  assert.match(server,/memberIds\(circle\.id\)\.length>=circleCapacity\(circle\)/);
  assert.match(server,/memberIds\(group\.id\)\.length>=MAX_GROUP_MEMBERS/);
  assert.match(server,/memberIds\(inv\.circleId\)\.length >= circleCapacity\(db\.circles\[inv\.circleId\]\)/);
  assert.match(server,/status:'pending'/);
  assert.match(server,/decision==='accept'/);
  assert.match(server,/profileNamePrefix:profileSlug\(name\)/);
  assert.match(server,/legacyProfileId/);
});

test('Accompagnami uses custom accessible glass picker, retaining timestamp validation',()=>{
  for(const id of ['journeyDueAt','journeyDueOpen','zyroJourneyDueDialog','zyroDueDayGrid','zyroDueHour','zyroDueMinute','zyroDueConfirm','zyroDueClear','zyroDueCancel'])
    assert.ok(html.includes('id="'+id+'"'),'Missing date picker control '+id);
  assert.match(app,/function initZyroDuePicker\(\)/);
  assert.match(app,/function confirmZyroDuePicker\(\)/);
  assert.match(app,/date\.getTime\(\)<Date\.now\(\)\+5\*60000/);
  assert.match(app,/date\.getTime\(\)>Date\.now\(\)\+24\*3600000/);
  assert.match(app,/closeZyroDuePicker/);
  assert.match(css,/\.zyro-due-card/);
  assert.match(css,/\.zyro-due-day-grid/);
  assert.ok(html.includes('id="journeyDueAt" type="datetime-local" step="60" hidden'));
});
