'use strict';
const $ = id => document.getElementById(id);
let current = null;
let adminUsersCache = [];
let adminLoaded = false;
let socket = null;
let wsRetry = null;
let watchId = null;
let lastCoords = null;
let sentAt = 0;
let localStream = null;
let micBusy = false;
let sosAudioError = '';
let activeView = 'home';
let authMode = 'login';
let toastTimer;
let refreshTimer;
const peers = new Map();
const pendingIce = new Map();
let listeningTo = null;
let geolocationError = '';
let lastAlertKey = '';
const inviteCodes = new Map();
let chatRoom=null, chatPhotoData=null;
let sosPending=null;
const journeySelected=new Set(),checkinSelected=new Set();
let journeyTarget=null;
let inviteFromLink=null;
// Map: GPS stays on this device unless the user explicitly enables sharing or an alert.
let mapTracking=false, ownCentered=false;
// One 2D map engine; no WebGL or external JavaScript.
let stableMap=null, stableMapState='idle', stableLoadTimer=null, stableRetryTimer=null;
let stableAttempts=0, stableBootId=0, stableResizeObserver=null;
const stableMarkers=new Map();
let compassHeading = null;
let gpsCourseActive = false;
// V14.5 - A single filtered heading controller. Every displayed rotation is animated
// through the shortest angle, without duplicating or redrawing map tiles.
const headingMotion = {
  compass: null, compassAt: 0, gps: null, gpsAt: 0,
  target: null, display: null, source: null, frame: null, previousFrame: 0,
  lastSensorAt: 0, lastAccepted: 0, pendingJump: null
};
function normalizeHeading(deg){return Number.isFinite(deg)?((deg%360)+360)%360:null;}
function headingDelta(a,b){return ((b-a+540)%360)-180;}
function clearHeadingMotion(){
  if(headingMotion.frame!==null)cancelAnimationFrame(headingMotion.frame);
  Object.assign(headingMotion,{compass:null,compassAt:0,gps:null,gpsAt:0,target:null,display:null,
    source:null,frame:null,previousFrame:0,lastSensorAt:0,lastAccepted:0,pendingJump:null});
  compassHeading=null;gpsCourseActive=false;
}
function renderHeadingOnly(){
  if(!lastCoords || activeView!=='home' || document.hidden)return;
  const shown=Number.isFinite(headingMotion.display)?headingMotion.display:null;
  lastCoords.heading=shown;
  const pin=stableMap?.pinNodes?.get('me');
  if(pin)updateGlassHeading(pin,shown);
  else stableMap?.schedule();
}
function selectHeadingSource(now=Date.now()){
  // Orientation of the PHONE comes first; GPS course is not phone orientation.
  if(Number.isFinite(headingMotion.compass)&&now-headingMotion.compassAt<4000)
    return {angle:headingMotion.compass,source:'compass'};
  if(Number.isFinite(headingMotion.gps)&&now-headingMotion.gpsAt<8000)
    return {angle:headingMotion.gps,source:'gps'};
  return null;
}
function animateHeading(time){
  headingMotion.frame=null;
  if(!lastCoords||!Number.isFinite(headingMotion.target)){headingMotion.previousFrame=0;return;}
  const dt=headingMotion.previousFrame?Math.min(.06,Math.max(.001,(time-headingMotion.previousFrame)/1000)):1/60;
  headingMotion.previousFrame=time;
  if(!Number.isFinite(headingMotion.display))headingMotion.display=headingMotion.target;
  const diff=headingDelta(headingMotion.display,headingMotion.target);
  // Angular low-pass with a maximum speed: smooth yet responsive to a real turn.
  const easing=1-Math.exp(-dt*(Math.abs(diff)>35?11:8));
  const turn=Math.sign(diff)*Math.min(Math.abs(diff*easing),dt*240);
  if(Math.abs(diff)<.65)headingMotion.display+=diff;
  else headingMotion.display+=turn;
  renderHeadingOnly();
  if(Math.abs(headingDelta(headingMotion.display,headingMotion.target))>.65)
    headingMotion.frame=requestAnimationFrame(animateHeading);
  else headingMotion.previousFrame=0;
}
function aimHeading(){
  const choice=selectHeadingSource();
  if(!choice){
    headingMotion.target=null;headingMotion.source=null;
    if(headingMotion.frame!==null){cancelAnimationFrame(headingMotion.frame);headingMotion.frame=null;}
    headingMotion.previousFrame=0;headingMotion.display=null;renderHeadingOnly();return;
  }
  const current=headingMotion.target;
  // Ignore tiny compass noise, but allow accumulated real rotation to pass.
  if(Number.isFinite(current)&&headingMotion.source===choice.source&&
      Math.abs(headingDelta(current,choice.angle))<1.5)return;
  headingMotion.target=choice.angle;headingMotion.source=choice.source;
  if(!Number.isFinite(headingMotion.display)){
    headingMotion.display=choice.angle;renderHeadingOnly();return;
  }
  if(headingMotion.frame===null)headingMotion.frame=requestAnimationFrame(animateHeading);
}
function acceptCompassReading(raw,now=Date.now()){
  const angle=normalizeHeading(raw);if(angle===null)return;
  // Reject isolated jumps typical of magnetic interference; a sustained turn is accepted.
  const old=headingMotion.compass;
  if(Number.isFinite(old)&&now-headingMotion.lastAccepted<300&&
      Math.abs(headingDelta(old,angle))>75){
    const pending=headingMotion.pendingJump;
    if(!pending||now-pending.at>900||Math.abs(headingDelta(pending.angle,angle))>25){
      headingMotion.pendingJump={angle,at:now};return;
    }
  }
  headingMotion.pendingJump=null;
  headingMotion.lastAccepted=now;
  if(!Number.isFinite(old))headingMotion.compass=angle;
  else {
    const delta=headingDelta(old,angle);
    // Circular smoothing avoids the 359°->0° jump and filters sensor jitter.
    if(Math.abs(delta)>=1.5)
      headingMotion.compass=normalizeHeading(old+delta*(Math.abs(delta)>25?.65:.40));
  }
  headingMotion.compassAt=now;
  compassHeading=headingMotion.compass;
  aimHeading();
}
const ZYRO_THEME_KEY='zyro360-appearance-v8';
let zyroTheme='dark';
// Pick Pocket is a foreground browser experiment, not an Android system lock.
let pickArmed=false, theftTriggered=false, lastMotionAt=0, motionPeaks=0, motionSamples=0, armTime=0;
const pickSelected = new Set();
let sirenContext=null, sirenOscillator=null, sirenGain=null, sirenTimer=null, theftIsPending=false;

function escapeHtml(t) { return String(t??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x])); }
function initials(s) {return String(s||'?').trim().charAt(0).toUpperCase();}
function toast(message,error=false) {const el=$('toast');el.textContent=message;el.classList.toggle('error',error);el.classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.add('hidden'),5200);}
async function api(route, options={}) {
  let res;
  try {res=await fetch(route,{credentials:'same-origin',headers:{'Content-Type':'application/json'},...options});}
  catch {throw Error('Connessione Internet assente. Riprova quando sei online.');}
  let body;try{body=await res.json();}catch{body={};}
  if(!res.ok) {const err=Error(body.error || `Errore di connessione (${res.status}).`);err.status=res.status;throw err;}
  return body;
}
const post = (path,data={})=>api(path,{method:'POST',body:JSON.stringify(data)});
async function action(fn){try{await fn();}catch(e){toast(e.message,true);}}
function connectSocket(){
  if(!current || socket?.readyState===WebSocket.OPEN || socket?.readyState===WebSocket.CONNECTING) return;
  if(wsRetry){clearTimeout(wsRetry);wsRetry=null;}
  const proto=location.protocol==='https:'?'wss':'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  socket=ws;
  ws.onopen=()=>{ connection(true); if(localStream)ws.send(JSON.stringify({type:'audio-ready',ready:true})); if(listeningTo)retryListenAfterReconnect(); };
  ws.onmessage=async(event)=>{
    let m;try{m=JSON.parse(event.data);}catch{return;}
    if(m.type==='state'){setState(m.data);}
    if(m.type==='listen-request') await action(()=>sendOffer(m.from));
    if(m.type==='rtc') await action(()=>handleRTC(m.from,m.signal));
    if(m.type==='audio-relay-start') await action(startAudioRelaySender);
    if(m.type==='audio-relay-stop') stopAudioRelaySender();
    if(m.type==='audio-relay-status') handleAudioRelayStatus(m);
    if(m.type==='audio-relay-data') handleAudioRelayPacket(m);
    if(m.type==='account-banned'){alert(m.notice||'Account sospeso.');location.reload();return;}
    if(m.type==='admin-new-report' && current?.me?.isAdmin){toast('Nuova segnalazione ricevuta nel Centro amministratore.');void action(adminLoad);}
    if(m.type==='chat-new' && chatRoom) { if(m.chatType===chatRoom.type && (chatRoom.type==='circle' ? m.target===chatRoom.id : m.from===chatRoom.id || m.from===current?.me?.id))void loadChat(); }
    if(m.type==='sos-ended') {if(m.userId===listeningTo)stopListening();if(m.userId===current?.me?.id)stopAudio();}
  };
  ws.onclose=()=>{if(socket!==ws)return;socket=null;connection(false);stopAudioRelaySender();if(current)wsRetry=setTimeout(connectSocket,3000);};
  ws.onerror=()=>{connection(false);};
}
function wsSend(message){if(socket?.readyState!==WebSocket.OPEN)return false;socket.send(JSON.stringify(message));return true;}
function connection(up){$('connectionText').textContent=up?'Collegato':'Non collegato';$('connectionDot').classList.toggle('connected',up);}
function setState(data){
  if(!data?.me)return;
  const prev = current;
  current=data;
  // Revoking explicit opt-in stops ongoing live audio locally as well.
  if(data.me.sosAudioConsent!==true && localStream)stopAudio();
  if(window.ZyroAndroidSafetySupported && window.ZyroNativeSafety?.pick===true && !theftTriggered)
    pickArmed=true;
  if($('appScreen').classList.contains('hidden')) { $('authScreen').classList.add('hidden');$('appScreen').classList.remove('hidden'); }
  updateGeo(null, data.me.sharing || !!data.me.sos || mapTracking || pickArmed);
  renderHome();renderCircles();renderSettings();renderPickControls();renderSOSRecipients();renderChatRooms();renderV15();renderAdminAccess();renderReportContacts();renderInvitedPeople();
  if (data.me.alertKind === 'pickpocket' && !theftTriggered) { theftTriggered=true; pickArmed=false; showTheftOverlay('È presente un allarme antifurto. Puoi fermarlo con la password.'); startSiren(); }
  if (data.me.alertKind !== 'pickpocket' && theftTriggered && !theftIsPending) { theftTriggered=false; hideTheftOverlay(); stopSiren(); }

  const key = data.alerts.filter(a=>a.userId!==data.me.id).map(a=>a.id).sort().join(',');
  if(prev && key && key !== lastAlertKey) toast('🆘 Nuovo SOS nella tua cerchia.',true);
  lastAlertKey=key;
}
// Admin UI is only an interface. Every admin endpoint separately verifies the owner's server-side user ID.
function renderAdminAccess(){
 const admin=Boolean(current?.me?.isAdmin);
 $('zyroAdminPanel').classList.toggle('hidden',!admin);
 $('myAccountId').textContent=current?.me?.id||'';
 $('reportMenuItem')?.classList.toggle('hidden',admin);
 $('premiumPanel')?.classList.toggle('zyro-premium-owner',admin);
 if(!admin){adminLoaded=false;adminUsersCache=[];$('adminUsers').replaceChildren();$('adminReports').replaceChildren();$('adminAudit').replaceChildren();}
}
function renderReportContacts(){
 const select=$('reportUser');if(!select)return;
 const contacts=uniqueContacts(),v=select.value;
 const signature=contacts.map(u=>`${u.id}:${u.name}`).sort().join('|');
 if(select.dataset.signature===signature)return;
 select.dataset.signature=signature;
 select.innerHTML='<option value="">Seleziona un contatto</option>'+contacts.map(u=>`<option value="${escapeHtml(u.id)}">${escapeHtml(u.name)}</option>`).join('');
 select.value=contacts.some(u=>u.id===v)?v:'';
}
async function submitReport(){
 const userId=$('reportUser').value,reason=$('reportReason').value.trim();
 if(!userId)throw Error('Seleziona il contatto da segnalare.');
 if(reason.length<12)throw Error('Descrivi il motivo in almeno 12 caratteri.');
 if(!confirm('Inviare una segnalazione privata all’amministratore?'))return;
 const result=await post('/api/report',{userId,reason});
 $('reportReason').value='';toast(result.message||'Segnalazione inviata.');
}
function fmtAdminDate(n){return n?new Date(n).toLocaleString('it-IT'):'Non disponibile';}
function renderAdminUsers(){
 const term=$('adminFilter').value.trim().toLowerCase();
 const users=adminUsersCache.filter(u=>[u.name,u.email,u.id].some(v=>String(v||'').toLowerCase().includes(term)));
 $('adminUsers').innerHTML=users.length?users.map(u=>`<article class="zyro-admin-user">
 <div class="zyro-admin-user-title"><b>${escapeHtml(u.name)}</b><span class="zyro-admin-chip ${u.bannedAt?'is-banned':u.premiumGiftLifetime?'is-gift':''}">${u.bannedAt?'Sospeso':u.premiumGiftLifetime?'Premium a vita':u.premiumActive?'Premium attivo':'Standard'}</span></div>
 <p>${escapeHtml(u.email)}</p><div class="zyro-admin-meta"><small>ID</small><code>${escapeHtml(u.id)}</code><small>Ultimo IP</small><code>${escapeHtml(u.lastLoginIp||'Non disponibile')}</code><small>Ultimo accesso</small><span>${escapeHtml(fmtAdminDate(u.lastLoginAt))}</span></div>
 ${u.id===current.me.id?'<small>Account proprietario — non sospendibile.</small>':`<div class="zyro-admin-actions"><button type="button" data-admin-ban="${escapeHtml(u.id)}">${u.bannedAt?'Riattiva account':'Sospendi account'}</button><button type="button" data-admin-gift="${escapeHtml(u.id)}">${u.premiumGiftLifetime?'Revoca regalo Premium':'Regala Premium a vita'}</button></div>`}
 </article>`).join(''):'<p class="setting-description">Nessun account corrispondente alla ricerca.</p>';
 $('adminUsers').querySelectorAll('[data-admin-ban]').forEach(b=>b.addEventListener('click',()=>action(()=>adminChangeBan(b.dataset.adminBan))));
 $('adminUsers').querySelectorAll('[data-admin-gift]').forEach(b=>b.addEventListener('click',()=>action(()=>adminChangeGift(b.dataset.adminGift))));
}
async function adminLoad(){
 if(!current?.me?.isAdmin)return;
 $('adminStatus').textContent='Caricamento account e segnalazioni…';
 const data=await api('/api/admin/users');
 adminUsersCache=data.users||[];adminLoaded=true;renderAdminUsers();
 $('adminReports').innerHTML=(data.reports||[]).length?`<h3>Segnalazioni recenti</h3>`+(data.reports||[]).map(r=>`<div class="zyro-admin-report"><b>${escapeHtml(r.reason)}</b><p>ID segnalato: ${escapeHtml(r.userId)} · ID segnalante: ${escapeHtml(r.reporterId)}</p><small>${fmtAdminDate(r.at)} · ${escapeHtml(r.status)}</small>${r.status==='open'?`<button type="button" data-admin-review="${escapeHtml(r.id)}">Segna come esaminata</button>`:''}</div>`).join(''):'';
 $('adminReports').querySelectorAll('[data-admin-review]').forEach(b=>b.addEventListener('click',()=>action(()=>adminReview(b.dataset.adminReview))));
 $('adminAudit').innerHTML=(data.audit||[]).map(a=>`<p><b>${escapeHtml(a.kind)}</b> · ${escapeHtml(a.for||'')} · ${escapeHtml(fmtAdminDate(a.at))}</p>`).join('')||'<p>Nessuna azione registrata.</p>';
 $('adminStatus').textContent=`${adminUsersCache.length} account registrati. Dati visibili esclusivamente al proprietario.`;
}
/* V17.1: native browser confirm()/prompt() may be cancelled by Android WebView.
   Use accessible DOM dialogs; all privileged actions still require server-side
   account ownership AND owner password verification. */
