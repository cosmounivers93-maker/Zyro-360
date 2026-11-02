// Pure LifeGuard timing policy; no subscriptions, network or location state here.
// Grace always begins at the first server-observed deadline, never at a client clock.
export const LIFE_GUARD_GRACE_MS=120_000;
export function lifeGuardGraceUntil(observedAt){
 if(!Number.isFinite(observedAt)||observedAt<0)throw new RangeError('Orario non valido');
 return observedAt+LIFE_GUARD_GRACE_MS;
}
export function lifeGuardShouldEscalate(entry,at){
 return !!entry && entry.status==='late' && entry.autoSOS===true &&
   entry.sosSent!==true && Number.isFinite(entry.graceUntil) &&
   Number.isFinite(at) && entry.graceUntil<=at;
}
