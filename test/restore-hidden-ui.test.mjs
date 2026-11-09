import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const js=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const sw=readFileSync(new URL('../public/sw.js',import.meta.url),'utf8');

test('subscription panel has no manual Google Play restore control',()=>{
  assert.doesNotMatch(html,/zyroRestorePurchases|Ripristina acquisti Google Play/);
  assert.match(html,/id="premiumStatus"/);
  assert.match(html,/id="premiumDetails"/);
  assert.match(html,/data-billing-open/);
});

test('billing UI does not reinsert the restore button, while retaining automatic sync',()=>{
  assert.doesNotMatch(js,/zyroRestorePurchases/);
  assert.match(js,/zyroNativeRequest\('billing-sync'\)/);
  assert.match(js,/async function openPlayBilling\(\)/);
  assert.match(js,/data-billing-open/);
});

test('service worker cache version changes so refreshed UI can be installed',()=>{
  assert.match(sw,/zyro-360-v28-quick-settings-only/);
  assert.match(sw,/zyro-circle-modes-v2\.css/);
  assert.match(sw,/zyro-circle-picker-v3\.css/);
  assert.match(sw,/zyro-circle-picker-v3\.js/);
});
