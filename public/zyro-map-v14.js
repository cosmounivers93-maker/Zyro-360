/* ZYRO 360 V14 - Stile A | Patch per la Home della V13 esistente.
   Richiede: /app.js caricato PRIMA, MapLibre GL JS 5.6.1 e OpenFreeMap.
   Non legge né trasmette posizioni dei contatti: riutilizza soltanto quelle
   già disponibili nella sessione autorizzata dell'app esistente. */
(function () {
  'use strict';
  const STYLE = {
    dark: 'https://tiles.openfreemap.org/styles/dark',
    light: 'https://tiles.openfreemap.org/styles/positron'
  };
  const PALETTE = {
    dark: {
      bg:'#0b1929', land:'#142438', green:'#153b39', buildings:'#23384d',
      water:'#0b354d', road:'#56778a', major:'#79aab7', minor:'#405f71',
      label:'#afc9d6', halo:'#0a1b2c'
    },
    light: {
      bg:'#e9f3f7', land:'#dcebf0', green:'#d0e9df', buildings:'#c7dae5',
      water:'#a6d5e5', road:'#a1b9c6', major:'#6c99aa', minor:'#bbd0d9',
      label:'#426278', halo:'#f1f7fa'
    }
  };
  const oldRenderMap = window.renderMap;
  let failTimer = null;
  let observer = null;

  function updateLabels() {
    const top = document.querySelector('.map-top-label > span:nth-child(2)');
    if(top) top.textContent='ZYRO · MAPPA PERSONALIZZATA';
    const brand = document.querySelector('.zyro-map-brand > span:last-child');
    if(brand) brand.textContent='ZYRO 360 · MAP';
    const link = document.getElementById('mapOpenGoogle');
    if(link){link.textContent='Apri OpenStreetMap';link.href='https://www.openstreetmap.org/';}
    const meta = document.querySelector('meta[name="zyro-ui-build"]');
    if(meta) meta.content='v14.0-map-custom-A';
  }
  window.mapLink = function () {
    const link=document.getElementById('mapOpenGoogle');
    if(!link)return;
    link.textContent='Apri OpenStreetMap';
    link.href=mapValidPoint(lastCoords)
      ? `https://www.openstreetmap.org/?mlat=${encodeURIComponent(lastCoords.lat)}&mlon=${encodeURIComponent(lastCoords.lon)}#map=16/${encodeURIComponent(lastCoords.lat)}/${encodeURIComponent(lastCoords.lon)}`
      : 'https://www.openstreetmap.org/';
  };
  function applyLayerColors(map, theme) {
    const c = PALETTE[theme] || PALETTE.dark;
    for(const layer of map.getStyle()?.layers || []) {
      const id=layer.id;
      const name=id.toLowerCase();
      try {
        if(layer.type==='background') map.setPaintProperty(id,'background-color',c.bg);
        else if(layer.type==='fill') {
          if(/water|sea|ocean|river|lake/.test(name)) map.setPaintProperty(id,'fill-color',c.water);
          else if(/park|wood|forest|grass|green|landcover/.test(name)) map.setPaintProperty(id,'fill-color',c.green);
          else if(/building/.test(name)) map.setPaintProperty(id,'fill-color',c.buildings);
          else if(/land|residential|industrial|commercial|airport/.test(name)) map.setPaintProperty(id,'fill-color',c.land);
        } else if(layer.type==='line') {
          if(/road|street|motorway|highway|trunk|primary|secondary|tertiary|minor|path/.test(name)) {
            const color=/motorway|highway|trunk|primary/.test(name)?c.major:/secondary|tertiary/.test(name)?c.road:c.minor;
            map.setPaintProperty(id,'line-color',color);
          } else if(/river|waterway|stream|canal/.test(name)) map.setPaintProperty(id,'line-color',c.water);
        } else if(layer.type==='symbol' && layer.layout?.['text-field']!==undefined) {
          map.setPaintProperty(id,'text-color',c.label);
          map.setPaintProperty(id,'text-halo-color',c.halo);
          map.setPaintProperty(id,'text-halo-width',0.85);
        }
      } catch(e) { /* Layer may use different paint expressions; leave it unchanged. */ }
    }
  }
  function showMapError(message) {
    const el=document.getElementById('mapUnavailable');
    el?.classList.remove('hidden');
    if(el) el.querySelector('strong').textContent='ZYRO MAP non disponibile';
    const text=document.getElementById('mapFailureText');
    if(text)text.textContent=message||'Controlla Internet e riprova.';
    mapStatus('La mappa non è disponibile. Il GPS resta indipendente.');
    updateLabels();
  }
  function clearMarkers() {
    for(const marker of stableMarkers.values())try{marker.remove();}catch(e){}
    stableMarkers.clear();
  }
  window.removeStableMap = function () {
    stableBootId++;
    if(failTimer){clearTimeout(failTimer);failTimer=null;}
    clearMarkers();
    if(stableMap){try{stableMap.remove();}catch(e){}}
    stableMap=null;
    stableMapState='idle';
    if(observer){observer.disconnect();observer=null;}
    const el=document.getElementById('zyroVectorMap');
    if(el)el.replaceChildren();
  };
  window.syncStableMarkers = function () {
    if(!stableMap || stableMapState!=='ready' || !current)return;
    const points=[];
    for(const u of uniqueContacts())if(mapValidPoint(u.location))
      points.push({id:'contact:'+u.id,p:u.location,name:u.name,alert:!!u.sos,own:false});
    if(mapValidPoint(lastCoords))points.push({id:'me',p:lastCoords,name:'Tu',own:true});
    const found=new Set();
    for(const p of points){
      found.add(p.id);
      let marker=stableMarkers.get(p.id);
      if(!marker){
        const node=stableMarker(p.own,p.p.heading,p.name,p.alert);
        marker=new maplibregl.Marker({element:node,anchor:p.own?'center':'bottom'})
          .setLngLat([Number(p.p.lon),Number(p.p.lat)]).addTo(stableMap);
        stableMarkers.set(p.id,marker);
      } else marker.setLngLat([Number(p.p.lon),Number(p.p.lat)]);
      const node=marker.getElement();
      node.classList.toggle('zyro-contact-alert',p.alert);
      const arrow=node.querySelector('.zyro-gl-arrow');
      if(arrow&&Number.isFinite(Number(p.p.heading)))arrow.style.transform=`rotate(${Number(p.p.heading)}deg)`;
    }
    for(const [id,marker] of stableMarkers){if(!found.has(id)){marker.remove();stableMarkers.delete(id);}}
  };
  window.focusStableMap = function (lat,lon,zoom=16) {
    if(!stableMap || stableMapState!=='ready' || !mapValidPoint({lat,lon}))return;
    stableMap.easeTo({center:[Number(lon),Number(lat)],zoom:Math.max(2,Math.min(19,zoom)),duration:500});
  };
  window.ensureStableMap = function () {
    if(!current || document.getElementById('homeView')?.classList.contains('hidden'))return;
    if(stableMapState==='ready'){
      stableMap?.resize();syncStableMarkers();return;
    }
    if(stableMapState==='loading' || stableMapState==='error')return;
    updateLabels();
    const el=document.getElementById('zyroVectorMap');
    if(!el || el.clientWidth<25 || el.clientHeight<25)return;
    if(!window.maplibregl?.Map){stableMapState='error';showMapError('Motore MapLibre non caricato. Controlla la connessione e la CSP del server.');return;}
    const boot=++stableBootId;
    stableMapState='loading';mapHideFailure();mapStatus('Caricamento ZYRO MAP…');
    const pos=mapValidPoint(lastCoords)?[Number(lastCoords.lon),Number(lastCoords.lat)]:[12.5,41.9];
    try{
      stableMap=new maplibregl.Map({
        container:el,style:STYLE[zyroTheme]||STYLE.dark,
        center:pos,zoom:mapValidPoint(lastCoords)?15:5,
        minZoom:2,maxZoom:19,pitch:0,bearing:0,
        dragRotate:false,touchPitch:false,pitchWithRotate:false,
        attributionControl:true,locale:{'AttributionControl.ToggleAttribution':'Attribuzioni'}
      });
      stableMap.on('style.load',()=>{if(boot===stableBootId)applyLayerColors(stableMap,zyroTheme);});
      stableMap.once('load',()=>{
        if(boot!==stableBootId)return;
        if(failTimer){clearTimeout(failTimer);failTimer=null;}
        stableMapState='ready';mapHideFailure();
        stableMap.resize();syncStableMarkers();
        mapStatus(mapValidPoint(lastCoords)?`GPS · precisione ±${Math.round(lastCoords.accuracy||0)} m`:'Mappa pronta · attiva il GPS per localizzarti');
      });
      stableMap.on('error',e=>{console.warn('ZYRO MAP V14',e?.error||e);});
      failTimer=setTimeout(()=>{
        if(boot===stableBootId && stableMapState==='loading'){
          removeStableMap();stableMapState='error';
          showMapError('Le tessere cartografiche non rispondono. Verifica Internet o la policy CSP.');
        }
      },22000);
      if(window.ResizeObserver){observer=new ResizeObserver(()=>stableMap?.resize());observer.observe(el);}
    }catch(e){console.warn('ZYRO V14',e);removeStableMap();stableMapState='error';showMapError('Inizializzazione mappa fallita: '+(e.message||'errore sconosciuto'));}
  };
  window.applyZyroTheme=function(next,persist=true){
    zyroTheme=next==='light'?'light':'dark';
    document.documentElement.dataset.theme=zyroTheme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',zyroTheme==='dark'?'#071626':'#e8f5f7');
    for(const btn of document.querySelectorAll('[data-theme-choice]')){
      const selected=btn.dataset.themeChoice===zyroTheme;
      btn.classList.toggle('is-selected',selected);btn.setAttribute('aria-pressed',String(selected));
    }
    if(persist)try{localStorage.setItem(ZYRO_THEME_KEY,zyroTheme);}catch(e){}
    if(stableMap && stableMapState==='ready')stableMap.setStyle(STYLE[zyroTheme]);
  };
  if(typeof oldRenderMap==='function')window.renderMap=function(){
    oldRenderMap();
    if(stableMapState==='ready')requestAnimationFrame(()=>stableMap?.resize());
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',updateLabels);
  else updateLabels();
})();
