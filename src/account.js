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
import { autoPhones, countryRegionHtml, wireRegion, addressLine } from './phone.js';

autoPhones();

const client = generateClient();
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
        const india = v.country === 'India';
        const why = !v.name ? "Add the receiver's name." : v.phone.replace(/\D/g, '').length < 9 ? 'Add a mobile number the courier can call.' : !v.emirate ? (india ? 'Choose the state.' : 'Choose the emirate.') : india && !/^\d{6}$/.test(v.pin) ? 'Add the 6-digit PIN code.' : v.address.length < 10 ? 'Add the full address: house or flat, building, street and area.' : '';
        if (why) { err.textContent = why; return; }
        const btn = f.querySelector('button[type=submit]'); btn.disabled = true; err.textContent = '';
        try {
          const { errors } = await client.mutations.customerAddress({ id: e.id, ...v, landmark: v.landmark || null, pin: india ? v.pin : null });
          if (errors?.length) throw new Error(errors[0].message);
          Object.assign(e, { deliveryName: v.name, deliveryPhone: v.phone, deliveryCountry: v.country, deliveryEmirate: v.emirate, deliveryPin: india ? v.pin : '', deliveryAddress: v.address, deliveryLandmark: v.landmark });
          showList();
        } catch (ex) { err.textContent = ex.message || 'Could not save the address.'; btn.disabled = false; }
      };
    };
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
    ${e.quotedPrice ? `<div>Price: <span class="enq-price">AED ${Number(e.quotedPrice).toLocaleString('en-US')}</span></div>` : ''}
    ${e.adminMessage ? `<div class="enq-msg">${esc(e.adminMessage)}</div>` : ''}
    ${['PAID', 'FRAMING'].includes(st) && e.artistStage ? `<div class="enq-msg">${e.artistStage === 'STARTED' ? `The artist started your painting on ${new Date(e.artistStartedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.` : e.artistStage === 'FINISHED' ? 'Your painting is finished and is being prepared for framing.' : 'Your painting is on its way to our framing studio in Dubai.'}</div>` : ''}
    ${e.kind === 'MARKET' ? `<div class="acct-info" style="font-size:13px">By ${esc(e.sellerName)}${e.qty > 1 ? ` · quantity ${e.qty}` : ''} · ${e.deliveryBy === 'KALAI' ? 'delivered by Kalai Art House' : 'delivered by the maker'}</div>` : ''}
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
  body.innerHTML = `<p class="acct-info">Signed in as <b>${esc(state.email)}</b></p>
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
      if (res.errors?.length) throw new Error(res.errors[0].message);
      items.push(...res.data);
      nextToken = res.nextToken;
    } while (nextToken);
    items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
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
loadUser().then(() => {
  // Links in our emails: art.pranixtechno.com/#my-enquiries opens the panel (sign-in first if needed).
  if (location.hash === "#my-enquiries") { state.user ? showList() : showSignIn(); open(); }
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
  const kind = subject.startsWith('Price') ? 'PRICE' : subject.startsWith('Commission') ? 'COMMISSION' : 'GIFT';
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
      <p class="acct-info" id="moIndia" style="margin:0;font-size:12px" hidden>Delivery to India: we confirm the shipping charge with your payment link, before you pay.</p>
      <div class="field"><label for="moAddr">Address</label><textarea id="moAddr" name="address" rows="2" placeholder="Villa / flat no., building, street, area" autocomplete="street-address">${esc(a.address)}</textarea></div>
      <div class="field"><label for="moLand">Landmark (optional)</label><input id="moLand" name="landmark" value="${esc(a.landmark)}"></div>
      <div class="field"><label for="moNote">Note to the maker (optional)</label><input id="moNote" name="note" maxlength="300"></div>
      <div class="enq-msg" id="moTotal"></div>
      <p class="acct-info" style="margin:0;font-size:12px">You pay Kalai Art House by a secure link we send you; the order is confirmed once paid. Until it is dispatched you can cancel for a full refund. By ordering you agree to our <a href="#terms" class="acct-terms" style="color:var(--kumkum)">terms</a>.</p>
      <div class="acct-err" role="alert"></div>
      <button class="btn primary" type="submit">Place order</button>
    </form>
    <button class="acct-link" id="moBack">Back to My enquiries &amp; orders</button>`,
  async (fd) => {
    const data = Object.fromEntries(['qty', 'name', 'phone', 'country', 'emirate', 'pin', 'address', 'landmark', 'note'].map((k) => [k, String(fd.get(k) || '').trim()]));
    const r = await client.mutations.marketOrder({ data: JSON.stringify({ listingId: p.id, ...data }) });
    if (r.errors?.length) throw new Error(r.errors[0].message.replace(/^.*?Error: /, ''));
    const out = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    lastAddr = { name: data.name, phone: data.phone, country: data.country, emirate: data.emirate, pin: data.pin, address: data.address, landmark: data.landmark };
    currentTab = 'ENQ';
    await showList();
    body.insertAdjacentHTML('afterbegin', `<p class="enq-msg" style="margin:0">Order <b>${esc(out.ref)}</b> placed: AED ${Number(out.total).toLocaleString('en-US')}. We'll email you a secure payment link shortly.</p>`);
  });
  const total = () => { body.querySelector('#moTotal').innerHTML = `Total: <b>AED ${(Number(p.price) * Number(f.qty.value)).toLocaleString('en-US')}</b>`; };
  f.qty.onchange = total; total();
  wireRegion(f);
  const india = () => { body.querySelector('#moIndia').hidden = f.country.value !== 'India'; };
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
const LANG_LABEL = { ta: 'தமிழ்', en: 'English', ar: 'العربية' };
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
async function showDailyMessage() {
  try {
    const r = await client.models.Announcement.list({ authMode: 'apiKey', limit: 50 });
    const nowIso = new Date().toISOString();
    const m = (r.data || []).filter((x) => x.active && (!x.showFrom || x.showFrom <= nowIso) && (!x.showUntil || x.showUntil > nowIso))
      .sort((a, b) => String(b.showFrom).localeCompare(String(a.showFrom)))[0];
    if (!m) return;
    const langs = ['ta', 'en', 'ar'].filter((l) => (m[l] || '').trim());
    if (!langs.length) return;
    const nav = (navigator.language || 'en').slice(0, 2);
    let lang = lsGet('kalai-lang') || (langs.includes(nav) ? nav : 'en');
    if (!langs.includes(lang)) lang = langs.includes('en') ? 'en' : langs[0];
    document.head.insertAdjacentHTML('beforeend', `<style>
.kmsg{position:fixed;right:16px;bottom:16px;z-index:30;width:min(320px,calc(100vw - 32px));background:var(--surface);color:var(--fg);border:1px solid var(--gold);border-left:4px solid var(--gold);border-radius:var(--r);box-shadow:0 10px 30px rgba(0,0,0,.18);padding:12px 14px;display:grid;gap:8px;animation:kmsgIn .35s ease-out}
@keyframes kmsgIn{from{transform:translateY(12px);opacity:0}to{transform:none;opacity:1}}
.kmsg-head{display:flex;align-items:center;gap:8px}
.kmsg-head b{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--gold);margin-right:auto}
.kmsg-langs{display:flex;gap:4px}
.kmsg-langs button{border:1px solid var(--line);background:none;color:var(--muted);border-radius:999px;padding:2px 8px;font:inherit;font-size:11px;cursor:pointer}
.kmsg-langs button[aria-pressed="true"]{background:var(--gold);border-color:var(--gold);color:#1d1b2b}
.kmsg-x{background:none;border:0;color:var(--muted);font-size:18px;line-height:1;cursor:pointer;padding:0 2px}
.kmsg p{margin:0;font-size:14px;line-height:1.55;white-space:pre-line}
.kmsg-tab{position:fixed;right:16px;bottom:16px;z-index:30;border:1px solid var(--gold);background:var(--surface);color:var(--fg);border-radius:999px;padding:7px 12px;font:inherit;font-size:13px;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.15)}
@media (prefers-reduced-motion:reduce){.kmsg{animation:none}}
</style>`);
    const box = document.createElement('aside');
    box.className = 'kmsg'; box.setAttribute('aria-label', "Today's message");
    const tab = document.createElement('button');
    tab.className = 'kmsg-tab'; tab.type = 'button'; tab.hidden = true;
    document.body.append(box, tab);
    const draw = () => {
      box.setAttribute('lang', lang); box.dir = lang === 'ar' ? 'rtl' : 'ltr';
      box.innerHTML = `<div class="kmsg-head"><b>${esc(MSG_TITLE[lang])}</b><span class="kmsg-langs">${langs.map((l) => `<button type="button" data-l="${l}" aria-pressed="${l === lang}">${LANG_LABEL[l]}</button>`).join('')}</span><button class="kmsg-x" type="button" aria-label="Close">×</button></div><p>${esc(m[lang])}</p>`;
      tab.textContent = `📢 ${MSG_TITLE[lang]}`;
      box.querySelectorAll('[data-l]').forEach((b) => { b.onclick = () => { lang = b.dataset.l; lsSet('kalai-lang', lang); draw(); }; });
      box.querySelector('.kmsg-x').onclick = () => { box.hidden = true; tab.hidden = false; lsSet('kalai-msg-closed', m.id); };
    };
    tab.onclick = () => { box.hidden = false; tab.hidden = true; lsSet('kalai-msg-closed', ''); };
    draw();
    // Closed this same message before: keep it as the small tab.
    if (lsGet('kalai-msg-closed') === m.id) { box.hidden = true; tab.hidden = false; }
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
      return { id: p.id, kind: p.kind === 'sketch' ? 'sketch' : 'water', subject: p.subject, name: p.title, size: p.size || '', medium: p.medium || (p.kind === 'sketch' ? 'Graphite on paper' : 'Watercolour on paper'), price: 1, sold: p.status === 'SOLD', ship: 'Original · ready to ship', desc: p.description || '', img };
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
      return { id: m.listingId, title: m.title, seller: m.sellerName, category: m.category, description: m.description, price: m.price, stock: Number(m.stock ?? 0), img };
    }));
    window.kalaiShowMarket(list.filter((x) => x.img));
  } catch (ex) { console.warn('Crafts shop not loaded.', ex); }
}
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
  if (!subject.startsWith('Price')) return false;
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
