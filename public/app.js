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
let zyroVectorMap=null, zyroVectorAttempted=false, zyroVectorLoading=false;
const zyroVectorMarkers=new Map();
let compassHeading = null;
const ZYRO_THEME_KEY='zyro360-appearance-v8';
let zyroTheme='dark', zyroMap3D=true, vectorStyleIsChanging=false;
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
  $('shareToggle').closest('.zyro-command-share')?.classList.toggle('is-sharing',!!me.sharing);
  $('shareState').textContent=me.sharing?'LIVE':'OFF';
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
let chatCategory='all';
let chatSearch='';
const roomArrow=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;
const roomGroupIcon=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3.5 19v-2.1A4.9 4.9 0 0 1 8.4 12h1.2a4.9 4.9 0 0 1 4.9 4.9V19H3.5Z"/><path d="M16 5a3 3 0 0 1 0 6M18 13c2.1.5 3 1.9 3 4v2h-4"/></svg>`;
const roomChatIcon=`<svg class="zyro-chat-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.4a8.7 8.7 0 0 1-9.2 8.5 9.5 9.5 0 0 1-3.3-.65L3 21l1.8-5.12a8.4 8.4 0 0 1-1.8-4.48A8.8 8.8 0 0 1 12 3a8.7 8.7 0 0 1 9 8.4Z"/><path d="M8 11.8h.01M12 11.8h.01M16 11.8h.01"/></svg>`;
function renderChatRooms(){
  if(!current)return;
  const circles=current.circles||[], contacts=uniqueContacts();
  const matching=(name)=>String(name).toLocaleLowerCase('it').includes(chatSearch.toLocaleLowerCase('it'));
  const rooms=[];
  if(chatCategory!=='direct')for(const c of circles.filter(c=>matching(c.name)))rooms.push(`<button type="button" class="chat-room" data-typ="circle" data-id="${escapeHtml(c.id)}"><span class="chat-room-icon family-room-icon">${roomGroupIcon}</span><span class="chat-room-text"><b>${escapeHtml(c.name)}</b><small>Gruppo famiglia · ${c.members.length} ${c.members.length===1?'persona':'persone'}</small></span><span class="chat-room-chevron">${roomArrow}</span></button>`);
  if(chatCategory!=='circle')for(const u of contacts.filter(u=>matching(u.name)))rooms.push(`<button type="button" class="chat-room" data-typ="direct" data-id="${escapeHtml(u.id)}"><span class="chat-room-icon person-room-icon">${avatarHTML(u)}</span><span class="chat-room-text"><b>${escapeHtml(u.name)}</b><small>Messaggio privato · cerchia condivisa</small></span><span class="chat-room-chevron">${roomArrow}</span></button>`);
  const hasAny = circles.length||contacts.length;
  $('chatRooms').innerHTML=rooms.length?rooms.join(''):chatSearch?`<div class="chat-empty-view"><span class="chat-empty-symbol">${roomChatIcon}</span><h3>Nessun risultato</h3><p>Prova a cercare un altro nome.</p></div>`:hasAny?`<div class="chat-empty-view"><span class="chat-empty-symbol">${roomChatIcon}</span><h3>Non ci sono chat qui</h3><p>Seleziona un'altra categoria.</p></div>`:`<div class="chat-empty-view"><span class="chat-empty-symbol">${roomChatIcon}</span><h3>Ogni legame inizia da qui</h3><p>Crea una cerchia o invita una persona fidata per iniziare una conversazione.</p><button type="button" class="btn btn-primary" id="chatInviteNow">Vai alle Cerchie <span aria-hidden="true">→</span></button></div>`;
  $('chatRooms').querySelectorAll('.chat-room').forEach(b=>b.addEventListener('click',()=>openChat(b.dataset.typ,b.dataset.id)));
  $('chatInviteNow')?.addEventListener('click',()=>showView('circles'));
}
function openChat(type,id){chatRoom={type,id};showView('chats');$('chatsView').classList.add('is-conversation');$('chatConversation').classList.remove('hidden');const circle=current.circles.find(c=>c.id===id),user=uniqueContacts().find(u=>u.id===id);$('chatTitle').textContent=type==='circle' ? circle?.name||'Gruppo':user?.name||'Amico';$('chatSubtitle').textContent=type==='circle'?'Chat di gruppo · membri della cerchia':'Chat privata · solo voi due';loadChat().catch(e=>toast(e.message,true));}
async function loadChat(){
  const r=chatRoom;if(!r||!current)return;
  const response=await api(`/api/chat/${encodeURIComponent(r.type)}/${encodeURIComponent(r.id)}`);
  if(chatRoom!==r)return;
  const node=$('chatMessages');node.innerHTML=response.messages.length?response.messages.map(m=>`<article class="chat-bubble ${m.from===current.me.id?'mine':''}"><small>${escapeHtml(m.name)} · ${new Date(m.at).toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'})}</small>${m.text?`<p>${escapeHtml(m.text)}</p>`:''}${m.image?`<img loading="lazy" src="${m.image}" alt="Foto nella conversazione">`:''}</article>`).join(''):'<p class="chat-empty">Nessun messaggio. Inizia tu la conversazione!</p>';
  node.scrollTop=node.scrollHeight;
}
async function sendChat(text,image){if(!chatRoom)return;await post(`/api/chat/${encodeURIComponent(chatRoom.type)}/${encodeURIComponent(chatRoom.id)}`,{text,image});chatPhotoData=null;$('chatPendingPhoto').textContent='';$('chatPhoto').value='';$('chatText').value='';await loadChat();}

