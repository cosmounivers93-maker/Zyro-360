import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const base = new URL('../public/', import.meta.url);
const html = fs.readFileSync(new URL('index.html',base),'utf8');
const js = fs.readFileSync(new URL('zyro-circle-picker-v3.js',base),'utf8');
const css = fs.readFileSync(new URL('zyro-circle-picker-v3.css',base),'utf8');
const sw = fs.readFileSync(new URL('sw.js',base),'utf8');
const app = fs.readFileSync(new URL('app.js',base),'utf8');

test('v3 scripts and style are included after existing CSS and app initialization',()=>{
  assert.ok(html.includes('/zyro-circle-picker-v3.css?v=3'));
  assert.ok(html.includes('/zyro-circle-picker-v3.js?v=3'));
  assert.ok(html.indexOf('/zyro-circle-picker-v3.css')>html.indexOf('/zyro-journey-v71.css'));
  assert.ok(html.indexOf('/zyro-circle-picker-v3.js')>html.indexOf('/app.js?v=80.6'));
  assert.match(sw,/zyro-360-v26-chat-directory-autorevole/);
  assert.match(sw,/zyro-circle-picker-v3\.js/);
  assert.match(sw,/zyro-circle-picker-v3\.css/);
  assert.match(app,/sw\.js\?v=25-cerchie-chat-sincronizzate/);
});

test('native circle inputs remain backing form fields, with modal controls and change events',()=>{
  for(const id of ['circleType','profileInviteMode','profileInviteCircle']){
    assert.match(html,new RegExp('<select id="'+id+'"'));
    assert.ok(js.includes("'"+id+"'"));
  }
  assert.match(js,/aria-modal/);
  assert.match(js,/aria-pressed/);
  assert.match(js,/new Event\('change',\{bubbles:true\}\)/);
  assert.match(js,/MutationObserver/);
  assert.match(js,/Escape/);
  assert.match(css,/select\.zyro-choice-native/);
  assert.match(css,/pointer-events:none!important/);
  new vm.Script(js,{filename:'zyro-circle-picker-v3.js'});
});

test('date selection text receives explicit readable foreground even on native WebView overrides',()=>{
  assert.match(html,/id="journeyDueText">Seleziona data e ora/);
  assert.match(css,/button#journeyDueOpen span#journeyDueText/);
  assert.match(css,/color:#193f65!important/);
  assert.match(css,/-webkit-text-fill-color:#193f65!important/);
  assert.match(css,/opacity:1!important/);
  assert.match(css,/font-size:16px!important/);
});

test('mode cards and destination list do not change group limits or invitation permissions',()=>{
  assert.match(js,/Cerchia singola/);
  assert.match(js,/Cerchia di gruppo/);
  assert.match(js,/massimo 2 persone/);
  assert.match(js,/fino a 20 persone/);
  assert.match(app,/post\('\/api\/profile-invites'/);
  assert.match(app,/post\('\/api\/circles'/);
});