function zyroOwnerDialog({title,description='',kind='confirm',submitLabel='Conferma',defaultValue=''}) {
 return new Promise(resolve=>{
  const veil=document.createElement('div');veil.className='zyro-owner-dialog-backdrop';
  const form=document.createElement('form');form.className='zyro-owner-dialog';
  form.setAttribute('role','dialog');form.setAttribute('aria-modal','true');
  const heading=document.createElement('h3');heading.textContent=title;
  const explanation=document.createElement('p');explanation.className='zyro-owner-dialog-description';explanation.textContent=description;
  form.setAttribute('aria-label',title);
  form.append(heading,explanation);
  let field=null;
  if(kind==='reason'||kind==='password'){
   const label=document.createElement('label');label.textContent=kind==='password'?'Password del proprietario':'Motivazione della sospensione';
   field=document.createElement(kind==='reason'?'textarea':'input');
   field.className='zyro-owner-dialog-input';field.required=true;
   if(kind==='password'){
    field.type='password';field.autocomplete='current-password';field.maxLength=200;
   }else{
    field.rows=3;field.minLength=8;field.maxLength=300;
   }
   field.value=defaultValue;
   label.append(field);form.append(label);
  }
  const actions=document.createElement('div');actions.className='zyro-owner-dialog-actions';
  const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Annulla';
  const submit=document.createElement('button');submit.type='submit';submit.className='zyro-owner-dialog-ok';submit.textContent=submitLabel;
  actions.append(cancel,submit);form.append(actions);veil.append(form);
  const previousFocus=document.activeElement;
  let done=false;
  const onKey=(event)=>{if(event.key==='Escape'){event.preventDefault();finish(null);}else if(event.key==='Tab'){
    const allowed=[...(field?[field]:[]),cancel,submit];
    if(event.shiftKey&&document.activeElement===allowed[0]){event.preventDefault();allowed[allowed.length-1].focus();}
    else if(!event.shiftKey&&document.activeElement===allowed[allowed.length-1]){event.preventDefault();allowed[0].focus();}
  }};
  const finish=(value)=>{if(done)return;done=true;document.removeEventListener('keydown',onKey,true);veil.remove();try{previousFocus?.focus?.();}catch{}resolve(value);};
  cancel.addEventListener('click',()=>finish(null));
  veil.addEventListener('click',e=>{if(e.target===veil)finish(null);});
  form.addEventListener('submit',e=>{e.preventDefault();if(field){const value=field.value.trim();if(!value||kind==='reason'&&value.length<8){field.focus();field.setCustomValidity(kind==='reason'?'Scrivi almeno 8 caratteri.':'Inserisci la password.');field.reportValidity();return;}finish(value);}else finish(true);});
  field?.addEventListener('input',()=>field.setCustomValidity(''));
  document.body.append(veil);document.addEventListener('keydown',onKey,true);
  (field||submit).focus();
 });
}
async function adminChangeBan(id){
 const u=adminUsersCache.find(x=>x.id===id);if(!u)return;
 const ban=!u.bannedAt;
 const reason=ban?await zyroOwnerDialog({title:`Sospendi ${u.name}`,description:'Scrivi la motivazione che giustifica la sospensione di questo account.',kind:'reason',submitLabel:'Continua'}):'Rimozione della sospensione';
 if(reason===null)return;
 const confirmed=await zyroOwnerDialog({title:ban?'Sospensione account':'Riattivazione account',description:`Vuoi davvero ${ban?'sospendere':'riattivare'} ${u.name}?`,submitLabel:ban?'Sospendi account':'Riattiva account'});
 if(!confirmed)return;
 const password=await zyroOwnerDialog({title:'Conferma amministratore',description:'Per sicurezza, inserisci la password del tuo account creatore.',kind:'password',submitLabel:'Conferma'});
 if(!password)return;
 await post('/api/admin/ban',{userId:id,banned:ban,reason,password});
 await adminLoad();toast(ban?'Account sospeso. Accesso revocato.':'Account riattivato.');
}
async function adminChangeGift(id){
 const u=adminUsersCache.find(x=>x.id===id);if(!u)return;
 const enabled=!u.premiumGiftLifetime;
 const confirmed=await zyroOwnerDialog({title:enabled?'Regala Premium a vita':'Revoca Premium a vita',description:`${enabled?'Assegnare Premium gratuito a vita a':'Revocare il regalo Premium a'} ${u.name}?`,submitLabel:enabled?'Regala Premium':'Revoca Premium'});
 if(!confirmed)return;
 const password=await zyroOwnerDialog({title:'Conferma amministratore',description:'Inserisci la password del tuo account creatore per autorizzare il cambiamento.',kind:'password',submitLabel:'Conferma'});
 if(!password)return;
 await post('/api/admin/premium-gift',{userId:id,enabled,password});
 await adminLoad();toast(enabled?'Premium a vita concesso.':'Regalo Premium revocato.');
}
async function adminReview(reportId){
 const password=await zyroOwnerDialog({title:'Conferma amministratore',description:'Autorizza la revisione della segnalazione con la tua password.',kind:'password',submitLabel:'Segna come esaminata'});
 if(!password)return;
 await post('/api/admin/report-resolve',{reportId,password,status:'reviewed'});
 await adminLoad();toast('Segnalazione esaminata.');
}
function uniqueContacts(){const contacts=new Map();for(const c of current?.circles||[])for(const m of c.members)if(m.id!==current.me.id)contacts.set(m.id,m);return [...contacts.values()];}
function when(ts){if(!ts)return 'Nessuna posizione';const diff=Date.now()-ts;if(diff<60000)return 'Aggiornata ora';if(diff<3600000)return `${Math.round(diff/60000)} min fa`;return `${Math.round(diff/3600000)} ore fa`;}
function locationUrl(p){return `https://www.openstreetmap.org/?mlat=${encodeURIComponent(p.lat)}&mlon=${encodeURIComponent(p.lon)}#map=16/${encodeURIComponent(p.lat)}/${encodeURIComponent(p.lon)}`;}
function renderHome(){
  if(!current)return;
  const me=current.me, contacts=uniqueContacts(), pick=me.alertKind==='pickpocket', sos=!!me.sos&&!pick;
  $('greetingName').textContent=me.name.split(' ')[0];setAvatar($('myAvatar'),me); 
  $('totalMembers').textContent=contacts.length;$('totalCircles').textContent=current.circles.length;
  $('shareToggle').checked=!!me.sharing; $('shareToggle').disabled=!!me.sos;
  $('shareToggle').closest('.zyro-command-share')?.classList.toggle('is-sharing',!!me.sharing);
  $('shareState').textContent=me.sharing?'LIVE':'OFF';
  const liveGPS=me.sharing||(pick&&me.theftShare);
  $('myLocationText').textContent= sos?'SOS attivo. Posizione condivisa solo se già autorizzata.':(liveGPS ? (geolocationError || (lastCoords?`GPS attivo · ${lastCoords.lat.toFixed(4)}, ${lastCoords.lon.toFixed(4)}`:'Ricerca posizione GPS...')):'Condivisione disattivata');
  $('sosCard').classList.toggle('is-active',!!me.sos);
  $('sosTitle').textContent=pick?'Protezione antifurto attiva':sos?'SOS attivo sul server (consegna non garantita)':'Hai bisogno di aiuto?';
  $('sosDescription').textContent=pick?'La modalità Pick Pocket è scattata. Puoi interromperla con la password nella schermata antifurto.':sos?(contacts.length?'SOS registrato. I destinatari selezionati possono visualizzare l’allarme; la consegna non è garantita.':'Nessun contatto nella tua cerchia: il SOS non raggiunge nessuno. Chiama il 112 in emergenza.'):'SOS Premium richiede un abbonamento attivo. In caso di pericolo reale chiama il 112.';
  $('sosButton').disabled=!!me.sos;
  $('sosButton').setAttribute('aria-label',me.sos?'Allarme già attivo':'Apri SOS Premium');
  $('sosActiveActions').classList.toggle('hidden',!sos);
  $('sosInactiveNote').classList.toggle('hidden',!!me.sos);
  const micState=$('sosAudioState');
  if(micState){
    const consent=me.sosAudioConsent===true;
    micState.dataset.status=!consent?'off':localStream?'on':sosAudioError?'error':'pending';
    micState.textContent=!consent?'Audio ambientale disattivato nelle impostazioni.'
      :localStream?'🎙 Microfono acceso · un destinatario autorizzato deve premere «Ascolta» per ricevere l’audio.'
      :sosAudioError?'⚠ Audio non disponibile: '+sosAudioError
      :'Audio autorizzato · avvio microfono in corso…';
  }
  const contactsRoot=$('contactsList');
  const contactHtml=contacts.length?contacts.map((u,i)=>{
    const status=u.sos?(u.sos.kind==='pickpocket'?'🚨 POSSIBILE FURTO':'🆘 SOS ATTIVO'):u.online?(u.sharing?'Posizione attiva':'Online'):'Offline';
    const loc=u.location, time=loc?when(loc.updatedAt):(u.sharing?'Posizione in attesa':'Posizione non condivisa');
    return `<div class="contact-card"><div class="contact-avatar ${i%2?'alt':''}">${avatarHTML(u)}</div><div class="contact-info"><b>${escapeHtml(u.name)}</b><small>${escapeHtml(time)}</small></div><div class="contact-actions"><span class="status-chip ${u.sos?'alert':!u.online?'off':''}">${escapeHtml(status)}</span>${loc?`<a class="mini-btn" target="_blank" rel="noopener noreferrer" href="${locationUrl(loc)}">📍 Mappa</a>`:''}${u.sos?.hasAudio?`<button type="button" class="mini-btn audio" data-listen="${escapeHtml(u.id)}">🎧 Ascolta</button>`:u.sos?.kind==='sos'?'<span class="status-chip off" title="La persona deve attivare il microfono SOS sul suo telefono">🎙 Audio in attesa</span>':''}</div></div>`;
  }).join(''):`<div class="empty-state"><div class="empty-symbol">♧</div><strong>La tua cerchia inizia da qui</strong>Aggiungi le persone di cui ti fidi per condividere la posizione e ricevere SOS.</div>`;
  if(contactsRoot._zyroHtml!==contactHtml){contactsRoot.innerHTML=contactHtml;contactsRoot._zyroHtml=contactHtml;}
  const otherAlerts=current.alerts.filter(a=>a.userId!==me.id);
  // V33: show the SOS audio action on Home, at the moment the authorized
  // recipient receives the server state. It is enabled ONLY when server says
  // hasAudio=true; a push/map location alone is not an audio connection.
  const incomingSOS=otherAlerts.find(a=>(a.kind||'sos')==='sos');
  const homeSOSListen=$('homeSOSListen');
  if(homeSOSListen){
    homeSOSListen.classList.toggle('hidden',!incomingSOS);
    if(incomingSOS){
      const ready=incomingSOS.hasAudio===true;
      const name=escapeHtml(incomingSOS.name||'Una persona fidata');
      const nextHtml=`<div class="zyro-home-sos-text"><b>🆘 SOS ricevuto da ${name}</b>`+
        `<small>${ready?'🎙 Microfono segnalato pronto. Tocca Ascolta per collegarti.':'🎙 Audio non ancora disponibile. Il mittente deve autorizzare e accendere il microfono SOS.'}</small></div>`+
        `<div class="zyro-home-sos-actions">`+
        (ready?`<button type="button" data-listen="${escapeHtml(incomingSOS.userId)}" class="zyro-home-listen-button">🎧 Ascolta microfono</button>`:
          `<button type="button" class="zyro-home-listen-button" disabled aria-disabled="true">🎧 In attesa del microfono</button>`)+
        `<button type="button" data-sos-detail="1" class="zyro-home-sos-details">Dettagli SOS</button></div>`;
      if(homeSOSListen._zyroHtml!==nextHtml){
        homeSOSListen.innerHTML=nextHtml;
        homeSOSListen._zyroHtml=nextHtml;
        homeSOSListen.querySelector('[data-sos-detail]')?.addEventListener('click',()=>showView('modes'));
      }
    }else{
      homeSOSListen.replaceChildren();
      homeSOSListen._zyroHtml='';
    }
  }
  $('activeAlerts').classList.toggle('hidden',!otherAlerts.length);
  const alertsRoot=$('activeAlerts');
  const alertsHtml=otherAlerts.map(a=>`<div class="alert-box"><h3>${a.kind==='pickpocket'?'🚨 Possibile furto:':'🆘'} ${escapeHtml(a.name)} ${a.kind==='pickpocket'?'potrebbe aver subito uno scippo':'chiede aiuto'}</h3><p>Allarme attivo · ${new Date(a.startedAt).toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'})}. Contatta i soccorsi se necessario.</p>${a.kind!=='pickpocket'&&!a.hasAudio?'<p role="status">🎙 Audio non ancora disponibile. Chi invia SOS deve abilitare il consenso microfono e verificare che compaia “Microfono acceso”.</p>':''}<div class="action-row">${a.address?`<p>📍 ${escapeHtml(a.address)}</p>`:''}${a.location?`<a target="_blank" rel="noopener noreferrer" href="${locationUrl(a.location)}">📍 Apri posizione</a>`:''}${a.kind!=='pickpocket'?(a.hasAudio?`<button type="button" data-listen="${escapeHtml(a.userId)}">🎧 Ascolta microfono</button>`:'<button type="button" disabled title="Attendi che il telefono che invia il SOS abbia attivato il microfono">🎧 In attesa del microfono</button>'):''}<a href="tel:112">Chiama 112</a></div></div>`).join('');
  if(alertsRoot._zyroHtml!==alertsHtml){alertsRoot.innerHTML=alertsHtml;alertsRoot._zyroHtml=alertsHtml;}
  document.querySelectorAll('[data-listen]:not([data-zyro-wired])').forEach(btn=>{
    btn.dataset.zyroWired='1';
    btn.addEventListener('click',()=>action(()=>listenTo(btn.dataset.listen)));
  });
  renderMap();
}
function inviteBox(code){const link=location.origin+'/?invite='+encodeURIComponent(code);return `<div class="invite-code-box"><small>LINK E CODICE MONOUSO · VALIDI 24 ORE</small><code>${escapeHtml(code)}</code><button type="button" class="copy-code">Copia codice</button><input readonly aria-label="Link invito" value="${escapeHtml(link)}"><div class="invite-share-actions"><button type="button" class="copy-invite-link">🔗 Copia link</button><button type="button" class="share-invite-link">↗ Condividi</button></div></div>`;}
function renderCircles(){
  if(!current)return;
  const list=$('circlesList');
  const sig=JSON.stringify([current.me.id,(current.circles||[]).map(c=>[c.id,c.name,c.mine,(c.members||[]).map(m=>[m.id,m.name])]),[...inviteCodes.entries()]]);
  if(list._zyroSig===sig&&list.children.length)return;
  list._zyroSig=sig;
  list.innerHTML=current.circles.length?current.circles.map(c=>`<div class="circle-card" data-circle="${escapeHtml(c.id)}"><div class="circle-top"><div><strong>◎ ${escapeHtml(c.name)}</strong><small>${c.members.length} ${c.members.length===1?'membro':'membri'} · ${c.mine?'Creata da te':'Cerchia condivisa'}</small></div><span class="status-chip">Privata</span></div><div class="circle-members">${c.members.map(m=>`<span class="member-pill">${escapeHtml(m.name)}${m.id===current.me.id?' (tu)':''}</span>`).join('')}</div><div class="circle-actions"><button type="button" data-chatcircle="${escapeHtml(c.id)}">💬 Chat gruppo</button><button type="button" data-invite="${escapeHtml(c.id)}">✚ Genera codice invito</button>${c.mine?`<button type="button" class="danger" data-delete="${escapeHtml(c.id)}">Elimina cerchia</button>`:`<button type="button" class="danger" data-leave="${escapeHtml(c.id)}">Esci dalla cerchia</button>`}</div><div class="invite-target">${inviteCodes.has(c.id)?inviteBox(inviteCodes.get(c.id)):''}</div></div>`).join(''):'<div class="empty-state"><div class="empty-symbol">◎</div><strong>Ancora nessuna cerchia</strong>Crea un gruppo o inserisci il codice di un familiare.</div>';
  list.querySelectorAll('[data-invite]').forEach(b=>b.addEventListener('click',()=>action(async()=>{
    const r=await post('/api/invites',{circleId:b.dataset.invite});
    const target=b.closest('.circle-card').querySelector('.invite-target');
    inviteCodes.set(b.dataset.invite,r.code);target.innerHTML=inviteBox(r.code);
    bindCopyCodes(target);
  })));
  bindCopyCodes(list);
  list.querySelectorAll('[data-chatcircle]').forEach(b=>b.addEventListener('click',()=>openChat('circle',b.dataset.chatcircle)));
  list.querySelectorAll('[data-leave]').forEach(b=>b.addEventListener('click',()=>action(async()=>{if(!confirm('Vuoi davvero uscire da questa cerchia?'))return;await post('/api/circles/leave',{circleId:b.dataset.leave});await refresh();toast('Hai lasciato la cerchia.');})));
  list.querySelectorAll('[data-delete]').forEach(b=>b.addEventListener('click',()=>action(async()=>{if(!confirm('Eliminare definitivamente questa cerchia per tutti i membri?'))return;await post('/api/circles/delete',{circleId:b.dataset.delete});await refresh();toast('Cerchia eliminata.');})));
}
function bindCopyCodes(root){
  root.querySelectorAll('.copy-code').forEach(btn=>btn.addEventListener('click',()=>copyInvite(btn.closest('.invite-code-box')?.querySelector('code')?.textContent,'Codice copiato.')));
  root.querySelectorAll('.copy-invite-link').forEach(btn=>btn.addEventListener('click',()=>copyInvite(btn.closest('.invite-code-box')?.querySelector('input')?.value,'Link copiato. Invialo a una persona fidata.')));
  root.querySelectorAll('.share-invite-link').forEach(btn=>btn.addEventListener('click',()=>action(async()=>{const link=btn.closest('.invite-code-box')?.querySelector('input')?.value;if(navigator.share)await navigator.share({title:'Invito ZYRO 360',text:'Entra nella mia cerchia privata di ZYRO 360',url:link});else await copyInvite(link,'Link copiato. Puoi incollarlo su WhatsApp o Telegram.');})));
}
async function copyInvite(value,message){try{await navigator.clipboard.writeText(value);toast(message);}catch{toast('Tieni premuto sul testo per copiarlo.',true);}}
function setAvatar(el,user){const image=user.avatar;if(image?.startsWith('data:image/jpeg;base64,')){el.textContent='';el.style.backgroundImage=`url("${image}")`;el.classList.add('has-photo');}else{el.style.backgroundImage='';el.textContent=initials(user.name);el.classList.remove('has-photo');}}
function avatarHTML(user){return user.avatar?.startsWith('data:image/jpeg;base64,') ? `<img src="${user.avatar}" alt="" class="avatar-image">` : escapeHtml(initials(user.name));}
function renderSOSRecipients(){
  if(!current)return;
  const contacts=uniqueContacts(), selected=new Set(sosPending===null ? (current.me.sosRecipients||[]) : sosPending);
  const node=$('sosRecipientList');
  const sig=JSON.stringify([contacts.map(u=>[u.id,u.name,u.avatar||'']),[...selected],current.me.premiumActive,current.pushEnabled]);
  if(node._zyroSig===sig&&node.children.length)return;
  node._zyroSig=sig;
  node.innerHTML=contacts.length?contacts.map(u=>`<label class="recipient-line"><input type="checkbox" data-sos-to="${escapeHtml(u.id)}" ${selected.has(u.id)?'checked':''}><span>${avatarHTML(u)} ${escapeHtml(u.name)}</span></label>`).join(''):'<p class="setting-description">Invita prima una persona nella cerchia.</p>';
  $('sosPushNote').textContent=(current.me.premiumActive?'Premium attivo. ':'Premium non attivo: SOS non inviabile. ')+(current.pushEnabled?'Push configurate; consegna non garantita.':'Push non configurate su Render.');
}
async function imageData(file,maxPx=520,maxBytes=105000){
  if(!file?.type?.startsWith('image/'))throw Error('Seleziona una fotografia.');
  if(file.size>12*1024*1024)throw Error('La foto originale è troppo grande (massimo 12 MB).');
  const url=URL.createObjectURL(file);
  try{
    const img=new Image();img.src=url;await img.decode();
    const scale=Math.min(1,maxPx/Math.max(img.width,img.height));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));
    canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
    for(const q of [.78,.60,.44,.3]){const data=canvas.toDataURL('image/jpeg',q);if(data.length<=maxBytes*1.33)return data;}
    throw Error('Foto ancora troppo grande. Scegline una più piccola.');
  }finally{URL.revokeObjectURL(url);}
}
async function saveAvatar(file){const avatar=await imageData(file,400,100000);await post('/api/profile/avatar',{avatar});await refresh();toast('Foto profilo aggiornata.');}
let chatCategory='all';
let chatSearch='';
const roomArrow=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;
const roomGroupIcon=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3.5 19v-2.1A4.9 4.9 0 0 1 8.4 12h1.2a4.9 4.9 0 0 1 4.9 4.9V19H3.5Z"/><path d="M16 5a3 3 0 0 1 0 6M18 13c2.1.5 3 1.9 3 4v2h-4"/></svg>`;
const roomChatIcon=`<svg class="zyro-chat-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.4a8.7 8.7 0 0 1-9.2 8.5 9.5 9.5 0 0 1-3.3-.65L3 21l1.8-5.12a8.4 8.4 0 0 1-1.8-4.48A8.8 8.8 0 0 1 12 3a8.7 8.7 0 0 1 9 8.4Z"/><path d="M8 11.8h.01M12 11.8h.01M16 11.8h.01"/></svg>`;
function renderChatRooms(){
  if(!current)return;
  const circles=current.circles||[], contacts=uniqueContacts();
  const list=$('chatRooms');
  const sig=JSON.stringify([chatCategory,chatSearch,circles.map(c=>[c.id,c.name,c.members.length]),contacts.map(u=>[u.id,u.name,u.avatar||''])]);
  if(list._zyroSig===sig&&list.children.length)return;
  list._zyroSig=sig;
  const matching=(name)=>String(name).toLocaleLowerCase('it').includes(chatSearch.toLocaleLowerCase('it'));
  const rooms=[];
  if(chatCategory!=='direct')for(const c of circles.filter(c=>matching(c.name)))rooms.push(`<button type="button" class="chat-room" data-typ="circle" data-id="${escapeHtml(c.id)}"><span class="chat-room-icon family-room-icon">${roomGroupIcon}</span><span class="chat-room-text"><b>${escapeHtml(c.name)}</b><small>Gruppo famiglia · ${c.members.length} ${c.members.length===1?'persona':'persone'}</small></span><span class="chat-room-chevron">${roomArrow}</span></button>`);
  if(chatCategory!=='circle')for(const u of contacts.filter(u=>matching(u.name)))rooms.push(`<button type="button" class="chat-room" data-typ="direct" data-id="${escapeHtml(u.id)}"><span class="chat-room-icon person-room-icon">${avatarHTML(u)}</span><span class="chat-room-text"><b>${escapeHtml(u.name)}</b><small>Messaggio privato · cerchia condivisa</small></span><span class="chat-room-chevron">${roomArrow}</span></button>`);
  const hasAny = circles.length||contacts.length;
  $('chatRooms').innerHTML=rooms.length?rooms.join(''):chatSearch?`<div class="chat-empty-view"><span class="chat-empty-symbol">${roomChatIcon}</span><h3>Nessun risultato</h3><p>Prova a cercare un altro nome.</p></div>`:hasAny?`<div class="chat-empty-view"><span class="chat-empty-symbol">${roomChatIcon}</span><h3>Non ci sono chat qui</h3><p>Seleziona un'altra categoria.</p></div>`:`<div class="chat-empty-view"><span class="chat-empty-symbol">${roomChatIcon}</span><h3>Ogni legame inizia da qui</h3><p>Crea una cerchia o invita una persona fidata per iniziare una conversazione.</p><button type="button" class="btn btn-primary" id="chatInviteNow">Vai alle Cerchie <span aria-hidden="true">→</span></button></div>`;
  $('chatRooms').querySelectorAll('.chat-room').forEach(b=>b.addEventListener('click',()=>openChat(b.dataset.typ,b.dataset.id)));
  $('chatInviteNow')?.addEventListener('click',()=>showView('circles'));
}
// ZYRO 360 V15.3: full-screen chat and paginated history without deleting older messages.
let chatHistory={room:'',messages:[],nextBefore:null};
function closeChat(){
  chatRoom=null;
  chatHistory={room:'',messages:[],nextBefore:null};
  $('chatConversation').classList.add('hidden');
  $('chatsView').classList.remove('is-conversation');
  document.body.classList.remove('zyro-chat-full');
}
function openChat(type,id){
  closeChat();
  chatRoom={type,id};
  chatHistory={room:`${type}:${id}`,messages:[],nextBefore:null};
  showView('chats');
  $('chatsView').classList.add('is-conversation');
  $('chatConversation').classList.remove('hidden');
  document.body.classList.add('zyro-chat-full');
  const circle=current.circles.find(c=>c.id===id),user=uniqueContacts().find(u=>u.id===id);
  $('chatTitle').textContent=type==='circle' ? circle?.name||'Gruppo':user?.name||'Amico';
  $('chatSubtitle').textContent=type==='circle'?'Chat di gruppo · accesso riservato':'Chat privata · non cifrata end-to-end';
  $('chatMessages').innerHTML='<p class="chat-empty">Caricamento messaggi…</p>';
  loadChat().catch(e=>toast(e.message,true));
}
function renderChatHistory({stickToBottom=false,preserveTop=false}={}){
  const node=$('chatMessages');
  const oldHeight=node.scrollHeight,oldTop=node.scrollTop;
  const bubbles=chatHistory.messages.map(m=>`<article class="chat-bubble ${m.from===current.me.id?'mine':''}"><small>${escapeHtml(m.name)} · ${new Date(m.at).toLocaleString('it-IT',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</small>${m.text?`<p>${escapeHtml(m.text)}</p>`:''}${m.image?`<img loading="lazy" src="${m.image}" alt="Foto nella conversazione">`:''}</article>`).join('');
  node.innerHTML=(chatHistory.nextBefore!==null?'<button type="button" id="chatOlder" class="chat-older">↑ Carica messaggi precedenti</button>':'')+(bubbles||'<p class="chat-empty">Nessun messaggio. Inizia tu la conversazione!</p>');
  $('chatOlder')?.addEventListener('click',()=>loadChat(true).catch(e=>toast(e.message,true)));
  if(stickToBottom) node.scrollTop=node.scrollHeight;
  else if(preserveTop)node.scrollTop=oldTop+node.scrollHeight-oldHeight;
  else node.scrollTop=oldTop;
}
async function loadChat(older=false){
  const r=chatRoom;if(!r||!current)return;
  const roomKey=`${r.type}:${r.id}`;
  if(older && (chatHistory.room!==roomKey||chatHistory.nextBefore===null))return;
  const before=older?`?before=${chatHistory.nextBefore}`:'';
  const node=$('chatMessages');
  const wasNearBottom=!older && (node.scrollHeight-node.scrollTop-node.clientHeight<105 || chatHistory.messages.length===0);
  const response=await api(`/api/chat/${encodeURIComponent(r.type)}/${encodeURIComponent(r.id)}${before}`);
  if(chatRoom!==r||chatHistory.room!==roomKey)return;
  const byId=new Map(chatHistory.messages.map(m=>[m.id,m]));
  for(const m of response.messages)byId.set(m.id,m);
  chatHistory.messages=[...byId.values()].sort((a,b)=>a.at-b.at || a.id.localeCompare(b.id));
  if(older||chatHistory.messages.length===response.messages.length)chatHistory.nextBefore=response.nextBefore;
  renderChatHistory({stickToBottom:wasNearBottom&&!older,preserveTop:older});
}
async function sendChat(text,image){if(!chatRoom)return;await post(`/api/chat/${encodeURIComponent(chatRoom.type)}/${encodeURIComponent(chatRoom.id)}`,{text,image});chatPhotoData=null;$('chatPendingPhoto').textContent='';$('chatPhoto').value='';$('chatText').value='';await loadChat();}

