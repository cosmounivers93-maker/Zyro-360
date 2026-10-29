import express from 'express';
import {isIP} from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import webpush from 'web-push';
import pg from 'pg';
import firebaseAdmin from 'firebase-admin';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const dbPath = path.join(dataDir, 'zyro360.json');
const initial = { users: {}, circles: {}, memberships: [], invites: {}, sessions: {}, alerts: {}, messages: {}, journeys: {}, checkins: {} };

// Firebase Admin is server-only. Add FIREBASE_SERVICE_ACCOUNT_JSON as a secret
// on Render; never upload its JSON key, private_key or access tokens to GitHub.
let fcmReady = false;
const fcmSecret = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
if (fcmSecret) {
  const serviceAccount = JSON.parse(fcmSecret);
  if (serviceAccount.project_id !== 'zyro-360') {
    throw new Error('Firebase service account belongs to the wrong project.');
  }
  firebaseAdmin.initializeApp({
    credential:firebaseAdmin.credential.cert(serviceAccount)
  });
  fcmReady = true;
}
// V15.5: PostgreSQL is the authoritative store. The previous local JSON file was
// TEMPORARY on free Render and MUST NOT be mistaken for a durable database.
// This bridge uses one JSONB snapshot for compatibility with existing features;
// move to relational tables and proper transaction-level concurrency before scaling.
let db = structuredClone(initial);
let pgPool = null;
let persistenceQueue = Promise.resolve();
let persistenceFailure = null;
let storageKind = 'temporary';
const PG_SQL = 'INSERT INTO zyro360_state (id, payload, updated_at) VALUES (1, $1::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload, updated_at=NOW()';
async function initializeStorage() {
  const url = String(process.env.DATABASE_URL || '').trim();
  if (url) {
    if (!/^postgres(?:ql)?:\/\//i.test(url)) throw new Error('DATABASE_URL deve essere un indirizzo PostgreSQL valido.');
    pgPool = new pg.Pool({ connectionString:url, max:3, connectionTimeoutMillis:12000, idleTimeoutMillis:30000 });
    pgPool.on('error',err=>console.error('[ZYRO storage] Connessione inattiva:',err.message));
    await pgPool.query('CREATE TABLE IF NOT EXISTS zyro360_state (id INTEGER PRIMARY KEY CHECK (id=1), payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const result = await pgPool.query('SELECT payload FROM zyro360_state WHERE id=1');
    if (result.rowCount) {
      const saved = result.rows[0].payload;
      if (!saved || typeof saved !== 'object' || Array.isArray(saved) || !saved.users || !saved.sessions) {
        throw new Error('Il database contiene un archivio ZYRO non valido: avvio bloccato per proteggere i profili.');
      }
      db = { ...initial, ...saved };
      console.log(`[ZYRO storage] PostgreSQL: ${Object.keys(db.users).length} profili recuperati.`);
    } else {
      // IMPORTANT: The first deploy cannot read the PREVIOUS instance's
      // ephemeral filesystem. Never promise to recover its users automatically.
      db = structuredClone(initial);
      await pgPool.query(PG_SQL,[JSON.stringify(db)]);
      console.warn('[ZYRO storage] Database PostgreSQL nuovo. I vecchi profili su disco temporaneo NON sono stati migrati.');
    }
    storageKind = 'postgres';
  } else {
    if (process.env.ZYRO_REQUIRE_PERSISTENT_DB === 'true') {
      throw new Error('Archivio persistente obbligatorio: configura DATABASE_URL prima del deploy.');
    }
    try { db = { ...initial, ...JSON.parse(fs.readFileSync(dbPath, 'utf8')) }; }
    catch (err) { if (err.code !== 'ENOENT') throw err; db = structuredClone(initial); }
    console.warn('[ZYRO storage] MODALITÀ TEMPORANEA: account e chat possono sparire a ogni deploy/riavvio.');
  }
  db.journeys ||= {}; db.checkins ||= {}; db.adminAudit ||= []; db.userReports ||= [];
}
// Admin identity is pinned by a server-side user ID, never by a browser flag or email address.
const ADMIN_ID = String(process.env.ZYRO_ADMIN_USER_ID || '').trim();
// Browser microphone tracks cannot survive a backend restart; do not claim audio is live.
for (const alert of Object.values(db.alerts)) alert.hasAudio = false;
let locations = new Map();
const sockets = new Map();
const throttle = new Map();
const PORT = Number(process.env.PORT || 3000);
const prod = process.env.NODE_ENV === 'production';
const SESSION_MAX_AGE = 30 * 24 * 3600 * 1000;
const MAX_USER_CIRCLES = 12;
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const token = (n = 24) => crypto.randomBytes(n).toString('base64url');
const now = () => Date.now();
// Only a verified, server-side purchase may set premiumUntil. Never trust premium=true from a browser.
// Actual Play Billing purchase verification is NOT configured in this web prototype.
// Entitlements are server-owned. Subscription verification will set plan + expiry.
const premiumPlan = user => {
 if(isAdmin(user)||user?.premiumGiftLifetime===true)return 'family';
 if(Number(user?.premiumUntil||0)<=now())return 'free';
 return user?.premiumPlan==='family'?'family':'personal';
};
const premiumActive = user => premiumPlan(user)!=='free';
const familyActive = user => premiumPlan(user)==='family';
const planFeatures = user => ({sos:premiumActive(user),pickpocket:premiumActive(user),sosAudio:familyActive(user),journey:familyActive(user),checkin:familyActive(user)});
const isAdmin = user => Boolean(ADMIN_ID && user && user.id === ADMIN_ID && !user.bannedAt);
const banNotice = 'A causa di una violazione delle norme e delle politiche di utilizzo, risulta che tu abbia utilizzato in modo scorretto ZYRO 360. Il tuo account è stato sospeso. Se ritieni si tratti di un errore, contatta l’assistenza tramite i recapiti dell’informativa privacy.';
const allowedRecipients = (userId, ids) => Array.isArray(ids) && ids.length <= 60 && ids.every(x => typeof x==='string' && x.length < 100) ? [...new Set(ids)].filter(x=>x!==userId && sharedCircle(userId,x)) : null;
function validCoords(point){const lat=Number(point?.lat),lon=Number(point?.lon),accuracy=Number(point?.accuracy||0);return Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)<=90&&Math.abs(lon)<=180&&Number.isFinite(accuracy)&&accuracy>=0&&accuracy<=100000?{lat,lon,accuracy,updatedAt:now()}:null;}
function metersBetween(a,b){const r=Math.PI/180,phi=(b.lat-a.lat)*r,l=(b.lon-a.lon)*r;const q=Math.sin(phi/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(l/2)**2;return 12742000*Math.atan2(Math.sqrt(q),Math.sqrt(1-q));}
const publicJourney = (j,viewer) => j && (j.userId===viewer || (j.recipients||[]).includes(viewer)) ? {id:j.id,userId:j.userId,name:db.users[j.userId]?.name||'Contatto',destination:j.destination,dueAt:j.dueAt,startedAt:j.startedAt,status:j.status,arrivedAt:j.arrivedAt||null,autoArrival:!!j.destinationPoint} : null;
const publicCheckin = (c,viewer) => c && (c.userId===viewer || (c.recipients||[]).includes(viewer)) ? {id:c.id,userId:c.userId,name:db.users[c.userId]?.name||'Contatto',dueAt:c.dueAt,status:c.status,completedAt:c.completedAt||null} : null;

const cleanText = (s, max = 60) => String(s || '').trim().replace(/[\u0000-\u001F\u007F<>]/g, '').slice(0, max);
const publicUser = u => ({ id: u.id, name: u.name, avatar: u.avatar || null });
function save() {
  if (persistenceFailure) throw new Error('Database temporaneamente indisponibile: modifica non confermata.');
  const snapshot = JSON.stringify(db);
  if (pgPool) {
    // Serialized, immutable snapshots avoid out-of-order writes. Each successful
    // mutating HTTP response waits for all queued writes before acknowledging.
    persistenceQueue = persistenceQueue.then(()=>pgPool.query(PG_SQL,[snapshot]));
    persistenceQueue.catch(err=>{
      persistenceFailure=err;
      console.error('[ZYRO storage] Salvataggio PostgreSQL fallito:',err.message);
    });
    return;
  }
  const tmp = `${dbPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp,snapshot,{mode:0o600});
  fs.renameSync(tmp,dbPath);
}

function passwordHash(p, salt) { return crypto.scryptSync(p, salt, 64).toString('hex'); }
function verifyPassword(p, u) { const stored = Buffer.from(u.passwordHash, 'hex'); const calc = Buffer.from(passwordHash(p, u.salt), 'hex'); return stored.length === calc.length && crypto.timingSafeEqual(stored, calc); }
function getCookie(req, key) { const raw = req.headers.cookie || ''; const part = raw.split(';').map(x => x.trim()).find(x => x.startsWith(`${key}=`)); return part ? decodeURIComponent(part.slice(key.length + 1)) : null; }
function auth(req) { const sid = getCookie(req, 'cs_session'); const s = sid && db.sessions[hash(sid)]; return s && s.expiresAt > now() ? db.users[s.userId] : null; }
function setCookie(res, sid) { res.cookie('cs_session', sid, { httpOnly: true, secure: prod, sameSite: 'lax', path: '/', maxAge: SESSION_MAX_AGE }); }
function loginUser(res, id) { const sid = token(32); db.sessions[hash(sid)] = { userId: id, expiresAt: now() + SESSION_MAX_AGE }; setCookie(res, sid); save(); }
function memberIds(circleId) { return db.memberships.filter(m => m.circleId === circleId).map(m => m.userId); }
function userCircles(id) { return db.memberships.filter(m => m.userId === id).map(m => db.circles[m.circleId]).filter(Boolean); }
function sharedCircle(a, b) { return a === b || userCircles(a).some(c => memberIds(c.id).includes(b)); }
// For legacy profiles, preserve previous all-circle-sharing until their owner
// explicitly customizes contact access. New profiles start with an empty list.
function gpsRecipientsFor(owner) {
  if (Array.isArray(owner.gpsRecipients)) return owner.gpsRecipients.filter(id => id!==owner.id && sharedCircle(owner.id,id));
  return [...activeRecipients(owner.id)].filter(id=>id!==owner.id);
}
function mayViewSharedGps(owner, viewerId) {
  return !!owner?.sharing && gpsRecipientsFor(owner).includes(viewerId);
}
function connections(id) { return sockets.get(id) || new Set(); }
function online(id) { return connections(id).size > 0; }
function currentAlert(id) { return Object.values(db.alerts).find(a => a.userId === id && a.active) || null; }
function canSeeAlert(viewerId, alert) {
  if (!alert || !sharedCircle(viewerId, alert.userId)) return false;
  return viewerId === alert.userId || (Array.isArray(alert.recipients) && alert.recipients.includes(viewerId));
}
function alertAudience(alert) {
  if (alert.kind === 'pickpocket') return new Set([alert.userId, ...(alert.recipients || []).filter(id => sharedCircle(id, alert.userId))]);
  return new Set([alert.userId, ...(alert.recipients || []).filter(id => sharedCircle(id, alert.userId))]);
}

function activeRecipients(id) { const recipients = new Set([id]); for (const c of userCircles(id)) for (const member of memberIds(c.id)) recipients.add(member); return recipients; }
function stateFor(id) {
  const me = db.users[id];
  if (!me) return null;
  const circles = userCircles(id).map(c => ({
    id: c.id, name: c.name, ownerId: c.ownerId, mine: c.ownerId === id,
    members: memberIds(c.id).filter(x => db.users[x]).map(x => {
      const u = db.users[x]; const alert = currentAlert(x);
      const visibleAlert = alert && canSeeAlert(id,alert) ? alert : null;
      const emergencyShare = !!(visibleAlert?.recipients?.includes(id));
      const shared = Boolean(mayViewSharedGps(u,id) || (visibleAlert?.kind === 'pickpocket' && emergencyShare));
      const location = (shared || emergencyShare) && locations.has(x) ? locations.get(x) : null;
      const membership = db.memberships.find(m => m.circleId === c.id && m.userId === x);
      return { ...publicUser(u), invitedByMe: membership?.invitedBy === id, joinedAt:membership?.joinedAt||null, online: online(x), sharing: shared, location, sos: visibleAlert ? { id: alert.id, startedAt: alert.startedAt, hasAudio: !!alert.hasAudio, kind: alert.kind || 'sos' } : null };
    })
  }));
  const alerts = Object.values(db.alerts).filter(a => a.active && canSeeAlert(id, a)).map(a => ({
    id: a.id, userId: a.userId, name: db.users[a.userId]?.name || 'Contatto',
    startedAt: a.startedAt, kind: a.kind || 'sos', hasAudio: Boolean(a.hasAudio), address:a.address||null, location: (mayViewSharedGps(db.users[a.userId],id) || a.recipients?.includes(id)) ? (locations.get(a.userId)||null) : null
  })).sort((a,b) => b.startedAt - a.startedAt);
  return { me: { ...publicUser(me), email: me.email, sharing: !!me.sharing, sos: currentAlert(id)?.id || null, alertKind: currentAlert(id)?.kind || null, theftShare: !!(currentAlert(id)?.kind==='pickpocket' && currentAlert(id)?.recipients?.length), sosRecipients: (me.sosRecipients || []).filter(x => sharedCircle(id,x)), sosAudioConsent:familyActive(me)&&me.sosAudioConsent===true,premiumPlan:premiumPlan(me),features:planFeatures(me), gpsRecipients:gpsRecipientsFor(me), premiumActive:premiumActive(me), creatorPremium:isAdmin(me), premiumGiftLifetime:me.premiumGiftLifetime===true, premiumUntil: Number(me.premiumUntil||0)>now()?me.premiumUntil:null, isAdmin:isAdmin(me), journey:publicJourney(db.journeys[id],id), checkin:publicCheckin(db.checkins[id],id) }, circles, alerts, journeys:Object.values(db.journeys).filter(j=>j.status==='active'||j.status==='late'||(j.arrivedAt||j.endedAt)>now()-24*3600*1000).map(j=>publicJourney(j,id)).filter(Boolean), checkins:Object.values(db.checkins).filter(c=>c.status==='pending'||c.status==='late'||c.completedAt>now()-24*3600*1000).map(c=>publicCheckin(c,id)).filter(Boolean), billingReady:false, persistentStorage:storageKind==='postgres', pushEnabled: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) || fcmReady, vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null };
}
function sendSocket(ws, msg) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
function pushState(id) { const payload = { type: 'state', data: stateFor(id) }; for (const ws of connections(id)) sendSocket(ws, payload); }
function refreshRelated(id) { for (const userId of activeRecipients(id)) pushState(userId); }
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'geolocation=(self), microphone=(self), camera=(self)');
  // ZYRO MAP V14 uses a single MapLibre engine, CDN assets and OpenFreeMap tiles.
  // In production, pin/vendor SDK assets and audit Content Security Policy.
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: blob: https://tiles.openfreemap.org; connect-src 'self' https://tiles.openfreemap.org ws: wss:; worker-src 'self' blob:; font-src 'self' data: https://tiles.openfreemap.org; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  res.set('Cache-Control', req.path.startsWith('/api/') ? 'no-store' : 'no-cache');
  next();
});
app.use(express.json({ limit: '350kb' }));
// Do not claim a successful profile/chat/admin mutation before PostgreSQL confirms the write.
app.use((req,res,next)=>{
  if (!pgPool || !['POST','PUT','PATCH','DELETE'].includes(req.method)) return next();
  const originalSend=res.send.bind(res);
  res.send=function(body){
    res.send=originalSend;
    if (res.statusCode>=400) return originalSend(body);
    void persistenceQueue.then(()=>{
      if (!res.writableEnded) originalSend(body);
    },(err)=>{
      console.error('[ZYRO storage] Risposta bloccata:',err.message);
      if (res.writableEnded) return;
      res.removeHeader('Set-Cookie');
      res.removeHeader('ETag');
      res.status(503).type('json');
      originalSend(JSON.stringify({error:'Database non disponibile: modifica NON confermata. Riprova più tardi.'}));
      // An in-memory state with uncommitted changes must not be served again.
      setTimeout(()=>process.exit(1),100).unref();
    });
    return res;
  };
  next();
});
// Requests altering private information must originate from this origin (CSRF protection).
app.use('/api', (req, res, next) => {
  if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  const expected = `${req.protocol}://${req.get('host')}`;
  if (origin && origin !== expected) return res.status(403).json({ error: 'Origine non autorizzata.' });
  if (!origin && req.headers['sec-fetch-site'] && !['same-origin','none'].includes(req.headers['sec-fetch-site'])) return res.status(403).json({ error: 'Richiesta non autorizzata.' });
  next();
});
const rateCounters = new Map();
function limit(req, res, next) {
  const k = `${req.ip}:${req.path}`;
  const curr = rateCounters.get(k) || { n: 0, until: now()+10*60*1000 };
  if (curr.until < now()) { curr.n = 0; curr.until = now()+10*60*1000; }
  curr.n++; rateCounters.set(k, curr);
  if (curr.n > 25) return res.status(429).json({error:'Troppi tentativi. Riprova più tardi.'});
  next();
}
function requireAuth(req, res, next) {
  req.user=auth(req);
  if (!req.user) return res.status(401).json({error:'Accedi per continuare.'});
  if (req.user.bannedAt) return res.status(403).json({error:banNotice,banned:true});
  // Refresh once after ~7 days of activity. A valid device stays signed in
  // for up to 30 days since its most recent renewal, not forever.
  const sid=getCookie(req,'cs_session'), session=sid && db.sessions[hash(sid)];
  if (session && session.expiresAt-now() < 23*86400*1000) {
    session.expiresAt=now()+SESSION_MAX_AGE;
    setCookie(res,sid);
    save();
  }
  next();
}
function requireAdmin(req,res,next){if(!isAdmin(req.user))return res.status(403).json({error:'Accesso riservato all’amministratore.'});next();}
function adminPassword(req,res){if(!String(req.body?.password||'') || !verifyPassword(String(req.body.password),req.user)){res.status(403).json({error:'Conferma con la password del tuo account amministratore.'});return false;}return true;}
function recordAction(kind,actor,target,detail=''){db.adminAudit.push({id:token(8),kind,by:actor,for:target,detail,at:now()});if(db.adminAudit.length>500)db.adminAudit.splice(0,db.adminAudit.length-500);}
function normalizedClientIp(value){
 let ip=String(value||'').trim();if(ip.startsWith('::ffff:')&&isIP(ip.slice(7))===4)ip=ip.slice(7);
 return isIP(ip)?ip.toLowerCase():null;
}
function notifyAdminUsers(){
 if(!ADMIN_ID || !db.users[ADMIN_ID])return;
 for(const ws of connections(ADMIN_ID))sendSocket(ws,{type:'admin-users-changed'});
}
function auditLogin(req,user){
 user.lastLoginIp=normalizedClientIp(req.ip);user.lastLoginAt=now();
}

app.get('/api/health', (_, res) => {
  res.set('Cache-Control','no-store');
  res.json({ok:true,persistentStorage:storageKind==='postgres',
    firebaseConfigured:fcmReady,billingReady:false});
});
// Live tiles requested only by logged-in users. A modest in-memory cache protects the community tile service.
// For a public production launch replace this best-effort upstream with a contracted map provider.
const mapTileCache = new Map();
const tileRequests = new Map();
app.get('/api/map-tile/:z/:x/:y.png', requireAuth, async (req,res) => {
  const z=Number(req.params.z), x=Number(req.params.x), y=Number(req.params.y);
  if (![z,x,y].every(Number.isInteger) || z<0 || z>18 || x<0 || y<0 || x>=2**z || y>=2**z) return res.sendStatus(400);
  const id=req.user.id, minute=Math.floor(now()/60000), counter=tileRequests.get(id);
  if(counter?.minute===minute && counter.n>=200) return res.sendStatus(429);
  tileRequests.set(id,{minute,n:(counter?.minute===minute?counter.n:0)+1});
  const key=`${z}/${x}/${y}`, cached=mapTileCache.get(key);
  if (cached && cached.expires>now()) {res.set('Content-Type','image/png');res.set('Cache-Control','private, max-age=604800');return res.send(cached.bytes);}
  try {
    const upstream=await fetch(`https://tile.openstreetmap.org/${key}.png`, {
      headers:{'User-Agent':'ZYRO360/0.4 (https://zyro-360.onrender.com; support via GitHub project Zyro-360)', 'Referer':'https://zyro-360.onrender.com/'},
      signal:AbortSignal.timeout(9000)
    });
    if(!upstream.ok || !upstream.headers.get('content-type')?.includes('image/')) throw Error('Upstream tiles not available');
    const bytes=Buffer.from(await upstream.arrayBuffer());
    if(bytes.length<100 || bytes.length>600000) throw Error('Invalid tile');
    if(mapTileCache.size>400)mapTileCache.delete(mapTileCache.keys().next().value);
    mapTileCache.set(key,{bytes,expires:now()+604800000});
    res.set('Content-Type','image/png');res.set('Cache-Control','private, max-age=604800');res.send(bytes);
  } catch {res.status(502).json({error:'Mappa temporaneamente non raggiungibile.'});}
});

app.post('/api/register', limit, (req, res) => {
  const name = cleanText(req.body.name, 36), email = String(req.body.email || '').trim().toLowerCase(), password = String(req.body.password || '');
  if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || email.length > 160 || password.length < 10 || password.length > 128) return res.status(400).json({error:'Inserisci nome, email valida e una password di almeno 10 caratteri.'});
  if (Object.values(db.users).some(u => u.email === email)) return res.status(409).json({error:'Email già registrata.'});
  const id = token(12), salt = token(16);
  db.users[id] = { id, name, email, salt, passwordHash: passwordHash(password, salt), createdAt: now(), sharing: false, pushSubs: [], gpsRecipients: [], sosRecipients: [], sosAudioConsent: false, avatar: null };
  auditLogin(req, db.users[id]);db.users[id].registrationIp=db.users[id].lastLoginIp; loginUser(res, id);notifyAdminUsers(); res.json({ ok:true });
});
app.post('/api/login', limit, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), password = String(req.body.password || '');
  const u = Object.values(db.users).find(x => x.email === email);
  if (!u || !verifyPassword(password, u)) return res.status(401).json({error:'Email o password non corretti.'});
  if(u.bannedAt) return res.status(403).json({error:banNotice,banned:true});
  auditLogin(req,u);loginUser(res, u.id);notifyAdminUsers(); res.json({ok:true});
});
app.post('/api/logout', requireAuth, (req,res) => {
  const sid = getCookie(req, 'cs_session');
  if (sid) {
    const sessionKey = hash(sid);
    delete db.sessions[sessionKey];
    // Only this login session's Android device tokens are removed.
    req.user.fcmTokens=(req.user.fcmTokens||[]).filter(x=>x.session!==sessionKey);
  }
  res.clearCookie('cs_session', {path:'/'}); save();
  for (const ws of connections(req.user.id)) ws.close(1008,'Sessione terminata');
  res.json({ok:true});
});
app.get('/api/state', requireAuth, (req,res) => res.json(stateFor(req.user.id)));
// ZYRO 360 V15.4 — private moderation; never include IPs in public account/state data.
const adminUser = u => ({id:u.id,name:u.name,email:u.email,createdAt:u.createdAt||null,registrationIp:(u.createdAt && now()-u.createdAt<30*86400e3)?(u.registrationIp||null):null,lastLoginAt:u.lastLoginAt||null,lastLoginIp:(u.lastLoginAt && now()-u.lastLoginAt<30*86400e3)?(u.lastLoginIp||null):null,bannedAt:u.bannedAt||null,premiumGiftLifetime:u.premiumGiftLifetime===true,premiumActive:premiumActive(u),premiumUntil:u.premiumUntil||null});
app.get('/api/admin/users',requireAuth,requireAdmin,(req,res)=>{
 res.set('Cache-Control','no-store');
 res.json({users:Object.values(db.users).map(adminUser).map(u=>{const ips=[u.registrationIp,u.lastLoginIp].filter(Boolean);const matches=Object.values(db.users).filter(v=>v.id!==u.id && v.bannedAt && [v.createdAt>now()-30*86400e3?v.registrationIp:null,v.lastLoginAt>now()-30*86400e3?v.lastLoginIp:null].some(ip=>ip&&ips.includes(ip)));return {...u,sameIpBannedAccounts:matches.map(v=>v.id)};}).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)),reports:db.userReports.slice(-100).reverse().map(r=>({...r,user:db.users[r.userId]?adminUser(db.users[r.userId]):null,reporter:db.users[r.reporterId]?adminUser(db.users[r.reporterId]):null})),audit:db.adminAudit.slice(-50).reverse()});
});
// Reports are accepted only for another user actually sharing a circle with the reporter.
app.post('/api/report',requireAuth,limit,(req,res)=>{
 const target=String(req.body.userId||''),reason=cleanText(req.body.reason,400);
 if(isAdmin(req.user))return res.status(403).json({error:'Il proprietario riceve e gestisce le segnalazioni nel Centro amministratore.'});
 if(target===req.user.id||!db.users[target]||!sharedCircle(req.user.id,target))return res.status(403).json({error:'Puoi segnalare soltanto un altro membro della tua cerchia.'});
 if(reason.length<12)return res.status(400).json({error:'Descrivi brevemente il motivo della segnalazione (almeno 12 caratteri).'});
 db.userReports.push({id:token(9),reporterId:req.user.id,userId:target,reason,at:now(),status:'open'});
 if(db.userReports.length>300)db.userReports.splice(0,db.userReports.length-300);
 save();
 if (ADMIN_ID && db.users[ADMIN_ID]) {
   for (const ws of connections(ADMIN_ID)) sendSocket(ws,{type:'admin-new-report'});
   void sendEventPush([ADMIN_ID],'Nuova segnalazione • ZYRO 360','Un utente ha inviato una segnalazione da esaminare.');
 }
 res.json({ok:true,message:'Segnalazione ricevuta. Sarà esaminata dall’amministratore.'});
});
app.post('/api/admin/ban',requireAuth,requireAdmin,limit,(req,res)=>{
 if(!adminPassword(req,res))return;
 const id=String(req.body.userId||''),ban=req.body.banned===true,u=db.users[id],reason=cleanText(req.body.reason,300);
 if(!u||id===ADMIN_ID)return res.status(403).json({error:'Non puoi sospendere questo account.'});
 if(ban && reason.length<8)return res.status(400).json({error:'Scrivi una motivazione (almeno 8 caratteri).'});
 if(ban){u.bannedAt=now();u.banReason=reason;u.sharing=false;locations.delete(id);for(const alert of Object.values(db.alerts))if(alert.userId===id && alert.active){alert.active=false;alert.endedAt=now();alert.hasAudio=false;}}
 else{delete u.bannedAt;delete u.banReason;}
 // Force sign-out on suspension so old cookies no longer work.
 if(ban){for(const [k,s] of Object.entries(db.sessions))if(s.userId===id)delete db.sessions[k];for(const ws of connections(id)){sendSocket(ws,{type:'account-banned',notice:banNotice});setTimeout(()=>ws.close(1008,'Account sospeso'),250).unref();}}
 recordAction(ban?'ban':'unban',req.user.id,id,reason);save();notifyAdminUsers();refreshRelated(id);if(ban)void sendEventPush([id],'Account sospeso • ZYRO 360',banNotice);
 res.json({ok:true,user:adminUser(u),notice:ban?banNotice:null});
});
app.post('/api/admin/premium-gift',requireAuth,requireAdmin,limit,(req,res)=>{
 if(!adminPassword(req,res))return;
 const id=String(req.body.userId||''),u=db.users[id],enabled=req.body.enabled===true;
 if(!u||id===ADMIN_ID)return res.status(403).json({error:'Utente non valido.'});
 // This is an owner-issued complimentary entitlement, NOT a Play Billing purchase.
 u.premiumGiftLifetime=enabled;
 if(enabled){u.premiumGiftGrantedAt=now();u.premiumGiftBy=req.user.id;}
 else {delete u.premiumGiftGrantedAt;delete u.premiumGiftBy;}
 recordAction(enabled?'premium-gift':'premium-revoke',req.user.id,id);
 save();pushState(id);res.json({ok:true,user:adminUser(u)});
});
app.post('/api/admin/report-resolve',requireAuth,requireAdmin,limit,(req,res)=>{
 if(!adminPassword(req,res))return;
 const report=db.userReports.find(x=>x.id===String(req.body.reportId||''));
 if(!report)return res.status(404).json({error:'Segnalazione non trovata.'});
 report.status=req.body.status==='dismissed'?'dismissed':'reviewed';report.reviewedAt=now();
 recordAction('report-'+report.status,req.user.id,report.userId,report.id);save();res.json({ok:true});
});

