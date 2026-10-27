'use strict';
const $ = id => document.getElementById(id);
let current = null;
let socket = null;
let wsRetry = null;
let watchId = null;
let lastCoords = null;
let sentAt = 0;
let localStream = null;
let micBusy = false;
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
function escapeHtml(t) { return String(t??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x])); }
function initials(s) {return String(s||'?').trim().charAt(0).toUpperCase();}
function toast(message,error=false) {const el=$('toast');el.textContent=message;el.classList.toggle('error',error);el.classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.add('hidden'),5200);}
async function api(route, options={}) {
  let res;
  try {res=await fetch(route,{credentials:'same-origin',headers:{'Content-Type':'application/json'},...options});}
  catch {throw Error('Connessione Internet assente. Riprova quando sei online.');}
  let body;try{body=await res.json();}catch{body={};}
  if(!res.ok) throw Error(body.error || `Errore di connessione (${res.status}).`);
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
  ws.onopen=()=>{ connection(true); if(localStream)ws.send(JSON.stringify({type:'audio-ready',ready:true})); };
  ws.onmessage=async(event)=>{
    let m;try{m=JSON.parse(event.data);}catch{return;}
    if(m.type==='state'){setState(m.data);}
    if(m.type==='listen-request') await action(()=>sendOffer(m.from));
    if(m.type==='rtc') await action(()=>handleRTC(m.from,m.signal));
    if(m.type==='sos-ended') {if(m.userId===listeningTo)stopListening();if(m.userId===current?.me?.id)stopAudio();}
  };
  ws.onclose=()=>{if(socket!==ws)return;socket=null;connection(false);if(current)wsRetry=setTimeout(connectSocket,3000);};
  ws.onerror=()=>{connection(false);};
}
function wsSend(message){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(message));}
function connection(up){$('connectionText').textContent=up?'Collegato':'Non collegato';$('connectionDot').classList.toggle('connected',up);}
function setState(data){
  if(!data?.me)return;
  const prev = current;
  current=data;
  if($('appScreen').classList.contains('hidden')) { $('authScreen').classList.add('hidden');$('appScreen').classList.remove('hidden'); }
  updateGeo(prev?.me?.sharing||!!prev?.me?.sos, data.me.sharing || !!data.me.sos);
  renderHome();renderCircles();renderSettings();
  const key = data.alerts.filter(a=>a.userId!==data.me.id).map(a=>a.id).sort().join(',');
  if(prev && key && key !== lastAlertKey) toast('🆘 Nuovo SOS nella tua cerchia.',true);
  lastAlertKey=key;
}
function uniqueContacts(){const contacts=new Map();for(const c of current?.circles||[])for(const m of c.members)if(m.id!==current.me.id)contacts.set(m.id,m);return [...contacts.values()];}
function when(ts){if(!ts)return 'Nessuna posizione';const diff=Date.now()-ts;if(diff<60000)return 'Aggiornata ora';if(diff<3600000)return `${Math.round(diff/60000)} min fa`;return `${Math.round(diff/3600000)} ore fa`;}
function locationUrl(p){return `https://www.openstreetmap.org/?mlat=${encodeURIComponent(p.lat)}&mlon=${encodeURIComponent(p.lon)}#map=16/${encodeURIComponent(p.lat)}/${encodeURIComponent(p.lon)}`;}
function renderHome(){
  if(!current)return;
  const me=current.me, contacts=uniqueContacts(), sos=!!me.sos;
  $('greetingName').textContent=me.name.split(' ')[0];$('myAvatar').textContent=initials(me.name);
  $('totalMembers').textContent=contacts.length;$('totalCircles').textContent=current.circles.length;
  $('shareToggle').checked=!!me.sharing; $('shareToggle').disabled=sos;
  const liveGPS=me.sharing||sos;
  $('myLocationText').textContent= sos?'GPS richiesto durante SOS · attivo fino alla fine dell’allarme':(liveGPS ? (geolocationError || (lastCoords?`GPS attivo · ${lastCoords.lat.toFixed(4)}, ${lastCoords.lon.toFixed(4)}`:'Ricerca posizione GPS...')):'Condivisione disattivata');
  $('sosCard').classList.toggle('is-active',sos);
  $('sosTitle').textContent=sos?'SOS inviato alla tua cerchia':'Hai bisogno di aiuto?';
  $('sosDescription').textContent=sos?(contacts.length?'L’allarme è visibile alle persone della cerchia. Tieni aperta l’app per GPS e audio live.':'Nessun contatto nella tua cerchia: il tuo SOS non raggiunge nessuno. In emergenza chiama il 112.'):'Premi il pulsante per avvisare la tua cerchia e condividere la tua posizione in tempo reale.';
  $('sosButton').disabled=sos;
  $('sosButton').setAttribute('aria-label',sos?'SOS già attivo':'Attiva SOS');
  $('sosActiveActions').classList.toggle('hidden',!sos);
  $('sosInactiveNote').classList.toggle('hidden',sos);
  $('audioButton').textContent=localStream?'🔇 Disattiva microfono':'🎙 Attiva microfono';
  $('contactsList').innerHTML=contacts.length?contacts.map((u,i)=>{
    const status=u.sos?'🆘 SOS ATTIVO':u.online?(u.sharing?'Posizione attiva':'Online'):'Offline';
    const loc=u.location, time=loc?when(loc.updatedAt):(u.sharing?'Posizione in attesa':'Posizione non condivisa');
    return `<div class="contact-card"><div class="contact-avatar ${i%2?'alt':''}">${escapeHtml(initials(u.name))}</div><div class="contact-info"><b>${escapeHtml(u.name)}</b><small>${escapeHtml(time)}</small></div><div class="contact-actions"><span class="status-chip ${u.sos?'alert':!u.online?'off':''}">${escapeHtml(status)}</span>${loc?`<a class="mini-btn" target="_blank" rel="noopener noreferrer" href="${locationUrl(loc)}">📍 Mappa</a>`:''}${u.sos?.hasAudio?`<button type="button" class="mini-btn audio" data-listen="${escapeHtml(u.id)}">🎧 Ascolta</button>`:''}</div></div>`;
  }).join(''):`<div class="empty-state"><div class="empty-symbol">♧</div><strong>La tua cerchia inizia da qui</strong>Aggiungi le persone di cui ti fidi per condividere la posizione e ricevere SOS.</div>`;
  const otherAlerts=current.alerts.filter(a=>a.userId!==me.id);
  $('activeAlerts').classList.toggle('hidden',!otherAlerts.length);
  $('activeAlerts').innerHTML=otherAlerts.map(a=>`<div class="alert-box"><h3>🆘 ${escapeHtml(a.name)} chiede aiuto</h3><p>Allarme attivo · ${new Date(a.startedAt).toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'})}. Contatta i soccorsi se necessario.</p><div class="action-row">${a.location?`<a target="_blank" rel="noopener noreferrer" href="${locationUrl(a.location)}">📍 Apri posizione</a>`:''}${a.hasAudio?`<button type="button" data-listen="${escapeHtml(a.userId)}">🎧 Ascolta microfono</button>`:''}<a href="tel:112">Chiama 112</a></div></div>`).join('');
  document.querySelectorAll('[data-listen]').forEach(btn=>btn.addEventListener('click',()=>action(()=>listenTo(btn.dataset.listen))));
}
function inviteBox(code){return `<div class="invite-code-box"><small>CODICE MONOUSO · VALIDO 24 ORE</small><code>${escapeHtml(code)}</code><button type="button" class="copy-code">Copia codice</button></div>`;}
function renderCircles(){
  if(!current)return;
  const list=$('circlesList');
  list.innerHTML=current.circles.length?current.circles.map(c=>`<div class="circle-card" data-circle="${escapeHtml(c.id)}"><div class="circle-top"><div><strong>◎ ${escapeHtml(c.name)}</strong><small>${c.members.length} ${c.members.length===1?'membro':'membri'} · ${c.mine?'Creata da te':'Cerchia condivisa'}</small></div><span class="status-chip">Privata</span></div><div class="circle-members">${c.members.map(m=>`<span class="member-pill">${escapeHtml(m.name)}${m.id===current.me.id?' (tu)':''}</span>`).join('')}</div><div class="circle-actions"><button type="button" data-invite="${escapeHtml(c.id)}">✚ Genera codice invito</button>${c.mine?`<button type="button" class="danger" data-delete="${escapeHtml(c.id)}">Elimina cerchia</button>`:`<button type="button" class="danger" data-leave="${escapeHtml(c.id)}">Esci dalla cerchia</button>`}</div><div class="invite-target">${inviteCodes.has(c.id)?inviteBox(inviteCodes.get(c.id)):''}</div></div>`).join(''):'<div class="empty-state"><div class="empty-symbol">◎</div><strong>Ancora nessuna cerchia</strong>Crea un gruppo o inserisci il codice di un familiare.</div>';
  list.querySelectorAll('[data-invite]').forEach(b=>b.addEventListener('click',()=>action(async()=>{
    const r=await post('/api/invites',{circleId:b.dataset.invite});
    const target=b.closest('.circle-card').querySelector('.invite-target');
    inviteCodes.set(b.dataset.invite,r.code);target.innerHTML=inviteBox(r.code);
    bindCopyCodes(target);
  })));
  bindCopyCodes(list);
  list.querySelectorAll('[data-leave]').forEach(b=>b.addEventListener('click',()=>action(async()=>{if(!confirm('Vuoi davvero uscire da questa cerchia?'))return;await post('/api/circles/leave',{circleId:b.dataset.leave});await refresh();toast('Hai lasciato la cerchia.');})));
  list.querySelectorAll('[data-delete]').forEach(b=>b.addEventListener('click',()=>action(async()=>{if(!confirm('Eliminare definitivamente questa cerchia per tutti i membri?'))return;await post('/api/circles/delete',{circleId:b.dataset.delete});await refresh();toast('Cerchia eliminata.');})));
}
function bindCopyCodes(root){root.querySelectorAll('.copy-code').forEach(btn=>btn.addEventListener('click',async()=>{const code=btn.closest('.invite-code-box')?.querySelector('code')?.textContent;try{await navigator.clipboard.writeText(code);toast('Codice copiato. Condividilo solo con una persona fidata.');}catch{toast('Seleziona e copia il codice mostrato.');}}));}
function renderSettings(){if(!current)return;$('profileName').textContent=current.me.name;$('profileEmail').textContent=current.me.email;$('profileAvatar').textContent=initials(current.me.name);$('pushButton').disabled=!current.pushEnabled;$('pushButton').textContent=current.pushEnabled?'Attiva notifiche SOS':'Notifiche push non configurate';}
function showView(view){activeView=view;for(const v of ['home','circles','settings'])$(`${v}View`).classList.toggle('hidden',v!==view);document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===view));window.scrollTo({top:0,behavior:'smooth'});}
function updateGeo(oldOn,newOn){
  if(!newOn){if(watchId!==null)navigator.geolocation?.clearWatch(watchId);watchId=null;lastCoords=null;geolocationError='';return;}
  if(watchId!==null)return;
  if(!navigator.geolocation){geolocationError='GPS non disponibile su questo browser';toast(geolocationError,true);return;}
  geolocationError='';
  watchId=navigator.geolocation.watchPosition(async(p)=>{
    lastCoords={lat:p.coords.latitude,lon:p.coords.longitude,accuracy:p.coords.accuracy};geolocationError='';
    if(Date.now()-sentAt > 3500){sentAt=Date.now();try{await post('/api/position',lastCoords);}catch(e){if(e.message!=='Condivisione non attiva.')console.warn(e.message);}}
    renderHome();
  },err=>{geolocationError=`GPS: ${err.message||'permesso negato'}`;renderHome();toast(geolocationError,true);},{enableHighAccuracy:true,maximumAge:5000,timeout:20000});
}
async function refresh(){if(!current)return;const data=await api('/api/state');setState(data);}
async function startSOS(){
  // Send the alarm first: microphone access must not delay the emergency alert.
  await post('/api/sos/start');await refresh();
  toast(uniqueContacts().length?'SOS attivato. I contatti collegati possono vedere il tuo allarme.':'SOS attivo, ma non hai contatti collegati alla cerchia: chiama 112 in emergenza.',!uniqueContacts().length);
  try{await startAudio();}catch(e){toast(`SOS attivo ma microfono non disponibile: ${e.message}`,true);}
}
async function stopSOS(){if(!confirm('Confermi di voler terminare l’allarme SOS?'))return;await post('/api/sos/stop');stopAudio();await refresh();toast('SOS terminato.');}
async function startAudio(){
  if(localStream || micBusy || !current?.me?.sos)return;
  if(!navigator.mediaDevices?.getUserMedia)throw Error('Serve HTTPS e un browser con accesso al microfono.');
  micBusy=true;
  try{
    localStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    localStream.getAudioTracks().forEach(t=>t.addEventListener('ended',()=>{if(localStream)stopAudio();}));
    wsSend({type:'audio-ready',ready:true});toast('Microfono attivo e condivisibile con la tua cerchia.');renderHome();
  }finally{micBusy=false;}
}
function stopAudio(){if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null;}for(const p of peers.values())p.close();peers.clear();pendingIce.clear();wsSend({type:'audio-ready',ready:false});renderHome();}
function makePeer(remoteId,send){
  let peer=peers.get(remoteId);if(peer)return peer;
  peer=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]});
  peer.onicecandidate=e=>{if(e.candidate)wsSend({type:'rtc',to:remoteId,signal:{kind:'candidate',candidate:e.candidate.toJSON()}});};
  peer.onconnectionstatechange=()=>{if(['failed','closed'].includes(peer.connectionState)){peer.close();peers.delete(remoteId);}};
  peer.ontrack=ev=>{if(listeningTo!==remoteId)return;const audio=$('remoteAudio');audio.srcObject=ev.streams[0]||new MediaStream([ev.track]);$('audioDock').classList.remove('hidden');audio.play().catch(()=>toast('Tocca ▶ nel lettore per ascoltare l’audio.'));};
  if(send&&localStream)for(const track of localStream.getTracks())peer.addTrack(track,localStream);
  peers.set(remoteId,peer);return peer;
}
async function sendOffer(remoteId){if(!localStream||!current?.me?.sos)return;const prior=peers.get(remoteId);if(prior){prior.close();peers.delete(remoteId);}const p=makePeer(remoteId,true);const offer=await p.createOffer();await p.setLocalDescription(offer);wsSend({type:'rtc',to:remoteId,signal:{kind:'offer',sdp:p.localDescription.toJSON()}});}
async function listenTo(remoteId){
  if(!current?.alerts.some(a=>a.userId===remoteId&&a.hasAudio)){toast('Microfono non disponibile in questo momento.',true);return;}
  if(!('RTCPeerConnection' in window)){toast('Questo browser non supporta l’audio live.',true);return;}
  stopListening();listeningTo=remoteId;
  $('audioDock').classList.remove('hidden');
  toast('Richiesta di ascolto inviata. Se necessario, premi Play.');
  wsSend({type:'listen-request',to:remoteId});
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
function stopListening(){if(listeningTo){const p=peers.get(listeningTo);if(p){p.close();peers.delete(listeningTo);}pendingIce.delete(listeningTo);}listeningTo=null;const a=$('remoteAudio');a.pause();a.srcObject=null;$('audioDock').classList.add('hidden');}
async function enablePush(){
  if(!current?.pushEnabled)return;
  if(!('serviceWorker'in navigator) || !('PushManager'in window))throw Error('Notifiche push non supportate da questo browser.');
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
async function init(){
  document.querySelectorAll('.auth-tab').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));
  $('authForm').addEventListener('submit',e=>{e.preventDefault();action(async()=>{
    const payload={email:$('email').value.trim(),password:$('password').value};if(authMode==='register')payload.name=$('name').value.trim();
    $('authSubmit').disabled=true;try{await post(authMode==='login'?'/api/login':'/api/register',payload);const data=await api('/api/state');setState(data);connectSocket();toast('Benvenuto in Zyro 360!');}finally{$('authSubmit').disabled=false;}
  });});
  document.querySelectorAll('.nav-item').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));
  $('openCircles').addEventListener('click',()=>showView('circles'));
  $('createCircleForm').addEventListener('submit',e=>{e.preventDefault();action(async()=>{await post('/api/circles',{name:$('circleName').value});$('circleName').value='';await refresh();toast('Cerchia creata! Ora puoi generare un invito.');});});
  $('joinCircleForm').addEventListener('submit',e=>{e.preventDefault();action(async()=>{await post('/api/invites/join',{code:$('inviteInput').value});$('inviteInput').value='';await refresh();toast('Ora fai parte della cerchia!');});});
  $('shareToggle').addEventListener('change',async e=>{const enabled=e.target.checked;await action(async()=>{await post('/api/sharing',{enabled});await refresh();toast(enabled?'Posizione condivisa con le tue cerchie.':'Condivisione della posizione interrotta.');});if(current)$('shareToggle').checked=!!current.me.sharing;});
  $('sosButton').addEventListener('click',()=>action(startSOS));
  $('stopSOS').addEventListener('click',()=>action(stopSOS));
  $('audioButton').addEventListener('click',()=>action(async()=>{if(localStream){stopAudio();toast('Microfono disattivato. Il tuo SOS rimane attivo.');}else await startAudio();}));
  $('pushButton').addEventListener('click',()=>action(enablePush));
  $('closeListen').addEventListener('click',stopListening);
  $('logoutButton').addEventListener('click',()=>action(async()=>{if(current?.me.sos && !confirm('Il tuo SOS è ancora attivo. Vuoi uscire? L’allarme resterà aperto ma GPS e microfono si interromperanno su questo dispositivo.'))return;stopListening();stopAudio();await post('/api/logout');if(watchId!==null)navigator.geolocation?.clearWatch(watchId);watchId=null;current=null;socket?.close();socket=null;clearInterval(refreshTimer);$('appScreen').classList.add('hidden');$('authScreen').classList.remove('hidden');connection(false);$('password').value='';toast('Sei uscito dal tuo account.');}));
  if('serviceWorker'in navigator && location.protocol==='https:')navigator.serviceWorker.register('/sw.js').catch(()=>{});
  try{const data=await api('/api/state');setState(data);connectSocket();}catch{ /* Guest sees login */ }
  refreshTimer=setInterval(async()=>{if(current){try{await refresh();}catch{/* WebSocket reconnect handles live state */}}},45000);
  window.addEventListener('online',()=>{if(current){connectSocket();refresh().catch(()=>{});}});
  window.addEventListener('pagehide',()=>{ /* The browser may suspend geo/audio; never promise background tracking. */ });
}
init();