function renderSettings(){if(!current)return;$('profileName').textContent=current.me.name;$('profileEmail').textContent=current.me.email;$('profileAccessLabel').textContent=current.me.isAdmin?'Creatore · Premium incluso':'Account personale';setAvatar($('profileAvatar'),current.me);$('avatarRemove').disabled=!current.me.avatar;$('avatarRemove').classList.toggle('is-disabled',!current.me.avatar);$('pushButton').disabled=!current.pushEnabled;$('pushButton').textContent=current.pushEnabled?'Attiva notifiche SOS':'Notifiche push non configurate';const status=$('profileStorageStatus');if(status){status.textContent=current.persistentStorage?'✓ Profilo salvato.':'Salvataggio del profilo non disponibile: i dati potrebbero non essere conservati. Riprova più tardi.';status.style.borderColor=current.persistentStorage?'#86cbb8':'#e9b3a4';}renderPushTestContacts();}
function renderPushTestContacts(){
  const select=$('pushTestRecipient'), button=$('pushTestButton');
  if(!select||!button)return;
  const previous=select.value, contacts=uniqueContacts();
  const signature=contacts.map(x=>x.id+'|'+x.name).join(';');
  if(select.dataset.signature!==signature){
    select.dataset.signature=signature;
    select.replaceChildren();
    if(!contacts.length){const option=document.createElement('option');option.value='';option.textContent='Nessun contatto nella cerchia';select.append(option);}
    else for(const u of contacts){const option=document.createElement('option');option.value=u.id;option.textContent=u.name;select.append(option);}
    if(contacts.some(c=>c.id===previous))select.value=previous;
  }
  select.disabled=!contacts.length||!current?.pushEnabled;
  button.disabled=!contacts.length||!current?.pushEnabled;
}
async function sendPushTest(){
  const recipientId=$('pushTestRecipient').value;
  if(!recipientId)throw Error('Scegli prima un contatto nella tua cerchia.');
  const button=$('pushTestButton');button.disabled=true;
  try{
    const result=await post('/api/push/test',{recipientId});
    $('pushTestStatus').textContent=result.notice||'Invio di prova completato.';
    toast(result.notice||'Test inviato.',result.accepted===0);
  }finally{button.disabled=false;}
}
let sectionAnimation=null;
function showView(view){const previousView=activeView;const sectionOrder=['home','circles','modes','chats','settings'];if(!sectionOrder.includes(view))return;if(view!=='settings')closeProfileSettings();if(view!=='chats'&&chatRoom)closeChat();activeView=view;for(const v of ['home','circles','modes','chats','settings'])$(`${v}View`).classList.toggle('hidden',v!==view);document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===view));window.scrollTo({top:0,behavior:'instant'});sectionAnimation?.cancel();if(previousView!==view && !matchMedia('(prefers-reduced-motion: reduce)').matches){const panel=$(`${view}View`);if(panel?.animate)sectionAnimation=panel.animate([{opacity:.75,transform:`translateX(${sectionOrder.indexOf(view)>sectionOrder.indexOf(previousView)?24:-24}px)`},{opacity:1,transform:'translateX(0)'}],{duration:180,easing:'cubic-bezier(.2,.7,.2,1)'});}if(view==='settings' && current?.me?.isAdmin && !adminLoaded)void action(adminLoad);if(view==='home'){requestAnimationFrame(()=>{renderMap();stableMap?.resize();});}}
// Native Android V21 runs GPS and sensors independently of the paused WebView.
// The owner always activates it via an explicit first-party on-screen action.

const zyroBridgePending=new Map();
let zyroBridgeRequestNumber=0;
function hasZyroNativeBridge(){
 return typeof window.ZyroNative?.postMessage==='function';
}
function isZyroNativeAvailable(){
 return hasZyroNativeBridge()||window.ZyroAndroidSafetySupported===true;
}
function zyroNativeRequest(action,payload={}){
 if(!hasZyroNativeBridge())return Promise.reject(Error('Non risulta un collegamento Android: apri l’APK, non il sito.'));
 if(!window.ZyroNative.__zyroBound){
   window.ZyroNative.onmessage=event=>{
     let msg;try{msg=JSON.parse(event.data);}catch{return;}
     const entry=zyroBridgePending.get(msg?.requestId);if(!entry)return;
     clearTimeout(entry.timeout);zyroBridgePending.delete(msg.requestId);
     msg.ok?entry.resolve(msg):entry.reject(Error(msg.result||'Comando Android non riuscito.'));
   };
   window.ZyroNative.__zyroBound=true;
 }
 return new Promise((resolve,reject)=>{
   const requestId='zyro'+(++zyroBridgeRequestNumber);
   const timeout=setTimeout(()=>{zyroBridgePending.delete(requestId);reject(Error('Android non risponde al controllo nativo.'));},7000);
   zyroBridgePending.set(requestId,{resolve,reject,timeout});
   try{window.ZyroNative.postMessage(JSON.stringify({requestId,action,payload}));}
   catch(err){clearTimeout(timeout);zyroBridgePending.delete(requestId);reject(err);}
 });
}
function nativeSyncError(code){
 if(code==='zyro-needs-location')return 'Consenti la posizione Android e riprova.';
 if(code==='zyro-needs-login')return 'Accedi dall’app Android, non dal browser.';
 if(code==='zyro-denied')return 'Il sistema non autorizza il monitoraggio.';
 if(code==='zyro-invalid-recipients')return 'Contatti selezionati non validi.';
 return 'Servizio Android non avviato: controlla autorizzazioni e batteria.';
}
async function nativeBackgroundSync(options={}){
 if(!isZyroNativeAvailable())return false;
 const sharing=options.sharing===undefined?Boolean(current?.me?.sharing||current?.me?.sos):!!options.sharing;
 const pick=options.pick===undefined?!!(pickArmed&&!theftTriggered):!!options.pick;
 const recipients=$('pickNotify')?.checked?[...pickSelected]:[];
 const sensitivity=$('pickSensitivity')?.value==='high'?'high':'normal';
 const payload={sharing,pick,recipients,sensitivity};
 let result;
 if(hasZyroNativeBridge()){
   const response=await zyroNativeRequest('sync',payload);
   result=response.result;
   window.ZyroAndroidSafetySupported=true;
   window.ZyroAndroidSafetyBuild=24;
 }else result=window.prompt('ZYRO360_BG_SYNC',JSON.stringify(payload));
 if(result==='zyro-native')return true;
 throw Error(nativeSyncError(result));
}

function zyroNativeAge(ms){
 if(!Number.isFinite(ms) || ms<=0)return 'mai verificato';
 const seconds=Math.max(0,Math.round((Date.now()-ms)/1000));
 if(seconds<60)return seconds+' s fa';
 if(seconds<3600)return Math.round(seconds/60)+' min fa';
 return Math.round(seconds/3600)+' h fa';
}

function nativeDiagnosticText(state){
 if(!isZyroNativeAvailable())
   return '⚠ Collegamento Android assente. Potresti aver aperto il sito o un collegamento del browser. Controlla in Impostazioni Android → App → Zyro 360 la versione 1.0.0-rc3, poi apri l’app dalla sua icona.';
 if(!state || !['v23-android','v24-android'].includes(state.build))
   return '⚠ Collegamento non ancora verificato. Premi «Verifica servizio Android»: controlliamo la risposta diretta del telefono.';
 if(!state.running)
   return '○ Servizio Android non attivo. Attiva GPS LIVE oppure Pick Pocket, poi verifica di nuovo.';
 const parts=['● Servizio Android in esecuzione · notifica persistente richiesta'];
 if(state.sharing){
   parts.push('GPS: ultimo rilevamento '+zyroNativeAge(state.lastLocationAt));
   const fresh=Date.now()-Number(state.lastServerAcceptedAt||0)<120000;
   parts.push((fresh?'✓':'⚠')+' GPS accettato dal server: '+zyroNativeAge(state.lastServerAcceptedAt));
 }else parts.push('GPS LIVE: non condiviso');
 if(state.pick){
   const recent=Date.now()-Number(state.lastSensorAt||0)<90000;
   parts.push((state.sensorReady&&state.sensorSamplingActive&&recent?'✓':'⚠')+
     ' Sensori Android: '+(state.sensorReady?'registrati':'non disponibili')+
     ' · campione '+zyroNativeAge(state.lastSensorAt));
 }else parts.push('Pick Pocket: sensori non armati');
 if(state.batteryUnrestricted===false)
   parts.push('⚠ Risparmio energetico: il sistema potrebbe interrompere il monitoraggio.');
 if(state.problem)parts.push('⚠ '+String(state.problem).slice(0,150));
 parts.push('Non garantito dopo arresto forzato, revoca permessi o spegnimento.');
 return parts.join('\n');
}
function renderNativeDiagnostic(){
 const panel=$('zyroNativeMonitor');if(!panel)return;
 panel.hidden=!current;
 if(!current)return;
 $('zyroNativeMonitorText').textContent=nativeDiagnosticText(window.ZyroNativeSafety);
 // A disabled button hides diagnostics. Keep it clickable even if the APK is outdated.
 $('zyroNativeCheck').disabled=false;
 $('zyroNativeBattery').disabled=!isZyroNativeAvailable();
}
async function readNativeSafetyStatus(){
 let status;
 if(hasZyroNativeBridge()){
   const response=await zyroNativeRequest('status');
   status=response.status;
   if(status?.build!=='v24-android')throw Error('APK Android non aggiornata alla V24.');
   window.ZyroAndroidSafetySupported=true;
   window.ZyroAndroidSafetyBuild=24;
 }else if(window.ZyroAndroidSafetyBuild===23){
   const answer=window.prompt('ZYRO360_BG_STATUS','');
   try{status=JSON.parse(answer||'null');}
   catch{throw Error('Android V23 non ha risposto correttamente.');}
   if(status?.build!=='v23-android')throw Error('Servizio Android V23 non raggiungibile.');
 }else{
   const error='Servizio nativo non rilevato. Controlla in Impostazioni Android → App → Zyro 360 che sia installata la V24 (1.0.0-rc3); apri la sua icona e non un collegamento del browser.';
   $('zyroNativeMonitorText').textContent='⚠ '+error;
   throw Error(error);
 }
 window.ZyroNativeSafety=status;
 renderNativeDiagnostic();renderPickControls();
 return status;
}
async function openNativeBatterySettings(){
 if(hasZyroNativeBridge())await zyroNativeRequest('settings');
 else if(window.ZyroAndroidSafetyBuild===23){
   const answer=window.prompt('ZYRO360_BG_SETTINGS','');
   if(answer!=='zyro-native')throw Error('Impostazioni Android non disponibili.');
 }else throw Error('Apri l’APK Android aggiornata, non il browser.');
 toast('Apri Batteria e, se disponibile, scegli Nessuna restrizione.');
}

