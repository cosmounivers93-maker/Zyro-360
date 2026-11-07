/* ZYRO 360 V3 — accessible glass selectors; original form selects stay authoritative. */
(function(){
 'use strict';
 if(window.ZyroCirclePickerV3)return;
 window.ZyroCirclePickerV3=true;
 const ids=['circleType','profileInviteMode','profileInviteCircle'];
 const modalTitle={
  circleType:'Modalità della cerchia',
  profileInviteMode:'Tipo di invito',
  profileInviteCircle:'Cerchia di destinazione'
 };
 const modalHint={
  circleType:'Scegli come condividere la tua cerchia.',
  profileInviteMode:'Decidi se invitare una persona o più persone.',
  profileInviteCircle:'Scegli la cerchia in cui invitare il contatto.'
 };
 const triggers=new Map();
 let layer=null,previousOverflow='',openedBy=null;
 function details(select,option){
  const raw=(option.textContent||'').trim();
  if(select.id==='circleType'){
   return option.value==='direct'
    ?{title:'Cerchia singola',description:'Tu e un solo contatto · massimo 2 persone',kind:'direct'}
    :{title:'Cerchia di gruppo',description:'Famiglia e amici · fino a 20 persone',kind:'group'};
  }
  if(select.id==='profileInviteMode'){
   return option.value==='direct'
    ?{title:'Singola persona',description:'Invito privato per un contatto',kind:'direct'}
    :{title:'Gruppo',description:'Invita più persone nella stessa cerchia',kind:'group'};
  }
  const match=raw.match(/^(.*?)\s*·\s*(Singola persona|Gruppo)\s*\((\d+)\/(\d+)\)$/i);
  if(match)return {title:match[1].trim(),description:(match[2]==='Singola persona'?'Cerchia singola':'Cerchia di gruppo')+' · '+match[3]+'/'+match[4]+' membri',kind:match[2]==='Singola persona'?'direct':'group'};
  return {title:raw||'Nessuna cerchia disponibile',description:'',kind:'group'};
 }
 function icon(kind){
  const symbol=document.createElement('span');
  symbol.className='zyro-choice-icon '+(kind==='direct'?'is-direct':'is-group');
  symbol.setAttribute('aria-hidden','true');
  symbol.innerHTML=kind==='direct'
   ?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7.6" r="3.2"/><path d="M5.5 20v-2.3c0-3.3 2.8-5.7 6.5-5.7s6.5 2.4 6.5 5.7V20"/></svg>'
   :'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M2.8 19v-1.5c0-2.9 2.7-5 6.2-5s6.2 2.1 6.2 5V19"/><path d="M16.4 5.2a3 3 0 0 1 0 5.7M17.2 13c2.5.7 4 2.5 4 4.6V19"/></svg>';
  return symbol;
 }
 function sync(select){
  const trigger=triggers.get(select.id);if(!trigger)return;
  const opt=select.options[select.selectedIndex]||select.options[0];
  const d=opt?details(select,opt):{title:'Nessuna cerchia disponibile',description:'',kind:'group'};
  trigger.querySelector('.zyro-choice-trigger-title').textContent=d.title;
  trigger.querySelector('.zyro-choice-trigger-meta').textContent=d.description;
  const oldIcon=trigger.querySelector('.zyro-choice-icon');
  if(oldIcon)oldIcon.replaceWith(icon(d.kind));
  trigger.disabled=select.disabled||!Array.from(select.options).some(o=>!o.disabled&&o.value!=='');
  trigger.setAttribute('aria-disabled',String(trigger.disabled));
 }
 function syncAll(){for(const id of ids){const select=document.getElementById(id);if(select)sync(select);}}
 function close(restoreFocus){
  if(!layer)return;
  const node=layer;layer=null;
  node.remove();document.body.style.overflow=previousOverflow;
  document.removeEventListener('keydown',keyHandler,true);
  if(openedBy){openedBy.setAttribute('aria-expanded','false');if(restoreFocus!==false&&openedBy.isConnected)openedBy.focus();}
  openedBy=null;
 }
 function keyHandler(event){
  if(!layer)return;
  if(event.key==='Escape'){event.preventDefault();close(true);return;}
  if(event.key!=='Tab')return;
  const focusable=Array.from(layer.querySelectorAll('button:not([disabled])'));
  if(!focusable.length)return;
  const first=focusable[0],last=focusable[focusable.length-1];
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
 }
 function optionButton(select,opt){
  const d=details(select,opt);
  const button=document.createElement('button');
  button.type='button';button.className='zyro-choice-option';
  const selected=opt.value===select.value;
  button.setAttribute('aria-pressed',String(selected));
  const text=document.createElement('span');text.className='zyro-choice-option-copy';
  const title=document.createElement('strong');title.textContent=d.title;
  const meta=document.createElement('small');meta.textContent=d.description;
  text.append(title,meta);
  const check=document.createElement('span');check.className='zyro-choice-check';
  check.setAttribute('aria-hidden','true');check.textContent=selected?'✓':'';
  button.append(icon(d.kind),text,check);
  button.addEventListener('click',()=>{
   const changed=select.value!==opt.value;
   select.value=opt.value;
   if(changed){
    select.dispatchEvent(new Event('input',{bubbles:true}));
    select.dispatchEvent(new Event('change',{bubbles:true}));
   }
   syncAll();
   close(true);
  });
  return button;
 }
 function open(select,trigger){
  if(trigger.disabled)return;
  if(layer)close(false);
  const overlay=document.createElement('div');
  overlay.className='zyro-choice-overlay';overlay.id='zyroCircleSelectOverlay';
  const backdrop=document.createElement('div');backdrop.className='zyro-choice-backdrop';
  const card=document.createElement('section');card.className='zyro-choice-sheet';
  card.setAttribute('role','dialog');card.setAttribute('aria-modal','true');
  card.setAttribute('aria-labelledby','zyroCircleSelectTitle');
  card.setAttribute('aria-describedby','zyroCircleSelectHint');
  const heading=document.createElement('div');heading.className='zyro-choice-heading';
  const copy=document.createElement('div');
  const eyebrow=document.createElement('span');eyebrow.className='zyro-choice-eyebrow';eyebrow.textContent='ZYRO 360 · CERCHIE';
  const title=document.createElement('h2');title.id='zyroCircleSelectTitle';title.textContent=modalTitle[select.id];
  const hint=document.createElement('p');hint.id='zyroCircleSelectHint';hint.textContent=modalHint[select.id];
  copy.append(eyebrow,title,hint);
  const dismiss=document.createElement('button');dismiss.type='button';dismiss.className='zyro-choice-dismiss';
  dismiss.setAttribute('aria-label','Chiudi selezione');dismiss.textContent='×';dismiss.addEventListener('click',()=>close(true));
  heading.append(copy,dismiss);
  const list=document.createElement('div');list.className='zyro-choice-list';
  for(const opt of Array.from(select.options)){
   if(opt.disabled||opt.value==='')continue;
   list.appendChild(optionButton(select,opt));
  }
  if(!list.children.length){
   const empty=document.createElement('p');empty.className='zyro-choice-empty';empty.textContent='Non ci sono cerchie disponibili. Crea prima una cerchia con posti liberi.';
   list.appendChild(empty);
  }
  card.append(heading,list);overlay.append(backdrop,card);
  backdrop.addEventListener('click',()=>close(true));
  previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
  document.body.append(overlay);layer=overlay;openedBy=trigger;trigger.setAttribute('aria-expanded','true');
  document.addEventListener('keydown',keyHandler,true);
  const selected=overlay.querySelector('.zyro-choice-option[aria-pressed="true"]');
  (selected||dismiss).focus();
 }
 function setup(id){
  const select=document.getElementById(id);if(!select||select.dataset.zyroPickerV3)return;
  select.dataset.zyroPickerV3='ready';
  const wrap=document.createElement('div');wrap.className='zyro-choice-control';
  const trigger=document.createElement('button');trigger.type='button';
  trigger.className='zyro-choice-trigger';
  trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-controls','zyroCircleSelectOverlay');
  trigger.setAttribute('aria-expanded','false');
  trigger.setAttribute('aria-label',modalTitle[id]);
  const copy=document.createElement('span');copy.className='zyro-choice-trigger-copy';
  const title=document.createElement('strong');title.className='zyro-choice-trigger-title';
  const meta=document.createElement('small');meta.className='zyro-choice-trigger-meta';
  copy.append(title,meta);
  const arrow=document.createElement('span');arrow.className='zyro-choice-arrow';arrow.setAttribute('aria-hidden','true');arrow.textContent='⌄';
  trigger.append(icon('group'),copy,arrow);
  select.parentNode.insertBefore(wrap,select);wrap.append(select,trigger);
  select.classList.add('zyro-choice-native');
  select.tabIndex=-1;
  triggers.set(id,trigger);
  trigger.addEventListener('click',()=>open(select,trigger));
  const label=document.querySelector('label[for="'+id+'"]');
  if(label)label.addEventListener('click',event=>{event.preventDefault();trigger.click();});
  select.addEventListener('change',()=>syncAll());
  new MutationObserver(()=>syncAll()).observe(select,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','label','selected']});
  sync(select);
 }
 function init(){
  ids.forEach(setup);
  const circles=document.getElementById('circlesList');
  if(circles)new MutationObserver(()=>syncAll()).observe(circles,{childList:true,subtree:false});
  syncAll();
 }
 window.zyroCirclePickerV3Refresh=syncAll;
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
 else init();
})();