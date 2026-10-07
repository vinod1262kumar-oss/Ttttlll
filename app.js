const $ = (s, root = document) => root.querySelector(s);

let sb = null;
let currentUser = null;

async function getClient() {
  if (sb) return sb;
  const r = await fetch('/api/config', { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('Could not load TruthLens configuration.');
  const c = await r.json();
  sb = window.supabase.createClient(c.supabaseUrl, c.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  const { data } = await sb.auth.getSession();
  currentUser = data.session?.user || null;
  sb.auth.onAuthStateChange((_event, session) => {
    currentUser = session?.user || null;
    renderAuthState();
  });
  return sb;
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
}

function renderAuthState() {
  const auth = $('#authBtn');
  if (auth) auth.textContent = currentUser ? 'Open TruthLens' : 'Get Started';
  const pill = $('#quotaPill');
  if (pill) pill.textContent = currentUser ? 'Account active' : '8 free scans';
}

function ensureModal() {
  let modal = $('#tlModal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'tlModal';
  modal.className = 'modal hidden';
  modal.innerHTML = `
    <div class="modal-card" style="max-height:90vh;overflow:auto">
      <button id="tlClose" class="close" aria-label="Close">×</button>
      <div id="tlContent"></div>
    </div>`;
  document.body.appendChild(modal);
  $('#tlClose', modal).onclick = closeModal;
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  return modal;
}

function openModal(html) {
  const modal = ensureModal();
  $('#tlContent', modal).innerHTML = html;
  modal.classList.remove('hidden');
}

function closeModal() {
  const modal = $('#tlModal');
  if (!modal) return;
  modal.classList.add('hidden');
}

function authView() {
  openModal(`
    <p class="text-xs font-semibold tracking-[0.22em] text-[#E3B978]">TRUTHLENS ACCOUNT</p>
    <h2 class="mt-2 text-3xl font-bold text-white">See what's really inside.</h2>
    <p class="mt-2 text-gray-400">Sign in to scan products, save history and use Durva.</p>
    <div class="tabs">
      <button id="loginTab" class="tab active">Sign in</button>
      <button id="signupTab" class="tab">Create account</button>
    </div>
    <div class="auth-grid">
      <input id="tlEmail" class="input full" type="email" placeholder="Email" autocomplete="email">
      <input id="tlPassword" class="input full" type="password" placeholder="Password" autocomplete="current-password">
      <button id="emailAuth" class="btn btn-gold full">Continue</button>
      <button id="googleAuth" class="btn btn-ghost full">Continue with Google</button>
    </div>
    <p id="tlAuthMsg" class="auth-message"></p>
  `);

  let signup = false;
  const setMode = value => {
    signup = value;
    $('#loginTab').className = signup ? 'tab' : 'tab active';
    $('#signupTab').className = signup ? 'tab active' : 'tab';
    $('#emailAuth').textContent = signup ? 'Create account' : 'Continue';
  };

  $('#loginTab').onclick = () => setMode(false);
  $('#signupTab').onclick = () => setMode(true);

  $('#emailAuth').onclick = async () => {
    const email = $('#tlEmail').value.trim();
    const password = $('#tlPassword').value;
    const msg = $('#tlAuthMsg');
    if (!email || !email.includes('@')) return msg.textContent = 'Enter a valid email address.';
    if (password.length < 6) return msg.textContent = 'Use a password with at least 6 characters.';
    msg.textContent = 'Please wait…';

    const out = signup
      ? await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + '/' } })
      : await sb.auth.signInWithPassword({ email, password });

    if (out.error) return msg.textContent = out.error.message;
    if (signup && !out.data.session) {
      msg.textContent = 'Account created. Check your email to confirm your account.';
      return;
    }
    currentUser = out.data.user || out.data.session?.user || currentUser;
    closeModal();
    location.href = '/app.html';
  };

  $('#googleAuth').onclick = async () => {
    $('#tlAuthMsg').textContent = 'Opening Google…';
    const out = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin + '/app.html' }
    });
    if (out.error) $('#tlAuthMsg').textContent = out.error.message;
  };
}

function requireAuth(action) {
  if (!currentUser) return authView();
  action();
}

