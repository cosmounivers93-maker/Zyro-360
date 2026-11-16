import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script=fs.readFileSync(new URL('../public/zyro-startup-watchdog-v1.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
function fixture(ready=false){
 const timers=[],intervals=[],elements=new Map();
 const body={
  classList:{removed:[],remove(x){this.removed.push(x);}},
  append(node){node.isConnected=true;elements.set(node.id,node);}
 };
 function element(tag){
  return {tag,children:[],id:'',style:{},isConnected:false,properties:{},setAttribute(k,v){this.properties[k]=v;},
   append(...children){this.children.push(...children);},addEventListener(){},remove(){elements.delete(this.id);this.isConnected=false;}};
 }
 const context={
  window:{ZyroStartupReady:ready,location:{reload(){}}},
  document:{body,createElement:element,getElementById:id=>elements.get(id)},
  setTimeout(fn,time){timers.push({fn,time});},
  setInterval(fn,time){intervals.push({fn,time});return 3;},
  clearInterval(){}
 };
 vm.runInNewContext(script,context);
 return {timers,intervals,elements,body,context};
}

test('independent watchdog begins before deferred app bundle and follows CSP',()=>{
 assert.match(html,/<body class="zyro-await-intro">\s*<script src="\/zyro-startup-watchdog-v1\.js\?v=1" async><\/script>/);
 assert.doesNotMatch(html,/<script>\s*setTimeout/);
 assert.equal(fixture().timers[0].time,25000);
});

test('shows retry and removes hidden intro class only if startup is still blocked',()=>{
 const f=fixture();
 f.timers[0].fn();
 assert.ok(f.body.classList.removed.includes('zyro-await-intro'));
 const overlay=f.elements.get('zyroStartupRecovery');
 assert.ok(overlay);
 assert.equal(overlay.properties.role,'alert');
 const section=overlay.children[0],retry=section.children[2];
 assert.equal(retry.textContent,'Riprova');
 assert.equal(section.children[0].textContent,'Impossibile completare il caricamento');
 f.context.window.ZyroStartupReady=true;
 f.intervals[0].fn();
 assert.equal(f.elements.has('zyroStartupRecovery'),false,'late successful startup hides the error');
});

test('does not interfere with a ready app and approved interface',()=>{
 const f=fixture(true);
 f.timers[0].fn();
 assert.equal(f.elements.has('zyroStartupRecovery'),false);
 assert.equal(f.body.classList.removed.length,0);
});