function renderSettings(){if(!current)return;$('profileName').textContent=current.me.name;$('profileEmail').textContent=current.me.email;setAvatar($('profileAvatar'),current.me);$('avatarRemove').disabled=!current.me.avatar;$('avatarRemove').classList.toggle('is-disabled',!current.me.avatar);$('pushButton').disabled=!current.pushEnabled;$('pushButton').textContent=current.pushEnabled?'Attiva notifiche SOS':'Notifiche push non configurate';}
function showView(view){activeView=view;for(const v of ['home','circles','modes','chats','settings'])$(`${v}View`).classList.toggle('hidden',v!==view);document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===view));window.scrollTo({top:0,behavior:'smooth'});if(view==='home'){requestAnimationFrame(()=>{renderMap();zyroMap?.invalidateSize();zyroVectorMap?.resize();});}}
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
// Google Maps is optional and requires a Google Cloud API key restricted to the site.
// Without a key, the on-screen free map remains functional using independent providers.
let googleMap=null,googleMarkers=[],googleInitAttempted=false,googleMapLoading=false;
async function maybeInitGoogleMap(){
  if(googleInitAttempted||googleMapLoading||!current)return;
  googleInitAttempted=true;googleMapLoading=true;
  try{
    const config=await api('/api/map-config');
    if(!config.googleMapsKey){googleMapLoading=false;return;}
    await new Promise((resolve,reject)=>{
      if(window.google?.maps?.Map){resolve();return;}
      const tag=document.createElement('script');tag.async=true;
      tag.src=`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(config.googleMapsKey)}&v=weekly&language=it`;
      tag.onload=()=>window.google?.maps?.Map?resolve():reject(Error('Google Maps non è stato caricato'));
      tag.onerror=()=>reject(Error('Rete o chiave Google Maps non disponibile'));
      document.head.append(tag);
    });
    const native=zyroMap;
    googleMap=new window.google.maps.Map($('googleMap'),{
      center:{lat:native?.center.lat??41.65,lng:native?.center.lon??12.48},zoom:native?.zoom??6,
      disableDefaultUI:true,zoomControl:true,gestureHandling:'greedy',clickableIcons:false,
      fullscreenControl:false,streetViewControl:false,mapTypeControl:false,
      styles:[{featureType:'poi',stylers:[{visibility:'off'}]},{featureType:'transit',stylers:[{visibility:'off'}]}]
    });
    $('googleMap').classList.remove('hidden');
    $('mapTiles').classList.add('hidden');$('mapPins').classList.add('hidden');
    $('mapAttribution').classList.add('hidden');$('mapUnavailable').classList.add('hidden');$('mapZoomControls')?.classList.add('hidden');
    document.querySelector('.map-top-label').lastChild.textContent=' GOOGLE MAPS · LIVE';
    syncGoogleMap();
  }catch(error){console.warn('Google Maps non disponibile. Cartografia alternativa attiva.',error);}
  finally{googleMapLoading=false;}
}
function googlePinIcon(isMe,heading){
  const arrow=Number.isFinite(heading)?`<path d="M26 10L35 30L26 26L17 30Z" fill="#1b72dd" transform="rotate(${Number(heading)} 26 28)"/>`:'';
  const svg=isMe?`<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 52 52"><circle cx="26" cy="26" r="23" fill="#148ee9" fill-opacity=".14"/>${arrow}<circle cx="26" cy="26" r="11" fill="white"/><circle cx="26" cy="26" r="7" fill="#1688ef"/></svg>`:`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="54" viewBox="0 0 48 54"><path d="M24 3c-10 0-18 8-18 18c0 14 18 29 18 29s18-15 18-29C42 11 34 3 24 3Z" fill="#13bfa4" stroke="white" stroke-width="3"/><circle cx="24" cy="21" r="7" fill="white" opacity=".9"/></svg>`;
  return {url:'data:image/svg+xml;charset=UTF-8,'+encodeURIComponent(svg),scaledSize:new google.maps.Size(isMe?52:48,isMe?52:54),anchor:new google.maps.Point(isMe?26:24,isMe?26:50)};
}
function syncGoogleMap(){
  if(!googleMap||!current)return;
  for(const marker of googleMarkers)marker.setMap(null);
  googleMarkers=[];
  const make=(lat,lon,title,isMe,heading)=>{
    const marker=new google.maps.Marker({map:googleMap,position:{lat:Number(lat),lng:Number(lon)},title,icon:googlePinIcon(isMe,heading),zIndex:isMe?10:2});
    googleMarkers.push(marker);
  };
  for(const user of uniqueContacts().filter(u=>u.location&&Number.isFinite(Number(u.location.lat))&&Number.isFinite(Number(u.location.lon))))make(user.location.lat,user.location.lon,user.name,false);
  if(lastCoords)make(lastCoords.lat,lastCoords.lon,'La tua posizione GPS',true,lastCoords.heading);
  const native=zyroMap;
  if(native && !googleMap.centerInitialized){
    googleMap.setCenter({lat:native.center.lat,lng:native.center.lon});googleMap.setZoom(native.zoom);googleMap.centerInitialized=true;
  }
}
function focusGoogleMap(lat,lon,zoom=16){if(googleMap){googleMap.panTo({lat:Number(lat),lng:Number(lon)});googleMap.setZoom(zoom);googleMap.centerInitialized=true;}}

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
    this.drawOrigin=null;this.panFrame=null;this.velocity={x:0,y:0};this.inertiaFrame=null;this.pinchFactor=1;
    this.pointerLast=null;
    this.loaded=0;this.failed=0;this.drawQueued=false;
    this.lastTap=0;this.own=null;this.contacts=[];
    element.addEventListener('pointerdown',e=>this.onDown(e));
    element.addEventListener('pointermove',e=>this.onMove(e));
    element.addEventListener('pointerup',e=>this.onUp(e));
    element.addEventListener('pointercancel',e=>this.onUp(e));
    element.addEventListener('wheel',e=>{if(zyroVectorMap||googleMap)return;if(!e.ctrlKey && !e.shiftKey)return;e.preventDefault();this.setZoom(this.zoom+(e.deltaY<0?1:-1));},{passive:false});
    this.resizeObserver=typeof ResizeObserver!=='undefined'?new ResizeObserver(()=>this.invalidateSize()):null;
    this.resizeObserver?.observe(element);
    window.addEventListener('resize',()=>this.invalidateSize());
    this.invalidateSize();
  }
  onDown(e){
    if(zyroVectorMap||googleMap)return;
    // Don't intercept links or buttons in the map overlays.
    if(e.target.closest('a,button,.map-attribution'))return;
    if(this.inertiaFrame){cancelAnimationFrame(this.inertiaFrame);this.inertiaFrame=null;}
    this.element.setPointerCapture?.(e.pointerId);
    this.fingers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(this.fingers.size===1){this.pointerStart={x:e.clientX,y:e.clientY,center:{...this.center}};this.pointerLast={x:e.clientX,y:e.clientY,ts:performance.now()};this.velocity={x:0,y:0};}
    if(this.fingers.size===2){
      const [a,b]=[...this.fingers.values()];this.pinchStart={distance:Math.hypot(a.x-b.x,a.y-b.y),zoom:this.zoom};this.pointerStart=null;this.pointerLast=null;
    }
  }
  onMove(e){
    if(zyroVectorMap||googleMap)return;
    if(!this.fingers.has(e.pointerId))return;
    this.fingers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(this.fingers.size===2 && this.pinchStart){
      const [a,b]=[...this.fingers.values()];const dist=Math.hypot(a.x-b.x,a.y-b.y);
      if(dist>0 && this.pinchStart.distance>0){
        this.pinchFactor=Math.max(.65,Math.min(2.6,dist/this.pinchStart.distance));
        this.previewMap(this.pinchFactor);
      }
      return;
    }
    if(!this.pointerStart)return;
    const p=worldPoint(this.pointerStart.center.lat,this.pointerStart.center.lon,this.zoom);
    this.center=geoPoint(p.x+this.pointerStart.x-e.clientX,p.y+this.pointerStart.y-e.clientY,this.zoom);
    const now=performance.now();
    if(this.pointerLast){const dt=now-this.pointerLast.ts;if(dt>0 && dt<120){this.velocity.x=.7*this.velocity.x+.3*(e.clientX-this.pointerLast.x)/dt;this.velocity.y=.7*this.velocity.y+.3*(e.clientY-this.pointerLast.y)/dt;}}
    this.pointerLast={x:e.clientX,y:e.clientY,ts:now};
    this.previewMap();
  }
  onUp(e){
    if(zyroVectorMap||googleMap){this.fingers.clear();return;}
    if(!this.fingers.has(e.pointerId))return;
    this.fingers.delete(e.pointerId);
    if(this.fingers.size===0){
      const didPinch=!!this.pinchStart;
      const zoomPreview=this.pinchFactor;
      this.pointerStart=null;this.pinchStart=null;this.pointerLast=null;this.pinchFactor=1;
      if(didPinch){this.setZoom(this.zoom+Math.round(Math.log2(zoomPreview)));this.queueDraw();return;}
      if(e.type==='pointerup'){
        const now=Date.now();if(now-this.lastTap<310){this.setZoom(this.zoom+1);this.lastTap=0;this.queueDraw();return;}else this.lastTap=now;
        this.startInertia();
      }
      this.queueDraw();
    }else if(this.fingers.size===1){
      const a=[...this.fingers.values()][0];this.pointerStart={x:a.x,y:a.y,center:{...this.center}};this.pinchStart=null;
    }
  }
  previewMap(scale=1){
    if(!this.drawOrigin){this.queueDraw();return;}
    const here=worldPoint(this.center.lat,this.center.lon,this.zoom);
    const dx=this.drawOrigin.x-here.x,dy=this.drawOrigin.y-here.y;
    // One GPU-friendly transform for all visible tiles, instead of re-positioning every image per finger movement.
    const matrix=`translate3d(${Math.round(dx)}px,${Math.round(dy)}px,0) scale(${scale})`;
    this.tiles.style.transform=matrix;this.pins.style.transform=matrix;
    if(Math.abs(dx)>170||Math.abs(dy)>170){this.queueDraw();}
  }
  startInertia(){
    if(this.fingers.size||Math.hypot(this.velocity.x,this.velocity.y)<.13)return;
    let vx=this.velocity.x,vy=this.velocity.y,last=performance.now(),frames=0;
    const step=(now)=>{
      if(this.fingers.size)return;
      const dt=Math.min(34,now-last);last=now;frames++;
      vx*=Math.pow(.90,dt/16);vy*=Math.pow(.90,dt/16);
      const center=worldPoint(this.center.lat,this.center.lon,this.zoom);
      this.center=geoPoint(center.x-vx*dt,center.y-vy*dt,this.zoom);
      this.previewMap();
      if(Math.hypot(vx,vy)>.085&&frames<40)this.inertiaFrame=requestAnimationFrame(step);
      else{this.inertiaFrame=null;this.queueDraw();}
    };
    this.inertiaFrame=requestAnimationFrame(step);
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
  reset(){if(this.inertiaFrame)cancelAnimationFrame(this.inertiaFrame);this.own=null;this.contacts=[];this.center={lat:41.65,lon:12.48};this.zoom=6;this.queueDraw();}
  invalidateSize(){this.queueDraw();}
  queueDraw(){if(this.drawQueued)return;this.drawQueued=true;requestAnimationFrame(()=>{this.drawQueued=false;this.draw();});}
  draw(){
    const w=this.element.clientWidth,h=this.element.clientHeight;
    if(!w || !h)return;
    const z=this.zoom, n=2**z, size=MAP_TILE_SIZE*n, center=worldPoint(this.center.lat,this.center.lon,z);
    this.tiles.style.transform='';this.pins.style.transform='';this.drawOrigin=center;
    const left=center.x-w/2,top=center.y-h/2;
    const pad=MAP_TILE_SIZE;
    const colMin=Math.floor((left-pad)/MAP_TILE_SIZE),colMax=Math.floor((left+w+pad)/MAP_TILE_SIZE);
    const rowMin=Math.max(0,Math.floor((top-pad)/MAP_TILE_SIZE)),rowMax=Math.min(n-1,Math.floor((top+h+pad)/MAP_TILE_SIZE));
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
          if(source===1){img.src=`/api/map-tile/${route}`;return;}
          this.failed++;this.updateTileStatus();
        });
        img.src=`https://tile.openstreetmap.org/${route}`;
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
    if(googleMap){fail.classList.add('hidden');return;}
    if(this.loaded>0){fail.classList.add('hidden');return;}
    if(this.failed>=3)fail.classList.remove('hidden');
  }
}

