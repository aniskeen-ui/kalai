// Customer accounts: sign up / sign in, save enquiries, "My enquiries & orders" panel
// (tabs: Orders · Enquiries · Cancellations & refunds).
import { openPdf } from './pdf.js';
import './amplify-config.js';
import {
  signUp, confirmSignUp, resendSignUpCode, signIn, signOut, autoSignIn,
  getCurrentUser, fetchUserAttributes, fetchAuthSession, resetPassword, confirmResetPassword,
} from 'aws-amplify/auth';
import { Hub } from 'aws-amplify/utils';
import { generateClient } from 'aws-amplify/data';
import { uploadData, getUrl } from 'aws-amplify/storage';
import { autoPhones, countryRegionHtml, wireRegion, addressLine, COUNTRIES } from './phone.js';
// Every country for the Little Artists form (index.html).
window.kalaiCountries = COUNTRIES;
// Pictures come from short-lived signed links (about an hour): a page left open longer shows broken pictures when it
// scrolls to new ones. On a failed picture from our storage, sign the link again (once) and reload it.
document.addEventListener('error', async (ev) => {
  const img = ev.target;
  if (!(img instanceof HTMLImageElement) || img.dataset.resigned || !/amazonaws\.com\/.+X-Amz-/i.test(img.src)) return;
  img.dataset.resigned = '1';
  try { const path = decodeURIComponent(new URL(img.src).pathname.replace(/^\//, '')); const { url } = await getUrl({ path, options: { expiresIn: 3600 } }); img.src = url.toString(); } catch { /* keep the alt text */ }
}, true);
window.kalaiKidsCountries?.(COUNTRIES);
import { cleanTitle } from './title.js';
import './translate.js'; // language picker in the header (whole site)
import './country.js'; // country looks that follow the language, festival looks

autoPhones();

const client = generateClient();
// Website settings master (Order management → Settings): timings for the home page.
let kuralSec = 10;
(async () => {
  try {
    const r = await client.models.SiteSetting.get({ id: 'site' }, { authMode: 'apiKey' });
    const st = r.data;
    if (!st) return;
    if (st.heroSeconds != null) window.kalaiHeroEvery?.(st.heroSeconds);
    window.kalaiSiteLangs = st.siteLangs || ''; window.kalaiSiteLangDefault = st.siteLangDefault || 'en'; window.kalaiLangPicker?.(); // website languages chosen in Settings
    if (st.inrPerAed) window.kalaiInrPerAed = Number(st.inrPerAed);
    if (st.gbpPerAed) window.kalaiGbpPerAed = Number(st.gbpPerAed);
    if (st.eurPerAed) window.kalaiEurPerAed = Number(st.eurPerAed);
    window.kalaiRound = { usd: Number(st.usdRound) || 5, inr: Number(st.inrRound) || 50, up: st.roundUp === true, approx: st.approxSign !== false };
    try { window.kalaiShipZones = JSON.parse(st.shipZones || '{}') || {}; } catch { window.kalaiShipZones = {}; }
    try { window.kalaiPhotoPrices = JSON.parse(st.photoPrices || '{}') || {}; } catch { window.kalaiPhotoPrices = {}; }
    try { window.kalaiLicencePcts = JSON.parse(st.licencePcts || '{}') || {}; } catch { window.kalaiLicencePcts = {}; }
    window.kalaiInstalments = st.instalments || '';
    window.kalaiPhotoFee?.();
    window.kalaiLeadDefault = st.leadDefault || '';
    window.kalaiRedrawPrices?.();
    // Pre-launch notice (Settings): a quiet bar above the header while the shop is not fully open.
    { const lb = document.getElementById('launchBar'); if (lb) { lb.textContent = st.launchNote || ''; lb.hidden = !st.launchNote; } }
    if (st.kuralSeconds != null) { kuralSec = Number(st.kuralSeconds) || 0; window.kalaiKuralRestart?.(); }
    // Home page texts from Order Management → Settings (blank = keep the built-in text).
    // Website look from Settings (a ?look= preview in this browser wins).
    let preview = null;
    try { localStorage.setItem('kalaiLook', st.siteLook === 'green' ? 'green' : 'classic'); preview = localStorage.getItem('kalaiLookPreview'); } catch { /* storage blocked */ }
    if (!preview) {
      if (st.siteLook === 'green') document.documentElement.setAttribute('data-skin', 'green');
      else document.documentElement.removeAttribute('data-skin');
    }
    // Real room photo for "On a wall" (marked in Settings).
    try {
      const mk = st.roomMarks ? JSON.parse(st.roomMarks) : null;
      if (mk && mk.r > mk.l && mk.top > 0) {
        const u = (await getUrl({ path: 'catalogue/site/room.jpg', options: { expiresIn: 3600 } })).url.toString();
        window.kalaiRoom = { ...mk, url: u };
        new Image().src = u;
      }
    } catch { /* drawn room stays */ }
    const tx = (v) => String(v ?? '').trim();
    const put = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    // Headlines take turns with the picture (same seconds); one per line, "plain part | gold part".
    const heads = tx(st.heroLines) ? tx(st.heroLines).split('\n').map((l) => l.trim()).filter(Boolean)
      : tx(st.heroTitle) || tx(st.heroHighlight) ? [`${tx(st.heroTitle) || 'Original watercolours and pencil sketches,'} | ${tx(st.heroHighlight) || 'painted for your walls'}`] : [];
    const headHtml = (l) => { const [a, b] = l.split('|').map((x) => x.trim()); return b ? `${esc(a)} <em>${esc(b)}</em>` : `<em>${esc(a)}</em>`; };
    const kids = tx(st.kidsTitle).split('\n').map((l) => l.trim()).filter(Boolean);
    const rot = (id, list, html) => {
      const el = document.getElementById(id);
      if (!el || !list.length) return;
      el.innerHTML = html(list[0]);
      if (list.length < 2 || !(Number(st.heroSeconds) > 0)) return;
      el.style.transition = 'opacity .6s'; let i = 0;
      setInterval(() => { if (document.hidden) return; el.style.opacity = '0'; setTimeout(() => { i = (i + 1) % list.length; el.innerHTML = html(list[i]); el.style.opacity = '1'; }, 600); }, Number(st.heroSeconds) * 1000);
    };
    rot('heroH1', heads, headHtml);
    if (tx(st.heroText)) put('heroP', esc(tx(st.heroText)));
    rot('kidsH2', kids, (l) => esc(l));
    if (tx(st.kidsText)) put('kidsStory', tx(st.kidsText).split(/\n\s*\n/).map((x) => `<p class="story">${esc(x.trim()).replace(/\n/g, '<br>')}</p>`).join(''));
  } catch { /* defaults stay */ }
})();
const state = { user: null, email: '' };

export const STATUS = {
  RECEIVED: 'Received',
  PRICE_SENT: 'Price sent',
  PAID: 'Paid',
  ARTIST_WORKING: 'Artist at work',
  ARTIST_DONE: 'Artwork finished',
  ARTIST_SENT: 'On its way to the framer',
  FRAMING: 'Being framed',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  REPLACEMENT: 'Replacement in progress',
  REFUNDED: 'Refunded',
  CANCELLED: 'Cancelled',
};
const STEPS = ['RECEIVED', 'PRICE_SENT', 'PAID', 'ARTIST_WORKING', 'ARTIST_DONE', 'ARTIST_SENT', 'FRAMING', 'SHIPPED', 'DELIVERED'];
const KIND = { PRICE: 'Collection', COMMISSION: 'Commission', GIFT: 'Little Artists', MARKET: 'Crafts shop', PHOTO: 'Framed Prints', LICENCE: 'Image licence' };
const MARKET_STEPS = ['RECEIVED', 'PRICE_SENT', 'PAID', 'SHIPPED', 'DELIVERED'];
// Framed Prints and Little Artists: no artist steps (printed / framed in Dubai).
const FRAME_STEPS = ['RECEIVED', 'PRICE_SENT', 'PAID', 'FRAMING', 'SHIPPED', 'DELIVERED'];
const LICENCE_STEPS = ['RECEIVED', 'PRICE_SENT', 'DELIVERED'];

/* ---------- styles ---------- */
const css = `
.acct-scrim{position:fixed;inset:0;background:rgba(10,8,20,.55);z-index:40}
.acct-panel{position:fixed;top:0;right:0;bottom:0;width:min(460px,100%);background:var(--surface);color:var(--fg);z-index:41;display:flex;flex-direction:column;
  padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);padding-right:env(safe-area-inset-right,0px);box-shadow:-10px 0 40px rgba(0,0,0,.3)}
.acct-panel header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:18px 20px;border-bottom:1px solid var(--line)}
.acct-panel h2{font-size:24px;margin:0}
.acct-panel .acct-hbtn{background:none;border:1px solid var(--line);border-radius:999px;padding:4px 10px;font-size:13px;color:var(--fg);cursor:pointer;margin-left:auto}
.acct-grip{position:absolute;left:-4px;top:0;bottom:0;width:8px;cursor:ew-resize;z-index:2}
.acct-panel.wide{width:100%!important;box-shadow:none}.acct-panel.wide .acct-grip{display:none}
.acct-panel.wide .acct-body{width:100%;max-width:1440px;margin:0 auto;box-sizing:border-box}
.acct-top{display:grid;gap:12px}.acct-top>div:empty{display:none}.acct-panel.wide #enqList>:not(article){grid-column:1/-1}
@media (min-width:900px){.acct-panel.wide .acct-top{grid-template-columns:repeat(auto-fit,minmax(320px,1fr));align-items:start}
  .acct-panel.wide #enqList{grid-template-columns:repeat(auto-fill,minmax(420px,1fr))!important;align-items:start}}
.acct-body{flex:1;overflow:auto;padding:20px;display:grid;gap:14px;align-content:start}
.acct-body form{display:grid;gap:12px}
.acct-body .field{display:grid;gap:6px}
.acct-body label{font-size:13px;font-weight:600}
.acct-link{background:none;border:0;padding:0;color:var(--kumkum);font:inherit;font-size:14px;text-decoration:underline;cursor:pointer;justify-self:start}
.acct-err{color:var(--kumkum);font-size:14px;min-height:1em}
.acct-info{font-size:13px;color:var(--muted)}
.enq{border:1px solid var(--line);border-radius:var(--r);padding:12px 14px;display:grid;gap:7px;font-size:14px;background:var(--bg)}
.enq-top{display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap}
.enq-title{font-weight:600;font-size:15px}
.enq-ref{font-family:var(--mono);font-size:11px;color:var(--muted)}
.pill{display:inline-block;font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px;background:var(--gold-soft);color:var(--fg)}
.pill.done{background:var(--ok);color:#fff}
.pill.stop{background:var(--kumkum);color:#fff}
.steps-bar{display:grid;grid-template-columns:repeat(6,1fr);gap:4px}
.steps-bar i{height:5px;border-radius:3px;background:var(--line)}
.steps-bar i.on{background:var(--gold)}
.trk-list{list-style:none;margin:4px 0 0;padding:0;display:grid;gap:0}
.trk-list li{display:grid;grid-template-columns:22px 1fr;gap:10px;position:relative;padding:0 0 12px;font-size:14px}
.trk-list li:not(:last-child)::before{content:'';position:absolute;left:10px;top:20px;bottom:0;width:2px;background:var(--line)}
.trk-list li.done:not(:last-child)::before{background:var(--gold)}
.trk-list .dot{width:20px;height:20px;border-radius:50%;border:2px solid var(--line);display:grid;place-items:center;font-size:11px;background:var(--bg);z-index:1}
.trk-list li.done .dot{background:var(--gold);border-color:var(--gold);color:#fff}
.trk-list li.now .dot{border-color:var(--gold);box-shadow:0 0 0 4px color-mix(in srgb,var(--gold) 25%,transparent)}
.trk-list li.todo{opacity:.55}
.trk-at{font-size:12px;opacity:.75;margin-left:4px}
.trk-note{font-size:13px;margin-top:2px}
.circle{border:1px solid var(--gold);background:color-mix(in srgb,var(--gold) 8%,transparent);border-radius:10px;padding:10px 12px;margin:6px 0;display:grid;gap:6px}
.redeem{border:1px dashed var(--gold);border-radius:10px;padding:8px 12px;margin:6px 0}
.redeem summary{cursor:pointer;font-weight:700;font-size:14px}
.enq-msg{font-size:13px;line-height:1.45;background:var(--surface);border-left:3px solid var(--gold);padding:8px 10px}
.enq-price{font-family:var(--mono);font-size:14px}
.rate{display:grid;gap:10px;border-top:1px solid var(--line);padding-top:10px}
.rate b{font-size:14px}
.stars{display:flex;gap:2px}
.stars button{background:none;border:0;padding:2px 3px;font-size:30px;line-height:1;color:var(--line);cursor:pointer}
.stars button.on{color:var(--gold)}
.rate textarea{min-height:70px}
.rate .tick{display:flex;gap:8px;align-items:flex-start;font-size:13px;font-weight:400}
.rate .tick input{width:auto;margin-top:3px}
.rated{font-size:14px}.rated span{color:var(--gold);letter-spacing:2px}
.req-open{background:none;border:0;padding:0;font:inherit;font-size:13px;color:var(--muted);text-decoration:underline;cursor:pointer;justify-self:start}
.req{display:grid;gap:10px;border:1px solid var(--line);border-radius:var(--r);padding:12px;background:var(--surface)}
.req .terms-box{font-size:14px;border-left:3px solid var(--kumkum);padding:6px 10px;background:var(--bg)}
.req .opts{display:grid;gap:6px}
.req .opts label,.req .tick{display:flex;gap:8px;align-items:flex-start;font-weight:400;font-size:14px}
.req input[type=radio],.req input[type=checkbox]{width:auto;margin-top:3px}
.req .row{display:flex;gap:8px;flex-wrap:wrap}
.req .row .btn{flex:1}
.enq-msg.warn{border-left-color:var(--kumkum)}
.addr{display:grid;gap:6px;font-size:13px;line-height:1.45;background:var(--surface);border-left:3px solid var(--line);padding:7px 10px}
.addr.need{border-left-color:var(--kumkum)}
.addr .req-open{margin-top:2px}
.addr-form .two{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.rtrack{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:3px;font-size:13px;line-height:1.4}
.rtrack li{color:var(--muted)}
.rtrack li.done,.rtrack li.now{color:var(--fg)}
.rtrack li span{display:inline-block;width:1.3em;font-size:12px}
.rtrack li.done span{color:var(--ok);font-weight:700}
.rtrack li.now span{color:var(--gold)}
.rtrack small{color:var(--muted);font-size:11px}
.acct-sm{display:none}
@media (max-width:1500px){.acct-lg{display:none}.acct-sm{display:inline}}
.acct-tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);overflow-x:auto;overflow-y:hidden;scrollbar-width:none}
.acct-tabs::-webkit-scrollbar{display:none}
.acct-tabs button{flex:none;background:none;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;padding:6px 8px;font:inherit;font-size:13px;font-weight:600;color:var(--muted);cursor:pointer;white-space:nowrap;line-height:1.3}
.acct-tabs button[aria-selected="true"]{color:var(--fg);border-bottom-color:var(--gold)}
.acct-tabs b{display:inline-block;min-width:16px;margin-left:5px;padding:0 5px;border-radius:999px;background:var(--line);font-weight:600;font-size:11px;line-height:16px;text-align:center}
.acct-tabs button[aria-selected="true"] b{background:var(--gold-soft)}
.rate-open{justify-self:start}
`;
document.head.insertAdjacentHTML('beforeend', `<style>${css}</style>`);

/* ---------- panel shell ---------- */
const scrim = document.createElement('div');
scrim.className = 'acct-scrim'; scrim.hidden = true;
const panel = document.createElement('aside');
panel.className = 'acct-panel'; panel.hidden = true; panel.setAttribute('aria-label', 'Your account');
panel.innerHTML = `<div class="acct-grip" title="Drag to resize"></div><header><h2 id="acctTitle">Sign in</h2><button type="button" class="acct-hbtn" id="acctWide" title="Full screen or side panel">⤢ Full screen</button><button class="x" id="acctClose" aria-label="Close">×</button></header><div class="acct-body" id="acctBody"></div>`;
document.body.append(scrim, panel);
const body = panel.querySelector('#acctBody');
// Full screen (remembered) or a side panel the customer can widen by dragging its left edge.
const lsG = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsS = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const setWide = (on) => { panel.classList.toggle('wide', on); const b = panel.querySelector('#acctWide'); if (b) b.textContent = on ? '⤡ Side panel' : '⤢ Full screen'; lsS('kalai-acct-wide', on ? '1' : '0'); };
setWide(lsG('kalai-acct-wide') !== '0' && innerWidth >= 900);
{ const w = Number(lsG('kalai-acct-w')); if (w > 300) panel.style.width = `min(${w}px,100%)`; }
panel.querySelector('#acctWide').onclick = () => setWide(!panel.classList.contains('wide'));
panel.querySelector('.acct-grip').addEventListener('pointerdown', (ev) => {
  ev.preventDefault(); const grip = ev.currentTarget; grip.setPointerCapture(ev.pointerId);
  const move = (e) => { const w = Math.max(360, Math.min(innerWidth, innerWidth - e.clientX)); panel.style.width = `${w}px`; };
  const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); lsS('kalai-acct-w', String(parseInt(panel.style.width, 10) || 460)); if (parseInt(panel.style.width, 10) >= innerWidth - 20) setWide(true); };
  grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
});
const title = panel.querySelector('#acctTitle');
const open = () => { panel.hidden = false; scrim.hidden = false; };
const close = () => { panel.hidden = true; scrim.hidden = true; };
panel.querySelector('#acctClose').onclick = close;
scrim.onclick = close;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const btn = document.getElementById('acctBtn');
function setButton() { if (btn) btn.innerHTML = state.user ? '<span class="acct-lg">My enquiries &amp; orders</span><span class="acct-sm">My orders</span>' : 'Sign in'; }
if (btn) btn.onclick = () => { state.user ? showList() : showSignIn(); open(); };

function form(html, onSubmit) {
  body.innerHTML = html;
  const f = body.querySelector('form');
  const err = body.querySelector('.acct-err');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const b = f.querySelector('button[type=submit]');
    err.textContent = ''; b.disabled = true;
    try { await onSubmit(new FormData(f)); }
    catch (ex) { err.textContent = friendly(ex); }
    finally { b.disabled = false; }
  });
  return f;
}
function friendly(ex) {
  const n = ex?.name || '';
  if (n === 'UserNotFoundException' || n === 'NotAuthorizedException') return 'Email or password is incorrect.';
  if (n === 'UsernameExistsException') return 'An account with this email already exists. Sign in instead.';
  if (n === 'CodeMismatchException') return 'That code is not right. Check the latest email and try again.';
  if (n === 'ExpiredCodeException') return 'That code has expired. Request a new one.';
  if (n === 'InvalidPasswordException') return 'Use at least 8 characters with upper and lower case letters, a number and a symbol.';
  if (n === 'LimitExceededException') return 'Too many attempts. Please wait a few minutes and try again.';
  return ex?.message || 'Something went wrong. Please try again.';
}

