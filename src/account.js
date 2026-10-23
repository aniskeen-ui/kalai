// Customer accounts: sign up / sign in, save enquiries, "My enquiries & orders" panel
// (tabs: Orders · Enquiries · Cancellations & refunds).
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
window.kalaiKidsCountries?.(COUNTRIES);
import { cleanTitle } from './title.js';

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
    if (st.inrPerAed) window.kalaiInrPerAed = Number(st.inrPerAed);
    window.kalaiRound = { usd: Number(st.usdRound) || 5, inr: Number(st.inrRound) || 50, up: st.roundUp === true, approx: st.approxSign !== false };
    try { window.kalaiShipZones = JSON.parse(st.shipZones || '{}') || {}; } catch { window.kalaiShipZones = {}; }
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
  FRAMING: 'Being framed',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  REPLACEMENT: 'Replacement in progress',
  REFUNDED: 'Refunded',
  CANCELLED: 'Cancelled',
};
const STEPS = ['RECEIVED', 'PRICE_SENT', 'PAID', 'FRAMING', 'SHIPPED', 'DELIVERED'];
const KIND = { PRICE: 'Price enquiry', COMMISSION: 'Commission', GIFT: 'Little Artists gift', MARKET: 'Crafts shop' };
const MARKET_STEPS = ['RECEIVED', 'PRICE_SENT', 'PAID', 'SHIPPED', 'DELIVERED'];

