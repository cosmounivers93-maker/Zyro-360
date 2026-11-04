import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../public/zyro-journey-v71.css',import.meta.url),'utf8');

test('Arrival and cancellation are always visible at the top of an active trip',()=>{
 const activeStart=html.indexOf('id="journeyActive"');
 const optionsStart=html.indexOf('id="zyroJourneyOptions"');
 const destinationStart=html.indexOf('id="journeyInactive"');
 assert.ok(activeStart>0 && optionsStart>activeStart && destinationStart>optionsStart,
  'active controls must appear ahead of the long destination form');
 assert.match(html,/id="journeyArrived"[^>]*>✓ Sono arrivato a destinazione/);
 assert.match(html,/id="journeyCancel"[^>]*>Annulla percorso/);
 assert.match(app,/\$\('journeyArrived'\)\.addEventListener\('click',\(\)=>action\(\(\)=>v15JourneyEnd\(true\)\)\)/);
 assert.match(app,/\$\('journeyCancel'\)\.addEventListener\('click',\(\)=>action\(\(\)=>v15JourneyEnd\(false\)\)\)/);
 assert.match(app,/post\('\/api\/journey\/end',\{arrived\}\)/);
 assert.doesNotMatch(html,/Riattiva Accompagnami/);
});

test('Active journey hides preparation and restores it once the journey ends',()=>{
 const start=app.indexOf('function renderV15(){');
 const end=app.indexOf('function zyroJourneyMeters',start);
 assert.ok(start>0&&end>start);
 const nodes={};
 function node(id){
  if(!nodes[id]){
   const selected=new Set(id==='journeyActive'?['hidden']:[]);
   nodes[id]={id,hidden:false,open:true,dataset:{},classList:{
    has:n=>selected.has(n),
    toggle:(n,on)=>on?selected.add(n):selected.delete(n),
    contains:n=>selected.has(n)
   },innerHTML:'',textContent:''};
  }
  return nodes[id];
 }
 const context={
  current:{me:{premiumActive:true,creatorPremium:true,journey:{id:'trip1',status:'active',destination:'Casa',dueAt:Date.now()+600000}},
   journeys:[],checkins:[],billingReady:true},
  $:node,uniqueContacts:()=>[],v15ContactsHtml:()=>'',renderBillingActions:()=>{},
  v15Time:()=> '14:20',journeySelected:new Set(),checkinSelected:new Set(),
  updateMarkupIfChanged:()=>{},escapeHtml:s=>s,hasFamilyPlan:()=>true,
  mapValidPoint:()=>false,zyroJourneyMeters:()=>0
 };
 const render=vm.runInNewContext(app.slice(start,end)+'\nrenderV15',context);
 render();
 assert.equal(nodes.zyroJourneyOptions.hidden,true);
 assert.equal(nodes.zyroJourneyOptions.open,false);
 assert.equal(nodes.journeyActive.classList.contains('hidden'),false);
 assert.equal(nodes.journeyInactive.classList.contains('hidden'),true);
 assert.equal(nodes.journeyStatus.textContent,'Percorso attivo');
 context.current.me.journey={id:'trip1',status:'cancelled'};
 render();
 assert.equal(nodes.zyroJourneyOptions.hidden,false);
 assert.equal(nodes.journeyActive.classList.contains('hidden'),true);
 assert.equal(nodes.journeyInactive.classList.contains('hidden'),false);
});

test('Address search selects first valid result and enables map button immediately',async()=>{
 const start=app.indexOf('async function searchJourneyAddress(){');
 const end=app.indexOf('function openJourneyMapPreview(',start);
 assert.ok(start>0&&end>start);
 const nodes={
  journeyStreet:{value:'Via Test 5'},journeyCity:{value:'Milano'},journeyPostal:{value:'20100'},
  journeyTargetInfo:{textContent:''},journeyViewMap:{disabled:true},
  journeyAddressResults:{hidden:true,innerHTML:''}
 };
 const ctx={
  $:id=>nodes[id],hasZyroNativeBridge:()=>false,post:async()=>({items:[
   {label:'Via Test 5, Milano',lat:45.4,lon:9.1},
   {label:'Via Test 5, Napoli',lat:40.8,lon:14.2}
  ]}),
  mapValidPoint:p=>!!p&&Number.isFinite(p.lat)&&Number.isFinite(p.lon),
  escapeHtml:s=>s,journeyAddressChoice:null,journeyAddressResults:[],journeyTarget:null
 };
 const search=vm.runInNewContext(app.slice(start,end)+'\nsearchJourneyAddress',ctx);
 await search();
 assert.equal(nodes.journeyViewMap.disabled,false);
 assert.equal(ctx.journeyAddressChoice.label,'Via Test 5, Milano');
 assert.match(nodes.journeyAddressResults.innerHTML,/aria-pressed="true"/);
});

test('Map preview displays purple centered destination, compact controls away from SOS',()=>{
 assert.match(html,/id="journeyPreviewPin"[^>]*zyro-journey-preview-pin hidden/);
 assert.match(app,/\$\('journeyPreviewPin'\)\.classList\.remove\('hidden'\)/);
 assert.match(app,/\$\('journeyPreviewPin'\)\.classList\.add\('hidden'\)/);
 assert.match(css,/\.zyro-journey-map-overlay:not\(\.hidden\)[\s\S]*?align-items:flex-start/);
 assert.match(css,/\.zyro-journey-preview-pin:not\(\.hidden\)/);
 assert.match(css,/top:50%/);
 assert.match(html,/id="journeyPreviewCancel"/);
 assert.match(html,/id="journeyPreviewSet"/);
});

test('Preparation shows both journey-ending commands but disables them until a trip is active',()=>{
 const prepStart=html.indexOf('id="journeyInactive"');
 const prepEnd=html.indexOf('id="journeyContactsStatus"',prepStart);
 const part=html.slice(prepStart,prepEnd);
 assert.ok(part.includes('id="journeyPendingActions"'));
 const pending=part.slice(part.indexOf('id="journeyPendingActions"'));
 assert.match(pending,/<button[^>]*disabled[^>]*>✓ Sono arrivato a destinazione<\/button>/);
 assert.match(pending,/<button[^>]*disabled[^>]*>Annulla percorso<\/button>/);
 assert.match(pending,/I due comandi si attivano solo dopo/);
 // The enabled, wired buttons have unique IDs and remain outside the inactive form.
 assert.equal((html.match(/id="journeyArrived"/g)||[]).length,1);
 assert.equal((html.match(/id="journeyCancel"/g)||[]).length,1);
 const active=html.slice(html.indexOf('id="journeyActive"'),html.indexOf('id="zyroJourneyOptions"'));
 assert.match(active,/<button id="journeyArrived"[^>]*>✓ Sono arrivato a destinazione<\/button>/);
 assert.match(active,/<button id="journeyCancel"[^>]*>Annulla percorso<\/button>/);
});