function updateGeo(oldOn,newOn){
  if(!newOn){if(watchId!==null)navigator.geolocation?.clearWatch(watchId);watchId=null;lastCoords=null;clearHeadingMotion();geolocationError='';renderMap();return;}
  if(watchId!==null)return;
  if(!navigator.geolocation){geolocationError='GPS non disponibile su questo browser';toast(geolocationError,true);return;}
  geolocationError='';
  watchId=navigator.geolocation.watchPosition(async(p)=>{
    // GPS heading is a COURSE of travel, not the direction the phone faces.
    // Use it only while moving reliably and if a fresh compass is unavailable.
    const speed=p.coords.speed;
    const gpsBearing=normalizeHeading(p.coords.heading);
    gpsCourseActive=gpsBearing!==null&&Number.isFinite(speed)&&speed>=1.5&&
      Number.isFinite(p.coords.accuracy)&&p.coords.accuracy<=50;
    headingMotion.gps=gpsCourseActive?gpsBearing:null;
    headingMotion.gpsAt=gpsCourseActive?Date.now():0;
    lastCoords={lat:p.coords.latitude,lon:p.coords.longitude,accuracy:p.coords.accuracy,
      heading:Number.isFinite(headingMotion.display)?headingMotion.display:null};
    aimHeading();geolocationError='';
    const canShare=!!current?.me?.sharing || !!current?.me?.sos;
    if(canShare && !(window.ZyroNativeSafety?.running && window.ZyroNativeSafety?.sharing)
        && Date.now()-sentAt > 3500){sentAt=Date.now();try{await post('/api/position',lastCoords);}catch(e){if(e.message!=='Condivisione non attiva.')console.warn(e.message);}}
    renderHome();
  },err=>{geolocationError=`GPS: ${err.message||'permesso negato'}`;renderHome();toast(geolocationError,true);},{enableHighAccuracy:true,maximumAge:5000,timeout:20000});
}
async function refresh(){if(!current)return;const data=await api('/api/state');setState(data);}
// The user opted-in in Profilo > Persone invitate. Begin requesting
// microphone access in the physical SOS button gesture (before GPS/network
// awaits), but publish a stream ONLY after the server accepts SOS.
async function openZyroMicrophone(){
 if(!navigator.mediaDevices?.getUserMedia)
   throw Error('Il microfono non è supportato da Android System WebView.');
 try{
   return await navigator.mediaDevices.getUserMedia({audio:true,video:false});
 }catch(firstError){
   // Android WebView can fail to open the default voice-processing route
   // even when runtime permission is already granted. One alternative route
   // without optional processing is worth trying; neither path ever stores audio.
   if(firstError?.name!=='NotReadableError' &&
      !/Could not start audio source/i.test(firstError?.message||''))throw firstError;
   try{
     return await navigator.mediaDevices.getUserMedia({
       audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false},
       video:false
     });
   }catch(secondError){throw secondError;}
 }
}
function acquireSOSEmergencyAudio(){
 return openZyroMicrophone().then(stream=>({stream}),error=>({error}));
}
async function startSOS(){
 if(!current?.me?.premiumActive){showView('settings');openProfileSettings('premium');toast('SOS Premium non attivo: nessun allarme è stato inviato. In emergenza chiama il 112.',true);return;}
 const optedIn=current.me.sosAudioConsent===true;
 sosAudioError='';
 const preparedAudio=optedIn?acquireSOSEmergencyAudio():null;
 let serverStarted=false;
 try{
   // Request a fresh GPS fix, but never delay an SOS indefinitely.
   if(!lastCoords && navigator.geolocation)try{
     const pos=await Promise.race([new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:true,maximumAge:10000,timeout:2400})),new Promise((_,reject)=>setTimeout(()=>reject(Error('GPS non disponibile')),2600))]);
     lastCoords={lat:pos.coords.latitude,lon:pos.coords.longitude,accuracy:pos.coords.accuracy,heading:null};
   }catch{/* GPS may be unavailable; SOS should still continue. */}
   const result=await post('/api/sos/start',{location:lastCoords?{lat:lastCoords.lat,lon:lastCoords.lon,accuracy:lastCoords.accuracy}:null});
   serverStarted=true;
   await refresh();mapTracking=true;updateGeo(null,true);
   if(preparedAudio){
     try{await startAudio(preparedAudio);}
     catch(error){
       sosAudioError=sosMicErrorMessage(error);
       renderHome();
       toast('SOS attivo, ma microfono non disponibile: '+sosAudioError,true);
     }
   }
   if(isZyroNativeAvailable()){
     try{await nativeBackgroundSync({sharing:true});}
     catch(err){toast('SOS attivo, ma GPS in background non avviato: '+err.message,true);}
   }
   if(result.serverRecorded){
     const pushCount=Number(result.pushAccepted||0);
     if(!result.pushConfigured)toast('SOS registrato, ma Firebase non risulta configurato su Render. In emergenza chiama il 112.',true);
     else if(Number(result.recipientCount||0)===0)toast('SOS attivo, ma non hai selezionato destinatari. Apri Persone invitate.',true);
     else if(Number(result.pushAttempted||0)===0)toast('SOS sulla mappa, ma nessun telefono dei destinatari risulta registrato alle notifiche.',true);
     else if(!pushCount)toast('SOS registrato, ma Firebase non ha accettato l’invio.',true);
     else toast('SOS attivato. '+pushCount+' invii accettati dal provider; ricezione non garantita.');
   }
 }catch(error){
   // No microphone should remain active if an SOS was not recorded.
   if(!serverStarted && preparedAudio)void preparedAudio.then(result=>{
     if(result.stream)result.stream.getTracks().forEach(track=>track.stop());
   });
   throw error;
 }
}
async function stopSOS(){
  const confirmed=await zyroOwnerDialog({
    title:'Termina allarme SOS',
    description:'Vuoi davvero interrompere la richiesta di aiuto? Le persone selezionate non vedranno più l’allarme attivo.',
    submitLabel:'Termina SOS'
  });
  if(!confirmed)return;
  await post('/api/sos/stop');
  stopAudio();
  await refresh();
  if(isZyroNativeAvailable()){
    try{await nativeBackgroundSync({sharing:!!current?.me?.sharing});}
    catch(err){toast('Controllo servizio GPS: '+err.message,true);}
  }
  toast('Allarme SOS terminato.');
}
function sosMicErrorMessage(error){
 if(['NotAllowedError','PermissionDeniedError','SecurityError'].includes(error?.name))
   return 'Permesso microfono negato. Apri Impostazioni Android → App → Zyro 360 → Autorizzazioni → Microfono.';
 if(error?.name==='NotReadableError'||/Could not start audio source/i.test(error?.message||''))
   return 'Android non riesce ad aprire il microfono. Controlla la privacy del microfono e chiudi le altre app che lo utilizzano.';
 if(['NotFoundError','DevicesNotFoundError'].includes(error?.name))
   return 'Nessun microfono rilevato su questo dispositivo.';
 return error?.message||'Verifica il permesso microfono e Android System WebView.';
}
async function testSOSMicrophone(){
 // TEST requested on Settings page, not an SOS stream. Nothing is stored
 // and the OS microphone is released immediately.
 const stream=await openZyroMicrophone();
 stream.getTracks().forEach(track=>track.stop());
 return true;
}
async function testZyroNativeMicrophone(){
 if(!hasZyroNativeBridge())
   throw Error('Per questo test serve la nuova APK Android V26, non il browser.');
 let response;
 try{response=await zyroNativeRequest('mic-diagnostic');}
 catch(error){
   if(/zyro-unknown-action/i.test(error.message))
     throw Error('L’APK installata non contiene la diagnostica Android V26. Aggiorna prima la versione Android.');
   throw error;
 }
 const result=response.result||{};
 if(result.permission!==true)
   throw Error('Android non concede il permesso microfono.');
 if(result.microphoneMuted===true)
   throw Error('L’accesso globale al microfono è disattivato sul telefono.');
 if(result.passed===true)
   return '✓ Microfono hardware Android funzionante ('+Number(result.capturedSamples||0)+
     ' campioni letti). Se il test WebView fallisce ancora, il problema è nel collegamento WebView/WebRTC, non nel permesso.';
 throw Error('Anche Android nativo non riesce ad aprire il microfono: '+
   String(result.problem||'sorgente audio non disponibile')+
   '. Controlla chiamate e altre app che usano l’audio.');
}
async function startAudio(preparedAudio){
 if(localStream||micBusy || !current?.me?.sos || current?.me?.sosAudioConsent!==true){
   if(preparedAudio)void preparedAudio.then(r=>r.stream?.getTracks().forEach(t=>t.stop()));
   return;
 }
 micBusy=true;
 try{
   // No second consent dialog: the user explicitly enabled this feature in
   // Persone invitate. Android still requests OS microphone permission.
   const acquired=preparedAudio?await preparedAudio:await acquireSOSEmergencyAudio();
   if(acquired.error)throw acquired.error;
   const stream=acquired.stream;
   if(!stream)throw Error('Nessun flusso audio disponibile.');
   if(!current?.me?.sos || current.me.sosAudioConsent!==true){
     stream.getTracks().forEach(track=>track.stop());return;
   }
   localStream=stream;
   sosAudioError='';
   localStream.getAudioTracks().forEach(track=>track.addEventListener('ended',()=>{
     if(localStream && localStream.getAudioTracks().includes(track)){
       sosAudioError='Android ha interrotto il microfono.';
       stopAudio();
     }
   }));
   wsSend({type:'audio-ready',ready:true});
   renderHome();
 }finally{micBusy=false;}
}
function stopAudio(){stopAudioRelaySender();if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null;}for(const p of peers.values())p.close();peers.clear();pendingIce.clear();wsSend({type:'audio-ready',ready:false});renderHome();}
function makePeer(remoteId,send){
  let peer=peers.get(remoteId);if(peer)return peer;
  peer=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]});
  peer.onicecandidate=e=>{if(e.candidate)wsSend({type:'rtc',to:remoteId,signal:{kind:'candidate',candidate:e.candidate.toJSON()}});};
  peer.onconnectionstatechange=()=>{
    if(peer.connectionState==='connected' && listeningTo===remoteId){
      cancelAudioRelayFallback();
      closeAudioRelayPlayback(true);
      const received=peer._zyroIncomingStream;
      if(received){
        const audio=$('remoteAudio');audio.srcObject=received;
        audio.play().catch(()=>toast('Tocca ▶ nel lettore per ascoltare l’audio.'));
      }
      setAudioListenState('🎧 Audio in diretta collegato (WebRTC)');
    }else if(peer.connectionState==='failed' && listeningTo===remoteId){
      requestAudioRelayFallback(remoteId);
    }
    if(['failed','closed'].includes(peer.connectionState)){peer.close();peers.delete(remoteId);}
  };
  peer.ontrack=ev=>{
    if(listeningTo!==remoteId)return;
    // ontrack fires at SDP negotiation, sometimes before ICE has a network
    // connection. Keep the fallback timer alive until connectionState=connected.
    peer._zyroIncomingStream=ev.streams[0]||new MediaStream([ev.track]);
    $('audioDock').classList.remove('hidden');
    if(peer.connectionState==='connected'){
      cancelAudioRelayFallback();
      closeAudioRelayPlayback(true);
      const audio=$('remoteAudio');audio.srcObject=peer._zyroIncomingStream;
      audio.play().catch(()=>toast('Tocca ▶ nel lettore per ascoltare l’audio.'));
      setAudioListenState('🎧 Audio in diretta collegato (WebRTC)');
    }else{
      setAudioListenState('🎧 Traccia rilevata · attendo connessione o alternativa server...');
    }
  };
  if(send&&localStream)for(const track of localStream.getTracks())peer.addTrack(track,localStream);
  peers.set(remoteId,peer);return peer;
}
async function sendOffer(remoteId){if(!localStream||!current?.me?.sos)return;const prior=peers.get(remoteId);if(prior){prior.close();peers.delete(remoteId);}const p=makePeer(remoteId,true);const offer=await p.createOffer();await p.setLocalDescription(offer);wsSend({type:'rtc',to:remoteId,signal:{kind:'offer',sdp:p.localDescription.toJSON()}});}
async function listenTo(remoteId){
  if(!current?.alerts.some(a=>a.userId===remoteId&&a.hasAudio)){toast('Microfono non disponibile in questo momento.',true);return;}
  if(!socket||socket.readyState!==WebSocket.OPEN){toast('Server audio non connesso: riapri l’app e riprova.',true);return;}
  stopListening();listeningTo=remoteId;
  $('audioDock').classList.remove('hidden');
  // Prime the fallback AudioContext while the receiver's tap gesture is still
  // active. Android WebView may otherwise suspend context creation later.
  try{ensureAudioRelayPlayback();}catch(error){console.warn('Audio playback unavailable:',error?.name||'unknown');}
  setAudioListenState('🎧 Connessione audio in corso...');
  // WebRTC is attempted first; the authenticated live relay is the fallback.
  if('RTCPeerConnection' in window){
    wsSend({type:'listen-request',to:remoteId});
    scheduleAudioRelayFallback(remoteId);
  }else requestAudioRelayFallback(remoteId);
  toast('Ascolto richiesto. Se il lettore rimane in pausa, premi ▶.');
}
async function handleRTC(remoteId,signal){
  if(!signal || !['offer','answer','candidate'].includes(signal.kind))return;
  if(signal.kind==='offer'){
    if(listeningTo!==remoteId)return;
    let p=peers.get(remoteId);if(p){p.close();peers.delete(remoteId);}p=makePeer(remoteId,false);
    await p.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    const answer=await p.createAnswer();await p.setLocalDescription(answer);
    wsSend({type:'rtc',to:remoteId,signal:{kind:'answer',sdp:p.localDescription.toJSON()}});
    await flushIce(remoteId);
  }else if(signal.kind==='answer'){
    const p=peers.get(remoteId);if(!p)return;await p.setRemoteDescription(new RTCSessionDescription(signal.sdp));await flushIce(remoteId);
  }else if(signal.kind==='candidate'){
    const p=peers.get(remoteId);
    if(p?.remoteDescription){await p.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(()=>{});}
    else {let list=pendingIce.get(remoteId)||[];if(list.length<30)list.push(signal.candidate);pendingIce.set(remoteId,list);}
  }
}
async function flushIce(remoteId){const p=peers.get(remoteId);for(const item of pendingIce.get(remoteId)||[])await p?.addIceCandidate(new RTCIceCandidate(item)).catch(()=>{});pendingIce.delete(remoteId);}
function stopListening(){cancelAudioRelayFallback();closeAudioRelayPlayback(true);if(listeningTo){const p=peers.get(listeningTo);if(p){p.close();peers.delete(listeningTo);}pendingIce.delete(listeningTo);}listeningTo=null;const a=$('remoteAudio');a.pause();a.srcObject=null;$('audioDock').classList.add('hidden');}
// V29: End-to-end audio connection feedback and a consent-gated WebSocket PCM
// fallback. PCM packets are forwarded only to authorized active SOS recipients
// by the server, in RAM, and are not stored or logged. Audio is NOT E2EE.
let zyroRelaySender=null,zyroRelayListener=null,zyroRelayTimer=null,zyroRelaySubscribed=false;
let zyroRelaySequence=0;
function setAudioListenState(text){
  const label=$('audioDock')?.querySelector('span');
  if(label)label.textContent=text;
}
function cancelAudioRelayFallback(){
  if(zyroRelayTimer!==null)clearTimeout(zyroRelayTimer);
  zyroRelayTimer=null;
}
function scheduleAudioRelayFallback(owner){
  cancelAudioRelayFallback();
  zyroRelayTimer=setTimeout(()=>{
    zyroRelayTimer=null;
    if(listeningTo!==owner)return;
    const p=peers.get(owner);
    if(p?.connectionState==='connected')return;
    requestAudioRelayFallback(owner);
  },6500);
}
function requestAudioRelayFallback(owner){
  if(listeningTo!==owner||zyroRelaySubscribed)return;
  if(!wsSend({type:'audio-relay-subscribe',to:owner})){
    setAudioListenState('⚠ Server scollegato. Riprova quando Internet torna disponibile.');
    return;
  }
  setAudioListenState('🎧 Collegamento alternativo al server in corso...');
}
function handleAudioRelayStatus(m){
  if(listeningTo!==m.owner)return;
  if(m.active!==true){
    setAudioListenState('⚠ Audio non raggiungibile: '+String(m.reason||'connessione non disponibile').slice(0,125));
    toast('L’audio SOS non è ancora collegato. Verifica il microfono dell’altro telefono.',true);
    return;
  }
  if(peers.get(m.owner)?.connectionState==='connected'){
    // WebRTC won the race: do not start a second unneeded connection.
    wsSend({type:'audio-relay-unsubscribe',to:m.owner});
    return;
  }
  zyroRelaySubscribed=true;
  setAudioListenState('🎧 Ricezione audio tramite server · premi ▶ per ascoltare');
}
function retryListenAfterReconnect(){
  if(!listeningTo)return;
  zyroRelaySubscribed=false;
  setAudioListenState('🎧 Riconnessione al server in corso...');
  requestAudioRelayFallback(listeningTo);
}
function closeAudioRelayPlayback(notifyServer=false){
  cancelAudioRelayFallback();
  if(notifyServer && listeningTo && zyroRelaySubscribed)
    wsSend({type:'audio-relay-unsubscribe',to:listeningTo});
  zyroRelaySubscribed=false;
  const r=zyroRelayListener;zyroRelayListener=null;
  if(r)void r.ctx.close().catch(()=>{});
}
function ensureAudioRelayPlayback(){
  if(zyroRelayListener)return zyroRelayListener;
  const AC=window.AudioContext||window.webkitAudioContext;
  if(!AC)throw Error('Audio in tempo reale non supportato su questo telefono.');
  const ctx=new AC({latencyHint:'interactive'});
  const sink=ctx.createMediaStreamDestination();
  const player=$('remoteAudio');player.srcObject=sink.stream;
  zyroRelayListener={ctx,sink,nextTime:0,started:false};
  void ctx.resume().catch(()=>{});
  void player.play().catch(()=>setAudioListenState('🎧 Audio disponibile · premi ▶ sul lettore per sentirlo'));
  return zyroRelayListener;
}
function handleAudioRelayPacket(m){
  if(!zyroRelaySubscribed||m.from!==listeningTo||typeof m.pcm!=='string')return;
  try{
    const raw=atob(m.pcm),frames=raw.length/2;
    if(!Number.isInteger(frames)||frames<50||frames>4096)return;
    const r=ensureAudioRelayPlayback();
    const buffer=r.ctx.createBuffer(1,frames,16000);
    const out=buffer.getChannelData(0);
    for(let i=0;i<frames;i++){
      const lo=raw.charCodeAt(i*2),hi=raw.charCodeAt(i*2+1);
      const signed=(hi<<8)|lo;out[i]=(signed>32767?signed-65536:signed)/32768;
    }
    const source=r.ctx.createBufferSource();source.buffer=buffer;source.connect(r.sink);
    const now=r.ctx.currentTime;
    if(r.nextTime<now+.12||r.nextTime>now+1)r.nextTime=now+.17;
    source.start(r.nextTime);r.nextTime+=buffer.duration;
    if(!r.started){r.started=true;setAudioListenState('🎧 Audio in diretta tramite server (non E2EE)');}
  }catch(error){
    console.warn('Audio relay playback issue:',error?.name||'unknown');
  }
}
async function startAudioRelaySender(){
  if(zyroRelaySender||!localStream||!current?.me?.sos||current.me.sosAudioConsent!==true)return;
  const AC=window.AudioContext||window.webkitAudioContext;
  if(!AC)return;
  let ctx;
  try{
    ctx=new AC({latencyHint:'interactive'});
    const source=ctx.createMediaStreamSource(localStream);
    // ScriptProcessor only runs when a recipient explicitly requests fallback.
    // Supported in Android WebView; no recording is retained.
    const processor=ctx.createScriptProcessor(4096,1,1);
    const silent=ctx.createGain();silent.gain.value=0;
    source.connect(processor);processor.connect(silent);silent.connect(ctx.destination);
    const sender={ctx,source,processor,silent};zyroRelaySender=sender;
    processor.onaudioprocess=e=>{
      if(zyroRelaySender!==sender||!localStream||!current?.me?.sos||
         current.me.sosAudioConsent!==true||socket?.readyState!==WebSocket.OPEN)return;
      // Skip data if the socket is congested: latency matters more than backlog.
      if(socket.bufferedAmount>96*1024)return;
      const input=e.inputBuffer.getChannelData(0),rate=e.inputBuffer.sampleRate;
      const sampleCount=Math.floor(input.length*16000/rate);
      if(sampleCount<50||sampleCount>4096)return;
      const bytes=new Uint8Array(sampleCount*2);
      for(let i=0;i<sampleCount;i++){
        const v=Math.max(-1,Math.min(1,input[Math.min(input.length-1,Math.floor(i*rate/16000))]||0));
        const p=v<0?Math.round(v*32768):Math.round(v*32767);
        bytes[i*2]=p&255;bytes[i*2+1]=(p>>8)&255;
      }
      let binary='';for(let i=0;i<bytes.length;i++)binary+=String.fromCharCode(bytes[i]);
      wsSend({type:'audio-relay-data',pcm:btoa(binary),seq:zyroRelaySequence++});
    };
    await ctx.resume();
    if(zyroRelaySender!==sender)void ctx.close().catch(()=>{});
  }catch(error){
    console.warn('SOS audio relay not supported:',error?.name||'unknown');
    if(ctx)void ctx.close().catch(()=>{});
    zyroRelaySender=null;
  }
}
function stopAudioRelaySender(){
  const r=zyroRelaySender;zyroRelaySender=null;
  if(!r)return;
  r.processor.onaudioprocess=null;
  try{r.source.disconnect();r.processor.disconnect();r.silent.disconnect();}catch{}
  void r.ctx.close().catch(()=>{});
}
async function enablePush(){
  if(!current?.pushEnabled)throw Error('Le notifiche Web Push non sono ancora configurate sul server.');
  if(!('serviceWorker'in navigator) || !('PushManager'in window)) {
    const nativeAndroid=/\bwv\b|; wv\)/i.test(navigator.userAgent);
    throw Error(nativeAndroid?'Questa versione Android usa una WebView, che non supporta Web Push. Le notifiche Android native richiedono Firebase Cloud Messaging (FCM), non ancora configurato.':'Il browser non supporta Web Push. Verifica i requisiti del browser e della connessione sicura.');
  }
  if(Notification.permission==='denied')throw Error('Notifiche bloccate nelle impostazioni del dispositivo.');
  const permission=await Notification.requestPermission();if(permission!=='granted')throw Error('Consenso alle notifiche non concesso.');
  const reg=await navigator.serviceWorker.ready;
  let sub=await reg.pushManager.getSubscription();
  if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:base64ToBytes(current.vapidPublicKey)});
  await post('/api/push/subscribe',{subscription:sub.toJSON()});
  $('pushStatus').textContent='Notifiche abilitate su questo dispositivo (compatibilità e consegna non garantite).';toast('Notifiche SOS abilitate.');
}
function base64ToBytes(base64){const padding='='.repeat((4-base64.length%4)%4);const binary=atob((base64+padding).replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(binary,x=>x.charCodeAt(0));}
function setMode(m){authMode=m;document.querySelectorAll('.auth-tab').forEach(b=>{const yes=b.dataset.mode===m;b.classList.toggle('active',yes);b.setAttribute('aria-selected',String(yes));});$('nameField').classList.toggle('hidden',m==='login');$('name').required=m==='register';$('password').autocomplete=m==='register'?'new-password':'current-password';$('authSubmit').innerHTML=m==='login'?'Entra nella tua cerchia <span>→</span>':'Crea il mio account <span>→</span>';}
// ZYRO 360 V14.2 — simple 2D cartography for browsers without WebGL or external JS libraries.
// Real raster tiles, requested via the existing authenticated /api/map-tile route.
// Map location is read from GPS; it is only sent to the server when the user opts into sharing.
const TILE_SIZE=256, DEFAULT_CENTER={lat:41.9,lon:12.5};
const ZYRO_MAP_MAX_ZOOM=18;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const mapValidPoint=p=>p&&Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lon))&&Math.abs(Number(p.lat))<=85&&Math.abs(Number(p.lon))<=180;
const mapSafePoint=p=>[Number(p.lon),Number(p.lat)];
const worldWidth=z=>TILE_SIZE*2**z;
function toWorld(lat,lon,z){
  const safeLat=clamp(Number(lat),-85.051128,85.051128),f=Math.PI/180,s=Math.sin(safeLat*f);
  return {x:(Number(lon)+180)/360*worldWidth(z),y:(.5-Math.log((1+s)/(1-s))/(4*Math.PI))*worldWidth(z)};
}
function fromWorld(x,y,z){const w=worldWidth(z);return {lat:Math.atan(Math.sinh(Math.PI*(1-2*clamp(y,0,w)/w)))*180/Math.PI,lon:(((x/w)%1+1)%1)*360-180};}
function mapStatus(message){const el=$('mapStatus');if(el)el.textContent=message;}
function mapLink(){const link=$('mapOpenGoogle');if(!link)return;link.href=mapValidPoint(lastCoords)?`https://www.openstreetmap.org/?mlat=${encodeURIComponent(lastCoords.lat)}&mlon=${encodeURIComponent(lastCoords.lon)}#map=16/${encodeURIComponent(lastCoords.lat)}/${encodeURIComponent(lastCoords.lon)}`:'https://www.openstreetmap.org/';}
function mapShowFailure(message){$('mapUnavailable')?.classList.remove('hidden');if($('mapFailureText'))$('mapFailureText').textContent=message;mapStatus('Cartografia non raggiungibile. Il GPS continua a funzionare.');mapLink();}
function mapHideFailure(){$('mapUnavailable')?.classList.add('hidden');}
function clearMapTimers(){clearTimeout(stableLoadTimer);clearTimeout(stableRetryTimer);stableLoadTimer=null;stableRetryTimer=null;}
function removeStableMap(){stableBootId++;clearMapTimers();try{stableMap?.remove();}catch{}stableMap=null;stableMapState='idle';stableMarkers.clear();$('zyroVectorMap')?.replaceChildren();}
// One translucent glass arrow represents the actual GPS/course or permitted compass bearing.
// The translucent ring remains visible when heading is not supported by the device.
function updateGlassHeading(pin,heading){
 const arrow=pin.querySelector('.zyro-gl-arrow');if(!arrow)return;
 const valid=typeof heading==='number'&&Number.isFinite(heading);
 pin.classList.toggle('zyro-heading-unknown',!valid);
 // The angle is intentionally NOT wrapped: a 359°->1° turn must move only 2°.
 if(valid)arrow.style.transform=`rotate(${heading}deg)`;
}
// V15.1: the public profile photo is shown only for authenticated users and
// contacts whose locations the server has authorized in /api/state.
function usableMapAvatar(user){
 const s=user?.avatar;
 return typeof s==='string'&&s.length<=150000&&/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(s)?s:null;
}
function updateMapAvatar(pin,user,isSelf){
 const src=usableMapAvatar(user),name=String(user?.name||'Contatto');
 const holder=pin.querySelector(isSelf?'.zyro-gl-core':'.zyro-atlas-initial');
 if(!holder)return;
 // Moving the map must not rebuild the photo; update only after profile changes.
 if(pin._zyroAvatar===src && pin._zyroAvatarName===name)return;
 pin._zyroAvatar=src;pin._zyroAvatarName=name;
 holder.replaceChildren();
 holder.classList.toggle('zyro-map-has-avatar',!!src);
 if(src){
  const img=document.createElement('img');img.className='zyro-map-profile-photo';
  img.src=src;img.alt='';img.draggable=false;img.decoding='async';
  holder.append(img);
 }else{
  const initial=document.createElement('b');initial.className='zyro-map-profile-initial';
  initial.textContent=initials(name);holder.append(initial);
 }
 pin.title=isSelf?`${name} — il tuo GPS`:`${name} — posizione condivisa`;
 pin.setAttribute('aria-label',pin.title);
}
function stableMarker(isSelf,heading,user,alert=false){
 const name=String(user?.name|| (isSelf?'Tu':'Contatto'));
 const el=document.createElement('div');el.className=isSelf?'zyro-gl-location':'zyro-gl-contact';
 if(alert)el.classList.add('zyro-contact-alert');
 if(isSelf){
  const ring=document.createElement('span'),arrow=document.createElement('span'),core=document.createElement('span');
  ring.className='zyro-gl-ring';arrow.className='zyro-gl-arrow';core.className='zyro-gl-core';
  arrow.setAttribute('aria-hidden','true');
  arrow.innerHTML=`<svg viewBox="0 0 72 72" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
  <defs>
   <linearGradient id="zyroGlassNavFill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e6ffff" stop-opacity=".72"/><stop offset=".48" stop-color="#5cd8ff" stop-opacity=".32"/><stop offset="1" stop-color="#098acc" stop-opacity=".17"/></linearGradient>
   <linearGradient id="zyroGlassNavFacet" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#bff8ff" stop-opacity=".65"/><stop offset="1" stop-color="#24b8ff" stop-opacity=".08"/></linearGradient>
  </defs>
  <path d="M36 3 L55 56 Q56 60 52 58 L36 49 L20 58 Q16 60 17 56 Z" fill="url(#zyroGlassNavFill)" stroke="#e2ffff" stroke-opacity=".86" stroke-width="1.8" stroke-linejoin="round"/>
  <path d="M36 7 L36 48 L20 55 Z" fill="url(#zyroGlassNavFacet)"/>
  <path d="M36 8 L50 51" stroke="#ccfbff" stroke-opacity=".5" stroke-width="1.2" stroke-linecap="round"/>
  </svg>`;
  el.append(ring,arrow,core);updateGlassHeading(el,heading);
 }else{
  const badge=document.createElement('span'),tag=document.createElement('span');
  badge.className='zyro-atlas-initial';tag.className='zyro-atlas-contact-name';
  tag.textContent=name.slice(0,22);el.append(badge,tag);
 }
 updateMapAvatar(el,user,isSelf);
 return el;
}
class ZyroRasterMap{
 constructor(container,center,zoom,onTile,onError){
  this.el=container;this.zoom=zoom;this.center={...center};this.tiles=new Map();this.onTile=onTile;this.onError=onError;
  this.failed=0;this.loaded=0;this.removed=false;this.pending=null;this.pointers=new Map();this.pinNodes=new Map();this.pinchStart=0;
  this.layer=document.createElement('div');this.layer.className='zyro-raster-tiles';
  this.pinLayer=document.createElement('div');this.pinLayer.className='zyro-raster-markers';
  this.el.replaceChildren(this.layer,this.pinLayer);
  this.onDown=e=>{if(e.pointerType==='mouse'&&e.button!==0)return;this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(this.pointers.size===2)this.pinchStart=0;try{this.el.setPointerCapture(e.pointerId);}catch{}e.preventDefault();};
  this.onMove=e=>{
   if(!this.pointers.has(e.pointerId))return;
   const prev=this.pointers.get(e.pointerId),next={x:e.clientX,y:e.clientY};this.pointers.set(e.pointerId,next);
   if(this.pointers.size===1){this.shift(next.x-prev.x,next.y-prev.y);}
   else if(this.pointers.size===2){
    const arr=[...this.pointers.values()],dist=Math.hypot(arr[0].x-arr[1].x,arr[0].y-arr[1].y);
    if(!this.pinchStart){this.pinchStart=dist;return;}
    if(dist>this.pinchStart*1.4){this.zoomTo(this.zoom+1);this.pinchStart=dist;}
    else if(dist<this.pinchStart/1.4){this.zoomTo(this.zoom-1);this.pinchStart=dist;}
   }
   e.preventDefault();
  };
  this.onUp=e=>{this.pointers.delete(e.pointerId);if(this.pointers.size<2)this.pinchStart=0;};
  this.onWheel=e=>{e.preventDefault();this.zoomTo(this.zoom+(e.deltaY<0?1:-1));};
  this.el.addEventListener('pointerdown',this.onDown);
  this.el.addEventListener('pointermove',this.onMove);
  this.el.addEventListener('pointerup',this.onUp);this.el.addEventListener('pointercancel',this.onUp);
  this.el.addEventListener('wheel',this.onWheel,{passive:false});
  this.resize();
 }
 getZoom(){return this.zoom;}
 zoomTo(newZoom){
  const z=clamp(Math.round(newZoom),2,ZYRO_MAP_MAX_ZOOM);
  if(z===this.zoom)return;
  this.zoom=z;
  // Keep the preceding tiles until the new zoom level is ready.
  // Clearing them immediately caused the white flashes visible on Android.
  this.schedule();
 }
 easeTo(opts){
  if(opts.center&&opts.center.length===2)this.center={lon:Number(opts.center[0]),lat:Number(opts.center[1])};
  if(Number.isFinite(opts.zoom))this.zoom=clamp(Math.round(opts.zoom),2,ZYRO_MAP_MAX_ZOOM);
  this.schedule();
 }
 setStyle(){this.schedule();}
 shift(dx,dy){
  const p=toWorld(this.center.lat,this.center.lon,this.zoom),n=fromWorld(p.x-dx,p.y-dy,this.zoom);
  this.center=n;this.schedule();
 }
 resize(){this.schedule();}
 schedule(){if(this.removed||this.pending!==null)return;this.pending=requestAnimationFrame(()=>{this.pending=null;this.draw();});}
 clearTiles(){for(const img of this.tiles.values())img.remove();this.tiles.clear();}
 positionTile(img,left,top,w,h){
  const tileZoom=Number(img.dataset.zyroZ),scale=2**(this.zoom-tileZoom);
  if(scale<.25||scale>4)return false;
  const size=TILE_SIZE*scale;
  const world=worldWidth(this.zoom);
  let wx=Number(img.dataset.zyroX)*size;
  // Keep the projection close to the viewport across the date line.
  wx+=Math.round(((left+w/2)-(wx+size/2))/world)*world;
  const px=Math.round(wx-left),py=Math.round(Number(img.dataset.zyroY)*size-top);
  img.style.width=`${size}px`;img.style.height=`${size}px`;
  img.style.transform=`translate3d(${px}px,${py}px,0)`;
  return px+size>-256&&px<w+256&&py+size>-256&&py<h+256;
 }
 draw(){
  if(this.removed)return;
  const w=this.el.clientWidth,h=this.el.clientHeight;if(w<20||h<20)return;
  const center=toWorld(this.center.lat,this.center.lon,this.zoom),count=2**this.zoom;
  const left=center.x-w/2,top=center.y-h/2;
  const startX=Math.floor(left/TILE_SIZE)-1,endX=Math.floor((left+w)/TILE_SIZE)+1;
  const startY=Math.max(0,Math.floor(top/TILE_SIZE)-1),endY=Math.min(count-1,Math.floor((top+h)/TILE_SIZE)+1);
  const currentKeys=new Set();
  let required=0,ready=0;
  for(let yy=startY;yy<=endY;yy++)for(let xx=startX;xx<=endX;xx++){
   const key=`${this.zoom}/${xx}/${yy}`;currentKeys.add(key);
   let img=this.tiles.get(key);
   if(!img){
    img=document.createElement('img');img.className='zyro-raster-tile';img.alt='';img.draggable=false;img.decoding='async';
    img.dataset.zyroZ=String(this.zoom);img.dataset.zyroX=String(xx);img.dataset.zyroY=String(yy);
    img.dataset.zyroReady='0';img.style.visibility='hidden';
    img.onload=()=>{
     if(this.removed||!this.tiles.has(key))return;
     img.dataset.zyroReady='1';img.style.visibility='visible';
     this.loaded++;this.onTile?.();this.schedule();
    };
    img.onerror=()=>{
     if(this.removed||!this.tiles.has(key))return;
     img.dataset.zyroReady='error';img.style.visibility='hidden';
     this.failed++;
     if(this.loaded===0&&this.failed>=3)this.onError?.('Le immagini della mappa non arrivano dal server. Riprova o verifica la connessione.');
    };
    this.tiles.set(key,img);this.layer.appendChild(img);
    img.src=`/api/map-tile/${this.zoom}/${((xx%count)+count)%count}/${yy}.png`;
   }
   required++;
   if(img.dataset.zyroReady==='1')ready++;
   this.positionTile(img,left,top,w,h);
  }
  // Previous level remains underneath until the replacement is ready.
  // Remove only off-screen/out-of-scale images while the new ones load.
  const canPrune=required>0&&ready===required;
  for(const [key,img] of this.tiles){
   if(currentKeys.has(key))continue;
   const inRange=this.positionTile(img,left,top,w,h);
   if(canPrune||!inRange||this.tiles.size>180){img.remove();this.tiles.delete(key);}
  }
  this.drawPins(w,h,center);
 }
 drawPins(w,h,center){
  if(!current)return;
  const places=[];for(const c of uniqueContacts())if(mapValidPoint(c.location))places.push({id:'contact:'+c.id,p:c.location,user:c,alert:!!c.sos,own:false});
  if(mapValidPoint(lastCoords))places.push({id:'me',p:lastCoords,user:current.me,own:true});
  const present=new Set();
  for(const p of places){
   const pos=toWorld(p.p.lat,p.p.lon,this.zoom);let dx=pos.x-center.x;const world=worldWidth(this.zoom);
   if(dx>world/2)dx-=world;if(dx< -world/2)dx+=world;
   const x=w/2+dx,y=h/2+pos.y-center.y;present.add(p.id);
   let pin=this.pinNodes.get(p.id);if(!pin){pin=stableMarker(p.own,p.p.heading,p.user,p.alert);pin.classList.add('zyro-raster-pin');this.pinNodes.set(p.id,pin);this.pinLayer.appendChild(pin);}
   pin.style.transform=`translate3d(${Math.round(x)}px,${Math.round(y)}px,0) ${p.own?'translate(-50%,-50%)':'translate(-50%,-22px)'}`;
   pin.style.display=(x< -70||x>w+70||y< -70||y>h+70)?'none':'';
   pin.classList.toggle('zyro-contact-alert',!!p.alert);
   updateMapAvatar(pin,p.user,p.own);
   if(p.own)updateGlassHeading(pin,p.p.heading);
  }
  for(const [id,pin]of this.pinNodes)if(!present.has(id)){pin.remove();this.pinNodes.delete(id);}
 }
 remove(){this.removed=true;if(this.pending!==null)cancelAnimationFrame(this.pending);this.el.removeEventListener('pointerdown',this.onDown);this.el.removeEventListener('pointermove',this.onMove);this.el.removeEventListener('pointerup',this.onUp);this.el.removeEventListener('pointercancel',this.onUp);this.el.removeEventListener('wheel',this.onWheel);this.el.replaceChildren();this.tiles.clear();this.pinNodes.clear();this.pointers.clear();}
}
function syncStableMarkers(){stableMap?.schedule();}
function focusStableMap(lat,lon,zoom=16){if(!stableMap||!mapValidPoint({lat,lon}))return;stableMap.easeTo({center:[Number(lon),Number(lat)],zoom});}
function applyZyroTheme(next,persist=true){
 zyroTheme=next==='light'?'light':'dark';document.documentElement.dataset.theme=zyroTheme;
 document.querySelector('meta[name="theme-color"]')?.setAttribute('content',zyroTheme==='dark'?'#071626':'#e8f5f7');
 for(const btn of document.querySelectorAll('[data-theme-choice]')){const selected=btn.dataset.themeChoice===zyroTheme;btn.classList.toggle('is-selected',selected);btn.setAttribute('aria-pressed',String(selected));}
 if(persist)try{localStorage.setItem(ZYRO_THEME_KEY,zyroTheme);}catch{}
 stableMap?.setStyle(zyroTheme);
}
function ensureStableMap(){
 if(!current||$('homeView').classList.contains('hidden'))return;
 if(stableMap){stableMap.resize();return;}
 const el=$('zyroVectorMap');if(!el||el.clientWidth<20||el.clientHeight<20)return;
 stableMapState='loading';mapHideFailure();mapStatus('Caricamento strade...');
 const initial=mapValidPoint(lastCoords)?{lat:lastCoords.lat,lon:lastCoords.lon}:DEFAULT_CENTER;
 const boot=++stableBootId;
 stableMap=new ZyroRasterMap(el,initial,mapValidPoint(lastCoords)?15:5,()=>{
  if(boot!==stableBootId)return;
  if(stableMapState!=='ready'){stableMapState='ready';mapHideFailure();mapStatus('Cartografia caricata. Attiva il GPS per localizzarti.');renderMap();}
 },message=>{if(boot===stableBootId)mapShowFailure(message);});
 stableLoadTimer=setTimeout(()=>{if(stableMapState!=='ready'&&boot===stableBootId)mapShowFailure('Non arrivano le strade. Controlla la connessione e riprova.');},14000);
}
function renderMap(){
 if(!current||$('homeView').classList.contains('hidden'))return;
 mapLink();ensureStableMap();if(!stableMap)return;
 syncStableMarkers();
 if(mapValidPoint(lastCoords)){
  if(!ownCentered){focusStableMap(lastCoords.lat,lastCoords.lon,16);ownCentered=true;}
  if(stableMapState==='ready')mapStatus(`GPS · precisione ±${Math.round(lastCoords.accuracy||0)} m`);
 }else if(!ownCentered){const c=uniqueContacts().find(u=>mapValidPoint(u.location));if(c){focusStableMap(c.location.lat,c.location.lon,14);ownCentered=true;}if(stableMapState==='ready')mapStatus(geolocationError||'Attiva il GPS per localizzarti');}
 else if(stableMapState==='ready')mapStatus(geolocationError||'Posizione non attiva');
}
function onOrientation(e){
  // Do not use relative alpha as magnetic north: Android often reports it as unstable.
  let raw=null;
  if(Number.isFinite(e.webkitCompassHeading)){
    if(Number.isFinite(e.webkitCompassAccuracy)&&e.webkitCompassAccuracy>45)return;
    raw=e.webkitCompassHeading;
  }else if((e.absolute===true||e.type==='deviceorientationabsolute')&&Number.isFinite(e.alpha)){
    // Account for screen rotation (portrait/landscape), if exposed by the browser.
    raw=360-e.alpha+(Number.isFinite(screen?.orientation?.angle)?screen.orientation.angle:0);
  }
  if(raw===null)return;
  const now=Date.now();
  if(now-headingMotion.lastSensorAt<45)return; // Cap incoming sensor updates (~22 Hz).
  headingMotion.lastSensorAt=now;
  acceptCompassReading(raw,now);
}
async function orientationPermission(){
  try{
    if(typeof window.DeviceOrientationEvent?.requestPermission==='function'){
      const granted=await window.DeviceOrientationEvent.requestPermission();if(granted!=='granted')return;
    }
    window.removeEventListener('deviceorientation',onOrientation);
    window.removeEventListener('deviceorientationabsolute',onOrientation);
    window.addEventListener('deviceorientation',onOrientation);
    window.addEventListener('deviceorientationabsolute',onOrientation);
  }catch{ /* Compass is optional. */ }
}
function renderPickControls(){
  if(!current)return;
  const contacts=uniqueContacts(), validIds=new Set(contacts.map(c=>c.id));
  for(const id of [...pickSelected])if(!validIds.has(id))pickSelected.delete(id);
  const pickRoot=$('pickRecipientsList');
  const pickHtml=contacts.length?contacts.map(c=>`<label><input type="checkbox" data-pickcontact="${escapeHtml(c.id)}" ${pickSelected.has(c.id)?'checked':''}><span>${escapeHtml(c.name)}</span></label>`).join(''):'<span class="empty-contacts">Prima aggiungi qualcuno a una cerchia.</span>';
  // User-selectable Pick Pocket recipients remain in place during unrelated
  // live-location and FCM updates; delegated change handler still works.
  if(pickRoot._zyroHtml!==pickHtml){pickRoot.innerHTML=pickHtml;pickRoot._zyroHtml=pickHtml;}
  $('pickRecipients').classList.toggle('hidden',!$('pickNotify').checked);
  $('pickPanel').classList.toggle('armed',pickArmed);
  $('pickPanel').classList.toggle('alarming',theftTriggered);
  $('pickArm').textContent=pickArmed?'Disattiva Pick Pocket':'Attiva Pick Pocket';
  $('pickArm').disabled=theftTriggered;
  $('pickSensitivity').disabled=pickArmed;
  $('pickNotify').disabled=pickArmed;
  pickRoot.querySelectorAll('input').forEach(el=>{if(el.disabled!==pickArmed)el.disabled=pickArmed;});
  const nativeStatus=window.ZyroNativeSafety;
  $('pickStatus').textContent=theftTriggered
    ?'🚨 Movimento sospetto rilevato. Inserisci la password nella schermata di allarme.'
    :pickArmed && isZyroNativeAvailable()
      ?nativeStatus?.running && nativeStatus?.pick
        ?'🟢 Servizio Android avviato. Premi «Verifica servizio Android» dopo aver bloccato e riaperto lo schermo per controllare i sensori.'
        :'⚠ Servizio Android non confermato. Premi «Verifica servizio Android»: il semplice tasto Attiva non prova il funzionamento.'
      :pickArmed?'⚠ Modalità web di prova, non adatta alla protezione in background. Usa l’app Android V24.'
      :'Protezione disattivata. Attiva solo quando serve: il monitoraggio usa batteria e sensori.';
  renderNativeDiagnostic();
}
async function motionPermission(){
  if(!('DeviceMotionEvent' in window))throw Error('Questo telefono/browser non espone i sensori di movimento.');
  if(typeof window.DeviceMotionEvent.requestPermission==='function'){
    const p=await window.DeviceMotionEvent.requestPermission();
    if(p!=='granted')throw Error('Permesso sensori di movimento negato.');
  }
}
function motionListener(e){
  if(!pickArmed || theftTriggered || Date.now()-armTime<3500)return;
  motionSamples++;
  const a=e.acceleration; if(!a)return;
  const force=Math.hypot(a.x||0,a.y||0,a.z||0);
  const r=e.rotationRate;
  const turn=r?Math.max(Math.abs(r.alpha||0),Math.abs(r.beta||0),Math.abs(r.gamma||0)):0;
  const high=$('pickSensitivity').value==='high';
  const strong=force>(high?13:18) && (turn>(high?60:100) || force>(high?20:27));
  if(!strong)return;
  const now=Date.now();
  const gap=now-lastMotionAt;
  if(gap>1350)motionPeaks=0;
  if(gap>180){motionPeaks++;lastMotionAt=now;}
  if(force>(high?25:31) || (motionPeaks>=2 && turn>(high?60:100)))void triggerTheft();
}
function startSiren(){
  try{
    const AC=window.AudioContext||window.webkitAudioContext;
    if(!AC)return;
    if(!sirenContext)sirenContext=new AC();
    sirenContext.resume().catch(()=>{});
    if(sirenOscillator)return;
    sirenOscillator=sirenContext.createOscillator();sirenGain=sirenContext.createGain();
    sirenOscillator.type='sawtooth';sirenOscillator.frequency.value=720;sirenGain.gain.value=.17;
    sirenOscillator.connect(sirenGain).connect(sirenContext.destination);sirenOscillator.start();
    let high=false;sirenTimer=setInterval(()=>{if(!sirenContext||!sirenOscillator)return;high=!high;sirenOscillator.frequency.setTargetAtTime(high?1230:670,sirenContext.currentTime,.045);navigator.vibrate?.(180);},340);
  }catch{toast('Sirena non disponibile nel browser.',true);}
}
function stopSiren(){
  clearInterval(sirenTimer);sirenTimer=null;
  if(sirenOscillator){try{sirenOscillator.stop();sirenOscillator.disconnect();}catch{}sirenOscillator=null;}
  if(sirenGain){try{sirenGain.disconnect();}catch{}sirenGain=null;}
  navigator.vibrate?.(0);
}
function showTheftOverlay(message){$('theftOverlay').classList.remove('hidden');$('theftMessage').textContent=message;}
function hideTheftOverlay(){$('theftOverlay').classList.add('hidden');$('theftPassword').value='';}
async function armPick(){
  if(theftTriggered)return;
  if(pickArmed){
    if(isZyroNativeAvailable())await nativeBackgroundSync({pick:false});
    pickArmed=false;window.removeEventListener('devicemotion',motionListener);
    updateGeo(null,current?.me?.sharing||!!current?.me?.sos||mapTracking);
    renderPickControls();toast('Pick Pocket disattivata.');return;
  }
  if($('pickNotify').checked && !pickSelected.size)throw Error('Seleziona almeno un familiare o un amico da avvisare.');
  if(isZyroNativeAvailable()){
    const confirmed=confirm('Attiva Pick Pocket: il monitoraggio continuerà a schermo bloccato tramite una notifica Android. Movimenti bruschi possono creare falsi allarmi. Vuoi attivarlo?');
    if(!confirmed)return;
    await nativeBackgroundSync({pick:true});
    pickArmed=true;armTime=Date.now();renderPickControls();
    toast('Monitoraggio nativo richiesto. Controlla la notifica permanente di Zyro 360.');
    return;
  }
  // Safety mode must never claim armed protection from browser-only sensors.
  // Native FGS is required: browser motion events stop when Android suspends it.
  throw Error('Pick Pocket in background richiede l’APK Android Zyro 360 V24. Apri l’app installata dalla sua icona, non il sito nel browser.');
  // Autoplay permission is tied to this user gesture; still not guaranteed by every browser.
  try{const AC=window.AudioContext||window.webkitAudioContext;if(AC){sirenContext ||= new AC();await sirenContext.resume();}}catch{}
  void orientationPermission();
  pickArmed=true;armTime=Date.now();motionSamples=0;motionPeaks=0;lastMotionAt=0;
  window.addEventListener('devicemotion',motionListener);
  updateGeo(null,true);renderPickControls();toast('Pick Pocket attivata. Muovi il telefono con prudenza: può generare falsi allarmi.');
  setTimeout(()=>{if(pickArmed && !theftTriggered && motionSamples===0)toast('Verifica se il browser concede l’accesso ai sensori; a schermo spento potrebbero non funzionare.',true);},7000);
}
async function triggerTheft(){
  if(!pickArmed || theftTriggered)return;
  theftTriggered=true;theftIsPending=true;pickArmed=false;
  window.removeEventListener('devicemotion',motionListener);
  showTheftOverlay('Movimento molto brusco rilevato. Potrebbe essere uno scippo (possibili falsi allarmi).');
  $('theftNetwork').textContent='Invio segnalazione in corso…';
  startSiren();renderPickControls();
  try{
    const recipients=$('pickNotify').checked?[...pickSelected]:[];
    const result=await post('/api/pickpocket/start',{recipients});
    $('theftNetwork').textContent=recipients.length?`Allarme inviato al server. Destinatari scelti: ${result.notifiedUsers}. Notifiche push non garantite.`:'Sirena locale attiva. Nessun contatto selezionato per l’avviso.';
    await refresh();
  }catch(e){$('theftNetwork').textContent='⚠ Invio non riuscito: '+e.message+'. Sirena locale attiva, i contatti potrebbero NON essere avvisati.';}
  finally{theftIsPending=false;}
}
async function stopTheft(){
  const password=$('theftPassword').value;
  if(!password)throw Error('Inserisci la password del tuo account per fermare l’allarme.');
  $('theftStop').disabled=true;
  try{
    await post('/api/pickpocket/stop',{password});
    theftTriggered=false;theftIsPending=false;stopSiren();hideTheftOverlay();
    await refresh();
    if(isZyroNativeAvailable())await nativeBackgroundSync({pick:false});
    renderPickControls();toast('Allarme antifurto terminato dal proprietario.');
  }finally{$('theftStop').disabled=false;}
}
async function previewSiren(){
  if(theftTriggered)return;
  startSiren();toast('Sirena attiva per 2 secondi. Nessun avviso inviato.');
  setTimeout(()=>{if(!theftTriggered)stopSiren();},2000);
}