/* ---------- views ---------- */
function showSignIn(msg = '') {
  title.textContent = 'Sign in';
  const f = form(`
    <p class="acct-info">Sign in to track your price enquiries, commissions and Little Artists gifts.</p>
    ${msg ? `<p class="acct-info" style="color:var(--ok)">${esc(msg)}</p>` : ''}
    <form novalidate>
      <div class="field"><label for="aiEmail">Email</label><input id="aiEmail" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="aiPass">Password</label><input id="aiPass" name="password" type="password" autocomplete="current-password" required></div>
      <div class="acct-err" role="alert"></div>
      <button class="btn primary" type="submit">Sign in</button>
    </form>
    <button class="acct-link" id="toSignUp">New here? Create an account</button>
    <button class="acct-link" id="toForgot">Forgot password?</button>`,
  async (fd) => {
    const email = String(fd.get('email')).trim().toLowerCase();
    const { nextStep } = await signIn({ username: email, password: String(fd.get('password')) });
    if (nextStep.signInStep === 'CONFIRM_SIGN_UP') { await resendSignUpCode({ username: email }); showConfirm(email); return; }
    if (nextStep.signInStep === 'DONE') { await loadUser(); afterSignIn(); return; }
    throw new Error('Additional sign-in step required: ' + nextStep.signInStep);
  });
  body.querySelector('#toSignUp').onclick = showSignUp;
  body.querySelector('#toForgot').onclick = () => showForgot(f.email.value);
  f.email.focus();
}

function showSignUp() {
  title.textContent = 'Create account';
  const f = form(`
    <p class="acct-info">We'll email you a 6-digit code to confirm your address.</p>
    <form novalidate>
      <div class="field"><label for="auEmail">Email</label><input id="auEmail" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="auPass">Password</label><input id="auPass" name="password" type="password" autocomplete="new-password" required>
        <span class="acct-info" style="font-size:12px">At least 8 characters, with upper and lower case letters, a number and a symbol.</span></div>
      <div class="acct-err" role="alert"></div>
      <button class="btn primary" type="submit">Create account</button>
    </form>
    <button class="acct-link" id="toSignIn">Already have an account? Sign in</button>`,
  async (fd) => {
    const email = String(fd.get('email')).trim().toLowerCase();
    await signUp({ username: email, password: String(fd.get('password')), options: { userAttributes: { email }, autoSignIn: true } });
    showConfirm(email);
  });
  body.querySelector('#toSignIn').onclick = () => showSignIn();
  f.email.focus();
}

function showConfirm(email) {
  title.textContent = 'Check your email';
  const f = form(`
    <p class="acct-info">We sent a 6-digit code to <b>${esc(email)}</b>. It can take a minute to arrive; check your spam folder too.</p>
    <form novalidate>
      <div class="field"><label for="acCode">Code</label><input id="acCode" name="code" inputmode="numeric" autocomplete="one-time-code" required></div>
      <div class="acct-err" role="alert"></div>
      <button class="btn primary" type="submit">Confirm</button>
    </form>
    <button class="acct-link" id="resend">Send a new code</button>`,
  async (fd) => {
    const { nextStep } = await confirmSignUp({ username: email, confirmationCode: String(fd.get('code')).trim() });
    if (nextStep.signUpStep === 'COMPLETE_AUTO_SIGN_IN') {
      try { await autoSignIn(); await loadUser(); afterSignIn(); return; } catch (e) { /* fall through to manual sign-in */ }
    }
    showSignIn('Email confirmed. Please sign in.');
  });
  body.querySelector('#resend').onclick = async () => {
    try { await resendSignUpCode({ username: email }); body.querySelector('.acct-err').textContent = 'A new code is on its way.'; }
    catch (ex) { body.querySelector('.acct-err').textContent = friendly(ex); }
  };
  f.code.focus();
}

function showForgot(prefill = '') {
  title.textContent = 'Reset password';
  const f = form(`
    <p class="acct-info">Enter your email and we'll send a code to set a new password.</p>
    <form novalidate>
      <div class="field"><label for="afEmail">Email</label><input id="afEmail" name="email" type="email" autocomplete="email" value="${esc(prefill)}" required></div>
      <div class="acct-err" role="alert"></div>
      <button class="btn primary" type="submit">Send code</button>
    </form>
    <button class="acct-link" id="toSignIn">Back to sign in</button>`,
  async (fd) => {
    const email = String(fd.get('email')).trim().toLowerCase();
    await resetPassword({ username: email });
    showReset(email);
  });
  body.querySelector('#toSignIn').onclick = () => showSignIn();
  f.email.focus();
}

function showReset(email) {
  title.textContent = 'Set a new password';
  const f = form(`
    <p class="acct-info">Enter the code we emailed to <b>${esc(email)}</b> and choose a new password.</p>
    <form novalidate>
      <div class="field"><label for="arCode">Code</label><input id="arCode" name="code" inputmode="numeric" autocomplete="one-time-code" required></div>
      <div class="field"><label for="arPass">New password</label><input id="arPass" name="password" type="password" autocomplete="new-password" required></div>
      <div class="acct-err" role="alert"></div>
      <button class="btn primary" type="submit">Save new password</button>
    </form>`,
  async (fd) => {
    await confirmResetPassword({ username: email, confirmationCode: String(fd.get('code')).trim(), newPassword: String(fd.get('password')) });
    showSignIn('Password changed. Please sign in.');
  });
  f.code.focus();
}

const myReviews = new Map();
const starText = (n) => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
function rateBlock(e) {
  if (e.status !== 'DELIVERED') return '';
  const r = myReviews.get(e.id);
  if (r) return `<div class="rated">You rated this <span aria-label="${r.rating} out of 5">${starText(r.rating)}</span>. Thank you for your feedback.${r.published ? ' It is now on our website.' : ''}</div>`;
  return `<button type="button" class="btn rate-open" data-rate="${esc(e.id)}">★ Rate your ${e.kind === 'GIFT' ? 'framed gift' : e.kind === 'PHOTO' ? 'framed photo' : 'artwork'}</button>
  <form class="rate" data-id="${esc(e.id)}" novalidate hidden>
    <b>How did we do? Rate your ${e.kind === 'GIFT' ? 'framed gift' : e.kind === 'PHOTO' ? 'framed photo' : 'artwork'}</b>
    <div class="stars" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map((n) => `<button type="button" role="radio" aria-checked="false" aria-label="${n} star${n > 1 ? 's' : ''}" data-n="${n}">★</button>`).join('')}</div>
    <textarea name="comment" maxlength="600" placeholder="Tell us about the painting, the packing and delivery (optional)"></textarea>
    <label class="tick"><input type="checkbox" name="consent"> You may show my first name and this review on the Kalai Art House website.</label>
    <div class="acct-err" role="alert"></div>
    <button class="btn primary" type="submit">Send feedback</button>
  </form>`;
}
function wireRate(root, items) {
  root.querySelectorAll('[data-rate]').forEach((b) => { b.onclick = () => { b.hidden = true; b.nextElementSibling.hidden = false; }; });
  root.querySelectorAll('form.rate').forEach((f) => {
    const e = items.find((x) => x.id === f.dataset.id);
    let rating = 0;
    const btns = [...f.querySelectorAll('.stars button')];
    const paint = (n) => btns.forEach((b) => { const on = Number(b.dataset.n) <= n; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(Number(b.dataset.n) === n)); });
    btns.forEach((b) => {
      b.onclick = () => { rating = Number(b.dataset.n); paint(rating); };
      b.onmouseenter = () => paint(Number(b.dataset.n));
      b.onmouseleave = () => paint(rating);
    });
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const err = f.querySelector('.acct-err');
      if (!rating) { err.textContent = 'Tap the stars to choose a rating.'; return; }
      const btn = f.querySelector('button[type=submit]'); btn.disabled = true; err.textContent = '';
      try {
        const firstName = String(e.customerName || '').trim().split(/\s+/)[0] || '';
        const { data, errors } = await client.models.Review.create({
          enquiryId: e.id, ref: e.ref, firstName, rating,
          // Only a general label goes with the review (no child's name or commission details).
          title: e.kind === 'GIFT' ? 'Little Artists framed gift' : e.kind === 'PHOTO' ? 'Framed print' : e.kind === 'COMMISSION' ? 'Commissioned painting' : e.title,
          comment: String(f.comment.value || '').trim().slice(0, 600), consent: f.consent.checked,
        });
        if (errors?.length) throw new Error(errors[0].message);
        myReviews.set(e.id, data || { enquiryId: e.id, rating });
        f.outerHTML = rateBlock(e);
      } catch (ex) {
        err.textContent = /conditional|exists/i.test(ex.message || '') ? 'You have already rated this order. Tap Refresh.' : 'Could not send your feedback. ' + friendly(ex);
        btn.disabled = false;
      }
    };
  });
}

