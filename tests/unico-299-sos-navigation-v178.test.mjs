import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PRODUCTS,evaluatePurchase,accountId} from '../play-billing.mjs';
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const help=html.slice(html.indexOf('<section class="how-it-works" id="zyroHelp"'),html.indexOf('</section>',html.indexOf('<section class="how-it-works" id="zyroHelp"')));

test('Only one 2,99 euro monthly subscription is visible in the web storefront',()=>{
 assert.match(html,/id="zyroUnicoTitle">ZYRO 360/);
 assert.match(html,/2,99 €/);
 assert.match(html,/SOS rapido/);
 assert.match(html,/Navigazione SOS/);
 for(const s of ['ZYRO Premium','ZYRO Family','3,99','6,99','Seleziona abbonamenti','Funzioni e accesso Premium'])assert.ok(!html.includes(s),'Old storefront text: '+s);
 assert.doesNotMatch(html,/id="zyroFamilyTitle"/);
 assert.doesNotMatch(html,/id="zyroPersonalTitle"/);
 assert.match(app,/Abbonati a 2,99 €\/mese/);
 assert.match(app,/data-billing-open/);
});
test('SOS rapido and map navigation have step-by-step consent-aware help',()=>{
 const must=['SOS rapido: invia','SOS rapido è compreso nel piano unico','Navigazione SOS: raggiungi','1. Ricevi l’allarme','2. Premi «Naviga»','3. Durante il percorso','4. Pericolo reale','OpenStreetMap/FOSSGIS','112','destinatario SOS autorizzato','possono subire ritardi'];
 for(const s of must)assert.ok(help.includes(s), 'Help missing '+s);
});
test('New product accepted only through server-side verified monthly receipt; previous products remain restorables',()=>{
 assert.equal(PRODUCTS.zyro360_unico?.basePlanId,'unico-mensile');
 assert.equal(PRODUCTS.zyro360_unico?.plan,'unico');
 const now=1800000000000;
 const receipt={
  externalAccountIdentifiers:{obfuscatedExternalAccountId:accountId('customer')},
  subscriptionState:'SUBSCRIPTION_STATE_ACTIVE',
  lineItems:[{productId:'zyro360_unico',offerDetails:{basePlanId:'unico-mensile'},autoRenewingPlan:{autoRenewEnabled:true},expiryTime:new Date(now+86400000).toISOString()}]
 };
 const result=evaluatePurchase(receipt,'customer',now);
 assert.equal(result.active,true);assert.equal(result.plan,'unico');
 assert.ok(PRODUCTS.zyro360_premium&&PRODUCTS.zyro360_family,'Existing subscribers must still be recognized');
 receipt.lineItems[0].offerDetails.basePlanId='wrong';
 assert.throws(()=>evaluatePurchase(receipt,'customer',now),/non riconosciuto/);
 assert.match(server,/const premiumActive = user => premiumPlan\(user\)!=='free'/);
 assert.match(server,/const familyActive = user => premiumActive\(user\)/);
});