function v15ContactsHtml(selected,tag){const contacts=uniqueContacts();
 return contacts.length?contacts.map(u=>`<label class="zyro-v15-contact"><input data-${tag}="${escapeHtml(u.id)}" type="checkbox" ${selected.has(u.id)?'checked':''}><span>${escapeHtml(u.name)}</span></label>`).join(''):'<p class="zyro-v15-note">Invita prima almeno una persona nella sezione Cerchie.</p>';
}
function v15Time(time){return Number.isFinite(time)?new Date(time).toLocaleString('it-IT',{hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit'}):'—';}
function renderV15(){if(!current)return;
 const me=current.me;
 $('premiumStatus').textContent=me.creatorPremium?'Account creatore verificato: tutte le funzioni Premium sono incluse gratuitamente. Nessun abbonamento richiesto.':me.premiumActive?(me.premiumGiftLifetime?'Premium a vita: accesso omaggio attivo.':`Premium attivo fino al ${v15Time(me.premiumUntil)} · le notifiche richiedono anche i permessi dei destinatari.`):'Abbonamento Premium non attivo. Acquisti Play Store non ancora configurati: non è possibile inviare SOS Premium.';
 $('premiumStatus').classList.toggle('ok',!!me.premiumActive);
 for(const [container,selected,tag] of [['journeyRecipients',journeySelected,'journey-to'],['checkinRecipients',checkinSelected,'checkin-to']]){
  const root=$(container);const members=uniqueContacts();const signature=members.map(x=>x.id).join(',');
  if(root.dataset.members!==signature){root.dataset.members=signature;root.innerHTML=v15ContactsHtml(selected,tag);}
 }
 const j=me.journey,onJ=j&&['active','late'].includes(j.status);
 $('journeyInactive').classList.toggle('hidden',!!onJ);$('journeyActive').classList.toggle('hidden',!onJ);
 if(onJ){$('journeyStatus').textContent=j.status==='late'?'Orario previsto superato: contatta i tuoi familiari':'Percorso attivo';$('journeyDetail').textContent=`Meta: ${j.destination} · Previsto entro ${v15Time(j.dueAt)}${j.autoArrival?' · Rilevamento GPS attivo':''}`;}
 const c=me.checkin,onC=c&&['pending','late'].includes(c.status);
 $('checkinInactive').classList.toggle('hidden',!!onC);$('checkinActive').classList.toggle('hidden',!onC);
 if(onC){$('checkinStatus').textContent=c.status==='late'?'Orario scaduto: conferma appena puoi':'Check-in programmato';$('checkinDetail').textContent=`Conferma prevista entro ${v15Time(c.dueAt)}.`;}
 const others=(current.journeys||[]).filter(x=>x.userId!==me.id);
 $('journeyContactsStatus').innerHTML=others.map(x=>`<p class="zyro-v15-contact-status">🚶 ${escapeHtml(x.name)}: ${escapeHtml(x.destination)} · ${x.status==='late'?'In ritardo':x.status==='arrived'?'Arrivo confermato':x.status==='cancelled'?'Percorso annullato':'Arrivo previsto '+v15Time(x.dueAt)}</p>`).join('');
 const checks=(current.checkins||[]).filter(x=>x.userId!==me.id);
 $('checkinContactsStatus').innerHTML=checks.map(x=>`<p class="zyro-v15-contact-status">⌛ ${escapeHtml(x.name)}: ${x.status==='late'?'Check-in scaduto':x.status==='confirmed'?'Confermato':x.status==='cancelled'?'Annullato':'Atteso '+v15Time(x.dueAt)}</p>`).join('');
}
async function v15JourneyStart(){
 const destination=$('journeyDestination').value.trim(),recipients=[...journeySelected];if(!recipients.length)throw Error('Scegli almeno un contatto.');
 const auto=$('journeyAuto').checked;
 if(auto&&!journeyTarget)throw Error('Imposta prima la meta GPS dalla mappa.');
 const result=await post('/api/journey/start',{destination,minutes:Number($('journeyMinutes').value),recipients,destinationPoint:auto?journeyTarget:null});
 await refresh();toast(result.ok?'Accompagnami attivo. I contatti scelti vedono il percorso se hai attivato la posizione.':'Percorso non avviato.');
}
async function v15JourneyEnd(arrived){if(!confirm(arrived?'Confermi di essere arrivato/a?':'Interrompere il percorso?'))return;await post('/api/journey/end',{arrived});journeyTarget=null;$('journeyAuto').checked=false;$('journeyTargetInfo').textContent='Nessuna meta GPS impostata';await refresh();toast(arrived?'Arrivo confermato nel server.':'Percorso terminato.');}
async function v15CheckinStart(){if(!checkinSelected.size)throw Error('Scegli almeno un destinatario.');await post('/api/checkin/start',{minutes:Number($('checkinMinutes').value),recipients:[...checkinSelected]});await refresh();toast('Check-in impostato sul server. Verifica che le notifiche siano abilitate.');}
async function v15CheckinEnd(confirmed){await post('/api/checkin/end',{confirmed});await refresh();toast(confirmed?'Check-in confermato.':'Check-in annullato.');}

// ZYRO V16: one right-side settings drawer for every account. Existing controls
// are MOVED (not cloned), preserving all event handlers and behavior.
let activeSettingsPane=null;
let profileMenuLastFocus=null;
function setupProfileSettings(){
 const host=$('zyroSettingsPanels');
 const permissionPanel=document.createElement('section');
 permissionPanel.className='zyro-permission-panel';
 permissionPanel.innerHTML=`
 <p class="zyro-permission-lead">Scegli quali funzioni autorizzare sul tuo telefono. I permessi non attivano automaticamente la condivisione della posizione o del microfono.</p>
 <div class="zyro-permission-stack">
  <section class="zyro-permission-card" aria-label="Notifiche">
   <div class="zyro-permission-top"><span class="zyro-permission-icon" aria-hidden="true">🔔</span><div class="zyro-permission-head"><h4>Notifiche</h4><p>Messaggi, richieste SOS e avvisi importanti.</p></div></div>
   <p id="zyroNotifState" class="zyro-permission-state" data-state="pending" role="status">Controllo delle notifiche…</p>
   <button type="button" class="zyro-permission-action" data-zyro-permission="notifications">Verifica notifiche</button>
   <button type="button" class="zyro-permission-secondary" data-zyro-permission="reconnect">Riprova collegamento Firebase</button>
   <button type="button" class="zyro-permission-secondary" data-zyro-permission="testpush">🔔 Invia notifica di prova a questo telefono</button>
  </section>
  <section class="zyro-permission-card" aria-label="Posizione GPS">
   <div class="zyro-permission-top"><span class="zyro-permission-icon" aria-hidden="true">📍</span><div class="zyro-permission-head"><h4>Posizione GPS</h4><p>Trova la tua posizione e condividila solo quando decidi tu.</p></div></div>
   <p id="zyroGpsState" class="zyro-permission-state" data-state="pending" role="status">Permesso GPS da verificare.</p>
   <button type="button" class="zyro-permission-action" data-zyro-permission="location">Verifica posizione</button>
  </section>
  <section class="zyro-permission-card" aria-label="Microfono SOS">
   <div class="zyro-permission-top"><span class="zyro-permission-icon" aria-hidden="true">🎙️</span><div class="zyro-permission-head"><h4>Microfono SOS</h4><p>Autorizza il microfono. L’audio si avvia solo durante un SOS, con una tua conferma.</p></div></div>
   <p id="zyroMicState" class="zyro-permission-state" data-state="pending" role="status">Autorizzazione da verificare.</p>
   <button type="button" class="zyro-permission-action" data-zyro-permission="microphone">Verifica microfono</button>
  </section>
  <section class="zyro-permission-card" aria-label="Sensori Pick Pocket">
   <div class="zyro-permission-top"><span class="zyro-permission-icon" aria-hidden="true">🛡️</span><div class="zyro-permission-head"><h4>Sensori Pick Pocket</h4><p>Controlla se il telefono può rilevare movimenti sospetti con l’app aperta.</p></div></div>
   <p id="zyroSensorState" class="zyro-permission-state" data-state="pending" role="status">Autorizza i sensori per attivare la funzione.</p>
   <button type="button" class="zyro-permission-action" data-zyro-permission="sensors">Verifica sensori</button>
  </section>
 </div>
 <p class="zyro-permission-footer">Le autorizzazioni sono gestite da Android. Se hai negato un permesso, puoi riattivarlo dalle impostazioni del telefono. Zyro 360 non sostituisce i servizi di emergenza.</p>`;
 const candidates={
  permissions:permissionPanel,
  appearance:document.querySelector('#settingsView .zyro-appearance-panel'),
  help:$('zyroHelp'), premium:$('premiumPanel'),
  emergency:[...document.querySelectorAll('#settingsView .panel')].find(x=>x.querySelector('h2')?.textContent.trim()==='Numeri di emergenza'),
  notifications:$('pushButton')?.closest('.panel'),
  privacy:[...document.querySelectorAll('#settingsView .panel')].find(x=>x.querySelector('h2')?.textContent.trim()==='La tua privacy'),
  reports:document.querySelector('#settingsView .zyro-report-panel'),
  logout:$('logoutButton')?.closest('.panel')
 };
 const titles={appearance:"Aspetto dell'app",help:'Come funziona ZYRO 360',premium:'Abbonamenti',emergency:'Numeri di emergenza',invitees:'Persone invitate',permissions:'Abilita permessi',notifications:'Notifiche SOS',privacy:'Privacy',reports:'Segnala un utente',logout:'Esci dall’account'};
 for(const [key,title] of Object.entries(titles)){
   const pane=document.createElement('section');pane.className='zyro-settings-pane';pane.dataset.pane=key;pane.hidden=true;
   if(key==='invitees'){
      const info=document.createElement('p');info.className='setting-description';
      info.textContent='Scegli chi vede la tua posizione e chi riceve i tuoi SOS. Solo tu puoi avviare GPS e microfono.';
      pane.append(info);
      const list=document.createElement('div');list.id='savedInvitees';list.className='zyro-saved-invitees';pane.append(list);
   } else if(candidates[key])pane.append(candidates[key]);
   host.append(pane);
 }
 // The personal ID is a central part of the profile, not buried in settings.
 const idCard=$('copyMyId')?.closest('.panel');
 const photoEditor=document.querySelector('#settingsView .profile-photo-editor');
 if(idCard && photoEditor)photoEditor.after(idCard);
 $('profileMore').addEventListener('click',()=>openProfileSettings());
 $('profileSettingsClose').addEventListener('click',closeProfileSettings);
 $('profileSettingsBackdrop').addEventListener('click',closeProfileSettings);
 $('settingsDrawerBack').addEventListener('click',()=>showProfileSettingsMenu());
 document.querySelectorAll('[data-settings-target]').forEach(button=>button.addEventListener('click',()=>showProfileSettingsPane(button.dataset.settingsTarget)));
 document.addEventListener('keydown',e=>{
   if(e.key==='Escape' && $('profileSettingsDrawer').classList.contains('is-open')){e.preventDefault();closeProfileSettings();}
   if(e.key==='Tab' && $('profileSettingsDrawer').classList.contains('is-open')){
      const focusables=[...$('profileSettingsDrawer').querySelectorAll('button:not([disabled]):not(.hidden),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled])')].filter(x=>x.getClientRects().length);
      if(!focusables.length)return;
      const first=focusables[0],last=focusables[focusables.length-1];
      if(e.shiftKey && document.activeElement===first){e.preventDefault();last.focus();}
      else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first.focus();}
   }
 });
}
function openProfileSettings(pane){
 if(!current)return;
 if(activeView!=='settings')showView('settings');
 profileMenuLastFocus=document.activeElement;
 const d=$('profileSettingsDrawer');d.inert=false;d.classList.add('is-open');d.setAttribute('aria-hidden','false');
 $('profileSettingsBackdrop').classList.add('is-open');$('profileMore').setAttribute('aria-expanded','true');
 document.body.classList.add('zyro-settings-open');
 if(pane)showProfileSettingsPane(pane);else showProfileSettingsMenu();
 $('profileSettingsClose').focus();
}
function showProfileSettingsMenu(){
 activeSettingsPane=null;$('zyroSettingsMenu').hidden=false;$('zyroSettingsDetail').hidden=true;
 document.querySelectorAll('.zyro-settings-pane').forEach(x=>x.hidden=true);
}

function permissionState(id,value,state='pending'){
 const node=$(id);if(node){node.textContent=value;node.dataset.state=state;}
}
// WebView's navigator.permissions.query('geolocation') may say "prompt"
// despite Android having granted location. Keep native permission and a
// real GPS fix as separate signals; never overwrite verified success.
let zyroLocationFix=null;
function isNativeZyro(){
 return window.ZyroAndroidPush?.platform==='android';
}
async function refreshPermissionStates(){
 const hasNative=isNativeZyro();
 if(hasNative){
   const granted=window.ZyroAndroidNotificationEnabled===true;
   const status=window.ZyroFCMStatus||{};
   const tokenOk=typeof window.ZyroAndroidPush?.token==='string' && window.ZyroAndroidPush.token.length>60;
   let info=granted?'Android: notifiche abilitate ✓':'Android: notifiche disattivate';
   if(granted){
     if(status.connected)info+=' · Firebase collegato ✓';
     else if(!tokenOk)info+=' · In attesa del token Firebase';
     else if(status.error)info+=' · '+status.error;
     else info+=' · Registrazione Firebase da verificare';
   }
   permissionState('zyroNotifState',info,granted&&status.connected?'on':granted?'pending':'off');
   const b=document.querySelector('[data-zyro-permission="notifications"]');
   if(b)b.textContent=granted?'Notifiche Android attive ✓':'Abilita notifiche';
   const re=document.querySelector('[data-zyro-permission="reconnect"]');
   if(re){re.hidden=!granted || !!status.connected || !!status.registering || !tokenOk;re.disabled=!tokenOk;}
   const test=document.querySelector('[data-zyro-permission="testpush"]');
   if(test){test.hidden=!granted;test.disabled=!granted || !status.connected;}
   const mic=window.ZyroAndroidMicrophoneEnabled;
   permissionState('zyroMicState',mic===true?'Permesso microfono concesso ✓':mic===false?'Permesso microfono non concesso':'Verifica il permesso microfono',mic===true?'on':mic===false?'off':'pending');
 }else{
   const permission=typeof Notification!=='undefined'?Notification.permission:'unsupported';
   permissionState('zyroNotifState',permission==='granted'?'Notifiche browser autorizzate ✓':'Notifiche browser non ancora attive',permission==='granted'?'on':'off');
   permissionState('zyroMicState','Autorizzazione microfono da verificare','pending');
   document.querySelector('[data-zyro-permission="reconnect"]')?.setAttribute('hidden','');
   document.querySelector('[data-zyro-permission="testpush"]')?.setAttribute('hidden','');
 }
 if(hasNative){
   const allowed=window.ZyroAndroidLocationEnabled;
   const precise=window.ZyroAndroidLocationFineEnabled===true;
   const gpsButton=document.querySelector('[data-zyro-permission="location"]');
   if(allowed===true){
     permissionState('zyroGpsState',
       zyroLocationFix
         ? 'GPS autorizzato ✓ · Posizione verificata ✓ (circa '+Math.round(zyroLocationFix.accuracy)+' m).'
         : 'GPS Android autorizzato ✓'+(precise?' · Posizione precisa':' · Posizione approssimativa')+'. Premi per verificare il rilevamento.',
       'on');
     if(gpsButton)gpsButton.textContent='Verifica posizione GPS';
   }else if(allowed===false){
     zyroLocationFix=null;
     permissionState('zyroGpsState','Permesso posizione non concesso. Tocca per autorizzarlo su Android.','off');
     if(gpsButton)gpsButton.textContent='Abilita posizione';
   }else{
     // The updated web app may load inside an older APK before its native
     // permission bridge is installed. Never trap users on "in corso".
     permissionState('zyroGpsState',
       zyroLocationFix
         ?'GPS verificato ✓ · Posizione rilevata e non condivisa automaticamente.'
         :'Tocca «Verifica posizione» per controllare GPS e autorizzazione Android.',
       zyroLocationFix?'on':'pending');
   }
 }else if(navigator.permissions?.query){
   try{
     const location=await navigator.permissions.query({name:'geolocation'});
     const granted=location.state==='granted'||Boolean(zyroLocationFix);
     permissionState('zyroGpsState',granted
       ?zyroLocationFix?'GPS verificato ✓ · Posizione rilevata.':'Posizione autorizzata ✓'
       :location.state==='denied'?'Posizione negata: modifica le autorizzazioni del browser.':'Posizione da autorizzare.',
       granted?'on':location.state==='denied'?'off':'pending');
   }catch{
     permissionState('zyroGpsState',zyroLocationFix?'GPS verificato ✓':'Tocca Verifica posizione per controllare il permesso.',zyroLocationFix?'on':'pending');
   }
 }else{
   permissionState('zyroGpsState',zyroLocationFix?'GPS verificato ✓':'Tocca Verifica posizione per controllare il permesso.',zyroLocationFix?'on':'pending');
 }
}
async function handleZyroPermission(type){
 if(type==='notifications'){
   if(isNativeZyro()){
     window.prompt('ZYRO360_REQUEST_NOTIFICATIONS_NATIVE','');
     await new Promise(resolve=>setTimeout(resolve,400));
     window.dispatchEvent(new Event('zyro:force-fcm-register'));
   }else{
     await enablePush();
   }
 }else if(type==='reconnect'){
   if(!isNativeZyro())return;
   window.dispatchEvent(new Event('zyro:force-fcm-register'));
   toast('Verifica della registrazione Firebase richiesta.');
 }else if(type==='testpush'){
   if(!isNativeZyro())throw Error('Questa prova è disponibile nell’app Android.');
   const result=await post('/api/push/android/test-self',{});
   if(Number(result.accepted||0)>0)
     toast('Test inviato a Firebase. Controlla la notifica e il suono sul telefono.');
   else throw Error('La notifica di prova non è stata accettata. Verifica il collegamento Firebase.');
 }else if(type==='location'){
   if(!navigator.geolocation)throw Error('GPS non disponibile su questo dispositivo.');
   const button=document.querySelector('[data-zyro-permission="location"]');
   if(button){button.disabled=true;button.textContent='Controllo GPS in corso…';}
   try{
     const pos=await new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(
       resolve,reject,{enableHighAccuracy:false,timeout:15000,maximumAge:0}));
     zyroLocationFix={accuracy:Number.isFinite(pos.coords.accuracy)?pos.coords.accuracy:0,at:Date.now()};
     permissionState('zyroGpsState','Posizione rilevata ✓ · non condivisa automaticamente.','on');
   }catch(e){
     zyroLocationFix=null;
     if(e?.code===1)throw Error('Posizione non autorizzata. Abilitala in Android → Impostazioni → App → Zyro 360 → Autorizzazioni → Posizione.');
     if(e?.code===3)throw Error('GPS: tempo scaduto. Attiva la posizione del telefono, prova all’aperto e ripeti.');
     throw Error('Impossibile rilevare la posizione. Controlla il GPS del telefono e riprova.');
   }finally{
     if(button){button.disabled=false;button.textContent='Verifica posizione GPS';}
   }
 }else if(type==='microphone'){
   if(isNativeZyro()){
     const reply=window.prompt('ZYRO360_REQUEST_MIC_PERMISSION_NATIVE','');
     if(reply!=='zyro-native')throw Error('Aggiorna l’APK per gestire il permesso microfono.');
     toast('Controlla la richiesta del microfono mostrata da Android.');
   }else{
     if(!navigator.mediaDevices?.getUserMedia)throw Error('Microfono non supportato dal browser.');
     const stream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
     stream.getTracks().forEach(t=>t.stop());
     permissionState('zyroMicState','Microfono autorizzato ✓ — audio SOS non avviato.','on');
   }
 }else if(type==='sensors'){
   if(typeof DeviceMotionEvent==='undefined'){
     permissionState('zyroSensorState','Sensori movimento non disponibili su questo dispositivo.','off');
     return;
   }
   if(typeof DeviceMotionEvent.requestPermission==='function'){
     const response=await DeviceMotionEvent.requestPermission();
     if(response!=='granted'){
       permissionState('zyroSensorState','Sensori movimento non autorizzati.','off');return;
     }
   }
   permissionState('zyroSensorState','Controllo dei sensori in corso…','pending');
   const sensorButton=document.querySelector('[data-zyro-permission="sensors"]');
   if(sensorButton)sensorButton.disabled=true;
   await new Promise(resolve=>{
     let finished=false;
     const onMotion=e=>{
       if(finished)return;
       if(e.accelerationIncludingGravity || e.acceleration){
         finished=true;
         permissionState('zyroSensorState','Sensori disponibili ✓ — Pick Pocket funziona con l’app aperta.','on');
         window.removeEventListener('devicemotion',onMotion);
         clearTimeout(timer);
         resolve();
       }
     };
     window.addEventListener('devicemotion',onMotion);
     const timer=setTimeout(()=>{
       if(finished)return;
       finished=true;window.removeEventListener('devicemotion',onMotion);
       permissionState('zyroSensorState','Nessun dato ricevuto: muovi delicatamente il telefono e riprova.','off');
       resolve();
     },4500);
   });
   if(sensorButton)sensorButton.disabled=false;
 }
 await refreshPermissionStates();
}

function showProfileSettingsPane(name){
 if(name==='reports' && current?.me?.isAdmin)return;
 const pane=document.querySelector('.zyro-settings-pane[data-pane="'+name+'"]');if(!pane)return;
 activeSettingsPane=name;$('zyroSettingsMenu').hidden=true;$('zyroSettingsDetail').hidden=false;
 document.querySelectorAll('.zyro-settings-pane').forEach(x=>x.hidden=x!==pane);
 const selected=document.querySelector('[data-settings-target="'+name+'"]');
 $('settingsDrawerHeading').textContent=selected?.querySelector('span:nth-child(2)')?.firstChild?.textContent?.trim()||'Impostazioni';
 $('profileSettingsDrawer').scrollTop=0;
 if(name==='permissions'){
    void refreshPermissionStates();
    // Refresh the FCM token on opening this pane only if it is missing.
    window.dispatchEvent(new Event('zyro:request-fcm-status'));
 }
}
function closeProfileSettings(){
 const d=$('profileSettingsDrawer');if(!d?.classList.contains('is-open'))return;
 d.classList.remove('is-open');d.setAttribute('aria-hidden','true');d.inert=true;
 $('profileSettingsBackdrop').classList.remove('is-open');$('profileMore').setAttribute('aria-expanded','false');
 document.body.classList.remove('zyro-settings-open');
 if(profileMenuLastFocus?.isConnected)profileMenuLastFocus.focus();
}
function renderInvitedPeople(){
 const root=$('savedInvitees');if(!root || !current)return;
 const sig=JSON.stringify([current.me.id,current.me.sharing,current.me.sos,current.me.sosAudioConsent,current.me.gpsRecipients,current.me.sosRecipients,(current.circles||[]).map(c=>[c.name,(c.members||[]).map(m=>[m.id,m.name,m.invitedByMe])])]);
 if(root._zyroSig===sig&&root.children.length)return;
 root._zyroSig=sig;
 const byId=new Map();
 for(const circle of current.circles||[]){
   for(const member of circle.members||[]){
     if(member.id===current.me.id)continue;
     if(!byId.has(member.id))byId.set(member.id,{member,circles:new Set()});
     byId.get(member.id).circles.add(circle.name);
   }
 }
 root.replaceChildren();
 // Only place that controls emergency microphone opt-in:
 // Profilo > Persone invitate, alongside per-contact GPS/SOS permissions.
 const micBox=document.createElement('section');
 micBox.className='zyro-sos-mic-choice';
 const micLabel=document.createElement('label');micLabel.className='zyro-access-toggle zyro-sos-mic-toggle';
 const micCopy=document.createElement('span');
 const micTitle=document.createElement('strong');micTitle.textContent='Condividi audio durante SOS';
 const micExplanation=document.createElement('small');
 micExplanation.textContent='Se attivo, premendo SOS il microfono può trasmettere audio in diretta esclusivamente ai destinatari selezionati che toccano «Ascolta». Se la connessione diretta fallisce, l’audio può transitare temporaneamente sul server per arrivare al destinatario: non viene registrato né conservato, ma questo percorso non è crittografato end-to-end. Puoi disattivare questa funzione in qualsiasi momento.';
 micCopy.append(micTitle,micExplanation);
 const micInput=document.createElement('input');micInput.type='checkbox';micInput.id='sosAudioConsent';
 micInput.checked=current.me.sosAudioConsent===true;
 micInput.setAttribute('aria-label','Consenti audio in diretta automatico durante SOS');
 micLabel.append(micCopy,micInput);
 const micHint=document.createElement('p');micHint.className='zyro-sos-mic-note';
 micHint.textContent='Scegli prima di usare SOS. Android richiede il permesso microfono. L’audio può interrompersi con lo schermo spento; lo stato sarà indicato nella Home.';
 const micTest=document.createElement('button');micTest.type='button';micTest.id='zyroTestMic';
 micTest.className='zyro-sos-mic-test';micTest.textContent='Verifica microfono';micTest.disabled=!micInput.checked;
 const micNative=document.createElement('button');micNative.type='button';
 micNative.id='zyroMicNativeCheck';micNative.className='zyro-sos-mic-test';
 micNative.textContent='Diagnostica microfono Android';micNative.disabled=!micInput.checked;
 const micResult=document.createElement('p');micResult.id='zyroMicDiagnosticResult';
 micResult.className='zyro-mic-diagnostic-result';micResult.hidden=true;
 micResult.setAttribute('role','status');micResult.setAttribute('aria-live','polite');
 micBox.append(micLabel,micHint,micTest,micNative,micResult);root.append(micBox);
 if(!byId.size){
   const p=document.createElement('p');p.className='zyro-invitees-empty';
   p.textContent='Nessuna persona collegata. Invita amici e familiari dalla sezione Cerchie.';
   root.append(p);return;
 }
 const gpsInfo=document.createElement('div');gpsInfo.className='zyro-invitees-intro';
 const description=document.createElement('p');
 description.textContent='Condividi la tua posizione soltanto con i contatti che autorizzi.';
 const gpsButton=document.createElement('button');gpsButton.type='button';gpsButton.id='zyroInviteesGpsGlobal';
 gpsButton.className='btn btn-outline btn-wide';
 gpsButton.textContent=current.me.sharing?'Disattiva GPS LIVE':'Attiva GPS LIVE';
 gpsButton.disabled=!!current.me.sos;
 const status=document.createElement('strong');status.className='zyro-access-status';status.textContent=current.me.sharing?'Posizione LIVE attiva':'Posizione LIVE disattivata';
 const hint=document.createElement('small');hint.textContent='Solo i contatti autorizzati qui sotto possono vedere il tuo GPS mentre LIVE è attivo.';
 gpsInfo.append(description,status,gpsButton,hint);root.append(gpsInfo);
 const gpsSet=new Set(current.me.gpsRecipients||[]);
 const sosSet=new Set(current.me.sosRecipients||[]);
 for(const {member,circles} of byId.values()){
   const card=document.createElement('article');card.className='zyro-access-card';
   const top=document.createElement('div');top.className='zyro-access-top';
   const avatar=document.createElement('span');avatar.className='zyro-invitee-avatar';avatar.textContent=initials(member.name);
   const name=document.createElement('div');name.className='zyro-access-name';
   const title=document.createElement('strong');title.textContent=member.name;
   const meta=document.createElement('small');meta.textContent=[...circles].join(' · ');
   name.append(title,meta);
   const flag=document.createElement('span');flag.className='zyro-invitee-flag';
   flag.textContent=member.invitedByMe?'Invitato da te':'Nella cerchia';
   top.append(avatar,name,flag);card.append(top);
   const addToggle=(type,labelText,help,checked)=>{
     const row=document.createElement('label');row.className='zyro-access-toggle';
     const info=document.createElement('span');
     const bold=document.createElement('strong');bold.textContent=labelText;
     const sub=document.createElement('small');sub.textContent=help;
     info.append(bold,sub);
     const input=document.createElement('input');input.type='checkbox';
     input.dataset.accessUser=member.id;input.dataset.accessType=type;
     input.checked=checked;
     input.disabled=!!current.me.sos;
     input.setAttribute('aria-label',labelText+' per '+member.name);
     row.append(info,input);card.append(row);
   };
   addToggle('gps','Può vedere il mio GPS',
       'Solo quando attivo la posizione LIVE.',gpsSet.has(member.id));
   addToggle('sos','Riceve i miei SOS',
       'Notifiche SOS e audio, solo dopo il mio consenso.',sosSet.has(member.id));
   root.append(card);
 }
 if(current.me.sos){
   const n=document.createElement('p');n.className='setting-description';
   n.textContent='Per cambiare i contatti, termina prima il SOS attivo.';
   root.append(n);
 }
}
async function changeContactAccess(target){
 if(!current)return;
 const id=target.dataset.accessUser, kind=target.dataset.accessType;
 const gps=new Set(current.me.gpsRecipients||[]), sos=new Set(current.me.sosRecipients||[]);
 (kind==='gps'?gps:sos)[target.checked?'add':'delete'](id);
 const response=await post('/api/settings/contact-access',{
   userId:id,shareGps:gps.has(id),receiveSos:sos.has(id)
 });
 current.me.gpsRecipients=response.gpsRecipients;
 current.me.sosRecipients=response.sosRecipients;
 sosPending=null;
 await refresh();
 if(kind==='gps'&&target.checked&&!current.me.sharing)
   toast('Contatto autorizzato. Premi «Attiva condivisione GPS» per iniziare a mostrargli la posizione.');
 else toast('Autorizzazioni del contatto salvate.');
}

async function copyAccountId(id){
 if(navigator.clipboard?.writeText){try{await navigator.clipboard.writeText(id);return;}catch{}}
 const control=document.createElement('textarea');control.value=id;control.readOnly=true;control.style.position='fixed';control.style.top='-9999px';document.body.append(control);
 try{control.select();if(!document.execCommand('copy'))throw Error('Copy blocked');}finally{control.remove();}
}

async function init(){
  let storedTheme=null;try{storedTheme=localStorage.getItem(ZYRO_THEME_KEY);}catch{}
  applyZyroTheme(storedTheme||'dark',false);
  for(const button of document.querySelectorAll('[data-theme-choice]'))button.addEventListener('click',()=>applyZyroTheme(button.dataset.themeChoice));
  $('mapRetry')?.addEventListener('click',()=>{stableAttempts=0;removeStableMap();mapHideFailure();ensureStableMap();});
  window.addEventListener('online',()=>{if(current){stableAttempts=0;removeStableMap();renderMap();}});
  const params=new URLSearchParams(location.search);inviteFromLink=params.get('invite');
  if(inviteFromLink && /^[A-Fa-f0-9]{18}$/.test(inviteFromLink)){history.replaceState(null,'',location.pathname);$('inviteInput').value=inviteFromLink.toUpperCase();}else inviteFromLink=null;
  document.querySelectorAll('.auth-tab').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));
  $('authForm').addEventListener('submit',e=>{e.preventDefault();action(async()=>{
    const payload={email:$('email').value.trim(),password:$('password').value};if(authMode==='register')payload.name=$('name').value.trim();
    $('authSubmit').disabled=true;try{await post(authMode==='login'?'/api/login':'/api/register',payload);const data=await api('/api/state');setState(data);connectSocket();closeProfileSettings();if(inviteFromLink){showView('circles');toast('Codice di invito compilato: premi Entra per unirti alla cerchia.');}else{showView('home');toast('Benvenuto in Zyro 360!');}}finally{$('authSubmit').disabled=false;}
  });});
  document.querySelectorAll('.nav-item').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));
  setupProfileSettings();
  const permissionsHost=document.querySelector('.zyro-permission-panel');
  permissionsHost?.addEventListener('click',event=>{
    const type=event.target.closest('button[data-zyro-permission]')?.dataset.zyroPermission;
    if(type)void action(()=>handleZyroPermission(type));
  });
  window.addEventListener('zyro:fcm-status',()=>{void refreshPermissionStates();});
  window.addEventListener('zyro:android-notification-permission',()=>{void refreshPermissionStates();});
  window.addEventListener('zyro:android-microphone-permission',()=>{void refreshPermissionStates();});
  window.addEventListener('zyro:android-ready',()=>{
    if(hasZyroNativeBridge())void readNativeSafetyStatus().catch(()=>{});
  });
  window.addEventListener('zyro:android-safety-state',event=>{
    const status=event.detail||{};
    if(status.pick && !theftTriggered)pickArmed=true;
    else if(!status.pick && isZyroNativeAvailable())pickArmed=false;
    renderPickControls();
    renderNativeDiagnostic();
  });
  window.addEventListener('zyro:android-location-permission',event=>{
    if(event?.detail?.granted===false)zyroLocationFix=null;
    void refreshPermissionStates();
  });
  $('savedInvitees').addEventListener('change',e=>{
    if(e.target.id==='sosAudioConsent'){
      const input=e.target, enabled=input.checked;
      input.disabled=true;
      // Launch the permission check in this tap; never store or send test audio.
      const probe=enabled?testSOSMicrophone().then(()=>null,error=>sosMicErrorMessage(error)):null;
      void action(async()=>{
        try{
          await post('/api/settings/sos-audio',{enabled});
          if(!enabled && localStream)stopAudio();
          sosAudioError='';
          await refresh();
          const issue=probe?await probe:null;
          if(issue)toast('Preferenza salvata, ma il microfono non è pronto: '+issue,true);
          else toast(enabled?'Ascolto SOS automatico consentito. Si attiverà quando premi SOS.':'Ascolto ambientale SOS disattivato.');
        }catch(err){
          if(input.isConnected){input.checked=!enabled;input.disabled=false;}
          throw err;
        }
      });
      return;
    }
    if(!e.target.matches('input[data-access-user]'))return;
    const input=e.target;input.disabled=true;
    void action(async()=>{
      try{await changeContactAccess(input);}
      catch(err){input.checked=!input.checked;throw err;}
      finally{if(input.isConnected)input.disabled=false;}
    });
  });
  $('savedInvitees').addEventListener('click',e=>{
    if(e.target.id!=='zyroTestMic'&&e.target.id!=='zyroMicNativeCheck')return;
    const button=e.target,native=e.target.id==='zyroMicNativeCheck';
    button.disabled=true;
    void action(async()=>{
      const result=$('zyroMicDiagnosticResult');
      if(result){result.hidden=false;result.dataset.status='pending';result.textContent='Test audio in corso…';}
      try{
        const message=native?await testZyroNativeMicrophone()
          :(await testSOSMicrophone(),'✓ Microfono WebView verificato. Nessun audio salvato o trasmesso.');
        if(result){result.hidden=false;result.dataset.status='ok';result.textContent=message;}
        toast(message);
      }catch(err){
        const message='⚠ '+(native?err.message:sosMicErrorMessage(err));
        if(result){result.hidden=false;result.dataset.status='error';result.textContent=message;}
        toast(message,true);
      }finally{if(button.isConnected)button.disabled=false;}
    });
  });
  $('savedInvitees').addEventListener('click',e=>{
    if(e.target.id!=='zyroInviteesGpsGlobal')return;
    void action(async()=>{
      if(current?.me?.sos)throw Error('Termina prima il tuo SOS.');
      const enabled=!current.me.sharing;
      await post('/api/sharing',{enabled});
      await refresh();
      if(isZyroNativeAvailable()){
        try{await nativeBackgroundSync();}
        catch(err){toast('GPS web attivo, ma background non disponibile: '+err.message,true);}
      }
      if(enabled)updateGeo(null,true);
      toast(enabled?'GPS attivo per i contatti autorizzati.':'Condivisione GPS disattivata.');
    });
  });
  $('mapZoomIn').addEventListener('click',()=>{if(stableMap)stableMap.zoomTo(Math.min(18,stableMap.getZoom()+1),{duration:250});});
  $('mapZoomOut').addEventListener('click',()=>{if(stableMap)stableMap.zoomTo(Math.max(2,stableMap.getZoom()-1),{duration:250});});
  $('locateMe').addEventListener('click',()=>action(async()=>{mapTracking=true;ownCentered=false;void orientationPermission();updateGeo(null,true);if(lastCoords){focusStableMap(lastCoords.lat,lastCoords.lon,16);ownCentered=true;renderMap();}else toast('Ricerca posizione in corso. Consenti l’accesso al GPS se richiesto.');}));
  $('pickNotify').addEventListener('change',renderPickControls);
  $('pickRecipientsList').addEventListener('change',e=>{if(!e.target.matches('[data-pickcontact]'))return;const id=e.target.dataset.pickcontact;if(e.target.checked)pickSelected.add(id);else pickSelected.delete(id);});
  $('zyroNativeCheck')?.addEventListener('click',()=>action(async()=>{
    await readNativeSafetyStatus();
    toast('Stato del servizio Android aggiornato.');
  }));
  $('zyroNativeBattery')?.addEventListener('click',()=>action(async()=>await openNativeBatterySettings()));
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible' && isZyroNativeAvailable())
      void readNativeSafetyStatus().catch(e=>console.warn('Android monitor:',e.message));
  });
  $('pickArm').addEventListener('click',()=>action(armPick));
  $('pickTest').addEventListener('click',()=>action(previewSiren));
  $('theftStop').addEventListener('click',()=>action(stopTheft));
  $('createCircleForm').addEventListener('submit',e=>{e.preventDefault();action(async()=>{await post('/api/circles',{name:$('circleName').value});$('circleName').value='';await refresh();toast('Cerchia creata! Ora puoi generare un invito.');});});
  $('joinCircleForm').addEventListener('submit',e=>{e.preventDefault();action(async()=>{await post('/api/invites/join',{code:$('inviteInput').value});$('inviteInput').value='';await refresh();inviteFromLink=null;toast('Ora fai parte della cerchia!');});});
  $('shareToggle').addEventListener('change',async e=>{const enabled=e.target.checked;await action(async()=>{await post('/api/sharing',{enabled});await refresh();if(isZyroNativeAvailable()){try{await nativeBackgroundSync();}catch(err){toast('GPS web attivo, ma background non disponibile: '+err.message,true);}}toast(enabled?'Posizione condivisa con le tue cerchie.':'Condivisione della posizione interrotta.');});if(current)$('shareToggle').checked=!!current.me.sharing;});
  $('journeyRecipients').addEventListener('change',e=>{if(e.target.matches('[data-journey-to]')){e.target.checked?journeySelected.add(e.target.dataset.journeyTo):journeySelected.delete(e.target.dataset.journeyTo);}});
  $('checkinRecipients').addEventListener('change',e=>{if(e.target.matches('[data-checkin-to]')){e.target.checked?checkinSelected.add(e.target.dataset.checkinTo):checkinSelected.delete(e.target.dataset.checkinTo);}});
  $('journeySetTarget').addEventListener('click',()=>{if(!stableMap){toast('Apri prima la Home e carica la mappa.',true);return;}journeyTarget={lat:stableMap.center.lat,lon:stableMap.center.lon};$('journeyAuto').checked=true;$('journeyTargetInfo').textContent=`Meta impostata: ${journeyTarget.lat.toFixed(5)}, ${journeyTarget.lon.toFixed(5)}`;toast('Meta GPS salvata dal centro della mappa.');});
  $('journeyStart').addEventListener('click',()=>action(v15JourneyStart));
  $('journeyArrived').addEventListener('click',()=>action(()=>v15JourneyEnd(true)));
  $('journeyCancel').addEventListener('click',()=>action(()=>v15JourneyEnd(false)));
  $('checkinStart').addEventListener('click',()=>action(v15CheckinStart));
  $('checkinConfirm').addEventListener('click',()=>action(()=>v15CheckinEnd(true)));
  $('checkinCancel').addEventListener('click',()=>action(()=>v15CheckinEnd(false)));
  $('premiumDetails').addEventListener('click',()=>toast('Pagamenti Google Play da integrare nell’app Android: al momento non si può acquistare Premium. Non viene inviato alcun SOS a pagamento.'));
  $('sosButton').addEventListener('click',()=>action(startSOS));
  $('stopSOS').addEventListener('click',()=>action(stopSOS));

  $('sosRecipientList').addEventListener('change',()=>{sosPending=[...$('sosRecipientList').querySelectorAll('[data-sos-to]:checked')].map(x=>x.dataset.sosTo);});
  $('saveSOSRecipients').addEventListener('click',()=>action(async()=>{const recipients=[...$('sosRecipientList').querySelectorAll('[data-sos-to]:checked')].map(x=>x.dataset.sosTo);await post('/api/settings/sos-recipients',{recipients});sosPending=null;await refresh();toast('Destinatari SOS salvati.');}));
  for(const id of ['avatarCamera','avatarGallery'])$(id).addEventListener('change',e=>{const file=e.target.files?.[0];if(file)action(()=>saveAvatar(file));e.target.value='';});
  $('avatarRemove').addEventListener('click',()=>action(async()=>{await post('/api/profile/avatar',{avatar:null});await refresh();toast('Foto profilo rimossa.');}));
  document.querySelectorAll('[data-chat-filter]').forEach(b=>b.addEventListener('click',()=>{chatCategory=b.dataset.chatFilter;document.querySelectorAll('[data-chat-filter]').forEach(t=>{const on=t===b;t.classList.toggle('active',on);t.setAttribute('aria-pressed',String(on));});renderChatRooms();}));
  $('chatSearch').addEventListener('input',e=>{chatSearch=e.target.value.trim();renderChatRooms();});
  $('chatClose').addEventListener('click',closeChat);
  $('chatForm').addEventListener('submit',e=>{e.preventDefault();action(async()=>{const text=$('chatText').value.trim();if(!text&&!chatPhotoData)return;await sendChat(text,chatPhotoData);});});
  $('chatPhoto').addEventListener('change',e=>{const file=e.target.files?.[0];if(file)action(async()=>{chatPhotoData=await imageData(file,520,105000);$('chatPendingPhoto').textContent='📷 '+file.name+' pronta da inviare';});});
  document.querySelectorAll('[data-quick]').forEach(b=>b.addEventListener('click',()=>action(()=>sendChat(b.dataset.quick,null))));
  $('reportSubmit').addEventListener('click',()=>action(submitReport));
  $('adminLoad').addEventListener('click',()=>action(adminLoad));
  $('adminFilter').addEventListener('input',renderAdminUsers);
  $('copyMyId').addEventListener('click',async()=>{if(!current)return;try{await copyAccountId(current.me.id);toast('ID account copiato.');}catch{toast('Copia non disponibile. Seleziona il codice e copialo manualmente.',true);}});
  $('pushButton').addEventListener('click',()=>action(enablePush));
  $('pushTestButton').addEventListener('click',()=>action(sendPushTest));
  $('closeListen').addEventListener('click',stopListening);
  $('logoutButton').addEventListener('click',()=>action(async()=>{if(theftTriggered)throw Error('Prima ferma l’antifurto usando la password del proprietario.');if(current?.me.sos && !confirm('Il tuo SOS è ancora attivo. Vuoi uscire? L’allarme resterà aperto ma GPS e microfono si interromperanno su questo dispositivo.'))return;stopListening();stopAudio();
    if(isZyroNativeAvailable())await nativeBackgroundSync({sharing:false,pick:false});
    pickArmed=false;window.removeEventListener('devicemotion',motionListener);await post('/api/logout');closeProfileSettings();showView('home');if(watchId!==null)navigator.geolocation?.clearWatch(watchId);watchId=null;lastCoords=null;clearHeadingMotion();mapTracking=false;ownCentered=false;removeStableMap();mapHideFailure();current=null;chatRoom=null;sosPending=null;socket?.close();socket=null;clearInterval(refreshTimer);$('appScreen').classList.add('hidden');$('authScreen').classList.remove('hidden');connection(false);$('password').value='';toast('Sei uscito dal tuo account.');}));
  if('serviceWorker'in navigator && location.protocol==='https:')navigator.serviceWorker.register('/sw.js?v=16-profilo').catch(()=>{});
  try{const data=await api('/api/state');setState(data);closeProfileSettings();showView('home');connectSocket();if(inviteFromLink){showView('circles');toast('Invito ricevuto: premi Entra per confermare.');}}
  catch(err){
    if(err.status!==401) toast('Impossibile recuperare il profilo dal server: '+err.message,true);
    // 401 indicates a missing/expired session; a returning user signs in
    // with the same credentials. Never store passwords in localStorage.
  }
  refreshTimer=setInterval(async()=>{if(current){try{await refresh();}catch{/* WebSocket reconnect handles live state */}}},45000);
  window.addEventListener('online',()=>{if(current){connectSocket();refresh().catch(()=>{});}});
  window.addEventListener('pagehide',()=>{ /* Browsers may suspend GPS, sensors and audio: never promise background safety. */ });
}
init();