/* ---------- cancel / report damage (policy mirrored from the server, which has the final say) ---------- */
const aedTxt = (n) => '⃃ ' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const DAMAGE_HOURS = 48;
function cancelTerms(e) {
  const st = e.status || 'RECEIVED';
  const price = Number(e.quotedPrice || 0);
  if (['RECEIVED', 'PRICE_SENT'].includes(st)) return { type: 'FREE', due: 0, text: "Nothing has been paid, so there's nothing to refund. Your enquiry is cancelled straight away." };
  if (['PAID', 'ARTIST_WORKING', 'ARTIST_DONE', 'ARTIST_SENT', 'FRAMING'].includes(st)) {
    const started = e.kind === 'GIFT' || e.kind === 'PHOTO' ? st === 'FRAMING' : !!e.artistStartedAt || st === 'FRAMING';
    return started
      ? { type: 'HALF', due: Math.round(price * 50) / 100, text: e.kind === 'GIFT' || e.kind === 'PHOTO' ? `Framing has started, so under our terms <b>50% is refunded: ${aedTxt(price / 2)}</b>.` : `The artist started your work${e.artistStartedAt ? ` on ${new Date(e.artistStartedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}, so under our terms <b>50% is refunded: ${aedTxt(price / 2)}</b>. The rest covers the artist's time.` }
      : { type: 'FULL', due: price, text: `The work hasn't started yet, so you get a <b>full refund of ${aedTxt(price)}</b>.` };
  }
  return null;
}
function damageOpen(e) {
  if (e.status !== 'DELIVERED') return false;
  if (e.cancelState === 'REOPENED') { const r = Date.parse(e.cancelReopenAt); return !Number.isFinite(r) || Date.now() - r <= DAMAGE_HOURS * 3600_000; }
  const at = Date.parse(e.deliveredAt || e.updatedAt);
  return !Number.isFinite(at) || Date.now() - at <= DAMAGE_HOURS * 3600_000;
}
function requestBlock(e) {
  if (e.kind === 'LICENCE' && !['RECEIVED', 'PRICE_SENT'].includes(e.status || 'RECEIVED')) return ''; // digital: no cancellation once paid
  const when = e.cancelRequestedAt ? new Date(e.cancelRequestedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
  if (e.cancelState === 'REQUESTED') {
    return `<div class="enq-msg warn">${e.cancelRequest === 'CANCEL' ? `Cancellation requested on ${esc(when)}. Refund due: <b>${aedTxt(e.cancelRefundDue)}</b>, sent within 7 working days. We'll email you when it's done.`
      : e.cancelRequest === 'DAMAGED_REPLACE' ? `Damage reported on ${esc(when)}. You asked for a replacement or repair; we'll confirm within 2 working days.`
      : `Damage reported on ${esc(when)}. Refund due: <b>${aedTxt(e.cancelRefundDue)}</b> once we've checked the photos. We'll email you.`}</div>
      <button type="button" class="req-open" data-withdraw="${esc(e.id)}">Sent the wrong photo or changed your mind? Withdraw this request</button>`;
  }
  if (e.cancelState === 'REOPENED') {
    const open = damageOpen(e);
    return `<div class="enq-msg warn"><b>Please send new photos.</b> ${esc(e.cancelReply || 'The photos did not show the damage clearly.')}${open ? ' You have 48 hours from our message.' : ' The 48 hours have passed: please contact us.'}</div>
      ${open ? `<button type="button" class="req-open" data-req="DAMAGE" data-id="${esc(e.id)}">Send new damage photos</button>` : ''}`;
  }
  if (e.cancelState === 'DECLINED') return `<div class="enq-msg warn">About your request: ${esc(e.cancelReply || 'we could not accept it under our terms. Please reply to our email to talk it through.')}</div>`;
  if (['CANCELLED', 'REFUNDED', 'REPLACEMENT'].includes(e.status)) return '';
  const t = cancelTerms(e);
  if (t) return `<button type="button" class="req-open" data-req="CANCEL" data-id="${esc(e.id)}">${t.type === 'FREE' ? 'Cancel this enquiry' : 'Cancel this order'}</button>`;
  if (e.status === 'SHIPPED') return `<p class="acct-info" style="margin:0;font-size:13px">It's on its way, so it can't be cancelled now. If it arrives damaged, you can report it here within 48 hours.</p>`;
  if (damageOpen(e)) return `<button type="button" class="req-open" data-req="DAMAGE" data-id="${esc(e.id)}">Arrived damaged? Report it (within 48 hours)</button>`;
  return '';
}
function requestForm(e, which) {
  if (which === 'CANCEL') {
    const t = cancelTerms(e);
    return `<form class="req" novalidate>
      <b>${t.type === 'FREE' ? 'Cancel this enquiry' : 'Cancel this order'}</b>
      <div class="terms-box">${t.text}${t.type !== 'FREE' ? ' Refunds go back the way you paid, usually within 7 working days.' : ''}</div>
      <div class="field"><label>Reason (optional)</label><input name="reason" maxlength="300" placeholder="e.g. change of plans"></div>
      ${t.type !== 'FREE' ? `<label class="tick"><input type="checkbox" name="agree"> I have read the <a href="#terms" style="color:var(--kumkum)">cancellation terms</a> and accept the refund shown.</label>` : ''}
      <div class="acct-err" role="alert"></div>
      <div class="row"><button class="btn primary" type="submit">${t.type === 'FREE' ? 'Cancel enquiry' : 'Request cancellation'}</button><button class="btn" type="button" data-close>Keep it</button></div>
    </form>`;
  }
  return `<form class="req" novalidate>
    <b>Report damage</b>
    <div class="terms-box">We're sorry. Every parcel is insured: send us photos and choose what you'd like. Please keep the packaging until it's resolved.</div>
    <div class="opts" role="radiogroup">
      <label><input type="radio" name="action" value="DAMAGED_REPLACE" checked> A replacement or repair, at no cost</label>
      <label><input type="radio" name="action" value="DAMAGED_REFUND"> A full refund of ${aedTxt(e.quotedPrice)}</label>
    </div>
    <div class="field"><label>What is damaged?</label><input name="reason" maxlength="500" placeholder="e.g. glass cracked in the corner"></div>
    <div class="field"><label>Photos (up to 3)</label><input name="photos" type="file" accept="image/*" multiple></div>
    <label class="tick"><input type="checkbox" name="agree"> I have read the <a href="#terms" style="color:var(--kumkum)">damage terms</a>.</label>
    <div class="acct-err" role="alert"></div>
    <div class="row"><button class="btn primary" type="submit">Send report</button><button class="btn" type="button" data-close>Close</button></div>
  </form>`;
}
// Image licence: download the full-size file once paid (a fresh 15-minute link each time).
function licenceBlock(e) {
  if (e.kind !== 'LICENCE') return '';
  const d = parseDet(e.details), st = e.status || 'RECEIVED';
  const paid = ['PAID', 'DELIVERED'].includes(st);
  return `<div class="enq-msg"><b>${esc(d.Licence || 'Licence')}</b>: ${esc(d.Allows || '')}${paid ? '' : ' The file is ready to download as soon as it is paid.'}</div>
    ${paid ? `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><button type="button" class="btn primary" data-licfile="${esc(e.id)}">⬇ Download the full-size file</button><span class="acct-info" style="font-size:12px">Credit: “Artwork © the artist / Kalai Art House”. The artist keeps the copyright.</span></div>` : ''}`;
}
// Certificate of authenticity for an original, once paid.
const COA_KINDS = ['PRICE', 'COMMISSION', 'MARKET'];
function coaBlock(e) {
  const st = e.status || 'RECEIVED';
  if (!COA_KINDS.includes(e.kind) || !['PAID', 'ARTIST_WORKING', 'ARTIST_DONE', 'ARTIST_SENT', 'FRAMING', 'SHIPPED', 'DELIVERED', 'REPLACEMENT'].includes(st)) return '';
  if (e.kind === 'MARKET' && parseDet(e.details).Maker !== 'Artist') return '';
  return `<div style="font-size:13px"><button type="button" class="linkbtn" data-coa="${esc(e.id)}">🏅 Certificate of authenticity (PDF)</button></div>`;
}
let jsPdfLoad = null;
const loadJsPdf = () => (jsPdfLoad ||= new Promise((ok, no) => { if (window.jspdf) return ok(window.jspdf); const sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'; sc.onload = () => ok(window.jspdf); sc.onerror = () => { jsPdfLoad = null; no(new Error('Could not load the PDF maker. Check your connection and try again.')); }; document.head.appendChild(sc); }));
async function certificatePdf(c) {
  const { jsPDF } = await loadJsPdf();
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const W = 297, H = 210, gold = [154, 117, 46], ink = [40, 32, 24];
  doc.setDrawColor(...gold); doc.setLineWidth(1.2); doc.rect(10, 10, W - 20, H - 20); doc.setLineWidth(0.3); doc.rect(14, 14, W - 28, H - 28);
  doc.setTextColor(...gold); doc.setFont('times', 'normal'); doc.setFontSize(13); doc.text('KALAI ART HOUSE  ·  DUBAI', W / 2, 32, { align: 'center' });
  doc.setTextColor(...ink); doc.setFont('times', 'bold'); doc.setFontSize(30); doc.text('Certificate of Authenticity', W / 2, 50, { align: 'center' });
  doc.setFont('times', 'normal'); doc.setFontSize(12); doc.text('This certifies that the artwork described below is an original work, made by hand and signed by the artist.', W / 2, 62, { align: 'center' });
  const rows = [['Title', c.title], ['Artist', c.artist], ['Medium', c.medium], ['Size', c.size], ['Artwork no.', c.code], ['Order', c.ref], ['Issued', c.issued ? new Date(c.issued).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : ''], ['Collector', c.owner]].filter((r) => r[1]);
  let y = 80; doc.setFontSize(13);
  rows.forEach(([k, v]) => { doc.setFont('times', 'bold'); doc.text(k, 80, y); doc.setFont('times', 'normal'); doc.text(String(v).slice(0, 80), 125, y); y += 9; });
  doc.setDrawColor(...gold); doc.setLineWidth(0.4); doc.line(195, 172, 265, 172); doc.setFontSize(10); doc.text('For Kalai Art House', 230, 178, { align: 'center' });
  doc.setTextColor(...gold); doc.setFont('courier', 'bold'); doc.setFontSize(12); doc.text(`Certificate no. ${c.number}`, 32, 170);
  doc.setFont('times', 'normal'); doc.setTextColor(...ink); doc.setFontSize(10); doc.text(`Check it at ${location.origin}/#verify (enter the certificate number).`, 32, 177);
  doc.save(`${c.number}.pdf`);
}
// Anyone: check a certificate number (website → #verify).
window.kalaiVerifyCoa = async (code) => {
  const { data, errors } = await client.mutations.verifyCertificate({ code }, { authMode: 'apiKey' });
  if (errors?.length) throw new Error(errors[0].message);
  return typeof data === 'string' ? JSON.parse(data) : data;
};
// Website → artwork → Licences → Buy: sign in, the function prices it and makes the Ziina link, then we go to it.
let pendingLicence = null;
async function buyLicence(pl) {
  title.textContent = 'Image licence';
  body.innerHTML = `<p>Preparing your secure payment for the <b>${esc(pl.label)}</b> of <b>${esc(pl.name)}</b>…</p><p class="acct-info" id="licWait"></p>`;
  open();
  try {
    const { data, errors } = await client.mutations.licenceOrder({ data: JSON.stringify({ productId: pl.productId, type: pl.type, name: state.name || '' }) });
    if (errors?.length) throw new Error(errors[0].message);
    const r = typeof data === 'string' ? JSON.parse(data) : data;
    const w = body.querySelector('#licWait');
    for (let i = 0; i < 12; i++) {
      await new Promise((ok) => setTimeout(ok, 1500));
      const g = await client.models.Enquiry.get({ id: r.id }).catch(() => null);
      const link = g?.data?.paymentLink;
      if (link) {
        body.innerHTML = `<p>Your <b>${esc(pl.label)}</b> for <b>${esc(pl.name)}</b>: <b>⃃ ${Number(r.total).toLocaleString('en-US')}</b> (order ${esc(r.ref)}).</p>
          <a class="btn primary" style="text-decoration:none;text-align:center;display:block" href="${esc(link)}">Pay ⃃ ${Number(r.total).toLocaleString('en-US')} securely</a>
          <p class="acct-info">After paying you come back here and the full-size file is ready to download under My enquiries &amp; orders.</p>`;
        location.href = link;
        return;
      }
      if (w) w.textContent = 'Creating the payment link…';
    }
    body.innerHTML = `<p>Order <b>${esc(r.ref)}</b> is saved (⃃ ${Number(r.total).toLocaleString('en-US')}). We've emailed you the payment link; it is also under My enquiries &amp; orders.</p><button class="btn primary" type="button" id="licList">My enquiries &amp; orders</button>`;
    body.querySelector('#licList').onclick = showList;
  } catch (ex) {
    body.innerHTML = `<p class="acct-err">${esc(ex.message || 'Could not start the licence order.')}</p>`;
  }
}
window.kalaiBuyLicence = (pl) => {
  if (state.user) { buyLicence(pl); return; }
  pendingLicence = pl;
  showSignIn('Sign in or create a free account to buy a licence, so you can pay securely and download the file.');
  open();
};

function wireRequests(root, items) {
  root.querySelectorAll('[data-licfile]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true; const t0 = b.textContent; b.textContent = 'Preparing the download…';
      try {
        const { data, errors } = await client.mutations.customerRequest({ id: b.dataset.licfile, action: 'LICENCE_FILE' });
        if (errors?.length) throw new Error(errors[0].message);
        const r = typeof data === 'string' ? JSON.parse(data) : data;
        location.href = r.url;
        b.textContent = t0;
      } catch (ex) { b.textContent = ex.message || 'Could not get the file.'; }
      finally { b.disabled = false; }
    };
  });
  root.querySelectorAll('[data-coa]').forEach((b) => {
    b.onclick = async () => {
      const t0 = b.textContent; b.disabled = true; b.textContent = 'Making the certificate…';
      try {
        const { data, errors } = await client.mutations.customerRequest({ id: b.dataset.coa, action: 'COA' });
        if (errors?.length) throw new Error(errors[0].message);
        await certificatePdf(typeof data === 'string' ? JSON.parse(data) : data);
        b.textContent = t0;
      } catch (ex) { b.textContent = ex.message || 'Could not make the certificate.'; }
      finally { b.disabled = false; }
    };
  });
  root.querySelectorAll('[data-pdf]').forEach((b) => {
    b.onclick = () => openPdf(async () => {
      const { data, errors } = await client.mutations.customerRequest({ id: b.dataset.id, action: b.dataset.pdf });
      if (errors?.length) throw new Error(errors[0].message);
      return typeof data === 'string' ? JSON.parse(data) : data;
    });
  });
  root.querySelectorAll('[data-withdraw]').forEach((b) => {
    b.onclick = async () => {
      if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = 'Withdraw it? Tap again to confirm'; return; }
      b.disabled = true; b.textContent = 'Withdrawing…';
      try {
        const { errors } = await client.mutations.customerRequest({ id: b.dataset.withdraw, action: 'WITHDRAW' });
        if (errors?.length) throw new Error(errors[0].message);
        const e = items.find((x) => x.id === b.dataset.withdraw); if (e) { e.cancelState = 'WITHDRAWN'; e.cancelRefundDue = null; }
        currentTab = 'ORDERS'; showList();
      } catch (ex) { b.textContent = ex.message || 'Could not withdraw.'; b.disabled = false; }
    };
  });
  root.querySelectorAll('[data-req]').forEach((b) => {
    b.onclick = () => {
      const e = items.find((x) => x.id === b.dataset.id);
      const which = b.dataset.req;
      b.hidden = true;
      b.insertAdjacentHTML('afterend', requestForm(e, which));
      const f = b.nextElementSibling;
      f.querySelector('[data-close]').onclick = () => { f.remove(); b.hidden = false; };
      f.querySelectorAll('a[href="#terms"]').forEach((a) => { a.onclick = () => close(); });
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        const err = f.querySelector('.acct-err');
        const btn = f.querySelector('button[type=submit]');
        const action = which === 'CANCEL' ? 'CANCEL' : f.querySelector('input[name=action]:checked').value;
        const reason = String(f.reason.value || '').trim();
        const files = which === 'DAMAGE' ? [...(f.photos.files || [])].slice(0, 3) : [];
        if (which === 'DAMAGE' && reason.length < 5) { err.textContent = 'Describe the damage in a few words.'; return; }
        if (which === 'DAMAGE' && !files.length) { err.textContent = 'Add at least one photo of the damage.'; return; }
        if (f.agree && !f.agree.checked) { err.textContent = 'Please tick the box to accept the terms.'; return; }
        btn.disabled = true; err.textContent = files.length ? 'Uploading photos…' : '';
        try {
          const keys = [];
          for (const [i, file] of files.entries()) {
            const res = await uploadData({
              path: ({ identityId }) => `uploads/${identityId}/${e.ref}-damage-${i + 1}-${safeName(file.name)}`,
              data: file, options: { contentType: file.type || 'image/jpeg' },
            }).result;
            keys.push(res.path);
          }
          err.textContent = '';
          const { data, errors } = await client.mutations.customerRequest({ id: e.id, action, reason: reason || null, photos: keys.join('\n') || null });
          if (errors?.length) throw new Error(errors[0].message);
          const r = typeof data === 'string' ? JSON.parse(data) : data;
          Object.assign(e, { cancelRequest: action, cancelState: r.state, cancelRequestedAt: r.at, cancelRefundDue: r.due, status: r.status || e.status });
          currentTab = 'CANCEL';
          showList();
        } catch (ex) {
          err.textContent = ex.message || 'Could not send your request.';
          btn.disabled = false;
        }
      };
    };
  });
}

/* ---------- replacement tracker (damaged in transit → replacement) ---------- */
const shortDay = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
function replacementTracker(e) {
  const st = e.status || '';
  if (!(st === 'REPLACEMENT' || (e.refundAction === 'DAMAGED_REPLACE' && ['SHIPPED', 'DELIVERED'].includes(st)))) return '';
  const steps = [];
  const add = (done, label, extra = '', at = '') => steps.push({ done, label, extra, at });
  add(true, 'Damage reported', '', e.cancelRequestedAt);
  if (e.returnMode === 'PICKUP') {
    add(!!e.returnAwb, 'Return pickup booked', e.returnAwb ? `${e.returnCourier} · AWB ${e.returnAwb}${e.returnPickupDate ? ` · ${shortDay(e.returnPickupDate)}` : ''}` : 'we will email you the courier and date');
    add(!!e.returnPickedAt, 'Collected from you', '', e.returnPickedAt);
  }
  if (e.returnMode && e.returnMode !== 'NONE') add(!!e.returnReceivedAt, 'Received at our framing studio', '', e.returnReceivedAt);
  const working = !!(e.reworkStartedAt || e.reworkStage || e.toSivaSentAt);
  const ready = e.reworkStage === 'READY';
  add(working || ready, e.reworkType === 'SIVA_REPAINT' ? 'The artist is painting your replacement' : e.reworkType?.startsWith('SIVA') ? 'The artist is repairing it' : 'Being repaired and re-framed');
  add(ready, 'Checked and ready to ship', '', e.reworkReadyAt);
  add(['SHIPPED', 'DELIVERED'].includes(st), 'On its way to you', ['SHIPPED', 'DELIVERED'].includes(st) && e.trackingNo ? `${e.courierName} · tracking no. ${e.trackingNo}` : '');
  add(st === 'DELIVERED', 'Delivered', '', st === 'DELIVERED' ? e.deliveredAt : '');
  const current = steps.findIndex((x) => !x.done);
  return `<div class="enq-msg"><b>Replacement</b>${st === 'REPLACEMENT' ? " · we're sorry it arrived damaged" : ''}
    <ol class="rtrack">${steps.map((x, i) => `<li class="${x.done ? 'done' : i === current ? 'now' : ''}"><span>${x.done ? '✓' : i === current ? '●' : '○'}</span> ${esc(x.label)}${x.extra ? ` <small>${esc(x.extra)}</small>` : ''}${x.at ? ` <small>· ${esc(shortDay(x.at))}</small>` : ''}</li>`).join('')}</ol></div>`;
}

/* ---------- delivery address (from the price onwards, until it ships) ---------- */
const ADDR_OPEN = ['PRICE_SENT', 'PAID', 'ARTIST_WORKING', 'ARTIST_DONE', 'ARTIST_SENT', 'FRAMING', 'REPLACEMENT'];
function addressBlock(e) {
  if (!(ADDR_OPEN.includes(e.status) || (e.kind === 'MARKET' && (e.status || 'RECEIVED') === 'RECEIVED')) || e.cancelState === 'REQUESTED') return '';
  if (e.deliveryAddress) {
    return `<div class="addr"><b>Deliver to</b> ${esc(e.deliveryName)} · ${esc(e.deliveryPhone)}<br>${esc(addressLine(e))}
      <button type="button" class="req-open" data-addr="${esc(e.id)}">Change</button></div>`;
  }
  const urgent = e.status !== 'PRICE_SENT';
  return `<div class="addr ${urgent ? 'need' : ''}">${urgent ? '<b>Add your delivery address</b> so we can ship it as soon as it is ready.' : 'Where should we deliver it?'}
    <button type="button" class="${urgent ? 'btn primary' : 'req-open'}" data-addr="${esc(e.id)}" style="${urgent ? 'justify-self:start;padding:6px 14px;font-size:13px' : ''}">Add delivery address</button></div>`;
}
function addressForm(e) {
  return `<form class="req addr-form" novalidate>
    <b>Delivery address</b>
    <div class="field"><label>Receiver's name</label><input name="name" value="${esc(e.deliveryName || e.customerName)}" autocomplete="name"></div>
    <div class="field"><label>Receiver's mobile</label><input name="phone" value="${esc(e.deliveryPhone || e.phone)}" inputmode="tel" autocomplete="tel"></div>
    <div class="two">${countryRegionHtml({ country: e.deliveryCountry || 'UAE', region: e.deliveryEmirate, pin: e.deliveryPin, prefix: 'ad' + esc(e.id).slice(0, 6) })}</div>
    <div class="field"><label>Address</label><textarea name="address" rows="2" placeholder="Villa / flat no., building, street, area" autocomplete="street-address">${esc(e.deliveryAddress)}</textarea></div>
    <div class="field"><label>Landmark (optional)</label><input name="landmark" value="${esc(e.deliveryLandmark)}" placeholder="e.g. near Spinneys"></div>
    <div class="acct-err" role="alert"></div>
    <div class="row"><button class="btn primary" type="submit">Save address</button><button class="btn" type="button" data-close>Cancel</button></div>
  </form>`;
}
function wireAddress(root, items) {
  root.querySelectorAll('[data-addr]').forEach((b) => {
    b.onclick = () => {
      const e = items.find((x) => x.id === b.dataset.addr);
      const box = b.closest('.addr');
      box.hidden = true;
      box.insertAdjacentHTML('afterend', addressForm(e));
      const f = box.nextElementSibling;
      wireRegion(f);
      f.querySelector('[data-close]').onclick = () => { f.remove(); box.hidden = false; };
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        const err = f.querySelector('.acct-err');
        const v = { name: f.name.value.trim(), phone: f.phone.value.trim(), country: f.country.value, emirate: f.emirate.value, pin: f.pin.value.trim(), address: f.address.value.trim(), landmark: f.landmark.value.trim() };
        const india = v.country === 'India', uae = v.country === 'UAE';
        const why = !v.name ? "Add the receiver's name." : v.phone.replace(/\D/g, '').length < 9 ? 'Add a mobile number the courier can call.' : !v.emirate ? (india ? 'Choose the state.' : uae ? 'Choose the emirate.' : 'Add the state, province or city.') : india && !/^\d{6}$/.test(v.pin) ? 'Add the 6-digit PIN code.' : v.address.length < 10 ? 'Add the full address: house or flat, building, street and area.' : '';
        if (why) { err.textContent = why; return; }
        const btn = f.querySelector('button[type=submit]'); btn.disabled = true; err.textContent = '';
        try {
          const { errors } = await client.mutations.customerAddress({ id: e.id, ...v, landmark: v.landmark || null, pin: !uae && v.pin ? v.pin : null });
          if (errors?.length) throw new Error(errors[0].message);
          Object.assign(e, { deliveryName: v.name, deliveryPhone: v.phone, deliveryCountry: v.country, deliveryEmirate: v.emirate, deliveryPin: uae ? '' : v.pin, deliveryAddress: v.address, deliveryLandmark: v.landmark });
          showList();
        } catch (ex) { err.textContent = ex.message || 'Could not save the address.'; btn.disabled = false; }
      };
    };
  });
}

