import { createClient } from '@libsql/client/web';

let schemaReady = null;
const COLLECTIONS = new Set(['prospects','pipeline','contracts','signed','closed','audit','devices','historicalPorts']);

function client(env){
  if(!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) throw new Error('Turso nu este configurat');
  return createClient({url:env.TURSO_DATABASE_URL, authToken:env.TURSO_AUTH_TOKEN});
}
function json(data,status=200,headers={}){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}})}
function hex(bytes){return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('')}
async function sha256(text){return hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))}
async function passwordHash(env,code,password){
  const secret=env.PASSWORD_PEPPER||'';
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return hex(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${String(code).toUpperCase()}:${password}`)));
}
function randomToken(){const b=new Uint8Array(32);crypto.getRandomValues(b);return [...b].map(x=>x.toString(16).padStart(2,'0')).join('')}
function safeUser(row){return {id:row.id,code:row.code,name:row.name,role:row.role,appCode:row.app_code||'',active:!!row.active,lastLogin:row.last_login||'',createdAt:row.created_at||''}}
function parseBody(request){return request.json().catch(()=>({}))}
function now(){return new Date().toISOString()}

async function ensureSchema(env){
  if(schemaReady) return schemaReady;
  schemaReady=(async()=>{
    const db=client(env);
    const stmts=[
      `CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, app_code TEXT, active INTEGER NOT NULL DEFAULT 1, last_login TEXT, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS records(collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT, PRIMARY KEY(collection,id))`,
      `CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)`,
      `CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection)`
    ];
    await db.batch(stmts.map(sql=>({sql,args:[]})),'write');
  })();
  try{return await schemaReady}catch(e){schemaReady=null;throw e}
}

async function auth(request,env){
  const h=request.headers.get('authorization')||'';
  const token=h.startsWith('Bearer ')?h.slice(7):'';
  if(!token) return null;
  const db=client(env), th=await sha256(token);
  const r=await db.execute({sql:`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1 LIMIT 1`,args:[th,now()]});
  return r.rows[0]||null;
}
function requireRole(user,roles){return user&&roles.includes(user.role)}


async function handleSetupStatus(env){
  const db=client(env),cnt=await db.execute(`SELECT COUNT(*) AS n FROM users`);
  return json({needsSetup:Number(cnt.rows[0]?.n||0)===0});
}

async function handleSetup(request,env){
  if((request.headers.get('x-setup-key')||'')!==env.SETUP_KEY) return json({error:'Setup key invalid'},403);
  const db=client(env), cnt=await db.execute(`SELECT COUNT(*) AS n FROM users`);
  if(Number(cnt.rows[0]?.n||0)>0) return json({error:'Setup-ul a fost deja făcut.'},409);
  const b=await parseBody(request),code=String(b.code||'').trim().toUpperCase(),password=String(b.password||'').trim(),name=String(b.name||'').trim();
  if(!code||!name) return json({error:'Numele și codul Managerului sunt obligatorii.'},400);
  if(!password||password.length<6) return json({error:'Parola inițială trebuie să aibă minimum 6 caractere.'},400);
  const id=crypto.randomUUID(),hash=await passwordHash(env,code,password),ts=now();
  await db.execute({sql:`INSERT INTO users(id,code,password_hash,name,role,app_code,active,created_at) VALUES(?,?,?,?,?,?,1,?)`,args:[id,code,hash,name,'Manager',String(b.appCode||''),ts]});
  return json({ok:true,message:'Managerul inițial a fost creat.',user:{id,code,name,role:'Manager',appCode:String(b.appCode||''),active:true}});
}
async function handleLogin(request,env){
  const b=await parseBody(request),code=String(b.code||'').trim().toUpperCase(),password=String(b.password||'');
  const db=client(env),r=await db.execute({sql:`SELECT * FROM users WHERE upper(code)=? AND active=1 LIMIT 1`,args:[code]});
  const u=r.rows[0];
  if(!u || u.password_hash!==await passwordHash(env,code,password)) return json({error:'Cod sau parolă incorectă.'},401);
  const token=randomToken(),th=await sha256(token),hours=Math.max(1,Number(env.SESSION_HOURS||12)),exp=new Date(Date.now()+hours*3600000).toISOString(),ts=now();
  await db.batch([
    {sql:`INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)`,args:[th,u.id,exp,ts]},
    {sql:`UPDATE users SET last_login=? WHERE id=?`,args:[ts,u.id]},
    {sql:`DELETE FROM sessions WHERE expires_at<=?`,args:[ts]}
  ],'write');
  u.last_login=ts;
  return json({token,user:safeUser(u),expiresAt:exp});
}
async function handleBootstrap(user,env){
  const db=client(env),recs=await db.execute(`SELECT collection,id,data FROM records`),state={};
  for(const c of COLLECTIONS) state[c]=[];
  for(const row of recs.rows){
    if(!COLLECTIONS.has(row.collection))continue;
    try{
      const item=JSON.parse(row.data);
      if(user.role==='Manager'||row.collection==='devices'||
        (user.role==='BackOffice'&&['contracts','signed','audit'].includes(row.collection))||
        (user.role==='Agent'&&(['prospects','pipeline','contracts','signed','closed','historicalPorts'].includes(row.collection)&&item.agentId===user.id||row.collection==='audit'&&item.user===user.code)))state[row.collection].push(item);
    }catch{}
  }
  const rr=await db.execute({sql:`SELECT data FROM settings WHERE key='rules'`,args:[]});
  let rules=null;try{rules=rr.rows[0]?JSON.parse(rr.rows[0].data):null}catch{}
  const users=await db.execute(`SELECT id,code,name,role,app_code,active,last_login,created_at FROM users ORDER BY role,name`);
  return json({user:safeUser(user),users:users.rows.map(safeUser),state,rules});
}
async function handlePatch(request,user,env){
  const b=await parseBody(request),db=client(env),stmts=[],ts=now();
  const cols=b.collections||{};
  if(b.rules && user.role!=='Manager') return json({error:'Doar Managerul poate modifica regulile comerciale.'},403);
  for(const [collection,ops] of Object.entries(cols)){
    if(!COLLECTIONS.has(collection)) continue;
    const editable = user.role==='Manager'||
      (user.role==='BackOffice'&&['contracts','signed','audit'].includes(collection))||
      (user.role==='Agent'&&['prospects','pipeline','contracts','historicalPorts','audit'].includes(collection));
    if(!editable)return json({error:'Permisiune insuficientă pentru '+collection},403);
    for(const item of (ops?.upsert||[])){
      if(!item?.id) continue;
      // Blocaj server: nimeni nu poate falsifica semnarea / sari peste etapa BO prin sincronizarea generica.
      if(collection==='contracts'){
        const rr=await db.execute({sql:`SELECT data FROM records WHERE collection='contracts' AND id=? LIMIT 1`,args:[String(item.id)]});
        let previous=null;
        if(rr.rows[0]){try{previous=JSON.parse(rr.rows[0].data)}catch{return json({error:'Contractul stocat are date invalide.'},500)}}
        const protectedFields=['signatureConfirmedAt','signatureMethod','signatureProof','signatureNote','signatureConfirmedBy'];
        if(previous){
          if(protectedFields.some(k=>String(item[k]??'')!==String(previous[k]??'')))return json({error:'Datele de semnare se pot schimba numai prin confirmarea BO.'},403);
          if(item.status==='Anulat'&&previous.status!=='Anulat')return json({error:'Anularea necesită motiv și endpointul dedicat.'},403);
          if(previous.status==='Anulat'&&item.status!=='Anulat')return json({error:'Contractul este anulat.'},409);
        }else if(protectedFields.some(k=>String(item[k]??'')!==''))return json({error:'Nu crea contracte cu semnarea deja confirmată.'},403);
        if((['Verificare Risk','Verificare Frauda','Avans/Depozit necesar','Rezolvat'].includes(item.boStatus)||['Semnat','Anulat'].includes(item.status))&&!previous?.signatureConfirmedAt&&item.status!=='Anulat')return json({error:'Contractul trebuie semnat înainte de validare.'},409);
        if(!previous&&['Semnat','Anulat'].includes(item.status))return json({error:'Contractul nu poate fi creat direct ca finalizat/anulat.'},403);
      }
      if(user.role==='Agent'){
        if(collection==='audit'){
          if(item.user!==user.code)return json({error:'Audit invalid.'},403);
        }else{
          if(item.agentId!==user.id)return json({error:'Înregistrarea nu îți aparține.'},403);
          if(collection==='historicalPorts'&&item.status!=='De validat')return json({error:'Validarea portărilor aparține Managerului.'},403);
          if(collection==='contracts'&&['Anulat','Semnat'].includes(item.status))return json({error:'Finalizarea și anularea sunt rezervate BO/Managerului.'},403);
          if(collection==='contracts'&&(item.signatureConfirmedAt||item.signatureMethod))return json({error:'Agentul nu poate modifica confirmarea semnării.'},403);
        }
      }
      if(user.role!=='Manager'){
        const existing=await db.execute({sql:`SELECT data FROM records WHERE collection=? AND id=? LIMIT 1`,args:[collection,String(item.id)]});
        if(existing.rows[0]){
          let prev={};try{prev=JSON.parse(existing.rows[0].data)}catch{}
          if(user.role==='Agent'&&prev.agentId!==user.id)return json({error:'Nu poți modifica alt agent.'},403);
          if(user.role==='Agent'&&prev.status==='Anulat')return json({error:'Contract anulat - read only.'},409);
          if(collection==='contracts'&&String(item.signatureConfirmedAt||'')!==String(prev.signatureConfirmedAt||''))return json({error:'Confirmarea semnării se face exclusiv prin endpointul BO.'},403);
          if(collection==='contracts'&&user.role==='Agent'&&item.boStatus!==prev.boStatus&&!(prev.status==='Configurare'&&item.boStatus==='Nou la BO')&&!(prev.status==='De corectat'&&item.boStatus==='Nou la BO'))return json({error:'Agentul nu poate schimba statusul BO.'},403);
          if(user.role==='Agent'&&collection==='contracts'&&(String(item.signatureConfirmedAt||'')!==String(prev.signatureConfirmedAt||'')||String(item.signatureMethod||'')!==String(prev.signatureMethod||'')))return json({error:'Semnarea este rezervată BackOffice.'},403);
        }
      }
      stmts.push({sql:`INSERT INTO records(collection,id,data,updated_at,updated_by) VALUES(?,?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,args:[collection,String(item.id),JSON.stringify(item),ts,user.id]});
    }
    for(const id of (ops?.delete||[])){
      if(user.role==='Agent'||(user.role==='BackOffice'&&collection==='signed'))return json({error:'Ștergerea directă nu este permisă pentru această colecție.'},403);
      stmts.push({sql:`DELETE FROM records WHERE collection=? AND id=?`,args:[collection,String(id)]});
    }
  }
  if(b.rules) stmts.push({sql:`INSERT INTO settings(key,data,updated_at,updated_by) VALUES('rules',?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,args:[JSON.stringify(b.rules),ts,user.id]});
  if(stmts.length) await db.batch(stmts,'write');
  return json({ok:true,writes:stmts.length,at:ts});
}

async function handleUserSave(request,user,env){
  if(!requireRole(user,['Manager'])) return json({error:'Doar Manager.'},403);
  const b=await parseBody(request),db=client(env),id=String(b.id||crypto.randomUUID()),code=String(b.code||'').trim().toUpperCase(),name=String(b.name||'').trim(),role=String(b.role||'Agent'),active=b.active===false?0:1,appCode=String(b.appCode||'');
  if(!code||!name||!['Agent','BackOffice','Manager'].includes(role)) return json({error:'Date utilizator invalide.'},400);
  const existing=await db.execute({sql:`SELECT * FROM users WHERE id=?`,args:[id]});
  if(existing.rows[0]){
    const stmts=[{sql:`UPDATE users SET code=?,name=?,role=?,app_code=?,active=? WHERE id=?`,args:[code,name,role,appCode,active,id]}];
    if(b.password)stmts.push({sql:`UPDATE users SET password_hash=? WHERE id=?`,args:[await passwordHash(env,code,String(b.password)),id]});
    await db.batch(stmts,'write');
  }else{
    if(!b.password) return json({error:'Parola este obligatorie pentru un cont nou.'},400);
    await db.execute({sql:`INSERT INTO users(id,code,password_hash,name,role,app_code,active,created_at) VALUES(?,?,?,?,?,?,?,?)`,args:[id,code,await passwordHash(env,code,String(b.password)),name,role,appCode,active,now()]});
  }
  const r=await db.execute({sql:`SELECT * FROM users WHERE id=?`,args:[id]});
  return json({ok:true,user:safeUser(r.rows[0])});
}
async function handlePassword(request,user,env){
  if(!requireRole(user,['Manager'])) return json({error:'Doar Manager.'},403);
  const b=await parseBody(request),db=client(env),r=await db.execute({sql:`SELECT code FROM users WHERE id=?`,args:[String(b.id||'')]});
  if(!r.rows[0]||!b.password) return json({error:'Utilizator/parolă invalidă.'},400);
  await db.execute({sql:`UPDATE users SET password_hash=? WHERE id=?`,args:[await passwordHash(env,r.rows[0].code,String(b.password)),String(b.id)]});
  return json({ok:true});
}
async function handleUserDelete(id,user,env){
  if(!requireRole(user,['Manager'])) return json({error:'Doar Manager.'},403);
  if(id===user.id) return json({error:'Nu îți poți șterge propriul cont.'},400);
  const db=client(env);await db.execute({sql:`DELETE FROM users WHERE id=?`,args:[id]});return json({ok:true});
}


function cleanCui(v){return String(v||'').replace(/^RO/i,'').replace(/\D/g,'')}
function pickAdmin(reps=[]){
  if(!Array.isArray(reps)||!reps.length)return'';
  const active=reps.filter(r=>r&&r.name&&r.roleCategory!=='procedural');
  const preferred=active.find(r=>/admin|director|represent/i.test(String(r.role||'')))||active[0]||reps.find(r=>r?.name);
  return preferred?.name||'';
}
function normalizeFinancial(sheet){
  if(!sheet)return null;
  const currentAssets=Number(sheet.currentAssets??0),fixedAssets=Number(sheet.fixedAssets??0);
  return {year:sheet.year??null,turnover:sheet.netTurnover??null,profit:(sheet.netProfit??0)-(sheet.netLoss??0),equity:sheet.equity??null,liabilities:sheet.liabilities??null,assets:(currentAssets||fixedAssets)?currentAssets+fixedAssets:null,employees:sheet.averageNumberOfEmployees??null};
}
async function companeroCompany(cui,env){
  if(!env.COMPANERO_API_KEY)throw new Error('COMPANERO_API_KEY nu este configurat. Creează cheia gratuită și adaug-o ca secret Cloudflare.');
  const headers={Accept:'application/json',Authorization:`Bearer ${env.COMPANERO_API_KEY}`};
  const base=`https://companero.ro/api/v1/companies/${encodeURIComponent(cui)}`;
  let r=await fetch(`${base}?include=balanceSheets:last5,legalRepresentatives`,{headers});
  if(r.status===402){r=await fetch(`${base}?include=balanceSheets:last5`,{headers})}
  if(r.status===401)throw new Error('Cheia Companero este invalidă sau expirată.');
  if(r.status===404)throw new Error('CUI-ul nu a fost găsit.');
  if(!r.ok){let msg='Eroare Companero '+r.status;try{const e=await r.json();msg=e.error||msg}catch{}throw new Error(msg)}
  return r.json();
}
async function handleCompanyLookup(user,env,cui){
  const taxId=cleanCui(cui);if(!taxId||taxId.length<2)return json({error:'CUI invalid.'},400);
  const p=await companeroCompany(taxId,env);const sheets=Array.isArray(p.balanceSheets)?p.balanceSheets:[];const latest=sheets.slice().sort((a,b)=>Number(b.year||0)-Number(a.year||0))[0]||null;
  const address=[p.city,p.county].filter(Boolean).join(', ');
  return json({company:{cui:taxId,name:p.name||'',administrator:pickAdmin(p.legalRepresentatives),address,county:p.county||'',city:p.city||'',caen:p.mainNaceCode||'',establishedDate:p.registrationDate||'',status:p.stateRegistration||p.registrationStatus||''},financials:normalizeFinancial(latest),source:'Companero · ONRC/ANAF/MF',checkedAt:now(),legalRepresentativesAvailable:Array.isArray(p.legalRepresentatives)});
}

async function handleDocs(request,user,env,key){
  if(!env.DOCS)return json({error:'R2 DOCS nu este configurat.'},503);
  const contractId=String(key||'').split('|')[0];
  if(!contractId)return json({error:'Document invalid.'},400);
  const rr=await client(env).execute({sql:`SELECT data FROM records WHERE collection='contracts' AND id=?`,args:[contractId]});
  if(!rr.rows[0])return json({error:'Contract inexistent.'},404);
  let contract={};try{contract=JSON.parse(rr.rows[0].data)}catch{}
  if(user.role==='Agent'&&contract.agentId!==user.id)return json({error:'Acces interzis la document.'},403);
  if(request.method==='PUT'){
    const name=decodeURIComponent(request.headers.get('x-file-name')||'document');
    await env.DOCS.put(key,request.body,{httpMetadata:{contentType:request.headers.get('content-type')||'application/octet-stream'},customMetadata:{fileName:name,uploadedBy:user.id}});return json({ok:true});
  }
  if(request.method==='GET'){
    const o=await env.DOCS.get(key);if(!o)return json({error:'Fișier inexistent.'},404);const h=new Headers();o.writeHttpMetadata(h);h.set('X-File-Name',encodeURIComponent(o.customMetadata?.fileName||'document'));h.set('cache-control','private, no-store');return new Response(o.body,{headers:h});
  }
  return json({error:'Method not allowed'},405);
}


async function handleCancelContract(request,user,env,id){
  if(!requireRole(user,['BackOffice','Manager']))return json({error:'Doar BO sau Manager pot confirma anularea.'},403);
  const body=await parseBody(request),reason=String(body.reason||'').trim();
  if(reason.length<3||reason.length>1000)return json({error:'Motiv obligatoriu, 3-1000 caractere.'},400);
  const db=client(env),r=await db.execute({sql:`SELECT data FROM records WHERE collection='contracts' AND id=?`,args:[id]});
  if(!r.rows[0])return json({error:'Contract inexistent.'},404);
  let c;try{c=JSON.parse(r.rows[0].data)}catch{return json({error:'Contract corupt.'},500)}
  if(c.status==='Anulat')return json({error:'Contract deja anulat.'},409);
  const oldStatus=c.status,ts=now();c.status='Anulat';c.boStatus='Anulat';c.cancelReason=reason;c.cancelledAt=ts;c.cancelledBy=user.id;c.cancelledFrom=oldStatus;
  const sr=await db.execute({sql:`SELECT id,data FROM records WHERE collection='signed'`});
  const signedIds=sr.rows.filter(x=>{try{return JSON.parse(x.data).contractId===id}catch{return false}}).map(x=>x.id);
  const audit={id:crypto.randomUUID(),at:ts,user:user.code,action:'CONTRACT_CANCELLED',entity:id,details:JSON.stringify({reason,oldStatus})};
  const statements=[
    {sql:`UPDATE records SET data=?,updated_at=?,updated_by=? WHERE collection='contracts' AND id=?`,args:[JSON.stringify(c),ts,user.id,id]},
    ...signedIds.map(sid=>({sql:`DELETE FROM records WHERE collection='signed' AND id=?`,args:[sid]})),
    {sql:`INSERT INTO records(collection,id,data,updated_at,updated_by) VALUES('audit',?,?,?,?)`,args:[audit.id,JSON.stringify(audit),ts,user.id]}
  ];
  await db.batch(statements,'write');return json({ok:true,contract:c,audit,signedIds});
}
// Semnarea independentă se confirmă de BO/Manager numai după solicitarea semnării.
// Actualizarea și auditul sunt atomice în Turso, nu doar în browser.
async function handleManualSignature(request,user,env,id){
 if(!requireRole(user,['BackOffice','Manager']))return json({error:'Doar BackOffice / Manager.'},403);
 const b=await parseBody(request),proof=String(b.proof||'').trim(),notes=String(b.notes||'').trim();
 const accepted=['Semnare finalizată în platforma electronică','Document semnat primit de la client','Confirmare oficială primită de BackOffice'];
 if(!accepted.includes(proof)||notes.length<5||notes.length>1000)return json({error:'Dovada și observația de minimum 5 caractere sunt obligatorii.'},400);
 const db=client(env),r=await db.execute({sql:`SELECT data FROM records WHERE collection='contracts' AND id=? LIMIT 1`,args:[id]});
 if(!r.rows[0])return json({error:'Contract inexistent.'},404);
 let c;try{c=JSON.parse(r.rows[0].data)}catch{return json({error:'Date contract invalide.'},500)}
 if(c.boStatus!=='Asteptare Semnare'||c.signatureConfirmedAt||!['Client de semnat','Semnare trimisa','La BO','Cod trimis BO'].includes(c.status))return json({error:'Contractul nu este în Așteptare Semnare sau a fost deja semnat.'},409);
 const ts=now();c.signatureConfirmedAt=ts;c.signatureMethod='Manual · client independent';c.signatureProof=proof;c.signatureNote=notes;c.signatureConfirmedBy=user.id;c.status='La BO';c.boStatus='Verificare Risk';
 const audit={id:crypto.randomUUID(),at:ts,user:user.code,action:'BO_MANUAL_SIGNATURE',entity:id,details:JSON.stringify({proof,notes,method:c.signatureMethod})};
 await db.batch([
 {sql:`UPDATE records SET data=?,updated_at=?,updated_by=? WHERE collection='contracts' AND id=?`,args:[JSON.stringify(c),ts,user.id,id]},
 {sql:`INSERT INTO records(collection,id,data,updated_at,updated_by) VALUES('audit',?,?,?,?)`,args:[audit.id,JSON.stringify(audit),ts,user.id]}
 ],'write');
 return json({ok:true,contract:c,audit});
}
async function handleSMSConfirm(request,user,env,id){
 if(!requireRole(user,['BackOffice','Manager']))return json({error:'Doar BackOffice / Manager.'},403);
 const db=client(env),r=await db.execute({sql:`SELECT data FROM records WHERE collection='contracts' AND id=? LIMIT 1`,args:[id]});
 if(!r.rows[0])return json({error:'Contract inexistent.'},404);
 let c;try{c=JSON.parse(r.rows[0].data)}catch{return json({error:'Contract invalid.'},500)}
 if(c.boStatus!=='Asteptare Semnare'||c.signatureConfirmedAt)return json({error:'Contractul nu mai așteaptă semnarea.'},409);
 if(!(Array.isArray(c.smsCodes)&&c.smsCodes.some(x=>String(x).trim())))return json({error:'Nu există coduri SMS trimise de agent.'},409);
 const ts=now();c.signatureConfirmedAt=ts;c.signatureMethod='Coduri SMS confirmate de BackOffice';c.signatureConfirmedBy=user.id;c.status='La BO';c.boStatus='Verificare Risk';
 const audit={id:crypto.randomUUID(),at:ts,user:user.code,action:'SIGNATURE_CONFIRMED_TO_RISK',entity:id,details:JSON.stringify({codesCount:c.smsCodes.length})};
 await db.batch([{sql:`UPDATE records SET data=?,updated_at=?,updated_by=? WHERE collection='contracts' AND id=?`,args:[JSON.stringify(c),ts,user.id,id]},{sql:`INSERT INTO records(collection,id,data,updated_at,updated_by) VALUES('audit',?,?,?,?)`,args:[audit.id,JSON.stringify(audit),ts,user.id]}],'write');
 return json({ok:true,contract:c,audit});
}
export default {
  async fetch(request,env){
    try{
      const url=new URL(request.url),path=url.pathname;
      if(path.startsWith('/api/')) await ensureSchema(env);
      if(path==='/api/health') return json({ok:true,service:'vodafone-business-hunting-crm',time:now()});
      if(path==='/api/setup/status'&&request.method==='GET') return handleSetupStatus(env);
      if(path==='/api/setup'&&request.method==='POST') return handleSetup(request,env);
      if(path==='/api/auth/login'&&request.method==='POST') return handleLogin(request,env);
      const user=path.startsWith('/api/')?await auth(request,env):null;
      if(path.startsWith('/api/')&&!user&&!path.startsWith('/api/sync/')) return json({error:'Neautorizat'},401);
      if(path==='/api/auth/me')return json({user:safeUser(user)});
      if(path==='/api/auth/logout'&&request.method==='POST'){const h=request.headers.get('authorization')||'',t=h.startsWith('Bearer ')?h.slice(7):'';if(t)await client(env).execute({sql:`DELETE FROM sessions WHERE token_hash=?`,args:[await sha256(t)]});return json({ok:true})}
      if(path==='/api/bootstrap')return handleBootstrap(user,env);
      if(path==='/api/state/patch'&&request.method==='POST')return handlePatch(request,user,env);
      if(path.startsWith('/api/contracts/')&&path.endsWith('/sign-sms')&&request.method==='POST')return handleSMSConfirm(request,user,env,decodeURIComponent(path.slice('/api/contracts/'.length,-'/sign-sms'.length)));
      if(path.startsWith('/api/contracts/')&&path.endsWith('/sign-manual')&&request.method==='POST')return handleManualSignature(request,user,env,decodeURIComponent(path.slice('/api/contracts/'.length,-'/sign-manual'.length)));
      if(path.startsWith('/api/contracts/')&&path.endsWith('/cancel')&&request.method==='POST')return handleCancelContract(request,user,env,decodeURIComponent(path.slice('/api/contracts/'.length,-'/cancel'.length)));
      if(path==='/api/admin/users'&&request.method==='POST')return handleUserSave(request,user,env);
      if(path==='/api/admin/users/password'&&request.method==='POST')return handlePassword(request,user,env);
      if(path.startsWith('/api/admin/users/')&&request.method==='DELETE')return handleUserDelete(decodeURIComponent(path.split('/').pop()),user,env);
      if(path.startsWith('/api/company/lookup/')&&request.method==='GET')return handleCompanyLookup(user,env,decodeURIComponent(path.slice('/api/company/lookup/'.length)));
      if(path.startsWith('/api/docs/'))return handleDocs(request,user,env,decodeURIComponent(path.slice('/api/docs/'.length)));
      if(path.startsWith('/api/'))return json({error:'Endpoint inexistent'},404);
      return env.ASSETS.fetch(request);
    }catch(e){return json({error:e?.message||'Eroare server'},500)}
  }
};
