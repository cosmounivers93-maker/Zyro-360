import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';

// Regression tests for the exact public files that Express serves.
// Do not test the similarly named root-level legacy app.js / index.html.
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const client=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');

test('production header shows a real-time connection status dot',()=>{
  const tag=html.match(/<div class="connection-pill"[^>]*>/)?.[0];
  assert.ok(tag,'production header connection-pill is missing');
  assert.doesNotMatch(tag,/\shidden(?:\s|>|=)/);
  assert.doesNotMatch(tag,/aria-hidden="true"/);
  assert.match(tag,/role="status"/);
  assert.match(html,/#appScreen>\.topbar \.connection-pill\{display:flex!important/);
  assert.doesNotMatch(html,/#appScreen>\.topbar \.connection-pill\{display:none!important/);
  assert.match(html,/id="connectionDot"/);
  assert.match(html,/id="connectionText"/);
});

test('production app JavaScript parses and reconnects after suspension',()=>{
  assert.doesNotThrow(()=>new Script(client,{filename:'public/app.js'}));
  assert.match(client,/function verifySocketPresence\(\)/);
  assert.match(client,/setInterval\(verifySocketPresence,15000\)/);
  assert.match(client,/window\.addEventListener\('focus',verifySocketPresence\)/);
  assert.match(client,/document\.addEventListener\('visibilitychange'/);
  assert.match(client,/wsLastMessageAt/);
  assert.match(client,/type:'presence-ping'/);
  assert.match(client,/type==='presence-pong'/);
  assert.match(client,/connection\(true\)/);
  assert.match(client,/connection\(false\)/);
});

test('server acknowledges authenticated socket presence without changing privacy checks',()=>{
  assert.match(server,/server\.on\('upgrade'/);
  assert.match(server,/const user = auth\(req\)/);
  assert.match(server,/if\(m\.type==='presence-ping'\)/);
  assert.match(server,/sendSocket\(ws,\{type:'presence-pong'\}\)/);
  assert.match(server,/function online\(id\) \{ return connections\(id\)\.size > 0; \}/);
});
