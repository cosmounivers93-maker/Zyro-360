// Remove only the requested account and its associated application data.
export function eraseAccount(db,id){
 if(!db.users[id])throw Error('Account non disponibile.');
 delete db.users[id];
 for(const [key,session] of Object.entries(db.sessions))if(session.userId===id)delete db.sessions[key];
 db.memberships=db.memberships.filter(m=>m.userId!==id);
 for(const membership of db.memberships)if(membership.invitedBy===id)delete membership.invitedBy;
 const emptyCircles=new Set();
 for(const [key,circle] of Object.entries(db.circles)){
  const members=db.memberships.filter(m=>m.circleId===key);
  if(!members.length){emptyCircles.add(key);delete db.circles[key];}
  else if(circle.ownerId===id)circle.ownerId=members[0].userId;
 }
 for(const [key,invite] of Object.entries(db.invites))if(invite.createdBy===id||emptyCircles.has(invite.circleId))delete db.invites[key];
 for(const collection of ['alerts','journeys','checkins'])for(const [key,item] of Object.entries(db[collection]||{})){
  if(item.userId===id)delete db[collection][key];
  else if(Array.isArray(item.recipients))item.recipients=item.recipients.filter(x=>x!==id);
 }
 for(const [key,messages] of Object.entries(db.messages||{})){
  if(key.startsWith('direct:')&&key.slice(7).split(':').includes(id)||key.startsWith('circle:')&&emptyCircles.has(key.slice(7)))delete db.messages[key];
  else db.messages[key]=messages.filter(m=>m.from!==id);
 }
 for(const user of Object.values(db.users)){
  for(const field of ['gpsRecipients','sosRecipients'])if(Array.isArray(user[field]))user[field]=user[field].filter(x=>x!==id);
  if(user.premiumGiftBy===id)delete user.premiumGiftBy;
 }
 db.userReports=(db.userReports||[]).filter(r=>r.userId!==id&&r.reporterId!==id);
 db.adminAudit=(db.adminAudit||[]).filter(a=>a.by!==id&&a.for!==id);
 return db;
}
