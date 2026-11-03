import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {PlayBilling,accountId} from '../play-billing.mjs';

const USER='zyro-plan-switch-tester';
const NOW=Date.parse('2026-11-03T12:00:00Z');
const PERSONAL='zyro360_premium',FAMILY='zyro360_family';
const BASE={zyro360_premium:'premium-mensile',zyro360_family:'family-mensile'};
function purchase(product,linkedPurchaseToken,overrides={}){
  return {
    externalAccountIdentifiers:{obfuscatedExternalAccountId:accountId(USER)},
    subscriptionState:'SUBSCRIPTION_STATE_ACTIVE',
    acknowledgementState:'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    ...(linkedPurchaseToken?{linkedPurchaseToken}:{}),
    lineItems:[{productId:product,offerDetails:{basePlanId:BASE[product]},
      autoRenewingPlan:{autoRenewEnabled:true},
      expiryTime:new Date(NOW+30*86400000).toISOString()}],
    ...overrides
  };
}
function mock(purchases){
  const rows=new Map();
  const repo={
    get:async key=>rows.get(key)||null,
    put:async row=>{rows.set(row.tokenHash,{...row});},
    user:async user=>[...rows.values()].filter(row=>row.userId===user),
    due:async()=>[]
  };
  const google={get:async token=>{
    if(!purchases[token])throw Error('Missing Google receipt');
    return purchases[token];
  },acknowledge:async()=>{}};
  const billing=new PlayBilling({repo,google,cipher:{encrypt:token=>'encrypted:'+token,
    decrypt:token=>token.slice(10)},clock:()=>NOW});
  return {rows,billing};
}
for(const [oldPlan,newPlan] of [[PERSONAL,FAMILY],[FAMILY,PERSONAL]]){
  test(`Play verified switch ${oldPlan} => ${newPlan} replaces old entitlement permanently`,async()=>{
    const oldToken='old-valid-play-token-123456789';
    const newToken='new-valid-play-token-987654321';
    const {rows,billing}=mock({[oldToken]:purchase(oldPlan),[newToken]:purchase(newPlan,oldToken)});
    assert.equal((await billing.verify(USER,oldToken)).active,true);
    assert.equal(billing.entitlement(USER).productId,oldPlan);
    assert.equal((await billing.verify(USER,newToken)).active,true);
    assert.equal(billing.entitlement(USER).productId,newPlan);
    const hash=crypto.createHash('sha256').update(oldToken).digest('hex');
    assert.equal(rows.get(hash).state,'REPLACED');
    assert.equal(rows.get(hash).active,false);
    const stale=await billing.verify(USER,oldToken);
    assert.equal(stale.active,false,'late event cannot revive the old subscription');
    assert.equal(billing.entitlement(USER).productId,newPlan);
  });
}
test('an unverified or pending change leaves the old plan active',async()=>{
  const oldToken='old-verified-family-123456789';
  const newToken='new-pending-premium-123456789';
  const pending=purchase(PERSONAL,oldToken,{subscriptionState:'SUBSCRIPTION_STATE_PENDING'});
  const {billing}=mock({[oldToken]:purchase(FAMILY),[newToken]:pending});
  await billing.verify(USER,oldToken);
  assert.equal((await billing.verify(USER,newToken)).active,false);
  assert.equal(billing.entitlement(USER).productId,FAMILY);
});
test('foreign account cannot replace a ZYRO subscription',async()=>{
  const oldToken='old-valid-personal-123456789';
  const newToken='foreign-upgrade-token-987654321';
  const foreign=purchase(FAMILY,oldToken,{
    externalAccountIdentifiers:{obfuscatedExternalAccountId:accountId('another-user')}
  });
  const {billing}=mock({[oldToken]:purchase(PERSONAL),[newToken]:foreign});
  await billing.verify(USER,oldToken);
  await assert.rejects(billing.verify(USER,newToken),/altro account/i);
  assert.equal(billing.entitlement(USER).productId,PERSONAL);
});
