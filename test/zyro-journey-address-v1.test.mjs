import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const js=readFileSync(new URL('../public/zyro-journey-address-v1.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/zyro-journey-address-v1.css',import.meta.url),'utf8');

test('Accompagnami asks for street, city and postal code and requires a confirmed map point',()=>{
 for(const id of ['journeyStreet','journeyCity','journeyPostcode','journeyFindAddress','journeyAddressResults','journeyAddressState','journeyChosenAddress','journeySeePin'])assert.match(html,new RegExp('id="'+id+'"'));
 assert.match(html,/type="text" maxlength="12" autocomplete="postal-code"/);
 assert.match(app,/if\(!destination\)throw Error/);
 assert.match(app,/if\(!journeyTarget\)throw Error/);
 assert.match(app,/destinationPoint:journeyTarget,autoArrival:auto/);
 assert.match(server,/app\.post\('\/api\/journey\/geocode',requireAuth,limit/);
 assert.match(server,/MAPTILER_API_KEY/);
 assert.match(server,/autocomplete','false'/);
 assert.match(server,/journeyAddressCooldown/);
 assert.match(server,/controller\.abort\(\),6500/);
 assert.match(js,/\/api\/journey\/geocode/);
 assert.match(js,/if\(ticket!==requestNo\)return/);
 assert.match(js,/button\.disabled=true/);
 assert.match(js,/journeyTarget=\{lat:Number\(point\.lat\),lon:Number\(point\.lon\)\}/);
});
test('blue point appears in raster map and Android MapLibre via removable marker',()=>{
 assert.match(app,/id:'journey:destination',p:journeyTarget,destination:true/);
 assert.match(app,/className='zyro-journey-map-pin'/);
 assert.match(app,/if\(!p\.destination\)updateMapAvatar/);
 assert.match(js,/new window\.maplibregl\.Marker/);
 assert.match(js,/setLngLat\(\[journeyTarget\.lon,journeyTarget\.lat\]\)/);
 assert.match(js,/pin\.remove\(\)/);
 assert.match(css,/#liveMap \.zyro-journey-map-pin/);
});
test('GPS-based arrival stays opt-in separately from merely choosing an address',()=>{
 assert.match(server,/autoArrival:req\.body\.autoArrival===true&&!!point/);
 assert.match(server,/j\.autoArrival===true\|\|\(j\.autoArrival===undefined&&!!j\.destinationPoint\)/);
 assert.match(app,/autoArrival:auto/);
 assert.match(html,/id="journeyAuto" type="checkbox"/);
});
test('stop and explicit restart are safe against duplicate or stale journey and preserve recipient checks',()=>{
 assert.match(html,/id="journeyCancel"/);
 assert.match(html,/id="journeyResume"/);
 assert.match(app,/v15JourneyEnd\(false\)/);
 assert.match(app,/post\('\/api\/journey\/resume',\{previousId:journey\.id\}\)/);
 assert.match(server,/old\.status!=='cancelled'\|\|old\.id!==req\.body\?\.previousId/);
 assert.match(server,/recipients\.length!==old\.recipients\.length/);
 assert.match(server,/autoSos:false,autoArrival:/);
 assert.match(server,/Nuovo orario previsto/);
 assert.match(server,/j\.status=arrived\?'arrived':'cancelled'/);
});
test('the how-it-works guide explains address confirmation, contacts, and cancellation',()=>{
 assert.match(html,/Accompagnami: scegli una meta sulla mappa/);
 assert.match(html,/via e numero civico, città e CAP/);
 assert.match(html,/Controlla il puntino blu/);
 assert.match(html,/Riattiva Accompagnami/);
 assert.match(html,/Disponibile con Base e Family/);
 assert.match(html,/zyro-journey-address-v1.js\?v=1/);
 assert.match(html,/zyro-journey-address-v1.css\?v=1/);
});

test('Address lookup never fills the separate Casa/Lavoro/Altro description',()=>{
 assert.match(html,/Dove stai andando\?<input id="journeyDestination" maxlength="70" placeholder="Es\. Casa, Lavoro, Palestra, Altro"/);
 assert.doesNotMatch(html,/id="journeyDestination"[^>]*readonly/);
 assert.doesNotMatch(js,/el\('journeyDestination'\)\.value=name\.slice/);
 assert.doesNotMatch(js,/el\('journeyDestination'\)\.value=''/);
 assert.doesNotMatch(app,/\$\('journeyDestination'\)\.value=text\.slice/);
 assert.match(html,/il nome non viene compilato dall'indirizzo/i);
});
