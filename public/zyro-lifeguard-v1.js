
/* Zyro LifeGuard UI. The server owns entitlements and SOS state.
 * Never equate a checked box with an actually running Android monitor. */
(function(){
  let changing=false,selectionBusy=false,selected='low',feedback='';
  const STORAGE_KEY='zyro-lifeguard-fall-sensitivity-v1';
  try{selected=localStorage.getItem(STORAGE_KEY)==='high'?'high':'low';}catch(err){}
  const $life=id=>document.getElementById(id);
  function paint(){
    const toggle=$life('lifeGuardFallToggle'),status=$life('lifeGuardFallStatus');
    if(!toggle||!status)return;
    const me=typeof current!=='undefined'?current?.me:null;
    const eligible=me?.features?.lifeGuardFall===true;
    const authorized=eligible&&me?.lifeGuardFallEnabled===true;
    const native=window.ZyroNativeSafety||{};
    const monitored=native.lifeGuardActive===true && native.lifeGuardSensorsReady===true;
    toggle.disabled=changing; // Never silently ignore taps on a greyed-out toggle.
    toggle.checked=authorized&&monitored;
    for(const button of document.querySelectorAll('#lifeGuardFallLevels [data-life-level]')){
      button.setAttribute('aria-pressed',String(button.dataset.lifeLevel===selected));
      button.disabled=changing||selectionBusy;
    }
    if(feedback){status.textContent=feedback;status.dataset.state='warning';return;}
    if(!eligible){
      status.textContent='Rilevamento cadute non ancora attivabile: verifica Family e completa l’aggiornamento del server. La sensibilità può essere scelta ora.';
      status.dataset.state='warning';
    }else if(authorized&&monitored){
      status.textContent='Sensori Android attivi · Sensibilità '+(native.lifeGuardSensitivity==='high'?'Elevata':'Bassa')+'. Puoi disattivare LifeGuard anche dalla notifica.';
      status.dataset.state='on';
    }else if(authorized){
      status.textContent='Autorizzazione presente, ma monitoraggio Android non confermato. Tocca il comando per tentare nuovamente l’avvio.';
      status.dataset.state='warning';
    }else{
      status.textContent='Protezione disattivata. Attiva solo dopo aver scelto i destinatari SOS.';
      status.dataset.state='';
    }
  }
  window.ZyroLifeGuardRender=paint;
  async function commandNative(enabled){
    if(typeof isZyroNativeAvailable!=='function'||!isZyroNativeAvailable())
      throw Error('È necessario aprire Zyro 360 dall’app Android aggiornata.');
    if(typeof hasZyroNativeBridge==='function' && hasZyroNativeBridge()){
      const result=await zyroNativeRequest('lifeguard',{enabled,sensitivity:selected});
      if(result.result!=='zyro-lifeguard-ok')throw Error('Il servizio LifeGuard non si è avviato su Android.');
    }else{
      const result=window.prompt('ZYRO360_LIFEGUARD_SYNC',JSON.stringify({enabled,sensitivity:selected}));
      if(result!=='zyro-lifeguard-ok')throw Error('Aggiorna l’APK Android per utilizzare il rilevamento cadute.');
    }
    if(typeof zyroNativeRequest==='function'&&typeof hasZyroNativeBridge==='function'&&hasZyroNativeBridge()){
      const result=await zyroNativeRequest('status',{});
      if(result?.status)window.ZyroNativeSafety=result.status;
    }
  }
  async function toggleFall(event){
    if(changing)return;
    const native=window.ZyroNativeSafety||{};
    const me=typeof current!=='undefined'?current?.me:null;
    const requested=!(me?.lifeGuardFallEnabled===true && native.lifeGuardActive===true&&native.lifeGuardSensorsReady===true);
    feedback='';
    if(!me?.features?.lifeGuardFall){
      feedback='Serve il piano Family e l’aggiornamento del server LifeGuard. Il monitoraggio non è stato attivato.';
      paint();return;
    }
    changing=true;paint();
    try{
      if(!me?.features?.lifeGuardFall)throw Error('Il rilevamento cadute richiede Family.');
      if(requested&&!(me.sosRecipients||[]).length)throw Error('Prima seleziona almeno un destinatario SOS nella sezione Modalità.');
      if(requested){
        await post('/api/lifeguard/fall/settings',{enabled:true});
        try{await commandNative(true);}
        catch(err){await post('/api/lifeguard/fall/settings',{enabled:false});throw err;}
      }else{
        // Stop Android first, so server state cannot claim monitoring is off while it is still running.
        await commandNative(false);
        await post('/api/lifeguard/fall/settings',{enabled:false});
      }
      await refresh();
      feedback='';
      if(requested&&!(window.ZyroNativeSafety?.lifeGuardActive&&window.ZyroNativeSafety?.lifeGuardSensorsReady))
        feedback='Avvio richiesto. Verifica la notifica Android per confermare che i sensori sono attivi.';
      if(typeof toast==='function')toast(requested?'Verifica la notifica Android LifeGuard.':'LifeGuard cadute disattivato.');
    }catch(err){
      feedback=err.message||'Impossibile aggiornare LifeGuard.';
      if(typeof toast==='function')toast(feedback,true);
      if(typeof refresh==='function')await refresh().catch(()=>{});
    }finally{changing=false;paint();}
  }
  async function selectLevel(level){
    if((level!=='low'&&level!=='high')||selectionBusy||changing)return;
    const native=window.ZyroNativeSafety||{};
    if(native.lifeGuardPending){feedback='Attendi la fine della verifica SOS prima di cambiare la sensibilità.';paint();return;}
    selected=level;feedback='';selectionBusy=true;
    try{localStorage.setItem(STORAGE_KEY,level);}catch(err){}
    paint();
    try{
      const me=typeof current!=='undefined'?current?.me:null;
      if(me?.features?.lifeGuardFall&&me.lifeGuardFallEnabled&&native.lifeGuardActive){
        await commandNative(true);
        feedback='Sensibilità '+(level==='high'?'Elevata':'Bassa')+' applicata ai sensori.';
      }else{
        feedback='Sensibilità '+(level==='high'?'Elevata':'Bassa')+' salvata. Sarà utilizzata quando avvierai LifeGuard.';
      }
    }catch(err){feedback='Sensibilità salvata, ma non applicata al servizio Android: '+(err?.message||'riprovare');}
    finally{selectionBusy=false;paint();}
  }
  document.addEventListener('DOMContentLoaded',()=>{
    $life('lifeGuardFallToggle')?.addEventListener('change',event=>{void toggleFall(event);});
    $life('lifeGuardFallLevels')?.addEventListener('click',event=>{
      const button=event.target.closest('[data-life-level]');if(button)void selectLevel(button.dataset.lifeLevel);
    });
    window.addEventListener('zyro:android-safety-state',paint);
    window.addEventListener('zyro:android-ready',paint);
    paint();
  });
})();
