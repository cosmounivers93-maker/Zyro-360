import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const section=html.slice(html.indexOf('<section class="how-it-works" id="zyroHelp"'),html.indexOf('</section>',html.indexOf('<section class="how-it-works" id="zyroHelp"')));

test('help panel remains accessible in Settings and includes contact-permission guide',()=>{
 assert.ok(section.startsWith('<section class="how-it-works"'));
 assert.match(section,/aria-labelledby="howTitle"/);
 assert.match(section,/id="zyroHelpContactPermissions"/);
 assert.match(section,/Profilo → Impostazioni aggiuntive → Persone invitate/);
 for(const phrase of [
   'Può vedere il mio GPS','Riceve i miei SOS',
   'Può ascoltare il mio microfono durante SOS',
   'Può far squillare il mio telefono',
   'Può bloccare il mio telefono da remoto'
 ]) assert.ok(section.includes(phrase),phrase);
});
test('SOS microphone explanation requires global opt-in, recipient and Family',()=>{
 assert.match(section,/Abilita microfono durante SOS/);
 assert.match(section,/soltanto con Family/);
 assert.match(section,/«Può ascoltare il mio microfono durante SOS»/);
 assert.match(section,/non può accendere il tuo microfono da remoto/);
 assert.match(section,/non registra né conserva l’audio/);
 assert.match(section,/senza crittografia end-to-end/);
});
test('remote controls require theft alert, explicit authorization and Android device-admin',()=>{
 assert.match(section,/id="zyroHelpRemoteControl"/);
 assert.match(section,/Può far squillare il mio telefono/);
 assert.match(section,/Può bloccare il mio telefono da remoto/);
 assert.match(section,/Amministratore dispositivo/);
 assert.match(section,/allarme Pick Pocket attivo/);
 assert.match(section,/destinatari dell’allarme/);
 assert.match(section,/non conferma che lo squillo o il blocco sia stato eseguito/);
 assert.match(section,/Non disturbare/);
});
test('leaving the last shared circle revokes rights and existing help is preserved',()=>{
 assert.match(section,/se non fate più parte di nessun’altra cerchia in comune/);
 assert.match(section,/revocati i permessi GPS, SOS, ascolto audio e controllo remoto/);
 for(const topic of ['Chat riservata','Segui il percorso','Accompagnami','Check-in',
   'Notifiche e funzionamento in background','Emergenze e assistenza'])
   assert.ok(section.includes(topic),topic);
 assert.ok(!section.includes('non blocca Android e non impedisce lo spegnimento'));
});
test('Premium and Family include device-lock and approved remote action explanations',()=>{
 assert.match(section,/Premium, 3,99 € al mese/);
 assert.match(section,/Family, 6,99 € al mese/);
 assert.match(section,/blocco automatico dello schermo e comandi di squillo\/blocco remoto/);
 assert.match(section,/Family.*audio SOS con consenso/);
 assert.match(html,/Come funziona l'app<small>Guida a cerchie, SOS e protezioni remote/);
 assert.match(html,/Persone invitate<small>GPS, SOS, microfono e controllo remoto/);
});
test('accordion uses matching summary/detail structure',()=>{
 const details=section.match(/<details\b/g)||[];
 const closes=section.match(/<\/details>/g)||[];
 assert.equal(details.length,closes.length);
 assert.ok(details.length>=16);
 assert.equal((section.match(/id="zyroHelpContactPermissions"/g)||[]).length,1);
 assert.equal((section.match(/id="zyroHelpRemoteControl"/g)||[]).length,1);
});