const parseDet = (d) => { try { const v = typeof d === 'string' ? JSON.parse(d) : d; return (typeof v === 'string' ? JSON.parse(v) : v) || {}; } catch { return {}; } };
// Discount code on an order that has a price and isn't paid yet.
/* ---------- Kalai Circle: points, level, invite code; points spent on an order ---------- */
let circle = null;
async function showCircle(items) {
  const host = body.querySelector('#circleBox'); if (!host) return;
  try {
    const r = await client.mutations.customerProfile({ action: 'get' });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    circle = d?.loyalty?.on ? d.loyalty : null;
    showProgrammes(d?.programmes);
  } catch { circle = null; }
  if (!circle) { host.innerHTML = ''; return; }
  const c = circle, fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const nx = c.next ? `${c.next.spendLeft ? `Spend ⃃ ${fmt(c.next.spendLeft)} more` : ''}${c.next.spendLeft && c.next.ordersLeft ? ' or ' : ''}${c.next.ordersLeft ? `${c.next.ordersLeft} more order${c.next.ordersLeft > 1 ? 's' : ''}` : ''} to reach <b>${esc(c.next.name)}</b> (${c.next.pct}% back).` : 'You are at our highest level. Thank you!';
  const share = c.referralCode ? `https://art.pranixtechno.com/#redeem=${encodeURIComponent(c.referralCode)}` : '';
  const wa = `I love the original art from Kalai Art House in Dubai. Here's ⃃ ${c.friendAed} off your first order (from ⃃ ${c.friendMin}) with my code ${c.referralCode}: ${share}`;
  host.innerHTML = `<div class="circle"><div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap"><b style="font-size:15px">✦ Kalai Circle</b><span class="pill">${esc(c.tier)} · ${c.pct}% back</span>
      <span style="margin-left:auto"><b style="font-size:18px">${fmt(c.points)}</b> points <span class="acct-info">= ⃃ ${fmt(c.worth)}</span></span></div>
    <div class="acct-info" style="font-size:13px">${nx}${c.expireAt ? ` Points last until ${esc(new Date(c.expireAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }))} (each new order extends them).` : ''} Spend them on an order from ${fmt(c.minRedeem)} points, up to ${c.maxPct}% of its price.</div>
    ${c.referralCode ? `<div style="font-size:13px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">Invite friends: they get <b>⃃ ${c.friendAed} off</b> their first order, you get <b>⃃ ${c.referrerAed}</b> in points. Your code <b class="mono">${esc(c.referralCode)}</b> <a href="https://wa.me/?text=${encodeURIComponent(wa)}" target="_blank" rel="noopener" class="acct-link" style="margin:0">Share on WhatsApp</a><button type="button" class="acct-link" style="margin:0" data-copyref>Copy link</button></div>` : ''}
    <details style="font-size:12px"><summary class="acct-info">How it works · history</summary><div class="acct-info">Points come 48 hours after an order is delivered: ${c.tiers.map((t) => `<b>${esc(t.name)}</b> ${t.pct}%${t.spend ? ` (from ⃃ ${fmt(t.spend)}${t.orders ? ` or ${t.orders} orders` : ''})` : ''}`).join(' · ')}. 100 points = ⃃ ${c.pointValue}. Points have no cash value and can't be transferred.</div>
      ${(c.history || []).map((h) => `<div>${esc(new Date(h.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }))} · ${h.pts > 0 ? '+' : ''}${h.pts} · ${esc({ order: 'order', referral: 'friend invited', spent: 'spent on', back: 'given back', expired: 'expired', adjust: 'from the studio' }[h.why] || h.why)} ${esc(h.ref || '')}</div>`).join('')}</details></div>`;
  host.querySelector('[data-copyref]')?.addEventListener('click', async (ev) => { try { await navigator.clipboard.writeText(share); ev.target.textContent = 'Copied'; } catch { ev.target.textContent = share; } });
  // Order cards were drawn before the balance arrived: draw their points boxes now.
  body.querySelectorAll('[data-points-slot]').forEach((el) => { const e = items.find((x) => x.id === el.dataset.pointsSlot); if (e) { el.outerHTML = pointsBox(e); } });
  wirePoints(items);
}
/* ---------- Special programmes (seniors, Little Artists, top students …): apply, see the outcome ---------- */
function showProgrammes(pg) {
  const host = body.querySelector('#progBox'); if (!host) return;
  if (!pg || (!pg.list?.length && !pg.mine?.length)) { host.innerHTML = ''; return; }
  const ST = { PENDING: 'waiting for the studio', APPROVED: 'approved', DECLINED: 'not approved', ENDED: 'ended' };
  const dt = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const busy = new Set((pg.mine || []).filter((a) => a.status === 'PENDING' || (a.status === 'APPROVED' && !a.voucher)).map((a) => a.pid));
  host.innerHTML = `<div class="circle"><b style="font-size:15px">♥ Special programmes</b>
    ${(pg.mine || []).map((a) => `<div style="font-size:13px"><b>${esc(a.name)}</b> (${esc(a.offer)}): ${ST[a.status] || a.status}${a.status === 'APPROVED' && a.voucher ? `. Your code <b class="mono">${esc(a.voucher)}</b>${a.until ? `, valid until ${esc(dt(a.until))}` : ''}: enter it on an order below.` : a.status === 'APPROVED' ? `. Taken off when we send your price${a.until ? `, until ${esc(dt(a.until))}` : ''}.` : ''}${a.note ? ` <span class="acct-info">${esc(a.note)}</span>` : ''}</div>`).join('')}
    <details style="font-size:13px"><summary class="acct-info">See the programmes and apply</summary>
    ${(pg.list || []).map((p) => `<div style="border-top:1px solid #0001;padding-top:6px;margin-top:6px"><b>${esc(p.name)}</b>: ${esc(p.offer)}${p.kind === 'ONGOING' ? ' on your orders' : ', one order'}. <span class="acct-info">${esc(p.about)}</span>
      ${busy.has(p.id) ? '<div class="acct-info">You have this programme or a request is waiting.</div>' : `<button type="button" class="acct-link" style="margin:0" data-pg-open="${esc(p.id)}">Apply</button>
      <form data-pg="${esc(p.id)}" hidden novalidate style="display:grid;gap:6px;margin-top:6px">
        <div class="acct-info">What we need: ${esc(p.proof)}</div>
        <input name="who" maxlength="80" placeholder="Who is it for? (name; for a child, their first name and age)">
        <textarea name="said" maxlength="400" rows="2" placeholder="Tell us briefly"></textarea>
        ${p.upload ? '<label class="acct-info">Proof (optional, photo or PDF; deleted once we decide) <input name="file" type="file" accept="image/*,application/pdf"></label>' : ''}
        <label style="display:flex;gap:6px;align-items:flex-start"><input type="checkbox" name="agree"> <span>The details are true. Kalai Art House may decline or end a programme discount.</span></label>
        <div><button class="btn" type="submit" style="padding:6px 12px;font-size:13px">Send request</button> <span class="acct-err" data-pg-msg></span></div></form>`}</div>`).join('')}</details></div>`;
  host.querySelectorAll('[data-pg-open]').forEach((b) => { b.onclick = () => { const f = host.querySelector(`form[data-pg="${b.dataset.pgOpen}"]`); f.hidden = !f.hidden; }; });
  host.querySelectorAll('form[data-pg]').forEach((f) => {
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const msg = f.querySelector('[data-pg-msg]'), btnS = f.querySelector('button[type=submit]');
      if (!f.agree.checked) { msg.textContent = 'Please tick to confirm the details are true.'; return; }
      btnS.disabled = true; msg.textContent = 'Sending…';
      try {
        let proofKey = '';
        const file = f.file?.files?.[0];
        if (file) {
          if (file.size > 8 * 1024 * 1024) throw new Error('The file is too large (8 MB at most).');
          proofKey = (await uploadData({ path: ({ identityId }) => `uploads/${identityId}/programme-${f.dataset.pg}-${Date.now()}-${safeName(file.name)}`, data: file, options: { contentType: file.type || 'application/octet-stream' } }).result).path;
        }
        const r = await client.mutations.customerProfile({ action: 'applyProgramme', data: JSON.stringify({ pid: f.dataset.pg, who: f.who.value.trim(), said: f.said.value.trim(), proofKey, agree: true }) });
        if (r.errors?.length) throw new Error(r.errors[0].message.replace(/^.*?Error: /, ''));
        const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
        showProgrammes(d);
        host.insertAdjacentHTML('afterbegin', '<p class="acct-info" style="margin:0 0 6px">Thank you. We\'ve received your request and will email you once we\'ve looked at it.</p>');
      } catch (ex) { msg.textContent = ex.message || 'Not sent.'; btnS.disabled = false; }
    };
  });
}
function pointsBox(e) {
  const st = e.status || 'RECEIVED';
  if (!e.quotedPrice || !['RECEIVED', 'PRICE_SENT'].includes(st) || e.cancelState === 'REQUESTED') return '';
  if (!circle) return `<span data-points-slot="${esc(e.id)}" hidden></span>`;
  if (e.loyaltyRedeemed) return `<div class="code-box" data-points-id="${esc(e.id)}" style="font-size:13px">✦ ${Number(e.loyaltyRedeemed).toLocaleString('en-US')} Kalai Circle points used: − ⃃ ${Number(e.loyaltyAmount || 0).toLocaleString('en-US')} <button type="button" class="req-open" data-points-remove>Remove</button><span class="acct-err" data-points-msg></span></div>`;
  if (circle.points < circle.minRedeem) return '';
  const base = Number(e.quotedPrice), maxAed = Math.floor(base * circle.maxPct) / 100, maxPts = Math.min(circle.points, Math.ceil(maxAed * 100 / circle.pointValue));
  return `<form class="code-box" data-points-id="${esc(e.id)}" novalidate style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:13px">✦ Use points: <input name="pts" type="number" min="${circle.minRedeem}" max="${maxPts}" step="1" value="${maxPts}" style="max-width:110px;padding:6px 8px;font-size:13px"> <span class="acct-info" data-points-worth>= ⃃ ${(Math.floor(maxPts * circle.pointValue) / 100).toLocaleString('en-US')}</span><button class="btn" type="submit" style="padding:6px 12px;font-size:13px">Use</button><span class="acct-err" data-points-msg style="flex-basis:100%"></span></form>`;
}
function wirePoints() {
  body.querySelectorAll('[data-points-id]').forEach((box) => {
    const id = box.dataset.pointsId, msg = box.querySelector('[data-points-msg]');
    const send = async (pts) => {
      msg.textContent = ''; box.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        const r = await client.mutations.redeemPoints({ id, points: pts });
        if (r.errors?.length) throw new Error(r.errors[0].message.replace(/^.*?Error: /, ''));
        await showList();
      } catch (ex) { msg.textContent = ex.message || 'Not applied.'; box.querySelectorAll('button').forEach((b) => { b.disabled = false; }); }
    };
    if (box.tagName === 'FORM') {
      const inp = box.querySelector('[name=pts]');
      inp.oninput = () => { box.querySelector('[data-points-worth]').textContent = `= ⃃ ${(Math.floor(Number(inp.value || 0) * circle.pointValue) / 100).toLocaleString('en-US')}`; };
      box.onsubmit = (ev) => { ev.preventDefault(); send(Number(inp.value)); };
    }
    box.querySelector('[data-points-remove]')?.addEventListener('click', () => send(0));
  });
}

/* ---------- Gift cards, vouchers and private codes: check, scan the QR, apply to an order ---------- */
const PENDING = 'kalaiRedeem';
const pendingCode = () => { try { return localStorage.getItem(PENDING) || ''; } catch { return ''; } };
function wireRedeem(items) {
  const box = body.querySelector('#redeemBox'); if (!box) return;
  const out = body.querySelector('#redeemOut'), inp = body.querySelector('#redeemCode');
  const pend = pendingCode(); if (pend) { inp.value = pend; box.open = true; }
  const open = () => items.filter((e) => e.quotedPrice && ['RECEIVED', 'PRICE_SENT'].includes(e.status || 'RECEIVED') && !e.discountCode && !e.discountType && e.cancelState !== 'REQUESTED');
  const check = async (code) => {
    code = String(code || '').trim().toUpperCase(); if (!code) return;
    out.innerHTML = 'Checking…';
    try {
      const r = await client.mutations.checkCode({ code });
      if (r.errors?.length) throw new Error(r.errors[0].message.replace(/^.*?Error: /, ''));
      const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
      try { localStorage.setItem(PENDING, code); } catch { /* */ }
      const os = open();
      out.innerHTML = `<b style="color:var(--ok)">✓ ${esc(d.text)}</b><br>${os.length ? `Use it on: ${os.map((e) => `<button type="button" class="btn" data-redeem="${esc(e.id)}" style="padding:4px 10px;font-size:12px;margin:4px 4px 0 0">${esc(e.title)} · ⃃ ${Number(e.quotedPrice).toLocaleString('en-US')}</button>`).join('')}`
        : "Saved: it's filled in for you on your next order once we send you the price (or ask for the price on any artwork now)."}`;
      out.querySelectorAll('[data-redeem]').forEach((b) => { b.onclick = async () => {
        b.disabled = true;
        try {
          const a = await client.mutations.applyCode({ id: b.dataset.redeem, code });
          if (a.errors?.length) throw new Error(a.errors[0].message.replace(/^.*?Error: /, ''));
          try { localStorage.removeItem(PENDING); } catch { /* */ }
          await showList();
        } catch (ex) { out.insertAdjacentHTML('beforeend', `<div class="acct-err">${esc(ex.message)}</div>`); b.disabled = false; }
      }; });
    } catch (ex) { out.innerHTML = `<span class="acct-err">${esc(ex.message || 'This code is not valid.')}</span>`; }
  };
  body.querySelector('#redeemForm').onsubmit = (ev) => { ev.preventDefault(); check(inp.value); };
  if (pend) check(pend);
  // Scan the QR on a printed gift card or voucher with the phone camera (where the browser can read QR codes).
  body.querySelector('#redeemScan').onclick = async () => {
    const cam = body.querySelector('#redeemCam');
    if (!('BarcodeDetector' in window)) { out.innerHTML = 'Your browser cannot scan here: open your phone camera and point it at the QR code; it opens this page with the code filled in.'; return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); } catch { out.innerHTML = '<span class="acct-err">Camera not allowed. You can type the code instead.</span>'; return; }
    cam.srcObject = stream; cam.hidden = false; await cam.play();
    const det = new window.BarcodeDetector({ formats: ['qr_code'] });
    const stop = () => { stream.getTracks().forEach((t) => t.stop()); cam.hidden = true; };
    const t0 = Date.now();
    const tick = async () => {
      if (cam.hidden) return;
      try {
        const codes = await det.detect(cam);
        const raw = codes[0]?.rawValue;
        if (raw) { stop(); const m = String(raw).match(/redeem=([A-Z0-9-]{4,30})/i); const code = (m ? m[1] : raw).toUpperCase().replace(/[^A-Z0-9-]/g, ''); inp.value = code; check(code); return; }
      } catch { /* keep trying */ }
      if (Date.now() - t0 > 30000) { stop(); out.textContent = 'No QR code found. You can type the code instead.'; return; }
      requestAnimationFrame(tick);
    };
    tick();
  };
}