// ZYRO MAP V9: independent, authored cartographic design on real OSM vector data.
// Geometry/labels originate from OpenFreeMap (OpenMapTiles schema); no simulated roads.
function zyroMapStyle(theme='dark'){
  const dark=theme!=='light';
  const c=dark?{
    ground:'#081827', land:'#0b2033',district:'#0e2940',park:'#103d38',forest:'#17433e',
    water:'#082e44',waterLine:'#1b809b',building:'#16334b',buildingEdge:'#35677a',roof:'#2a5168',
    path:'#236557',minor:'#23516b',motorway:'#32c2cf',main:'#26e1db',mid:'#2a9da9',roadCore:'#b0fff0',
    glow:'#00d8df',label:'#e8fbff',smallLabel:'#9abdd2',place:'#dffff9',halo:'#091b2e',poi:'#55d7cd',
    outline:'#0b2941',boundary:'#38667b',badge:'#10f1d2'
  }:{
    ground:'#e7f4f5',land:'#f0f9f9',district:'#deefef',park:'#bde9d5',forest:'#a4d7c4',
    water:'#a4dce6',waterLine:'#3ba3b4',building:'#d0e3e9',buildingEdge:'#a5c0c9',roof:'#b7d5e0',
    path:'#78bca7',minor:'#ffffff',motorway:'#43a8bf',main:'#43c5c2',mid:'#88d2d1',roadCore:'#ffffff',
    glow:'#38c6c4',label:'#1c4c61',smallLabel:'#47778a',place:'#153f51',halo:'#f0f9f9',poi:'#158c7b',
    outline:'#c5dcde',boundary:'#a4c7cc',badge:'#128e87'
  };
  const S='openmaptiles';
  const name=['coalesce',['get','name:latin'],['get','name:en'],['get','name'],''];
  const zm=(...stops)=>['interpolate',['linear'],['zoom'],...stops];
  const major=['in',['get','class'],['literal',['motorway','trunk','primary']]];
  const arterial=['in',['get','class'],['literal',['motorway','trunk','primary','secondary','tertiary']]];
  const local=['in',['get','class'],['literal',['minor','residential','living_street','service']]];
  const foot=['in',['get','class'],['literal',['path','track','pedestrian','footway','steps']]];
  const roadColors=['match',['get','class'],'motorway',c.motorway,'trunk',c.motorway,'primary',c.main,'secondary',c.mid,'tertiary',c.mid,'residential',c.minor,'minor',c.minor,'service',c.minor,'living_street',c.minor,'path',c.path,'pedestrian',c.path,'footway',c.path,c.minor];
  const L=[];
  const add=(id,type,sourceLayer,extra={})=>{
    const obj={id,type,...(sourceLayer?{source:S,'source-layer':sourceLayer}:{}) ,...extra};L.push(obj);return obj;
  };
  add('zyro-background','background',null,{paint:{'background-color':c.ground}});
  add('zyro-land','fill','landcover',{paint:{'fill-color':c.land,'fill-opacity':.89}});
  add('zyro-district','fill','landuse',{filter:['in',['get','class'],['literal',['residential','commercial','industrial']]],paint:{'fill-color':c.district,'fill-opacity':.52}});
  add('zyro-green-land','fill','landcover',{filter:['in',['get','class'],['literal',['wood','forest','grass','scrub']]],paint:{'fill-color':c.forest,'fill-opacity':.87}});
  add('zyro-parks','fill','park',{paint:{'fill-color':c.park,'fill-opacity':.94}});
  add('zyro-parks-alt','fill','landuse',{filter:['in',['get','class'],['literal',['park','grass','cemetery','recreation_ground','garden','allotments']]],paint:{'fill-color':c.park,'fill-opacity':.9}});
  add('zyro-water','fill','water',{paint:{'fill-color':c.water}});
  add('zyro-water-edge','line','water',{paint:{'line-color':c.waterLine,'line-width':zm(4,.2,12,.8,17,1.8),'line-opacity':dark?.62:.55}});
  add('zyro-waterway','line','waterway',{paint:{'line-color':c.waterLine,'line-width':zm(8,.2,14,1.2,18,2.5),'line-opacity':.76}});
  add('zyro-rail','line','transportation',{filter:['==',['get','class'],'rail'],paint:{'line-color':dark?'#43627c':'#aec5ce','line-width':zm(9,.4,15,1.8,18,3),'line-dasharray':[2,2],'line-opacity':.8}});
  // Colored housing blocks and realistic heights come exclusively from vector building features.
  add('zyro-building-shadow','fill','building',{minzoom:12,paint:{'fill-color':c.outline,'fill-opacity':zm(12,.18,16,.72)}});
  add('zyro-building-area','fill','building',{minzoom:13,paint:{'fill-color':c.building,'fill-outline-color':c.buildingEdge,'fill-opacity':zm(13,.46,16,.95)}});
  // Road geometry is shared with all normal cartographic maps; only rendering is unique.
  add('zyro-road-casing','line','transportation',{filter:['!=',['get','class'],'rail'],layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':dark?'#061522':'#c5e0e4','line-width':zm(8,1.5,12,3.2,15,7.5,18,19),'line-opacity':.9}});
  add('zyro-street-base','line','transportation',{filter:['all',['!=',['get','class'],'rail'],['!',foot]],layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':roadColors,'line-width':zm(8,.8,12,1.6,15,4,18,12),'line-opacity':dark?.9:.94}});
  add('zyro-walking-tracks','line','transportation',{filter:foot,minzoom:14,layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':c.path,'line-width':zm(14,.5,18,2),'line-dasharray':[1.3,2], 'line-opacity':.74}});
  add('zyro-arterial-glow','line','transportation',{filter:arterial,minzoom:10,layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':c.glow,'line-width':zm(10,1,13,4,16,12,19,24),'line-blur':dark?5.5:2,'line-opacity':dark?.55:.19}});
  add('zyro-arterial-color','line','transportation',{filter:arterial,layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':roadColors,'line-width':zm(8,1,12,2.1,15,4.6,18,11),'line-opacity':1}});
  add('zyro-arterial-core','line','transportation',{filter:major,minzoom:13,layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':c.roadCore,'line-width':zm(13,.35,16,1,18,2.2),'line-opacity':dark?.53:.7}});
  add('zyro-building-3d','fill-extrusion','building',{minzoom:14,paint:{'fill-extrusion-color':c.roof,'fill-extrusion-height':zm(14,0,16,['coalesce',['get','render_height'],['get','height'],10]),'fill-extrusion-base':zm(14,0,16,['coalesce',['get','render_min_height'],['get','min_height'],0]),'fill-extrusion-opacity':dark?.78:.53,'fill-extrusion-vertical-gradient':true}});
  add('zyro-boundaries','line','boundary',{minzoom:4,filter:['<=',['get','admin_level'],4],paint:{'line-color':c.boundary,'line-opacity':.45,'line-dasharray':[3,3],'line-width':zm(4,.45,10,1.4)}});
  // Only a short list of useful landmark labels, with no visual clutter at street level.
  const label=(id,sourceLayer,filter,minzoom,size,color,layoutExtra={},paintExtra={})=>add(id,'symbol',sourceLayer,{
    minzoom, ...(filter?{filter}:{}),layout:{'text-field':name,'text-font':['Noto Sans Regular'],'text-size':size,'text-letter-spacing':.02,'text-max-width':10,'text-allow-overlap':false,...layoutExtra},
    paint:{'text-color':color,'text-halo-color':c.halo,'text-halo-width':dark?1.9:1.4,'text-halo-blur':.35,...paintExtra}
  });
  label('zyro-cities','place',['in',['get','class'],['literal',['city','town']]],4,zm(4,11,8,14,13,18),c.place,{'text-transform':'uppercase','text-max-width':14},{'text-halo-width':2.2});
  label('zyro-neighborhoods','place',['in',['get','class'],['literal',['village','suburb','neighbourhood','quarter']]],11,zm(11,10,16,13),c.smallLabel);
  label('zyro-road-names','transportation_name',null,13,zm(13,9,16,11,19,13),c.smallLabel,{'symbol-placement':'line','text-rotation-alignment':'map','symbol-spacing':260,'text-padding':8,'text-max-angle':35});
  label('zyro-park-names','park',null,13,zm(13,10,17,12),c.poi,{'text-transform':'uppercase'});
  label('zyro-hospital-labels','poi',['in',['get','class'],['literal',['hospital','clinic','doctors']]],14,zm(14,10,18,12),dark?'#ffa5ba':'#a74f65');
  label('zyro-school-labels','poi',['in',['get','class'],['literal',['school','college','university']]],14,zm(14,10,18,12),dark?'#f1d79d':'#967143');
  return {version:8,name:`ZYRO 360 • ${dark?'Midnight':'Daylight'}`,glyphs:'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources:{openmaptiles:{type:'vector',url:'https://tiles.openfreemap.org/planet',attribution:'© OpenFreeMap · © OpenStreetMap contributors'}},layers:L};
}
// Unlike the older releases, no provider style is recolored after loading.
// The style itself (all layers, palette and labeling rules) belongs to ZYRO 360.
function zyroStyleUrl(){return zyroMapStyle(zyroTheme);}
function zyroStylePaint(){/* ZYRO's complete style is assembled before rendering. */}
function currentZyroPitch(){return zyroMap3D&&Math.max(zyroVectorMap?.getZoom()||0,lastCoords?16:0)>=14?52:0;}
function update3DView(){
 const button=$('mapTilt');if(button){button.disabled=!zyroVectorMap;button.textContent=zyroMap3D?'3D':'2D';button.setAttribute('aria-pressed',String(zyroMap3D));button.title=zyroMap3D?'Disattiva la prospettiva 3D':'Attiva la prospettiva 3D';}
 if(zyroVectorMap)zyroVectorMap.easeTo({pitch:zyroMap3D?52:0,duration:530,essential:true});
}
function applyZyroTheme(next,persist=true){
 zyroTheme=next==='light'?'light':'dark';
 document.documentElement.dataset.theme=zyroTheme;
 document.querySelector('meta[name="theme-color"]')?.setAttribute('content',zyroTheme==='dark'?'#071626':'#0b1831');
 for(const btn of document.querySelectorAll('[data-theme-choice]')){
  const selected=btn.dataset.themeChoice===zyroTheme;
  btn.classList.toggle('is-selected',selected);btn.setAttribute('aria-pressed',String(selected));
 }
 if(persist){try{localStorage.setItem(ZYRO_THEME_KEY,zyroTheme);}catch{}}
 if(zyroVectorMap && !vectorStyleIsChanging){
  vectorStyleIsChanging=true;
  try{zyroVectorMap.setStyle(zyroStyleUrl());}catch(e){vectorStyleIsChanging=false;console.warn('Tema mappa non disponibile',e);}
 }else if(zyroMap){zyroMap.queueDraw();}
}
function zyroVectorMarker(isMe,heading,person){
  const el=document.createElement('div');
  el.className=isMe?'zyro-gl-location':'zyro-gl-contact';
  if(isMe){
    const ring=document.createElement('span'),arrow=document.createElement('span'),core=document.createElement('span');
    ring.className='zyro-gl-ring';arrow.className='zyro-gl-arrow';core.className='zyro-gl-core';
    arrow.style.transform=`rotate(${Number.isFinite(heading)?heading:0}deg)`;
    el.append(ring,arrow,core);
  }else el.textContent=String(person||'?').trim().charAt(0).toUpperCase()||'?';
  el.title=isMe?'La tua posizione GPS':String(person||'Contatto');
  el.setAttribute('aria-label',el.title);
  return el;
}
function syncZyroVector(){
  if(!zyroVectorMap||!current)return;
  const people=uniqueContacts().filter(u=>u.location&&Number.isFinite(Number(u.location.lat))&&Number.isFinite(Number(u.location.lon)));
  const wanted=new Set();
  const points=people.map(u=>({id:'contact:'+u.id,lon:Number(u.location.lon),lat:Number(u.location.lat),heading:null,name:u.name}));
  if(lastCoords)points.push({id:'me',lon:Number(lastCoords.lon),lat:Number(lastCoords.lat),heading:lastCoords.heading,name:'Tu'});
  for(const p of points){
    if(Math.abs(p.lat)>85||Math.abs(p.lon)>180)continue;
    wanted.add(p.id);let mark=zyroVectorMarkers.get(p.id);
    if(!mark){
      const elem=zyroVectorMarker(p.id==='me',p.heading,p.name);
      mark=new window.maplibregl.Marker({element:elem,anchor:'center'}).setLngLat([p.lon,p.lat]).addTo(zyroVectorMap);
      zyroVectorMarkers.set(p.id,mark);
    }else mark.setLngLat([p.lon,p.lat]);
    const arrow=mark.getElement().querySelector('.zyro-gl-arrow');
    if(arrow&&Number.isFinite(p.heading))arrow.style.transform=`rotate(${p.heading}deg)`;
  }
  for(const [id,mark]of zyroVectorMarkers){if(!wanted.has(id)){mark.remove();zyroVectorMarkers.delete(id);}}
}
function focusZyroVector(lat,lon,zoom=16){
  if(!zyroVectorMap||!Number.isFinite(Number(lat))||!Number.isFinite(Number(lon)))return;
  zyroVectorMap.easeTo({center:[Number(lon),Number(lat)],zoom:Math.min(19,Math.max(3,zoom)),pitch:zyroMap3D?52:0,duration:580,essential:true});
}
function resetZyroVector(){
  for(const mark of zyroVectorMarkers.values())mark.remove();zyroVectorMarkers.clear();
  if(zyroVectorMap){zyroVectorMap.remove();zyroVectorMap=null;}
  zyroVectorAttempted=false;zyroVectorLoading=false;vectorStyleIsChanging=false;
  $('zyroVectorMap').classList.add('hidden');
  $('mapTiles').classList.remove('hidden');$('mapPins').classList.remove('hidden');
  $('mapZoomControls').classList.remove('hidden');update3DView();
}
function maybeInitZyroVector(){
  if(zyroVectorMap||zyroVectorAttempted||zyroVectorLoading||!current||!window.maplibregl?.Map)return;
  if(!window.maplibregl.supported?.())return;
  const el=$('zyroVectorMap');if(!el||!el.clientWidth||!el.clientHeight)return;
  zyroVectorAttempted=true;zyroVectorLoading=true;
  let candidate=null,ready=false;
  const fallback=()=>{
    if(ready)return;
    zyroVectorLoading=false;
    try{candidate?.remove();}catch{}
    el.classList.add('hidden');
  };
  // A failed remote provider never removes the existing raster map.
  const timeout=setTimeout(fallback,11000);
  try{
    const pos=lastCoords?{lat:lastCoords.lat,lon:lastCoords.lon,zoom:16}:
      zyroMap?{lat:zyroMap.center.lat,lon:zyroMap.center.lon,zoom:zyroMap.zoom}:{lat:41.9,lon:12.5,zoom:6};
    candidate=new window.maplibregl.Map({container:el,style:zyroStyleUrl(),center:[pos.lon,pos.lat],zoom:pos.zoom,minZoom:3,maxZoom:19,pitch:zyroMap3D&&pos.zoom>=14?52:0,bearing:0,
      attributionControl:false,dragRotate:false,touchPitch:false,pitchWithRotate:false,scrollZoom:false,dragPan:true,touchZoomRotate:true,
      fadeDuration:170,antialias:false,renderWorldCopies:true,cooperativeGestures:false});
    candidate.on('load',()=>{
      if(!current){clearTimeout(timeout);fallback();return;}
      ready=true;zyroVectorLoading=false;clearTimeout(timeout);zyroVectorMap=candidate;
      if(zyroMap){zyroMap.fingers.clear();zyroMap.pointerStart=null;}
      update3DView();
      zyroStylePaint(candidate);
      el.classList.remove('hidden');
      $('mapTiles').classList.add('hidden');$('mapPins').classList.add('hidden');
      $('mapUnavailable').classList.add('hidden');
      $('mapSourceCredit').textContent='© OpenFreeMap';
      $('mapSourceCredit').href='https://openfreemap.org/';
      syncZyroVector();candidate.resize();
      candidate.on('zoomend',()=>{if(zyroMap3D && candidate.getZoom()>=14 && candidate.getPitch()<20)candidate.easeTo({pitch:52,duration:350});});
    });
    candidate.on('style.load',()=>{
      if(!ready)return; // first style is handled by 'load'
      vectorStyleIsChanging=false;zyroStylePaint(candidate);syncZyroVector();
    });
    candidate.on('error',error=>{console.warn('ZYRO MAP: stile o tile vettoriali non disponibili.',error?.error?.message||'errore');vectorStyleIsChanging=false;});
  }catch(error){console.warn('ZYRO MAP: mappa di riserva attiva',error);clearTimeout(timeout);fallback();}
}

function renderMap(){
  if(!current || $('homeView').classList.contains('hidden'))return;
  if(!zyroMap)zyroMap=new ZyroNativeMap($('liveMap'));
  const contacts=uniqueContacts().filter(m=>m.location && Number.isFinite(Number(m.location.lat)) && Number.isFinite(Number(m.location.lon)));
  zyroMap.own=lastCoords;zyroMap.contacts=contacts;
  if(lastCoords){
    if(!ownCentered){zyroMap.focusOn(lastCoords.lat,lastCoords.lon,16);focusZyroVector(lastCoords.lat,lastCoords.lon,16);ownCentered=true;}
    $('mapStatus').textContent=`GPS · precisione ±${Math.round(lastCoords.accuracy||0)} m`;
  }else if(contacts.length && !ownCentered){
    zyroMap.focusOn(Number(contacts[0].location.lat),Number(contacts[0].location.lon),14);focusZyroVector(Number(contacts[0].location.lat),Number(contacts[0].location.lon),14);ownCentered=true;
    $('mapStatus').textContent='Mappa della tua cerchia · attiva il GPS per localizzarti';
  }else $('mapStatus').textContent=geolocationError||'Tocca «Trova la mia posizione» per localizzarti';
  const googLink=$('mapOpenGoogle');
  if(googLink && lastCoords)googLink.href='https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(lastCoords.lat+','+lastCoords.lon);
  if(zyroVectorMap){syncZyroVector();return;}
  $('mapSourceCredit').textContent='Dati OSM';
  $('mapSourceCredit').href='https://www.openstreetmap.org/copyright';
  zyroMap.queueDraw();maybeInitZyroVector();
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
  let storedTheme=null;try{storedTheme=localStorage.getItem(ZYRO_THEME_KEY);}catch{}
  applyZyroTheme(storedTheme||'dark',false);
  for(const button of document.querySelectorAll('[data-theme-choice]'))button.addEventListener('click',()=>applyZyroTheme(button.dataset.themeChoice));
  $('mapTilt')?.addEventListener('click',()=>{zyroMap3D=!zyroMap3D;update3DView();});
  update3DView();
  const params=new URLSearchParams(location.search);inviteFromLink=params.get('invite');
  if(inviteFromLink && /^[A-Fa-f0-9]{18}$/.test(inviteFromLink)){history.replaceState(null,'',location.pathname);$('inviteInput').value=inviteFromLink.toUpperCase();}else inviteFromLink=null;
  document.querySelectorAll('.auth-tab').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));
  $('authForm').addEventListener('submit',e=>{e.preventDefault();action(async()=>{
    const payload={email:$('email').value.trim(),password:$('password').value};if(authMode==='register')payload.name=$('name').value.trim();
    $('authSubmit').disabled=true;try{await post(authMode==='login'?'/api/login':'/api/register',payload);const data=await api('/api/state');setState(data);connectSocket();if(inviteFromLink){showView('circles');toast('Codice di invito compilato: premi Entra per unirti alla cerchia.');}else toast('Benvenuto in Zyro 360!');}finally{$('authSubmit').disabled=false;}
  });});
  document.querySelectorAll('.nav-item').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));
  $('mapZoomIn').addEventListener('click',()=>{if(zyroVectorMap){zyroVectorMap.zoomTo(Math.min(19,zyroVectorMap.getZoom()+1),{duration:230});}else zyroMap?.setZoom(zyroMap.zoom+1);});
  $('mapZoomOut').addEventListener('click',()=>{if(zyroVectorMap){zyroVectorMap.zoomTo(Math.max(3,zyroVectorMap.getZoom()-1),{duration:230});}else zyroMap?.setZoom(zyroMap.zoom-1);});
  $('locateMe').addEventListener('click',()=>action(async()=>{mapTracking=true;void orientationPermission();updateGeo(null,true);if(lastCoords){zyroMap?.focusOn(lastCoords.lat,lastCoords.lon,Math.max(16,zyroMap.zoom));focusZyroVector(lastCoords.lat,lastCoords.lon,Math.max(16,zyroMap.zoom));ownCentered=true;renderMap();}else toast('Ricerca posizione in corso. Consenti l’accesso al GPS se richiesto.');}));
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
  document.querySelectorAll('[data-chat-filter]').forEach(b=>b.addEventListener('click',()=>{chatCategory=b.dataset.chatFilter;document.querySelectorAll('[data-chat-filter]').forEach(t=>{const on=t===b;t.classList.toggle('active',on);t.setAttribute('aria-pressed',String(on));});renderChatRooms();}));
  $('chatSearch').addEventListener('input',e=>{chatSearch=e.target.value.trim();renderChatRooms();});
  $('chatClose').addEventListener('click',()=>{chatRoom=null;$('chatConversation').classList.add('hidden');$('chatsView').classList.remove('is-conversation');});
  $('chatForm').addEventListener('submit',e=>{e.preventDefault();action(async()=>{const text=$('chatText').value.trim();if(!text&&!chatPhotoData)return;await sendChat(text,chatPhotoData);});});
  $('chatPhoto').addEventListener('change',e=>{const file=e.target.files?.[0];if(file)action(async()=>{chatPhotoData=await imageData(file,520,105000);$('chatPendingPhoto').textContent='📷 '+file.name+' pronta da inviare';});});
  document.querySelectorAll('[data-quick]').forEach(b=>b.addEventListener('click',()=>action(()=>sendChat(b.dataset.quick,null))));
  $('pushButton').addEventListener('click',()=>action(enablePush));
  $('closeListen').addEventListener('click',stopListening);
  $('logoutButton').addEventListener('click',()=>action(async()=>{if(theftTriggered)throw Error('Prima ferma l’antifurto usando la password del proprietario.');if(current?.me.sos && !confirm('Il tuo SOS è ancora attivo. Vuoi uscire? L’allarme resterà aperto ma GPS e microfono si interromperanno su questo dispositivo.'))return;stopListening();stopAudio();pickArmed=false;window.removeEventListener('devicemotion',motionListener);await post('/api/logout');if(watchId!==null)navigator.geolocation?.clearWatch(watchId);watchId=null;lastCoords=null;mapTracking=false;ownCentered=false;zyroMap?.reset();resetZyroVector();googleMarkers.forEach(m=>m.setMap(null));googleMarkers=[];googleMap=null;$('googleMap').classList.add('hidden');$('mapTiles').classList.remove('hidden');$('mapPins').classList.remove('hidden');$('mapAttribution').classList.remove('hidden');googleInitAttempted=false;current=null;chatRoom=null;sosPending=null;socket?.close();socket=null;clearInterval(refreshTimer);$('appScreen').classList.add('hidden');$('authScreen').classList.remove('hidden');connection(false);$('password').value='';toast('Sei uscito dal tuo account.');}));
  if('serviceWorker'in navigator && location.protocol==='https:')navigator.serviceWorker.register('/sw.js?v=8.0-zyromap-3d-temi').catch(()=>{});
  try{const data=await api('/api/state');setState(data);connectSocket();if(inviteFromLink){showView('circles');toast('Invito ricevuto: premi Entra per confermare.');}}catch{ /* Guest sees login */ }
  refreshTimer=setInterval(async()=>{if(current){try{await refresh();}catch{/* WebSocket reconnect handles live state */}}},45000);
  window.addEventListener('online',()=>{if(current){connectSocket();refresh().catch(()=>{});}});
  window.addEventListener('pagehide',()=>{ /* Browsers may suspend GPS, sensors and audio: never promise background safety. */ });
}
init();
