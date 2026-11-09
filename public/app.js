function hasFamilyPlan(){return current?.me?.features?.sosAudio===true;}
function requireFamilyPlan(){if(!hasFamilyPlan()){showView('settings');openProfileSettings('premium');throw Error('Per questa funzione serve l’abbonamento ZYRO 360.');}}
function updateMarkupIfChanged(node,html){
 if(node._zyroMarkup===html)return;
 node._zyroMarkup=html;node.innerHTML=html;
}
'use strict';
function currentDeviceInfo(){
 const d=window.ZyroDeviceInfo;
 return d?.source==='android-app'?d:{source:'browser'};
}
let deviceSyncKey='';
async function syncDeviceInfo(){
 if(!current?.me?.id)return;
 const id=current.me.id,device=currentDeviceInfo(),key=id+JSON.stringify(device);
 if(key===deviceSyncKey)return;deviceSyncKey=key;
 try{await post('/api/settings/device',{device});}catch{if(deviceSyncKey===key)deviceSyncKey='';}
}
function adminDeviceLabel(d){
 if(!d)return 'Non ancora rilevato';
 const phone=[d.manufacturer,d.model].filter(Boolean).join(' ');
 return [phone||'Marca e modello non disponibili',[d.platform,d.osVersion].filter(Boolean).join(' ')].join(' · ');
}
window.addEventListener('zyro:android-ready',()=>{void syncDeviceInfo();});
const $ = id => document.getElementById(id);
let current = null;
let zyroGroupCodeLastCircleId='';
let adminUsersCache = [];
let adminArchivedView=false;
let adminLoaded = false;
let socket = null;
let wsRetry = null;
let wsConnectedAt = 0;
let wsLastMessageAt = 0;
let wsLastProbeAt = 0;
let wsConnectStartedAt = 0;
let wsReconnectAttempts = 0;
let watchId = null;
let lastCoords = null;
let sentAt = 0;
let localStream = null;
let micBusy = false;
let sosAudioError = '';
let activeView = 'home';
// The map Home is intentionally title-free; the wordmark stays in other sections.
document.body.classList.add('zyro-home-no-brand');
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
// Android shortcut requests are short-lived and consumed once after authentication.
let zyroQuickSOSRequestedAt=0;
function zyroQuickSOSStorageKey(){return current?.me?.id?'zyro-quick-sos-optin-v1:'+current.me.id:'';}
function zyroQuickSOSEnabled(){
 const key=zyroQuickSOSStorageKey();
 try{return !!key&&localStorage.getItem(key)==='yes';}catch{return false;}
}
function renderQuickSOSSettings(){
 const toggle=$('zyroQuickSosEnabled'),status=$('zyroQuickSosStatus');
 if(!toggle||!status)return;
 const paid=!!current?.me?.premiumActive, nativeReady=window.ZyroAndroidQuickSOSSupported===true;
 toggle.checked=paid&&nativeReady&&zyroQuickSOSEnabled();toggle.disabled=!current||!paid||!nativeReady;
 status.textContent=!current?'Accedi per configurare SOS rapido.'
   :!nativeReady?'Per questa funzione serve la versione Android aggiornata di ZYRO 360. Questo browser o APK non offre ancora il pulsante ZYRO SOS nelle Impostazioni rapide.'
   :!paid?'Serve il piano unico ZYRO 360 da 2,99 €/mese, verificato da Google Play.'
   :toggle.checked?(current.me.creatorPremium
      ?'Account creatore: SOS rapido gratuito attivo. Aggiungi «ZYRO SOS» dalla tendina Android → Modifica e verifica l’invio con i tuoi contatti.'
      :'Piano ZYRO 360 attivo: aggiungi «ZYRO SOS» dalla tendina Android → Modifica e verifica l’invio con i tuoi contatti.')
   :'Disattivato: attiva questa opzione, poi apri la tendina Android → Modifica e aggiungi «ZYRO SOS». L’account creatore autorizzato non paga il piano.';
}
function runRequestedQuickSOS(){
 const requested=zyroQuickSOSRequestedAt;
 if(!requested||!current?.me?.id)return;
 zyroQuickSOSRequestedAt=0;
 if(Date.now()-requested>45000)return; // Never trigger a stale SOS on a later login.
 if(window.ZyroAndroidQuickSOSSupported!==true)return;
 if(!zyroQuickSOSEnabled()){
   showView('settings');openProfileSettings('quickSos');
   toast('Abilita prima SOS rapido in Profilo → Impostazioni aggiuntive → SOS rapido.',true);return;
 }
 if(!current.me.premiumActive){
   showView('settings');openProfileSettings('premium');
   toast('Serve l’abbonamento ZYRO 360 da 2,99 €/mese per inviare SOS.',true);return;
 }
 if(current.me.sos){showView('home');toast('SOS già attivo.');return;}
 showView('home'); // Immediately expose the SOS status and stop control.
 void action(()=>startSOS({quick:true}));
}
window.ZyroQuickSOSHandlerReady=true;
window.addEventListener('zyro:android-ready',renderQuickSOSSettings);
window.addEventListener('zyro:quick-sos-request',()=>{
 zyroQuickSOSRequestedAt=Date.now();
 runRequestedQuickSOS();
});
const journeySelected=new Set(),checkinSelected=new Set();
let journeyTarget=null;
let journeyAddressResults=[],journeyAddressChoice=null,journeyMapCandidate=null;
let journeyPreviewPositionLocked=false;
let journeyPreviewMapFocused=false;
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
  if(document.hidden || activeView!=='home'){
    headingMotion.target=choice.angle;headingMotion.display=choice.angle;
    headingMotion.source=choice.source;return;
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
  wsConnectStartedAt=Date.now();
  let ws;
  try{ws=new WebSocket(`${proto}://${location.host}/ws`);}
  catch(error){connection(false);wsRetry=setTimeout(connectSocket,5000);return;}
  socket=ws;
  connection(false);
  ws.onopen=()=>{
    if(socket!==ws)return;
    wsConnectedAt=Date.now();
    wsLastMessageAt=wsConnectedAt;
    wsLastProbeAt=0;
    wsReconnectAttempts=0;
    connection(true);
    probeSocketPresence();
    if(current?.me?.isAdmin)scheduleAdminUsersRefresh();
    if(localStream)ws.send(JSON.stringify({type:'audio-ready',ready:true}));
    if(listeningTo)retryListenAfterReconnect();
  };
  ws.onmessage=async(event)=>{
    if(socket!==ws)return;
    wsLastMessageAt=Date.now();
    let m;try{m=JSON.parse(event.data);}catch{return;}
    if(m.type==='presence-pong')return;
    if(m.type==='state'){setState(m.data);if(current?.me?.isAdmin && !adminLoaded)scheduleAdminUsersRefresh();}
    if(m.type==='listen-request') await action(()=>sendOffer(m.from));
    if(m.type==='rtc') await action(()=>handleRTC(m.from,m.signal));
    if(m.type==='audio-relay-start') await action(startAudioRelaySender);
    if(m.type==='audio-relay-stop') stopAudioRelaySender();
    if(m.type==='audio-relay-status') handleAudioRelayStatus(m);
    if(m.type==='audio-relay-data') handleAudioRelayPacket(m);
    if(m.type==='account-banned'){alert(m.notice||'Account sospeso.');location.reload();return;}
    if(m.type==='admin-users-changed' && current?.me?.isAdmin)scheduleAdminUsersRefresh();
    if(m.type==='admin-new-report' && current?.me?.isAdmin){toast('Nuova segnalazione ricevuta nel Centro amministratore.');void action(adminLoad);}
    if(m.type==='chat-new' && chatRoom) { if(m.chatType===chatRoom.type && (chatRoom.type==='circle' ? m.target===chatRoom.id : m.from===chatRoom.id || m.from===current?.me?.id))void loadChat(); }
    if(m.type==='chat-new'){
      window.dispatchEvent(new CustomEvent('zyro:chat-new',{detail:m}));
      if(activeView==='chats'&&!chatRoom)void refreshChatDirectory().catch(()=>{});
    }
    if(m.type==='sos-ended') {if(m.userId===listeningTo)stopListening();if(m.userId===current?.me?.id)stopAudio();}
  };
  ws.onclose=()=>{
    if(socket!==ws)return;
    socket=null;
    connection(false);
    stopAudioRelaySender();
    if(current){
      const delay=Math.min(30000,3000*Math.pow(2,Math.min(wsReconnectAttempts++,3)));
      wsRetry=setTimeout(connectSocket,delay);
    }
  };
  ws.onerror=()=>{if(socket===ws)connection(false);};
}
// WebView may suspend JavaScript while Android is locked or in another app.
// Recheck a stalled connection when the app resumes, without marking it green
// until the WebSocket has genuinely opened and answered.
function probeSocketPresence(){
  if(socket?.readyState!==WebSocket.OPEN)return;
  try{
    socket.send(JSON.stringify({type:'presence-ping'}));
    wsLastProbeAt=Date.now();
  }catch(error){
    try{socket.close();}catch{}
  }
}
function verifySocketPresence(){
  if(!current || document.hidden)return;
  const now=Date.now();
  if(socket?.readyState===WebSocket.CONNECTING){
    if(now-wsConnectStartedAt>18000){
      try{socket.close();}catch{}
    }
    return;
  }
  if(socket?.readyState===WebSocket.OPEN){
    if(now-wsLastMessageAt>65000){
      connection(false);
      try{socket.close();}catch{}
      return;
    }
    if(now-wsLastProbeAt>20000)probeSocketPresence();
    return;
  }
  if(!wsRetry)connectSocket();
}
function wsSend(message){if(socket?.readyState!==WebSocket.OPEN)return false;socket.send(JSON.stringify(message));return true;}
function connection(up){$('connectionText').textContent=up?'Collegato':'Non collegato';$('connectionDot').classList.toggle('connected',up);}
function setState(data){
  if(!data?.me)return;
  const prev = current;
  current=data;
  // Never reuse the authenticated chat directory after a profile switch.
  if(prev?.me?.id!==data.me.id){verifiedChatRooms=null;verifiedChatOwner='';chatDirectorySequence++;}
  if(data.billingReady&&window.ZyroBillingSupported&&prev?.me?.id!==data.me.id)void zyroNativeRequest('billing-sync').catch(()=>{});
  void syncDeviceInfo();
  // Revoking explicit opt-in stops ongoing live audio locally as well.
  if((data.me.sosAudioConsent!==true || data.me.features?.sosAudio!==true) && localStream)stopAudio();
  // A contact who leaves a circle or loses SOS microphone permission cannot
  // keep an existing P2P audio connection alive after the server update.
  if(listeningTo && !data.alerts?.some(a=>a.userId===listeningTo &&
      a.kind==='sos' && a.hasAudio===true))stopListening();
  if(localStream && peers instanceof Map){
    const allowed=new Set(data.me.sosAudioRecipients||[]);
    for(const [id,peer] of peers)if(!allowed.has(id)){
      peer.close();peers.delete(id);pendingIce.delete(id);
    }
  }
  if(window.ZyroAndroidSafetySupported && window.ZyroNativeSafety?.pick===true && !theftTriggered)
    pickArmed=true;
  if($('appScreen').classList.contains('hidden')) { $('authScreen').classList.add('hidden');$('appScreen').classList.remove('hidden'); }
  updateGeo(null, data.me.sharing || !!data.me.sos || mapTracking || pickArmed);
  renderHome();renderCircles();renderProfileInvites();renderSettings();renderQuickSOSSettings();renderPickControls();renderSOSRecipients();renderChatRooms();renderV15();renderAdminAccess();renderReportContacts();renderInvitedPeople();
  if (data.me.alertKind === 'pickpocket' && !theftTriggered) { theftTriggered=true; pickArmed=false; showTheftOverlay('È presente un allarme antifurto. Puoi fermarlo con la password.'); startSiren(); }
  if (data.me.alertKind !== 'pickpocket' && theftTriggered && !theftIsPending) { theftTriggered=false; hideTheftOverlay(); stopSiren(); }

  const key = data.alerts.filter(a=>a.userId!==data.me.id).map(a=>a.id).sort().join(',');
  if(prev && key && key !== lastAlertKey) toast('🆘 Nuovo SOS nella tua cerchia.',true);
  lastAlertKey=key;
  if(zyroQuickSOSRequestedAt)runRequestedQuickSOS();
}
// Admin UI is only an interface. Every admin endpoint separately verifies the owner's server-side user ID.
function renderAdminAccess(){
 const admin=Boolean(current?.me?.isAdmin);
 $('zyroAdminPanel').classList.toggle('hidden',!admin);
 $('myAccountId').textContent=current?.me?.profileId||'';
 const adminMenu=$('reportMenuItem');
 if(adminMenu){adminMenu.classList.remove('hidden');adminMenu.dataset.settingsTarget=admin?'admin':'reports';adminMenu.querySelector('span:nth-child(2)').innerHTML=admin?'Centro amministratore<small>Segnalazioni e utenti registrati</small>':'Segnala un utente<small>Invia una segnalazione privata</small>';}

 $('premiumPanel')?.classList.toggle('zyro-premium-owner',admin);
 if(!admin){adminArchivedView=false;if($('adminArchiveToggle')){$('adminArchiveToggle').textContent='Mostra archiviate';$('adminArchiveToggle').setAttribute('aria-pressed','false');}adminLoaded=false;adminUsersCache=[];$('adminUsers').replaceChildren();$('adminReports').replaceChildren();$('adminAudit').replaceChildren();}
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
 const users=adminUsersCache.filter(u=>Boolean(u.adminArchivedAt)===adminArchivedView).filter(u=>[u.name,u.email,u.id,u.profileId,u.lastLoginIp,u.registrationIp,u.lastDevice?.manufacturer,u.lastDevice?.model].some(v=>String(v||'').toLowerCase().includes(term)));
 $('adminUsers').innerHTML=users.length?users.map(u=>`<article class="zyro-admin-user">
 <div class="zyro-admin-user-title"><b>${escapeHtml(u.name)}</b><span class="zyro-admin-chip ${u.bannedAt?'is-banned':u.premiumGiftLifetime?'is-gift':''}">${u.bannedAt?'Sospeso':u.premiumGiftLifetime?'Accesso a vita':u.premiumActive?'Piano attivo':'Standard'}</span></div>
 <p>${escapeHtml(u.email)}</p><div class="zyro-admin-meta"><small>ID profilo</small><code>${escapeHtml(u.profileId||'Non disponibile')}</code><small>ID interno</small><code>${escapeHtml(u.id)}</code><small>IP alla registrazione</small><code>${escapeHtml(u.registrationIp||'Non disponibile')}</code><small>Registrato il</small><span>${escapeHtml(fmtAdminDate(u.createdAt))}</span><small>Ultimo IP rilevato</small><code>${escapeHtml(u.lastLoginIp||'Non disponibile')}</code><small>Dispositivo alla registrazione</small><span>${escapeHtml(adminDeviceLabel(u.registrationDevice))}</span><small>Ultimo dispositivo</small><span>${escapeHtml(adminDeviceLabel(u.lastDevice))}</span><small>Rilevato il</small><span>${escapeHtml(fmtAdminDate(u.lastDevice?.at))}</span><small>Origine dati</small><span>${u.lastDevice?.source==='android-app'?'App Android · dati del sistema dichiarati dall’app':'Browser · informazioni limitate'}</span><small>Ultimo accesso</small><span>${escapeHtml(fmtAdminDate(u.lastLoginAt))}</span></div>
 ${u.sameIpBannedAccounts?.length?`<p class="zyro-admin-ip-match">IP condiviso con ${u.sameIpBannedAccounts.length} account sospesi. Verifica gli account: una rete condivisa non dimostra la stessa identità.</p><small>ID: ${u.sameIpBannedAccounts.map(escapeHtml).join(', ')}</small>`:''}
 ${u.id===current.me.id?'<small>Account proprietario — non sospendibile.</small>':`<div class="zyro-admin-actions"><button type="button" data-admin-ban="${escapeHtml(u.id)}">${u.bannedAt?'Riattiva account':'Sospendi account'}</button><button type="button" data-admin-gift="${escapeHtml(u.id)}">${u.premiumGiftLifetime?'Revoca accesso gratuito':'Regala accesso a vita'}</button></div>`}
 <button type="button" class="zyro-admin-archive" data-archive-user="${escapeHtml(u.id)}">${adminArchivedView?'Riapri scheda':'Chiudi esaminazione'}</button>
 </article>`).join(''):'<p class="setting-description">Nessun account corrispondente alla ricerca.</p>';
 $('adminUsers').querySelectorAll('[data-archive-user]').forEach(b=>b.addEventListener('click',()=>action(()=>adminArchive('user',b.dataset.archiveUser))));
 $('adminUsers').querySelectorAll('[data-admin-ban]').forEach(b=>b.addEventListener('click',()=>action(()=>adminChangeBan(b.dataset.adminBan))));
 $('adminUsers').querySelectorAll('[data-admin-gift]').forEach(b=>b.addEventListener('click',()=>action(()=>adminChangeGift(b.dataset.adminGift))));
}
function showAdminTab(tab){
 if(!current?.me?.isAdmin)return;
 const reports=tab==='reports';
 $('adminReportsSection').hidden=!reports;$('adminUsersSection').hidden=reports;
 document.querySelectorAll('[data-admin-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.adminTab===tab)));
}
let adminRefreshTimer=null;
function scheduleAdminUsersRefresh(){if(adminRefreshTimer)return;adminRefreshTimer=setTimeout(()=>{adminRefreshTimer=null;if(current?.me?.isAdmin)void action(adminLoad);},350);}
function renderAdminOverview(data){
 const root=$('zyroAdminOverview');if(!root||!current?.me?.isAdmin)return;
 const metrics=[
  ['Account',data.registered],['Collegati',data.connected],['SOS attivi',data.activeSos],
  ['Cerchie',data.circles],['Gruppi chat',data.chatGroups],['Inviti pendenti',data.pendingInvites],
  ['Segnalazioni aperte',data.reportsToReview],['Account sospesi',data.suspended],
  ['Accesso a vita',data.lifetimeGifts]
 ];
 root.innerHTML='<h3>Centro di controllo</h3><div class="zyro-admin-overview-grid">'+
  metrics.map(([label,value])=>'<div class="zyro-admin-stat"><strong>'+escapeHtml(value)+'</strong><small>'+escapeHtml(label)+'</small></div>').join('')+
  '</div><div class="zyro-admin-system"><strong>Stato servizi</strong>'+
  '<p>Database persistente: '+(data.services?.persistentDatabase?'Configurato':'Da verificare')+'</p>'+
  '<p>Notifiche Firebase: '+(data.services?.notifications?'Configurate':'Da verificare')+'</p>'+
  '<p>Verifica acquisti: '+(data.services?.billingVerifier?'Configurata':'Da verificare')+'</p>'+
  '<p>Backend: '+escapeHtml(data.webVersion||'Versione non disponibile')+'</p>'+
  '<small>La diagnostica non garantisce la consegna di SOS o notifiche e non legge chat, posizioni o microfoni privati.</small></div>';
}
async function adminLoad(){
 if(!current?.me?.isAdmin)return;
 $('adminStatus').textContent='Caricamento account e segnalazioni…';
 const expectedAdminId=current.me.id;
 const data=await api('/api/admin/users');
 if(!current?.me?.isAdmin || current.me.id!==expectedAdminId)return;
 adminUsersCache=data.users||[];adminLoaded=true;renderAdminUsers();
 try {
   const summary=await api('/api/admin/overview');
   if(current?.me?.isAdmin&&current.me.id===expectedAdminId)renderAdminOverview(summary);
 }catch(error){if($('zyroAdminOverview'))$('zyroAdminOverview').textContent='Diagnostica non disponibile: '+error.message;}
 const allReports=data.reports||[];
 const reports=allReports.filter(r=>Boolean(r.adminArchivedAt)===adminArchivedView);
 $('adminReportCount').textContent=String(allReports.filter(r=>!r.adminArchivedAt&&r.status==='open').length);
 $('adminUserCount').textContent=String(adminUsersCache.length);
 $('adminReports').innerHTML=reports.length?reports.map(r=>{
  const u=r.user,reporter=r.reporter;
  return `<article class="zyro-admin-report"><div class="zyro-admin-report-top"><b>${escapeHtml(u?.name||'Account non disponibile')}</b><span>${r.status==='open'?'Da esaminare':'Esaminata'}</span></div>
  <dl class="zyro-admin-report-data"><dt>Email</dt><dd>${escapeHtml(u?.email||'Non disponibile')}</dd><dt>ID utente</dt><dd>${escapeHtml(r.userId)}</dd><dt>IP registrazione</dt><dd>${escapeHtml(u?.registrationIp||'Non disponibile')}</dd><dt>Ultimo IP rilevato</dt><dd>${escapeHtml(u?.lastLoginIp||'Non disponibile')}</dd><dt>Ultimo accesso</dt><dd>${escapeHtml(fmtAdminDate(u?.lastLoginAt))}</dd><dt>Dispositivo utente</dt><dd>${escapeHtml(adminDeviceLabel(u?.lastDevice))}</dd><dt>Ricevuta il</dt><dd>${escapeHtml(fmtAdminDate(r.at))}</dd></dl>
  <p class="zyro-admin-report-label">Messaggio della segnalazione</p><blockquote class="zyro-admin-message">${escapeHtml(r.reason)}</blockquote>
  <small>Inviata da ${escapeHtml(reporter?.name||r.reporterId)} · ID ${escapeHtml(r.reporterId)}</small>
  <div class="zyro-admin-actions">${r.status==='open'?`<button type="button" data-admin-review="${escapeHtml(r.id)}">Segna come esaminata</button>`:''}${u && u.id!==current.me.id?`<button type="button" data-report-ban="${escapeHtml(u.id)}">${u.bannedAt?'Riattiva account':'Sospendi account'}</button>`:''}</div><button type="button" class="zyro-admin-archive" data-archive-report="${escapeHtml(r.id)}">${adminArchivedView?'Riapri segnalazione':'Chiudi esaminazione'}</button></article>`;
 }).join(''):'<div class="zyro-admin-empty">Nessuna segnalazione ricevuta.</div>';
 $('adminReports').querySelectorAll('[data-archive-report]').forEach(b=>b.addEventListener('click',()=>action(()=>adminArchive('report',b.dataset.archiveReport))));
 $('adminReports').querySelectorAll('[data-admin-review]').forEach(b=>b.addEventListener('click',()=>action(()=>adminReview(b.dataset.adminReview))));
 $('adminReports').querySelectorAll('[data-report-ban]').forEach(b=>b.addEventListener('click',()=>action(()=>adminChangeBan(b.dataset.reportBan))));
 $('adminAudit').innerHTML=(data.audit||[]).map(a=>`<p><b>${escapeHtml(a.kind)}</b> · ${escapeHtml(a.for||'')} · ${escapeHtml(fmtAdminDate(a.at))}</p>`).join('')||'<p>Nessuna azione registrata.</p>';
 $('adminStatus').textContent=`${adminUsersCache.length} account registrati. Aggiornamento in tempo reale · dati riservati al proprietario.`;
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
 const confirmed=await zyroOwnerDialog({title:enabled?'Regala accesso a vita':'Revoca Premium a vita',description:`${enabled?'Assegnare Premium gratuito a vita a':'Revocare il regalo Premium a'} ${u.name}?`,submitLabel:enabled?'Regala Premium':'Revoca Premium'});
 if(!confirmed)return;
 const password=await zyroOwnerDialog({title:'Conferma amministratore',description:'Inserisci la password del tuo account creatore per autorizzare il cambiamento.',kind:'password',submitLabel:'Conferma'});
 if(!password)return;
 await post('/api/admin/premium-gift',{userId:id,enabled,password});
 await adminLoad();toast(enabled?'Premium a vita concesso.':'Regalo Premium revocato.');
}
async function adminArchive(kind,id){
 if(!current?.me?.isAdmin)return;
 await post('/api/admin/archive',{kind,id,archived:!adminArchivedView});
 await adminLoad();toast(adminArchivedView?'Scheda riaperta nell’elenco principale.':'Esaminazione chiusa. Scheda spostata nelle archiviate.');
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
  $('sosDescription').textContent=pick?'La modalità Pick Pocket è scattata. Puoi interromperla con la password nella schermata antifurto.':sos?(contacts.length?'SOS registrato. I destinatari selezionati possono visualizzare l’allarme; la consegna non è garantita.':'Nessun contatto nella tua cerchia: il SOS non raggiunge nessuno. Chiama il 112 in emergenza.'):'SOS rapido: serve un abbonamento ZYRO 360 attivo. Per un pericolo reale chiama il 112.';
  $('sosButton').disabled=!!me.sos;
  $('sosButton').setAttribute('aria-label',me.sos?'Allarme già attivo':'Invia SOS rapido ai contatti autorizzati');
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
// ID-based invitations keep the approved Zyro 360 card styling; circle
// membership is granted by the server ONLY after the recipient accepts.
function renderCircles(){
 if(!current)return;
 const list=$('circlesList');
 const sig=JSON.stringify([current.me.id,$('profileInviteMode')?.value,(current.circles||[]).map(c=>[c.id,c.name,c.kind,c.mine,c.memberLimit,(c.members||[]).map(m=>[m.id,m.name])])]);
 if(list._zyroSig===sig&&list.children.length)return;
 list._zyroSig=sig;
 const mode=$('profileInviteMode')?.value||'group';
 const isDirect=mode==='direct';
 const eligible=current.circles.filter(c=>c.kind!=='chat'&&c.kind!=='direct'&&
   c.members.length<(c.memberLimit||20));
 const inviteForm=$('sendProfileInviteForm');
 if(inviteForm)inviteForm.classList.toggle('zyro-direct-invite',isDirect);
 const picker=$('profileInviteCircle');
 if(picker){
   const previous=picker.value;
   picker.innerHTML=eligible.length
     ?eligible.map(c=>'<option value="'+escapeHtml(c.id)+'">'+escapeHtml(c.name)+' · '+(c.kind==='direct'?'Singola persona':'Gruppo')+' ('+c.members.length+'/'+(c.memberLimit||(c.kind==='direct'?2:20))+')</option>').join('')
     :'<option value="">Nessuna cerchia disponibile</option>';
   if(eligible.some(c=>c.id===previous))picker.value=previous;
   picker.disabled=isDirect||!eligible.length;
   const submit=$('sendProfileInviteForm')?.querySelector('button[type="submit"]');
   if(submit)submit.disabled=!isDirect&&!eligible.length;
   const hint=$('profileInviteInfo');
   if(hint)hint.textContent=isDirect
     ?'Inserisci l’ID: la cerchia privata tra voi due nasce soltanto se l’altra persona accetta.'
     :eligible.length?'Scegli una cerchia di gruppo. I nuovi membri entrano soltanto dopo aver accettato. GPS e SOS restano autorizzazioni individuali.'
     :'Crea prima una cerchia di gruppo con posti disponibili.';
 }
 list.innerHTML=current.circles.length?current.circles.map(c=>
  '<div class="circle-card" data-circle="'+escapeHtml(c.id)+'"><div class="circle-top"><div><strong>◎ '+escapeHtml(c.name)+'</strong><small>'+
  (c.kind==='direct'?'Cerchia privata':c.kind==='chat'?'Gruppo chat precedente':'Cerchia di gruppo')+' · '+c.members.length+'/'+(c.memberLimit||(c.kind==='direct'?2:20))+' membri · '+(c.mine?'Creata da te':'Cerchia condivisa')+
  '</small></div><span class="status-chip">Privata</span></div><div class="circle-members">'+
  c.members.map(m=>'<span class="member-pill">'+escapeHtml(m.name)+(m.id===current.me.id?' (tu)':'')+'</span>').join('')+
  '</div><div class="circle-actions">'+
  // Every accepted direct relationship has an immediate 1:1 chat; every group circle has the same group chat.
  (c.kind==='direct'
    ?(c.members.some(m=>m.id!==current.me.id)?'<button type="button" data-chatdirect="'+escapeHtml(c.members.find(m=>m.id!==current.me.id).id)+'">💬 Chat privata</button>':'')
    :'<button type="button" data-chatcircle="'+escapeHtml(c.id)+'">💬 Chat di gruppo</button>')+
  (c.kind==='chat'?'':c.members.length >= (c.memberLimit||(c.kind==='direct'?2:20))
      ?'<button type="button" disabled aria-disabled="true">Limite membri raggiunto</button>'
      :'<button type="button" data-profile-invite="'+escapeHtml(c.id)+'">✚ Invita tramite ID</button>')+
  (c.kind==='group'&&c.mine&&c.members.length<20?'<button type="button" class="zyro-circle-code-generate" data-group-code="'+escapeHtml(c.id)+'">🔑 Genera codice cerchia</button>':'')+
  (c.mine?'<button type="button" class="danger" data-delete="'+escapeHtml(c.id)+'">Elimina cerchia</button>':
    '<button type="button" class="danger" data-leave="'+escapeHtml(c.id)+'">Esci dalla cerchia</button>')+
  '</div></div>').join(''):'<div class="empty-state"><div class="empty-symbol">◎</div><strong>Ancora nessuna cerchia</strong>Crea una cerchia e invita persone tramite il loro ID profilo.</div>';
 list.querySelectorAll('[data-profile-invite]').forEach(b=>b.addEventListener('click',()=>{
  const selected=current.circles.find(circle=>circle.id===b.dataset.profileInvite);
  const modePicker=$('profileInviteMode');
  if(modePicker){modePicker.value='group';renderCircles();}
  if(picker)picker.value=b.dataset.profileInvite;
  $('sendProfileInviteForm')?.scrollIntoView({behavior:'smooth',block:'center'});
  $('profileInviteId')?.focus();
 }));
 list.querySelectorAll('[data-group-code]').forEach(b=>b.addEventListener('click',()=>void action(async()=>{
   const circleId=b.dataset.groupCode;
   const circle=current.circles.find(c=>c.id===circleId&&c.kind==='group'&&c.mine);
   if(!circle)throw Error('Questa cerchia non è disponibile.');
   const response=await post('/api/circles/group-code',{circleId});
   zyroGroupCodeLastCircleId=circleId;
   $('zyroGroupCodeIssuedName').textContent='Codice: '+circle.name;
   $('zyroGroupCodeIssuedValue').textContent=response.code;
   $('zyroGroupCodeIssued').hidden=false;
   $('zyroGroupCodeIssued').scrollIntoView({behavior:'smooth',block:'nearest'});
   toast('Codice privato pronto: condividilo con i familiari. Valido 24 ore.');
 })));
 list.querySelectorAll('[data-chatcircle]').forEach(b=>b.addEventListener('click',()=>openChat('circle',b.dataset.chatcircle)));
 list.querySelectorAll('[data-chatdirect]').forEach(b=>b.addEventListener('click',()=>openChat('direct',b.dataset.chatdirect)));
 list.querySelectorAll('[data-leave]').forEach(b=>b.addEventListener('click',()=>action(async()=>{
  if(!confirm('Vuoi davvero uscire da questa cerchia?'))return;
  await post('/api/circles/leave',{circleId:b.dataset.leave});await refresh();toast('Hai lasciato la cerchia.');
 })));
 list.querySelectorAll('[data-delete]').forEach(b=>b.addEventListener('click',()=>action(async()=>{
  if(!confirm('Eliminare definitivamente questa cerchia per tutti i membri?'))return;
  await post('/api/circles/delete',{circleId:b.dataset.delete});await refresh();toast('Cerchia eliminata.');
 })));
}
function renderProfileInvites(){
 if(!current)return;
 const incoming=$('profileIncomingInvites'),outgoing=$('profileOutgoingInvites');
 if(!incoming||!outgoing)return;
 const invites=current.profileInvites||[];
 const pending=invites.filter(x=>x.direction==='received'&&x.status==='pending');
 const sent=invites.filter(x=>x.direction==='sent');
 const sig=JSON.stringify(invites);
 if(incoming._sig===sig && outgoing._sig===sig)return;
 incoming._sig=sig;outgoing._sig=sig;
 incoming.innerHTML='<h3>Richieste ricevute</h3>'+(pending.length?pending.map(x=>
   '<article class="zyro-id-invite-card"><strong>'+escapeHtml(x.peerName)+'</strong>'+
   '<p>Invito '+(x.circleKind==='direct'?'singolo':'di gruppo')+' per «'+escapeHtml(x.circleName)+'». Vuoi accettare?</p>'+ 
   '<div class="zyro-id-invite-actions">'+
   '<button type="button" data-profile-accept="'+escapeHtml(x.id)+'">Accetta</button>'+
   '<button type="button" data-profile-decline="'+escapeHtml(x.id)+'">Rifiuta</button>'+
   '<button type="button" data-profile-block="'+escapeHtml(x.id)+'">Rifiuta e blocca inviti</button>'+
   '</div></article>').join(''):'<p class="setting-description">Nessuna richiesta in attesa.</p>');
 outgoing.innerHTML='<h3>Richieste inviate</h3>'+(sent.length?sent.map(x=>
   '<article class="zyro-id-invite-card"><strong>'+escapeHtml(x.peerName)+'</strong>'+
   '<p>'+(x.circleKind==='direct'?'Singola persona':'Gruppo')+' · '+escapeHtml(x.circleName)+' · '+(x.status==='pending'?'In attesa di risposta':x.status==='declined'?'Invito rifiutato':x.status==='accepted'?'Invito accettato':'Richiesta annullata')+'</p>'+
   (x.status==='pending'?'<button type="button" data-profile-cancel="'+escapeHtml(x.id)+'">Annulla invito</button>':'')+
   '</article>').join(''):'<p class="setting-description">Non hai richieste inviate.</p>');
 for(const type of ['accept','decline','block']){
  incoming.querySelectorAll('[data-profile-'+type+']').forEach(btn=>btn.addEventListener('click',()=>action(async()=>{
   const inviteId=btn.dataset['profile'+type[0].toUpperCase()+type.slice(1)];
   const choice=type==='accept'?'accept':'decline';
   if(type==='block'&&!confirm('Bloccare altre richieste di invito da questo utente?'))return;
   if(type==='accept'&&!confirm('Entrare nella cerchia? GPS, microfono e controllo remoto non vengono autorizzati automaticamente.'))return;
   await post('/api/profile-invites/respond',{inviteId,decision:choice,blockSender:type==='block'});
   await refresh();toast(type==='accept'?'Invito accettato. Chat e cerchia aggiornate.':'Invito rifiutato.');
  })));
 }
 outgoing.querySelectorAll('[data-profile-cancel]').forEach(btn=>btn.addEventListener('click',()=>action(async()=>{
  await post('/api/profile-invites/cancel',{inviteId:btn.dataset.profileCancel});
  await refresh();toast('Richiesta annullata.');
 })));
}
async function copyInvite(value,message){
 if(typeof value!=='string'||!value){toast('Genera un nuovo invito e riprova.',true);return;}
 try{await navigator.clipboard.writeText(value);toast(message);return;}catch{}
 const field=document.createElement('textarea'),previous=document.activeElement;
 field.value=value;field.readOnly=true;field.style.cssText='position:fixed;left:-9999px;top:0;opacity:0';
 document.body.append(field);field.focus();field.select();field.setSelectionRange(0,value.length);
 let copied=false;try{copied=document.execCommand('copy');}catch{}
 field.remove();previous?.focus?.({preventScroll:true});
 toast(copied?message:'Copia non disponibile. Usa Condividi oppure riprova.',!copied);
}
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
// Each chat group is a private circle with its own multi-use invitation code.
// Joining does not opt anyone in to location, SOS, or microphone sharing.
function showChatGroupInviteCode(code){
 if(!/^G[A-F0-9]{18}$/.test(code))throw Error('Codice gruppo non valido.');
 $('chatGroupInviteCode').textContent=code;
 $('chatGroupInviteResult').hidden=false;
}
async function makeChatGroupInvite(){
 if(!chatRoom||chatRoom.type!=='circle')throw Error('Apri prima un gruppo chat.');
 const group=current.circles.find(c=>c.id===chatRoom.id);
 if(!group||!['chat','group'].includes(group.kind)||!group.mine)throw Error('Solo chi ha creato la cerchia può invitare.');
 const response=await post('/api/chat/groups/invite',{groupId:group.id});
 showChatGroupInviteCode(response.code);
 toast('Codice gruppo creato: può essere usato da più persone per 24 ore.');
}
let chatCategory='all';
let chatSearch='';
let verifiedChatRooms=null,verifiedChatOwner='',chatDirectorySequence=0;
// Membership authorization comes from the backend summary; client state is a fallback.
async function refreshChatDirectory(){
  const owner=current?.me?.id;
  if(!owner)return;
  const sequence=++chatDirectorySequence;
  const result=await api('/api/chat/summary');
  if(sequence!==chatDirectorySequence||current?.me?.id!==owner)return;
  if(!Array.isArray(result?.rooms))throw Error('Elenco chat non valido.');
  verifiedChatOwner=owner;
  verifiedChatRooms=result.rooms.filter(room=>
    (room?.type==='direct'||room?.type==='circle')&&
    typeof room.id==='string'&&room.id.length>0
  );
  renderChatRooms();
}
const roomArrow=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;
const roomGroupIcon=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3.5 19v-2.1A4.9 4.9 0 0 1 8.4 12h1.2a4.9 4.9 0 0 1 4.9 4.9V19H3.5Z"/><path d="M16 5a3 3 0 0 1 0 6M18 13c2.1.5 3 1.9 3 4v2h-4"/></svg>`;
const roomChatIcon=`<svg class="zyro-chat-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.4a8.7 8.7 0 0 1-9.2 8.5 9.5 9.5 0 0 1-3.3-.65L3 21l1.8-5.12a8.4 8.4 0 0 1-1.8-4.48A8.8 8.8 0 0 1 12 3a8.7 8.7 0 0 1 9 8.4Z"/><path d="M8 11.8h.01M12 11.8h.01M16 11.8h.01"/></svg>`;
function renderChatRooms(){
  if(!current)return;
  // A direct circle has a 1:1 chat only; group circles and dedicated chat groups share a multi-member room.
  const circles=current.circles||[], contacts=uniqueContacts();
  const confirmed=verifiedChatOwner===current.me.id?(verifiedChatRooms||[]):[];
  const groups=circles.filter(c=>c.kind!=='direct');
  const directUsers=[...contacts];
  const knownGroups=new Set(groups.map(c=>c.id)), knownContacts=new Set(contacts.map(u=>u.id));
  // A stale /api/state response must not hide a room authorized by /api/chat/summary.
  for(const room of confirmed){
    if(room.type==='circle'&&!knownGroups.has(room.id)){
      groups.push({id:room.id,name:room.title||'Cerchia di gruppo',kind:room.kind||'group',
        members:Array(Math.max(1,Math.min(20,Number(room.memberCount)||1))),
        memberLimit:Number(room.memberLimit)||20});
      knownGroups.add(room.id);
    }else if(room.type==='direct'&&!knownContacts.has(room.id)){
      directUsers.push({id:room.id,name:room.title||'Contatto',avatar:null});
      knownContacts.add(room.id);
    }
  }
  const list=$('chatRooms');
  const sig=JSON.stringify([chatCategory,chatSearch,groups.map(c=>[c.id,c.name,c.kind,c.mine,c.members.length]),directUsers.map(u=>[u.id,u.name,u.avatar||''])]);
  if(list._zyroSig===sig&&list.children.length)return;
  list._zyroSig=sig;
  const matching=(name)=>String(name).toLocaleLowerCase('it').includes(chatSearch.toLocaleLowerCase('it'));
  const rooms=[];
  const showCircle=(group)=>group.kind!=='direct'&&(chatCategory==='all'||chatCategory==='group'||chatCategory==='circle');
  if(chatCategory!=='direct')for(const group of groups.filter(group=>showCircle(group)&&matching(group.name)))rooms.push(`<button type="button" class="chat-room" data-typ="circle" data-id="${escapeHtml(group.id)}"><span class="chat-room-icon family-room-icon">${roomGroupIcon}</span><span class="chat-room-text"><b>${escapeHtml(group.name)}</b><small>${group.kind==='chat'?'Chat di gruppo':'Cerchia di gruppo'} · ${group.members.length}/${group.memberLimit||20} partecipanti</small></span><span class="chat-room-chevron">${roomArrow}</span></button>`);
  if(chatCategory==='all'||chatCategory==='direct')for(const u of directUsers.filter(u=>matching(u.name)))rooms.push(`<button type="button" class="chat-room" data-typ="direct" data-id="${escapeHtml(u.id)}"><span class="chat-room-icon person-room-icon">${avatarHTML(u)}</span><span class="chat-room-text"><b>${escapeHtml(u.name)}</b><small>Chat singola · solo voi due</small></span><span class="chat-room-chevron">${roomArrow}</span></button>`);
  const hasAny = groups.length||directUsers.length;
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
  $('chatGroupInviteButton')?.classList.add('hidden');
  if($('chatGroupInviteResult'))$('chatGroupInviteResult').hidden=true;
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
  const fallbackTitle=verifiedChatOwner===current.me.id?verifiedChatRooms?.find(room=>room.type===type&&room.id===id)?.title:'';
  $('chatTitle').textContent=type==='circle' ? circle?.name||fallbackTitle||'Gruppo':user?.name||fallbackTitle||'Amico';
  $('chatSubtitle').textContent=type==='circle'?'Chat di gruppo · accesso riservato':'Chat riservata ai partecipanti';
  // The current group-circle codes are managed exclusively from Cerchie. Keep legacy G-code invitations for existing chat-only groups.
  $('chatGroupInviteButton')?.classList.toggle('hidden',!(type==='circle'&&circle?.kind==='chat'&&circle?.mine));
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
  if(!older)window.dispatchEvent(new Event('zyro:chat-read'));
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
function showView(view){
  const order=['home','circles','modes','chats','settings'];
  if(!order.includes(view))return;
  const previousView=activeView;
  const changed=previousView!==view;
  if(view!=='settings')closeProfileSettings();
  if(view!=='chats'&&chatRoom)closeChat();
  activeView=view;
  document.body.classList.toggle('zyro-home-no-brand',view==='home');
  for(const id of order)$(`${id}View`).classList.toggle('hidden',id!==view);
  document.querySelectorAll('.bottom-nav .nav-item').forEach(button=>button.classList.toggle('active',button.dataset.view===view));
  if(changed)window.scrollTo(0,0);
  sectionAnimation?.cancel();
  sectionAnimation=null;
  if(changed&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
    const panel=$(`${view}View`);
    if(panel?.animate)sectionAnimation=panel.animate(
      [{opacity:.88,transform:`translate3d(${order.indexOf(view)>order.indexOf(previousView)?12:-12}px,0,0)`},
       {opacity:1,transform:'translate3d(0,0,0)'}],
      {duration:105,easing:'cubic-bezier(.22,.75,.25,1)'}
    );
  }
  if(view==='settings'&&current?.me?.isAdmin&&!adminLoaded)void action(adminLoad);
  if(view==='chats'&&!chatRoom&&current){
    // Always rebuild from accepted circle memberships. Android can resume with a
    // previous search, category or cached DOM that hides otherwise valid chats.
    if(changed){
      chatCategory='all';
      chatSearch='';
      if($('chatSearch'))$('chatSearch').value='';
      document.querySelectorAll('[data-chat-filter]').forEach(t=>{
        const on=t.dataset.chatFilter==='all';
        t.classList.toggle('active',on);
        t.setAttribute('aria-pressed',String(on));
      });
    }
    const roomList=$('chatRooms');
    if(roomList)roomList._zyroSig='';
    renderChatRooms();
    // Also recheck server membership when the tab is tapped again, not only
    // after switching tabs. This repairs stale WebView/WS state without logout.
    void refresh().catch(error=>console.warn('Impossibile aggiornare le chat:',error.message)).finally(()=>{
      if(activeView==='chats'&&!chatRoom){
        renderChatRooms();
        void refreshChatDirectory().catch(error=>console.warn('Elenco chat temporaneamente non disponibile:',error.message));
        window.ZyroChatRefreshBadges?.();
      }
    });
  }

  // Preserve the live map; avoid a redundant re-render on repeated Home taps.
  if(view==='home'&&(changed||!stableMap)){
    requestAnimationFrame(()=>{renderMap();stableMap?.resize();});
  }
}
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
 const selectedSensitivity=$('pickSensitivity')?.value;
 const sensitivity=['normal','high','ultra'].includes(selectedSensitivity)?selectedSensitivity:'normal';
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
async function startSOS({quick=false}={}){
 if(!current?.me?.premiumActive){showView('settings');openProfileSettings('premium');toast('SOS non disponibile: occorre un abbonamento ZYRO 360 attivo e almeno un destinatario autorizzato. In emergenza chiama il 112.',true);return;}
 const optedIn=hasFamilyPlan()&&current.me.sosAudioConsent===true;
 sosAudioError='';
 // Quick SOS never automatically captures the microphone from a background shortcut.
 const preparedAudio=optedIn&&!quick?acquireSOSEmergencyAudio():null;
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
 if(!hasFamilyPlan()||localStream||micBusy || !current?.me?.sos || current?.me?.sosAudioConsent!==true){
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
  this.routeLayer=document.createElementNS('http://www.w3.org/2000/svg','svg');
  this.routeLayer.setAttribute('aria-hidden','true');
  this.routeLayer.classList.add('zyro-journey-map-line');
  this.routeLine=document.createElementNS('http://www.w3.org/2000/svg','line');
  this.routeStart=document.createElementNS('http://www.w3.org/2000/svg','circle');
  this.routeEnd=document.createElementNS('http://www.w3.org/2000/svg','circle');
  this.routeStart.setAttribute('r','8');this.routeEnd.setAttribute('r','9');
  this.routeLayer.append(this.routeLine,this.routeStart,this.routeEnd);
  // Dedicated SVG overlay avoids Android WebView visibility/stacking problems
  // caused by moving the old HTML marker between map containers.
  const ns='http://www.w3.org/2000/svg';
  this.previewSvg=document.createElementNS(ns,'svg');
  this.previewSvg.setAttribute('aria-label','Destinazione selezionata');
  this.previewSvg.setAttribute('role','img');
  this.previewSvg.classList.add('zyro-destination-svg-layer');
  Object.assign(this.previewSvg.style,{
   position:'absolute',left:'0',top:'0',width:'100%',height:'100%',
   display:'none',overflow:'visible',pointerEvents:'none',zIndex:'50'
  });
  this.previewGroup=document.createElementNS(ns,'g');
  this.previewGroup.setAttribute('id','journeyDestinationSvgPin');
  const node=(tag,attrs)=>{
   const element=document.createElementNS(ns,tag);
   for(const [key,value] of Object.entries(attrs))element.setAttribute(key,String(value));
   return element;
  };
  this.previewGroup.append(
   node('circle',{cx:0,cy:0,r:27,fill:'#8a57e8','fill-opacity':'.19'}),
   node('circle',{cx:0,cy:0,r:17,fill:'#7850d9',stroke:'#fff','stroke-width':5}),
   node('circle',{cx:0,cy:0,r:8,fill:'#c7a2ff'}),
   node('rect',{x:-57,y:33,width:114,height:29,rx:15,fill:'#faf7ff',stroke:'#bea6ed','stroke-width':1}),
  );
  const caption=node('text',{x:0,y:52,'text-anchor':'middle',fill:'#452882','font-family':'Arial, sans-serif','font-size':13,'font-weight':700});
  caption.textContent='Destinazione';
  this.previewGroup.append(caption);
  this.previewSvg.append(this.previewGroup);
  this.el.replaceChildren(this.layer,this.routeLayer,this.pinLayer,this.previewSvg);
  // Render the confirmation pin in the outer map stacking context on Android.
  // Nested SVG layers can disappear behind WebView-composited map tiles.
  this.previewPin=null;
  const previewHost=this.el.closest('#liveMap');
  if(previewHost){
   const pin=document.createElement('div');
   pin.className='zyro-journey-preview-pin';
   pin.setAttribute('role','img');
   pin.setAttribute('aria-label','Destinazione selezionata');
   const dot=document.createElement('span');
   dot.className='zyro-journey-preview-pin-center';
   dot.setAttribute('aria-hidden','true');
   const label=document.createElement('span');
   label.className='zyro-journey-preview-pin-label';
   label.textContent='Destinazione';
   pin.append(dot,label);
   pin.style.display='none';
   pin.style.zIndex='90';
   previewHost.appendChild(pin);
   this.previewPin=pin;
  }
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
  if(typeof ResizeObserver!=='undefined'){this.sizeObserver=new ResizeObserver(()=>this.resize());this.sizeObserver.observe(this.el);}
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
 resize(){this.viewportWidth=this.el.clientWidth;this.viewportHeight=this.el.clientHeight;this.schedule();}
 schedule(){if(this.removed||this.pending!==null||document.hidden||activeView!=='home')return;this.pending=requestAnimationFrame(()=>{this.pending=null;this.draw();});}
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
  if(img._zyroSize!==size){img._zyroSize=size;img.style.width=`${size}px`;img.style.height=`${size}px`;}
  const transform=`translate3d(${px}px,${py}px,0)`;
  if(img._zyroTransform!==transform){img._zyroTransform=transform;img.style.transform=transform;}
  return px+size>-256&&px<w+256&&py+size>-256&&py<h+256;
 }
 draw(){
  if(this.removed)return;
  const w=this.viewportWidth,h=this.viewportHeight;if(w<20||h<20)return;
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
  this.drawJourneyRoute(w,h,center);
  this.drawPins(w,h,center);
  this.drawPreviewDestination(w,h,center);
 }
 drawJourneyRoute(w,h,center){
  const approved=(current?.journeys||[]).find(j=>j.userId!==current.me.id &&
   j.response==='accepted' && ['active','late'].includes(j.status) &&
   mapValidPoint(j.currentPoint) && mapValidPoint(j.destinationPoint));
  const preview=$('journeyMapOverlay')&&!$('journeyMapOverlay').classList.contains('hidden');
  // During destination editing the dedicated purple center pin takes priority.
  if(preview||!approved){this.routeLayer.style.display='none';return;}
  this.routeLayer.style.display='';
  this.routeLayer.setAttribute('viewBox',`0 0 ${w} ${h}`);
  const project=p=>{
   const pos=toWorld(p.lat,p.lon,this.zoom),world=worldWidth(this.zoom);
   let dx=pos.x-center.x;
   if(dx>world/2)dx-=world;
   if(dx< -world/2)dx+=world;
   return {x:w/2+dx,y:h/2+pos.y-center.y};
  };
  const from=project(approved.currentPoint),to=project(approved.destinationPoint);
  this.routeLine.style.display='';this.routeStart.style.display='';this.routeEnd.style.display='';
  this.routeLine.setAttribute('x1',String(from.x));this.routeLine.setAttribute('y1',String(from.y));
  this.routeLine.setAttribute('x2',String(to.x));this.routeLine.setAttribute('y2',String(to.y));
  this.routeStart.setAttribute('cx',String(from.x));this.routeStart.setAttribute('cy',String(from.y));
  this.routeEnd.setAttribute('cx',String(to.x));this.routeEnd.setAttribute('cy',String(to.y));
 }
 drawPreviewDestination(w,h,center){
  const previewOpen=!$('journeyMapOverlay').classList.contains('hidden');
  if(!previewOpen||!mapValidPoint(journeyMapCandidate)){
   this.previewSvg.style.display='none';
   if(this.previewPin)this.previewPin.style.display='none';
   return;
  }
  let x=w/2,y=h/2;
  // The searched place is a geographic marker, not a screen-space crosshair.
  // Users can pan/zoom without changing the accepted destination.
  if(journeyPreviewPositionLocked){
   const pos=toWorld(journeyMapCandidate.lat,journeyMapCandidate.lon,this.zoom);
   const world=worldWidth(this.zoom);
   let dx=pos.x-center.x;
   if(dx>world/2)dx-=world;
   if(dx< -world/2)dx+=world;
   x+=dx;y+=pos.y-center.y;
  }
  this.previewSvg.setAttribute('viewBox',`0 0 ${w} ${h}`);
  const visible=Number.isFinite(x)&&Number.isFinite(y)&&
   x>=-60&&x<=w+60&&y>=-60&&y<=h+60;
  if(this.previewPin){
   // HTML marker is painted above the whole map, never under Android tiles.
   this.previewPin.style.display=visible?'flex':'none';
   if(visible){
    this.previewPin.style.left=`${Math.round(x)}px`;
    this.previewPin.style.top=`${Math.round(y)}px`;
   }
   this.previewSvg.style.display='none';
  }else{
   // SVG fallback for standalone map instances, tests and older layouts.
   this.previewSvg.style.display=visible?'block':'none';
   if(visible)this.previewGroup.setAttribute('transform',`translate(${Math.round(x)} ${Math.round(y)})`);
  }
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
 remove(){
  this.removed=true;this.previewPin?.remove();this.sizeObserver?.disconnect();if(this.pending!==null)cancelAnimationFrame(this.pending);this.el.removeEventListener('pointerdown',this.onDown);this.el.removeEventListener('pointermove',this.onMove);this.el.removeEventListener('pointerup',this.onUp);this.el.removeEventListener('pointercancel',this.onUp);this.el.removeEventListener('wheel',this.onWheel);this.el.replaceChildren();this.tiles.clear();this.pinNodes.clear();this.pointers.clear();}
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
 // Preview has priority over automatic GPS recentering. Otherwise a delayed
 // GPS update/tile reload can move the map away from the searched address,
 // leaving the geo-anchored violet marker outside the viewport.
 const previewOpen=!$('journeyMapOverlay').classList.contains('hidden');
 if(previewOpen&&mapValidPoint(journeyMapCandidate)){
  if(!journeyPreviewMapFocused){
   focusStableMap(journeyMapCandidate.lat,journeyMapCandidate.lon,16);
   journeyPreviewMapFocused=true;
  }
  return;
 }
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
        ?'Protezione attiva anche in background e a schermo spento. Monitoraggio Android in esecuzione.'
        :'Attivazione non confermata. Controlla le autorizzazioni e le impostazioni batteria.'
      :pickArmed?'Protezione attiva con l’app aperta. Il monitoraggio può interrompersi quando l’app è in background.'
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
  const sensitivity=$('pickSensitivity').value;
  const high=sensitivity==='high'||sensitivity==='ultra';
  const ultra=sensitivity==='ultra';
  const strong=force>(ultra?11:(high?13:18)) &&
   (turn>(ultra?46:(high?60:100)) || force>(ultra?18:(high?20:27)));
  if(!strong)return;
  const now=Date.now();
  const gap=now-lastMotionAt;
  if(gap>1350)motionPeaks=0;
  if(gap>180){motionPeaks++;lastMotionAt=now;}
  if(force>(ultra?23:(high?25:31)) || (motionPeaks>=2 && turn>(ultra?46:(high?60:100))))void triggerTheft();
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
  if(!current?.me?.premiumActive){showView('settings');openProfileSettings('premium');throw Error('Pick Pocket richiede un abbonamento ZYRO 360 attivo.');}
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
  throw Error('Pick Pocket in background richiede l’app Android Zyro 360. Apri l’app installata dalla sua icona, non il sito nel browser.');
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
 $('premiumStatus').textContent=me.creatorPremium?'Il tuo account creatore include tutte le funzioni di ZYRO 360, compreso SOS rapido e navigazione SOS.':me.premiumActive?(me.premiumGiftLifetime?'Accesso gratuito a vita: tutte le funzioni ZYRO 360 attive.':`ZYRO 360 attivo fino al ${v15Time(me.premiumUntil)} · le notifiche richiedono anche i permessi dei destinatari.`):(current.billingReady?'Piano unico ZYRO 360 a 2,99 €/mese, con SOS rapido e navigazione. Verifica prezzo e disponibilità effettivi in Google Play prima dell’acquisto.':'Nessun piano attivo. Ti avviseremo qui quando gli abbonamenti saranno disponibili.');
 $('premiumStatus').classList.toggle('ok',!!me.premiumActive);
 renderBillingActions();
 for(const [container,selected,tag] of [['journeyRecipients',journeySelected,'journey-to'],['checkinRecipients',checkinSelected,'checkin-to']]){
  const root=$(container);const members=uniqueContacts();const signature=members.map(x=>x.id).join(',');
  if(root.dataset.members!==signature){root.dataset.members=signature;root.innerHTML=v15ContactsHtml(selected,tag);}
 }
 const j=me.journey,onJ=!!(j&&['active','late'].includes(j.status));
 const journeyOptions=$('zyroJourneyOptions');
 // While a trip is active, show its two stop actions immediately below the
 // section title. Do not leave them beneath the long destination form.
 journeyOptions.hidden=onJ;
 if(onJ)journeyOptions.open=false;
 $('journeyInactive').classList.toggle('hidden',onJ);
 $('journeyActive').classList.toggle('hidden',!onJ);
 if(onJ){$('journeyStatus').textContent=j.status==='late'?(j.autoSosTriggeredAt?'Orario scaduto · SOS creato':'Orario scaduto · SOS non attivato'):'Percorso attivo';$('journeyDetail').textContent=`Meta: ${j.destination}${j.dueAt?' · Arrivo previsto: '+new Date(j.dueAt).toLocaleString('it-IT',{dateStyle:'short',timeStyle:'short'}):''}${j.autoSosTriggeredAt?' · SOS creato per mancato arrivo'+(j.autoSosPushAccepted>0?' · Notifica accettata dal servizio, recapito non confermato':' · Notifica non confermata'):''}`;}
 const c=me.checkin,onC=c&&['pending','late'].includes(c.status);
 $('checkinInactive').classList.toggle('hidden',!!onC);$('checkinActive').classList.toggle('hidden',!onC);
 if(onC){$('checkinStatus').textContent=c.status==='late'?'Orario scaduto: conferma appena puoi':'Check-in programmato';$('checkinDetail').textContent=`Conferma prevista entro ${v15Time(c.dueAt)}.`;}
 const others=(current.journeys||[]).filter(x=>x.userId!==me.id);
 updateMarkupIfChanged($('journeyContactsStatus'),others.map(x=>{
  const pending=x.response==='pending' && ['active','late'].includes(x.status);
  const accepted=x.response==='accepted' && ['active','late'].includes(x.status);
  const route=accepted&&mapValidPoint(x.currentPoint)&&mapValidPoint(x.destinationPoint);
  const distance=route?Math.round(zyroJourneyMeters(x.currentPoint,x.destinationPoint)):null;
  return `<article class="zyro-journey-request"><strong>🚶 ${escapeHtml(x.name)}: ${escapeHtml(x.destination)}</strong>
   <p>${pending?'Ti chiede di seguire il suo percorso. Accetta o rifiuta prima di vedere la posizione.':x.status==='arrived'?'Arrivo confermato':x.status==='cancelled'?'Percorso terminato':'In viaggio verso la destinazione'}</p>
   ${x.dueAt?`<p>Arrivo previsto: ${v15Time(x.dueAt)}. Se non conferma, il server tenterà un SOS automatico.</p>`:''}
   ${pending?`<div class="zyro-journey-request-actions"><button type="button" data-journey-answer="yes" data-journey-user="${escapeHtml(x.userId)}" data-journey-id="${escapeHtml(x.id)}">Accetta</button><button type="button" data-journey-answer="no" data-journey-user="${escapeHtml(x.userId)}" data-journey-id="${escapeHtml(x.id)}">Rifiuta</button></div>`:''}
   ${accepted?`<p>Accompagnamento accettato${distance!==null?' · Distanza in linea d’aria: '+(distance>=1000?(distance/1000).toFixed(1)+' km':distance+' m'):''}.</p><div class="zyro-journey-request-actions"><button type="button" data-journey-answer="no" data-journey-user="${escapeHtml(x.userId)}" data-journey-id="${escapeHtml(x.id)}">Smetti di seguire</button></div>`:''}
   ${route?`<div class="zyro-journey-request-actions"><button type="button" data-journey-map="${escapeHtml(x.userId)}">Guarda sulla mappa</button><a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(x.destinationPoint.lat+','+x.destinationPoint.lon)}" target="_blank" rel="noopener noreferrer">Apri navigazione stradale</a></div>`:''}
  </article>`;
 }).join(''));
 const checks=(current.checkins||[]).filter(x=>x.userId!==me.id);
 updateMarkupIfChanged($('checkinContactsStatus'),checks.map(x=>`<p class="zyro-v15-contact-status">⌛ ${escapeHtml(x.name)}: ${x.status==='late'?'Check-in scaduto':x.status==='confirmed'?'Confermato':x.status==='cancelled'?'Annullato':'Atteso '+v15Time(x.dueAt)}</p>`).join(''));
}
function zyroJourneyMeters(a,b){
 const r=Math.PI/180,dlat=(b.lat-a.lat)*r,dlon=(b.lon-a.lon)*r;
 const q=Math.sin(dlat/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dlon/2)**2;
 return 12742000*Math.atan2(Math.sqrt(q),Math.sqrt(1-q));
}
async function answerJourney(button){
 const yes=button.dataset.journeyAnswer==='yes';
 await post('/api/journey/respond',{userId:button.dataset.journeyUser,
  journeyId:button.dataset.journeyId,accept:yes});
 await refresh();
 toast(yes?'Richiesta accettata. Puoi seguire la posizione e vedere la mappa.':'Accompagnamento non condiviso. Nessuna posizione del percorso visibile.');
}
async function searchJourneyAddress(){
 const street=$('journeyStreet').value.trim(),city=$('journeyCity').value.trim(),postal=$('journeyPostal').value.trim();
 if(street.length<4||city.length<2)throw Error('Inserisci via, numero civico e città prima della ricerca.');
 let result=null;
 // Android's on-device geocoder is available from the trusted, origin-bound
 // bridge. It avoids requiring a separate hosted geocoding subscription.
 if(typeof hasZyroNativeBridge==='function' && hasZyroNativeBridge() &&
    typeof zyroNativeRequest==='function'){
  try {
   const native=await zyroNativeRequest('journey-geocode',{street,city,postcode:postal});
   if(native?.ok && Array.isArray(native.results) && native.results.length)
    result={items:native.results};
  } catch {}
 }
 if(!result)result=await post('/api/journey/geocode',{street,city,postal});
 journeyAddressResults=(Array.isArray(result.items)?result.items:[]).filter(p=>mapValidPoint(p)).slice(0,5);
 // The first valid address is the default choice; do not force a second tap.
 // The user can still select another result before opening the map.
 journeyAddressChoice=journeyAddressResults[0]||null;
 journeyTarget=null;
 $('journeyTargetInfo').textContent='Nessuna meta GPS impostata';
 $('journeyViewMap').disabled=!journeyAddressChoice;
 const root=$('journeyAddressResults');
 root.hidden=false;
 root.innerHTML=journeyAddressResults.length
  ?'<strong>Indirizzo trovato · scegli il risultato corretto</strong>'+journeyAddressResults.map((item,index)=>`<button type="button" data-journey-address-index="${index}" aria-pressed="${index===0}">${escapeHtml(item.label)}</button>`).join('')
  :'<p>Non è stato trovato nessun indirizzo. Verifica via, città e CAP.</p>';
}
function positionJourneyPreviewDialog(){
 const panel=$('journeyMapOverlay');
 if(!panel||panel.classList.contains('hidden'))return;
 const sosActions=document.querySelector('#homeView .zyro-command-row');
 if(!sosActions)return;
 const top=sosActions.getBoundingClientRect().top;
 if(!Number.isFinite(top)||top<=0)return;
 // Keep this small confirmation directly ABOVE the GPS/SOS button row.
 const bottom=Math.ceil(window.innerHeight-top+12);
 panel.style.setProperty('--zyro-journey-panel-bottom',`${Math.max(110,bottom)}px`);
}
function openJourneyMapPreview(point,locked=true){
 if(!mapValidPoint(point)){toast('Scegli una destinazione valida prima di aprire la mappa.',true);return;}
 journeyMapCandidate={lat:Number(point.lat),lon:Number(point.lon)};
 journeyPreviewPositionLocked=locked;
 journeyPreviewMapFocused=false;
 $('journeyMapHint').textContent=locked?'Il puntino viola resta fisso sull’indirizzo trovato: premi Imposta per confermare.':'Selezione manuale: sposta la mappa e premi Imposta per scegliere il centro.';
 showView('home');
 const overlay=$('journeyMapOverlay');overlay.classList.remove('hidden');overlay.setAttribute('aria-hidden','false');
 // Render the violet destination using a dedicated SVG layer above the tiles,
 // never reparent a CSS-hidden HTML element.
 positionJourneyPreviewDialog();
 requestAnimationFrame(()=>{
  // The Home view becomes measurable on the next frame.
  renderMap();
  stableMap?.drawPreviewDestination(
   stableMap.viewportWidth,stableMap.viewportHeight,
   stableMap&&toWorld(stableMap.center.lat,stableMap.center.lon,stableMap.zoom)
  );
  positionJourneyPreviewDialog();
 });
 $('journeyPreviewCancel').focus();
 stableMap?.schedule();
}
function closeJourneyMapPreview(savePoint){
 const point=journeyPreviewPositionLocked ? journeyMapCandidate : (stableMap?.center||journeyMapCandidate);
 const overlay=$('journeyMapOverlay');overlay.classList.add('hidden');overlay.setAttribute('aria-hidden','true');
 if(stableMap?.previewSvg)stableMap.previewSvg.style.display='none';
 if(stableMap?.previewPin)stableMap.previewPin.style.display='none';
 if(savePoint){
  if(!mapValidPoint(point))throw Error('La mappa non ha un punto valido. Riprova.');
  journeyTarget={lat:Number(point.lat),lon:Number(point.lon)};
  $('journeyTargetInfo').textContent='Meta confermata: '+journeyTarget.lat.toFixed(5)+', '+journeyTarget.lon.toFixed(5);
  if(!$('journeyDestination').value.trim()){
   $('journeyDestination').value=journeyAddressChoice
    ?[$('journeyStreet').value.trim(),$('journeyCity').value.trim()].filter(Boolean).join(', ').slice(0,70)
    :'Destinazione sulla mappa';
  }
  toast('Punto sulla mappa confermato. Ora scegli un contatto e invia la richiesta.');
 }
 journeyMapCandidate=null;
 journeyPreviewPositionLocked=false;
 journeyPreviewMapFocused=false;
 stableMap?.schedule();
 showView('modes');
 $('zyroJourneyOptions').open=true;
 requestAnimationFrame(()=>$('journeyPanel').scrollIntoView({block:'start',behavior:'auto'}));
}
async function v15JourneyStart(){
 requireFamilyPlan();
 const destination=$('journeyDestination').value.trim(),recipients=[...journeySelected];if(!recipients.length)throw Error('Scegli almeno un contatto.');
 const etaInput=$('journeyDueAt');
 const dueAt=etaInput.value?new Date(etaInput.value).getTime():null;
 if(dueAt!==null&&(!Number.isFinite(dueAt)||dueAt<Date.now()+5*60000||dueAt>Date.now()+24*3600000))
  throw Error('Scegli un orario previsto di arrivo tra 5 minuti e 24 ore.');
 if(!journeyTarget)throw Error('Prima cerca un indirizzo, poi premi Guarda sulla mappa e Imposta.');
 const result=await post('/api/journey/start',{destination,recipients,destinationPoint:journeyTarget,...(dueAt===null?{}:{dueAt})});
 await refresh();
 if(result.ok&&current?.me?.journey&&['active','late'].includes(current.me.journey.status)){
  $('journeyActive').scrollIntoView({block:'start',behavior:'smooth'});
 }
 toast(result.ok?'Richiesta Accompagnami inviata. Puoi confermare l’arrivo o annullare il percorso in qualsiasi momento.':'Richiesta non inviata.');
}
async function v15JourneyEnd(arrived){if(!confirm(arrived?'Confermi di essere arrivato a destinazione?':'Vuoi annullare il percorso? I contatti che lo seguono saranno avvisati.'))return;await post('/api/journey/end',{arrived});journeyTarget=null;journeyAddressChoice=null;journeyAddressResults=[];$('journeyAddressResults').hidden=true;$('journeyAddressResults').replaceChildren();$('journeyViewMap').disabled=true;['journeyStreet','journeyCity','journeyPostal'].forEach(id=>$(id).value='');$('journeyDueAt').value='';updateZyroDueTrigger();$('journeyTargetInfo').textContent='Nessuna meta GPS impostata';$('journeyDestination').value='';journeySelected.clear();$('journeyRecipients').querySelectorAll('input').forEach(input=>input.checked=false);await refresh();toast(arrived?'Arrivo confermato nel server.':'Percorso terminato. Per ripartire crea una nuova richiesta.');}
async function v15CheckinStart(){requireFamilyPlan();if(!checkinSelected.size)throw Error('Scegli almeno un destinatario.');await post('/api/checkin/start',{minutes:Number($('checkinMinutes').value),recipients:[...checkinSelected]});await refresh();toast('Check-in impostato sul server. Verifica che le notifiche siano abilitate.');}
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
   <div class="zyro-permission-top"><span class="zyro-permission-icon" aria-hidden="true">🛡️</span><div class="zyro-permission-head"><h4>Sensori Pick Pocket</h4><p>Nell’app Android Pick Pocket rileva movimenti sospetti anche in background e a schermo spento, con il servizio di protezione attivo e i permessi necessari. Controlla che le impostazioni batteria consentano il funzionamento in background.</p></div></div>
   <p id="zyroSensorState" class="zyro-permission-state" data-state="pending" role="status">Autorizza i sensori per attivare la funzione.</p>
   <button type="button" class="zyro-permission-action" data-zyro-permission="sensors">Verifica sensori</button>
  </section>
 </div>
 <p class="zyro-permission-footer">Le autorizzazioni sono gestite da Android. Se hai negato un permesso, puoi riattivarlo dalle impostazioni del telefono. Zyro 360 non sostituisce i servizi di emergenza.</p>`;
 const candidates={
  permissions:permissionPanel,
  quickSos:$('zyroQuickSosSettings'),
  appearance:document.querySelector('#settingsView .zyro-appearance-panel'),
  help:$('zyroHelp'), premium:$('premiumPanel'),
  emergency:[...document.querySelectorAll('#settingsView .panel')].find(x=>x.querySelector('h2')?.textContent.trim()==='Numeri di emergenza'),
  notifications:$('pushButton')?.closest('.panel'),
  privacy:[...document.querySelectorAll('#settingsView .panel')].find(x=>x.querySelector('h2')?.textContent.trim()==='La tua privacy'),
  reports:document.querySelector('#settingsView .zyro-report-panel'),
  admin:$('zyroAdminPanel'),
  deletion:$('deleteAccountPanel'),
  logout:$('logoutButton')?.closest('.panel')
 };
 const titles={appearance:"Aspetto dell'app",quickSos:'SOS rapido',help:'Come funziona ZYRO 360',premium:'Abbonamenti',emergency:'Numeri di emergenza',invitees:'Persone invitate',permissions:'Abilita permessi',notifications:'Notifiche SOS',privacy:'Privacy',reports:'Segnala un utente',admin:'Centro amministratore',deletion:'Elimina account',logout:'Esci dall’account'};
 for(const [key,title] of Object.entries(titles)){
   const pane=document.createElement('section');pane.className='zyro-settings-pane';pane.dataset.pane=key;pane.hidden=true;
   if(key==='invitees'){
      const info=document.createElement('p');info.className='setting-description';
      info.textContent='Da qui puoi decidere chi e cosa vuoi abilitare della tua cerchia.';
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
         permissionState('zyroSensorState',isZyroNativeAvailable()?'Sensori disponibili ✓ — nell’app Android Pick Pocket funziona anche in background e a schermo spento, con la protezione attiva.':'Sensori disponibili ✓ — per Pick Pocket in background e a schermo spento usa l’app Android.','on');
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
 if(name==='admin' && !current?.me?.isAdmin)return;
 if(name==='reports' && current?.me?.isAdmin)name='admin';
 if(name==='admin')void action(adminLoad);
 const pane=document.querySelector('.zyro-settings-pane[data-pane="'+name+'"]');if(!pane)return;
 $('profileSettingsDrawer').dataset.section=name;activeSettingsPane=name;$('zyroSettingsMenu').hidden=true;$('zyroSettingsDetail').hidden=false;
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
let inviteeExpandedId=null;
function renderInvitedPeople(){
 const root=$('savedInvitees');if(!root||!current)return;
 const sig=JSON.stringify([current.me.id,current.me.sharing,current.me.sos,current.me.sosAudioConsent,current.me.premiumPlan,current.me.gpsRecipients,current.me.sosRecipients,current.me.sosAudioRecipients,current.me.pickRemoteRingContacts,current.me.pickRemoteLockContacts,(current.circles||[]).map(c=>[c.name,(c.members||[]).map(m=>[m.id,m.name,m.avatar||'',m.invitedByMe])])]);
 if(root._zyroSig===sig&&root.children.length)return;
 root._zyroSig=sig;
 const byId=new Map();
 for(const circle of current.circles||[])for(const member of circle.members||[]){
   if(member.id===current.me.id)continue;
   if(!byId.has(member.id))byId.set(member.id,{member,circles:new Set()});
   byId.get(member.id).circles.add(circle.name);
 }
 root.replaceChildren();
 // Il consenso generale all'audio SOS è accessibile nelle opzioni del contatto, non in un riquadro separato.
 if(!byId.size){
   const p=document.createElement('p');p.className='zyro-invitees-empty';
   p.textContent='Nessuna persona collegata. Invita amici e familiari dalla sezione Cerchie.';
   root.append(p);return;
 }
 const gpsInfo=document.createElement('div');gpsInfo.className='zyro-invitees-intro';
 const description=document.createElement('p');description.textContent='Condividi la tua posizione soltanto con i contatti che autorizzi.';
 const gpsButton=document.createElement('button');gpsButton.type='button';gpsButton.id='zyroInviteesGpsGlobal';
 gpsButton.className='btn btn-outline btn-wide';gpsButton.textContent=current.me.sharing?'Disattiva GPS LIVE':'Attiva GPS LIVE';
 gpsButton.disabled=!!current.me.sos;
 const status=document.createElement('strong');status.className='zyro-access-status';
 status.textContent=current.me.sharing?'Posizione LIVE attiva':'Posizione LIVE disattivata';
 const hint=document.createElement('small');hint.textContent='I permessi dei contatti non attivano automaticamente il GPS LIVE.';
 gpsInfo.append(description,status,gpsButton,hint);root.append(gpsInfo);
 const sets={gps:new Set(current.me.gpsRecipients||[]),sos:new Set(current.me.sosRecipients||[]),audio:new Set(current.me.sosAudioRecipients||[]),ring:new Set(current.me.pickRemoteRingContacts||[]),lock:new Set(current.me.pickRemoteLockContacts||[])};
 for(const {member,circles} of byId.values()){
   const card=document.createElement('article');card.className='zyro-access-card zyro-access-card-compact';
   const top=document.createElement('div');top.className='zyro-access-top';
   const avatar=document.createElement('span');avatar.className='zyro-invitee-avatar';avatar.innerHTML=avatarHTML(member);
   const name=document.createElement('div');name.className='zyro-access-name';
   const title=document.createElement('strong');title.textContent=member.name;
   const meta=document.createElement('small');meta.textContent=[...circles].join(' · ');
   name.append(title,meta);
   const flag=document.createElement('span');flag.className='zyro-invitee-flag';
   flag.textContent=member.invitedByMe?'Invitato da te':'Nella cerchia';
   top.append(avatar,name,flag);card.append(top);
   const expand=document.createElement('button');expand.type='button';
   expand.className='zyro-invitee-expand';expand.dataset.accessExpand=member.id;
   expand.setAttribute('aria-expanded',String(inviteeExpandedId===member.id));
   expand.textContent=inviteeExpandedId===member.id?'Nascondi opzioni':'Abilita opzioni';
   card.append(expand);
   const options=document.createElement('div');options.className='zyro-invitee-options';
   options.dataset.accessOptions=member.id;options.hidden=inviteeExpandedId!==member.id;
   const family=hasFamilyPlan();
   const available=family?['gps','sos','audio','ring','lock']:['gps','sos'];
   const enabledCount=available.filter(key=>sets[key].has(member.id)).length;
   const allLabel=document.createElement('label');allLabel.className='zyro-access-toggle zyro-access-all';
   const allText=document.createElement('span');
   const allTitle=document.createElement('strong');allTitle.textContent='Abilita tutte le opzioni';
   const allHint=document.createElement('small');
   allHint.textContent='Oppure disattivale tutte. Le opzioni sotto restano modificabili singolarmente.';
   allText.append(allTitle,allHint);
   const all=document.createElement('input');all.type='checkbox';
   all.dataset.accessAll=member.id;all.checked=enabledCount===available.length;
   all.indeterminate=enabledCount>0&&enabledCount<available.length;
   all.disabled=!!current.me.sos&&enabledCount===0;
   all.setAttribute('aria-label','Abilita o disabilita tutte le autorizzazioni per '+member.name);
   allLabel.append(allText,all);options.append(allLabel);
   const addToggle=(type,labelText,help,checked)=>{
     const row=document.createElement('label');row.className='zyro-access-toggle';
     const info=document.createElement('span');
     const bold=document.createElement('strong');bold.textContent=labelText;
     const sub=document.createElement('small');sub.textContent=help;
     info.append(bold,sub);
     const input=document.createElement('input');input.type='checkbox';
     input.dataset.accessUser=member.id;input.dataset.accessType=type;
     input.checked=checked;
     input.disabled=(!!current.me.sos&&!checked)||(type==='audio'&&!family)||
       ((type==='ring'||type==='lock')&&!family);
     input.setAttribute('aria-label',labelText+' per '+member.name);
     row.append(info,input);options.append(row);
   };
   addToggle('gps','Può vedere il mio GPS','Solo quando attivo la posizione LIVE.',sets.gps.has(member.id));
   addToggle('sos','Riceve i miei SOS','Notifiche di emergenza selezionate da te.',sets.sos.has(member.id));
   addToggle('audio','Può ascoltare il mio microfono durante SOS','Piano unico ZYRO 360: consenso valido solo durante un SOS attivo e revocabile.',sets.audio.has(member.id)&&current.me.sosAudioConsent===true);
   addToggle('ring','Può far squillare il mio telefono','Piano unico ZYRO 360: durante un allarme Pick Pocket attivo e con consenso.',sets.ring.has(member.id));
   addToggle('lock','Può bloccare il mio telefono da remoto','Piano unico ZYRO 360: richiede il permesso di amministratore Android.',sets.lock.has(member.id));
   card.append(options);root.append(card);
 }
 if(current.me.sos){const n=document.createElement('p');n.className='setting-description';
   n.textContent='Per modificare le autorizzazioni, termina prima il SOS attivo.';root.append(n);}
}
async function changeAllContactAccess(target){
 if(!current)return;
 const id=target.dataset.accessAll,contact=uniqueContacts().find(c=>c.id===id);
 if(!contact){await refresh();throw Error('Questo contatto non appartiene più alla tua cerchia.');}
 const enabled=target.checked,family=hasFamilyPlan();
 const confirmed=await zyroOwnerDialog({
  title:enabled?'Autorizza tutte le funzioni':'Revoca tutte le autorizzazioni',
  description:enabled
   ?'Stai per autorizzare '+contact.name+' a utilizzare tutte le funzioni del tuo piano (GPS, SOS'+(family?', ascolto audio in diretta solo DURANTE SOS e controllo remoto Pick Pocket':'')+'). Confermando concedi esplicitamente anche il consenso audio; la persona dovrà scegliere Ascolta. Il microfono resta disattivato fuori da SOS e puoi revocare il permesso.'
   :'Vuoi revocare tutte le autorizzazioni di '+contact.name+'? Potrai riabilitarle tutte insieme o singolarmente in qualsiasi momento.',
  submitLabel:enabled?'Conferma autorizzazioni':'Disabilita tutte'
 });
 if(!confirmed){
  target.checked=!enabled;
  $('savedInvitees')._zyroSig=null;
  renderInvitedPeople();
  return;
 }
 const response=await post('/api/settings/contact-access',{
   userId:id,shareGps:enabled,receiveSos:enabled,
   listenSosAudio:enabled&&family,consentSosAudio:enabled&&family,remoteRing:enabled&&family,remoteLock:enabled&&family
 });
 current.me.gpsRecipients=response.gpsRecipients;
 current.me.sosRecipients=response.sosRecipients;
 current.me.sosAudioRecipients=response.sosAudioRecipients;
 current.me.pickRemoteRingContacts=response.pickRemoteRingContacts;
 current.me.pickRemoteLockContacts=response.pickRemoteLockContacts;
 sosPending=null;await refresh();
 toast(enabled?'Autorizzazioni aggiornate. Audio disponibile solo durante SOS.':'Tutte le autorizzazioni del contatto disabilitate.');
}
async function changeContactAccess(target){
 if(!current)return;
 const id=target.dataset.accessUser, kind=target.dataset.accessType;
 if(!uniqueContacts().some(c=>c.id===id)){
   await refresh();throw Error('Questo contatto non appartiene più alla tua cerchia.');
 }
 const gps=new Set(current.me.gpsRecipients||[]);
 const sos=new Set(current.me.sosRecipients||[]);
 const audio=new Set(current.me.sosAudioRecipients||[]);
 const ring=new Set(current.me.pickRemoteRingContacts||[]);
 const lock=new Set(current.me.pickRemoteLockContacts||[]);
 const groups={gps,sos,audio,ring,lock};
 if(!Object.hasOwn(groups,kind))throw Error('Permesso sconosciuto.');
 if(kind==='audio'&&target.checked){
   const contact=uniqueContacts().find(u=>u.id===id);
   const allowed=await zyroOwnerDialog({
     title:'Consenso ascolto microfono SOS',
     description:'Confermi che '+(contact?.name||'questo contatto')+' potrà ascoltare il tuo microfono esclusivamente quando attivi SOS e soltanto dopo aver premuto «Ascolta»? Puoi revocare il permesso in qualsiasi momento.',
     submitLabel:'Autorizza ascolto'
   });
   if(!allowed){target.checked=false;return;}
   sos.add(id);
 }
 groups[kind][target.checked?'add':'delete'](id);
 if(!sos.has(id))audio.delete(id);
 const response=await post('/api/settings/contact-access',{
   userId:id,shareGps:gps.has(id),receiveSos:sos.has(id),
   listenSosAudio:audio.has(id),consentSosAudio:kind==='audio'&&target.checked,remoteRing:ring.has(id),remoteLock:lock.has(id)
 });
 current.me.gpsRecipients=response.gpsRecipients;
 current.me.sosRecipients=response.sosRecipients;
 current.me.sosAudioRecipients=response.sosAudioRecipients;
 current.me.pickRemoteRingContacts=response.pickRemoteRingContacts;
 current.me.pickRemoteLockContacts=response.pickRemoteLockContacts;
 sosPending=null;
 await refresh();
 if(kind==='gps'&&target.checked&&!current.me.sharing)
   toast('Contatto autorizzato. Premi «Attiva GPS LIVE» per condividere la posizione.');
 else toast('Permessi del contatto aggiornati.');
}

async function copyAccountId(id){
 if(navigator.clipboard?.writeText){try{await navigator.clipboard.writeText(id);return;}catch{}}
 const control=document.createElement('textarea');control.value=id;control.readOnly=true;control.style.position='fixed';control.style.top='-9999px';document.body.append(control);
 try{control.select();if(!document.execCommand('copy'))throw Error('Copy blocked');}finally{control.remove();}
}


function zyroDueLocalValue(d){
 const pad=x=>String(x).padStart(2,'0');
 return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());
}
let zyroDueSelectedDay=null,zyroDueVisibleMonth=null,zyroDueReturnFocus=null;
function updateZyroDueTrigger(){
 const input=$('journeyDueAt'),text=$('journeyDueText');
 if(!input||!text)return;
 const date=input.value?new Date(input.value):null;
 text.textContent=date&&Number.isFinite(date.getTime())
   ?date.toLocaleString('it-IT',{weekday:'short',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})
   :'Seleziona data e ora';
}
function renderZyroDueCalendar(){
 if(!zyroDueSelectedDay||!zyroDueVisibleMonth)return;
 const year=zyroDueVisibleMonth.getFullYear(),month=zyroDueVisibleMonth.getMonth();
 const first=new Date(year,month,1),last=new Date(year,month+1,0).getDate();
 const min=new Date(Date.now()+5*60000),max=new Date(Date.now()+24*3600000);
 $('zyroDueMonth').textContent=first.toLocaleDateString('it-IT',{month:'long',year:'numeric'});
 const previous=new Date(year,month-1,1),next=new Date(year,month+1,1);
 $('zyroDuePrev').disabled=previous.getFullYear()*12+previous.getMonth()<min.getFullYear()*12+min.getMonth();
 $('zyroDueNext').disabled=next.getFullYear()*12+next.getMonth()>max.getFullYear()*12+max.getMonth();
 const offset=(first.getDay()+6)%7;
 let html='<span class="zyro-due-day-empty" aria-hidden="true"></span>'.repeat(offset);
 for(let day=1;day<=last;day++){
   const start=new Date(year,month,day),end=new Date(year,month,day,23,59,59,999);
   const available=end>=min && start<=max;
   const selected=day===zyroDueSelectedDay.getDate()&&year===zyroDueSelectedDay.getFullYear()&&month===zyroDueSelectedDay.getMonth();
   const iso=zyroDueLocalValue(start).slice(0,10);
   html+='<button type="button" data-zyro-day="'+iso+'"'+(available?'':' disabled')+
     (selected?' class="selected" aria-pressed="true"':' aria-pressed="false"')+' aria-label="'+
     start.toLocaleDateString('it-IT',{weekday:'long',day:'numeric',month:'long'})+'">'+day+'</button>';
 }
 const grid=$('zyroDueDayGrid');grid.innerHTML=html;
 grid.querySelectorAll('[data-zyro-day]').forEach(b=>b.addEventListener('click',()=>{
   const [y,m,d]=b.dataset.zyroDay.split('-').map(Number);
   zyroDueSelectedDay=new Date(y,m-1,d);
   renderZyroDueCalendar();
 }));
}
function closeZyroDuePicker(){
 const dialog=$('zyroJourneyDueDialog');if(!dialog||dialog.hidden)return;
 dialog.hidden=true;document.body.classList.remove('zyro-due-open');
 zyroDueReturnFocus?.focus?.();zyroDueReturnFocus=null;
}
function openZyroDuePicker(){
 const value=$('journeyDueAt').value;
 const old=value?new Date(value):null;
 const initial=old&&Number.isFinite(old.getTime())?old:new Date(Date.now()+60*60000);
 zyroDueSelectedDay=new Date(initial.getFullYear(),initial.getMonth(),initial.getDate());
 zyroDueVisibleMonth=new Date(initial.getFullYear(),initial.getMonth(),1);
 $('zyroDueHour').value=String(initial.getHours()).padStart(2,'0');
 $('zyroDueMinute').value=String(initial.getMinutes()).padStart(2,'0');
 zyroDueReturnFocus=document.activeElement;
 $('zyroJourneyDueDialog').hidden=false;document.body.classList.add('zyro-due-open');
 renderZyroDueCalendar();$('zyroDueClose').focus();
}
function confirmZyroDuePicker(){
 if(!zyroDueSelectedDay)return;
 const hours=Number($('zyroDueHour').value),minutes=Number($('zyroDueMinute').value);
 if(!Number.isInteger(hours)||hours<0||hours>23||!Number.isInteger(minutes)||minutes<0||minutes>59){
   toast('Inserisci un orario valido tra 00:00 e 23:59.',true);return;
 }
 const date=new Date(zyroDueSelectedDay.getFullYear(),zyroDueSelectedDay.getMonth(),zyroDueSelectedDay.getDate(),hours,minutes);
 if(date.getHours()!==hours||date.getMinutes()!==minutes||date.getTime()<Date.now()+5*60000||date.getTime()>Date.now()+24*3600000){
   toast('Scegli un orario valido tra 5 minuti e 24 ore da adesso.',true);return;
 }
 $('journeyDueAt').value=zyroDueLocalValue(date);
 $('journeyDueAt').dispatchEvent(new Event('change',{bubbles:true}));
 updateZyroDueTrigger();closeZyroDuePicker();
}
function initZyroDuePicker(){
 if(!$('journeyDueOpen')||!$('zyroJourneyDueDialog'))return;
 $('journeyDueOpen').addEventListener('click',openZyroDuePicker);
 for(const id of ['zyroDueClose','zyroDueCancel'])$(id).addEventListener('click',closeZyroDuePicker);
 $('zyroJourneyDueDialog').querySelector('[data-due-close]').addEventListener('click',closeZyroDuePicker);
 $('zyroDueConfirm').addEventListener('click',confirmZyroDuePicker);
 $('zyroDueClear').addEventListener('click',()=>{
   $('journeyDueAt').value='';$('journeyDueAt').dispatchEvent(new Event('change',{bubbles:true}));
   updateZyroDueTrigger();closeZyroDuePicker();
 });
 $('zyroDuePrev').addEventListener('click',()=>{zyroDueVisibleMonth.setMonth(zyroDueVisibleMonth.getMonth()-1);renderZyroDueCalendar();});
 $('zyroDueNext').addEventListener('click',()=>{zyroDueVisibleMonth.setMonth(zyroDueVisibleMonth.getMonth()+1);renderZyroDueCalendar();});
 $('journeyDueAt').addEventListener('change',updateZyroDueTrigger);
 $('zyroJourneyDueDialog').addEventListener('keydown',event=>{
   if(event.key==='Escape'){event.preventDefault();closeZyroDuePicker();return;}
   if(event.key!=='Tab')return;
   const focusable=[...$('zyroJourneyDueDialog').querySelectorAll('button:not([disabled]),input:not([disabled])')];
   if(!focusable.length)return;
   if(event.shiftKey&&document.activeElement===focusable[0]){event.preventDefault();focusable.at(-1).focus();}
   else if(!event.shiftKey&&document.activeElement===focusable.at(-1)){event.preventDefault();focusable[0].focus();}
 });
 updateZyroDueTrigger();
}

async function init(){
  initZyroDuePicker();
  let storedTheme=null;try{storedTheme=localStorage.getItem(ZYRO_THEME_KEY);}catch{}
  applyZyroTheme(storedTheme||'dark',false);
  await zyroWelcomeBeforeStart();
  for(const button of document.querySelectorAll('[data-theme-choice]'))button.addEventListener('click',()=>applyZyroTheme(button.dataset.themeChoice));
  $('mapRetry')?.addEventListener('click',()=>{stableAttempts=0;removeStableMap();mapHideFailure();ensureStableMap();});
  window.addEventListener('online',()=>{if(current){stableAttempts=0;removeStableMap();renderMap();}});
  const params=new URLSearchParams(location.search);inviteFromLink=params.get('invite');
  inviteFromLink=null;
  document.querySelectorAll('.auth-tab').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));
  $('authForm').addEventListener('submit',e=>{e.preventDefault();action(async()=>{
    const payload={email:$('email').value.trim(),password:$('password').value,device:currentDeviceInfo()};if(authMode==='register')payload.name=$('name').value.trim();
    $('authSubmit').disabled=true;try{await post(authMode==='login'?'/api/login':'/api/register',payload);const data=await api('/api/state');setState(data);connectSocket();closeProfileSettings();showView('home');toast('Benvenuto in Zyro 360!');}finally{$('authSubmit').disabled=false;}
  });});
  document.querySelectorAll('.nav-item').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));
  setupProfileSettings();
  $('zyroOpenSubscriptionPlans')?.addEventListener('click',()=>openProfileSettings('premium'));
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
    if(e.target.matches('input[data-sos-audio-consent]')){
      const input=e.target, enabled=input.checked;
      if(enabled&&!hasFamilyPlan()){input.checked=false;toast('L’audio SOS richiede un abbonamento ZYRO 360 attivo.',true);return;}
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
    if(e.target.matches('input[data-access-all]')){
      const input=e.target;input.disabled=true;
      void action(async()=>{try{await changeAllContactAccess(input);}catch(err){input.checked=!input.checked;throw err;}
        finally{if(input.isConnected)input.disabled=false;}});
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
    const expand=e.target.closest('button[data-access-expand]');
    if(expand){
      inviteeExpandedId=inviteeExpandedId===expand.dataset.accessExpand?null:expand.dataset.accessExpand;
      $('savedInvitees').querySelectorAll('[data-access-options]').forEach(node=>{
        node.hidden=node.dataset.accessOptions!==inviteeExpandedId;
      });
      $('savedInvitees').querySelectorAll('button[data-access-expand]').forEach(button=>{
        const open=button.dataset.accessExpand===inviteeExpandedId;
        button.textContent=open?'Nascondi opzioni':'Abilita opzioni';
        button.setAttribute('aria-expanded',String(open));
      });
      return;
    }
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
    if(document.visibilityState==='visible'){
      verifySocketPresence();
      if(isZyroNativeAvailable())
        void readNativeSafetyStatus().catch(e=>console.warn('Android monitor:',e.message));
    }
  });
  window.addEventListener('focus',verifySocketPresence);
  // Quick actions jump to the correct settings without resetting or toggling protections.
  $('modesView').addEventListener('click',event=>{
    const button=event.target.closest('button[data-mode-target]');
    if(!button||!$('modesView').contains(button))return;
    const allowed={sosRecipientsPanel:'zyroSosOptions',pickPanel:null,journeyPanel:'zyroJourneyOptions',checkinPanel:'zyroCheckinOptions'};
    const targetName=button.dataset.modeTarget;
    if(!Object.hasOwn(allowed,targetName))return;
    const target=$(targetName);
    if(!target)return;
    const panelId=allowed[targetName];
    // The SOS contacts and inactive journey/check-in settings open directly.
    if(panelId){
      const details=$(panelId);
      const active=targetName==='journeyPanel'?!$('journeyActive').classList.contains('hidden')
        :targetName==='checkinPanel'?!$('checkinActive').classList.contains('hidden'):false;
      if(details&&!active)details.open=true;
    }
    target.scrollIntoView({behavior:'auto',block:'start'});
  });
  $('pickArm').addEventListener('click',()=>action(armPick));
  $('pickTest').addEventListener('click',()=>action(previewSiren));
  $('theftStop').addEventListener('click',()=>action(stopTheft));
  $('createCircleForm').addEventListener('submit',e=>{e.preventDefault();action(async()=>{const kind=$('circleType').value;await post('/api/circles',{name:$('circleName').value,kind});$('circleName').value='';if($('profileInviteMode'))$('profileInviteMode').value=kind;await refresh();toast(kind==='direct'?'Cerchia singola creata. Ora invita il tuo contatto tramite ID.':'Cerchia di gruppo creata. Puoi invitare fino a 19 persone.');});});
  $('profileInviteMode')?.addEventListener('change',renderCircles);
  $('zyroGroupCodeJoinForm').addEventListener('submit',e=>{e.preventDefault();void action(async()=>{
    const code=$('zyroGroupCodeInput').value.trim();
    if(!/^C[A-F0-9]{18}$/i.test(code.replace(/[\s-]/g,'')))throw Error('Inserisci il codice completo della cerchia, che inizia per C.');
    const result=await post('/api/circles/group-code/join',{code});
    $('zyroGroupCodeInput').value='';
    await refresh();
    showView('circles');
    toast('Sei entrato nella cerchia «'+result.circleName+'». GPS e autorizzazioni restano sotto il tuo controllo.');
  });});
  $('zyroGroupCodeCopy').addEventListener('click',()=>void action(async()=>{
    await copyInvite($('zyroGroupCodeIssuedValue').textContent,'Codice della cerchia copiato.');
  }));
  $('zyroGroupCodeShare').addEventListener('click',()=>void action(async()=>{
    const code=$('zyroGroupCodeIssuedValue').textContent;
    if(!code)throw Error('Prima genera un codice valido.');
    const circleName=$('zyroGroupCodeIssuedName').textContent.replace(/^Codice: /,'');
    const message='Entra nella mia cerchia '+circleName+' su ZYRO 360 con questo codice: '+code+' (valido 24 ore). La posizione non è condivisa automaticamente.';
    if(navigator.share){try{await navigator.share({title:'Invito cerchia ZYRO 360',text:message});return;}catch(err){if(err?.name==='AbortError')return;}}
    await copyInvite(message,'Invito della cerchia copiato.');
  }));
  $('zyroGroupCodeRevoke').addEventListener('click',()=>void action(async()=>{
    if(!zyroGroupCodeLastCircleId)throw Error('Nessun codice da revocare.');
    await post('/api/circles/group-code/revoke',{circleId:zyroGroupCodeLastCircleId});
    zyroGroupCodeLastCircleId='';
    $('zyroGroupCodeIssuedValue').textContent='';
    $('zyroGroupCodeIssued').hidden=true;
    toast('Codice revocato. Nessun altro potrà usarlo.');
  }));

  $('sendProfileInviteForm').addEventListener('submit',e=>{e.preventDefault();void action(async()=>{
  const profileId=$('profileInviteId').value.trim().toUpperCase();
  const mode=$('profileInviteMode').value;
  const circleId=mode==='group' ? $('profileInviteCircle').value : '';
  if(mode==='group'&&!circleId)throw Error('Scegli una cerchia di gruppo.');
  if(!/^[A-Z0-9]{2,20}-[A-F0-9]{16}$/.test(profileId))throw Error('Inserisci l’ID completo che inizia con il nome registrato, seguito da 16 caratteri.');
  const sent=await post('/api/profile-invites',mode==='direct'?{profileId,mode:'direct'}:{profileId,circleId,mode:'group'});
  $('profileInviteId').value='';await refresh();
  toast('Invito inviato a '+sent.recipientName+'. '+(mode==='direct'?'La cerchia privata nascerà dopo l’accettazione.':'Potrà entrare nel gruppo dopo aver accettato.'));
 });});
  $('shareToggle').addEventListener('change',async e=>{const enabled=e.target.checked;await action(async()=>{await post('/api/sharing',{enabled});await refresh();if(isZyroNativeAvailable()){try{await nativeBackgroundSync();}catch(err){toast('GPS web attivo, ma background non disponibile: '+err.message,true);}}toast(enabled?'Posizione condivisa con le tue cerchie.':'Condivisione della posizione interrotta.');});if(current)$('shareToggle').checked=!!current.me.sharing;});
  $('journeyRecipients').addEventListener('change',e=>{if(e.target.matches('[data-journey-to]')){e.target.checked?journeySelected.add(e.target.dataset.journeyTo):journeySelected.delete(e.target.dataset.journeyTo);}});
  $('checkinRecipients').addEventListener('change',e=>{if(e.target.matches('[data-checkin-to]')){e.target.checked?checkinSelected.add(e.target.dataset.checkinTo):checkinSelected.delete(e.target.dataset.checkinTo);}});
  // Editing the address invalidates any previously selected map point.
  for(const id of ['journeyStreet','journeyCity','journeyPostal']){
   $(id).addEventListener('input',()=>{
    journeyAddressChoice=null;journeyAddressResults=[];journeyTarget=null;
    $('journeyViewMap').disabled=true;
    $('journeyAddressResults').hidden=true;
    $('journeyAddressResults').replaceChildren();
    $('journeyTargetInfo').textContent='Nessuna meta GPS impostata';
   });
  }
  $('journeyFindAddress').addEventListener('click',()=>void action(searchJourneyAddress));
  $('journeyAddressResults').addEventListener('click',e=>{
   const item=e.target.closest('[data-journey-address-index]');if(!item)return;
   const index=Number(item.dataset.journeyAddressIndex);
   journeyAddressChoice=journeyAddressResults[index]||null;
   $('journeyViewMap').disabled=!journeyAddressChoice;
   $('journeyAddressResults').querySelectorAll('[data-journey-address-index]').forEach(button=>button.setAttribute('aria-pressed',String(button===item)));
  });
  $('journeyViewMap').addEventListener('click',()=>{if(journeyAddressChoice)openJourneyMapPreview(journeyAddressChoice,true);});
  $('journeySetTarget').addEventListener('click',()=>openJourneyMapPreview(journeyTarget||lastCoords||DEFAULT_CENTER,false));
  window.addEventListener('resize',positionJourneyPreviewDialog,{passive:true});
  $('journeyPreviewCancel').addEventListener('click',()=>closeJourneyMapPreview(false));
  $('journeyPreviewSet').addEventListener('click',()=>action(()=>closeJourneyMapPreview(true)));
  $('journeyContactsStatus').addEventListener('click',e=>{
   const reply=e.target.closest('[data-journey-answer]');
   if(reply){reply.disabled=true;void action(async()=>{try{await answerJourney(reply);}finally{reply.disabled=false;}});return;}
   const map=e.target.closest('[data-journey-map]');
   if(map){
    const j=(current?.journeys||[]).find(x=>x.userId===map.dataset.journeyMap&&x.response==='accepted');
    if(j&&mapValidPoint(j.currentPoint)){showView('home');requestAnimationFrame(()=>focusStableMap(j.currentPoint.lat,j.currentPoint.lon,14));}
   }
  });
  $('journeyStart').addEventListener('click',()=>action(v15JourneyStart));
  $('journeyArrived').addEventListener('click',()=>action(()=>v15JourneyEnd(true)));
  $('journeyCancel').addEventListener('click',()=>action(()=>v15JourneyEnd(false)));
  $('checkinStart').addEventListener('click',()=>action(v15CheckinStart));
  $('checkinConfirm').addEventListener('click',()=>action(()=>v15CheckinEnd(true)));
  $('checkinCancel').addEventListener('click',()=>action(()=>v15CheckinEnd(false)));
  $('premiumDetails').addEventListener('click',()=>{const panel=$('zyroPlanHelp'),button=$('premiumDetails');panel.hidden=!panel.hidden;button.setAttribute('aria-expanded',String(!panel.hidden));button.querySelector('span').textContent=panel.hidden?'＋':'−';});
  $('zyroQuickSosEnabled')?.addEventListener('change',event=>{
    const toggle=event.currentTarget,key=zyroQuickSOSStorageKey();
    if(!key||!current?.me?.premiumActive||window.ZyroAndroidQuickSOSSupported!==true){toggle.checked=false;renderQuickSOSSettings();return;}
    try{if(toggle.checked)localStorage.setItem(key,'yes');else localStorage.removeItem(key);}
    catch{toggle.checked=false;toast('Impossibile salvare la preferenza SOS su questo dispositivo.',true);}
    renderQuickSOSSettings();
  });
  $('zyroQuickSosReadGuide')?.addEventListener('click',()=>{
    openProfileSettings('help');
    const help=$('zyroHelpQuickSOS');if(help)help.open=true;
  });
  $('sosButton').addEventListener('click',()=>action(startSOS));
  $('stopSOS').addEventListener('click',()=>action(stopSOS));

  $('sosRecipientList').addEventListener('change',()=>{sosPending=[...$('sosRecipientList').querySelectorAll('[data-sos-to]:checked')].map(x=>x.dataset.sosTo);});
  $('saveSOSRecipients').addEventListener('click',()=>action(async()=>{const recipients=[...$('sosRecipientList').querySelectorAll('[data-sos-to]:checked')].map(x=>x.dataset.sosTo);await post('/api/settings/sos-recipients',{recipients});sosPending=null;await refresh();toast('Destinatari SOS salvati.');}));
  $('avatarGallery').addEventListener('change',e=>{const file=e.target.files?.[0];if(file)action(()=>saveAvatar(file));e.target.value='';});
  $('avatarRemove').addEventListener('click',()=>action(async()=>{await post('/api/profile/avatar',{avatar:null});await refresh();toast('Foto profilo rimossa.');}));
  document.querySelectorAll('[data-chat-filter]').forEach(b=>b.addEventListener('click',()=>{chatCategory=b.dataset.chatFilter;document.querySelectorAll('[data-chat-filter]').forEach(t=>{const on=t===b;t.classList.toggle('active',on);t.setAttribute('aria-pressed',String(on));});renderChatRooms();}));
  $('chatSearch').addEventListener('input',e=>{chatSearch=e.target.value.trim();renderChatRooms();});
  $('chatManageCirclesButton').addEventListener('click',()=>showView('circles'));
  $('chatGroupInviteButton').addEventListener('click',()=>void action(makeChatGroupInvite));
  $('chatGroupCopy').addEventListener('click',()=>void action(async()=>{
    await copyInvite($('chatGroupInviteCode').textContent,'Codice del gruppo copiato.');
  }));
  $('chatGroupShare').addEventListener('click',()=>void action(async()=>{
    const code=$('chatGroupInviteCode').textContent;
    if(!/^G[A-F0-9]{18}$/.test(code))throw Error('Genera prima un codice gruppo.');
    if(navigator.share){try{await navigator.share({text:code});return;}catch(err){if(err?.name==='AbortError')return;}}
    await copyInvite(code,'Codice copiato. Puoi condividerlo con i membri del gruppo.');
  }));
  $('chatClose').addEventListener('click',closeChat);
  $('chatForm').addEventListener('submit',e=>{e.preventDefault();action(async()=>{const text=$('chatText').value.trim();if(!text&&!chatPhotoData)return;await sendChat(text,chatPhotoData);});});
  $('chatPhoto').addEventListener('change',e=>{const file=e.target.files?.[0];if(file)action(async()=>{chatPhotoData=await imageData(file,520,105000);$('chatPendingPhoto').textContent='📷 '+file.name+' pronta da inviare';});});
  document.querySelectorAll('[data-quick]').forEach(b=>b.addEventListener('click',()=>action(()=>sendChat(b.dataset.quick,null))));
  $('reportSubmit').addEventListener('click',()=>action(submitReport));
  $('adminLoad').addEventListener('click',()=>action(adminLoad));
  $('adminArchiveToggle').addEventListener('click',()=>{adminArchivedView=!adminArchivedView;$('adminArchiveToggle').setAttribute('aria-pressed',String(adminArchivedView));$('adminArchiveToggle').textContent=adminArchivedView?'Torna all’elenco principale':'Mostra archiviate';void action(adminLoad);});
  document.querySelectorAll('[data-admin-tab]').forEach(b=>b.addEventListener('click',()=>showAdminTab(b.dataset.adminTab)));
  $('adminFilter').addEventListener('input',renderAdminUsers);
  $('copyMyId').addEventListener('click',async()=>{if(!current)return;try{await copyAccountId(current.me.profileId);toast('ID profilo copiato.');}catch{toast('Copia non disponibile. Seleziona il codice e copialo manualmente.',true);}});
  $('pushButton').addEventListener('click',()=>action(enablePush));
  $('pushTestButton').addEventListener('click',()=>action(sendPushTest));
  $('closeListen').addEventListener('click',stopListening);
  $('deleteAccountForm').addEventListener('submit',event=>{
    event.preventDefault();
    void action(async()=>{
      if(!current)return;
      if(theftTriggered)throw Error('Prima ferma l’antifurto con la tua password.');
      if(!confirm('Eliminare definitivamente account e dati ZYRO 360? Posizione, SOS e protezioni si interromperanno. Questa operazione non può essere annullata.'))return;
      const button=event.currentTarget?.querySelector('button')||$('deleteAccountForm').querySelector('button');button.disabled=true;
      try{
        await post('/api/account/delete',{email:current.me.email,password:$('deleteAccountPassword').value,confirmation:$('deleteAccountConfirmation').value});
        stopListening();stopAudio();stopSiren();
        try{if(isZyroNativeAvailable())await nativeBackgroundSync({sharing:false,pick:false});}catch{}
        pickArmed=false;window.removeEventListener('devicemotion',motionListener);
        if(watchId!==null)navigator.geolocation?.clearWatch(watchId);
        watchId=null;lastCoords=null;clearHeadingMotion();mapTracking=false;ownCentered=false;
        current=null;socket?.close();socket=null;clearTimeout(wsRetry);clearInterval(refreshTimer);
        location.replace('/');
      }finally{button.disabled=false;$('deleteAccountPassword').value='';}
    });
  });
  $('logoutButton').addEventListener('click',()=>action(async()=>{if(theftTriggered)throw Error('Prima ferma l’antifurto usando la password del proprietario.');if(current?.me.sos && !confirm('Il tuo SOS è ancora attivo. Vuoi uscire? L’allarme resterà aperto ma GPS e microfono si interromperanno su questo dispositivo.'))return;stopListening();stopAudio();
    if(isZyroNativeAvailable())await nativeBackgroundSync({sharing:false,pick:false});
    pickArmed=false;window.removeEventListener('devicemotion',motionListener);await post('/api/logout');closeProfileSettings();showView('home');if(watchId!==null)navigator.geolocation?.clearWatch(watchId);watchId=null;lastCoords=null;clearHeadingMotion();mapTracking=false;ownCentered=false;removeStableMap();mapHideFailure();current=null;chatRoom=null;sosPending=null;socket?.close();socket=null;deviceSyncKey='';clearInterval(refreshTimer);$('appScreen').classList.add('hidden');$('authScreen').classList.remove('hidden');connection(false);$('password').value='';toast('Sei uscito dal tuo account.');}));
  if('serviceWorker'in navigator && location.protocol==='https:')navigator.serviceWorker.register('/sw.js?v=28-quick-settings-only').catch(()=>{});
  try{const data=await api('/api/state');setState(data);closeProfileSettings();showView('home');connectSocket();}
  catch(err){
    if(err.status!==401) toast('Impossibile recuperare il profilo dal server: '+err.message,true);
    // 401 indicates a missing/expired session; a returning user signs in
    // with the same credentials. Never store passwords in localStorage.
  }
  refreshTimer=setInterval(async()=>{if(current){try{await refresh();}catch{/* WebSocket reconnection is handled separately. */}}},45000);
  setInterval(verifySocketPresence,15000);
  window.addEventListener('online',()=>{if(current){verifySocketPresence();refresh().catch(()=>{});}});
  window.addEventListener('pagehide',()=>{ /* Browsers may suspend GPS, sensors and audio: never promise background safety. */ });
}
// Startup is invoked after onboarding declarations below.



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
  if(!g)return;const t=e.touches.length===1&&e.touches[0].identifier===g.id?e.touches[0]:null;
  if(e.touches.length!==1 || !t){g=null;return;}
  const dx=t.clientX-g.x,dy=t.clientY-g.y;
  if(!g.axis && Math.max(Math.abs(dx),Math.abs(dy))>10){
   if(Math.abs(dx)>Math.abs(dy)*1.35)g.axis='x';else{g=null;return;}
  }
  // CSS touch-action:pan-y handles horizontal gestures; no scroll-blocking preventDefault.
 },{passive:false,capture:true});
 document.addEventListener('touchcancel',()=>{g=null;},{passive:true,capture:true});
 document.addEventListener('touchend',e=>{
  const s=g;g=null;if(!s || e.touches.length || !available() || activeView!==s.view)return;
  const t=Array.from(e.changedTouches).find(t=>t.identifier===s.id);if(!t)return;
  const dx=t.clientX-s.x,dy=t.clientY-s.y;
  if(performance.now()-s.time>1200 || Math.abs(dx)<46 || Math.abs(dx)<Math.abs(dy)*1.35)return;
  const next=order[order.indexOf(activeView)+(dx<0?1:-1)];if(!next)return;
  suppressUntil=performance.now()+400;showView(next);
 },{passive:true,capture:true});
 document.addEventListener('click',e=>{if(performance.now()<suppressUntil){e.preventDefault();e.stopImmediatePropagation();}},true);
})();


