import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const start=app.indexOf('class ZyroRasterMap{');
const end=app.indexOf('function syncStableMarkers()',start);
assert.ok(start>0 && end>start,'production map implementation found');
const mapClass=app.slice(start,end);
const browser=await chromium.launch({
 headless:true,
 executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',
 args:['--no-sandbox','--disable-dev-shm-usage']
});
try{
 const page=await browser.newPage({viewport:{width:400,height:640},deviceScaleFactor:1});
 await page.setContent('<!doctype html><html lang="it"><head><style>body{margin:0;background:#e6f3f7}#liveMap{position:relative;width:400px;height:640px;overflow:hidden}#zyroVectorMap{position:absolute;inset:0;overflow:hidden;background:repeating-linear-gradient(45deg,#e4f2fa 0px,#e4f2fa 50px,#edf5ff 50px,#edf5ff 100px)}.zyro-raster-tiles,.zyro-raster-markers{position:absolute;inset:0;pointer-events:none}.zyro-raster-tiles{z-index:1}.zyro-raster-markers{z-index:2}</style></head><body><div id="liveMap"><div id="zyroVectorMap"></div></div><div id="journeyMapOverlay"></div></body></html>');
 await page.addStyleTag({content:fs.readFileSync(new URL('../public/zyro-journey-v71.css',import.meta.url),'utf8')});
 const setup=[
  "var activeView='modes',journeyMapCandidate={lat:45.4,lon:9.1},journeyPreviewPositionLocked=true;",
  "var current={me:{id:'owner'},journeys:[]},lastCoords=null,TILE_SIZE=256,ZYRO_MAP_MAX_ZOOM=19;",
  "var $=id=>document.getElementById(id);",
  "function mapValidPoint(p){return Number.isFinite(p?.lat)&&Number.isFinite(p?.lon);}",
  "function clamp(n,lo,hi){return Math.min(Math.max(n,lo),hi);}",
  "function worldWidth(z){return 256*Math.pow(2,z);}",
  "function toWorld(lat,lon,z){const size=worldWidth(z);const rad=lat*Math.PI/180;return {x:(lon+180)/360*size,y:(.5-Math.log((1+Math.sin(rad))/(1-Math.sin(rad)))/(4*Math.PI))*size};}",
  "function fromWorld(x,y,z){const size=worldWidth(z);return {lon:x/size*360-180,lat:Math.atan(Math.sinh(Math.PI*(1-2*y/size)))*180/Math.PI};}",
  "function uniqueContacts(){return [];}"
 ].join('\n');
 await page.addScriptTag({content:setup+'\n'+mapClass+'\nwindow.testMap=new ZyroRasterMap(document.getElementById("zyroVectorMap"),{lat:45.4,lon:9.1},16);window.testCenter=toWorld(45.4,9.1,16);window.testMap.drawPreviewDestination(400,640,window.testCenter);'});
 const svg=page.locator('.zyro-destination-svg-layer');
 const pin=page.locator('#liveMap .zyro-journey-preview-pin');
 const circle=pin.locator('.zyro-journey-preview-pin-center');
 assert.equal(await svg.count(),1);
 assert.equal(await svg.evaluate(e=>getComputedStyle(e).display),'none','outer HTML marker takes priority over WebView SVG');
 assert.equal(await pin.count(),1);
 assert.equal(await pin.evaluate(e=>getComputedStyle(e).display),'flex');
 assert.equal(await pin.evaluate(e=>getComputedStyle(e).zIndex),'90');
 assert.equal(await pin.evaluate(e=>e.style.left),'200px');
 assert.equal(await pin.evaluate(e=>e.style.top),'320px');
 assert.ok(await circle.isVisible(),'violet HTML marker must actually be visible');
 const rect=await circle.boundingBox();
 assert.ok(rect&&rect.width>=25&&rect.height>=25,'violet circle must occupy visible screen pixels');
 await page.evaluate(()=>{const p=window.testCenter;window.testMap.drawPreviewDestination(400,640,{x:p.x+100,y:p.y});});
 assert.equal(await pin.evaluate(e=>e.style.left),'100px','marker remains geographically anchored during panning');
 await page.evaluate(()=>{window.testMap.drawPreviewDestination(400,640,window.testCenter);});
 await page.screenshot({path:'zyro-journey-destination-browser-smoke.png'});
 console.log('PASS: the purple pin is actually painted in Chrome and remains anchored to geographic coordinates.');
}finally{
 await browser.close();
}