app.post('/api/circles', requireAuth, limit, (req,res) => {
  const name = cleanText(req.body.name, 48);
  if (name.length < 2) return res.status(400).json({error:'Dai un nome alla cerchia.'});
  if (userCircles(req.user.id).length >= MAX_USER_CIRCLES) return res.status(400).json({error:'Limite cerchie raggiunto.'});
  const id = token(12); db.circles[id] = {id, name, ownerId:req.user.id, createdAt:now()};
  db.memberships.push({circleId:id, userId:req.user.id, joinedAt:now()}); save(); refreshRelated(req.user.id); res.json({ok:true, circleId:id});
});
app.post('/api/invites', requireAuth, limit, (req,res) => {
  const id = String(req.body.circleId || '');
  if (!memberIds(id).includes(req.user.id)) return res.status(403).json({error:'Non fai parte della cerchia.'});
  const code = crypto.randomBytes(9).toString('hex').toUpperCase();
  db.invites[hash(code)] = { circleId:id, createdBy:req.user.id, expiresAt:now()+24*3600*1000 }; save();
  res.json({code, expiresInHours:24});
});
app.post('/api/invites/join', requireAuth, limit, (req,res) => {
  const code = String(req.body.code || '').replace(/[\s-]/g,'').toUpperCase();
  const key = hash(code), inv = db.invites[key];
  if (!inv || inv.expiresAt < now() || !db.circles[inv.circleId]) return res.status(400).json({error:'Codice non valido o scaduto.'});
  if (userCircles(req.user.id).length >= MAX_USER_CIRCLES) return res.status(400).json({error:'Limite cerchie raggiunto.'});
  if (memberIds(inv.circleId).includes(req.user.id)) return res.status(400).json({error:'Sei già nella cerchia.'});
  if (memberIds(inv.circleId).length >= 30) return res.status(400).json({error:'Cerchia piena.'});
  db.memberships.push({circleId:inv.circleId,userId:req.user.id,invitedBy:inv.createdBy,joinedAt:now()}); delete db.invites[key]; save();
  for (const id of memberIds(inv.circleId)) refreshRelated(id);
  res.json({ok:true});
});
app.post('/api/circles/leave', requireAuth, (req,res) => {
  const circle = db.circles[String(req.body.circleId || '')];
  if (!circle || !memberIds(circle.id).includes(req.user.id)) return res.status(404).json({error:'Cerchia non trovata.'});
  if (circle.ownerId === req.user.id) return res.status(400).json({error:'Il proprietario deve eliminare la cerchia.'});
  const others = memberIds(circle.id); db.memberships = db.memberships.filter(m => !(m.circleId === circle.id && m.userId === req.user.id)); save();
  for (const id of others) refreshRelated(id);
  res.json({ok:true});
});
app.post('/api/circles/remove', requireAuth, (req,res) => {
  const circle = db.circles[String(req.body.circleId || '')], id = String(req.body.userId || '');
  if (!circle || circle.ownerId !== req.user.id || id === req.user.id) return res.status(403).json({error:'Operazione non consentita.'});
  if (!memberIds(circle.id).includes(id)) return res.status(404).json({error:'Membro non trovato.'});
  const others = memberIds(circle.id); db.memberships = db.memberships.filter(m => !(m.circleId === circle.id && m.userId === id)); save();
  for (const u of others) refreshRelated(u);
  res.json({ok:true});
});
app.post('/api/circles/delete', requireAuth, (req,res) => {
  const circle = db.circles[String(req.body.circleId || '')];
  if (!circle || circle.ownerId !== req.user.id) return res.status(403).json({error:'Solo il proprietario può eliminarla.'});
  const others = memberIds(circle.id);
  db.memberships = db.memberships.filter(m => m.circleId !== circle.id);
  for (const [k,v] of Object.entries(db.invites)) if (v.circleId === circle.id) delete db.invites[k];
  delete db.circles[circle.id]; save();
  for (const id of others) refreshRelated(id); res.json({ok:true});
});
app.post('/api/sharing', requireAuth, (req,res) => {
  const enabled = req.body.enabled === true;
  req.user.sharing = enabled;
  if (!enabled && !(currentAlert(req.user.id)?.kind==='pickpocket' && currentAlert(req.user.id).recipients?.length)) locations.delete(req.user.id);
  save(); refreshRelated(req.user.id); res.json({ok:true});
});
const lastPos = new Map();
app.post('/api/position', requireAuth, (req,res) => {
  const alert=currentAlert(req.user.id);
  if (!req.user.sharing && !(alert?.recipients?.length)) return res.status(403).json({error:'Condivisione non attiva.'});
  const lat = Number(req.body.lat), lon = Number(req.body.lon), accuracy = Number(req.body.accuracy);
  if (![lat,lon,accuracy].every(Number.isFinite) || Math.abs(lat)>90 || Math.abs(lon)>180 || accuracy < 0 || accuracy>100000) return res.status(400).json({error:'Coordinate non valide.'});
  const t=now(); if (t-(lastPos.get(req.user.id)||0)<2400) return res.json({ok:true}); lastPos.set(req.user.id,t);
  locations.set(req.user.id,{lat,lon,accuracy,updatedAt:t});
  const j=db.journeys[req.user.id];
  if(j?.status==='active' && j.destinationPoint && accuracy<=100){
    j.nearCount = metersBetween({lat,lon},j.destinationPoint) <= 120 ? (j.nearCount||0)+1 : 0;
    if(j.nearCount>=2){j.status='arrived';j.arrivedAt=t;save();void sendEventPush(j.recipients,'✅ Arrivo confermato',`${req.user.name} è arrivato/a a ${j.destination}.`);}
  }
  refreshRelated(req.user.id); res.json({ok:true});
});

