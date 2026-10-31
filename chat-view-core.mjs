// Pure per-user chat state utilities; never mutate or delete shared messages.
export function normalizeChatView(messages,view={}){
 const count=messages.length,clamp=n=>Number.isSafeInteger(n)?Math.min(count,Math.max(0,n)):0;
 return {cleared:clamp(view?.cleared),read:clamp(view?.read)};
}
export function summarizeChat(messages,viewerId,view={}){
 const {cleared,read}=normalizeChatView(messages,view);
 const latest=messages.length>cleared?messages[messages.length-1]:null;
 return {
  unread:messages.slice(Math.max(cleared,read)).filter(m=>m.from!==viewerId).length,
  lastAt:latest?.at||null,lastFrom:latest?.from||null,
  lastName:latest?.name||null,hidden:cleared>0&&!latest,
  preview:latest?(latest.text?String(latest.text).slice(0,80):'📷 Foto'):''
 };
}
export function chatPage(messages,view={},before){
 const {cleared}=normalizeChatView(messages,view);
 let end=before===undefined?messages.length:Math.min(messages.length,before);
 end=Math.max(cleared,end);
 const start=Math.max(cleared,end-80);
 return {messages:messages.slice(start,end),nextBefore:start>cleared?start:null,total:messages.length-cleared};
}
