/* Fail-safe for boot failures: keep the approved UI untouched unless startup stalls.
   This file is deliberately independent from the main application bundle. */
(function () {
 'use strict';
 const TIMEOUT_MS = 25000;
 const RECOVERY_ID = 'zyroStartupRecovery';
 let recovery = null;

 function clearRecovery() {
   if (recovery && recovery.isConnected) recovery.remove();
   recovery = null;
 }

 function showRecovery() {
   if (window.ZyroStartupReady === true) { clearRecovery(); return; }
   if (!document.body || document.getElementById(RECOVERY_ID)) return;
   // A JavaScript or asset failure previously kept both login and app hidden.
   document.body.classList.remove('zyro-await-intro');
   recovery = document.createElement('div');
   recovery.id = RECOVERY_ID;
   recovery.setAttribute('role','alert');
   recovery.setAttribute('aria-live','assertive');
   recovery.style.cssText = 'position:fixed;inset:0;z-index:2147483645;'+
     'background:rgba(245,248,255,.97);display:flex;justify-content:center;'+
     'align-items:center;padding:24px;box-sizing:border-box;color:#33446f;';
   const card = document.createElement('section');
   card.style.cssText = 'max-width:390px;width:100%;padding:25px 20px;'+
     'border-radius:20px;background:#fff;border:1px solid #c4c7ed;'+
     'box-shadow:0 14px 50px rgba(76,73,126,.17);text-align:center;';
   const heading=document.createElement('h2');
   heading.textContent='Impossibile completare il caricamento';
   heading.style.cssText='font:700 19px system-ui,sans-serif;color:#6351a9;margin:0 0 10px;';
   const note=document.createElement('p');
   note.textContent='Zyro 360 non ha terminato l’avvio. Controlla la connessione e riprova. Se il problema continua, potrebbe essere temporaneamente indisponibile il server.';
   note.style.cssText='font:400 14px/1.55 system-ui,sans-serif;margin:0 0 16px;';
   const retry=document.createElement('button');
   retry.textContent='Riprova';
   retry.type='button';
   retry.style.cssText='border:0;border-radius:12px;padding:12px 22px;'+
     'background:linear-gradient(100deg,#8767dd,#78a7df);'+
     'color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer;';
   retry.addEventListener('click',()=>window.location.reload());
   card.append(heading,note,retry);
   recovery.append(card);
   document.body.append(recovery);
 }

 setTimeout(showRecovery,TIMEOUT_MS);
 const check=setInterval(()=>{
   if(window.ZyroStartupReady===true){
     clearRecovery();
     clearInterval(check);
   }
 },1500);
 setTimeout(()=>clearInterval(check),120000);
})();