const configuredPush = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (configuredPush) webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.org', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

function hasLiveFcmSession(entry) {
  return typeof entry?.session==='string' && db.sessions[entry.session]?.expiresAt>now();
}
function fcmEntriesFor(id) {
  return (db.users[id]?.fcmTokens||[]).filter(x=>x && typeof x.token==='string' && hasLiveFcmSession(x));
}
async function sendFcm(recipients,title,body,kind='general') {
  if (!fcmReady) return {attempted:0,accepted:0};
  const targets=[...new Set(recipients)].filter(id=>db.users[id]&&!db.users[id].bannedAt);
  let attempted=0,accepted=0,dirty=false;
  const jobs=[];
  for(const userId of targets) {
    const user=db.users[userId], existing=user.fcmTokens||[];
    const valid=fcmEntriesFor(userId);
    if(valid.length!==existing.length) {user.fcmTokens=valid;dirty=true;}
    for(const entry of valid) {
      attempted++;
      jobs.push(firebaseAdmin.messaging().send({
        token:entry.token,
        notification:{title:String(title).slice(0,100),body:String(body).slice(0,300)},
        android:{
          priority:'high',ttl:kind==='sos'?300000:120000,
          notification:{
            channelId:kind==='sos'||kind==='pickpocket'?'zyro_sos_v2':kind==='chat'?'zyro_chat_v2':'zyro_updates',
            priority:kind==='sos'||kind==='pickpocket'?'high':'default',
            defaultSound:true,defaultVibrateTimings:true,
            visibility:'private'
          }
        },
        data:{kind,destination:'/'}
      }).then(()=>{accepted++;}).catch(err=>{
        const code=String(err?.code||'');
        if(code==='messaging/registration-token-not-registered' || code==='messaging/invalid-registration-token') {
          user.fcmTokens=(user.fcmTokens||[]).filter(x=>x.token!==entry.token);
          dirty=true;
        } else console.error('[ZYRO FCM] delivery rejected:',code||'unknown');
      }));
    }
  }
  await Promise.allSettled(jobs);
  if(dirty)save();
  return {attempted,accepted};
}

