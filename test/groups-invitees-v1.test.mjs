import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const style=readFileSync(new URL('../public/zyro-chat-groups-invitees-v1.css',import.meta.url),'utf8');
test('codici gruppo distinti, riutilizzabili e a scadenza',()=>{
  assert.match(server,/app\.post\('\/api\/chat\/groups',/);
  assert.match(server,/app\.post\('\/api\/chat\/groups\/invite',/);
  assert.match(server,/app\.post\('\/api\/chat\/groups\/join',/);
  assert.match(server,/code='G'\+crypto\.randomBytes\(9\)/);
  assert.match(server,/inv\.kind==='group'/);
  assert.match(server,/expiresAt:now\(\)\+24\*3600\*1000/);
  const join=server.slice(server.indexOf("app.post('/api/chat/groups/join'"),server.indexOf("app.post('/api/circles'"));
  assert.match(join,/db\.memberships\.push/);
  assert.doesNotMatch(join,/delete db\.invites\[key\]/);
  assert.match(server,/inv\.kind==='group' \|\| inv\.expiresAt/);
});
test('only creator regenerates group code and permissions stay opt in',()=>{
  assert.match(server,/group\.ownerId!==req\.user\.id/);
  assert.match(server,/const legacy=new Set\(\)/);
  assert.match(server,/filter\(c=>c\.kind!=='chat'\)/);
  assert.match(server,/if\(memberIds\(group\.id\)\.length>=MAX_GROUP_MEMBERS\)/);
});
test('chat forms and copy controls are all wired',()=>{
  for(const id of ['chatGroupCreateForm','chatGroupJoinForm','chatGroupInviteButton','chatGroupInviteResult','chatGroupCopy','chatGroupShare','chatGroupCreateOpen','chatGroupJoinOpen']) {
    assert.ok(html.includes('id="'+id+'"'),id);
    assert.ok(app.includes("$('"+id+"')"),id);
  }
  assert.ok(html.includes('data-chat-filter="group"'));
  assert.match(app,/showChatGroupInviteCode/);
  assert.match(style,/\.zyro-group-editor/);
});
test('invited people are compact with independent five permissions and master',()=>{
  assert.match(app,/expand\.dataset\.accessExpand=member\.id/);
  assert.match(app,/all\.dataset\.accessAll=member\.id/);
  assert.match(app,/options\.dataset\.accessOptions=member\.id/);
  assert.match(app,/changeAllContactAccess\(target\)/);
  assert.match(app,/Abilita tutte le opzioni/);
  for(const key of ["'gps'","'sos'","'audio'","'ring'","'lock'"])assert.ok(app.includes(key),key);
  assert.doesNotMatch(app,/consentToggle\.dataset\.sosAudioConsent='true'/);
  assert.match(app,/consentSosAudio:kind==='audio'&&target\.checked/);
  assert.doesNotMatch(app,/Consenso microfono SOS <small>/);
  assert.match(app,/listenSosAudio:enabled&&family,consentSosAudio:enabled&&family/);
  assert.match(app,/remoteRing:enabled&&family/);
  assert.match(app,/remoteLock:enabled&&family/);
  assert.match(style,/zyro-access-card-compact/);
});
