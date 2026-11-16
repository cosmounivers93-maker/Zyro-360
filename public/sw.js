'use strict';
const CACHE='zyro-360-v190-push-accompagnami';
const ASSETS=['/','/index.html','/style.css','/zyro-settings-compact.css','/zyro-glass-v162.css','/zyro-settings-balanced-v163.css','/zyro-home-glass-v169.css','/zyro-home-true-glass-v170.css','/zyro-gradient-admin-v171.css','/zyro-id-admin-v1.css','/zyro-circle-modes-v2.css','/zyro-circle-picker-v3.css','/zyro-final-circle-status-v4.css','/zyro-group-circle-code-v5.css','/zyro-circle-picker-v3.js','/app.js','/zyro-release-185-light.css','/zyro-home-final-v187.css','/zyro-approved-glass-v188.css','/manifest.webmanifest','/assets/icon192.png','/assets/icon512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(async cache=>{await Promise.all(ASSETS.map(async url=>{try{await cache.add(url);}catch{/* Asset opzionale mancante: installa comunque l'aggiornamento. */}}));}));self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).pathname.startsWith('/api/'))return;
  event.respondWith(fetch(event.request,{cache:'no-store'}).catch(()=>caches.match(event.request,{ignoreSearch:true})));
});
self.addEventListener('push',event=>{
  let info={title:'🆘 Nuovo SOS',body:'Una persona fidata ha bisogno di aiuto.',url:'/'};
  try{Object.assign(info,event.data?.json()||{});}catch{}
  const isTest=info.kind==='test';
  const urgent=info.kind==='sos'||info.kind==='pickpocket';
  const kind=typeof info.kind==='string'?info.kind:'general';
  const tag=isTest?'zyro360-test':urgent?'zyro360-safety':kind==='chat'
    ?'zyro360-chat-'+Date.now():kind==='journey-request'?'zyro360-journey-request':'zyro360-'+kind;
  event.waitUntil(self.registration.showNotification(info.title,{
    body:info.body,icon:'/assets/icon192.png',badge:'/assets/icon192.png',
    tag,renotify:urgent,data:{url:'/',kind},requireInteraction:urgent
  }));
});
self.addEventListener('notificationclick',event=>{
  const kind=event.notification.data?.kind||'general';
  const allowed=new Set(['chat','journey-request','journey-response','checkin','sos','pickpocket','invite']);
  const safeKind=allowed.has(kind)?kind:'general';
  event.notification.close();event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async cs=>{
    for(const client of cs){
      if(client.url.startsWith(self.location.origin)){
        await client.focus();
        client.postMessage({type:'zyro:push-open',kind:safeKind});
        return;
      }
    }
    return self.clients.openWindow('/?zyro_push_kind='+encodeURIComponent(safeKind));
  }));
});