// Ordinary self-test notification. Never creates an SOS and never shares GPS.
// One test per account each minute, with honest "accepted != delivered" result.
const selfPushTests=new Map();
app.post('/api/push/android/test-self',requireAuth,limit,async(req,res)=>{
  if(!fcmReady)return res.status(503).json({error:'Firebase non configurato sul server.'});
  const registered=fcmEntriesFor(req.user.id);
  if(!registered.length)return res.status(409).json({error:'Questo account non ha dispositivi Android registrati. Apri Abilita permessi.'});
  const sid=getCookie(req,'cs_session'),session=sid&&hash(sid);
  if(!session || !registered.some(x=>x.session===session))
    return res.status(409).json({error:'Questo dispositivo non è collegato a Firebase. Ricollegalo nelle impostazioni.'});
  const last=selfPushTests.get(req.user.id)||0;
  if(now()-last<60000)return res.status(429).json({error:'Attendi un minuto prima di un altro test.'});
  selfPushTests.set(req.user.id,now());
  const outcome=await sendFcm([req.user.id],'🔔 Test notifiche Zyro 360',
    'Questa è una notifica di prova. Nessuna emergenza è stata attivata.','general');
  res.json({ok:true,attempted:outcome.attempted,accepted:outcome.accepted,
    deliveryConfirmed:false,
    notice:outcome.accepted>0
      ?'Firebase ha accettato la notifica. Verifica sul telefono che appaia e produca un suono.'
      :'Firebase non ha accettato la notifica. Verifica connessione e permessi.'});
});

