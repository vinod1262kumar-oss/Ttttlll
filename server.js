import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = z.object({
  SUPABASE_URL:z.string().url(), SUPABASE_PUBLISHABLE_KEY:z.string().min(10), SUPABASE_SECRET_KEY:z.string().min(10),
  GEMINI_API_KEY:z.string().min(10), GEMINI_MODEL:z.string().default('gemini-2.5-flash'), FREE_SCANS:z.coerce.number().int().min(1).max(100).default(8),
  PORT:z.coerce.number().int().min(1).max(65535).default(3000), SITE_URL:z.string().default('http://localhost:3000'),
  MAX_IMAGE_BYTES:z.coerce.number().int().min(100000).max(10000000).default(5242880), CONTACT_EMAIL:z.string().email().default('hello@example.com')
}).parse(process.env);

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth:{persistSession:false,autoRefreshToken:false} });
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'","https://cdn.jsdelivr.net","https://cdn.tailwindcss.com"],styleSrc:["'self'","'unsafe-inline'","https://fonts.googleapis.com"],imgSrc:["'self'","data:","blob:","https://lh3.googleusercontent.com"],connectSrc:["'self'","https://*.supabase.co","https://generativelanguage.googleapis.com"],fontSrc:["'self'","data:","https://fonts.gstatic.com"]}}}));
app.use(express.json({limit:'7mb',strict:true}));
app.use(rateLimit({windowMs:60_000,max:120,standardHeaders:true,legacyHeaders:false,message:{error:'Too many requests. Please try again shortly.'}}));
app.use(express.static(path.join(__dirname,'public'),{extensions:['html']}));

const authLimiter = rateLimit({windowMs:10*60_000,max:40,standardHeaders:true,legacyHeaders:false});
const aiLimiter = rateLimit({windowMs:60_000,max:12,standardHeaders:true,legacyHeaders:false,message:{error:'AI request limit reached. Please wait a moment.'}});
const ALLOWED_MIME = new Set(['image/jpeg','image/png','image/webp']);

function jsonError(res,status,error,code='error'){ return res.status(status).json({error,code}); }
async function requireUser(req,res,next){
  try {
    const header=req.get('authorization')||'';
    if(!header.startsWith('Bearer ')) return jsonError(res,401,'Sign in first.','auth_required');
    const token=header.slice(7).trim();
    if(token.length<20 || token.length>5000) return jsonError(res,401,'Invalid session.','auth_invalid');
    const {data,error}=await admin.auth.getUser(token);
    if(error || !data.user) return jsonError(res,401,'Session expired. Sign in again.','auth_expired');
    req.user=data.user; next();
  } catch { return jsonError(res,401,'Could not verify your session.','auth_failed'); }
}

