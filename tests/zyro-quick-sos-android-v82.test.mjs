import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const ui=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');

test('SOS rapido: opt-in in settings, not automatic rear gesture interception',()=>{
  assert.match(html,/id="zyroQuickSosEnabled"/);
  assert.match(html,/data-settings-target="quickSos"/);
  assert.match(html,/id="zyroHelpQuickSOS"/);
  assert.match(html,/Triplo tocco/);
  assert.match(html,/scorciatoia specifica/);
  assert.match(html,/non è possibile associare il triplo tocco/);
  assert.match(html,/non le rileva/);
  assert.match(ui,/zyro:quick-sos-request/);
  assert.match(ui,/zyroQuickSOSStorageKey/);
  assert.match(ui,/ZyroAndroidQuickSOSSupported/);
  assert.match(ui,/zyroQuickSOSEnabled\(\)/);
  assert.match(ui,/if\(!zyroQuickSOSEnabled\(\)\)/);
  assert.match(ui,/startSOS\(\{quick:true\}\)/);
  assert.match(ui,/optedIn&&!quick\?acquireSOSEmergencyAudio\(\):null/);
});

test('SOS rapido: server checks subscription and recipients, never grants on client alone',()=>{
  assert.match(html,/2,99 € al mese/);
  assert.match(ui,/!current\.me\.premiumActive/);
  assert.match(server,/app\.post\('\/api\/sos\/start', requireAuth/);
  assert.match(server,/if \(!premiumActive\(req\.user\)\) return res\.status\(402\)/);
  assert.match(server,/if\(!recipients\.length&&!alert\)return res\.status\(400\)/);
  assert.match(html,/app\.js\?v=81\.0/);
  assert.match(ui,/sw\.js\?v=27-sos-shortcut-guide/);
});