// Only the account owner can inspect its own device registration, no raw tokens.
// Per-account readiness data; never expose device tokens or other users' GPS.
// Diagnostic booleans do NOT imply notification delivery or safety guarantees.
app.get('/api/diagnostics/self',requireAuth,(req,res)=>{
  const sid=getCookie(req,'cs_session'),session=sid&&hash(sid);
  const devices=fcmEntriesFor(req.user.id);
  res.set('Cache-Control','no-store');
  res.json({
    ok:true,persistentStorage:storageKind==='postgres',
    firebaseServerConfigured:fcmReady,
    currentDeviceRegistered:Boolean(session&&devices.some(x=>x.session===session)),
    registeredDeviceCount:devices.length,
    liveLocationSharing:!!req.user.sharing,
    authorizedGpsContacts:gpsRecipientsFor(req.user).length,
    sosRecipients:(req.user.sosRecipients||[]).filter(id=>sharedCircle(id,req.user.id)).length,
    premiumActive:premiumActive(req.user),billingReady:false,
    gpsBackgroundServiceVerified:false,
    notificationDeliveryVerified:false
  });
});
app.get('/api/push/android/status',requireAuth,(req,res)=>{
  const sid=getCookie(req,'cs_session'),session=sid&&hash(sid);
  const devices=fcmEntriesFor(req.user.id);
  res.json({ok:true,firebaseConfigured:fcmReady,
    linkedToCurrentSession:Boolean(session&&devices.some(x=>x.session===session)),
    devices:devices.length});
});
// The browser and Android must keep separate device registrations.
app.post('/api/push/android/register',requireAuth,limit,(req,res)=>{
  if(!fcmReady)return res.status(503).json({error:'Notifiche Firebase non configurate sul server.'});
  const deviceToken=req.body?.token;
  if(typeof deviceToken!=='string' || deviceToken.length<60 || deviceToken.length>4096 ||
      !/^[A-Za-z0-9_:.-]+$/.test(deviceToken))
    return res.status(400).json({error:'Token notifiche Android non valido.'});
  const sid=getCookie(req,'cs_session'),session=sid&&hash(sid);
  if(!session||!db.sessions[session]||db.sessions[session].userId!==req.user.id)
    return res.status(401).json({error:'Sessione non valida.'});
  // A phone moving between accounts must not continue receiving old accounts' alerts.
  for(const user of Object.values(db.users))
    user.fcmTokens=(user.fcmTokens||[]).filter(x=>x.token!==deviceToken);
  const registered={token:deviceToken,session,at:now()};
  req.user.fcmTokens=(req.user.fcmTokens||[]).filter(hasLiveFcmSession).slice(-4);
  req.user.fcmTokens.push(registered);
  save();res.json({ok:true,enabled:true,linkedToCurrentSession:true});
});
app.post('/api/push/android/unregister',requireAuth,limit,(req,res)=>{
  const t=req.body?.token;
  if(typeof t!=='string'||t.length>4096)return res.status(400).json({error:'Token non valido.'});
  req.user.fcmTokens=(req.user.fcmTokens||[]).filter(x=>x.token!==t);
  save();res.json({ok:true});
});

async function notifyContacts(id,name,recipients=null,isTheft=false) {
  const targets=[...(recipients===null?activeRecipients(id):recipients)].filter(x=>x!==id);
  return sendEventPush(targets,isTheft?'🚨 Possibile furto':'🆘 Richiesta SOS',
    isTheft?`${name}: possibile furto rilevato. Verifica e contatta la persona.`
      :`${name} ha attivato un SOS. Apri Zyro 360.`, isTheft?'pickpocket':'sos');
}
// Accepted by FCM/Web Push does not prove the receiver saw the alert.
async function sendEventPush(recipients,title,body,kind='general') {
  const ids=[...new Set(recipients)].filter(id=>db.users[id]&&!db.users[id].bannedAt);
  const fcm=await sendFcm(ids,title,body,kind);
  let attempted=fcm.attempted,accepted=fcm.accepted,dirty=false;
  if (configuredPush) {
    const calls=[];
    for(const id of ids)for(const sub of db.users[id]?.pushSubs||[]){
      attempted++;
      calls.push(webpush.sendNotification(sub,JSON.stringify({title,body,kind,url:'/'}),{TTL:300,urgency:kind==='sos'?'high':'normal'})
        .then(()=>{accepted++;})
        .catch(err=>{
          if([404,410].includes(err.statusCode)){
            db.users[id].pushSubs=db.users[id].pushSubs.filter(s=>s.endpoint!==sub.endpoint);
            dirty=true;
          }
        }));
    }
    await Promise.allSettled(calls);
  }
  if(dirty)save();
  return {configured:fcmReady||configuredPush,accepted,attempted};
}
let lastReverseGeocodeAt=0;
async function sosAddressFor(pos){
 // Opt-in: forwarding GPS coordinates to a geocoder must be disclosed in privacy information.
 // Explicit opt-in on Render required: reverse geocoding shares the GPS point
 // with the chosen provider. Disclose this to users in the privacy notice.
 if(!pos || process.env.ZYRO_SOS_GEOCODER_ENABLED!=='true')return null;
 // The public Nominatim API allows max 1 request/sec. If busy, never delay an SOS.
 if(Date.now()-lastReverseGeocodeAt<1200)return null;
 lastReverseGeocodeAt=Date.now();
 try{
  const base=(process.env.ZYRO_SOS_GEOCODER_URL||'https://nominatim.openstreetmap.org/reverse');
  const url=new URL(base);url.searchParams.set('format','jsonv2');url.searchParams.set('addressdetails','1');url.searchParams.set('lat',String(pos.lat));url.searchParams.set('lon',String(pos.lon));url.searchParams.set('zoom','18');
  const response=await fetch(url,{headers:{
    'User-Agent':'ZYRO360/1.0 (+https://zyro-360.onrender.com)',
    'Referer':'https://zyro-360.onrender.com/',
    'Accept-Language':'it'
  },signal:AbortSignal.timeout(2800)});
  if(!response.ok)return null;const data=await response.json(),a=data.address||{};
  const road=cleanText(a.road||a.pedestrian||a.footway||a.residential||a.path||'',90);
  const number=cleanText(a.house_number||'',15);
  const city=cleanText(a.city||a.town||a.village||a.municipality||a.hamlet||'',90);
  // Geocoders may only return a street or a city; never manufacture a civic number.
  return cleanText([[road,number].filter(Boolean).join(' '),city].filter(Boolean).join(', '),160)||null;
 }catch{return null;}
}
function journeyAudience(userId, ids){const chosen=allowedRecipients(userId,ids);return chosen&&chosen.length===new Set(ids).size&&chosen.length?chosen:null;}
// Trip / check-in events are server-backed but cannot run during Render Free spin-down.
function overdueCheck(){
 const t=now();let changed=false;
 for(const j of Object.values(db.journeys))if(j.status==='active'&&j.dueAt<=t){j.status='late';j.lateAt=t;changed=true;void sendEventPush(j.recipients,'⌛ Percorso in ritardo',`${db.users[j.userId]?.name||'Un contatto'} non ha ancora confermato l'arrivo a ${j.destination}. Verifica direttamente.`);for(const x of j.recipients)pushState(x);}
 for(const c of Object.values(db.checkins))if(c.status==='pending'&&c.dueAt<=t){c.status='late';c.lateAt=t;changed=true;void sendEventPush(c.recipients,'⌛ Check-in mancato',`${db.users[c.userId]?.name||'Un contatto'} non ha confermato in tempo. Contattalo/a, non presumere un'emergenza.`);for(const x of c.recipients)pushState(x);}
 if(changed)save();
}
app.get('/api/premium/status',requireAuth,(req,res)=>res.json({active:premiumActive(req.user),plan:premiumPlan(req.user),features:planFeatures(req.user),billingReady:false,plans:[{id:'zyro_premium_monthly',monthlyEUR:3.99},{id:'zyro_family_monthly',monthlyEUR:6.99}],message:'Gli acquisti Google Play non sono ancora collegati. Non effettuare pagamenti.'}));
app.post('/api/journey/start',requireAuth,limit,(req,res)=>{
 if(!familyActive(req.user))return res.status(402).json({error:'Questa modalità richiede ZYRO Family.'});
 const recipients=journeyAudience(req.user.id,req.body.recipients);
 const destination=cleanText(req.body.destination,70);const mins=Number(req.body.minutes);
 if(!recipients||!destination||!Number.isInteger(mins)||mins<5||mins>720)return res.status(400).json({error:'Indica meta, minuti (5-720) e destinatari della cerchia.'});
 if(!req.user.sharing)return res.status(409).json({error:'Attiva la condivisione della posizione prima di iniziare Accompagnami.'});
 if(['active','late'].includes(db.journeys[req.user.id]?.status))return res.status(409).json({error:'Termina prima il percorso esistente.'});
 const point=req.body.destinationPoint?validCoords(req.body.destinationPoint):null;
 if(req.body.destinationPoint && !point)return res.status(400).json({error:'Coordinate della destinazione non valide.'});
 const j={id:token(10),userId:req.user.id,destination,recipients,startedAt:now(),dueAt:now()+mins*60000,status:'active',destinationPoint:point?{lat:point.lat,lon:point.lon}:null,nearCount:0};
 db.journeys[req.user.id]=j;save();refreshRelated(req.user.id);
 void sendEventPush(recipients,'🚶 Percorso iniziato',`${req.user.name} è in viaggio verso ${destination}. Orario di arrivo previsto: ${new Date(j.dueAt).toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Rome'})}.`);
 res.json({ok:true,journey:publicJourney(j,req.user.id)});
});
app.post('/api/journey/end',requireAuth,(req,res)=>{
 const j=db.journeys[req.user.id];if(!j||!['active','late'].includes(j.status))return res.status(404).json({error:'Nessun percorso attivo.'});
 const arrived=req.body.arrived===true;j.status=arrived?'arrived':'cancelled';j.endedAt=now();if(arrived)j.arrivedAt=j.endedAt;
 save();refreshRelated(req.user.id);void sendEventPush(j.recipients,arrived?'✅ Sono arrivato/a':'Percorso interrotto',arrived?`${req.user.name} ha confermato l'arrivo a ${j.destination}.`:`${req.user.name} ha interrotto il percorso per ${j.destination}.`);res.json({ok:true});
});
app.post('/api/checkin/start',requireAuth,limit,(req,res)=>{
 if(!familyActive(req.user))return res.status(402).json({error:'Questa modalità richiede ZYRO Family.'});
 const recipients=journeyAudience(req.user.id,req.body.recipients),minutes=Number(req.body.minutes);
 if(!recipients||!Number.isInteger(minutes)||minutes<5||minutes>1440)return res.status(400).json({error:'Scegli i contatti e un controllo tra 5 e 1440 minuti.'});
 if(['pending','late'].includes(db.checkins[req.user.id]?.status))return res.status(409).json({error:'Hai già un check-in attivo.'});
 const c={id:token(10),userId:req.user.id,recipients,dueAt:now()+minutes*60000,status:'pending',startedAt:now()};db.checkins[req.user.id]=c;save();refreshRelated(req.user.id);res.json({ok:true,checkin:publicCheckin(c,req.user.id)});
});
app.post('/api/checkin/end',requireAuth,(req,res)=>{
 const c=db.checkins[req.user.id];if(!c||!['pending','late'].includes(c.status))return res.status(404).json({error:'Nessun check-in attivo.'});
 const confirmed=req.body.confirmed===true;c.status=confirmed?'confirmed':'cancelled';c.completedAt=now();save();refreshRelated(req.user.id);
 if(confirmed)void sendEventPush(c.recipients,'✅ Check-in confermato',`${req.user.name} ha confermato di stare bene.`);
 res.json({ok:true});
});
setInterval(overdueCheck,20000).unref();

