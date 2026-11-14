/* ZYRO 360 - Centro Segnalazioni. Uses authenticated, server-enforced APIs. */
(function(){
 'use strict';
 const $=id=>document.getElementById(id);
 const safe=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const date=x=>x?new Date(x).toLocaleString('it-IT'):'—';
 const labels={open:'Nuova',in_review:'In verifica',reviewed:'Conclusa',dismissed:'Archiviata senza provvedimenti'};
 const templates={
   reporter:[
     ['','Scegli un messaggio rapido'],
     ['Abbiamo preso in carico la tua segnalazione. Ti informeremo sugli sviluppi.','Presa in carico'],
     ['Per completare la verifica abbiamo bisogno di ulteriori dettagli. Puoi rispondere qui.','Richiesta di chiarimenti'],
     ['La tua segnalazione è stata esaminata. Grazie per la collaborazione.','Aggiornamento finale']
   ],
   reported:[
     ['','Scegli un avvertimento'],
     ['L’Amministrazione Zyro 360 sta verificando una segnalazione relativa al tuo account. Nessuna violazione è stata ancora accertata. Puoi fornire chiarimenti rispondendo qui.','Comunicazione di verifica'],
     ['Ti invitiamo a rispettare le regole di Zyro 360 e a mantenere comunicazioni corrette. Puoi rispondere a questo messaggio.','Richiamo alle regole'],
     ['Ti informiamo che eventuali violazioni confermate delle regole possono comportare limitazioni o sospensioni dell’account. La tua posizione è ancora oggetto di verifica.','Possibile sospensione']
   ]
 };
 let reloadAdmin=()=>{}, lastInboxAt=0,lastUser='', busy=false;
 const request=async (url,body)=>{
   const response=await fetch(url,{method:body===undefined?'GET':'POST',
     credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json'},
     ...(body===undefined?{}:{body:JSON.stringify(body)})});
   const json=await response.json().catch(()=>({}));
   if(!response.ok)throw Error(json.error||'Operazione non riuscita.');
   return json;
 };
 const notifyError=e=>{const msg=e?.message||'Operazione non riuscita.'; if(window.toast)window.toast(msg,true);else alert(msg);};
 const withBusy=async(fn)=>{if(busy)return;busy=true;try{await fn();}catch(e){notifyError(e);}finally{busy=false;}};

 // Signed-in users receive a visible in-app message; only the server decides
 // when a message is read, and only the intended recipient can acknowledge it.
 let activeUser=null, inboxReports=[], openedNotice=null, noticeSending=false;
 const deferredNotices=new Set();
 function dismissNotice(){
   const dialog=$('zyroOfficialNotice');
   if(dialog?.open){if(typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open');}
   openedNotice=null;
 }
 function unreadMessages(){
   return inboxReports.flatMap(r=>(r.messages||[])
     .filter(m=>m.from==='admin'&&!m.seenAt&&!deferredNotices.has(m.id))
     .map(m=>({reportId:r.id,role:r.role,...m})))
     .sort((a,b)=>a.at-b.at);
 }
 function safeToShowNotice(){
   if(!activeUser||activeUser.isAdmin || document.hidden) return false;
   if($('appScreen')?.classList.contains('hidden'))return false;
   if(activeUser.sos || !$('theftOverlay')?.classList.contains('hidden'))return false;
   if(document.querySelector('dialog[open]:not(#zyroOfficialNotice),[role="alertdialog"]:not(.hidden),.zyro-owner-dialog-backdrop'))return false;
   return true;
 }
 function showPendingNotice(){
   const dialog=$('zyroOfficialNotice');
   if(!dialog || dialog.open || !safeToShowNotice())return;
   const queue=unreadMessages(), m=queue[0];if(!m)return;
   openedNotice=m;
   $('zyroOfficialNoticeText').textContent=m.body;
   $('zyroOfficialNoticeDate').textContent=date(m.at);
   $('zyroOfficialNoticeCount').textContent=queue.length>1
     ?`Hai ${queue.length} comunicazioni da leggere`
     :'Comunicazione privata';
   $('zyroOfficialNoticeKind').textContent=m.role==='reporter'
     ?'Aggiornamento sulla tua segnalazione'
     :'Messaggio riservato al tuo account';
   try{if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');}
   catch{openedNotice=null;}
 }
 function deferNotice(){
   if(openedNotice)deferredNotices.add(openedNotice.id);
   dismissNotice();
   showPendingNotice();
 }
 async function acknowledgeNotice(openConversation=false){
   if(noticeSending || !openedNotice)return;
   noticeSending=true;
   const accountId=activeUser?.id;
   const m=openedNotice;
   try{
     const response=await request('/api/reports/read-message',
       {reportId:m.reportId,messageId:m.id});
     if(activeUser?.id!==accountId)return;
     for(const r of inboxReports)if(r.id===m.reportId){
       const item=(r.messages||[]).find(x=>x.id===m.id);
       if(item)item.seenAt=response.seenAt||Date.now();
     }
     dismissNotice();
     if(openConversation){
       // Keep other notices available on a later revisit, without stacking
       // dialogs on top of the conversation the user just opened.
       for(const rest of unreadMessages())deferredNotices.add(rest.id);
       if(typeof window.showView==='function')window.showView('settings');
       await loadInbox(true);
       setTimeout(()=>{
         const target=[...document.querySelectorAll('#zyroMyReportsList details[data-inbox-id]')]
           .find(el=>el.dataset.inboxId===m.reportId);
         if(target){target.open=true;target.scrollIntoView({block:'start',behavior:'smooth'});
           target.querySelector('textarea[data-user-reply]')?.focus({preventScroll:true});}
         else $('zyroMyReports')?.scrollIntoView({block:'start',behavior:'smooth'});
       },120);
     }else showPendingNotice();
   }catch(e){notifyError(e);}
   finally{noticeSending=false;}
 }
 function bindOfficialNotice(){
   const dialog=$('zyroOfficialNotice');if(!dialog||dialog.dataset.bound)return;
   dialog.dataset.bound='yes';
   $('zyroOfficialNoticeLater')?.addEventListener('click',deferNotice);
   $('zyroOfficialNoticeRead')?.addEventListener('click',()=>void acknowledgeNotice(false));
   $('zyroOfficialNoticeReply')?.addEventListener('click',()=>void acknowledgeNotice(true));
   dialog.addEventListener('cancel',event=>{event.preventDefault();deferNotice();});
   document.addEventListener('visibilitychange',()=>{
     if(!document.hidden && activeUser && !activeUser.isAdmin){
       void loadInbox(true);showPendingNotice();
     }
   });
   window.addEventListener('focus',()=>{if(activeUser && !activeUser.isAdmin)void loadInbox(true);});
 }
 function resetNotices(){
   dismissNotice();deferredNotices.clear();inboxReports=[];activeUser=null;
   lastInboxAt=0;lastUser='';
 }

 const messagesFor=(r,role)=>(r.messages||[]).filter(m=>m.to===role||m.from===role);
 const thread=(r,role)=>{
   const list=messagesFor(r,role);
   return list.length?list.map(m=>`<div class="zyro-case-message ${m.from==='admin'?'is-staff':'is-user'}">
     <b>${m.from==='admin'?'Amministrazione Zyro 360':'Utente'}</b>
     <p>${safe(m.body)}</p><small>${safe(date(m.at))}${m.from==='admin'?(m.seenAt?' · Letto':' · Inviato'):''}</small>
     </div>`).join(''):'<p class="zyro-case-empty">Nessun messaggio in questa conversazione.</p>';
 };
 const composer=(role,r)=>{
   const title=role==='reporter'?'Scrivi al segnalante':'Scrivi all’utente segnalato';
   return `<section class="zyro-case-conversation" data-recipient="${role}">
     <h4>${safe(title)}</h4>
     <div class="zyro-case-timeline">${thread(r,role)}</div>
     <label>Messaggio rapido
       <select data-template="${role}" aria-label="Messaggio rapido ${role}">
       ${templates[role].map(([body,label])=>`<option value="${safe(body)}">${safe(label)}</option>`).join('')}
       </select>
     </label>
     <label>Messaggio da inviare
       <textarea data-compose="${role}" rows="3" maxlength="800" placeholder="Puoi modificare il messaggio prima dell'invio"></textarea>
     </label>
     <button type="button" data-report-send="${role}">Conferma e invia privatamente</button>
     </section>`;
 };
 function renderAdmin(reports,reload){
   const root=$('adminReports');if(!root)return false;
   reloadAdmin=reload||(()=>{});
   const opened=new Set([...root.querySelectorAll('details[data-case][open]')].map(x=>x.dataset.case));
   root.innerHTML=reports.length?reports.map(r=>`<details class="zyro-case-card" data-case="${safe(r.id)}" ${opened.has(r.id)?'open':''}>
      <summary><span class="zyro-case-summary-name">${safe(r.user?.name||'Utente non disponibile')}<small>Segnalato da ${safe(r.reporter?.name||'Utente')}</small></span><span class="zyro-case-status">${safe(labels[r.status]||r.status)}</span></summary>
      <div class="zyro-case-main">
        <div class="zyro-case-parties">
         <div><small>CHI SEGNALA</small><strong>${safe(r.reporter?.name||'Utente')}</strong><code>${safe(r.reporterId)}</code></div>
         <div><small>UTENTE SEGNALATO</small><strong>${safe(r.user?.name||'Utente')}</strong><code>${safe(r.userId)}</code></div>
        </div>
        <p class="zyro-case-date">Ricevuta il ${safe(date(r.at))} · Pratica ${safe(r.id)}</p>
        <div class="zyro-case-reason"><strong>Motivo della segnalazione</strong><p>${safe(r.reason)}</p></div>
        <div class="zyro-case-actions">
         ${r.status==='open'?'<button data-report-action="take" type="button">Prendi in carico</button>':''}
         ${['open','in_review'].includes(r.status)?'<button data-report-action="resolve" type="button">Concludi verifica</button>':''}
         <button data-report-action="ban" type="button">${r.user?.bannedAt?'Riattiva account':'Valuta sospensione'}</button>
         <button data-report-action="archive" type="button">${r.adminArchivedAt?'Ripristina pratica':'Archivia pratica'}</button>
        </div>
        <div class="zyro-case-conversations">${composer('reporter',r)}${composer('reported',r)}</div>
      </div>
     </details>`).join(''):'<p class="zyro-case-empty">Nessuna segnalazione in questa sezione.</p>';
   if(!root.dataset.caseBound){
     root.dataset.caseBound='yes';
     root.addEventListener('change',event=>{
       const sel=event.target.closest('[data-template]');if(!sel)return;
       const area=sel.closest('.zyro-case-conversation')?.querySelector('textarea[data-compose]');
       if(area)area.value=sel.value;
     });
     root.addEventListener('click',event=>{
       const button=event.target.closest('[data-report-action],[data-report-send]');if(!button)return;
       const card=button.closest('[data-case]');if(!card)return;
       const id=card.dataset.case;
       if(button.hasAttribute('data-report-send')){
         const role=button.dataset.reportSend;
         const body=card.querySelector(`[data-recipient="${role}"] textarea[data-compose]`)?.value.trim()||'';
         void withBusy(async()=>{
           if(body.length<10)throw Error('Il messaggio deve contenere almeno 10 caratteri.');
           const confirmed=window.zyroOwnerDialog
             ?await window.zyroOwnerDialog({title:'Invia messaggio ufficiale',description:role==='reporter'?'Il messaggio arriverà soltanto al segnalante.':'Il messaggio arriverà soltanto all’utente segnalato.',submitLabel:'Invia messaggio'})
             :confirm('Confermi l’invio privato al destinatario selezionato?');
           if(!confirmed)return;
           await request('/api/admin/report-message',{reportId:id,recipient:role,body});
           await reloadAdmin();
         });return;
       }
       const cmd=button.dataset.reportAction;
       void withBusy(async()=>{
         if(cmd==='take'){await request('/api/admin/report-take',{reportId:id});await reloadAdmin();}
         if(cmd==='resolve' && window.adminReview)await window.adminReview(id);
         if(cmd==='archive' && window.adminArchive)await window.adminArchive('report',id);
         if(cmd==='ban'){
           const report=reports.find(x=>x.id===id);
           if(report?.userId && window.adminChangeBan)await window.adminChangeBan(report.userId);
         }
       });
     });
   }
   return true;
 }
 async function loadInbox(force=false){
   const el=$('zyroMyReports');if(!el||el.hidden)return;
   if(!force && Date.now()-lastInboxAt<30000){showPendingNotice();return;}
   lastInboxAt=Date.now();
   const accountId=activeUser?.id;
   try{
     const data=await request('/api/reports/mine');
     if(!activeUser || activeUser.id!==accountId)return;
     inboxReports=data.reports||[];
     const list=$('zyroMyReportsList');if(!list)return;
     list.innerHTML=data.reports.length?data.reports.map(r=>`<details class="zyro-inbox-case" data-inbox-id="${safe(r.id)}">
       <summary><strong>${r.role==='reporter'?'Segnalazione inviata':'Messaggio dall’amministrazione'}</strong><span>${safe(labels[r.status]||r.status)}</span></summary>
       <div class="zyro-inbox-inner">
         <small>Pratica ${safe(r.id)} · ${safe(date(r.at))}</small>
         ${r.role==='reporter'?`<p><b>Utente segnalato:</b> ${safe(r.reportedName)}</p><p><b>Motivo:</b> ${safe(r.reason)}</p>`:''}
         <div class="zyro-case-timeline">${(r.messages||[]).map(m=>`<div class="zyro-case-message ${m.from==='admin'?'is-staff':'is-user'}"><b>${m.from==='admin'?'Amministrazione Zyro 360':'Tu'}</b><p>${safe(m.body)}</p><small>${safe(date(m.at))}</small></div>`).join('')}</div>
         <label>Rispondi privatamente all’amministrazione<textarea data-user-reply rows="3" maxlength="800" placeholder="Scrivi eventuali chiarimenti o informazioni aggiuntive"></textarea></label>
         <button type="button" data-reply-send>Invia risposta</button>
       </div></details>`).join(''):'<p class="zyro-case-empty">Nessun messaggio o segnalazione presente.</p>';
     showPendingNotice();
     if(!list.dataset.inboxBound){
       list.dataset.inboxBound='yes';
       list.addEventListener('toggle',event=>{
         const details=event.target.closest('details[data-inbox-id]');
         if(details?.open)void request('/api/reports/read',{reportId:details.dataset.inboxId}).then(()=>{
           const report=inboxReports.find(r=>r.id===details.dataset.inboxId);
           for(const m of report?.messages||[])if(m.from==='admin'&&!m.seenAt)m.seenAt=Date.now();
           if(openedNotice?.reportId===details.dataset.inboxId)dismissNotice();
         }).catch(()=>{});
       },true);
       list.addEventListener('click',event=>{
         const btn=event.target.closest('[data-reply-send]');if(!btn)return;
         const card=btn.closest('details[data-inbox-id]');
         const body=card?.querySelector('[data-user-reply]')?.value.trim()||'';
         void withBusy(async()=>{
           if(body.length<3)throw Error('Scrivi un messaggio di almeno 3 caratteri.');
           await request('/api/reports/reply',{reportId:card.dataset.inboxId,body});
           await loadInbox(true);
         });
       });
     }
   }catch(e){if($('zyroMyReportsList'))$('zyroMyReportsList').textContent='Non è stato possibile caricare le comunicazioni: '+e.message;}
 }
 function onState(user){
   const box=$('zyroMyReports');
   if(!box)return;
   box.hidden=!user || user.isAdmin===true;
   if(!user){resetNotices();return;}
   if(lastUser!==user.id){
     resetNotices();lastUser=user.id;
     box.querySelector('#zyroMyReportsList')?.replaceChildren();
   }
   activeUser=user;
   if(!user.isAdmin)void loadInbox();
   else dismissNotice();
 }
 window.ZyroModeration={renderAdmin,loadInbox,onState,reset:resetNotices,showPendingNotice};
 document.addEventListener('DOMContentLoaded',()=>{
   bindOfficialNotice();
   $('zyroMyReportsRefresh')?.addEventListener('click',()=>void loadInbox(true));
 });
})();
