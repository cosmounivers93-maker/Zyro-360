import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeChatView,summarizeChat,chatPage} from '../chat-view-core.mjs';

const a={id:'m1',at:1,from:'alex',name:'Alex',text:'Ciao'};
const b={id:'m2',at:2,from:'bea',name:'Bea',text:'Rispondo'};
const c={id:'m3',at:3,from:'bea',name:'Bea',text:'Altro messaggio'};
test('ogni account vede un numero differente di messaggi non letti',()=>{
 const messages=[a,b,c];
 assert.equal(summarizeChat(messages,'alex',{read:1}).unread,2);
 assert.equal(summarizeChat(messages,'bea',{read:0}).unread,1);
 assert.equal(summarizeChat(messages,'bea',{read:2}).unread,0);
});
test('lettura e cancellazione non mutano la cronologia comune',()=>{
 const messages=[a,b,c];
 const owner={cleared:3,read:3};
 const viewer={cleared:0,read:0};
 assert.deepEqual(chatPage(messages,owner),{messages:[],nextBefore:null,total:0});
 assert.equal(chatPage(messages,viewer).messages.length,3);
 assert.equal(summarizeChat(messages,'alex',owner).hidden,true);
 assert.equal(summarizeChat(messages,'bea',viewer).hidden,false);
 assert.equal(messages.length,3);
});
test('una risposta dopo la cancellazione riporta in elenco solo i nuovi messaggi',()=>{
 const messages=[a,b,c,{id:'m4',at:4,from:'bea',name:'Bea',text:'Di nuovo'}];
 const view={cleared:3,read:3};
 assert.deepEqual(chatPage(messages,view).messages.map(x=>x.id),['m4']);
 assert.equal(summarizeChat(messages,'alex',view).unread,1);
 assert.equal(summarizeChat(messages,'alex',view).hidden,false);
});
test('pagination never crosses cleared boundary',()=>{
 const messages=Array.from({length:200},(_,i)=>({id:String(i),at:i,from:'alex',name:'Alex',text:'x'}));
 const view={cleared:105,read:105};
 const newest=chatPage(messages,view);
 assert.equal(newest.messages.length,80);
 assert.equal(newest.nextBefore,120);
 const older=chatPage(messages,view,newest.nextBefore);
 assert.equal(older.messages.length,15);
 assert.equal(older.nextBefore,null);
 assert.equal(chatPage(messages,view,0).messages.length,0);
});
test('invalid persisted counters are clamped and do not unlock old data',()=>{
 assert.deepEqual(normalizeChatView([a,b],{cleared:-5,read:7}),{cleared:0,read:2});
 assert.deepEqual(normalizeChatView([a,b],{cleared:'9999',read:null}),{cleared:0,read:0});
});
