import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {lifeGuardGraceUntil,lifeGuardShouldEscalate,LIFE_GUARD_GRACE_MS} from '../lifeguard-policies.mjs';

test('LifeGuard uses a fixed 2-minute grace after a missed check',()=>{
 assert.equal(LIFE_GUARD_GRACE_MS,120000);
 assert.equal(lifeGuardGraceUntil(1000),121000);
 assert.throws(()=>lifeGuardGraceUntil(NaN),RangeError);
});
test('an absent explicit SOS opt-in must never escalate',()=>{
 const at=Date.now(),entry={status:'late',autoSOS:false,graceUntil:at-100,sosSent:false};
 assert.equal(lifeGuardShouldEscalate(entry,at),false);
 assert.equal(lifeGuardShouldEscalate({...entry,autoSOS:undefined},at),false);
});
test('only an overdue, not-yet-sent eligible check escalates',()=>{
 const at=Date.now(),base={status:'late',autoSOS:true,graceUntil:at-1,sosSent:false};
 assert.equal(lifeGuardShouldEscalate(base,at),true);
 assert.equal(lifeGuardShouldEscalate({...base,sosSent:true},at),false);
 assert.equal(lifeGuardShouldEscalate({...base,status:'cancelled'},at),false);
 assert.equal(lifeGuardShouldEscalate({...base,status:'confirmed'},at),false);
 assert.equal(lifeGuardShouldEscalate({...base,graceUntil:at+1},at),false);
 assert.equal(lifeGuardShouldEscalate({...base,graceUntil:null},at),false);
});
test('frontend consent and server subscription gates are explicit',()=>{
 const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 assert.match(server,/app\.post\('\/api\/lifeguard\/fall',requireAuth,limit/);
 assert.match(server,/req\.user\.lifeguardFallEnabled!==true/);
 assert.match(server,/req\.user\.lifeguardLastFallAt=now\(\)/);
 assert.match(server,/if\(!premiumActive\(req\.user\)\)return res\.status\(402\)/);
 assert.match(html,/id="lifeGuardPanel"/);
 assert.match(html,/id="journeyAutoSOS" type="checkbox"/);
 assert.match(html,/id="checkinAutoSOS" type="checkbox"/);
 assert.match(app,/autoSOS:\$\('journeyAutoSOS'\)\.checked/);
 assert.match(app,/autoSOS:\$\('checkinAutoSOS'\)\.checked/);
 assert.doesNotMatch(html.slice(html.indexOf('id="lifeGuardPanel"'),html.indexOf('id="chatsView"')),/sperimentale/i);
});