app.post('/api/push/subscribe', requireAuth, (req,res) => {
  if (!configuredPush) return res.status(503).json({error:'Notifiche push non configurate.'});
  const s=req.body.subscription;
  if (!s || typeof s.endpoint !== 'string' || !s.endpoint.startsWith('https://') || s.endpoint.length>2000 || !s.keys?.p256dh || !s.keys?.auth) return res.status(400).json({error:'Abbonamento push non valido.'});
  req.user.pushSubs = (req.user.pushSubs || []).filter(x=>x.endpoint!==s.endpoint).slice(-3);
  req.user.pushSubs.push({endpoint:s.endpoint,keys:{p256dh:s.keys.p256dh,auth:s.keys.auth}});
  save(); res.json({ok:true});
});
// V15.2: safe non-emergency push delivery test between members of a shared circle.
// This test NEVER starts an SOS and NEVER shares location or microphone data.
const lastPushTestByUser = new Map();
app.post('/api/push/test', requireAuth, limit, async (req,res) => {
  if (!configuredPush && !fcmReady) return res.status(503).json({error:'Notifiche push non configurate sul server.'});
  const targetId = typeof req.body?.recipientId === 'string' ? req.body.recipientId : '';
  if (!targetId || targetId === req.user.id || !db.users[targetId] || !sharedCircle(req.user.id,targetId))
    return res.status(403).json({error:'Scegli un contatto appartenente alla tua cerchia.'});
  const subs = [...(db.users[targetId].pushSubs || [])];
  if (!subs.length && !fcmEntriesFor(targetId).length) return res.status(409).json({error:'Il contatto non ha ancora attivato le notifiche su un dispositivo.'});
  // One outgoing test per sender per minute. Prevent accidental notification spam.
  const t = now(), previous = lastPushTestByUser.get(req.user.id) || 0;
  if (t - previous < 60000) return res.status(429).json({error:'Attendi almeno un minuto prima di inviare un’altra notifica di prova.'});
  lastPushTestByUser.set(req.user.id,t);
  // This is an ordinary test notification, NOT an SOS/emergency alert.
  const outcome=await sendEventPush([targetId],'🔔 Test ZYRO 360',
    `${cleanText(req.user.name,36)} ti ha inviato una notifica di prova. Nessuna emergenza.`);
  res.json({ok:true,accepted:outcome.accepted,attempted:outcome.attempted,
    notice:outcome.accepted>0
      ?'Notifica accettata da Firebase/Web Push. La ricezione non è confermata.'
      :'Nessun servizio ha accettato la notifica. Controlla le autorizzazioni.'});
});

