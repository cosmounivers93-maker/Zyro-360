import crypto from 'node:crypto';
export const PACKAGE='com.zyro360.app';
export const PRODUCTS={zyro_premium_monthly:{plan:'personal',basePlanId:'monthly'},zyro_family_monthly:{plan:'family',basePlanId:'monthly'}};
export const accountId=id=>crypto.createHash('sha256').update(`zyro360:${id}`).digest('hex');
const digest=token=>crypto.createHash('sha256').update(token).digest('hex');
const allowedStates=new Set(['SUBSCRIPTION_STATE_ACTIVE','SUBSCRIPTION_STATE_IN_GRACE_PERIOD','SUBSCRIPTION_STATE_CANCELED']);
export function evaluatePurchase(purchase,userId,time=Date.now()){
 if(purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId!==accountId(userId))throw new Error('Acquisto associato a un altro account ZYRO 360.');
 const items=(purchase.lineItems||[]).filter(x=>Object.hasOwn(PRODUCTS,x.productId) && x.offerDetails?.basePlanId===PRODUCTS[x.productId].basePlanId && x.autoRenewingPlan && !x.autoRenewingPlan.installmentDetails && Number.isFinite(Date.parse(x.expiryTime)));
 const active=items.filter(x=>Date.parse(x.expiryTime)>time && !x.deferredItemReplacement);
 // A deferred replacement leaves the current item active until its expiry.
 const candidates=active.length?active:items.filter(x=>Date.parse(x.expiryTime)>time);
 candidates.sort((a,b)=>(PRODUCTS[b.productId].plan==='family')-(PRODUCTS[a.productId].plan==='family') || Date.parse(b.expiryTime)-Date.parse(a.expiryTime));
 const item=candidates[0]||items[0];
 if(!item)throw new Error('Prodotto o piano base Google Play non riconosciuto.');
 return {productId:item.productId,plan:PRODUCTS[item.productId].plan,state:purchase.subscriptionState,expiresAt:Date.parse(item.expiryTime),active:allowedStates.has(purchase.subscriptionState)&&Date.parse(item.expiryTime)>time,autoRenew:item.autoRenewingPlan.autoRenewEnabled===true};
}
export function createTokenCipher(base64){
 const key=Buffer.from(base64||'','base64');if(key.length!==32)throw new Error('Chiave cifratura acquisti non valida.');
 return {encrypt(token){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);const b=Buffer.concat([c.update(token,'utf8'),c.final()]);return [iv,c.getAuthTag(),b].map(x=>x.toString('base64url')).join('.');},decrypt(value){const [iv,tag,b]=String(value).split('.').map(x=>Buffer.from(x,'base64url'));const d=crypto.createDecipheriv('aes-256-gcm',key,iv);d.setAuthTag(tag);return Buffer.concat([d.update(b),d.final()]).toString('utf8');}};
}
export class PlayRepository{
 constructor(pool){this.pool=pool;}
 async init(){await this.pool.query(`CREATE TABLE IF NOT EXISTS zyro_play_receipts (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,encrypted_token TEXT NOT NULL,product_id TEXT NOT NULL,plan TEXT NOT NULL,state TEXT NOT NULL,expires_at BIGINT NOT NULL,checked_at BIGINT NOT NULL,auto_renew BOOLEAN NOT NULL,active BOOLEAN NOT NULL)`);await this.pool.query('CREATE INDEX IF NOT EXISTS zyro_play_receipts_user ON zyro_play_receipts(user_id)');}
 row(r){return r&&{tokenHash:r.token_hash,userId:r.user_id,encryptedToken:r.encrypted_token,productId:r.product_id,plan:r.plan,state:r.state,expiresAt:Number(r.expires_at),checkedAt:Number(r.checked_at),autoRenew:r.auto_renew,active:r.active};}
 async get(hash){return this.row((await this.pool.query('SELECT * FROM zyro_play_receipts WHERE token_hash=$1',[hash])).rows[0]);}
 async put(r){const result=await this.pool.query(`INSERT INTO zyro_play_receipts VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(token_hash) DO UPDATE SET encrypted_token=EXCLUDED.encrypted_token,product_id=EXCLUDED.product_id,plan=EXCLUDED.plan,state=EXCLUDED.state,expires_at=EXCLUDED.expires_at,checked_at=EXCLUDED.checked_at,auto_renew=EXCLUDED.auto_renew,active=EXCLUDED.active WHERE zyro_play_receipts.user_id=EXCLUDED.user_id RETURNING token_hash`,[r.tokenHash,r.userId,r.encryptedToken,r.productId,r.plan,r.state,r.expiresAt,r.checkedAt,r.autoRenew,r.active]);if(!result.rowCount)throw new Error('Acquisto già associato a un altro account.');}
 async user(id){return (await this.pool.query('SELECT * FROM zyro_play_receipts WHERE user_id=$1',[id])).rows.map(r=>this.row(r));}
 async due(time){return (await this.pool.query('SELECT * FROM zyro_play_receipts WHERE checked_at<$1 AND expires_at>$2 ORDER BY checked_at LIMIT 20',[time-300000,time-60*86400000])).rows.map(r=>this.row(r));}
 async all(){return (await this.pool.query('SELECT * FROM zyro_play_receipts WHERE expires_at>$1',[Date.now()])).rows.map(r=>this.row(r));}
}
export class GooglePlayApi{
 constructor(credentials,fetcher=fetch){this.credentials=credentials;this.fetcher=fetcher;this.access=null;this.keys=null;}
 async accessToken(){
  if(this.access?.until>Date.now()+60000)return this.access.token;
  const c=this.credentials,iat=Math.floor(Date.now()/1000),enc=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned=enc({alg:'RS256',typ:'JWT'})+'.'+enc({iss:c.client_email,scope:'https://www.googleapis.com/auth/androidpublisher',aud:'https://oauth2.googleapis.com/token',iat,exp:iat+3600});
  const signature=crypto.sign('RSA-SHA256',Buffer.from(unsigned),c.private_key).toString('base64url');
  const response=await this.fetcher('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:unsigned+'.'+signature}),signal:AbortSignal.timeout(15000)});
  const json=await response.json();if(!response.ok||typeof json.access_token!=='string')throw new Error('Autorizzazione Google Play non disponibile.');this.access={token:json.access_token,until:Date.now()+Number(json.expires_in||3600)*1000};return json.access_token;
 }
 async request(path,body){
  const token=await this.accessToken();const r=await this.fetcher('https://androidpublisher.googleapis.com/androidpublisher/v3/applications/'+PACKAGE+'/purchases/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  if(!r.ok){const error=new Error('Verifica Google Play temporaneamente non disponibile.');error.googleStatus=r.status;throw error;}const raw=await r.text();return raw?JSON.parse(raw):{};
 }
 get(token){return this.request('subscriptionsv2/tokens/'+encodeURIComponent(token));}
 acknowledge(token,productId){return this.request('subscriptions/'+encodeURIComponent(productId)+'/tokens/'+encodeURIComponent(token)+':acknowledge',{});}
 async verifyPush(authorization,audience,email){
  if(!audience||!email||!/^Bearer [\w.-]+$/.test(authorization||''))throw new Error('Notifica non autorizzata.');
  const jwt=authorization.slice(7),parts=jwt.split('.');if(parts.length!==3)throw new Error('Notifica non autorizzata.');
  const h=JSON.parse(Buffer.from(parts[0],'base64url')),p=JSON.parse(Buffer.from(parts[1],'base64url'));
  if(h.alg!=='RS256'||typeof h.kid!=='string')throw new Error('Notifica non autorizzata.');
  if(!this.keys||this.keys.until<Date.now()||!this.keys.values.some(k=>k.kid===h.kid)){
   const response=await this.fetcher('https://www.googleapis.com/oauth2/v3/certs',{signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('Certificati Google non disponibili.');const json=await response.json();this.keys={values:json.keys||[],until:Date.now()+3600000};
  }
  const jwk=this.keys.values.find(k=>k.kid===h.kid);if(!jwk||!crypto.verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),crypto.createPublicKey({key:jwk,format:'jwk'}),Buffer.from(parts[2],'base64url')))throw new Error('Notifica non autorizzata.');
  const time=Date.now()/1000;if(!['accounts.google.com','https://accounts.google.com'].includes(p.iss)||p.aud!==audience||p.email!==email||p.email_verified!==true||!(p.exp>time)||!(p.iat<=time+60))throw new Error('Notifica non autorizzata.');
 }
}
export class PlayBilling{
 constructor({repo,google,cipher,clock=Date.now,onChange=()=>{}}){Object.assign(this,{repo,google,cipher,clock,onChange});this.cache=new Map();this.locks=new Map();this.retryAt=new Map();this.ready=true;}
 async init(){await this.repo.init();for(const r of await this.repo.all()){const list=this.cache.get(r.userId)||[];list.push(r);this.cache.set(r.userId,list);}}
 entitlement(userId){const time=this.clock();const rows=(this.cache.get(userId)||[]).filter(r=>r.active&&r.expiresAt>time&&r.checkedAt+900000>time);rows.sort((a,b)=>(b.plan==='family')-(a.plan==='family')||b.expiresAt-a.expiresAt);return rows[0]||null;}
 async refreshUser(id){this.cache.set(id,await this.repo.user(id));this.onChange(id);}
 async verify(userId,token){
  if(typeof token!=='string'||token.length<16||token.length>4096)throw new Error('Ricevuta Google Play non valida.');
  const key=digest(token);const previous=this.locks.get(key)||Promise.resolve();
  const job=previous.catch(()=>{}).then(()=>this.verifyUnlocked(userId,token,key));this.locks.set(key,job);
  try{return await job;}finally{if(this.locks.get(key)===job)this.locks.delete(key);}
 }
 async verifyUnlocked(userId,token,key){
  const existing=await this.repo.get(key);if(existing&&existing.userId!==userId)throw new Error('Acquisto già associato a un altro account.');
  let purchase;
  try{purchase=await this.google.get(token);}catch(error){
   if(existing&&[404,410].includes(error.googleStatus)){await this.repo.put({...existing,active:false,state:'UNAVAILABLE',checkedAt:this.clock()});await this.refreshUser(userId);return {active:false,state:'UNAVAILABLE'};}throw error;
  }
  const data=evaluatePurchase(purchase,userId,this.clock());
  if(purchase.linkedPurchaseToken){const old=await this.repo.get(digest(purchase.linkedPurchaseToken));if(old&&old.userId!==userId)throw new Error('Acquisto precedente associato a un altro account.');}
  const row={...data,tokenHash:key,userId,encryptedToken:this.cipher.encrypt(token),checkedAt:this.clock()};
  // Persist ownership and verification before acknowledgement, then allow access.
  await this.repo.put({...row,active:false});
  if(data.active&&purchase.acknowledgementState==='ACKNOWLEDGEMENT_STATE_PENDING')await this.google.acknowledge(token,data.productId);
  if(data.active&&!['ACKNOWLEDGEMENT_STATE_PENDING','ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'].includes(purchase.acknowledgementState))throw new Error('Conferma acquisto Google Play non disponibile.');
  await this.repo.put(row);
  // Reverify the linked receipt so a replaced Family plan cannot outlive an upgrade/downgrade.
  if(purchase.linkedPurchaseToken){const old=await this.repo.get(digest(purchase.linkedPurchaseToken));if(old){try{const prior=await this.google.get(purchase.linkedPurchaseToken);const priorData=evaluatePurchase(prior,userId,this.clock());await this.repo.put({...old,...priorData,checkedAt:this.clock()});}catch{await this.repo.put({...old,active:false,checkedAt:this.clock()});}}}
  await this.refreshUser(userId);return {active:data.active,plan:data.plan,expiresAt:data.expiresAt,state:data.state,autoRenew:data.autoRenew};
 }
 async sweep(){if(this.sweeping)return;this.sweeping=true;try{for(const row of await this.repo.due(this.clock())){if((this.retryAt.get(row.tokenHash)||0)>this.clock())continue;try{await this.verify(row.userId,this.cipher.decrypt(row.encryptedToken));this.retryAt.delete(row.tokenHash);}catch{this.retryAt.set(row.tokenHash,this.clock()+300000);}}}finally{this.sweeping=false;}}
}