function codeBox(e) {
  const st = e.status || 'RECEIVED';
  if (!e.quotedPrice || !['RECEIVED', 'PRICE_SENT'].includes(st) || e.cancelState === 'REQUESTED') return '';
  if (e.discountCode) return `<div class="code-box" data-code-id="${esc(e.id)}"><button type="button" class="req-open" data-code-remove>Remove code</button><span class="acct-err" data-code-msg></span></div>`;
  return `<form class="code-box" data-code-id="${esc(e.id)}" novalidate style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><input name="code" placeholder="Code or gift card" value="${esc(pendingCode())}" maxlength="30" style="max-width:160px;text-transform:uppercase;padding:6px 8px;font-size:13px"><button class="btn" type="submit" style="padding:6px 12px;font-size:13px">Apply</button><a href="/offers.html" class="acct-info" style="font-size:12px">See offers</a><span class="acct-err" data-code-msg style="flex-basis:100%"></span></form>`;
}
function wireCodes(root) {
  root.querySelectorAll('.code-box').forEach((box) => {
    const id = box.dataset.codeId;
    const msg = box.querySelector('[data-code-msg]');
    const send = async (code) => {
      msg.textContent = '';
      box.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        const r = await client.mutations.applyCode({ id, code: code || null });
        if (r.errors?.length) throw new Error(r.errors[0].message.replace(/^.*?Error: /, ''));
        await showList();
      } catch (ex) { msg.textContent = ex.message || 'Could not apply the code.'; box.querySelectorAll('button').forEach((b) => { b.disabled = false; }); }
    };
    if (box.tagName === 'FORM') box.onsubmit = (ev) => { ev.preventDefault(); const c = box.code.value.trim(); if (c) send(c); };
    box.querySelector('[data-code-remove]')?.addEventListener('click', () => send(''));
  });
}
let BASKETS = {};
const payLabel = (e) => { const b = e.basketRef && BASKETS[e.basketRef]; return b && b.n > 1 ? `Pay ⃃ ${Number(b.total.toFixed(2)).toLocaleString('en-US')} for order ${esc(e.basketRef)} (${b.n} items)` : 'Pay now'; };
function card(e) {
  const st = e.status || 'RECEIVED';
  const steps = e.kind === 'MARKET' ? MARKET_STEPS : e.kind === 'LICENCE' ? LICENCE_STEPS : ['PHOTO', 'GIFT'].includes(e.kind) ? FRAME_STEPS : STEPS;
  const idx = steps.indexOf(st);
  const pillCls = st === 'DELIVERED' ? 'pill done' : st === 'CANCELLED' || st === 'REFUNDED' ? 'pill stop' : 'pill';
  const date = e.createdAt ? new Date(e.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const pay = st === 'PRICE_SENT' && e.paymentLink
    ? `<a class="btn primary" style="text-decoration:none;text-align:center" href="${esc(e.paymentLink)}" target="_blank" rel="noopener">${payLabel(e)}</a>` : '';
  return `<article class="enq">
    <div class="enq-top"><span class="enq-title">${esc(e.title)}</span><span class="${pillCls}">${esc(STATUS[st] || st)}</span></div>
    <div class="enq-ref">${esc(e.ref)} · ${esc(KIND[e.kind] || '')} · ${esc(date)}</div>
    ${!['CANCELLED', 'REFUNDED', 'REPLACEMENT'].includes(st) ? `<div class="steps-bar" aria-hidden="true" style="grid-template-columns:repeat(${steps.length},1fr)">${steps.map((_, i) => `<i class="${i <= idx ? 'on' : ''}"></i>`).join('')}</div>` : ''}
    ${e.quotedPrice ? `<div>Price: ${e.discountCode && e.listPrice ? `<s class="acct-info">⃃ ${Number(e.listPrice).toLocaleString('en-US')}</s> ` : ''}<span class="enq-price">⃃ ${Number(e.quotedPrice).toLocaleString('en-US')}</span>${e.discountCode ? ` <span class="acct-info" style="font-size:12px">· code <b>${esc(e.discountCode)}</b> −⃃ ${Number(e.discountAmount || 0).toLocaleString('en-US')}</span>` : ''}</div>` : ''}
    ${e.loyaltyAt && e.loyaltyPoints ? `<div class="acct-info" style="font-size:13px">✦ You earned <b>${Number(e.loyaltyPoints).toLocaleString('en-US')} Kalai Circle points</b> on this order.</div>` : e.status === 'DELIVERED' && circle ? '<div class="acct-info" style="font-size:13px">✦ Your Kalai Circle points for this order arrive 48 hours after delivery.</div>' : ''}
    ${codeBox(e)}
    ${pointsBox(e)}
    ${e.adminMessage ? `<div class="enq-msg">${esc(e.adminMessage)}</div>` : ''}
    ${['PAID', 'ARTIST_WORKING', 'ARTIST_DONE', 'ARTIST_SENT'].includes(st) && e.artistStage ? `<div class="enq-msg">${e.artistStage === 'STARTED' ? `The artist started your artwork on ${new Date(e.artistStartedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.` : e.artistStage === 'FINISHED' ? 'Your artwork is finished and is being prepared for the framer.' : 'Your artwork is on its way to our framer in Dubai.'}</div>` : ''}
    ${e.kind === 'MARKET' ? `<div class="acct-info" style="font-size:13px">By ${esc(parseDet(e.details).Maker || e.sellerName)}${e.qty > 1 ? ` · quantity ${e.qty}` : ''} · ${e.deliveryBy === 'KALAI' ? 'delivered by Kalai Art House' : 'delivered by the maker'}</div>` : ''}
    ${e.kind === 'MARKET' && st === 'RECEIVED' ? '<div class="enq-msg">Thank you for your order. We are confirming it with the maker and will send you a secure payment link shortly.</div>' : ''}
    ${e.kind === 'MARKET' && st === 'PAID' ? `<div class="enq-msg">${e.sellerStage === 'READY' ? 'The maker has packed it; our courier is collecting it.' : 'Paid: the maker is preparing your order.'}</div>` : ''}
    ${st === 'REFUNDED' && e.refundAmount ? `<div class="enq-msg">Refunded ⃃ ${Number(e.refundAmount).toLocaleString('en-US')}${e.refundRef ? ` · ref ${esc(e.refundRef)}` : ''}</div>` : ''}
    ${replacementTracker(e)}
    ${(st === 'SHIPPED' || st === 'DELIVERED') && e.courierName ? `<div class="enq-msg">${st === 'DELIVERED' ? 'Delivered' : 'Shipped'} with <b>${esc(e.courierName)}</b>${e.trackingNo ? ` · tracking no. <b>${esc(e.trackingNo)}</b>` : ''}</div>` : ''}
    ${e.zohoInvoiceId || e.zohoChallanId ? `<div style="display:flex;gap:14px;flex-wrap:wrap;font-size:13px">${e.zohoInvoiceId ? `<button type="button" class="linkbtn" data-pdf="INVOICE_PDF" data-id="${esc(e.id)}">📄 Invoice${e.zohoInvoice ? ` ${esc(e.zohoInvoice)}` : ''} (PDF)</button>` : ''}${e.zohoChallanId ? `<button type="button" class="linkbtn" data-pdf="CHALLAN_PDF" data-id="${esc(e.id)}">🚚 Delivery note (PDF)</button>` : ''}</div>` : ''}
    ${pay}
    ${licenceBlock(e)}
    ${coaBlock(e)}
    ${e.kind === 'LICENCE' ? '' : addressBlock(e)}
    ${requestBlock(e)}
    ${rateBlock(e)}
  </article>`;
}

const ORDER_ST = ['PAID', 'ARTIST_WORKING', 'ARTIST_DONE', 'ARTIST_SENT', 'FRAMING', 'SHIPPED', 'DELIVERED', 'REPLACEMENT'];
/* ---------- Tracker: every step of each open order, live (no need to wait for an email) ---------- */
const TRACK_STEPS = {
  ART: [['RECEIVED', 'Enquiry received', 'We have your request.'], ['PRICE_SENT', 'Price sent', 'The price and payment link are ready.'], ['PAID', 'Paid', 'Your order is confirmed.'],
    ['ARTIST_WORKING', 'Artist at work', 'The artist is making your artwork by hand.'], ['ARTIST_DONE', 'Artwork finished', 'Finished and drying, ready to send.'],
    ['ARTIST_SENT', 'On its way to our framer', 'Sent from the artist\'s studio to our framer in Dubai.'], ['FRAMING', 'Being framed', 'Our framer in Dubai is mounting and framing it.'],
    ['SHIPPED', 'Out for delivery', 'With the courier.'], ['DELIVERED', 'Delivered', 'Enjoy it! Please rate your order.']],
  FRAME: [['RECEIVED', 'Order received', 'We have your order.'], ['PRICE_SENT', 'Payment link sent', 'Ready for payment.'], ['PAID', 'Paid', 'Your order is confirmed.'],
    ['FRAMING', 'Printing and framing', 'Our team in Dubai is printing and framing it.'], ['SHIPPED', 'Out for delivery', 'With the courier.'], ['DELIVERED', 'Delivered', 'Enjoy it! Please rate your order.']],
  MARKET: [['RECEIVED', 'Order received', 'We are confirming it with the maker.'], ['PRICE_SENT', 'Payment link sent', 'Ready for payment.'], ['PAID', 'Paid', 'The maker is preparing it.'],
    ['READY', 'Packed by the maker', 'Packed and ready for the courier.'], ['SHIPPED', 'Out for delivery', 'With the courier.'], ['DELIVERED', 'Delivered', 'Enjoy it!']],
  LICENCE: [['RECEIVED', 'Order received', ''], ['PRICE_SENT', 'Payment link sent', ''], ['DELIVERED', 'Paid · file ready', 'Download the full-size file under Orders.']],
};
function trackCard(e) {
  const st = e.status || 'RECEIVED';
  const steps = e.kind === 'MARKET' ? TRACK_STEPS.MARKET : e.kind === 'LICENCE' ? TRACK_STEPS.LICENCE : ['PHOTO', 'GIFT'].includes(e.kind) ? TRACK_STEPS.FRAME : TRACK_STEPS.ART;
  let log = []; try { log = JSON.parse(e.statusLog || '[]') || []; } catch { log = []; }
  const firstAt = (s) => (log.find((x) => x.s === s) || {}).at;
  const at = {
    RECEIVED: e.createdAt, PRICE_SENT: firstAt('PRICE_SENT'), PAID: firstAt('PAID'),
    ARTIST_WORKING: e.artistStartedAt || firstAt('ARTIST_WORKING'), ARTIST_DONE: e.artistFinishedAt || firstAt('ARTIST_DONE'), ARTIST_SENT: e.artistShippedAt || firstAt('ARTIST_SENT'),
    FRAMING: firstAt('FRAMING'), READY: e.sellerReadyAt, SHIPPED: firstAt('SHIPPED') || e.sellerDispatchedAt, DELIVERED: e.deliveredAt || firstAt('DELIVERED'),
  };
  // How far it has got: the status, or a later step already recorded (e.g. the artist's own steps).
  let cur = steps.findIndex(([k]) => k === st);
  if (e.kind === 'MARKET' && st === 'PAID' && e.sellerStage === 'READY') cur = steps.findIndex(([k]) => k === 'READY');
  steps.forEach(([k], i) => { if (at[k] && k !== 'RECEIVED' && i > cur && ['ARTIST_WORKING', 'ARTIST_DONE', 'ARTIST_SENT'].includes(k)) cur = i; });
  if (cur < 0) cur = 0;
  const d = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' · ' + new Date(v).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
  const ship = (st === 'SHIPPED' || st === 'DELIVERED') && e.courierName ? ` ${esc(e.courierName)}${e.trackingNo ? ` · tracking no. <b>${esc(e.trackingNo)}</b>` : ''}.` : '';
  return `<article class="enq trk">
    <div class="enq-top"><span class="enq-title">${esc(e.title)}</span><span class="pill">${esc(STATUS[st] || st)}</span></div>
    <div class="enq-ref">${esc(e.ref)} · ${esc(KIND[e.kind] || '')}</div>
    <ol class="trk-list">${steps.map(([k, label, note], i) => {
      const cls = i < cur ? 'done' : i === cur ? 'now' : 'todo';
      return `<li class="${cls}"><span class="dot">${i < cur || (i === cur && st === 'DELIVERED') ? '✓' : ''}</span><div><b>${esc(label)}</b>${at[k] && i <= cur ? ` <span class="trk-at">${esc(d(at[k]))}</span>` : ''}${i === cur ? `<div class="trk-note">${esc(note)}${k === 'SHIPPED' ? ship : ''}</div>` : ''}</div></li>`;
    }).join('')}</ol>
    ${st === 'PRICE_SENT' && e.paymentLink ? `<a class="btn primary" style="text-decoration:none;text-align:center" href="${esc(e.paymentLink)}" target="_blank" rel="noopener">${payLabel(e)}</a>` : ''}
  </article>`;
}
const TABS = [
  ['TRACK', 'Tracker', (e) => !['CANCELLED', 'REFUNDED'].includes(e.status) && !(e.status === 'DELIVERED' && e.deliveredAt && Date.now() - new Date(e.deliveredAt).getTime() > 14 * 864e5)],
  ['ORDERS', 'Orders', (e) => ORDER_ST.includes(e.status) && e.cancelState !== 'REQUESTED'],
  ['ENQ', 'Enquiries', (e) => ['RECEIVED', 'PRICE_SENT'].includes(e.status || 'RECEIVED')],
  ['CANCEL', 'Cancellations & refunds', (e) => ['CANCELLED', 'REFUNDED'].includes(e.status) || ['REQUESTED', 'DECLINED', 'REOPENED'].includes(e.cancelState)],
];
let currentTab = null;
const POLICY_NOTE = `<p class="acct-info" style="margin:0;font-size:13px">To cancel, open the order under <b>Orders</b> or <b>Enquiries</b> and tap “Cancel this order”: you see the refund before you confirm. Before payment it's free; after payment you get a full refund until the artist starts, then 50%. Shipped orders can't be cancelled; damage can be reported with photos within 48 hours of delivery. <a href="#terms" class="acct-terms" style="color:var(--kumkum)">Full terms</a></p>`;

/* ---------- My details: name, mobile and delivery address (the studio's customer master; open orders follow) ---------- */
async function showDetails() {
  title.textContent = 'My details';
  body.innerHTML = '<p class="acct-info">Loading…</p>';
  let c = {};
  try { const { data, errors } = await client.mutations.customerProfile({ action: 'get' }); if (errors?.length) throw new Error(errors[0].message); c = typeof data === 'string' ? JSON.parse(data) : data || {}; }
  catch (ex) { body.innerHTML = `<p class="acct-err">${esc(ex.message)}</p><button class="acct-link" id="back">Back</button>`; body.querySelector('#back').onclick = showList; return; }
  const f = form(`
    <p class="acct-info">${c.code ? `Customer no. <b style="font-family:var(--mono)">${esc(c.code)}</b> · ` : ''}${esc(c.email || state.email)}</p>
    <form novalidate>
      <div class="field"><label for="mdName">Name</label><input id="mdName" name="name" autocomplete="name" maxlength="80" value="${esc(c.name)}"></div>
      <div class="field"><label for="mdPhone">Mobile / WhatsApp</label><input id="mdPhone" name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="30" value="${esc(c.phone)}"></div>
      ${countryRegionHtml({ country: c.country || 'UAE', region: c.emirate, pin: c.pin, prefix: 'md' })}
      <div class="field"><label for="mdAddr">Delivery address</label><textarea id="mdAddr" name="address" rows="2" placeholder="Villa / flat no., building, street, area" autocomplete="street-address">${esc(c.address)}</textarea></div>
      <div class="field"><label for="mdLand">Landmark (optional)</label><input id="mdLand" name="landmark" value="${esc(c.landmark)}"></div>
      <p class="acct-info" style="margin:0;font-size:12px">Saving also updates your open orders (orders already shipped keep their address).</p>
      <div class="acct-err" role="alert"></div>
      <button class="btn primary" type="submit">Save my details</button>
      <button class="acct-link" type="button" id="mdBack">Back to my orders</button>
    </form>`, async (fd) => {
    const data = Object.fromEntries(fd.entries());
    const { data: r, errors } = await client.mutations.customerProfile({ action: 'save', data: JSON.stringify(data) });
    if (errors?.length) throw new Error(errors[0].message);
    const o = typeof r === 'string' ? JSON.parse(r) : r;
    toastMsg(`Saved${o?.updatedOrders ? `: ${o.updatedOrders} open order${o.updatedOrders === 1 ? '' : 's'} updated` : ''}.`);
    showList();
  });
  void f;
  wireRegion(body); autoPhones(body);
  body.querySelector('#mdBack').onclick = showList;
}
const toastMsg = (m) => { try { window.toast ? window.toast(m) : null; } catch { /* no toast */ } };

async function showList() {
  title.textContent = 'My enquiries & orders';
  if (!state.email) {
    try { state.email = (await fetchUserAttributes()).email || ''; } catch { /* keep going */ }
    if (!state.email) state.email = state.user?.signInDetails?.loginId || '';
  }
  let admin = false;
  try { admin = ((await fetchAuthSession()).tokens?.accessToken?.payload?.['cognito:groups'] || []).includes('ADMINS'); } catch { /* not admin */ }
  body.innerHTML = `<p class="acct-info">Signed in as <b>${esc(state.email)}</b><span id="custNo"></span></p>
    ${admin ? '<p class="acct-info" style="margin:0;font-size:13px;color:var(--kumkum)">Studio account: you see every customer\'s enquiries and orders here, and anything you do is done for that customer (they get the emails).</p>' : ''}
    <div class="acct-top"><div id="circleBox"></div>
    <div id="progBox"></div>
    <details class="redeem" id="redeemBox"><summary>🎁 Have a gift card, voucher or code?</summary>
      <form id="redeemForm" novalidate style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px"><input name="code" id="redeemCode" placeholder="Enter the code" maxlength="30" style="max-width:200px;text-transform:uppercase;padding:6px 8px;font-size:14px"><button class="btn" type="submit" style="padding:6px 12px;font-size:13px">Check</button><button class="btn ghost-dark" type="button" id="redeemScan" style="padding:6px 12px;font-size:13px">📷 Scan QR</button></form>
      <video id="redeemCam" playsinline muted hidden style="width:100%;max-width:320px;border-radius:8px;margin-top:8px"></video>
      <div id="redeemOut" class="acct-info" style="font-size:13px;margin-top:6px"></div></details></div>
    <nav class="acct-tabs" role="tablist" id="acctTabs"></nav>
    <div id="enqList" class="acct-info">Loading…</div>
    <button class="acct-link" id="myDetails">My details</button><button class="acct-link" id="refresh">Refresh</button><button class="acct-link" id="signOut">Sign out</button>`;
  body.querySelector('#signOut').onclick = async () => { await signOut(); state.user = null; setButton(); showSignIn('You are signed out.'); };
  body.querySelector('#refresh').onclick = showList;
  body.querySelector('#myDetails').onclick = showDetails;
  const list = body.querySelector('#enqList');
  try {
    const items = [];
    let nextToken = null;
    do {
      const res = await client.models.Enquiry.list({ limit: 100, nextToken });
      // Studio-only fields (payout, Ziina ids…) come back as "Not Authorized to access X": the rest of the order is fine.
      const real = (res.errors || []).filter((x) => !/Not Authorized to access \w+ on type Enquiry/i.test(x.message || ''));
      if (real.length) throw new Error(real[0].message);
      items.push(...res.data);
      nextToken = res.nextToken;
    } while (nextToken);
    items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    BASKETS = {}; items.filter((x) => x.basketRef && x.status === 'PRICE_SENT' && x.paymentLink).forEach((x) => { const b = (BASKETS[x.basketRef] ||= { n: 0, total: 0 }); b.n += 1; b.total += Number(x.quotedPrice || 0); });
    const cc = !admin && items.find((x) => x.customerCode)?.customerCode;
    if (cc && body.querySelector('#custNo')) body.querySelector('#custNo').innerHTML = ` · customer no. <b style="font-family:var(--mono)">${esc(cc)}</b>`;
    myReviews.clear();
    if (items.some((x) => x.status === 'DELIVERED')) {
      try {
        const rv = await client.models.Review.list({ limit: 200 });
        (rv.data || []).forEach((r) => myReviews.set(r.enquiryId, r));
      } catch { /* reviews are optional */ }
    }
    list.className = '';
    list.style.cssText = 'display:grid;gap:12px';
    if (!items.length) {
      body.querySelector('#acctTabs').hidden = true;
      list.innerHTML = `<p class="acct-info">Nothing here yet. Tap "Ask for price" on a painting, request a commission, or send a Little Artists gift, and it will appear here.</p>`;
      return;
    }
    const groups = Object.fromEntries(TABS.map(([k, , f]) => [k, items.filter(f)]));
    if (!currentTab || !groups[currentTab]) currentTab = groups.TRACK.length ? 'TRACK' : groups.ORDERS.length ? 'ORDERS' : groups.ENQ.length ? 'ENQ' : 'CANCEL';
    const nav = body.querySelector('#acctTabs');
    const draw = () => {
      nav.innerHTML = TABS.map(([k, label]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === currentTab}">${label}<b>${groups[k].length}</b></button>`).join('');
      nav.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { currentTab = b.dataset.tab; draw(); }; });
      const shown = groups[currentTab];
      list.innerHTML = (currentTab === 'CANCEL' ? POLICY_NOTE : currentTab === 'TRACK' ? '<p class="acct-info" style="margin:0;font-size:13px">Every step of your orders, updated live as the artist, our framer and the courier move it on. Open <b>Orders</b> for invoices, address and requests.</p>' : '') + (shown.length ? shown.map(currentTab === 'TRACK' ? trackCard : card).join('')
        : `<p class="acct-info">${currentTab === 'ORDERS' ? 'No orders yet. Once you pay for an enquiry it moves here.' : currentTab === 'ENQ' ? 'No open enquiries.' : currentTab === 'TRACK' ? 'Nothing in progress right now.' : 'No cancellations or refunds.'}</p>`);
      list.querySelectorAll('.acct-terms').forEach((a) => { a.onclick = () => close(); });
      wireRate(list, items);
      wireRequests(list, items);
      wireAddress(list, items);
      wireCodes(list);
      wirePoints();
    };
    draw();
    wireRedeem(items);
    showCircle(items);
  } catch (ex) {
    list.textContent = 'We could not load your enquiries and orders. ' + friendly(ex);
  }
}