// Contact access is controlled ONLY by the signed-in profile owner.
// It never enables GPS/microphone on another person's device.
app.post('/api/settings/contact-access',requireAuth,limit,(req,res)=>{
  const otherId=String(req.body?.userId||'');
  if(!otherId || otherId===req.user.id || !db.users[otherId] || !sharedCircle(req.user.id,otherId))
    return res.status(403).json({error:'Puoi modificare solo i contatti della tua cerchia.'});
  if(typeof req.body.shareGps!=='boolean' || typeof req.body.receiveSos!=='boolean')
    return res.status(400).json({error:'Seleziona le autorizzazioni GPS e SOS.'});
  // Changing recipients mid-alert would silently leave old listeners connected.
  if(currentAlert(req.user.id)?.kind==='sos')
    return res.status(409).json({error:'Termina prima il tuo SOS per modificare i destinatari.'});
  const gps=new Set(gpsRecipientsFor(req.user).filter(id=>sharedCircle(req.user.id,id))),
        sos=new Set((req.user.sosRecipients||[]).filter(id=>sharedCircle(req.user.id,id)));
  req.body.shareGps?gps.add(otherId):gps.delete(otherId);
  req.body.receiveSos?sos.add(otherId):sos.delete(otherId);
  req.user.gpsRecipients=[...gps].slice(0,120);
  req.user.sosRecipients=[...sos].slice(0,60);
  save();refreshRelated(req.user.id);
  res.json({ok:true,gpsRecipients:req.user.gpsRecipients,sosRecipients:req.user.sosRecipients});
});
// Per-account opt-in: the SOS audio microphone is OFF by default and can only
// be enabled by the authenticated owner from the invitees/permissions screen.
app.post('/api/settings/sos-audio',requireAuth,limit,(req,res)=>{
  const enabled=req.body?.enabled;
  if(typeof enabled!=='boolean')return res.status(400).json({error:'Impostazione audio non valida.'});
  if(enabled&&!familyActive(req.user))return res.status(402).json({error:'L’audio SOS è incluso soltanto in ZYRO Family.'});
  req.user.sosAudioConsent=enabled;
  if(!enabled){
    // Immediately prevent new listening requests and signalling when revoked.
    const alert=currentAlert(req.user.id);
    if(alert?.kind==='sos'){alert.hasAudio=false;}
    for(const connection of connections(req.user.id))connection.microphoneReady=false;
  }
  save();refreshRelated(req.user.id);
  res.json({ok:true,enabled:req.user.sosAudioConsent});
});
app.post('/api/settings/sos-recipients', requireAuth, limit, (req,res)=> {
  const ids=req.body.recipients;
  if(!Array.isArray(ids) || ids.length>60 || ids.some(id=>typeof id!=='string' || id.length>100)) return res.status(400).json({error:'Destinatari non validi.'});
  const chosen=[...new Set(ids)];
  if(chosen.some(id=>id===req.user.id || !sharedCircle(id,req.user.id))) return res.status(403).json({error:'Seleziona soltanto persone della tua cerchia.'});
  req.user.sosRecipients=chosen;save();refreshRelated(req.user.id);res.json({ok:true,recipients:chosen});
});
app.post('/api/profile/avatar',requireAuth,limit,(req,res)=>{
  const avatar=req.body.avatar;
  if(avatar!==null && (typeof avatar!=='string' || avatar.length>150000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(avatar))) return res.status(400).json({error:'La foto deve essere JPEG e inferiore a 110 KB.'});
  if(avatar){const buffer=Buffer.from(avatar.split(',')[1],'base64');if(buffer.length>110000 || buffer.length<100 || buffer[0]!==255 || buffer[1]!==216 || buffer[2]!==255)return res.status(400).json({error:'Immagine non valida.'});}
  req.user.avatar=avatar;save();refreshRelated(req.user.id);res.json({ok:true});
});
// Chat: messages are PRIVATE by access checks, but not end-to-end encrypted.
// Demo storage in one JSON file. A real launch needs a durable database and separate media storage.
function chatAccess(viewer,type,target){
  if(type==='circle')return db.circles[target] && memberIds(target).includes(viewer) ? {key:`circle:${target}`, members:memberIds(target)} : null;
  if(type==='direct' && target!==viewer && db.users[target] && sharedCircle(viewer,target))return {key:`direct:${[viewer,target].sort().join(':')}`, members:[viewer,target]};
  return null;
}
app.get('/api/chat/:type/:target', requireAuth,(req,res)=>{
  const chat=chatAccess(req.user.id,req.params.type,req.params.target);
  if(!chat)return res.status(403).json({error:'Non hai accesso a questa conversazione.'});
  // Paginated conversation history; older messages remain stored instead of being cut off.
  // Durable history requires DATA_DIR on persistent storage (see LEGGIMI).
  const all=(db.messages||{})[chat.key]||[];
  const rawBefore=req.query.before;
  let end=all.length;
  if(rawBefore!==undefined){
    if(!/^\d{1,10}$/.test(String(rawBefore)))return res.status(400).json({error:'Pagina dello storico non valida.'});
    end=Math.min(all.length,Number(rawBefore));
  }
  const start=Math.max(0,end-80);
  res.set('Cache-Control','no-store');
  res.json({messages:all.slice(start,end),nextBefore:start>0?start:null,total:all.length});
});
app.post('/api/chat/:type/:target',requireAuth,(req,res)=>{
  const chat=chatAccess(req.user.id,req.params.type,req.params.target);
  if(!chat)return res.status(403).json({error:'Non hai accesso a questa conversazione.'});
  const t=now(),lim=throttle.get(`chat:${req.user.id}`)||[];
  const recent=lim.filter(x=>x>t-60000);if(recent.length>=12)return res.status(429).json({error:'Troppi messaggi. Attendi un momento.'});
  recent.push(t);throttle.set(`chat:${req.user.id}`,recent);
  const text=cleanText(req.body.text,1200), image=req.body.image;
  if(image!=null && (typeof image!=='string' || image.length>160000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image))) return res.status(400).json({error:'Foto non valida o troppo grande.'});
  if(image){const binary=Buffer.from(image.split(',')[1],'base64');if(binary.length>115000 || binary.length<100 || binary[0]!==255 || binary[1]!==216 || binary[2]!==255)return res.status(400).json({error:'La foto deve essere inferiore a 115 KB.'});}
  if(!text && !image)return res.status(400).json({error:'Scrivi un messaggio o aggiungi una foto.'});
  db.messages ||= {};
  const message={id:token(9),from:req.user.id,name:req.user.name,text,image:image||null,at:t};
  db.messages[chat.key] ||= [];db.messages[chat.key].push(message);
  // Do not silently erase messages after 60 sends. Data is stored in DATA_DIR,
  // which MUST be backed by persistent storage for survival across deployments.
  save();
  for(const id of chat.members)for(const sock of connections(id))sendSocket(sock,{type:'chat-new',chatType:req.params.type,target:req.params.target,from:req.user.id});
  // Keep message contents private on the device lock screen.
  void sendEventPush(chat.members.filter(id=>id!==req.user.id),'💬 Nuovo messaggio Zyro 360',
    `${req.user.name} ti ha inviato un messaggio.`,'chat')
    .catch(err=>console.error('[ZYRO push] chat:',err.message));
  res.json({ok:true,message});
});
app.post('/api/sos/start', requireAuth, async (req,res) => {
 // Premium is enforced server-side. A UI claim or client flag never grants access.
 if (!premiumActive(req.user)) return res.status(402).json({error:'SOS Premium non attivo. Nessun avviso è stato inviato. Per un pericolo reale chiama il 112.'});
 let alert=currentAlert(req.user.id);
 const recipients=[...new Set((req.user.sosRecipients||[]).filter(id=>id!==req.user.id && sharedCircle(id,req.user.id)))];
 if(!recipients.length&&!alert)return res.status(400).json({error:'Seleziona prima almeno un destinatario SOS nella sezione Modalità.'});
 if(alert?.kind==='pickpocket')return res.status(409).json({error:'Termina prima l’allarme Pick Pocket.'});
 if(alert)return res.json({ok:true,id:alert.id,alreadyActive:true,pushConfigured:configuredPush||fcmReady,serverRecorded:true});
 // Prefer a fresh fix sent with SOS, otherwise a recent GPS already received
 // from this account. Do not block the alert while waiting for a geocoder.
 const cached=locations.get(req.user.id);
 const pos=validCoords(req.body.location) ||
   (cached && now()-cached.updatedAt<120000 ? cached : null);
 if(pos)locations.set(req.user.id,pos);
 alert={id:token(12),userId:req.user.id,recipients,startedAt:now(),active:true,hasAudio:false,kind:'sos',address:null};db.alerts[alert.id]=alert;save();refreshRelated(req.user.id);
 // An address is attempted only with explicit geocoder configuration; GPS works without it.
 const street=await sosAddressFor(pos);if(street){alert.address=street;save();refreshRelated(req.user.id);}
 const where=street || (pos
   ?`Indirizzo non disponibile; GPS ${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}`
   :'Posizione GPS non ancora disponibile');
 const push=await sendEventPush(recipients,`🆘 SOS: ${cleanText(req.user.name,36)} chiede aiuto`,
   `${cleanText(req.user.name,36)} chiede aiuto! ${where}. Apri Zyro 360 per visualizzare la mappa.`, 'sos');
 console.info('[ZYRO SOS] Notifiche provider', {recipients:recipients.length,
   attempted:push.attempted,accepted:push.accepted,geocoded:Boolean(street)});
 // An SOS visible on the map does not guarantee a push arrived.
 // The client can distinguish no devices from provider rejection.
 res.json({ok:true,id:alert.id,serverRecorded:true,pushConfigured:push.configured,pushAccepted:push.accepted,pushAttempted:push.attempted,recipientCount:recipients.length,address:street});
});
app.post('/api/sos/stop', requireAuth, (req,res) => {
  const a=currentAlert(req.user.id);
  if (a?.kind === 'pickpocket') return res.status(403).json({error:'Per interrompere l’antifurto inserisci la password del proprietario.'});
  if (!a) return res.json({ok:true});
  a.active=false; a.hasAudio=false; a.endedAt=now();
  sosAudioRelaySubscribers.delete(req.user.id);
  if (!req.user.sharing) locations.delete(req.user.id);
  save(); refreshRelated(req.user.id);
  for (const id of alertAudience(a)) for (const ws of connections(id)) sendSocket(ws,{type:'sos-ended',userId:req.user.id});
  res.json({ok:true});
});
// Experimental Pick Pocket: browser sensors and alarm cannot lock Android or resist shutdown.
// The contact list is explicitly approved by the owner at activation time.
app.post('/api/pickpocket/start', requireAuth, limit, (req,res) => {
 if(!premiumActive(req.user))return res.status(402).json({error:'Pick Pocket richiede ZYRO Premium o Family.'});
  const existing = currentAlert(req.user.id);
  if (existing) return res.status(409).json({error:'Un altro allarme è già attivo.'});
  const ids = req.body.recipients;
  if (!Array.isArray(ids) || ids.length > 60 || !ids.every(id => typeof id === 'string' && id.length < 100)) return res.status(400).json({error:'Destinatari non validi.'});
  const recipients = [...new Set(ids)];
  if (recipients.some(id => id === req.user.id || !sharedCircle(req.user.id,id))) return res.status(403).json({error:'Puoi avvisare solo membri delle tue cerchie.'});
  const alert = {id:token(12),userId:req.user.id,kind:'pickpocket',recipients,active:true,startedAt:now(),hasAudio:false};
  db.alerts[alert.id]=alert;
  save(); refreshRelated(req.user.id);
  if (recipients.length) void notifyContacts(req.user.id,req.user.name, recipients, true).catch(()=>{});
  res.json({ok:true,id:alert.id,notifiedUsers:recipients.length});
});
app.post('/api/pickpocket/stop', requireAuth, limit, (req,res) => {
  const password=String(req.body.password || '');
  if (!password || !verifyPassword(password,req.user)) return res.status(403).json({error:'Password del proprietario non corretta.'});
  const alert=currentAlert(req.user.id);
  if (!alert || alert.kind!=='pickpocket') return res.json({ok:true});
  alert.active=false;alert.endedAt=now();
  if (!req.user.sharing) locations.delete(req.user.id);
  save(); refreshRelated(req.user.id);
  for (const id of alertAudience(alert)) for (const ws of connections(id)) sendSocket(ws,{type:'sos-ended',userId:req.user.id});
  res.json({ok:true});
});
app.use(express.static(path.join(root,'public'),{maxAge:0, etag:true}));
app.get('*', (req,res) => res.sendFile(path.join(root,'public','index.html')));
const server = http.createServer(app);
const wss = new WebSocketServer({noServer:true, maxPayload:32*1024});
server.on('upgrade',(req,socket,head) => {
  const origin = req.headers.origin;
  const expected = `${req.headers['x-forwarded-proto'] || (prod?'https':'http')}://${req.headers.host}`;
  const user = auth(req);
  if (!user || user.bannedAt || !origin || origin !== expected || !req.url?.startsWith('/ws')) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req,socket,head,ws=>{ws.userId=user.id;wss.emit('connection',ws,req);});
});
function relay(id, msg, preferMicrophone=false) { const con=[...connections(id)].filter(x=>x.readyState===WebSocket.OPEN); const pick = preferMicrophone ? con.find(x=>x.microphoneReady) : con[con.length-1]; if (pick) sendSocket(pick,msg); }
/* V29 · Volatile emergency audio over authenticated WSS when direct WebRTC
   cannot connect. Raw audio frames are never saved or logged. */
