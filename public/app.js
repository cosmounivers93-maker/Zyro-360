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
let chatRoom=null, chatPhotoData=null;
let sosPending=null;
let inviteFromLink=null;
// Map: GPS stays on this device unless the user explicitly enables sharing or an alert.
let mapTracking=false, ownCentered=false;
let zyroMap=null;
let compassHeading = null;
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
    if(m.type==='chat-new' && chatRoom) { if(m.chatType===chatRoom.type && (chatRoom.type==='circle' ? m.target===chatRoom.id : m.from===chatRoom.id || m.from===current?.me?.id))void loadChat(); }
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
  updateGeo(null, data.me.sharing || (data.me.alertKind==='pickpocket' && data.me.theftShare) || mapTracking || pickArmed);
  renderHome();renderCircles();renderSettings();renderPickControls();renderSOSRecipients();renderChatRooms();
  if (data.me.alertKind === 'pickpocket' && !theftTriggered) { theftTriggered=true; pickArmed=false; showTheftOverlay('È presente un allarme antifurto. Puoi fermarlo con la password.'); startSiren(); }
  if (data.me.alertKind !== 'pickpocket' && theftTriggered && !theftIsPending) { theftTriggered=false; hideTheftOverlay(); stopSiren(); }

  const key = data.alerts.filter(a=>a.userId!==data.me.id).map(a=>a.id).sort().join(',');
  if(prev && key && key !== lastAlertKey) toast('🆘 Nuovo SOS nella tua cerchia.',true);
  lastAlertKey=key;
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
  const liveGPS=me.sharing||(pick&&me.theftShare);
  $('myLocationText').textContent= sos?'SOS attivo. Posizione condivisa solo se già autorizzata.':(liveGPS ? (geolocationError || (lastCoords?`GPS attivo · ${lastCoords.lat.toFixed(4)}, ${lastCoords.lon.toFixed(4)}`:'Ricerca posizione GPS...')):'Condivisione disattivata');
  $('sosCard').classList.toggle('is-active',!!me.sos);
  $('sosTitle').textContent=pick?'Protezione antifurto attiva':sos?'SOS inviato ai contatti selezionati':'Hai bisogno di aiuto?';
  $('sosDescription').textContent=pick?'La modalità Pick Pocket è scattata. Puoi interromperla con la password nella schermata antifurto.':sos?(contacts.length?'Le persone selezionate vedono l’allarme. Premi «Attiva microfono» se vuoi trasmettere audio.':'Nessun contatto nella tua cerchia: il tuo SOS non raggiunge nessuno. In emergenza chiama il 112.'):'Premi SOS per avvisare soltanto i destinatari selezionati. La condivisione GPS è indipendente.';
  $('sosButton').disabled=!!me.sos;
  $('sosButton').setAttribute('aria-label',me.sos?'Allarme già attivo':'Attiva SOS');
  $('sosActiveActions').classList.toggle('hidden',!sos);
  $('sosInactiveNote').classList.toggle('hidden',!!me.sos);
  $('audioButton').textContent=localStream?'🔇 Disattiva microfono':'🎙 Attiva microfono';
  $('contactsList').innerHTML=contacts.length?contacts.map((u,i)=>{
    const status=u.sos?(u.sos.kind==='pickpocket'?'🚨 POSSIBILE FURTO':'🆘 SOS ATTIVO'):u.online?(u.sharing?'Posizione attiva':'Online'):'Offline';
    const loc=u.location, time=loc?when(loc.updatedAt):(u.sharing?'Posizione in attesa':'Posizione non condivisa');
    return `<div class="contact-card"><div class="contact-avatar ${i%2?'alt':''}">${avatarHTML(u)}</div><div class="contact-info"><b>${escapeHtml(u.name)}</b><small>${escapeHtml(time)}</small></div><div class="contact-actions"><span class="status-chip ${u.sos?'alert':!u.online?'off':''}">${escapeHtml(status)}</span>${loc?`<a class="mini-btn" target="_blank" rel="noopener noreferrer" href="${locationUrl(loc)}">📍 Mappa</a>`:''}${u.sos?.hasAudio?`<button type="button" class="mini-btn audio" data-listen="${escapeHtml(u.id)}">🎧 Ascolta</button>`:''}</div></div>`;
  }).join(''):`<div class="empty-state"><div class="empty-symbol">♧</div><strong>La tua cerchia inizia da qui</strong>Aggiungi le persone di cui ti fidi per condividere la posizione e ricevere SOS.</div>`;
  const otherAlerts=current.alerts.filter(a=>a.userId!==me.id);
  $('activeAlerts').classList.toggle('hidden',!otherAlerts.length);
  $('activeAlerts').innerHTML=otherAlerts.map(a=>`<div class="alert-box"><h3>${a.kind==='pickpocket'?'🚨 Possibile furto:':'🆘'} ${escapeHtml(a.name)} ${a.kind==='pickpocket'?'potrebbe aver subito uno scippo':'chiede aiuto'}</h3><p>Allarme attivo · ${new Date(a.startedAt).toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'})}. Contatta i soccorsi se necessario.</p><div class="action-row">${a.location?`<a target="_blank" rel="noopener noreferrer" href="${locationUrl(a.location)}">📍 Apri posizione</a>`:''}${a.hasAudio?`<button type="button" data-listen="${escapeHtml(a.userId)}">🎧 Ascolta microfono</button>`:''}<a href="tel:112">Chiama 112</a></div></div>`).join('');
  document.querySelectorAll('[data-listen]').forEach(btn=>btn.addEventListener('click',()=>action(()=>listenTo(btn.dataset.listen))));
  renderMap();
}
function inviteBox(code){const link=location.origin+'/?invite='+encodeURIComponent(code);return `<div class="invite-code-box"><small>LINK E CODICE MONOUSO · VALIDI 24 ORE</small><code>${escapeHtml(code)}</code><button type="button" class="copy-code">Copia codice</button><input readonly aria-label="Link invito" value="${escapeHtml(link)}"><div class="invite-share-actions"><button type="button" class="copy-invite-link">🔗 Copia link</button><button type="button" class="share-invite-link">↗ Condividi</button></div></div>`;}
function renderCircles(){
  if(!current)return;
  const list=$('circlesList');
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
  node.innerHTML=contacts.length?contacts.map(u=>`<label class="recipient-line"><input type="checkbox" data-sos-to="${escapeHtml(u.id)}" ${selected.has(u.id)?'checked':''}><span>${avatarHTML(u)} ${escapeHtml(u.name)}</span></label>`).join(''):'<p class="setting-description">Invita prima una persona nella cerchia.</p>';
  $('sosPushNote').textContent=current.pushEnabled?'Le notifiche push richiedono che i destinatari le abilitino sul loro telefono.':'⚠ Notifiche push non configurate su Render: gli allarmi possono essere visualizzati solo nell’app aperta. Non usarli per emergenze reali.';
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
function renderChatRooms(){
  if(!current)return;
  const circles=current.circles, contacts=uniqueContacts();
  $('chatRooms').innerHTML=`<p class="chat-section-label">👨‍👩‍👧‍👦 Gruppi famiglia</p>`+(circles.length?circles.map(c=>`<button type="button" class="chat-room" data-typ="circle" data-id="${escapeHtml(c.id)}"><span class="chat-room-icon">◎</span><span><b>${escapeHtml(c.name)}</b><small>${c.members.length} membri · chat di gruppo</small></span><span>›</span></button>`).join(''):'<p class="setting-description">Crea una cerchia per avere la sua chat.</p>')+`<p class="chat-section-label">💬 Chat amici</p>`+(contacts.length?contacts.map(u=>`<button type="button" class="chat-room" data-typ="direct" data-id="${escapeHtml(u.id)}"><span class="chat-room-icon">${avatarHTML(u)}</span><span><b>${escapeHtml(u.name)}</b><small>Conversazione privata</small></span><span>›</span></button>`).join(''):'<p class="setting-description">Invita gli amici per messaggiare.</p>');
  $('chatRooms').querySelectorAll('.chat-room').forEach(b=>b.addEventListener('click',()=>openChat(b.dataset.typ,b.dataset.id)));
}
function openChat(type,id){chatRoom={type,id};showView('chats');$('chatConversation').classList.remove('hidden');const circle=current.circles.find(c=>c.id===id),user=uniqueContacts().find(u=>u.id===id);$('chatTitle').textContent=type==='circle' ? circle?.name||'Gruppo':user?.name||'Amico';$('chatSubtitle').textContent=type==='circle'?'Chat di gruppo · membri della cerchia':'Chat privata · solo voi due';loadChat().catch(e=>toast(e.message,true));}
async function loadChat(){
  const r=chatRoom;if(!r||!current)return;
  const response=await api(`/api/chat/${encodeURIComponent(r.type)}/${encodeURIComponent(r.id)}`);
  if(chatRoom!==r)return;
  const node=$('chatMessages');node.innerHTML=response.messages.length?response.messages.map(m=>`<article class="chat-bubble ${m.from===current.me.id?'mine':''}"><small>${escapeHtml(m.name)} · ${new Date(m.at).toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'})}</small>${m.text?`<p>${escapeHtml(m.text)}</p>`:''}${m.image?`<img loading="lazy" src="${m.image}" alt="Foto nella conversazione">`:''}</article>`).join(''):'<p class="chat-empty">Nessun messaggio. Inizia tu la conversazione!</p>';
  node.scrollTop=node.scrollHeight;
}
async function sendChat(text,image){if(!chatRoom)return;await post(`/api/chat/${encodeURIComponent(chatRoom.type)}/${encodeURIComponent(chatRoom.id)}`,{text,image});chatPhotoData=null;$('chatPendingPhoto').textContent='';$('chatPhoto').value='';$('chatText').value='';await loadChat();}

function renderSettings(){if(!current)return;$('profileName').textContent=current.me.name;$('profileEmail').textContent=current.me.email;setAvatar($('profileAvatar'),current.me);$('pushButton').disabled=!current.pushEnabled;$('pushButton').textContent=current.pushEnabled?'Attiva notifiche SOS':'Notifiche push non configurate';}
function showView(view){activeView=view;for(const v of ['home','circles','chats','settings'])$(`${v}View`).classList.toggle('hidden',v!==view);document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===view));window.scrollTo({top:0,behavior:'smooth'});if(view==='home'){requestAnimationFrame(()=>{renderMap();zyroMap?.invalidateSize();});}}
function updateGeo(oldOn,newOn){
  if(!newOn){if(watchId!==null)navigator.geolocation?.clearWatch(watchId);watchId=null;lastCoords=null;geolocationError='';renderMap();return;}
  if(watchId!==null)return;
  if(!navigator.geolocation){geolocationError='GPS non disponibile su questo browser';toast(geolocationError,true);return;}
  geolocationError='';
  watchId=navigator.geolocation.watchPosition(async(p)=>{
    lastCoords={lat:p.coords.latitude,lon:p.coords.longitude,accuracy:p.coords.accuracy,heading:Number.isFinite(p.coords.heading)?p.coords.heading:compassHeading};geolocationError='';
    const canShare=!!current?.me?.sharing || (current?.me?.alertKind==='pickpocket' && !!current.me.theftShare);
    if(canShare && Date.now()-sentAt > 3500){sentAt=Date.now();try{await post('/api/position',lastCoords);}catch(e){if(e.message!=='Condivisione non attiva.')console.warn(e.message);}}
    renderHome();
  },err=>{geolocationError=`GPS: ${err.message||'permesso negato'}`;renderHome();toast(geolocationError,true);},{enableHighAccuracy:true,maximumAge:5000,timeout:20000});
}
async function refresh(){if(!current)return;const data=await api('/api/state');setState(data);}
async function startSOS(){
  // Send the alarm first: microphone access must not delay the emergency alert.
  await post('/api/sos/start');await refresh();
  toast('Allerta SOS inviata al server ai contatti selezionati. Le notifiche push non sono garantite.');
  toast(current.pushEnabled?'Se vuoi trasmettere l’audio premi «Attiva microfono».':'Attenzione: push non configurate sul server. Avvisa la persona anche con una chiamata.',!current.pushEnabled);
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
// Map tiles are loaded only for the visible viewport. No third-party JS dependency.
// OpenStreetMap standard tiles: © OpenStreetMap contributors. Internet required.
const MAP_TILE_SIZE=256, MIN_MAP_ZOOM=3, MAX_MAP_ZOOM=18;
function clampLatitude(lat){return Math.min(85.05112878,Math.max(-85.05112878,lat));}
function worldPoint(lat,lon,zoom){
  const size=MAP_TILE_SIZE*2**zoom, phi=clampLatitude(lat)*Math.PI/180;
  return {x:(lon+180)/360*size,y:(1-Math.log(Math.tan(phi)+1/Math.cos(phi))/Math.PI)/2*size};
}
function geoPoint(x,y,zoom){
  const size=MAP_TILE_SIZE*2**zoom;
  return {lat:Math.atan(Math.sinh(Math.PI*(1-2*Math.max(0,Math.min(size,y))/size)))*180/Math.PI,
    lon:((x/size*360+180)%360+360)%360-180};
}
class ZyroNativeMap {
  constructor(element){
    this.element=element;this.tiles=$('mapTiles');this.pins=$('mapPins');
    this.center={lat:41.65,lon:12.48};this.zoom=6;this.tilesByKey=new Map();
    this.pointerStart=null;this.fingers=new Map();this.pinchStart=null;
    this.loaded=0;this.failed=0;this.drawQueued=false;
    this.lastTap=0;this.own=null;this.contacts=[];
    element.addEventListener('pointerdown',e=>this.onDown(e));
    element.addEventListener('pointermove',e=>this.onMove(e));
    element.addEventListener('pointerup',e=>this.onUp(e));
    element.addEventListener('pointercancel',e=>this.onUp(e));
    element.addEventListener('wheel',e=>{if(!e.ctrlKey && !e.shiftKey)return;e.preventDefault();this.setZoom(this.zoom+(e.deltaY<0?1:-1));},{passive:false});
    this.resizeObserver=typeof ResizeObserver!=='undefined'?new ResizeObserver(()=>this.invalidateSize()):null;
    this.resizeObserver?.observe(element);
    window.addEventListener('resize',()=>this.invalidateSize());
    this.invalidateSize();
  }
  onDown(e){
    // Don't intercept links or buttons in the map overlays.
    if(e.target.closest('a,button,.map-attribution'))return;
    this.element.setPointerCapture?.(e.pointerId);
    this.fingers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(this.fingers.size===1)this.pointerStart={x:e.clientX,y:e.clientY,center:{...this.center}};
    if(this.fingers.size===2){
      const [a,b]=[...this.fingers.values()];this.pinchStart={distance:Math.hypot(a.x-b.x,a.y-b.y),zoom:this.zoom};this.pointerStart=null;
    }
  }
  onMove(e){
    if(!this.fingers.has(e.pointerId))return;
    this.fingers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(this.fingers.size===2 && this.pinchStart){
      const [a,b]=[...this.fingers.values()];const dist=Math.hypot(a.x-b.x,a.y-b.y);
      if(dist>0 && this.pinchStart.distance>0){
        const next=this.pinchStart.zoom+Math.round(Math.log2(dist/this.pinchStart.distance)*1.5);
        this.setZoom(next);
      }
      return;
    }
    if(!this.pointerStart)return;
    const p=worldPoint(this.pointerStart.center.lat,this.pointerStart.center.lon,this.zoom);
    this.center=geoPoint(p.x+this.pointerStart.x-e.clientX,p.y+this.pointerStart.y-e.clientY,this.zoom);
    this.queueDraw();
  }
  onUp(e){
    if(!this.fingers.has(e.pointerId))return;
    this.fingers.delete(e.pointerId);
    if(this.fingers.size===0){
      this.pointerStart=null;this.pinchStart=null;
      if(e.type==='pointerup'){
        const now=Date.now();if(now-this.lastTap<310){this.setZoom(this.zoom+1);this.lastTap=0;}else this.lastTap=now;
      }
    }else if(this.fingers.size===1){
      const a=[...this.fingers.values()][0];this.pointerStart={x:a.x,y:a.y,center:{...this.center}};this.pinchStart=null;
    }
  }
  setZoom(zoom){
    const value=Math.max(MIN_MAP_ZOOM,Math.min(MAX_MAP_ZOOM,Math.round(zoom)));
    if(value===this.zoom)return;
    this.zoom=value;this.queueDraw();
  }
  focusOn(lat,lon,zoom=16){
    if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)return;
    this.center={lat:clampLatitude(lat),lon};this.zoom=Math.max(MIN_MAP_ZOOM,Math.min(MAX_MAP_ZOOM,Math.round(zoom)));
    this.queueDraw();
  }
  reset(){this.own=null;this.contacts=[];this.center={lat:41.65,lon:12.48};this.zoom=6;this.queueDraw();}
  invalidateSize(){this.queueDraw();}
  queueDraw(){if(this.drawQueued)return;this.drawQueued=true;requestAnimationFrame(()=>{this.drawQueued=false;this.draw();});}
  draw(){
    const w=this.element.clientWidth,h=this.element.clientHeight;
    if(!w || !h)return;
    const z=this.zoom, n=2**z, size=MAP_TILE_SIZE*n, center=worldPoint(this.center.lat,this.center.lon,z);
    const left=center.x-w/2,top=center.y-h/2;
    const colMin=Math.floor(left/MAP_TILE_SIZE),colMax=Math.floor((left+w)/MAP_TILE_SIZE);
    const rowMin=Math.max(0,Math.floor(top/MAP_TILE_SIZE)),rowMax=Math.min(n-1,Math.floor((top+h)/MAP_TILE_SIZE));
    const seen=new Set();
    for(let col=colMin;col<=colMax;col++)for(let row=rowMin;row<=rowMax;row++){
      const normalizedX=((col%n)+n)%n, key=`${z}/${normalizedX}/${row}/${col}`;
      seen.add(key);
      let img=this.tilesByKey.get(key);
      if(!img){
        img=document.createElement('img');img.className='zyro-map-tile';img.alt='';img.draggable=false;
        img.decoding='async';img.loading='eager';
        const route=`${z}/${normalizedX}/${row}.png`;
        let source=0;
        img.addEventListener('load',()=>{this.loaded++;this.updateTileStatus();});
        img.addEventListener('error',()=>{
          source++;
          if(source===1){img.src=`https://tile.openstreetmap.org/${route}`;return;}
          if(source===2){img.src=`https://tile.openstreetmap.fr/hot/${route}`;return;}
          this.failed++;this.updateTileStatus();
        });
        img.src=`/api/map-tile/${route}`;
        this.tilesByKey.set(key,img);this.tiles.append(img);
      }
      img.style.transform=`translate3d(${Math.round(col*MAP_TILE_SIZE-left)}px,${Math.round(row*MAP_TILE_SIZE-top)}px,0)`;
    }
    for(const [key,tile] of this.tilesByKey){if(!seen.has(key)){tile.remove();this.tilesByKey.delete(key);}}
    // Real GPS and live shared contacts are drawn above the map raster.
    this.pins.replaceChildren();
    const pinAt=(lat,lon,markerClass,label,heading,accuracy)=>{
      if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)return;
      const p=worldPoint(lat,lon,z);
      let dx=p.x-center.x;if(dx>size/2)dx-=size;else if(dx<-size/2)dx+=size;
      const x=w/2+dx,y=h/2+p.y-center.y;
      if(x < -150||x > w+150 || y < -150||y > h+150)return;
      if(accuracy){
        const metersPerPixel=156543.03392*Math.cos(lat*Math.PI/180)/(2**z);
        const diameter=Math.min(480,Math.max(22,2*accuracy/metersPerPixel));
        const circle=document.createElement('div');circle.className='zyro-gps-accuracy';
        circle.style.left=`${x}px`;circle.style.top=`${y}px`;circle.style.width=`${diameter}px`;circle.style.height=`${diameter}px`;
        this.pins.append(circle);
      }
      const marker=document.createElement('div');marker.className=markerClass;marker.style.left=`${x}px`;marker.style.top=`${y}px`;
      marker.title=label;marker.setAttribute('aria-label',label);
      if(markerClass.includes('you')){
        if(Number.isFinite(heading)){const dir=document.createElement('span');dir.className='zyro-heading';dir.style.transform=`translateX(-50%) rotate(${heading}deg)`;marker.append(dir);}
        const dot=document.createElement('span');dot.className='zyro-you-dot';marker.append(dot);
      }else{marker.textContent=label.trim().charAt(0).toUpperCase()||'•';}
      this.pins.append(marker);
    };
    for(const c of this.contacts){pinAt(Number(c.location.lat),Number(c.location.lon),'zyro-map-pin zyro-pin-contact',c.name,null,null);}
    if(this.own)pinAt(this.own.lat,this.own.lon,'zyro-map-pin zyro-pin-you','Tu — posizione GPS',this.own.heading,this.own.accuracy);
  }
  updateTileStatus(){
    const fail=$('mapUnavailable');
    if(this.loaded>0){fail.classList.add('hidden');return;}
    if(this.failed>=3)fail.classList.remove('hidden');
  }
}
function renderMap(){
  if(!current || $('homeView').classList.contains('hidden'))return;
  if(!zyroMap)zyroMap=new ZyroNativeMap($('liveMap'));
  const contacts=uniqueContacts().filter(m=>m.location && Number.isFinite(Number(m.location.lat)) && Number.isFinite(Number(m.location.lon)));
  zyroMap.own=lastCoords;zyroMap.contacts=contacts;
  if(lastCoords){
    if(!ownCentered){zyroMap.focusOn(lastCoords.lat,lastCoords.lon,16);ownCentered=true;}
    $('mapStatus').textContent=`GPS · precisione ±${Math.round(lastCoords.accuracy||0)} m`;
  }else if(contacts.length && !ownCentered){
    zyroMap.focusOn(Number(contacts[0].location.lat),Number(contacts[0].location.lon),14);ownCentered=true;
    $('mapStatus').textContent='Mappa della tua cerchia · attiva il GPS per localizzarti';
  }else $('mapStatus').textContent=geolocationError||'Tocca «Trova la mia posizione» per localizzarti';
  zyroMap.queueDraw();
}
function onOrientation(e){
  let direction=Number.isFinite(e.webkitCompassHeading)?e.webkitCompassHeading:Number.isFinite(e.alpha)?(360-e.alpha)%360:null;
  if(direction===null)return;
  compassHeading=direction;
  if(lastCoords && !Number.isFinite(lastCoords.heading)){
    lastCoords.heading=direction;renderMap();
  }
}
async function orientationPermission(){
  try{
    if(typeof window.DeviceOrientationEvent?.requestPermission==='function'){
      const granted=await window.DeviceOrientationEvent.requestPermission();if(granted!=='granted')return;
    }
    window.removeEventListener('deviceorientation',onOrientation);
    window.addEventListener('deviceorientation',onOrientation);
  }catch{ /* Compass is optional. */ }
}
function renderPickControls(){
  if(!current)return;
  const contacts=uniqueContacts(), validIds=new Set(contacts.map(c=>c.id));
  for(const id of [...pickSelected])if(!validIds.has(id))pickSelected.delete(id);
  $('pickRecipientsList').innerHTML=contacts.length?contacts.map(c=>`<label><input type="checkbox" data-pickcontact="${escapeHtml(c.id)}" ${pickSelected.has(c.id)?'checked':''}><span>${escapeHtml(c.name)}</span></label>`).join(''):'<span class="empty-contacts">Prima aggiungi qualcuno a una cerchia.</span>';
  $('pickRecipients').classList.toggle('hidden',!$('pickNotify').checked);
  $('pickPanel').classList.toggle('armed',pickArmed);
  $('pickPanel').classList.toggle('alarming',theftTriggered);
  $('pickArm').textContent=pickArmed?'Disattiva Pick Pocket':'Attiva Pick Pocket';
  $('pickArm').disabled=theftTriggered;
  $('pickSensitivity').disabled=pickArmed;
  $('pickNotify').disabled=pickArmed;
  $('pickRecipientsList').querySelectorAll('input').forEach(el=>el.disabled=pickArmed);
  $('pickStatus').textContent=theftTriggered?'🚨 Movimento sospetto rilevato. Inserisci la password nella schermata di allarme.':pickArmed?'🟢 Pick Pocket attiva: tieni ZYRO 360 aperta. La protezione si ferma se il browser sospende i sensori.':'Protezione disattivata. Attivala solo per i test con l’app aperta.';
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
  if(pickArmed){pickArmed=false;window.removeEventListener('devicemotion',motionListener);updateGeo(null,current?.me?.sharing||!!current?.me?.sos||mapTracking);renderPickControls();toast('Pick Pocket disattivata.');return;}
  if($('pickNotify').checked && !pickSelected.size)throw Error('Seleziona almeno un familiare o un amico da avvisare.');
  await motionPermission();
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
    await refresh();renderPickControls();toast('Allarme antifurto terminato dal proprietario.');
  }finally{$('theftStop').disabled=false;}
}
async function previewSiren(){
  if(theftTriggered)return;
  startSiren();toast('Test sirena locale di 2 secondi, nessun avviso inviato.');
  setTimeout(()=>{if(!theftTriggered)stopSiren();},2000);
}
async function init(){
  const params=new URLSearchParams(location.search);inviteFromLink=params.get('invite');
  if(inviteFromLink && /^[A-Fa-f0-9]{18}$/.test(inviteFromLink)){history.replaceState(null,'',location.pathname);$('inviteInput').value=inviteFromLink.toUpperCase();}else inviteFromLink=null;
  document.querySelectorAll('.auth-tab').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));
  $('authForm').addEventListener('submit',e=>{e.preventDefault();action(async()=>{
    const payload={email:$('email').value.trim(),password:$('password').value};if(authMode==='register')payload.name=$('name').value.trim();
    $('authSubmit').disabled=true;try{await post(authMode==='login'?'/api/login':'/api/register',payload);const data=await api('/api/state');setState(data);connectSocket();if(inviteFromLink){showView('circles');toast('Codice di invito compilato: premi Entra per unirti alla cerchia.');}else toast('Benvenuto in Zyro 360!');}finally{$('authSubmit').disabled=false;}
  });});
  document.querySelectorAll('.nav-item').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));
  $('locateMe').addEventListener('click',()=>action(async()=>{mapTracking=true;void orientationPermission();updateGeo(null,true);if(lastCoords){zyroMap?.focusOn(lastCoords.lat,lastCoords.lon,Math.max(16,zyroMap.zoom));ownCentered=true;renderMap();}else toast('Ricerca posizione in corso. Consenti l’accesso al GPS se richiesto.');}));
  $('pickNotify').addEventListener('change',renderPickControls);
  $('pickRecipientsList').addEventListener('change',e=>{if(!e.target.matches('[data-pickcontact]'))return;const id=e.target.dataset.pickcontact;if(e.target.checked)pickSelected.add(id);else pickSelected.delete(id);});
  $('pickArm').addEventListener('click',()=>action(armPick));
  $('pickTest').addEventListener('click',()=>action(previewSiren));
  $('theftStop').addEventListener('click',()=>action(stopTheft));
  $('createCircleForm').addEventListener('submit',e=>{e.preventDefault();action(async()=>{await post('/api/circles',{name:$('circleName').value});$('circleName').value='';await refresh();toast('Cerchia creata! Ora puoi generare un invito.');});});
  $('joinCircleForm').addEventListener('submit',e=>{e.preventDefault();action(async()=>{await post('/api/invites/join',{code:$('inviteInput').value});$('inviteInput').value='';await refresh();inviteFromLink=null;toast('Ora fai parte della cerchia!');});});
  $('shareToggle').addEventListener('change',async e=>{const enabled=e.target.checked;await action(async()=>{await post('/api/sharing',{enabled});await refresh();toast(enabled?'Posizione condivisa con le tue cerchie.':'Condivisione della posizione interrotta.');});if(current)$('shareToggle').checked=!!current.me.sharing;});
  $('sosButton').addEventListener('click',()=>action(startSOS));
  $('stopSOS').addEventListener('click',()=>action(stopSOS));
  $('audioButton').addEventListener('click',()=>action(async()=>{if(localStream){stopAudio();toast('Microfono disattivato. Il tuo SOS rimane attivo.');}else await startAudio();}));
  $('sosRecipientList').addEventListener('change',()=>{sosPending=[...$('sosRecipientList').querySelectorAll('[data-sos-to]:checked')].map(x=>x.dataset.sosTo);});
  $('saveSOSRecipients').addEventListener('click',()=>action(async()=>{const recipients=[...$('sosRecipientList').querySelectorAll('[data-sos-to]:checked')].map(x=>x.dataset.sosTo);await post('/api/settings/sos-recipients',{recipients});sosPending=null;await refresh();toast('Destinatari SOS salvati.');}));
  for(const id of ['avatarCamera','avatarGallery'])$(id).addEventListener('change',e=>{const file=e.target.files?.[0];if(file)action(()=>saveAvatar(file));e.target.value='';});
  $('avatarRemove').addEventListener('click',()=>action(async()=>{await post('/api/profile/avatar',{avatar:null});await refresh();toast('Foto profilo rimossa.');}));
  $('chatClose').addEventListener('click',()=>{chatRoom=null;$('chatConversation').classList.add('hidden');});
  $('chatForm').addEventListener('submit',e=>{e.preventDefault();action(async()=>{const text=$('chatText').value.trim();if(!text&&!chatPhotoData)return;await sendChat(text,chatPhotoData);});});
  $('chatPhoto').addEventListener('change',e=>{const file=e.target.files?.[0];if(file)action(async()=>{chatPhotoData=await imageData(file,520,105000);$('chatPendingPhoto').textContent='📷 '+file.name+' pronta da inviare';});});
  document.querySelectorAll('[data-quick]').forEach(b=>b.addEventListener('click',()=>action(()=>sendChat(b.dataset.quick,null))));
  $('pushButton').addEventListener('click',()=>action(enablePush));
  $('closeListen').addEventListener('click',stopListening);
  $('logoutButton').addEventListener('click',()=>action(async()=>{if(theftTriggered)throw Error('Prima ferma l’antifurto usando la password del proprietario.');if(current?.me.sos && !confirm('Il tuo SOS è ancora attivo. Vuoi uscire? L’allarme resterà aperto ma GPS e microfono si interromperanno su questo dispositivo.'))return;stopListening();stopAudio();pickArmed=false;window.removeEventListener('devicemotion',motionListener);await post('/api/logout');if(watchId!==null)navigator.geolocation?.clearWatch(watchId);watchId=null;lastCoords=null;mapTracking=false;ownCentered=false;zyroMap?.reset();current=null;chatRoom=null;sosPending=null;socket?.close();socket=null;clearInterval(refreshTimer);$('appScreen').classList.add('hidden');$('authScreen').classList.remove('hidden');connection(false);$('password').value='';toast('Sei uscito dal tuo account.');}));
  if('serviceWorker'in navigator && location.protocol==='https:')navigator.serviceWorker.register('/sw.js').catch(()=>{});
  try{const data=await api('/api/state');setState(data);connectSocket();if(inviteFromLink){showView('circles');toast('Invito ricevuto: premi Entra per confermare.');}}catch{ /* Guest sees login */ }
  refreshTimer=setInterval(async()=>{if(current){try{await refresh();}catch{/* WebSocket reconnect handles live state */}}},45000);
  window.addEventListener('online',()=>{if(current){connectSocket();refresh().catch(()=>{});}});
  window.addEventListener('pagehide',()=>{ /* Browsers may suspend GPS, sensors and audio: never promise background safety. */ });
}
init();
