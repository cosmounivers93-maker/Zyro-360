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
  assert.match(sw,/zyro-360-v188-approved-glass/);
  assert.match(sw,/zyro-circle-modes-v2\.css/);
  assert.match(sw,/zyro-circle-picker-v3\.css/);
  assert.match(sw,/zyro-circle-picker-v3\.js/);
});

test('release 1.85 loads the updated light-only interface',()=>{
  assert.match(html,/zyro-release-185-light\.css/);
  assert.match(html,/<meta name="color-scheme" content="light">/);
  assert.doesNotMatch(html,/data-settings-target="appearance"/);
  assert.match(js,/zyroTheme='light'/);
  assert.match(js,/applyZyroTheme\('light',true\)/);
  assert.match(sw,/zyro-release-185-light\.css/);
});

const home187=readFileSync(new URL('../public/zyro-home-final-v187.css',import.meta.url),'utf8');
test('release 1.87 forces a readable top-left brand and the requested Home title',()=>{
  assert.ok(html.includes('zyro-home-final-v187.css?v=187.0'));
  assert.ok(html.includes('class="zyro-brand-caption">Tu e la tua cerchia</span>'));
  assert.ok(html.includes('class="zyro-brand-title">ZYRO <b>360</b>'));
  assert.ok(home187.includes('justify-content:flex-start!important'));
  assert.ok(home187.includes('visibility:visible!important'));
  assert.ok(home187.includes('.zyro-raster-tile'));
  for(const kind of ['share','locate','sos']) {
    assert.ok(home187.includes('.zyro-command-'+kind),'Home action has a distinct, readable design: '+kind);
  }
  assert.ok(sw.includes('zyro-home-final-v187.css'));
  assert.ok(js.includes('/sw.js?v=187-home-final'));
});

const approvedGlass=readFileSync(new URL('../public/zyro-approved-glass-v188.css',import.meta.url),'utf8');
const moderation=readFileSync(new URL('../public/zyro-moderation-v1.js',import.meta.url),'utf8');
const billing=readFileSync(new URL('../play-billing.mjs',import.meta.url),'utf8');
test('release 1.88 restores approved light login and V37 shield while preserving payments and reports',()=>{
  assert.ok(html.includes('/zyro-approved-glass-v188.css?v=188.0'));
  assert.ok(html.includes('/zyro-icon-192-v37.png'));
  assert.ok(approvedGlass.includes('#authScreen.auth-shell'));
  assert.ok(approvedGlass.includes('zyro-icon-192-v37.png'));
  assert.ok(approvedGlass.includes('rgba(255,255,255,.88)'));
  assert.ok(sw.includes('zyro-360-v188-approved-glass'));
  assert.ok(sw.includes('zyro-approved-glass-v188.css'));
  assert.ok(html.includes('Tu e la tua cerchia'));
  assert.ok(html.includes('zyro-moderation-v1.js'));
  assert.match(moderation,/admin|segnalazion/i);
  assert.ok(billing.includes('zyro360_unico'));
  assert.match(js,/unico-mensile|billing-sync/);
});
