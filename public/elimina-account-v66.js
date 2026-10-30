'use strict';
const form=document.getElementById('webDeleteAccountForm');
form.addEventListener('submit',async event=>{
 event.preventDefault();
 if(!confirm('Confermi la cancellazione definitiva del tuo account ZYRO 360 e dei dati associati?'))return;
 const button=form.querySelector('button'),status=document.getElementById('deletionStatus');
 button.disabled=true;status.textContent='Eliminazione in corso…';
 try{
  const response=await fetch('/api/account/delete',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('deletionEmail').value,password:document.getElementById('deletionPassword').value,confirmation:document.getElementById('deletionConfirmation').value})});
  const data=await response.json();if(!response.ok||data.ok!==true)throw Error(data.error||'Cancellazione non confermata. Riprova o contatta l’assistenza.');
  form.reset();status.textContent='Account e dati associati eliminati dal servizio ZYRO 360. Se avevi un abbonamento, ricorda di gestirne il rinnovo su Google Play.';
 }catch(error){status.textContent=error.message||'Servizio non raggiungibile. Riprova o contatta l’assistenza.';}
 finally{document.getElementById('deletionPassword').value='';button.disabled=false;}
});
