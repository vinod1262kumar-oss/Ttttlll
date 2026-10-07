const $ = s => document.querySelector(s);
let sb, user;

function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

async function init(){
  const c=await (await fetch('/api/config')).json();
  sb=window.supabase.createClient(c.supabaseUrl,c.supabasePublishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  const {data}=await sb.auth.getSession();
  user=data.session?.user||null;
  if(!user){location.href='/';return;}
  $('#chat').innerHTML='<div class="empty">Hi, I’m Durva. Ask me about a food label, a balanced meal plan, or practical tasks.</div>';
}
async function send(){
  const input=$('#message'), msg=input.value.trim();
  if(!msg)return;
  const chat=$('#chat');
  chat.innerHTML+=`<div class="bubble user">${esc(msg)}</div><div class="bubble bot" data-thinking="1">Thinking…</div>`;
  input.value='';
  const {data}=await sb.auth.getSession();
  const r=await fetch('/api/durva',{method:'POST',headers:{Authorization:`Bearer ${data.session.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({message:msg})});
  const d=await r.json();
  const bot=[...chat.querySelectorAll('[data-thinking="1"]')].pop();
  bot.removeAttribute('data-thinking');
  bot.innerHTML=r.ok?esc(d.message).replace(/\n/g,'<br>'):`<span style="color:#fca5a5">${esc(d.error||'Durva is temporarily unavailable.')}</span>`;
  if(r.ok&&d.tasks?.length)chat.innerHTML+=`<div class="sub" style="margin:10px 0">Tasks created: ${d.tasks.map(t=>esc(t.title)).join(', ')}</div>`;
  chat.scrollTop=chat.scrollHeight;
}
$('#send').onclick=send;
$('#message').addEventListener('keydown',e=>{if(e.key==='Enter')send();});
$('#logout').onclick=async()=>{await sb.auth.signOut();location.href='/';};
init();