/* ---------- session ---------- */
async function loadUser() {
  try {
    state.user = await getCurrentUser();
    const attrs = await fetchUserAttributes();
    state.email = attrs.email || state.user.signInDetails?.loginId || '';
  } catch {
    state.user = null; state.email = '';
  }
  setButton();
}
Hub.listen('auth', ({ payload }) => {
  if (payload.event === 'signedIn') loadUser();
  if (payload.event === 'signedOut') { state.user = null; setButton(); }
});
loadUser().then(async () => {
  // Links in our emails: art.pranixtechno.com/#my-enquiries opens the panel (sign-in first if needed).
  const qp = new URLSearchParams(location.search);
  // QR on a gift card / voucher: art.pranixtechno.com/#redeem=GIFT-XXXX-XXXX → the code waits in My enquiries & orders.
  const rd = location.hash.match(/^#redeem=([A-Za-z0-9-]{4,30})$/);
  if (rd) {
    try { localStorage.setItem(PENDING, rd[1].toUpperCase()); } catch { /* */ }
    try { history.replaceState(null, '', location.pathname + '#my-enquiries'); } catch { /* */ }
    if (state.user) await showList(); else showSignIn('Sign in (or create an account) to use your gift card or code.');
    open();
    return;
  }
  if (location.hash === "#my-enquiries") {
    if (state.user) {
      await showList();
      const paid = qp.get('paid'), fail = qp.get('payfail');
      if (paid) body.insertAdjacentHTML('afterbegin', `<p class="enq-msg" style="margin:0;border-left-color:var(--ok)">Thank you! We have received your payment for <b>${esc(paid)}</b>. It shows as <b>Paid</b> here within a minute, and we email your confirmation.</p>`);
      if (fail) body.insertAdjacentHTML('afterbegin', `<p class="enq-msg" style="margin:0;border-left-color:var(--kumkum)">The payment for <b>${esc(fail)}</b> did not go through. Nothing was charged; tap <b>Pay now</b> to try again, or contact us on WhatsApp.</p>`);
      if (paid || fail) try { history.replaceState(null, '', location.pathname + '#my-enquiries'); } catch { /* ignore */ }
    } else showSignIn();
    open();
  }
});

/* ---------- save an enquiry (called by the site's forms) ---------- */
const safeName = (n) => String(n || 'file').replace(/[^\w.\-]+/g, '_').slice(-60);
async function save({ ref, subject, fields, files }) {
  let fileKey = null;
  const file = (files || []).map((x) => x[1]).find(Boolean);
  if (file) {
    const res = await uploadData({
      path: ({ identityId }) => `uploads/${identityId}/${ref}-${safeName(file.name)}`,
      data: file,
      options: { contentType: file.type || 'application/octet-stream' },
    }).result;
    fileKey = res.path;
  }
  const kind = subject.startsWith('Price') || subject.startsWith('Artwork order') ? 'PRICE' : subject.startsWith('Commission') ? 'COMMISSION' : subject.startsWith('Photo framing') ? 'PHOTO' : 'GIFT';
  const title = kind === 'PRICE' ? (fields['Artwork'] || 'Price enquiry').split(' (')[0]
    : kind === 'COMMISSION' ? `Commission: ${fields['Subject'] || ''} (${fields['Style'] || ''})`
    : kind === 'PHOTO' ? `Framed print: ${fields['Print'] || 'photo'} (${String(fields['Size'] || '').split(' (')[0]})`
    : `Little Artists gift for ${fields['Gift for'] || ''}`;
  const { errors } = await client.models.Enquiry.create({
    ref, kind, title,
    details: JSON.stringify(fields),
    customerName: fields['Name'] || fields['Parent'] || '',
    phone: fields['Mobile'] || '',
    email: state.email,
    fileKey,
  });
  if (errors?.length) throw new Error(errors[0].message);
}


/* ---------- Crafts shop: order an item (signed in; the price comes from the listing on the server) ---------- */
let pendingOrder = null;
function afterSignIn() { if (pendingCart) { pendingCart = false; showList(); window.kalaiCart?.open(); return; } if (pendingLicence) { const pl = pendingLicence; pendingLicence = null; buyLicence(pl); return; } if (pendingOrder) { const p = pendingOrder; pendingOrder = null; showOrder(p); } else showList(); }
let lastAddr = null;
async function showOrder(p) {
  title.textContent = 'Order';
  const max = Math.max(1, Math.min(10, Number(p.stock) || 1));
  // Reuse the last delivery address the customer gave us, if any.
  if (!lastAddr) {
    try {
      const r = await client.models.Enquiry.list({ limit: 100 });
      const withAddr = (r.data || []).filter((x) => x.deliveryAddress && (!x.email || !state.email || x.email === state.email)).sort((a, b) => String(b.addressAt || '').localeCompare(String(a.addressAt || '')))[0];
      lastAddr = withAddr ? { name: withAddr.deliveryName, phone: withAddr.deliveryPhone, country: withAddr.deliveryCountry || 'UAE', emirate: withAddr.deliveryEmirate, pin: withAddr.deliveryPin, address: withAddr.deliveryAddress, landmark: withAddr.deliveryLandmark } : {};
    } catch { lastAddr = {}; }
  }
  const a = lastAddr || {};
  const f = form(`
    <div style="display:grid;grid-template-columns:72px 1fr;gap:12px;align-items:center">${p.img ? `<img src="${esc(p.img)}" alt="" style="width:72px;height:72px;object-fit:cover;border-radius:4px">` : '<span></span>'}
      <div><b>${esc(p.title)}</b><div class="acct-info">by ${esc(p.seller)} · ⃃ ${Number(p.price).toLocaleString('en-US')} each, delivery within the UAE included</div></div></div>
    <form novalidate>
      <div class="field"><label for="moQty">Quantity</label><select id="moQty" name="qty">${Array.from({ length: max }, (_, i) => `<option>${i + 1}</option>`).join('')}</select></div>
      <div class="field"><label for="moName">Receiver's name</label><input id="moName" name="name" autocomplete="name" value="${esc(a.name)}"></div>
      <div class="field"><label for="moPhone">Receiver's mobile</label><input id="moPhone" name="phone" type="tel" inputmode="tel" autocomplete="tel" value="${esc(a.phone)}"></div>
      ${countryRegionHtml({ country: a.country || 'UAE', region: a.emirate, pin: a.pin, prefix: 'mo' })}
      <p class="acct-info" id="moIndia" style="margin:0;font-size:12px" hidden>Delivery outside the UAE: we confirm the shipping charge with your payment link, before you pay.</p>
      <div class="field"><label for="moAddr">Address</label><textarea id="moAddr" name="address" rows="2" placeholder="Villa / flat no., building, street, area" autocomplete="street-address">${esc(a.address)}</textarea></div>
      <div class="field"><label for="moLand">Landmark (optional)</label><input id="moLand" name="landmark" value="${esc(a.landmark)}"></div>
      <div class="field"><label for="moNote">Note to the maker (optional)</label><input id="moNote" name="note" maxlength="300"></div>
      <div class="field"><label for="moCode">Discount code (optional)</label><input id="moCode" name="code" maxlength="30" style="text-transform:uppercase" placeholder="e.g. DIWALI10"></div>
      <div class="enq-msg" id="moTotal"></div>
      <p class="acct-info" style="margin:0;font-size:12px">You pay Kalai Art House by a secure link we send you; the order is confirmed once paid. Until it is dispatched you can cancel for a full refund. By ordering you agree to our <a href="#terms" class="acct-terms" style="color:var(--kumkum)">terms</a>.</p>
      <div class="acct-err" role="alert"></div>
      <button class="btn primary" type="submit">Place order</button>
    </form>
    <button class="acct-link" id="moBack">Back to My enquiries &amp; orders</button>`,
  async (fd) => {
    const data = Object.fromEntries(['qty', 'name', 'phone', 'country', 'emirate', 'pin', 'address', 'landmark', 'note', 'code'].map((k) => [k, String(fd.get(k) || '').trim()]));
    const r = await client.mutations.marketOrder({ data: JSON.stringify({ listingId: p.id, ...data }) });
    if (r.errors?.length) throw new Error(r.errors[0].message.replace(/^.*?Error: /, ''));
    const out = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    lastAddr = { name: data.name, phone: data.phone, country: data.country, emirate: data.emirate, pin: data.pin, address: data.address, landmark: data.landmark };
    currentTab = 'ENQ';
    await showList();
    body.insertAdjacentHTML('afterbegin', `<p class="enq-msg" style="margin:0">Order <b>${esc(out.ref)}</b> placed: ⃃ ${Number(out.total).toLocaleString('en-US')}${data.code ? ` (code ${esc(data.code.toUpperCase())} applied)` : ''}. We'll email you a secure payment link shortly.</p>`);
  });
  const total = () => { body.querySelector('#moTotal').innerHTML = `Total: <b>⃃ ${(Number(p.price) * Number(f.qty.value)).toLocaleString('en-US')}</b>`; };
  f.qty.onchange = total; total();
  wireRegion(f);
  const india = () => { body.querySelector('#moIndia').hidden = f.country.value === 'UAE'; };
  f.country.addEventListener('change', india); india();
  body.querySelector('#moBack').onclick = showList;
  if (!a.name) f.name.focus();
}
window.kalaiMarketOrder = (p) => {
  if (window.kalaiCart && Number(p.price) > 0) { window.kalaiCart.add({ t: 'CRAFT', listingId: p.id, name: p.title, img: p.img, maker: p.seller, unit: Number(p.price), qty: 1, max: Number(p.stock) || 1, price: Number(p.price), sub: `${p.seller ? `by ${p.seller} · ` : ''}qty 1` }, true); return; }
  if (state.user) { showOrder(p); open(); return; }
  pendingOrder = p;
  showSignIn('Sign in or create a free account to order, so you can pay securely and follow the delivery.');
  open();
};


/* ---------- Cart: collection paintings, framed prints, Crafts shop, Little Artists gifts → one checkout, one payment ---------- */
// Kept in this browser (localStorage). Prices shown here are the website's; the server works them out again at checkout.
const CART_KEY = 'kalai-cart3';
let pendingCart = false;
const cartGet = () => { try { const v = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const cartSet = (v) => { try { localStorage.setItem(CART_KEY, JSON.stringify(v)); } catch { /* private mode */ } cartBadge(); };
const money = (n) => (typeof moneyH === 'function' ? moneyH(Number(n)) : `⃃ ${Number(n).toLocaleString('en-US')}`); // eslint-disable-line no-undef
function cartBadge() {
  const b = document.getElementById('openCart'), n = cartGet().reduce((a, i) => a + (Number(i.qty) || 1), 0);
  if (!b) return;
  b.hidden = false; // always there, like any shop
  const c = document.getElementById('cartCount'); if (c) c.textContent = String(n);
}
const lineTotal = (i) => Number(i.price || 0) * (i.t === 'CRAFT' || i.t === 'PRINT' ? 1 : 1);
let cartStep = 'items';
let cartPreview = null;
function cartDrawer() {
  const drawer = document.getElementById('drawer'), sc = document.getElementById('scrim');
  if (!drawer) return;
  drawer.hidden = false; if (sc) sc.hidden = false;
  drawCartUi();
}
function drawCartUi() {
  const b = document.getElementById('cartBody'), t = document.getElementById('totals');
  if (!b || !t) return;
  const items = cartGet();
  const h2 = document.querySelector('#drawer header h2'), units = items.reduce((a, i) => a + (Number(i.qty) || 1), 0);
  if (h2) h2.textContent = units ? `Your cart · ${units} item${units > 1 ? 's' : ''}` : 'Your cart';
  if (!items.length) { b.innerHTML = '<div class="empty">Your cart is empty.<br>Add a painting, a framed print, a Crafts shop item or a Little Artists gift.</div>'; t.innerHTML = ''; cartStep = 'items'; return; }
  b.innerHTML = items.map((i, n) => `<div class="line" style="display:grid;grid-template-columns:64px 1fr auto;gap:10px;align-items:start">
      ${i.img ? `<img src="${esc(i.img)}" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:4px">` : '<span style="width:64px;height:64px;display:grid;place-items:center;background:#0001;border-radius:4px">🎨</span>'}
      <div><div class="t" style="font-weight:600">${esc(i.name)}</div><div class="s" style="font-size:12px;color:var(--muted)">${esc(i.sub || '')}</div>
        ${i.t === 'CRAFT' || i.t === 'PRINT' ? `<label style="font-size:12px">Qty <select data-cq="${n}">${Array.from({ length: i.t === 'PRINT' ? 5 : Math.max(1, Math.min(10, Number(i.max) || 1)) }, (_, k) => `<option ${k + 1 === Number(i.qty || 1) ? 'selected' : ''}>${k + 1}</option>`).join('')}</select></label> ` : ''}
        <button class="rm" type="button" data-crm="${n}" style="background:none;border:0;padding:0;color:var(--kumkum);font-size:12px;cursor:pointer">Remove</button></div>
      <div class="price" style="font-family:var(--mono)">${money(lineTotal(i))}${i.quote ? '<div style="font-size:11px;color:var(--muted)">+ shipping</div>' : ''}</div></div>`).join('');
  b.querySelectorAll('[data-crm]').forEach((x) => { x.onclick = () => { const v = cartGet(); v.splice(Number(x.dataset.crm), 1); cartSet(v); cartPreview = null; drawCartUi(); }; });
  b.querySelectorAll('[data-cq]').forEach((x) => { x.onchange = () => { const v = cartGet(), it = v[Number(x.dataset.cq)]; const unit = Number(it.unit) || Number(it.price) / (Number(it.qty) || 1); it.qty = Number(x.value); it.unit = unit; it.price = Math.round(unit * it.qty * 100) / 100; if (it.t === 'CRAFT') it.sub = `${it.maker ? `by ${it.maker} · ` : ''}qty ${it.qty}`; else it.sub = String(it.sub || '').replace(/ · \d+ copies$/, '') + (it.qty > 1 ? ` · ${it.qty} copies` : ''); cartSet(v); cartPreview = null; drawCartUi(); }; });
  const sub = items.reduce((a, i) => a + lineTotal(i), 0);
  const gifts = items.every((i) => i.t === 'GIFT');
  if (cartStep === 'items' || !state.user) {
    t.innerHTML = `<div class="r" style="display:flex;justify-content:space-between"><span>Subtotal</span><span class="mono">${money(sub)}</span></div>
      <div class="r note" style="display:flex;justify-content:space-between;font-size:13px"><span>Delivery in the UAE</span><span>Included</span></div>
      <p class="note" style="font-size:12px;margin:4px 0">Gift card, voucher or offer code? Add it at checkout. Outside the UAE we add the shipping before you pay.</p>
      <button class="btn primary" type="button" id="cartGo" style="width:100%">Checkout</button>
      <button class="btn ghost-dark" type="button" id="cartMore" style="width:100%;margin-top:6px">Continue shopping</button>`;
    t.querySelector('#cartMore').onclick = () => { document.getElementById('drawer').hidden = true; document.getElementById('scrim').hidden = true; };
    t.querySelector('#cartGo').onclick = () => {
      if (!state.user) { pendingCart = true; document.getElementById('drawer').hidden = true; showSignIn('Sign in or create a free account to check out: you pay securely and can follow each item.'); open(); return; }
      cartStep = 'checkout'; drawCartUi();
    };
    return;
  }
  const a = lastAddr || {};
  t.innerHTML = '';
  b.innerHTML = `<div style="font-size:13px;color:var(--muted)">${items.length} item${items.length > 1 ? 's' : ''} · ${money(sub)}</div><form id="coForm" novalidate style="display:grid;gap:8px">
      <b style="font-size:15px">${gifts ? 'Your details' : 'Delivery address'}</b>
      <input name="name" placeholder="${gifts ? 'Your name' : "Receiver's name"}" autocomplete="name" value="${esc(a.name)}" aria-label="Name">
      <input name="phone" type="tel" inputmode="tel" placeholder="Mobile, e.g. +971 50 123 4567" autocomplete="tel" value="${esc(a.phone)}" aria-label="Mobile">
      ${gifts ? '<p class="note" style="font-size:12px;margin:0">The gift goes to the address you gave with it.</p>' : `${countryRegionHtml({ country: a.country || 'UAE', region: a.emirate, pin: a.pin, prefix: 'co' })}
      <textarea name="address" rows="2" placeholder="Villa / flat no., building, street, area" autocomplete="street-address" aria-label="Address">${esc(a.address)}</textarea>
      <input name="landmark" placeholder="Landmark (optional)" value="${esc(a.landmark)}" aria-label="Landmark">`}
      <input name="note" maxlength="300" placeholder="Note for us (optional)" aria-label="Note">
      <div style="display:flex;gap:6px"><input name="code" maxlength="30" placeholder="Gift card, voucher or offer code" style="text-transform:uppercase;flex:1" aria-label="Code"><button class="btn ghost-dark" type="button" id="coApply">Apply</button></div>
      <div id="coSum" style="font-size:14px"></div>
      <p class="note" style="font-size:12px;margin:0">By paying you agree to our <a href="#terms" style="color:var(--kumkum)">terms</a>, including the cancellation policy. Each item is prepared on its own and may arrive separately.</p>
      <div class="acct-err" id="coErr" role="alert" style="color:var(--kumkum);font-size:13px"></div>
      <button class="btn primary" type="submit" id="coPay">Review total</button>
      <button class="acct-link" type="button" id="coBack">← Back to the cart</button></form>`;
  const f = b.querySelector('#coForm');
  if (!gifts) wireRegion(f);
  if (cartPreview?.code) f.code.value = cartPreview.code;
  b.querySelector('#coBack').onclick = () => { cartStep = 'items'; cartPreview = null; drawCartUi(); };
  const payload = (dry) => {
    const g = (k) => String(f[k]?.value || '').trim();
    return { dry, items: cartGet().map(({ img, sub: _s, ...rest }) => rest), code: g('code'), note: g('note'),
      address: { name: g('name'), phone: g('phone'), country: g('country') || 'UAE', emirate: g('emirate'), pin: g('pin'), address: g('address'), landmark: g('landmark') } };
  };
  const err = b.querySelector('#coErr'), sum = b.querySelector('#coSum'), pay = b.querySelector('#coPay');
  const call = async (dry) => {
    err.textContent = ''; pay.disabled = true;
    try {
      const r = await client.mutations.basketCheckout({ data: JSON.stringify(payload(dry)) });
      if (r.errors?.length) throw new Error(r.errors[0].message.replace(/^.*?Error: /, ''));
      return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    } catch (ex) { err.textContent = ex.message || 'Something went wrong.'; return null; } finally { pay.disabled = false; }
  };
  const showSum = (p) => {
    cartPreview = { ...p, code: f.code.value.trim().toUpperCase() };
    sum.innerHTML = `${p.lines.map((l) => `<div style="display:flex;justify-content:space-between;gap:8px"><span>${esc(l.title)}</span><span class="mono">${l.discount ? `<s style="color:var(--muted)">${money(l.list)}</s> ` : ''}${money(l.price)}</span></div>`).join('')}
      ${p.discountLabel ? `<div style="color:var(--ok)">${esc(p.discountLabel)}: − ${money(p.discount)}</div>` : ''}
      <div style="display:flex;justify-content:space-between;font-weight:700;font-size:16px;border-top:1px solid var(--line);padding-top:4px;margin-top:4px"><span>Total</span><span class="mono">${money(p.total)}</span></div>
      ${p.quote ? '<div class="note" style="font-size:12px">Shipping is added by us before you pay: we email you the payment link.</div>' : '<div class="note" style="font-size:12px">Includes delivery in the UAE. Paid in dirhams by card, Apple Pay or Google Pay (Ziina).</div>'}`;
    pay.innerHTML = p.quote ? 'Place order' : `Pay ${money(p.total)} securely`;
  };
  const review = async () => { const p = await call(true); if (p) showSum(p); return p; };
  b.querySelector('#coApply').onclick = review;
  f.code.addEventListener('change', () => { cartPreview = null; pay.textContent = 'Review total'; });
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    if (!cartPreview || cartPreview.code !== f.code.value.trim().toUpperCase()) { await review(); return; }
    pay.textContent = 'One moment…';
    const r = await call(false);
    if (!r) { pay.textContent = 'Try again'; return; }
    const g = (k) => String(f[k]?.value || '').trim();
    if (!gifts) lastAddr = { name: g('name'), phone: g('phone'), country: g('country'), emirate: g('emirate'), pin: g('pin'), address: g('address'), landmark: g('landmark') };
    cartSet([]); cartStep = 'items'; cartPreview = null;
    if (r.payUrl) { location.href = r.payUrl; return; }
    document.getElementById('drawer').hidden = true;
    await showList(); open();
    body.insertAdjacentHTML('afterbegin', `<p class="enq-msg" style="margin:0">Thank you! Order <b>${esc(r.basketRef)}</b> placed (${r.refs.length} item${r.refs.length > 1 ? 's' : ''}, ${money(r.total)}). ${r.quote ? "We'll add the shipping and email you the payment link." : "We'll email you the payment link shortly."}</p>`);
  };
  if (cartPreview) showSum(cartPreview); else review();
}
window.kalaiCart = {
  add(item, buyNow = false) {
    const v = cartGet();
    if (item.t === 'ART' && v.some((x) => x.t === 'ART' && x.pid === item.pid)) { toastMsg('Already in your cart. Each work is one of a kind.'); if (buyNow) cartDrawer(); return; }
    if (item.t === 'CRAFT') { const same = v.find((x) => x.t === 'CRAFT' && x.listingId === item.listingId); if (same) { same.qty = Math.min(Number(same.max) || 10, Number(same.qty) + 1); same.price = same.unit * same.qty; same.sub = `${same.maker ? `by ${same.maker} · ` : ''}qty ${same.qty}`; cartSet(v); toastMsg('Added to cart'); if (buyNow) cartDrawer(); return; } }
    v.push(item); cartSet(v); cartPreview = null;
    toastMsg(`Added to cart: ${item.name}`);
    if (buyNow) cartDrawer();
  },
  /** Little Artists: the drawing is uploaded now (signed in), then the gift waits in the cart. */
  async addGift(f, file, price, quote) {
    const res = await uploadData({ path: ({ identityId }) => `uploads/${identityId}/gift-${Date.now()}-${safeName(file.name)}`, data: file, options: { contentType: file.type || 'image/jpeg' } }).result;
    this.add({ t: 'GIFT', name: `Little Artists gift for ${f.to}`, sub: `${f.child}, age ${f.age} · ${f.country === 'UAE' ? f.emirate : f.country}`, f, fileKey: res.path, price, quote }, true);
  },
  open: cartDrawer,
  count: () => cartGet().length,
};
document.getElementById('openCart')?.addEventListener('click', (e) => { e.stopImmediatePropagation(); cartStep = 'items'; cartDrawer(); }, true);
cartBadge();

/* ---------- daily message: small notice at the side of the page, Tamil / English / Arabic ---------- */
const MSG_TITLE = { ta: 'இன்றைய செய்தி', en: "Today's message", ar: 'رسالة اليوم' };
const KURAL_TITLE = { ta: 'இன்றைய திருக்குறள்', en: 'Thirukkural of the day', ar: 'حكمة اليوم من الثيروكورال',
  hi: 'आज का तिरुक्कुरल', ml: 'ഇന്നത്തെ തിരുക്കുറൾ', ur: 'آج کا تروکورل', tl: 'Thirukkural ngayong araw', bn: 'আজকের তিরুক্কুরল',
  te: 'నేటి తిరుక్కురళ్', kn: 'ಇಂದಿನ ತಿರುಕ್ಕುರಳ್', ru: 'Тируккурал дня', fr: 'Le Thirukkural du jour', zh: '今日蒂鲁古拉尔',
  mr: 'आजचे तिरुक्कुरल', gu: 'આજનું તિરુક્કુરલ', pa: 'ਅੱਜ ਦਾ ਤਿਰੁੱਕੁਰਲ', si: 'අද දින තිරුක්කුරල්', ne: 'आजको तिरुक्कुरल', fa: 'تیروکورال امروز',
  de: 'Thirukkural des Tages', es: 'Thirukkural del día', it: 'Il Thirukkural del giorno', pt: 'Thirukkural do dia', tr: 'Günün Thirukkural’ı',
  ja: '今日のティルックラル', ko: '오늘의 티루쿠랄', id: 'Thirukkural hari ini', ms: 'Thirukkural hari ini' };
const RTL = ['ar', 'ur', 'fa', 'fa-AF', 'he', 'ps'];
// The visitor's own language (browser setting), if the kural has it; ?klang=hi to preview one.
function visitorLang(have) {
  let picked = ''; try { picked = localStorage.getItem('kalai-klang') || ''; } catch { picked = ''; }
  if (picked === 'none') return '';
  const q = new URLSearchParams(location.search).get('klang') || picked;
  const keys = Object.keys(have).filter((k) => k !== '_h'), byLower = Object.fromEntries(keys.map((k) => [k.toLowerCase(), k]));
  const alias = { fil: 'tl', iw: 'he', nb: 'no', nn: 'no', 'zh-hk': 'zh-TW', 'zh-mo': 'zh-TW', 'zh-hant': 'zh-TW', 'es-419': 'es-MX', 'pt-br': 'pt', 'fa-af': 'fa-AF', prs: 'fa-AF' };
  const list = [q, ...(navigator.languages || [navigator.language || ''])].filter(Boolean).map((x) => String(x).toLowerCase());
  for (const x of list) {
    const base = x.split('-')[0];
    if (['ta', 'en', 'ar'].includes(base)) return '';
    const l = byLower[x] || byLower[alias[x]?.toLowerCase()] || byLower[alias[base]?.toLowerCase()] || (x.startsWith('zh-') && x.includes('tw') ? byLower['zh-tw'] : '') || byLower[base];
    if (l) return l;
  }
  return '';
}
const LANG_LABEL = { ta: 'தமிழ்', en: 'English', ar: 'العربية' };
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
async function showDailyMessage() {
  try {
    const nowIso = new Date().toISOString();
    // Today's kural (Dubai date), else yesterday's: read directly by id, so the list size never matters.
    const day = (ms) => new Date(ms + 4 * 3600_000).toISOString().slice(0, 10);
    let r = { data: [] };
    for (const d of [day(Date.now()), day(Date.now() - 86_400_000), day(Date.now() - 2 * 86_400_000)]) {
      const g = await client.models.Announcement.get({ id: `kural-${d}` }, { authMode: 'apiKey' }).catch(() => null);
      if (g?.data) { r = { data: [g.data] }; break; }
    }
    // The card shows only the Thirukkural (published 06:05 Dubai each morning). Before today's is out
    // (midnight to 06:05) it keeps showing the latest one. Hand-written messages are not shown here.
    const kurals = (r.data || []).filter((x) => x.source === 'KURAL').sort((a, b) => String(b.showFrom || b.createdAt).localeCompare(String(a.showFrom || a.createdAt)));
    const m = kurals.find((x) => x.active && (!x.showFrom || x.showFrom <= nowIso) && (!x.showUntil || x.showUntil > nowIso)) || kurals[0];
    if (!m) return;
    // Tamil and English always shown; below them the other languages take turns (the visitor's own one first, then Arabic,
    // then the rest). A language picked under "Other languages" stays put instead of turning (remembered on this device).
    let extra = {}; try { extra = JSON.parse(m.more || '{}') || {}; } catch { extra = {}; }
    if ((m.ar || '').trim()) extra.ar = m.ar;
    const own = visitorLang(extra);
    const strip = (t) => String(t || '').replace(/\n—[^\n]*$/, '').trim();
    const native = (l) => { try { return new Intl.DisplayNames([l], { type: 'language' }).of(l) || l; } catch { return l; } };
    const others = Object.keys(extra).filter((l) => l !== '_h' && extra[l]).map((l) => [l, native(l)]).sort((a, b) => a[1].localeCompare(b[1]));
    const turn = [...new Set([own, 'ar', ...others.map((x) => x[0])].filter((l) => l && extra[l]))];
    let fixed = ''; try { fixed = localStorage.getItem('kalai-klang') || ''; } catch { fixed = ''; }
    if (!extra[fixed]) fixed = '';
    if (!(m.ta || '').trim() && !(m.en || '').trim()) return;
    document.head.insertAdjacentHTML('beforeend', `<style>
.kmsg{position:fixed;right:12px;bottom:12px;z-index:30;text-align:center;width:min(250px,calc(100vw - 24px));background:var(--surface);color:var(--fg);border:1px solid var(--gold);border-left:4px solid var(--gold);border-radius:var(--r);box-shadow:0 10px 30px rgba(0,0,0,.18);padding:7px 9px;display:grid;gap:4px;animation:kmsgIn .35s ease-out}
@keyframes kmsgIn{from{transform:translateY(12px);opacity:0}to{transform:none;opacity:1}}
.kmsg-img{display:flex;justify-content:center;margin-top:-2px}
.kmsg-img img{width:34px;height:34px;border-radius:50%;object-fit:cover;border:2px solid var(--gold);background:#f7e7c1}
.kmsg-head b{display:block;font-size:10px;letter-spacing:.04em;color:var(--gold)}.kmsg-head small{display:block;font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.kmsg-x{position:absolute;top:4px;right:5px;background:none;border:0;color:var(--muted);font-size:14px;line-height:1;cursor:pointer;padding:0 2px}
.kmsg p{margin:0;font-size:11px;line-height:1.45;white-space:pre-line}
.kmsg .k-en{font-size:10.5px;color:var(--muted);font-style:italic}
.kmsg-rot{border-top:1px solid var(--line);padding-top:4px;display:grid;gap:2px;transition:opacity .4s}.kmsg-rot.fade{opacity:0}
.kmsg-rot span{font-size:9px;color:var(--gold);letter-spacing:.04em}.kmsg-rot p{font-size:10.5px;min-height:3em}
.kmsg-bar{height:2px;background:var(--line);border-radius:2px;overflow:hidden}.kmsg-bar i{display:block;height:100%;width:0;background:var(--gold)}
.kmsg-bar i.run{animation:kmsgBar 10s linear forwards}@keyframes kmsgBar{to{width:100%}}
.kmsg-more{background:none;border:0;color:var(--muted);font:inherit;font-size:10px;cursor:pointer;padding:0;text-decoration:underline}
.kmsg-pick{font:inherit;font-size:11px;padding:2px 4px;width:100%}
.kmsg-tab{position:fixed;right:12px;bottom:12px;z-index:30;border:1px solid var(--gold);background:var(--surface);color:var(--fg);border-radius:999px;padding:4px 9px;font:inherit;font-size:11px;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.15)}
@media (prefers-reduced-motion:reduce){.kmsg{animation:none}.kmsg-rot{transition:none}}
</style>`);
    const box = document.createElement('aside');
    box.className = 'kmsg'; box.setAttribute('aria-label', 'Thirukkural of the day'); box.lang = 'ta'; box.dataset.notranslate = ''; // has its own languages
    const tab = document.createElement('button');
    tab.dataset.notranslate = ''; tab.className = 'kmsg-tab'; tab.type = 'button'; tab.hidden = true; tab.textContent = `📜 ${KURAL_TITLE.ta}`;
    document.body.append(box, tab);
    // Thiruvalluvar picture: the one uploaded in Order Management → Messages, else our emblem.
    let picture = '/valluvar.svg';
    try { picture = (await getUrl({ path: 'catalogue/site/thiruvalluvar.jpg', options: { expiresIn: 3600, validateObjectExistence: true } })).url.toString(); } catch { picture = '/valluvar.svg'; }
    box.innerHTML = `<div class="kmsg-img"><img alt="Thiruvalluvar" src="${esc(picture)}" onerror="this.onerror=null;this.src='/valluvar.svg'"></div>
      <div class="kmsg-head"><b>${esc(KURAL_TITLE.ta)}</b><small lang="en">${esc(KURAL_TITLE.en)}</small><button class="kmsg-x" type="button" aria-label="Close">×</button></div>
      ${(m.ta || '').trim() ? `<p class="k-ta">${esc(m.ta)}</p>` : ''}
      ${(m.en || '').trim() ? `<p class="k-en" lang="en">${esc(strip(m.en))}</p>` : ''}
      ${turn.length ? `<div class="kmsg-rot"><span></span><p></p></div><div class="kmsg-bar" aria-hidden="true"><i></i></div>` : ''}
      ${others.length ? `<button type="button" class="kmsg-more">🌐 Other languages</button><select class="kmsg-pick" aria-label="Choose your language" hidden><option value="">🌐 All languages, taking turns</option>${others.map(([l, n]) => `<option value="${esc(l)}" ${l === fixed ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>` : ''}`;
    const rot = box.querySelector('.kmsg-rot'), bar = box.querySelector('.kmsg-bar i');
    let lang = fixed || turn[0] || '';
    let paused = false, timer = null;
    const show = (l, fade = true) => {
      if (!rot || !l) return;
      lang = l;
      const put = () => {
        const rp = rot.querySelector('p'), rtl = RTL.includes(l);
        rot.lang = l; rp.dir = rtl ? 'rtl' : 'ltr'; rp.style.textAlign = rtl ? 'right' : '';
        rot.querySelector('span').textContent = native(l);
        rp.textContent = strip(extra[l]);
        rot.classList.remove('fade');
        const moving = !fixed && turn.length > 1 && kuralSec > 0;
        if (bar) { bar.classList.remove('run'); bar.style.animationDuration = `${kuralSec || 10}s`; bar.parentElement.hidden = !moving; void bar.offsetWidth; if (!paused && moving) bar.classList.add('run'); }
      };
      if (fade) { rot.classList.add('fade'); setTimeout(put, 400); } else put();
    };
    const next = () => show(turn[(turn.indexOf(lang) + 1) % turn.length]);
    // Every few seconds (Settings → kural seconds) the next language; paused while hovered, closed or a language is picked.
    const restart = () => { clearInterval(timer); if (!fixed && turn.length > 1 && kuralSec > 0) timer = setInterval(() => { if (!paused && !box.hidden) next(); }, kuralSec * 1000); };
    window.kalaiKuralRestart = restart;
    box.addEventListener('mouseenter', () => { paused = true; bar?.classList.remove('run'); });
    box.addEventListener('mouseleave', () => { paused = false; restart(); if (bar && !fixed) { void bar.offsetWidth; bar.classList.add('run'); } });
    if (rot) { rot.style.cursor = 'pointer'; rot.title = 'Next language'; rot.onclick = () => { if (!fixed) { next(); restart(); } }; }
    box.querySelector('.kmsg-x').onclick = () => { box.hidden = true; tab.hidden = false; clearInterval(timer); lsSet('kalai-msg-closed', m.id); };
    tab.onclick = () => { box.hidden = false; tab.hidden = true; lsSet('kalai-msg-closed', ''); show(lang, false); restart(); };
    // On an artwork page the card would cover the buttons: fold it into the small tab while the page is open.
    const modal = document.getElementById('modal');
    let autoFolded = false;
    if (modal) new MutationObserver(() => {
      if (!modal.hidden && !box.hidden) { box.hidden = true; tab.hidden = false; autoFolded = true; }
      else if (modal.hidden && autoFolded) { autoFolded = false; box.hidden = false; tab.hidden = true; show(lang, false); restart(); }
    }).observe(modal, { attributes: true, attributeFilter: ['hidden'] });
    const more = box.querySelector('.kmsg-more'), pick = box.querySelector('.kmsg-pick');
    if (more) {
      more.onclick = () => { more.hidden = true; pick.hidden = false; pick.focus(); };
      pick.onchange = () => {
        fixed = pick.value;
        try { localStorage.setItem('kalai-klang', fixed); } catch { /* private window */ }
        show(fixed || turn[0]); restart();
      };
    }
    show(lang, false);
    restart();
    // Closed this same message before: keep it as the small tab.
    if (lsGet('kalai-msg-closed') === m.id) { box.hidden = true; tab.hidden = false; clearInterval(timer); }
  } catch { /* no message */ }
}
showDailyMessage();

/* ---------- website collection from the Catalogue (public, read-only) ---------- */
async function showCatalogue() {
  if (typeof window.kalaiShowCatalogue !== 'function') return;
  try {
    const all = [];
    let nextToken = null;
    do {
      const r = await client.models.Product.list({ authMode: 'apiKey', limit: 500, nextToken });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      all.push(...r.data);
      nextToken = r.nextToken;
    } while (nextToken);
    const nowIso = new Date().toISOString();
    const live = all
      .filter((p) => ['PUBLISHED', 'SOLD'].includes(p.status) && (!p.publishAt || p.publishAt <= nowIso) && p.imageKey)
      .sort((a, b) => (a.status === 'SOLD') - (b.status === 'SOLD') || String(b.publishAt).localeCompare(String(a.publishAt)) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    if (!live.length) return;
    const list = await Promise.all(live.map(async (p) => {
      let img = '';
      try { img = (await getUrl({ path: p.imageKey, options: { expiresIn: 3600 } })).url.toString(); } catch { /* no photo */ }
      if (p.kind === 'photo') return { id: p.id, print: true, name: p.named ? p.title : cleanTitle(p.title), code: p.code || '', desc: p.description || '', img };
      return { id: p.id, kind: p.kind === 'sketch' ? 'sketch' : 'water', subject: p.subject, name: p.named ? p.title : cleanTitle(p.title), untitled: !p.named && cleanTitle(p.title) === 'Original', code: p.code || '', size: p.size || '', medium: p.medium || (p.kind === 'sketch' ? 'Graphite on paper' : 'Watercolour on paper'), price: 1, ai: !!p.aiPreview, leadDays: p.leadDays ?? null, leadMax: p.leadMax ?? p.leadDays ?? null, prices: (() => { try { return p.priceMatrix ? JSON.parse(p.priceMatrix) : null; } catch { return null; } })(), sold: p.status === 'SOLD', ship: 'Original · ready to ship', desc: p.description || '', img, ...(p.artist ? { artist: p.artist } : {}), ...(p.printable ? { printable: true, printMax: p.printMax || 'A3', printRoyalty: Number(p.printRoyalty || 0) } : {}), ...(p.licensable && p.printKey ? { licensable: true, fileW: p.printW || null, fileH: p.printH || null } : {}), ...(p.printable ? { printFrom: true } : {}) };
    }));
    // Framed prints (Catalogue type "Framed print") have their own section; paintings go to the collection.
    // Framed Prints: our photos, then paintings with prints switched on (Catalogue → Sell framed prints).
    window.kalaiShowPrints?.([...list.filter((x) => x.img && x.print), ...list.filter((x) => x.img && x.printable).map((x) => ({ id: x.id, print: true, painting: true, name: x.name, code: x.code, desc: x.desc, img: x.img, artist: x.artist || 'Siva Raja', max: x.printMax, royalty: x.printRoyalty }))]);
    window.kalaiShowCatalogue(list.filter((x) => x.img && !x.print));
  } catch (ex) { console.warn('Catalogue not loaded; showing the built-in collection.', ex); }
}
showCatalogue();

/* ---------- Crafts shop: approved seller listings (public, read-only) ---------- */
async function showMarket() {
  if (typeof window.kalaiShowMarket !== 'function') return;
  try {
    const r = await client.models.MarketItem.list({ authMode: 'apiKey', limit: 500 });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    const items = (r.data || []).sort((a, b) => (Number(b.stock > 0) - Number(a.stock > 0)) || String(b.publishedAt).localeCompare(String(a.publishedAt)));
    const list = await Promise.all(items.map(async (m) => {
      let keys = []; try { keys = JSON.parse(m.imageKeys || '[]'); } catch { /* none */ }
      let img = '';
      try { if (keys[0]) img = (await getUrl({ path: keys[0], options: { expiresIn: 3600 } })).url.toString(); } catch { /* no photo */ }
      // Artists' works get a detail page with all their photos.
      let imgs = [img];
      if (m.sellerType === 'ARTIST' && keys.length > 1) imgs = [img, ...(await Promise.all(keys.slice(1, 8).map((k) => getUrl({ path: k, options: { expiresIn: 3600 } }).then((u) => u.url.toString()).catch(() => ''))))].filter(Boolean);
      return { id: m.listingId, title: m.title, seller: m.sellerName, sellerType: m.sellerType, category: m.category, description: m.description, price: m.price, stock: Number(m.stock ?? 0), img, imgs };
    }));
    const withImg = list.filter((x) => x.img);
    // Artists' works join the collection (with the artist dropdown); sellers' products stay in the Crafts shop.
    const kindOf = (c) => (/sketch|pencil|charcoal|graphite|ink|pen/i.test(c || '') ? 'sketch' : /water/i.test(c || '') ? 'water' : 'other');
    const art = withImg.filter((x) => x.sellerType === 'ARTIST');
    if (typeof window.kalaiShowArtistWorks === 'function' && art.length) {
      window.kalaiShowArtistWorks(art.map((x) => ({ id: x.id, market: true, name: x.title, artist: x.seller, category: x.category, kind: kindOf(x.category), desc: x.description, price: x.price, stock: x.stock, img: x.img, imgs: x.imgs })));
    }
    window.kalaiShowMarket(withImg.filter((x) => x.sellerType !== 'ARTIST'));
  } catch (ex) { console.warn('Crafts shop not loaded.', ex); }
}

/* ---------- Offer banner across the top (Order Management → Offers, "Show as banner") ---------- */
async function showOfferBanner() {
  try {
    const r = await client.models.Promotion.list({ authMode: 'apiKey', limit: 100 });
    const now = new Date().toISOString();
    const p = (r.data || []).filter((x) => x.active && x.showBanner && x.bannerText && (!x.startAt || x.startAt <= now) && (!x.endAt || x.endAt >= now))
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))[0];
    if (!p || lsGet('kalai-banner-closed') === p.id) return;
    document.head.insertAdjacentHTML('beforeend', `<style>
.promo-bar{background:linear-gradient(90deg,#b0832b,#d9ad55);color:#1d1b2b;font-size:14px;font-weight:600;text-align:center;padding:8px 40px;position:relative;line-height:1.4}
.promo-bar a{color:#1d1b2b;text-decoration:underline;margin-left:8px;white-space:nowrap}
.promo-bar code{font-family:var(--mono);background:rgba(255,255,255,.45);border-radius:4px;padding:1px 6px;margin-left:6px}
.promo-bar button{position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:0;font-size:18px;line-height:1;cursor:pointer;color:#1d1b2b}
@media (max-width:640px){.promo-bar{font-size:12.5px;padding:7px 34px}}
</style>`);
    const bar = document.createElement('div');
    bar.className = 'promo-bar'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Offer');
    bar.innerHTML = `${esc(p.bannerText)}${p.code ? `<code>${esc(p.code)}</code>` : ''}<a href="/offers.html#o-${esc(p.id)}">See offers →</a><button type="button" aria-label="Close offer">×</button>`;
    bar.querySelector('button').onclick = () => { bar.remove(); lsSet('kalai-banner-closed', p.id); };
    const atTop = window.scrollY < 5 && !location.hash;
    bar.style.overflowAnchor = 'none';
    document.body.prepend(bar);
    // The browser keeps the view where it was (scroll anchoring); at the top of the page, show the banner.
    if (atTop) { window.scrollTo(0, 0); requestAnimationFrame(() => window.scrollTo(0, 0)); setTimeout(() => { if (window.scrollY <= 40) window.scrollTo(0, 0); }, 300); }
  } catch { /* no banner */ }
}
showOfferBanner();

/* ---------- Our artists: approved artists' public profiles ---------- */
async function showArtists() {
  if (typeof window.kalaiShowArtists !== 'function') return;
  try {
    const st = await client.models.SiteSetting.get({ id: 'site' }, { authMode: 'apiKey' }).catch(() => null);
    if (st?.data?.showArtists === false) return; // switched off in Order management → Settings
    const r = await client.models.ArtistProfile.list({ authMode: 'apiKey', limit: 200 });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    const url = async (k) => { try { return k ? (await getUrl({ path: k, options: { expiresIn: 3600 } })).url.toString() : ''; } catch { return ''; } };
    // The artist's works on the website (the catalogue pictures, cleaned and approved) come before the sample photos
    // sent with the application.
    const works = new Map();
    try {
      const pr = await client.models.Product.list({ authMode: 'apiKey', limit: 500 });
      const nowIso = new Date().toISOString();
      for (const p of pr.data || []) if (p.artist && p.imageKey && ['PUBLISHED', 'SOLD'].includes(p.status) && (!p.publishAt || p.publishAt <= nowIso)) (works.get(p.artist.trim().toLowerCase()) || works.set(p.artist.trim().toLowerCase(), []).get(p.artist.trim().toLowerCase())).push(p.imageKey);
    } catch { /* samples only */ }
    const list = await Promise.all((r.data || []).sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt))).map(async (a) => {
      let keys = []; try { keys = JSON.parse(a.sampleKeys || '[]'); } catch { keys = []; }
      const own = works.get(String(a.name || '').trim().toLowerCase()) || [];
      if (own.length) keys = [...own, ...keys.filter((k) => !own.includes(k))].slice(0, 8);
      return {
        name: a.name, mediums: a.mediums, about: a.about, training: a.training || '', experience: a.experience || '', commissions: a.commissions,
        place: [a.city || a.region, a.country === 'India' ? 'India' : 'UAE'].filter(Boolean).join(', '),
        born: `b. ${a.country === 'India' ? 'India' : 'UAE'}${a.bornYear ? `, ${a.bornYear}` : ''}`,
        img: await url(a.photoKey), featured: await url(own.length ? own[0] : a.featuredKey || keys[0]), sampleKeys: keys, url,
      };
    }));
    window.kalaiShowArtists(list);
  } catch (ex) { console.warn('Artists not loaded.', ex); }
}
showArtists();
showMarket();

/* ---------- published reviews on the website (public, read-only) ---------- */
async function showPublicReviews() {
  const sec = document.getElementById('reviews');
  if (!sec) return;
  try {
    const res = await client.models.PublicReview.list({ authMode: 'apiKey', limit: 100 });
    const list = (res.data || []).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    if (!list.length) return;
    const avg = list.reduce((a, r) => a + r.rating, 0) / list.length;
    document.getElementById('revAvg').textContent = `${avg.toFixed(1)} out of 5 from ${list.length} review${list.length > 1 ? 's' : ''} by customers who bought from us.`;
    document.getElementById('revGrid').innerHTML = list.slice(0, 12).map((r) => `<figure class="rev">
      <div class="st" aria-label="${r.rating} out of 5">${starText(r.rating)}</div>
      ${r.comment ? `<blockquote>“${esc(r.comment)}”</blockquote>` : ''}
      <figcaption>${esc(r.firstName || 'A customer')}${r.title ? ` · ${esc(r.title)}` : ''}${r.date ? ` · ${esc(new Date(r.date).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }))}` : ''}</figcaption>
    </figure>`).join('');
    sec.hidden = false;
  } catch { /* no reviews section if it can't load */ }
}
showPublicReviews();

/* Visitor not signed in: a catalogue price enquiry is still saved for the studio (public key; no tracking for the visitor). */
async function saveGuest({ ref, subject, fields }) {
  if (!subject.startsWith('Price') && !subject.startsWith('Artwork order')) return false;
  const { errors } = await client.mutations.guestEnquiry({
    ref, title: (fields['Artwork'] || 'Price enquiry').split(' (')[0], details: JSON.stringify(fields),
    customerName: fields['Name'] || '', phone: fields['Mobile'] || '', email: fields['Email'] || null,
  }, { authMode: 'apiKey' });
  if (errors?.length) throw new Error(errors[0].message);
  return true;
}

window.kalaiAccount = {
  saveGuest,
  get user() { return state.user; },
  save,
  open: () => { state.user ? showList() : showSignIn(); open(); },
};
