import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PRODUCTS,accountId,evaluatePurchase,createTokenCipher} from './play-billing.mjs';

const when=Date.parse('2026-10-31T12:00:00Z');
const purchase=(productId,basePlanId,state='SUBSCRIPTION_STATE_ACTIVE',expires=when+86400000)=>({
  externalAccountIdentifiers:{obfuscatedExternalAccountId:accountId('zyro-user-1')},
  subscriptionState:state,
  acknowledgementState:'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
  lineItems:[{
    productId,
    offerDetails:{basePlanId},
    autoRenewingPlan:{autoRenewEnabled:true},
    expiryTime:new Date(expires).toISOString()
  }]
});
test('IDs match subscriptions and base plans configured in Google Play Console',()=>{
  assert.deepEqual(PRODUCTS,{
    zyro360_premium:{plan:'personal',basePlanId:'premium-mensile'},
    zyro360_family:{plan:'family',basePlanId:'family-mensile'}
  });
});
test('Premium unlocks personal tier, not Family audio',()=>{
  const out=evaluatePurchase(purchase('zyro360_premium','premium-mensile'),'zyro-user-1',when);
  assert.equal(out.active,true);
  assert.equal(out.plan,'personal');
});
test('Family unlocks the Family tier only when verified and unexpired',()=>{
  const out=evaluatePurchase(purchase('zyro360_family','family-mensile'),'zyro-user-1',when);
  assert.equal(out.active,true);
  assert.equal(out.plan,'family');
});
test('other Zyro account cannot reuse a purchase token',()=>{
  assert.throws(()=>evaluatePurchase(purchase('zyro360_family','family-mensile'),'zyro-user-2',when),/altro account/);
});
test('wrong base plan is rejected',()=>{
  assert.throws(()=>evaluatePurchase(purchase('zyro360_premium','monthly'),'zyro-user-1',when),/non riconosciuto/);
});
test('expiry or non-active state does not grant access',()=>{
  assert.equal(evaluatePurchase(purchase('zyro360_family','family-mensile','SUBSCRIPTION_STATE_EXPIRED'),'zyro-user-1',when).active,false);
  assert.equal(evaluatePurchase(purchase('zyro360_family','family-mensile','SUBSCRIPTION_STATE_ACTIVE',when-2000),'zyro-user-1',when).active,false);
});
test('AES-GCM purchase tokens remain encrypted at rest',()=>{
  const crypto=createTokenCipher(Buffer.alloc(32,5).toString('base64'));
  const value=crypto.encrypt('test-purchase-token-1234567');
  assert.notEqual(value,'test-purchase-token-1234567');
  assert.equal(crypto.decrypt(value),'test-purchase-token-1234567');
});