// Resume visual map updates when the app returns to the foreground.
document.addEventListener('visibilitychange',()=>{if(!document.hidden && activeView==='home'){stableMap?.resize();renderHeadingOnly();}});









function renderBillingActions(){
 const android=window.ZyroBillingSupported===true&&hasZyroNativeBridge();
 const ready=!!current?.billingReady;
 document.querySelectorAll('[data-billing-open]').forEach(b=>{
  b.disabled=!(android&&ready);
  b.textContent=!ready?'Abbonamenti non ancora disponibili':android?(current.me.premiumActive?'Gestisci abbonamento':'Abbonati a 2,99 €/mese'):'Acquista dall’app Android aggiornata';
 });
}
async function openPlayBilling(){
 if(!current?.billingReady)throw Error('Il prodotto ZYRO 360 2,99 €/mese non è ancora attivo su Google Play.');
 if(window.ZyroBillingSupported!==true)throw Error('Per gli acquisti installa la versione Android aggiornata.');
 await zyroNativeRequest('billing');
}
document.querySelectorAll('[data-billing-open]').forEach(b=>b.addEventListener('click',()=>action(openPlayBilling)));
window.addEventListener('zyro:android-ready',renderBillingActions);
window.addEventListener('focus',()=>{if(current)void action(refresh);});





