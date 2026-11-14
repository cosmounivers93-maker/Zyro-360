// ZYRO 360 — report-case messaging. All permissions are checked server side.
// Never disclose the reporter's identity or the original report to the reported account.
export function installReportMessaging({
  app, getDb, requireAuth, requireAdmin, limit, now, token, cleanText,
  save, recordAction, isAdmin, notify
}) {
  const templates = {
    receipt: 'Abbiamo ricevuto la tua segnalazione. La esamineremo e ti informeremo sugli aggiornamenti. Grazie per averci contattato.',
    taking: 'La tua segnalazione è stata presa in carico dall’Amministrazione Zyro 360 ed è in fase di verifica.',
    closed: 'La tua segnalazione è stata esaminata e la pratica è stata conclusa. Grazie per la collaborazione.',
    dismissed: 'Abbiamo concluso la verifica della tua segnalazione. Al momento non sono previsti ulteriori provvedimenti. Grazie per averci contattato.'
  };
  const lookup = id => getDb().userReports.find(r => r.id === id);
  const append = (r, from, to, body, type='manual') => {
    r.messages ||= [];
    if (r.messages.length >= 120) throw Object.assign(new Error('Limite messaggi della pratica raggiunto.'), {status:409});
    const m = {id:token(9), at:now(), from, to, body, type, seenAt:null};
    r.messages.push(m);
    return m;
  };
  const inform = (r, kind) => {
    const body=templates[kind];
    if (!body) return;
    append(r,'admin','reporter',body,'automatic');
    notify(r.reporterId,'report-message',r.id,'Aggiornamento segnalazione • Zyro 360');
  };
  function onCreated(r) { inform(r,'receipt'); }
  function onStatusChanged(r) {
    if (r.status==='in_review') inform(r,'taking');
    else if (r.status==='reviewed' || r.status==='dismissed') inform(r,r.status==='dismissed'?'dismissed':'closed');
  }
  const asMember = (r,id) => r.reporterId===id ? 'reporter' : r.userId===id ? 'reported' : null;
  const visible = (r,id) => {
    const role=asMember(r,id);
    if (!role) return null;
    const messages=(r.messages||[]).filter(m=>m.to===role || m.from===role).map(m=>({
      id:m.id,at:m.at,from:m.from==='admin'?'admin':'me',body:m.body,
      type:m.type,seenAt:m.seenAt||null
    }));
    // Only make a reported user's case visible once an official message has been sent.
    if (role==='reported' && !(r.messages||[]).some(m=>m.to==='reported')) return null;
    return {
      id:r.id,role,at:r.at,status:r.status,messages,
      ...(role==='reporter'?{reason:r.reason,reportedName:getDb().users[r.userId]?.name||'Utente'}:{})
    };
  };
  app.get('/api/reports/mine',requireAuth,(req,res)=>{
    const items=getDb().userReports.slice(-100).reverse().map(r=>visible(r,req.user.id)).filter(Boolean);
    res.set('Cache-Control','no-store').json({reports:items});
  });
  app.post('/api/reports/reply',requireAuth,limit,(req,res)=>{
    const r=lookup(String(req.body?.reportId||''));
    const role=r&&asMember(r,req.user.id);
    const body=cleanText(req.body?.body,800);
    if (!role || (role==='reported'&&!(r.messages||[]).some(m=>m.to==='reported')))
      return res.status(404).json({error:'Pratica non disponibile.'});
    if (body.length<3) return res.status(400).json({error:'Scrivi un messaggio di almeno 3 caratteri.'});
    try {append(r,role,'admin',body,'reply');}catch(e){return res.status(e.status||400).json({error:e.message});}
    recordAction('report-user-reply',req.user.id,r.id,role);
    save();
    notify(null,'admin-new-report',r.id,'Risposta a una segnalazione • Zyro 360');
    res.json({ok:true});
  });
  app.post('/api/reports/read',requireAuth,limit,(req,res)=>{
    const r=lookup(String(req.body?.reportId||''));
    const role=r&&asMember(r,req.user.id);
    if (!role || (role==='reported'&&!(r.messages||[]).some(m=>m.to==='reported')))
      return res.status(404).json({error:'Pratica non disponibile.'});
    let changed=false;
    for (const m of (r.messages||[])) if (m.to===role && !m.seenAt) {m.seenAt=now();changed=true;}
    if(changed)save();
    res.json({ok:true});
  });
  app.post('/api/admin/report-message',requireAuth,requireAdmin,limit,(req,res)=>{
    const r=lookup(String(req.body?.reportId||''));
    const to=req.body?.recipient;
    const body=cleanText(req.body?.body,800);
    if (!r)return res.status(404).json({error:'Pratica non trovata.'});
    if(!['reporter','reported'].includes(to))return res.status(400).json({error:'Destinatario non valido.'});
    if(body.length<10)return res.status(400).json({error:'Scrivi almeno 10 caratteri.'});
    const id=to==='reporter'?r.reporterId:r.userId;
    if(!getDb().users[id] || getDb().users[id].bannedAt)
      return res.status(409).json({error:'Il destinatario non può ricevere messaggi.'});
    try {append(r,'admin',to,body);}catch(e){return res.status(e.status||400).json({error:e.message});}
    recordAction('report-message-'+to,req.user.id,id,'Pratica '+r.id);
    save();
    notify(id,'report-message',r.id,'Messaggio dall’Amministrazione Zyro 360');
    res.json({ok:true});
  });
  app.post('/api/admin/report-take',requireAuth,requireAdmin,limit,(req,res)=>{
    const r=lookup(String(req.body?.reportId||''));
    if (!r)return res.status(404).json({error:'Pratica non trovata.'});
    if(r.status!=='open')return res.status(409).json({error:'Pratica già presa in carico o conclusa.'});
    r.status='in_review';r.takenAt=now();r.takenBy=req.user.id;
    try {onStatusChanged(r);}catch(e){return res.status(e.status||400).json({error:e.message});}
    recordAction('report-taken',req.user.id,r.userId,r.id);
    save();res.json({ok:true});
  });
  return {onCreated,onStatusChanged};
}