function scanView() {
  openModal(`
    <p class="text-xs font-semibold tracking-[0.22em] text-[#E3B978]">PRODUCT SCANNER</p>
    <h2 class="mt-2 text-3xl font-bold text-white">Uncover what's really inside.</h2>
    <p class="mt-2 text-gray-400">Use a clear nutrition/ingredient label photo. V1 includes 8 free scans.</p>
    <input id="tlScanFile" class="file-input" type="file" accept="image/jpeg,image/png,image/webp" capture="environment">
    <button id="tlScanNow" class="btn btn-gold" style="margin-top:14px">Analyze label →</button>
    <div id="tlScanOut" class="mt-5"></div>
  `);
  $('#tlScanNow').onclick = runScan;
}

function fileData(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function nutrient(name, value, unit) {
  return `<div class="nutri"><small>${name}</small><div >${value ?? '—'}${value != null ? unit : ''}</div></div>`;
}

async function runScan() {
  const file = $('#tlScanFile')?.files?.[0];
  const out = $('#tlScanOut');
  if (!file) return out.innerHTML = '<p class="text-sm text-red-300">Choose an image first.</p>';
  if (file.size > 5 * 1024 * 1024) return out.innerHTML = '<p class="text-sm text-red-300">Please use an image under 5 MB.</p>';

  out.innerHTML = '<div class="result">Reading the label…</div>';

  try {
    const { data } = await sb.auth.getSession();
    if (!data.session) return authView();

    const r = await fetch('/api/scan', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${data.session.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ image: await fileData(file), mime: file.type })
    });
    const d = await r.json();

    if (r.status === 402) {
      out.innerHTML = `<div class="result"><b class="text-white">You've used all 8 free scans.</b><p class="mt-2 text-sm text-gray-400">Upgrade/payment is reserved for the post-launch V1.1 release.</p></div>`;
      return;
    }
    if (!r.ok) {
      out.innerHTML = `<div class="result">${esc(d.error || 'Scan failed.')}</div>`;
      return;
    }

    const a = d.analysis;
    const claims = (a.claims || []).map(c =>
      `<div class="flex justify-between gap-3 border-t border-white/10 py-3"><span class="text-gray-300">${esc(c.claim)}</span><b class="text-[#E3B978]">${esc(c.status)}</b></div>`
    ).join('');

    out.innerHTML = `
      <div class="result">
        <small class="tracking-wider text-gray-500">TRUTHLENS VERDICT</small>
        <div class="mt-2 text-3xl font-bold text-[#E3B978]">${esc(a.verdict.level)}</div>
        <p class="mt-1 text-sm text-gray-400">${esc(a.product || 'Product')} · limiting factor: ${esc(a.limiting)}</p>
        <div class="mt-5 grid grid-cols-2 gap-3">
          ${nutrient('Sugar', d.nutrients.total_sugars, 'g')}
          ${nutrient('Sat. fat', d.nutrients.sat_fat, 'g')}
          ${nutrient('Sodium', d.nutrients.sodium, 'mg')}
          ${nutrient('Protein', d.nutrients.protein, 'g')}
        </div>
        <p class="mt-5 text-sm leading-6 text-gray-400">${esc(a.note)}</p>
        ${claims ? `<div class="mt-5"><b class="text-white">Claim check</b>${claims}</div>` : ''}
        <p class="mt-5 text-sm text-[#E3B978]"><b>${d.scans_left}</b> free scans left.</p>
        <a href="/app.html#history" class="mt-4 inline-block text-sm text-white underline">Open scan history →</a>
      </div>`;
  } catch {
    out.innerHTML = '<p class="text-sm text-red-300">Could not connect to TruthLens. Please try again.</p>';
  }
}

function bindNavigation() {
  const links = document.querySelectorAll('nav a');
  links.forEach(link => {
    const text = link.textContent.trim().toLowerCase();
    if (text === 'home') link.href = '#top';
    if (text === 'features') link.href = '#features';
    if (text === 'how it works') link.href = '#how';
    if (text === 'about') link.href = '#trust';
    if (text === 'blog') {
      link.href = '#features';
      link.textContent = 'Scan';
      link.onclick = e => { e.preventDefault(); requireAuth(scanView); };
    }
  });
}

async function init() {
  try {
    await getClient();
    renderAuthState();
    bindNavigation();

    $('#authBtn')?.addEventListener('click', () => requireAuth(() => location.href = '/app.html'));
    $('#scanHero')?.addEventListener('click', () => requireAuth(scanView));
    $('#scanFeature')?.addEventListener('click', () => requireAuth(scanView));
    $('#durvaBtn')?.addEventListener('click', () => requireAuth(() => location.href = '/durva.html'));
  } catch (e) {
    console.error(e);
  }
}

init();