async function zyroWelcomeBeforeStart(){
 const welcomeSeenKey='zyro360.welcome.completed';
 let welcomeSeen=false;
 try{welcomeSeen=localStorage.getItem(welcomeSeenKey)==='true';}catch{}
 if(welcomeSeen){
  window.ZyroStartupReady=true;document.body.classList.remove('zyro-await-intro');
  return;
 }
 const screen=document.createElement('section');screen.className='zyro-welcome-screen';screen.setAttribute('aria-label','Benvenuto in ZYRO 360');
 screen.innerHTML=`<div class="zyro-welcome-wrap"><div class="zyro-welcome-content" tabindex="0" aria-label="Le funzioni di ZYRO 360"><header class="zyro-welcome-header"><div class="zyro-welcome-brand">ZYRO <span>360</span></div><p class="zyro-welcome-kicker">IL TUO SPAZIO DI SICUREZZA</p><h1>Più vicini.<br>Più consapevoli.</h1></header><p class="zyro-welcome-intro">Resta in contatto con le persone fidate e chiedi aiuto quando ne hai bisogno.</p>
 <article class="zyro-welcome-card"><span aria-hidden="true">⌖</span><div><h2>SOS e posizione</h2><p>Avvisa i contatti scelti e condividi la posizione. Con il piano unico ZYRO 360 da 2,99 €/mese puoi attivare l’audio SOS, soltanto con il tuo consenso e le autorizzazioni richieste.</p></div></article>
 <article class="zyro-welcome-card"><span aria-hidden="true">↗</span><div><h2>Pick Pocket</h2><p>Se attivo, un movimento sospetto può far partire la sirena e un SOS con posizione in tempo reale ai contatti scelti, quando abiliti gli avvisi.</p></div></article>
 <article class="zyro-welcome-card"><span aria-hidden="true">➤</span><div><h2>Segui il percorso SOS e possibile furto</h2><p>Con Premium puoi seguire sulla mappa un percorso indicativo verso il contatto che invia un SOS o una segnalazione Pick Pocket. Premi «Portami da» e autorizza l’uso del GPS e del servizio stradale esterno.</p></div></article>
 <article class="zyro-welcome-card"><span aria-hidden="true">◎</span><div><h2>Accompagnami e Check-in</h2><p>Condividi un percorso o conferma che stai bene entro un orario. I contatti possono ricevere un avviso se sei in ritardo.</p></div></article>
 <p class="zyro-welcome-note">Gli aggiornamenti richiedono servizio attivo, permessi e connessione. L’app non riconosce ogni emergenza: in caso di pericolo chiama il <a href="tel:112">112</a>.</p></div>
 <footer class="zyro-welcome-actions"><button id="zyroWelcomeProceed" type="button">Prosegui <span aria-hidden="true">→</span></button></footer></div>`;
 const auth=$('authScreen'),app=$('appScreen');
 const previousAuthInert=auth.inert,previousAppInert=app.inert;
 auth.inert=true;app.inert=true;auth.setAttribute('aria-hidden','true');app.setAttribute('aria-hidden','true');
 document.body.append(screen);document.body.classList.add('zyro-welcome-open');
 window.ZyroStartupReady=true;document.body.classList.remove('zyro-await-intro');
 const button=screen.querySelector('#zyroWelcomeProceed');
 await new Promise(resolve=>button.addEventListener('click',()=>{
  try{localStorage.setItem(welcomeSeenKey,'true');}catch{}
  screen.remove();document.body.classList.remove('zyro-welcome-open');
  auth.inert=previousAuthInert;app.inert=previousAppInert;auth.removeAttribute('aria-hidden');app.removeAttribute('aria-hidden');
  resolve();
 },{once:true}));
}

init();




