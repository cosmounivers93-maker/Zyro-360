
/* Zyro LifeGuard UI. The server owns entitlements and SOS state.
 * Never equate a checked box with an actually running Android monitor. */
(function(){
  let changing=false;
  const $life=id=>document.getElementById(id);
  function paint(){
    const toggle=$life('lifeGuardFallToggle'),status=$life('lifeGuardFallStatus');
    if(!toggle||!status)return;
    const me=typeof current!=='undefined'?current?.me:null;
    const eligible=me?.features?.lifeGuardFall===true;
    const authorized=eligible&&me?.lifeGuardFallEnabled===true;
    const native=window.ZyroNativeSafety||{};
    const monitored=native.lifeGuardActive===true && native.lifeGuardSensorsReady===true;
    toggle.disabled=!eligible||changing;
    toggle.checked=authorized;
    if(!eligible){
      status.textContent='Disponibile con il piano Family. Seleziona l’abbonamento per attivare il rilevamento cadute.';
      status.dataset.state='warning';
    }else if(authorized&&monitored){
      status.textContent='Protezione attiva su questo telefono · Sensori Android collegati. Tocca per interrompere.';
      status.dataset.state='on';
    }else if(authorized){
      status.textContent='Protezione autorizzata, ma monitoraggio Android non confermato. Apri l’app aggiornata e riattiva il servizio. Nessuna protezione continua garantita.';
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
      const result=await zyroNativeRequest('lifeguard',{enabled});
      if(result.result!=='zyro-lifeguard-ok')throw Error('Il servizio LifeGuard non si è avviato su Android.');
    }else{
      const result=window.prompt('ZYRO360_LIFEGUARD_SYNC',JSON.stringify({enabled}));
      if(result!=='zyro-lifeguard-ok')throw Error('Aggiorna l’APK Android per utilizzare il rilevamento cadute.');
    }
    if(typeof zyroNativeRequest==='function'&&typeof hasZyroNativeBridge==='function'&&hasZyroNativeBridge()){
      const result=await zyroNativeRequest('status',{});
      if(result?.status)window.ZyroNativeSafety=result.status;
    }
  }
  async function toggleFall(event){
    const requested=event.target.checked;
    if(changing)return;
    changing=true;paint();
    try{
      const me=current?.me;
      if(!me?.features?.lifeGuardFall)throw Error('Il rilevamento cadute richiede Family.');
      if(requested&&!(me.sosRecipients||[]).length)throw Error('Prima seleziona almeno un destinatario SOS nella sezione Modalità.');
      if(requested){
        await post('/api/lifeguard/fall/settings',{enabled:true});
        try{await commandNative(true);}
        catch(err){await post('/api/lifeguard/fall/settings',{enabled:false});throw err;}
      }else{
        await post('/api/lifeguard/fall/settings',{enabled:false});
        try{await commandNative(false);}
        catch(err){throw Error('Autorizzazione revocata sul server, ma il servizio Android potrebbe restare acceso: fermalo dalla notifica persistente. '+err.message);}
      }
      await refresh();
      if(typeof toast==='function')toast(requested?'LifeGuard attivato: verifica la notifica Android.':'LifeGuard cadute disattivato.');
    }catch(err){
      if(typeof toast==='function')toast(err.message||'Impossibile aggiornare LifeGuard.',true);
      if(typeof refresh==='function')await refresh().catch(()=>{});
    }finally{changing=false;paint();}
  }
  document.addEventListener('DOMContentLoaded',()=>{
    $life('lifeGuardFallToggle')?.addEventListener('change',event=>{void toggleFall(event);});
    window.addEventListener('zyro:android-safety-state',paint);
    window.addEventListener('zyro:android-ready',paint);
    paint();
  });
})();
