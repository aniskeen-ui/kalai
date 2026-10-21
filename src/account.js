// Customer accounts: sign up / sign in, save enquiries, "My enquiries & orders" panel
// (tabs: Orders · Enquiries · Cancellations & refunds).
import './amplify-config.js';
import {
  signUp, confirmSignUp, resendSignUpCode, signIn, signOut, autoSignIn,
  getCurrentUser, fetchUserAttributes, fetchAuthSession, resetPassword, confirmResetPassword,
} from 'aws-amplify/auth';
import { Hub } from 'aws-amplify/utils';
import { generateClient } from 'aws-amplify/data';
import { uploadData } from 'aws-amplify/storage';

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
const KIND = { PRICE: 'Price enquiry', COMMISSION: 'Commission', GIFT: 'Little Artists gift' };

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
.acct-info{font-size:14px;color:var(--muted)}
.enq{border:1px solid var(--line);border-radius:var(--r);padding:14px 16px;display:grid;gap:8px;background:var(--bg)}
.enq-top{display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap}
.enq-title{font-weight:600}
.enq-ref{font-family:var(--mono);font-size:12px;color:var(--muted)}
.pill{display:inline-block;font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px;background:var(--gold-soft);color:var(--fg)}
.pill.done{background:var(--ok);color:#fff}
.pill.stop{background:var(--kumkum);color:#fff}
.steps-bar{display:grid;grid-template-columns:repeat(6,1fr);gap:4px}
.steps-bar i{height:5px;border-radius:3px;background:var(--line)}
.steps-bar i.on{background:var(--gold)}
.enq-msg{font-size:14px;background:var(--surface);border-left:3px solid var(--gold);padding:8px 10px}
.enq-price{font-family:var(--mono);font-size:16px}
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
.rtrack{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:5px;font-size:14px}
.rtrack li{color:var(--muted)}
.rtrack li.done,.rtrack li.now{color:var(--fg)}
.rtrack li span{display:inline-block;width:1.2em}
.rtrack li.done span{color:var(--ok);font-weight:700}
.rtrack li.now span{color:var(--gold)}
.rtrack small{color:var(--muted);font-size:12px}
.acct-sm{display:none}
@media (max-width:640px){.acct-lg{display:none}.acct-sm{display:inline}}
.acct-tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);overflow-x:auto}
.acct-tabs button{background:none;border:0;border-bottom:3px solid transparent;padding:8px 10px;font:inherit;font-size:14px;font-weight:600;color:var(--muted);cursor:pointer;white-space:nowrap}
.acct-tabs button[aria-selected="true"]{color:var(--fg);border-bottom-color:var(--gold)}
.acct-tabs b{font-family:var(--mono);font-weight:400;font-size:12px;margin-left:4px}
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
    if (nextStep.signInStep === 'DONE') { await loadUser(); showList(); return; }
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
      try { await autoSignIn(); await loadUser(); showList(); return; } catch (e) { /* fall through to manual sign-in */ }
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

function card(e) {
  const st = e.status || 'RECEIVED';
  const idx = STEPS.indexOf(st);
  const pillCls = st === 'DELIVERED' ? 'pill done' : st === 'CANCELLED' || st === 'REFUNDED' ? 'pill stop' : 'pill';
  const date = e.createdAt ? new Date(e.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const pay = st === 'PRICE_SENT' && e.paymentLink
    ? `<a class="btn primary" style="text-decoration:none;text-align:center" href="${esc(e.paymentLink)}" target="_blank" rel="noopener">Pay now</a>` : '';
  return `<article class="enq">
    <div class="enq-top"><span class="enq-title">${esc(e.title)}</span><span class="${pillCls}">${esc(STATUS[st] || st)}</span></div>
    <div class="enq-ref">${esc(e.ref)} · ${esc(KIND[e.kind] || '')} · ${esc(date)}</div>
    ${!['CANCELLED', 'REFUNDED', 'REPLACEMENT'].includes(st) ? `<div class="steps-bar" aria-hidden="true">${STEPS.map((_, i) => `<i class="${i <= idx ? 'on' : ''}"></i>`).join('')}</div>` : ''}
    ${e.quotedPrice ? `<div>Price: <span class="enq-price">AED ${Number(e.quotedPrice).toLocaleString('en-US')}</span></div>` : ''}
    ${e.adminMessage ? `<div class="enq-msg">${esc(e.adminMessage)}</div>` : ''}
    ${['PAID', 'FRAMING'].includes(st) && e.artistStage ? `<div class="enq-msg">${e.artistStage === 'STARTED' ? `The artist started your painting on ${new Date(e.artistStartedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.` : e.artistStage === 'FINISHED' ? 'Your painting is finished and is being prepared for framing.' : 'Your painting is on its way to our framing studio in Dubai.'}</div>` : ''}
    ${st === 'REFUNDED' && e.refundAmount ? `<div class="enq-msg">Refunded AED ${Number(e.refundAmount).toLocaleString('en-US')}${e.refundRef ? ` · ref ${esc(e.refundRef)}` : ''}</div>` : ''}
    ${replacementTracker(e)}
    ${(st === 'SHIPPED' || st === 'DELIVERED') && e.courierName ? `<div class="enq-msg">${st === 'DELIVERED' ? 'Delivered' : 'Shipped'} with <b>${esc(e.courierName)}</b>${e.trackingNo ? ` · tracking no. <b>${esc(e.trackingNo)}</b>` : ''}</div>` : ''}
    ${pay}
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

window.kalaiAccount = {
  get user() { return state.user; },
  save,
  open: () => { state.user ? showList() : showSignIn(); open(); },
};