function cleanText(v,max=500){ return typeof v==='string' ? v.trim().slice(0,max) : ''; }
const numberOrNull = v => (v===null||v===undefined||v==='' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
function normalizeNutrition(raw={}){
  const keys=['serving_size_g','energy_kcal','protein','carbs','total_sugars','added_sugars','total_fat','sat_fat','trans_fat','cholesterol','fibre','sodium','salt'];
  const out={}; for(const k of keys){ const n=numberOrNull(raw[k]); out[k]=n!==null && n>=0 && n<100000 ? n : null; } return out;
}
function verdict(n){
  const values=[];
  if(n.total_sugars!==null) values.push(['Sugar',n.total_sugars/25]);
  if(n.sat_fat!==null) values.push(['Saturated fat',n.sat_fat/22]);
  if(n.trans_fat!==null) values.push(['Trans fat',n.trans_fat/2.2]);
  if(n.sodium!==null) values.push(['Sodium',n.sodium/2000]);
  if(!values.length) return null;
  const worst=values.sort((a,b)=>b[1]-a[1])[0]; const pct=Math.round(worst[1]*100);
  const level=pct>=100?'High':pct>=50?'Watch':'Lower';
  return {level,limiting:worst[0],safe_grams:Math.max(0,Math.round(100/worst[1]))};
}
function analysis(n, product='', claims=[]){
  const v=verdict(n); if(!v) return null;
  const safeClaims=Array.isArray(claims)?claims.slice(0,8).map(c=>({claim:cleanText(c?.claim,180),reality:cleanText(c?.reality,300),status:['supported','review','not_supported'].includes(c?.status)?c.status:'review'})).filter(c=>c.claim):[];
  return {product:cleanText(product,180)||null, verdict:v, limiting:v.limiting, safe_grams:v.safe_grams, claims:safeClaims, note:'This is an educational estimate from the visible label values, not medical advice.'};
}

const nutritionPrompt = `You are the label-reading engine for TruthLens. Inspect the supplied packaged-food image. Return ONLY valid JSON with keys: product_name, serving_size_g, energy_kcal, protein, carbs, total_sugars, added_sugars, total_fat, sat_fat, trans_fat, cholesterol, fibre, sodium, salt, claims. Values must be numeric or null. Normalize nutrition to per 100 g or per 100 ml. If only per-serving values are visible and serving size is known, convert to per 100 g/ml. Do not guess. Nil/absent/0 = 0. claims must be an array of objects with claim, reality, status where status is supported, review, or not_supported. Only assess claims that are visibly stated on the package and only use visible nutrition/ingredient evidence for reality; use review when evidence is insufficient. If nutrition is unreadable, return null for nutrition fields but still extract visible claims.`;
const durvaSystem = `You are Durva, a careful food and planning assistant inside TruthLens. You can explain food labels, suggest balanced meal ideas, create simple non-medical meal plans, and create task suggestions. Never claim to diagnose disease or replace a doctor/dietitian. Do not encourage restrictive eating, extreme dieting, fasting, purging, over-exercise, or unsafe weight-loss behavior. When a user asks for a plan, keep it balanced and practical. Return concise helpful text. If a task is requested, end with a line beginning TASK_JSON: followed by JSON array of {title,details,due_date} objects.`;

async function gemini(parts,system=nutritionPrompt,jsonMode=true){
  const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_MODEL)}:generateContent`;
  const generationConfig={temperature:0.1}; if(jsonMode) generationConfig.responseMimeType='application/json'; const body={systemInstruction:{parts:[{text:system}]},contents:[{role:'user',parts}],generationConfig};
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},body:JSON.stringify(body),signal:AbortSignal.timeout(45_000)});
  if(!r.ok){ const status=r.status; if(status===429) throw Object.assign(new Error('AI busy'),{status:429}); throw Object.assign(new Error('AI provider error'),{status:502}); }
  const d=await r.json(); return d?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'';
}
function parseJson(text){ const clean=text.trim().replace(/^```json\s*/i,'').replace(/```$/,'').trim(); try{return JSON.parse(clean);}catch{ const a=clean.indexOf('{'),b=clean.lastIndexOf('}'); if(a>=0&&b>a)return JSON.parse(clean.slice(a,b+1)); throw new Error('Invalid AI JSON'); }}

app.get('/api/config',(_req,res)=>res.json({supabaseUrl:env.SUPABASE_URL,supabasePublishableKey:env.SUPABASE_PUBLISHABLE_KEY,siteUrl:env.SITE_URL}));
app.get('/api/health',(_req,res)=>res.json({ok:true,version:'1.0.0'}));

app.post('/api/scan',requireUser,aiLimiter,async(req,res)=>{
  try{
    const image=typeof req.body?.image==='string'?req.body.image:''; const mime=cleanText(req.body?.mime,40);
    if(!ALLOWED_MIME.has(mime)) return jsonError(res,400,'Use a JPG, PNG or WebP image.','bad_image_type');
    const comma=image.indexOf(','); const b64=comma>=0?image.slice(comma+1):image;
    if(!b64 || b64.length<100) return jsonError(res,400,'No product image received.','no_image');
    if(Buffer.byteLength(b64,'base64')>env.MAX_IMAGE_BYTES) return jsonError(res,413,'Image is too large. Please use an image under 5 MB.','image_too_large');
    let parsed;
    try{ parsed=parseJson(await gemini([{text:nutritionPrompt},{inline_data:{mime_type:mime,data:b64}}])); }
    catch(e){ return jsonError(res,e.status===429?429:502,e.status===429?'Gemini is busy. Try again shortly.':'The label could not be read. Try a clearer photo.','ai_scan_failed'); }
    const nutrients=normalizeNutrition(parsed); const a=analysis(nutrients,parsed.product_name,parsed.claims);
    if(!a) return jsonError(res,422,'No usable nutrition values were found. Try a clearer label photo.','no_values');
    const quota=await admin.rpc('increment_scan_if_available',{p_user:req.user.id,p_free_limit:env.FREE_SCANS});
    if(quota.error) return jsonError(res,500,'Scan quota is not configured. Run sql/schema.sql in Supabase.','quota_config');
    const q=quota.data?.[0]; if(!q?.ok) return res.status(402).json({error:`You have used all ${env.FREE_SCANS} free scans. Upgrade to keep scanning.`,code:'limit',upgrade:true});
    const saved=await admin.from('scans').insert({user_id:req.user.id,source:'scan',product_name:a.product,safe_grams:a.safe_grams,verdict:a.verdict.level,limiting:a.limiting,nutrients,analysis:a}).select('id,created_at').single();
    if(saved.error) return jsonError(res,500,'The scan was analyzed but could not be saved.','save_failed');
    return res.json({nutrients,analysis:a,scan_id:saved.data.id,scans_used:q.scans_used,scans_left:q.plan==='pro'?null:Math.max(env.FREE_SCANS-q.scans_used,0),plan:q.plan});
  }catch(e){ console.error('scan',e); return jsonError(res,500,'Something went wrong while scanning.','scan_failed'); }
});

app.get('/api/me',requireUser,async(req,res)=>{
  const {data,error}=await admin.from('profiles').select('plan,scans_used').eq('id',req.user.id).maybeSingle();
  if(error) return jsonError(res,500,'Profile is not configured.','profile_error');
  const p=data||{plan:'free',scans_used:0}; res.json({plan:p.plan,scans_used:p.scans_used,scans_left:p.plan==='pro'?null:Math.max(env.FREE_SCANS-p.scans_used,0),free_limit:env.FREE_SCANS});
});

app.get('/api/history',requireUser,async(req,res)=>{ const {data,error}=await admin.from('scans').select('id,created_at,product_name,verdict,limiting,safe_grams,nutrients,analysis').eq('user_id',req.user.id).order('created_at',{ascending:false}).limit(100); if(error)return jsonError(res,500,'Could not load scan history.','history_error'); res.json({items:data||[]}); });
app.delete('/api/history/:id',requireUser,async(req,res)=>{ if(!/^[0-9a-f-]{36}$/i.test(req.params.id))return jsonError(res,400,'Invalid scan id.','bad_id'); const {error}=await admin.from('scans').delete().eq('id',req.params.id).eq('user_id',req.user.id); if(error)return jsonError(res,500,'Could not delete this scan.','delete_failed'); res.json({ok:true}); });

app.post('/api/durva',requireUser,aiLimiter,async(req,res)=>{
  try{
    const message=cleanText(req.body?.message,4000); if(message.length<1)return jsonError(res,400,'Message is required.','bad_message');
    const prompt=`User message: ${message}\nProvide practical, balanced food guidance. If they explicitly ask to create tasks, include TASK_JSON in the response as specified.`;
    let textOut; try{ textOut=(await gemini([{text:prompt}],durvaSystem,false)).trim(); }catch(e){return jsonError(res,e.status===429?429:502,'Durva is temporarily unavailable. Try again shortly.','durva_failed');}
    let tasks=[]; const marker=textOut.indexOf('TASK_JSON:'); if(marker>=0){ const raw=textOut.slice(marker+10).trim(); try{ tasks=JSON.parse(raw.replace(/^```json\s*/i,'').replace(/```$/,'').trim()); }catch{} textOut=textOut.slice(0,marker).trim(); }
    if(Array.isArray(tasks)&&tasks.length){ const safe=tasks.slice(0,10).map(t=>({user_id:req.user.id,title:cleanText(t.title,160),details:cleanText(t.details,500),due_date:/^\d{4}-\d{2}-\d{2}$/.test(t.due_date||'')?t.due_date:null})).filter(t=>t.title); if(safe.length) await admin.from('durva_tasks').insert(safe); }
    res.json({message:textOut,tasks});
  }catch(e){ console.error('durva',e); res.status(500).json({error:'Durva could not complete that request.','code':'durva_failed'}); }
});
app.get('/api/tasks',requireUser,async(req,res)=>{const {data,error}=await admin.from('durva_tasks').select('id,created_at,title,details,due_date,completed').eq('user_id',req.user.id).order('created_at',{ascending:false}).limit(100);if(error)return jsonError(res,500,'Could not load tasks.','tasks_error');res.json({items:data||[]});});
app.patch('/api/tasks/:id',requireUser,async(req,res)=>{if(!/^[0-9a-f-]{36}$/i.test(req.params.id))return jsonError(res,400,'Invalid task id.','bad_id');const completed=!!req.body?.completed;const {data,error}=await admin.from('durva_tasks').update({completed}).eq('id',req.params.id).eq('user_id',req.user.id).select('id,completed').maybeSingle();if(error)return jsonError(res,500,'Could not update task.','task_update_failed');res.json({item:data});});

app.post('/api/auth/delete-account',requireUser,async(req,res)=>{ try{ const {error}=await admin.auth.admin.deleteUser(req.user.id); if(error)throw error; res.json({ok:true}); }catch(e){console.error('delete account',e);return jsonError(res,500,'Could not delete your account.','delete_account_failed');} });

app.use((req,res,next)=>{ if(req.path.startsWith('/api/')) return jsonError(res,404,'Not found','not_found'); if(req.method==='GET') return res.sendFile(path.join(__dirname,'public','index.html')); next(); });
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:'Unexpected server error.','code':'server_error'});});

app.listen(env.PORT,()=>console.log(`TruthLens V1 listening on ${env.PORT}`));
