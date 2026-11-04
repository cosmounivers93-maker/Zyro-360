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

test('Map preview displays a native violet SVG destination and leaves SOS dialog placement unchanged',()=>{
 assert.doesNotMatch(html,/id="journeyPreviewPin"/);
 assert.match(app,/this\.previewGroup\.setAttribute\('id','journeyDestinationSvgPin'\)/);
 assert.match(app,/this\.previewSvg\.append\(this\.previewGroup\)/);
 assert.match(app,/this\.el\.replaceChildren\(this\.layer,this\.routeLayer,this\.pinLayer,this\.previewSvg\)/);
 assert.match(app,/zIndex:'50'/);
 assert.match(css,/\.zyro-journey-map-overlay:not\(\.hidden\)[\s\S]*?align-items:flex-end/);
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

test('Accompagnami offers an expected arrival date and server-backed SOS deadline',()=>{
 const server=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 assert.match(html,/id="journeyDueAt" type="datetime-local"/);
 assert.doesNotMatch(html,/id="journeyAuto"/);
 assert.match(html,/id="journeyArrived"/);
 assert.match(html,/id="journeyCancel"/);
 const journeyStart=app.slice(app.indexOf('async function v15JourneyStart('),app.indexOf('async function v15JourneyEnd('));
 assert.match(journeyStart,/new Date\(etaInput.value\).getTime\(\)/);
 assert.match(journeyStart,/post\('\/api\/journey\/start',\{destination,recipients,destinationPoint:journeyTarget,dueAt\}\)/);
 const postStart=server.slice(server.indexOf("app.post('/api/journey/start'"),server.indexOf("app.post('/api/journey/respond'"));
 assert.match(postStart,/req.body\?\.dueAt/);
 assert.match(postStart,/dueAt,autoArrival:false/);
 const scheduled=server.slice(server.indexOf('function overdueCheck(){'),server.indexOf("app.get('/api/premium/status'"));
 assert.match(scheduled,/j\.dueAt<=t/);
 assert.match(scheduled,/kind:'sos',source:'journey-deadline'/);
 assert.match(scheduled,/j\.autoSosPushStatus='pending'/);
 assert.match(scheduled,/c\.dueAt/);
});

test('Searched destination retains geographic coordinates while map can pan, manual selection remains adjustable',()=>{
 assert.match(app,/let journeyPreviewPositionLocked=false/);
 assert.doesNotMatch(app,/this\.onDown=e=>\{if\(journeyPreviewPositionLocked\)/);
 assert.doesNotMatch(app,/this\.onMove=e=>\{\s*if\(journeyPreviewPositionLocked\)/);
 assert.match(app,/const point=journeyPreviewPositionLocked \? journeyMapCandidate : \(stableMap\?\.center\|\|journeyMapCandidate\)/);
 assert.match(app,/openJourneyMapPreview\(journeyAddressChoice,true\)/);
 assert.match(app,/openJourneyMapPreview\(journeyTarget\|\|lastCoords\|\|DEFAULT_CENTER,false\)/);
 assert.match(html,/id="journeyMapHint"/);
});

test('Violet SVG stays visible and geographically anchored while map moves',()=>{
 const start=app.indexOf(' drawPreviewDestination(w,h,center){');
 const end=app.indexOf('\n drawPins(w,h,center){',start);
 assert.ok(start>0&&end>start);
 const mapNode={classList:{contains:()=>false}};
 const svg={style:{},viewBox:'',setAttribute(name,value){this[name]=value;}};
 const group={transform:'',setAttribute(name,value){this[name]=value;}};
 const ctx={
  $:()=>mapNode,
  mapValidPoint:p=>Number.isFinite(p?.lat)&&Number.isFinite(p?.lon),
  journeyMapCandidate:{lat:45.4,lon:9.1},
  journeyPreviewPositionLocked:true,
  toWorld:(lat,lon)=>({x:lon*100,y:lat*100}),
  worldWidth:()=>100000
 };
 const draw=vm.runInNewContext('({'+app.slice(start,end).trim()+'}).drawPreviewDestination',ctx);
 const raster={previewSvg:svg,previewGroup:group,zoom:16};
 draw.call(raster,400,800,{x:910,y:4540});
 assert.equal(svg.style.display,'block');
 assert.equal(svg.viewBox,'0 0 400 800');
 assert.equal(group.transform,'translate(200 400)');
 draw.call(raster,400,800,{x:1010,y:4540});
 assert.equal(group.transform,'translate(100 400)');
 ctx.journeyPreviewPositionLocked=false;
 draw.call(raster,400,800,{x:1010,y:4540});
 assert.equal(group.transform,'translate(200 400)');
 // When confirmation closes, no destination marker should remain.
 mapNode.classList.contains=()=>true;
 draw.call(raster,400,800,{x:1010,y:4540});
 assert.equal(svg.style.display,'none');
});
test('GPS recentering never hides the destination marker during Accompagnami preview',()=>{
 const start=app.indexOf('function renderMap(){');
 const end=app.indexOf('function onOrientation(',start);
 assert.ok(start>0&&end>start);
 const ctx={
  current:{me:{}}, stableMap:{center:{lat:45.2,lon:9.2}},ownCentered:false,
  journeyPreviewMapFocused:false,journeyMapCandidate:{lat:45.4,lon:9.1},
  $:id=>id==='homeView'?{classList:{contains:()=>false}}:{classList:{contains:()=>false}},
  mapValidPoint:p=>p!=null&&Number.isFinite(p.lat)&&Number.isFinite(p.lon),
  mapLink(){},ensureStableMap(){},syncStableMarkers(){},
  focusStableMap(lat,lon,zoom){ctx.focusCalls.push([lat,lon,zoom]);},
  focusCalls:[],lastCoords:{lat:45.7,lon:9.7},stableMapState:'ready',
  mapStatus(){}, geolocationError:'',uniqueContacts:()=>[]
 };
 const render=vm.runInNewContext(app.slice(start,end)+'\nrenderMap',ctx);
 render();render();
 assert.deepEqual(ctx.focusCalls,[[45.4,9.1,16]],'preview must be centered once on searched address, not on owner GPS');
 assert.equal(ctx.journeyPreviewMapFocused,true);
});
test('Map confirmation floats directly above live GPS/SOS action buttons',()=>{
 assert.match(app,/function positionJourneyPreviewDialog\(\)/);
 assert.match(app,/document\.querySelector\('#homeView \.zyro-command-row'\)/);
 assert.match(app,/window\.innerHeight-top\+12/);
 assert.match(app,/--zyro-journey-panel-bottom/);
 assert.match(css,/padding:0 14px var\(--zyro-journey-panel-bottom/);
 assert.match(css,/align-items:flex-end/);
});
