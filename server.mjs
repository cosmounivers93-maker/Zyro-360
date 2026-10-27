import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import webpush from 'web-push';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const dbPath = path.join(dataDir, 'zyro360.json');
const initial = { users: {}, circles: {}, memberships: [], invites: {}, sessions: {}, alerts: {} };
let db;
try { db = { ...initial, ...JSON.parse(fs.readFileSync(dbPath, 'utf8')) }; }
catch (err) { if (err.code !== 'ENOENT') throw err; db = structuredClone(initial); }
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
const cleanText = (s, max = 60) => String(s || '').trim().replace(/[\u0000-\u001F\u007F<>]/g, '').slice(0, max);
const publicUser = u => ({ id: u.id, name: u.name });
function save() { const tmp = `${dbPath}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 }); fs.renameSync(tmp, dbPath); }
function passwordHash(p, salt) { return crypto.scryptSync(p, salt, 64).toString('hex'); }
function verifyPassword(p, u) { const stored = Buffer.from(u.passwordHash, 'hex'); const calc = Buffer.from(passwordHash(p, u.salt), 'hex'); return stored.length === calc.length && crypto.timingSafeEqual(stored, calc); }
function getCookie(req, key) { const raw = req.headers.cookie || ''; const part = raw.split(';').map(x => x.trim()).find(x => x.startsWith(`${key}=`)); return part ? decodeURIComponent(part.slice(key.length + 1)) : null; }
function auth(req) { const sid = getCookie(req, 'cs_session'); const s = sid && db.sessions[hash(sid)]; return s && s.expiresAt > now() ? db.users[s.userId] : null; }
function setCookie(res, sid) { res.cookie('cs_session', sid, { httpOnly: true, secure: prod, sameSite: 'lax', path: '/', maxAge: SESSION_MAX_AGE }); }
function loginUser(res, id) { const sid = token(32); db.sessions[hash(sid)] = { userId: id, expiresAt: now() + SESSION_MAX_AGE }; setCookie(res, sid); save(); }
function memberIds(circleId) { return db.memberships.filter(m => m.circleId === circleId).map(m => m.userId); }
function userCircles(id) { return db.memberships.filter(m => m.userId === id).map(m => db.circles[m.circleId]).filter(Boolean); }
function sharedCircle(a, b) { return a === b || userCircles(a).some(c => memberIds(c.id).includes(b)); }
function connections(id) { return sockets.get(id) || new Set(); }
function online(id) { return connections(id).size > 0; }
function currentAlert(id) { return Object.values(db.alerts).find(a => a.userId === id && a.active) || null; }
function canSeeAlert(viewerId, alert) {
  if (!alert || !sharedCircle(viewerId, alert.userId)) return false;
  return alert.kind !== 'pickpocket' || (Array.isArray(alert.recipients) && alert.recipients.includes(viewerId)) || viewerId === alert.userId;
}
function alertAudience(alert) {
  if (alert.kind === 'pickpocket') return new Set([alert.userId, ...(alert.recipients || []).filter(id => sharedCircle(id, alert.userId))]);
  return activeRecipients(alert.userId);
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
      const shared = Boolean(u.sharing || visibleAlert);
      const location = shared && locations.has(x) ? locations.get(x) : null;
      return { ...publicUser(u), online: online(x), sharing: shared, location, sos: visibleAlert ? { id: alert.id, startedAt: alert.startedAt, hasAudio: !!alert.hasAudio, kind: alert.kind || 'sos' } : null };
    })
  }));
  const alerts = Object.values(db.alerts).filter(a => a.active && canSeeAlert(id, a)).map(a => ({
    id: a.id, userId: a.userId, name: db.users[a.userId]?.name || 'Contatto',
    startedAt: a.startedAt, kind: a.kind || 'sos', hasAudio: Boolean(a.hasAudio), location: locations.get(a.userId) || null
  })).sort((a,b) => b.startedAt - a.startedAt);
  return { me: { ...publicUser(me), email: me.email, sharing: !!me.sharing, sos: currentAlert(id)?.id || null, alertKind: currentAlert(id)?.kind || null, theftShare: !!(currentAlert(id)?.kind==='pickpocket' && currentAlert(id)?.recipients?.length) }, circles, alerts, pushEnabled: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY), vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null };
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
  res.set('Permissions-Policy', 'geolocation=(self), microphone=(self), camera=()');
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' https://unpkg.com; img-src 'self' data: https://tile.openstreetmap.org https://unpkg.com; connect-src 'self' ws: wss:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  res.set('Cache-Control', req.path.startsWith('/api/') ? 'no-store' : 'no-cache');
  next();
});
app.use(express.json({ limit: '24kb' }));
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
function requireAuth(req, res, next) { req.user = auth(req); if (!req.user) return res.status(401).json({ error:'Accedi per continuare.' }); next(); }
app.get('/api/health', (_, res) => res.json({ ok: true }));
app.post('/api/register', limit, (req, res) => {
  const name = cleanText(req.body.name, 36), email = String(req.body.email || '').trim().toLowerCase(), password = String(req.body.password || '');
  if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || email.length > 160 || password.length < 10 || password.length > 128) return res.status(400).json({error:'Inserisci nome, email valida e una password di almeno 10 caratteri.'});
  if (Object.values(db.users).some(u => u.email === email)) return res.status(409).json({error:'Email già registrata.'});
  const id = token(12), salt = token(16);
  db.users[id] = { id, name, email, salt, passwordHash: passwordHash(password, salt), createdAt: now(), sharing: false, pushSubs: [] };
  loginUser(res, id); res.json({ ok:true });
});
app.post('/api/login', limit, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), password = String(req.body.password || '');
  const u = Object.values(db.users).find(x => x.email === email);
  if (!u || !verifyPassword(password, u)) return res.status(401).json({error:'Email o password non corretti.'});
  loginUser(res, u.id); res.json({ok:true});
});
app.post('/api/logout', requireAuth, (req,res) => {
  const sid = getCookie(req, 'cs_session'); if (sid) delete db.sessions[hash(sid)];
  res.clearCookie('cs_session', {path:'/'}); save();
  for (const ws of connections(req.user.id)) ws.close(1008,'Sessione terminata');
  res.json({ok:true});
});
app.get('/api/state', requireAuth, (req,res) => res.json(stateFor(req.user.id)));
app.post('/api/circles', requireAuth, limit, (req,res) => {
  const name = cleanText(req.body.name, 48);
  if (name.length < 2) return res.status(400).json({error:'Dai un nome alla cerchia.'});
  if (userCircles(req.user.id).length >= MAX_USER_CIRCLES) return res.status(400).json({error:'Limite cerchie raggiunto.'});
  const id = token(12); db.circles[id] = {id, name, ownerId:req.user.id, createdAt:now()};
  db.memberships.push({circleId:id, userId:req.user.id}); save(); refreshRelated(req.user.id); res.json({ok:true, circleId:id});
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
  db.memberships.push({circleId:inv.circleId,userId:req.user.id}); delete db.invites[key]; save();
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
  if (!enabled && (!currentAlert(req.user.id) || (currentAlert(req.user.id).kind==='pickpocket' && !currentAlert(req.user.id).recipients?.length))) locations.delete(req.user.id);
  save(); refreshRelated(req.user.id); res.json({ok:true});
});
const lastPos = new Map();
app.post('/api/position', requireAuth, (req,res) => {
  const alert=currentAlert(req.user.id);
  if (!req.user.sharing && (!alert || (alert.kind==='pickpocket' && !alert.recipients?.length))) return res.status(403).json({error:'Condivisione non attiva.'});
  const lat = Number(req.body.lat), lon = Number(req.body.lon), accuracy = Number(req.body.accuracy);
  if (![lat,lon,accuracy].every(Number.isFinite) || Math.abs(lat)>90 || Math.abs(lon)>180 || accuracy < 0 || accuracy>100000) return res.status(400).json({error:'Coordinate non valide.'});
  const t=now(); if (t-(lastPos.get(req.user.id)||0)<2400) return res.json({ok:true}); lastPos.set(req.user.id,t);
  locations.set(req.user.id,{lat,lon,accuracy,updatedAt:t}); refreshRelated(req.user.id); res.json({ok:true});
});
const configuredPush = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (configuredPush) webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.org', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
async function notifyContacts(id, name, recipients = null, isTheft = false) {
  if (!configuredPush) return;
  const tasks = [];
  for (const target of (recipients || activeRecipients(id))) {
    if (target === id) continue;
    const user = db.users[target];
    for (const sub of user?.pushSubs || []) tasks.push(webpush.sendNotification(sub, JSON.stringify({title:isTheft?'🚨 Possibile furto':'🆘 Richiesta SOS', body:isTheft?`${name}: possibile scippo rilevato. Verifica e contatta la persona.`:`${name} ha attivato un SOS. Apri Zyro 360.`, url:'/'}), {TTL:120, urgency:'high'}).catch(e => { if ([404,410].includes(e.statusCode)) user.pushSubs = user.pushSubs.filter(s => s.endpoint!==sub.endpoint); }));
  }
  await Promise.allSettled(tasks); save();
}
app.post('/api/push/subscribe', requireAuth, (req,res) => {
  if (!configuredPush) return res.status(503).json({error:'Notifiche push non configurate.'});
  const s=req.body.subscription;
  if (!s || typeof s.endpoint !== 'string' || !s.endpoint.startsWith('https://') || s.endpoint.length>2000 || !s.keys?.p256dh || !s.keys?.auth) return res.status(400).json({error:'Abbonamento push non valido.'});
  req.user.pushSubs = (req.user.pushSubs || []).filter(x=>x.endpoint!==s.endpoint).slice(-3);
  req.user.pushSubs.push({endpoint:s.endpoint,keys:{p256dh:s.keys.p256dh,auth:s.keys.auth}});
  save(); res.json({ok:true});
});
app.post('/api/sos/start', requireAuth, async (req,res) => {
  let alert = currentAlert(req.user.id);
  if (!alert) { alert={id:token(12),userId:req.user.id,startedAt:now(),active:true,hasAudio:false,kind:'sos'}; db.alerts[alert.id]=alert; save(); refreshRelated(req.user.id); void notifyContacts(req.user.id, req.user.name).catch(()=>{}); }
  res.json({ok:true,id:alert.id});
});
app.post('/api/sos/stop', requireAuth, (req,res) => {
  const a=currentAlert(req.user.id);
  if (a?.kind === 'pickpocket') return res.status(403).json({error:'Per interrompere l’antifurto inserisci la password del proprietario.'});
  if (!a) return res.json({ok:true});
  a.active=false; a.hasAudio=false; a.endedAt=now();
  if (!req.user.sharing) locations.delete(req.user.id);
  save(); refreshRelated(req.user.id);
  for (const id of activeRecipients(req.user.id)) for (const ws of connections(id)) sendSocket(ws,{type:'sos-ended',userId:req.user.id});
  res.json({ok:true});
});
// Experimental Pick Pocket: browser sensors and alarm cannot lock Android or resist shutdown.
// The contact list is explicitly approved by the owner at activation time.
app.post('/api/pickpocket/start', requireAuth, limit, (req,res) => {
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
  if (!user || !origin || origin !== expected || !req.url?.startsWith('/ws')) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req,socket,head,ws=>{ws.userId=user.id;wss.emit('connection',ws,req);});
});
function relay(id, msg, preferMicrophone=false) { const con=[...connections(id)].filter(x=>x.readyState===WebSocket.OPEN); const pick = preferMicrophone ? con.find(x=>x.microphoneReady) : con[con.length-1]; if (pick) sendSocket(pick,msg); }
wss.on('connection', ws => {
  if (!sockets.has(ws.userId)) sockets.set(ws.userId,new Set());
  sockets.get(ws.userId).add(ws); ws.alive = true;
  ws.on('pong',()=>{ws.alive=true;});
  sendSocket(ws,{type:'state',data:stateFor(ws.userId)}); refreshRelated(ws.userId);
  ws.on('message', data => {
    let m; try {m=JSON.parse(data.toString());}catch{return;}
    if (!m || typeof m.type !== 'string') return;
    const self=ws.userId;
    if (m.type==='audio-ready') {
      const a=currentAlert(self); if (!a) return;
      ws.microphoneReady = m.ready === true;
      a.hasAudio = a.kind !== 'pickpocket' && [...connections(self)].some(x => x.microphoneReady); save(); refreshRelated(self);
    }
    if (m.type==='listen-request') {
      const owner=String(m.to||''); const a=currentAlert(owner);
      if (!a || a.kind==='pickpocket' || !a.hasAudio || !sharedCircle(self,owner) || owner===self) return;
      relay(owner,{type:'listen-request',from:self,alertId:a.id},true);
    }
    if (m.type==='rtc') {
      const target=String(m.to||''); const a=currentAlert(self) || currentAlert(target);
      if (!a || a.kind==='pickpocket' || !sharedCircle(self,target) || ![self,target].includes(a.userId) || self===target) return;
      const signal=m.signal;
      if (!signal || typeof signal!=='object' || !['offer','answer','candidate'].includes(signal.kind) || JSON.stringify(signal).length>24000) return;
      relay(target,{type:'rtc',from:self,alertId:a.id,signal});
    }
  });
  ws.on('close',()=>{const conn=sockets.get(ws.userId);if(conn){conn.delete(ws);if(!conn.size)sockets.delete(ws.userId);}const a=currentAlert(ws.userId);if(a){a.hasAudio=a.kind !== 'pickpocket' && [...connections(ws.userId)].some(x=>x.microphoneReady);save();}refreshRelated(ws.userId);});
});
setInterval(()=>{ for (const ws of wss.clients) { if (!ws.alive) {ws.terminate();continue;} ws.alive=false;ws.ping();} },25000).unref();
setInterval(()=>{
  const t=now(); let changed=false;
  for (const [k,s] of Object.entries(db.sessions)) if (s.expiresAt<t) {delete db.sessions[k];changed=true;}
  for (const [k,v] of Object.entries(db.invites)) if (v.expiresAt<t) {delete db.invites[k];changed=true;}
  for (const [k,a] of Object.entries(db.alerts)) if (!a.active && a.endedAt<t-7*86400*1000) {delete db.alerts[k];changed=true;}
  if (changed) save();
},3600000).unref();
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) server.listen(PORT, '0.0.0.0',()=>console.log(`Zyro 360: http://localhost:${PORT}`));
export { app, server };