// V41: swipe on page content, including cards and buttons; inputs/maps keep their gestures.
(() => {
 const order=['home','circles','modes','chats','settings'];
 let g=null, suppressUntil=0;
 function available(){return !$('appScreen').classList.contains('hidden') &&
  !document.body.classList.contains('zyro-settings-open') &&
  !Array.from(document.querySelectorAll('[aria-modal="true"]')).some(el=>
   el.getAttribute('aria-hidden')!=='true' && !el.inert && !el.closest('.hidden,[hidden]') && el.getClientRects().length>0);}
 document.addEventListener('touchstart',e=>{
  g=null;if(e.touches.length!==1 || !available())return;
  const el=e.target instanceof Element?e.target:e.target.parentElement;
  if(!el?.closest('.view,.bottom-nav') || el.closest('input,textarea,select,[contenteditable="true"],audio,video,#liveMap,[role="slider"]'))return;
  const t=e.touches[0];if(t.clientX<24 || t.clientX>innerWidth-24)return;
  for(let n=el;n && !n.matches('.view,.bottom-nav');n=n.parentElement){
   if(n.scrollWidth>n.clientWidth+4 && /auto|scroll/.test(getComputedStyle(n).overflowX))return;
  }
  g={id:t.identifier,x:t.clientX,y:t.clientY,time:performance.now(),view:activeView,axis:null};
 },{passive:true,capture:true});
 document.addEventListener('touchmove',e=>{
  if(!g)return;const t=Array.from(e.touches).find(t=>t.identifier===g.id);
  if(e.touches.length!==1 || !t){g=null;return;}
  const dx=t.clientX-g.x,dy=t.clientY-g.y;
  if(!g.axis && Math.max(Math.abs(dx),Math.abs(dy))>12){
   if(Math.abs(dx)>Math.abs(dy)*1.35)g.axis='x';else{g=null;return;}
  }
  if(g.axis==='x' && e.cancelable)e.preventDefault();
 },{passive:false,capture:true});
 document.addEventListener('touchcancel',()=>{g=null;},{passive:true,capture:true});
 document.addEventListener('touchend',e=>{
  const s=g;g=null;if(!s || e.touches.length || !available() || activeView!==s.view)return;
  const t=Array.from(e.changedTouches).find(t=>t.identifier===s.id);if(!t)return;
  const dx=t.clientX-s.x,dy=t.clientY-s.y;
  if(performance.now()-s.time>1200 || Math.abs(dx)<56 || Math.abs(dx)<Math.abs(dy)*1.35)return;
  const next=order[order.indexOf(activeView)+(dx<0?1:-1)];if(!next)return;
  suppressUntil=performance.now()+400;showView(next);
 },{passive:true,capture:true});
 document.addEventListener('click',e=>{if(performance.now()<suppressUntil){e.preventDefault();e.stopImmediatePropagation();}},true);
})();