const sosAudioRelaySubscribers=new Map();
function authorizedAudioRelay(viewer,owner,alert){
  return !!alert?.active && alert.kind==='sos' && alert.userId===owner &&
    owner!==viewer && familyActive(db.users[owner]) && db.users[owner]?.sosAudioConsent===true &&
    canSeeAlert(viewer,alert);
}
function audioRelayOwnerUpdate(owner){
  const alert=currentAlert(owner),listeners=sosAudioRelaySubscribers.get(owner);
  if(listeners)for(const listener of listeners){
    if(listener.readyState!==WebSocket.OPEN ||
       !authorizedAudioRelay(listener.userId,owner,alert))listeners.delete(listener);
  }
  if(listeners&&!listeners.size)sosAudioRelaySubscribers.delete(owner);
  const needed=!!sosAudioRelaySubscribers.get(owner)?.size;
  relay(owner,{type:needed?'audio-relay-start':'audio-relay-stop'},true);
}

wss.on('connection', ws => {
  if (!sockets.has(ws.userId)) sockets.set(ws.userId,new Set());
  sockets.get(ws.userId).add(ws); ws.alive = true;
  ws.on('pong',()=>{ws.alive=true;});
  sendSocket(ws,{type:'state',data:stateFor(ws.userId)}); refreshRelated(ws.userId);
  ws.on('message', data => {
    let m; try {m=JSON.parse(data.toString());}catch{return;}
    if (!m || typeof m.type !== 'string') return;
    const self=ws.userId;
    if(db.users[self]?.bannedAt){ws.close(1008,'Account sospeso');return;}
    if (m.type==='audio-ready') {
      const a=currentAlert(self); if (!a) return;
      ws.microphoneReady = familyActive(db.users[self]) && m.ready === true && db.users[self]?.sosAudioConsent===true;
      a.hasAudio = familyActive(db.users[self]) && a.kind !== 'pickpocket' && db.users[self]?.sosAudioConsent===true
        && [...connections(self)].some(x => x.microphoneReady);
      if(!a.hasAudio){sosAudioRelaySubscribers.delete(self);relay(self,{type:'audio-relay-stop'},true);}
      save(); refreshRelated(self);
    }

    if(m.type==='audio-relay-subscribe'){
      const owner=String(m.to||'').slice(0,120),a=currentAlert(owner);
      if(!authorizedAudioRelay(self,owner,a)||!a.hasAudio ||
         ![...connections(owner)].some(c=>c.microphoneReady)){
        sendSocket(ws,{type:'audio-relay-status',owner,active:false,
          reason:'Nessun SOS audio disponibile o permesso di ascolto mancante.'});
        return;
      }
      if(!sosAudioRelaySubscribers.has(owner))sosAudioRelaySubscribers.set(owner,new Set());
      sosAudioRelaySubscribers.get(owner).add(ws);
      sendSocket(ws,{type:'audio-relay-status',owner,active:true});
      audioRelayOwnerUpdate(owner);
      return;
    }
    if(m.type==='audio-relay-unsubscribe'){
      const owner=String(m.to||'').slice(0,120),listeners=sosAudioRelaySubscribers.get(owner);
      if(listeners?.delete(ws))audioRelayOwnerUpdate(owner);
      return;
    }
    if(m.type==='audio-relay-data'){
      const a=currentAlert(self),listeners=sosAudioRelaySubscribers.get(self);
      if(!familyActive(db.users[self])||!a||a.kind!=='sos'||db.users[self]?.sosAudioConsent!==true||
         ws.microphoneReady!==true||!a.hasAudio||!listeners?.size)return;
      const pcm=m.pcm;
      if(typeof pcm!=='string'||pcm.length<128||pcm.length>11000||
         pcm.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(pcm))return;
      const time=Date.now();
      if(ws._zyroAudioLastAt && time-ws._zyroAudioLastAt<25)return;
      ws._zyroAudioLastAt=time;
      const packet={type:'audio-relay-data',from:self,pcm};
      for(const listener of listeners){
        if(listener.readyState!==WebSocket.OPEN ||
           !authorizedAudioRelay(listener.userId,self,a)){listeners.delete(listener);continue;}
        if(listener.bufferedAmount<96*1024)sendSocket(listener,packet);
      }
      if(!listeners.size)audioRelayOwnerUpdate(self);
      return;
    }
    if (m.type==='listen-request') {
      const owner=String(m.to||''); const a=currentAlert(owner);
      if (!familyActive(db.users[owner]) || !a || a.kind==='pickpocket' || !a.hasAudio || db.users[owner]?.sosAudioConsent!==true || !canSeeAlert(self,a) || owner===self) return;
      relay(owner,{type:'listen-request',from:self,alertId:a.id},true);
    }
    if (m.type==='rtc') {
      const target=String(m.to||''); const a=currentAlert(self) || currentAlert(target);
      if (!a || !familyActive(db.users[a.userId]) || a.kind==='pickpocket' || db.users[a.userId]?.sosAudioConsent!==true ||
          !canSeeAlert(self,a) || !canSeeAlert(target,a) || ![self,target].includes(a.userId) || self===target) return;
      const signal=m.signal;
      if (!signal || typeof signal!=='object' || !['offer','answer','candidate'].includes(signal.kind) || JSON.stringify(signal).length>24000) return;
      relay(target,{type:'rtc',from:self,alertId:a.id,signal});
    }
  });
  ws.on('close',()=>{
    const conn=sockets.get(ws.userId);
    if(conn){conn.delete(ws);if(!conn.size)sockets.delete(ws.userId);}
    const impacted=[];
    for(const [owner,listeners] of sosAudioRelaySubscribers)if(listeners.delete(ws))impacted.push(owner);
    const a=currentAlert(ws.userId);
    if(a){
      a.hasAudio=a.kind !== 'pickpocket' && db.users[ws.userId]?.sosAudioConsent===true && [...connections(ws.userId)].some(x=>x.microphoneReady);
      if(!a.hasAudio)sosAudioRelaySubscribers.delete(ws.userId);
      save();
    }
    for(const owner of impacted)audioRelayOwnerUpdate(owner);
    refreshRelated(ws.userId);
  });
});
setInterval(()=>{ for (const ws of wss.clients) { if (!ws.alive) {ws.terminate();continue;} ws.alive=false;ws.ping();} },25000).unref();
setInterval(()=>{
  const t=now(); let changed=false;
  for (const [k,s] of Object.entries(db.sessions)) if (s.expiresAt<t) {delete db.sessions[k];changed=true;}
  for (const [k,v] of Object.entries(db.invites)) if (v.expiresAt<t) {delete db.invites[k];changed=true;}
  for (const [k,a] of Object.entries(db.alerts)) if (!a.active && a.endedAt<t-7*86400*1000) {delete db.alerts[k];changed=true;}
  for(const u of Object.values(db.users))if(u.lastLoginAt && u.lastLoginAt<t-30*86400e3 && u.lastLoginIp){delete u.lastLoginIp;changed=true;}
  for(const u of Object.values(db.users))if(u.registrationIp && u.createdAt<t-30*86400e3){delete u.registrationIp;changed=true;}
  if (changed) save();
},3600000).unref();
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  initializeStorage().then(()=>{
    server.listen(PORT,'0.0.0.0',()=>console.log(`Zyro 360: http://localhost:${PORT} (${storageKind})`));
  }).catch(err=>{
    console.error('[ZYRO storage] AVVIO BLOCCATO:',err.message);
    process.exitCode=1;
    // Do not start the app with a blank DB if Postgres is unavailable.
    if(pgPool) void pgPool.end().catch(()=>{});
  });
}
export { app, server, initializeStorage };