/* ---------- styles ---------- */
const css = `
.acct-scrim{position:fixed;inset:0;background:rgba(10,8,20,.55);z-index:40}
.acct-panel{position:fixed;top:0;right:0;bottom:0;width:min(460px,100%);background:var(--surface);color:var(--fg);z-index:41;display:flex;flex-direction:column;
  padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);padding-right:env(safe-area-inset-right,0px);box-shadow:-10px 0 40px rgba(0,0,0,.3)}
.acct-panel header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:18px 20px;border-bottom:1px solid var(--line)}
.acct-panel h2{font-size:24px;margin:0}
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
@media (max-width:640px){.acct-lg{display:none}.acct-sm{display:inline}}
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
panel.innerHTML = `<header><h2 id="acctTitle">Sign in</h2><button class="x" id="acctClose" aria-label="Close">×</button></header><div class="acct-body" id="acctBody"></div>`;
document.body.append(scrim, panel);
const body = panel.querySelector('#acctBody');
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
  return `<button type="button" class="btn rate-open" data-rate="${esc(e.id)}">★ Rate your ${e.kind === 'GIFT' ? 'framed gift' : 'artwork'}</button>
  <form class="rate" data-id="${esc(e.id)}" novalidate hidden>
    <b>How did we do? Rate your ${e.kind === 'GIFT' ? 'framed gift' : 'artwork'}</b>
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
          title: e.kind === 'GIFT' ? 'Little Artists framed gift' : e.kind === 'COMMISSION' ? 'Commissioned painting' : e.title,
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
const aedTxt = (n) => 'AED ' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const DAMAGE_HOURS = 48;
function cancelTerms(e) {
  const st = e.status || 'RECEIVED';
  const price = Number(e.quotedPrice || 0);
  if (['RECEIVED', 'PRICE_SENT'].includes(st)) return { type: 'FREE', due: 0, text: "Nothing has been paid, so there's nothing to refund. Your enquiry is cancelled straight away." };
  if (['PAID', 'FRAMING'].includes(st)) {
    const started = e.kind === 'GIFT' ? st === 'FRAMING' : !!e.artistStartedAt || st === 'FRAMING';
    return started
      ? { type: 'HALF', due: Math.round(price * 50) / 100, text: e.kind === 'GIFT' ? `Framing has started, so under our terms <b>50% is refunded: ${aedTxt(price / 2)}</b>.` : `The artist started your work${e.artistStartedAt ? ` on ${new Date(e.artistStartedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}, so under our terms <b>50% is refunded: ${aedTxt(price / 2)}</b>. The rest covers the artist's time.` }
      : { type: 'FULL', due: price, text: `The work hasn't started yet, so you get a <b>full refund of ${aedTxt(price)}</b>.` };
  }
  return null;
}
function damageOpen(e) {
  if (e.status !== 'DELIVERED') return false;
  const at = Date.parse(e.deliveredAt || e.updatedAt);
  return !Number.isFinite(at) || Date.now() - at <= DAMAGE_HOURS * 3600_000;
}
function requestBlock(e) {
  const when = e.cancelRequestedAt ? new Date(e.cancelRequestedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
  if (e.cancelState === 'REQUESTED') {
    return `<div class="enq-msg warn">${e.cancelRequest === 'CANCEL' ? `Cancellation requested on ${esc(when)}. Refund due: <b>${aedTxt(e.cancelRefundDue)}</b>, sent within 7 working days. We'll email you when it's done.`
      : e.cancelRequest === 'DAMAGED_REPLACE' ? `Damage reported on ${esc(when)}. You asked for a replacement or repair; we'll confirm within 2 working days.`
      : `Damage reported on ${esc(when)}. Refund due: <b>${aedTxt(e.cancelRefundDue)}</b> once we've checked the photos. We'll email you.`}</div>`;
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
function wireRequests(root, items) {
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
const ADDR_OPEN = ['PRICE_SENT', 'PAID', 'FRAMING', 'REPLACEMENT'];
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
function codeBox(e) {
  const st = e.status || 'RECEIVED';
  if (!e.quotedPrice || !['RECEIVED', 'PRICE_SENT'].includes(st) || e.cancelState === 'REQUESTED') return '';
  if (e.discountCode) return `<div class="code-box" data-code-id="${esc(e.id)}"><button type="button" class="req-open" data-code-remove>Remove code</button><span class="acct-err" data-code-msg></span></div>`;
  return `<form class="code-box" data-code-id="${esc(e.id)}" novalidate style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><input name="code" placeholder="Discount code" maxlength="30" style="max-width:160px;text-transform:uppercase;padding:6px 8px;font-size:13px"><button class="btn" type="submit" style="padding:6px 12px;font-size:13px">Apply</button><a href="/offers.html" class="acct-info" style="font-size:12px">See offers</a><span class="acct-err" data-code-msg style="flex-basis:100%"></span></form>`;
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
function card(e) {
  const st = e.status || 'RECEIVED';
  const steps = e.kind === 'MARKET' ? MARKET_STEPS : STEPS;
  const idx = steps.indexOf(st);
  const pillCls = st === 'DELIVERED' ? 'pill done' : st === 'CANCELLED' || st === 'REFUNDED' ? 'pill stop' : 'pill';
  const date = e.createdAt ? new Date(e.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const pay = st === 'PRICE_SENT' && e.paymentLink
    ? `<a class="btn primary" style="text-decoration:none;text-align:center" href="${esc(e.paymentLink)}" target="_blank" rel="noopener">Pay now</a>` : '';
  return `<article class="enq">
    <div class="enq-top"><span class="enq-title">${esc(e.title)}</span><span class="${pillCls}">${esc(STATUS[st] || st)}</span></div>
    <div class="enq-ref">${esc(e.ref)} · ${esc(KIND[e.kind] || '')} · ${esc(date)}</div>
    ${!['CANCELLED', 'REFUNDED', 'REPLACEMENT'].includes(st) ? `<div class="steps-bar" aria-hidden="true" style="grid-template-columns:repeat(${steps.length},1fr)">${steps.map((_, i) => `<i class="${i <= idx ? 'on' : ''}"></i>`).join('')}</div>` : ''}
    ${e.quotedPrice ? `<div>Price: ${e.discountCode && e.listPrice ? `<s class="acct-info">AED ${Number(e.listPrice).toLocaleString('en-US')}</s> ` : ''}<span class="enq-price">AED ${Number(e.quotedPrice).toLocaleString('en-US')}</span>${e.discountCode ? ` <span class="acct-info" style="font-size:12px">· code <b>${esc(e.discountCode)}</b> −AED ${Number(e.discountAmount || 0).toLocaleString('en-US')}</span>` : ''}</div>` : ''}
    ${codeBox(e)}
    ${e.adminMessage ? `<div class="enq-msg">${esc(e.adminMessage)}</div>` : ''}
    ${['PAID', 'FRAMING'].includes(st) && e.artistStage ? `<div class="enq-msg">${e.artistStage === 'STARTED' ? `The artist started your painting on ${new Date(e.artistStartedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.` : e.artistStage === 'FINISHED' ? 'Your painting is finished and is being prepared for framing.' : 'Your painting is on its way to our framing studio in Dubai.'}</div>` : ''}
    ${e.kind === 'MARKET' ? `<div class="acct-info" style="font-size:13px">By ${esc(parseDet(e.details).Maker || e.sellerName)}${e.qty > 1 ? ` · quantity ${e.qty}` : ''} · ${e.deliveryBy === 'KALAI' ? 'delivered by Kalai Art House' : 'delivered by the maker'}</div>` : ''}
    ${e.kind === 'MARKET' && st === 'RECEIVED' ? '<div class="enq-msg">Thank you for your order. We are confirming it with the maker and will send you a secure payment link shortly.</div>' : ''}
    ${e.kind === 'MARKET' && st === 'PAID' ? `<div class="enq-msg">${e.sellerStage === 'READY' ? 'The maker has packed it; our courier is collecting it.' : 'Paid: the maker is preparing your order.'}</div>` : ''}
    ${st === 'REFUNDED' && e.refundAmount ? `<div class="enq-msg">Refunded AED ${Number(e.refundAmount).toLocaleString('en-US')}${e.refundRef ? ` · ref ${esc(e.refundRef)}` : ''}</div>` : ''}
    ${replacementTracker(e)}
    ${(st === 'SHIPPED' || st === 'DELIVERED') && e.courierName ? `<div class="enq-msg">${st === 'DELIVERED' ? 'Delivered' : 'Shipped'} with <b>${esc(e.courierName)}</b>${e.trackingNo ? ` · tracking no. <b>${esc(e.trackingNo)}</b>` : ''}</div>` : ''}
    ${pay}
    ${addressBlock(e)}
    ${requestBlock(e)}
    ${rateBlock(e)}
  </article>`;
}

const ORDER_ST = ['PAID', 'FRAMING', 'SHIPPED', 'DELIVERED', 'REPLACEMENT'];
const TABS = [
  ['ORDERS', 'Orders', (e) => ORDER_ST.includes(e.status) && e.cancelState !== 'REQUESTED'],
  ['ENQ', 'Enquiries', (e) => ['RECEIVED', 'PRICE_SENT'].includes(e.status || 'RECEIVED')],
  ['CANCEL', 'Cancellations & refunds', (e) => ['CANCELLED', 'REFUNDED'].includes(e.status) || e.cancelState === 'REQUESTED' || e.cancelState === 'DECLINED'],
];
let currentTab = null;
const POLICY_NOTE = `<p class="acct-info" style="margin:0;font-size:13px">To cancel, open the order under <b>Orders</b> or <b>Enquiries</b> and tap “Cancel this order”: you see the refund before you confirm. Before payment it's free; after payment you get a full refund until the artist starts, then 50%. Shipped orders can't be cancelled; damage can be reported with photos within 48 hours of delivery. <a href="#terms" class="acct-terms" style="color:var(--kumkum)">Full terms</a></p>`;

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
    <nav class="acct-tabs" role="tablist" id="acctTabs"></nav>
    <div id="enqList" class="acct-info">Loading…</div>
    <button class="acct-link" id="refresh">Refresh</button><button class="acct-link" id="signOut">Sign out</button>`;
  body.querySelector('#signOut').onclick = async () => { await signOut(); state.user = null; setButton(); showSignIn('You are signed out.'); };
  body.querySelector('#refresh').onclick = showList;
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
    if (!currentTab || !groups[currentTab]) currentTab = groups.ORDERS.length ? 'ORDERS' : groups.ENQ.length ? 'ENQ' : 'CANCEL';
    const nav = body.querySelector('#acctTabs');
    const draw = () => {
      nav.innerHTML = TABS.map(([k, label]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === currentTab}">${label}<b>${groups[k].length}</b></button>`).join('');
      nav.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { currentTab = b.dataset.tab; draw(); }; });
      const shown = groups[currentTab];
      list.innerHTML = (currentTab === 'CANCEL' ? POLICY_NOTE : '') + (shown.length ? shown.map(card).join('')
        : `<p class="acct-info">${currentTab === 'ORDERS' ? 'No orders yet. Once you pay for an enquiry it moves here.' : currentTab === 'ENQ' ? 'No open enquiries.' : 'No cancellations or refunds.'}</p>`);
      list.querySelectorAll('.acct-terms').forEach((a) => { a.onclick = () => close(); });
      wireRate(list, items);
      wireRequests(list, items);
      wireAddress(list, items);
      wireCodes(list);
    };
    draw();
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
  const kind = subject.startsWith('Price') || subject.startsWith('Artwork order') ? 'PRICE' : subject.startsWith('Commission') ? 'COMMISSION' : 'GIFT';
  const title = kind === 'PRICE' ? (fields['Artwork'] || 'Price enquiry').split(' (')[0]
    : kind === 'COMMISSION' ? `Commission: ${fields['Subject'] || ''} (${fields['Style'] || ''})`
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
function afterSignIn() { if (pendingOrder) { const p = pendingOrder; pendingOrder = null; showOrder(p); } else showList(); }
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
      <div><b>${esc(p.title)}</b><div class="acct-info">by ${esc(p.seller)} · AED ${Number(p.price).toLocaleString('en-US')} each, delivery within the UAE included</div></div></div>
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
    body.insertAdjacentHTML('afterbegin', `<p class="enq-msg" style="margin:0">Order <b>${esc(out.ref)}</b> placed: AED ${Number(out.total).toLocaleString('en-US')}${data.code ? ` (code ${esc(data.code.toUpperCase())} applied)` : ''}. We'll email you a secure payment link shortly.</p>`);
  });
  const total = () => { body.querySelector('#moTotal').innerHTML = `Total: <b>AED ${(Number(p.price) * Number(f.qty.value)).toLocaleString('en-US')}</b>`; };
  f.qty.onchange = total; total();
  wireRegion(f);
  const india = () => { body.querySelector('#moIndia').hidden = f.country.value === 'UAE'; };
  f.country.addEventListener('change', india); india();
  body.querySelector('#moBack').onclick = showList;
  if (!a.name) f.name.focus();
}
window.kalaiMarketOrder = (p) => {
  if (state.user) { showOrder(p); open(); return; }
  pendingOrder = p;
  showSignIn('Sign in or create a free account to order, so you can pay securely and follow the delivery.');
  open();
};

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
    box.className = 'kmsg'; box.setAttribute('aria-label', 'Thirukkural of the day'); box.lang = 'ta';
    const tab = document.createElement('button');
    tab.className = 'kmsg-tab'; tab.type = 'button'; tab.hidden = true; tab.textContent = `📜 ${KURAL_TITLE.ta}`;
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
      return { id: p.id, kind: p.kind === 'sketch' ? 'sketch' : 'water', subject: p.subject, name: p.named ? p.title : cleanTitle(p.title), untitled: !p.named && cleanTitle(p.title) === 'Original', code: p.code || '', size: p.size || '', medium: p.medium || (p.kind === 'sketch' ? 'Graphite on paper' : 'Watercolour on paper'), price: 1, ai: !!p.aiPreview, leadDays: p.leadDays ?? null, leadMax: p.leadMax ?? p.leadDays ?? null, prices: (() => { try { return p.priceMatrix ? JSON.parse(p.priceMatrix) : null; } catch { return null; } })(), sold: p.status === 'SOLD', ship: 'Original · ready to ship', desc: p.description || '', img };
    }));
    window.kalaiShowCatalogue(list.filter((x) => x.img));
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
    const list = await Promise.all((r.data || []).sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt))).map(async (a) => {
      let keys = []; try { keys = JSON.parse(a.sampleKeys || '[]'); } catch { keys = []; }
      return {
        name: a.name, mediums: a.mediums, about: a.about, training: a.training || '', experience: a.experience || '', commissions: a.commissions,
        place: [a.city || a.region, a.country === 'India' ? 'India' : 'UAE'].filter(Boolean).join(', '),
        born: `b. ${a.country === 'India' ? 'India' : 'UAE'}${a.bornYear ? `, ${a.bornYear}` : ''}`,
        img: await url(a.photoKey), featured: await url(a.featuredKey || keys[0]), sampleKeys: keys, url,
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
