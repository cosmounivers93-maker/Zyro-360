/* Zyro 360: authenticated chat unread counts and personal conversation reset. */
(function(){
'use strict';
if(window.ZyroChatNotificationsV1)return;
window.ZyroChatNotificationsV1=true;
const $=id=>document.getElementById(id);
let owner='',cache=new Map(),lastTotal=0,lastError=0,fetching=false,refreshAgain=false;
let modal=null,tick=null;
function account(){try{return !document.getElementById('appScreen')?.classList.contains('hidden')&&current?.me?.id?String(current.me.id):'';}catch{return '';}}
function roomKey(type,id){return type+':'+id;}
function online(){return document.visibilityState!=='hidden'&&navigator.onLine!==false;}
function rooms(){return $('chatRooms');}
function nodeName(type,id){
 try{
  if(type==='circle')return current?.circles?.find(x=>x.id===id)?.name||'Gruppo famiglia';
  const contacts=typeof uniqueContacts==='function'?uniqueContacts():[];
  return contacts.find(x=>x.id===id)?.name||'Contatto';
 }catch{return 'Contatto';}
}
function notify(message){
 if(typeof toast==='function')toast(message);
}
async function summary(){
 const response=await fetch('/api/chat/summary',{credentials:'same-origin',cache:'no-store'});
 if(!response.ok)throw Error(response.status===404?'Il server richiede l’aggiornamento della funzione chat.':'Impossibile aggiornare i messaggi ('+response.status+').');
 const result=await response.json();
 if(!Array.isArray(result.rooms))throw Error('Elenco delle conversazioni non valido.');
 return result.rooms;
}
async function refresh(){
 const id=account();if(!id||!online())return;
 if(fetching){refreshAgain=true;return;}
 fetching=true;
 try{
  const data=await summary();
  if(id!==account())return;
  cache=new Map(data.filter(x=>['circle','direct'].includes(x.type)&&typeof x.id==='string').map(x=>[roomKey(x.type,x.id),x]));
  decorate();
 }catch(e){
  if(Date.now()-lastError>60000){lastError=Date.now();console.warn('[Zyro chat]',e.message);}
 }finally{
  fetching=false;
  if(refreshAgain){refreshAgain=false;void refresh();}
 }
}
function badge(count){
 const b=document.createElement('span');b.className='zyro-chat-badge';
 b.textContent=count>99?'99+':String(count);
 b.setAttribute('aria-label',count+' messaggi non letti');return b;
}
function decorate(){
 const id=account(),list=rooms();if(!id||!list)return;
 const wrappers=[...list.querySelectorAll('.zyro-chat-line')];
 for(const wrapper of wrappers)updateLine(wrapper);
 let total=0;
 for(const data of cache.values())total+=Math.max(0,Number(data.unread)||0);
 lastTotal=total;
 const nav=document.querySelector('.nav-item[data-view="chats"]');
 if(nav){
  let marker=nav.querySelector('.zyro-chat-total');
  if(!total){marker?.remove();}
  else{
   if(!marker){marker=document.createElement('span');marker.className='zyro-chat-total';marker.setAttribute('aria-label','Messaggi non letti');nav.append(marker);}
   marker.textContent=total>99?'99+':String(total);
   marker.setAttribute('aria-label',total+' messaggi non letti');
  }
 }
}
function updateLine(wrapper){
 const item=wrapper.querySelector('.chat-room');if(!item)return;
 const type=item.dataset.typ,roomId=item.dataset.id;
 const info=cache.get(roomKey(type,roomId)),unread=Math.max(0,Number(info?.unread)||0);
 const hidden=!!info?.hidden;
 const search=typeof chatSearch!=='undefined'?String(chatSearch||'').trim():'';
 wrapper.hidden=hidden&&!search;
 wrapper.classList.toggle('has-unread',unread>0);
 wrapper.querySelector('.zyro-chat-badge')?.remove();
 const chevron=item.querySelector('.chat-room-chevron');
 if(unread){
  const b=badge(unread);
  if(chevron)chevron.before(b);else item.append(b);
 }
 const text=item.querySelector('.chat-room-text');
 if(text){
  let snippet=text.querySelector('.zyro-chat-preview');
  if(info?.lastAt){
   if(!snippet){snippet=document.createElement('small');snippet.className='zyro-chat-preview';text.append(snippet);}
   snippet.textContent=(info.lastName||'Contatto')+': '+(info.preview||'Nuovo messaggio');
  }else snippet?.remove();
 }
 item.setAttribute('aria-label',nodeName(type,roomId)+(unread?' · '+unread+' messaggi non letti':'')+' · tocca per aprire, tieni premuto per eliminare');
}
function askToClear(type,id){
 if(modal||!account())return;
 const name=nodeName(type,id);
 const overlay=document.createElement('div');overlay.className='zyro-chat-tools-overlay';
 const panel=document.createElement('div');panel.className='zyro-chat-tools-card';panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');
 const title=document.createElement('h3');title.textContent='Eliminare la chat con '+name+'?';title.id='zyroClearChatTitle';
 panel.setAttribute('aria-labelledby',title.id);
 const desc=document.createElement('p');
 desc.textContent='La conversazione e i messaggi precedenti scompariranno soltanto dal tuo account. Gli altri partecipanti non perderanno i loro messaggi. Se ricevi un nuovo messaggio, la chat tornerà visibile.';
 const yes=document.createElement('button');yes.type='button';yes.className='zyro-chat-delete';yes.textContent='Elimina chat per me';
 const no=document.createElement('button');no.type='button';no.className='zyro-chat-cancel';no.textContent='Annulla';
 panel.append(title,desc,yes,no);overlay.append(panel);document.body.append(overlay);modal=overlay;
 const previous=document.activeElement;no.focus();
 function close(){overlay.remove();if(modal===overlay)modal=null;if(previous?.isConnected)previous.focus();}
 no.addEventListener('click',close);
 overlay.addEventListener('click',e=>{if(e.target===overlay)close();});
 overlay.addEventListener('keydown',e=>{
  if(e.key==='Escape'){e.preventDefault();close();}
  if(e.key==='Tab'){
   const opts=[yes,no],at=opts.indexOf(document.activeElement);
   if(e.shiftKey&&at===0){e.preventDefault();no.focus();}
   else if(!e.shiftKey&&at===1){e.preventDefault();yes.focus();}
  }
 });
 yes.addEventListener('click',async()=>{
  if(yes.disabled)return;
  yes.disabled=true;yes.textContent='Eliminazione…';
  try{
   const response=await fetch('/api/chat/'+encodeURIComponent(type)+'/'+encodeURIComponent(id)+'/clear',{
    method:'POST',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},body:'{}'
   });
   if(!response.ok){const body=await response.json().catch(()=>({}));throw Error(body.error||'Impossibile eliminare la conversazione.');}
   if(typeof chatRoom!=='undefined'&&chatRoom?.type===type&&chatRoom?.id===id&&typeof closeChat==='function')closeChat();
   close();notify('Conversazione eliminata solo per te.');
   await refresh();
  }catch(err){yes.disabled=false;yes.textContent='Elimina chat per me';notify(err.message);}
 });
}
function hookRow(button){
 if(button.closest('.zyro-chat-line'))return;
 const wrapper=document.createElement('div');wrapper.className='zyro-chat-line';
 button.before(wrapper);wrapper.append(button);
 const more=document.createElement('button');more.type='button';more.className='zyro-chat-extra';
 more.textContent='⋯';more.setAttribute('aria-label','Opzioni chat con '+nodeName(button.dataset.typ,button.dataset.id));
 wrapper.append(more);
 more.addEventListener('click',()=>askToClear(button.dataset.typ,button.dataset.id));
 let timer=null,held=false,startX=0,startY=0;
 button.addEventListener('pointerdown',e=>{
  if(e.button!==0)return;
  startX=e.clientX;startY=e.clientY;held=false;
  clearTimeout(timer);
  timer=setTimeout(()=>{held=true;askToClear(button.dataset.typ,button.dataset.id);},620);
 });
 const cancel=()=>{clearTimeout(timer);timer=null;};
 button.addEventListener('pointermove',e=>{if(Math.abs(e.clientX-startX)>14||Math.abs(e.clientY-startY)>14)cancel();});
 ['pointerup','pointerleave','pointercancel'].forEach(event=>button.addEventListener(event,cancel));
 button.addEventListener('contextmenu',e=>{e.preventDefault();cancel();held=true;askToClear(button.dataset.typ,button.dataset.id);});
 button.addEventListener('click',e=>{
  if(!held)return;held=false;e.preventDefault();e.stopImmediatePropagation();
 },true);
}
let decorating=false;
function scan(){
 if(decorating)return;
 const list=rooms();if(!list)return;
 decorating=true;
 try{
  for(const button of list.querySelectorAll('.chat-room[data-typ][data-id]'))hookRow(button);
  decorate();
 }finally{decorating=false;}
}
function start(){
 const list=rooms();if(!list)return;
 new MutationObserver(()=>{queueMicrotask(scan);}).observe(list,{childList:true});
 scan();
 window.addEventListener('zyro:chat-new',e=>{
  const d=e.detail||{};
  if(d.from&&d.from!==account()&&d.fromName){
   const name=String(d.fromName).slice(0,60);
   notify('💬 '+name+' ti ha inviato un messaggio.');
  }
  void refresh();
 });
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});
 window.addEventListener('focus',()=>void refresh());
 window.addEventListener('online',()=>void refresh());
 // Room opening acknowledges reading on the server via normal chat GET.
 document.addEventListener('click',e=>{
  if(e.target.closest('.chat-room'))setTimeout(()=>void refresh(),550);
 },true);
 setInterval(()=>{
  const id=account();
  if(!id){owner='';cache.clear();lastTotal=0;decorate();return;}
  if(id!==owner){owner=id;cache.clear();decorate();}
  if(online())void refresh();
 },14000);
 void refresh();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});
else start();
})();
