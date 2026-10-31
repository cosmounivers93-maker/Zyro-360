import test from 'node:test';
import assert from 'node:assert/strict';
import {PRODUCTS,accountId,evaluatePurchase} from '../play-billing.mjs';

const USER='test-user-001', NOW=Date.parse('2026-10-31T13:00:00Z');
function receipt(productId,basePlanId,account=accountId(USER)){
 return {
  externalAccountIdentifiers:{obfuscatedExternalAccountId:account},
  subscriptionState:'SUBSCRIPTION_STATE_ACTIVE',
  lineItems:[{
   productId,
   offerDetails:{basePlanId},
   autoRenewingPlan:{autoRenewEnabled:true},
   expiryTime:new Date(NOW+30*86400000).toISOString()
  }]
 };
}
test('Google Play product IDs match current Play Console',()=>{
 assert.deepEqual(Object.keys(PRODUCTS).sort(),['zyro360_family','zyro360_premium']);
 assert.equal(PRODUCTS.zyro360_premium.basePlanId,'premium-mensile');
 assert.equal(PRODUCTS.zyro360_family.basePlanId,'family-mensile');
});
test('Premium monthly receipt grants only personal features',()=>{
 const result=evaluatePurchase(receipt('zyro360_premium','premium-mensile'),USER,NOW);
 assert.equal(result.plan,'personal');
 assert.equal(result.active,true);
});
test('Family receipt requires the configured monthly base plan and grants family',()=>{
 assert.equal(evaluatePurchase(receipt('zyro360_family','family-mensile'),USER,NOW).plan,'family');
 assert.throws(()=>evaluatePurchase(receipt('zyro360_family',''),USER,NOW),/non riconosciuto/);
 assert.throws(()=>evaluatePurchase(receipt('zyro360_family','wrong-plan'),USER,NOW),/non riconosciuto/);
});
test('Reject unrecognized product IDs, mismatched Premium plans and wrong user',()=>{
 assert.throws(()=>evaluatePurchase(receipt('zyro_premium_monthly','monthly'),USER,NOW),/non riconosciuto/);
 assert.throws(()=>evaluatePurchase(receipt('zyro360_premium','monthly'),USER,NOW),/non riconosciuto/);
 assert.throws(()=>evaluatePurchase(receipt('zyro360_premium','premium-mensile','someone-else'),USER,NOW),/altro account/);
});
test('Expired subscription grants no active access',()=>{
 const r=receipt('zyro360_premium','premium-mensile');
 r.lineItems[0].expiryTime=new Date(NOW-1000).toISOString();
 assert.equal(evaluatePurchase(r,USER,NOW).active,false);
});
