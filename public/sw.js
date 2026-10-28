'use strict';
const CACHE='zyro-360-v14.6-dark-legibility';
const ASSETS=['/','/index.html','/style.css','/app.js','/manifest.webmanifest','/assets/icon192.png','/assets/icon512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(async cache=>{await Promise.all(ASSETS.map(async url=>{try{await cache.add(url);}catch{/* Asset opzionale mancante: installa comunque l'aggiornamento. */}}));}));self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).pathname.startsWith('/api/'))return;
  event.respondWith(fetch(event.request).catch(()=>caches.match(event.request,{ignoreSearch:true})));
});
self.addEventListener('push',event=>{
  let info={title:'🆘 Nuovo SOS',body:'Una persona fidata ha bisogno di aiuto.',url:'/'};
  try{Object.assign(info,event.data?.json()||{});}catch{}
  event.waitUntil(self.registration.showNotification(info.title,{body:info.body,icon:'/assets/icon192.png',badge:'/assets/icon192.png',tag:'zyro360-sos',renotify:true,data:{url:'/'},requireInteraction:true}));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async cs=>{
    for(const client of cs){if(client.url.startsWith(self.location.origin)){await client.focus();return;}}
    return self.clients.openWindow('/');
  }));
});
