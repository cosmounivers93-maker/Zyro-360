/* Accompagnami address search & blue destination marker.
 * No key in client. Only explicit user searches; never auto-geocode as user types. */
(function(){
 'use strict';
 let requestNo=0,querying=false,selectedFromJourney=null,pin=null,pinMap=null,pendingFocus=false;
 const el=id=>document.getElementById(id);
 function valid(p){return p&&Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lon))&&Math.abs(Number(p.lat))<=85&&Math.abs(Number(p.lon))<=180;}
 function status(message,kind=''){const e=el('journeyAddressState');if(e){e.textContent=message;e.dataset.state=kind;}}
 function clearPin(){
   journeyTarget=null;selectedFromJourney=null;
   if(pin){pin.remove();pin=null;pinMap=null;}
   if(stableMap)stableMap.schedule?.();
 }
 function clearChoice(){
   requestNo++;
   clearPin();
   el('journeyDestination').value='';
   el('journeyTargetInfo').textContent='Nessuna meta GPS impostata';
   el('journeyChosenAddress')?.classList.add('hidden');
   el('journeyAddressResults')?.replaceChildren();
   status('Indirizzo modificato. Cerca nuovamente per scegliere la meta.');
 }
 window.ZyroJourneyAddressClear=clearChoice;
 function selected(point,label,manual=false){
   if(!valid(point))return;
   clearPin();journeyTarget={lat:Number(point.lat),lon:Number(point.lon)};
   const name=String(label||'Destinazione scelta').slice(0,160);
   selectedFromJourney={...journeyTarget,name,manual};
   el('journeyDestination').value=name.slice(0,70);
   el('journeyTargetInfo').textContent='Meta GPS verificata sulla mappa: '+journeyTarget.lat.toFixed(5)+', '+journeyTarget.lon.toFixed(5);
   el('journeyChosenLabel').textContent=name;
   el('journeyChosenAddress').classList.remove('hidden');
   el('journeyAddressResults')?.replaceChildren();
   status('Punto blu selezionato. Controllalo sulla Home, scegli i destinatari e avvia Accompagnami.','ok');
   renderMap();renderPin();
 }
 window.ZyroJourneyAddressSelected=selected;
 function renderPin(){
   if(!valid(journeyTarget)){
     if(pin){pin.remove();pin=null;pinMap=null;}
     return;
   }
   const map=stableMap?.map;
   if(map&&window.maplibregl?.Marker){
     if(!pin||pinMap!==map){
       if(pin)pin.remove();
       const node=document.createElement('div');
       node.className='zyro-journey-map-pin';
       node.title='Destinazione Accompagnami';
       node.textContent='●';
       pin=new window.maplibregl.Marker({element:node,anchor:'bottom'}).setLngLat([journeyTarget.lon,journeyTarget.lat]).addTo(map);
       pinMap=map;
     }else pin.setLngLat([journeyTarget.lon,journeyTarget.lat]);
     if(pendingFocus){pendingFocus=false;map.easeTo({center:[journeyTarget.lon,journeyTarget.lat],zoom:16,duration:400});}
   }else if(stableMap){
     // The built-in raster engine draws its blue pin in drawPins().
     stableMap.schedule?.();
     if(pendingFocus){pendingFocus=false;focusStableMap(journeyTarget.lat,journeyTarget.lon,16);}
   }
 }
 window.ZyroJourneyPinRender=renderPin;
 function restore(){
   const j=typeof current!=='undefined'?current?.me?.journey:null;
   if(!j||!['active','late','cancelled'].includes(j.status)||!valid(j.destinationPoint))return;
   if(selectedFromJourney?.name===j.destination||journeyTarget)return;
   selected(j.destinationPoint,j.destination);
   selectedFromJourney={...journeyTarget,name:j.destination,journeyId:j.id};
 }
 window.ZyroJourneyRestore=restore;
 function preview(){
   if(!valid(journeyTarget)){status('Seleziona prima un risultato o scegli il centro della mappa.','attention');return;}
   pendingFocus=true;
   showView('home');
   renderMap();
   renderPin();
   // Native vector maps can initialize asynchronously; the next render will focus.
   const retry=()=>{if(pendingFocus&&activeView==='home')renderPin();};
   setTimeout(retry,600);setTimeout(retry,1700);setTimeout(retry,3200);
   toast('Il puntino blu indica la meta scelta. Controlla che sia corretta, poi torna su Modalità → Accompagnami.');
 }
 async function search(){
   if(querying)return;
   const street=el('journeyStreet').value.trim(),city=el('journeyCity').value.trim(),postcode=el('journeyPostcode').value.trim();
   if(street.length<3||city.length<2||!postcode){status('Inserisci via, città e CAP prima di cercare.','attention');return;}
   const ticket=++requestNo;querying=true;
   const button=el('journeyFindAddress');button.disabled=true;
   const root=el('journeyAddressResults');root.replaceChildren();
   status('Ricerca della destinazione in corso…');
   try{
     const result=await post('/api/journey/geocode',{street,city,postcode});
     if(ticket!==requestNo)return;
     if(!Array.isArray(result.results)||!result.results.length){
       status('Nessun indirizzo trovato. Controlla via, città e CAP oppure seleziona manualmente il centro della mappa.','attention');return;
     }
     status('Seleziona il risultato corretto. La posizione può essere approssimativa.');
     for(const [i,p]of result.results.entries()){
       if(!valid(p))continue;
       const b=document.createElement('button');
       b.type='button';b.className='zyro-journey-result';
       b.setAttribute('aria-label','Seleziona destinazione '+p.label);
       const dot=document.createElement('span');dot.className='zyro-journey-blue-dot';dot.setAttribute('aria-hidden','true');
       const label=document.createElement('span');label.textContent=p.label||('Risultato '+(i+1));
       b.append(dot,label);b.addEventListener('click',()=>selected(p,p.label));
       root.appendChild(b);
     }
   }catch(error){if(ticket===requestNo)status(error.message||'Ricerca non disponibile.','attention');}
   finally{querying=false;button.disabled=false;}
 }
 function boot(){
   if(!el('journeyAddressSearch'))return;
   el('journeyFindAddress')?.addEventListener('click',()=>{void search();});
   el('journeySeePin')?.addEventListener('click',preview);
   for(const name of ['journeyStreet','journeyCity','journeyPostcode']){
     el(name)?.addEventListener('input',clearChoice);
     el(name)?.addEventListener('keydown',ev=>{if(ev.key==='Enter'){ev.preventDefault();void search();}});
   }
   restore();
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
