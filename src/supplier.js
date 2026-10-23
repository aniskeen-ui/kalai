import { openPdf } from './pdf.js';
// Supplier portal: frame shops (FRAMER) and delivery partners (COURIER).
// They apply, and once approved see the jobs Kalai Art House gives them: the work's photo, frame spec and size,
// the agreed price, pickup and delivery addresses. They update each step and enter their invoice (a Zoho bill).
// A frame shop can also take the delivery of its own job when we ask (it confirms when accepting).
import './amplify-config.js';
import './skin.js';
import {
  fetchAuthSession, signIn, signUp, confirmSignUp, resendSignUpCode, autoSignIn, signOut, getCurrentUser,
  fetchUserAttributes, resetPassword, confirmResetPassword,
} from 'aws-amplify/auth';
import { generateClient } from 'aws-amplify/data';
import { uploadData, getUrl } from 'aws-amplify/storage';
import { autoPhones } from './phone.js';
import { RC_STYLES, RC_SIZES, RC_EMIRATES, RC_ZONES, RC_PARCELS, parcelPrice, parseCard } from './ratecard.js';

autoPhones();
const client = generateClient();
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const aed = (n) => (n == null || n === '' ? '–' : 'AED ' + Number(n).toLocaleString('en-GB', { maximumFractionDigits: 2 }));
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');

let profile = null;
let jobs = [];
let tab = 'open';
let mode = 'in';
let groups = [];
let viewAs = new URLSearchParams(location.search).get('view') || '';
const isAdmin = () => groups.includes('ADMINS');

async function call(action, data) {
  const body = viewAs ? { ...(data || {}), viewAs } : data;
  const r = await client.mutations.sellerAction({ action, data: body ? JSON.stringify(body) : undefined });
  if (r.errors?.length) throw new Error(r.errors[0].message.replace(/^.*?Error: /, ''));
  return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
}
function show(view) {
  ['loginView', 'applyView', 'statusView', 'jobsView', 'ratesView', 'framesView'].forEach((v) => { $(v).hidden = v !== view; });
  $('signOutBtn').hidden = view === 'loginView';
}

async function start() {
  try { await getCurrentUser(); } catch { show('loginView'); setMode('in'); return; }
  const attrs = await fetchUserAttributes().catch(() => ({}));
  $('who').textContent = attrs.email || '';
  groups = (await fetchAuthSession().catch(() => null))?.tokens?.accessToken?.payload?.['cognito:groups'] || [];
  if (isAdmin()) await adminBar(); else viewAs = '';
  await load();
}
async function load() {
  try {
    profile = (await call('me')).profile;
  } catch (ex) {
    if (/No current user|Unauthorized|not authorized/i.test(ex.message)) { show('loginView'); setMode('in'); return; }
    show('statusView'); $('statusBox').innerHTML = `<p class="err">Could not load your account: ${esc(ex.message)}</p>`; return;
  }
  route();
}

async function adminBar() {
  $('adminBar').hidden = false;
  try {
    const list = ((await client.mutations.sellerAction({ action: 'portals' })).data);
    const all = (typeof list === 'string' ? JSON.parse(list) : list).portals || [];
    const sup = all.filter((p) => p.type === 'FRAMER' || p.type === 'COURIER');
    const opt = (p) => `<option value="${esc(p.id)}">${esc(p.business || p.contactName)} · ${p.type === 'FRAMER' ? 'frame shop' : 'delivery'} · ${esc({ APPLIED: 'to approve', APPROVED: 'approved', REJECTED: 'rejected', SUSPENDED: 'suspended' }[p.status] || p.status)}</option>`;
    $('viewAs').innerHTML = `<option value="">My own portal (studio login)</option>${sup.map(opt).join('')}`;
    $('viewAs').value = sup.some((p) => p.id === viewAs) ? viewAs : '';
    if (!$('viewAs').value) viewAs = '';
    $('adminNote').textContent = sup.length ? '' : 'No frame shops or delivery partners yet. Share art.pranixtechno.com/supplier.html with them.';
  } catch (ex) { $('adminNote').textContent = ex.message; }
  $('viewAs').onchange = () => {
    viewAs = $('viewAs').value;
    const u = new URL(location.href); if (viewAs) u.searchParams.set('view', viewAs); else u.searchParams.delete('view');
    history.replaceState(null, '', u);
    load();
  };
}

function route() {
  const s = profile?.status;
  // The studio login itself: pick a supplier above (its own account may be an artist/seller test account).
  if (isAdmin() && !viewAs) { show('statusView'); $('statusBox').innerHTML = '<h2>Studio view</h2><p>Choose a frame shop or delivery partner above to see and work in their portal, exactly as they see it.</p>'; return; }
  if (profile && !['FRAMER', 'COURIER'].includes(profile.type)) {
    show('statusView');
    $('statusBox').innerHTML = `<h2>This is the supplier portal</h2><p>Your account is an ${profile.type === 'ARTIST' ? 'artist' : 'seller'} account. <a href="/seller.html">Open the artist &amp; seller portal</a>.</p>`;
    return;
  }
  if (!profile || s === 'REJECTED') {
    if (isAdmin() && !viewAs) { show('statusView'); $('statusBox').innerHTML = '<h2>Studio view</h2><p>Choose a frame shop or delivery partner above to see their jobs as they do.</p>'; return; }
    show('applyView'); fillApply();
    if (s === 'REJECTED') $('applyNote').innerHTML = `Your earlier application was not accepted.${profile.adminNote ? ` <b>Our note:</b> ${esc(profile.adminNote)}` : ''} You can update it and send it again.`;
    return;
  }
  if (s === 'APPLIED') {
    show('statusView');
    $('statusBox').innerHTML = `<h2>Application received</h2><p>Thank you, ${esc(profile.contactName)}. We'll check your details and email you, usually within a few days. Once approved, the jobs we give you appear here.</p>
      <p><b>Please add your price list</b> (${profile.type === 'FRAMER' ? 'frame prices by style and size, and the fixing charge' : 'delivery charges by emirate'}): we compare suppliers on it.</p>
      <div style="display:flex;gap:12px;flex-wrap:wrap"><button class="btn" id="goRates" type="button">My price list</button>${profile.type === 'FRAMER' ? '<button class="btn ghost" id="goFrames" type="button">My frames</button>' : ''}<button class="linkbtn" id="editApp" type="button">Edit my application</button></div>`;
    $('editApp').onclick = () => { show('applyView'); fillApply(); };
    $('goRates').onclick = () => openRates('statusView');
    if ($('goFrames')) $('goFrames').onclick = () => openFrames('statusView');
    return;
  }
  if (s === 'SUSPENDED') { show('statusView'); $('statusBox').innerHTML = `<h2>Your account is paused</h2><p>${profile.adminNote ? esc(profile.adminNote) : 'Please contact Kalai Art House on WhatsApp.'}</p>`; return; }
  show('jobsView');
  $('tabFrames').hidden = profile.type !== 'FRAMER';
  $('jBiz').textContent = profile.business;
  $('jNote').textContent = profile.type === 'FRAMER'
    ? 'Framing jobs from Kalai Art House: accept, frame, mark ready for pickup (or deliver it yourself when we ask), then enter your invoice.'
    : 'Delivery jobs from Kalai Art House: accept, pick up (from the frame shop shown), deliver, then enter your invoice.';
  loadJobs();
}

// ---------- sign in ----------
function setMode(m) {
  mode = m;
  $('tSignIn').setAttribute('aria-pressed', String(m === 'in' || m === 'reset'));
  $('tSignUp').setAttribute('aria-pressed', String(m === 'up' || m === 'code'));
  $('aCodeBox').hidden = !(m === 'code' || m === 'reset');
  $('aPass').closest('.field').querySelector('label').textContent = m === 'reset' ? 'New password' : 'Password';
  $('aPass').autocomplete = m === 'in' ? 'current-password' : 'new-password';
  $('aBtn').textContent = { in: 'Sign in', up: 'Create account', code: 'Confirm', reset: 'Set new password' }[m];
  $('aForgot').hidden = m !== 'in';
  $('aErr').textContent = '';
}
$('tSignIn').onclick = () => setMode('in');
$('tSignUp').onclick = () => setMode('up');
$('aForgot').onclick = async () => {
  const email = $('aEmail').value.trim().toLowerCase();
  if (!email) { $('aErr').textContent = 'Type your email first.'; return; }
  try { await resetPassword({ username: email }); setMode('reset'); $('aErr').textContent = 'We emailed you a code. Enter it with a new password.'; } catch (ex) { $('aErr').textContent = ex.message; }
};
$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('aEmail').value.trim().toLowerCase(), password = $('aPass').value, code = $('aCode').value.trim();
  const b = $('aBtn'); b.disabled = true; $('aErr').textContent = '';
  try {
    if (!email) throw new Error('Type your email.');
    if (mode === 'in') {
      const { nextStep } = await signIn({ username: email, password });
      if (nextStep.signInStep === 'CONFIRM_SIGN_UP') { await resendSignUpCode({ username: email }); setMode('code'); $('aErr').textContent = 'Confirm your email: we sent you a code.'; return; }
      if (nextStep.signInStep !== 'DONE') throw new Error('Finish setting up this account first.');
      await start();
    } else if (mode === 'up') {
      if (password.length < 8) throw new Error('Use at least 8 characters for the password.');
      await signUp({ username: email, password, options: { userAttributes: { email }, autoSignIn: true } });
      setMode('code'); $('aErr').textContent = 'We emailed you a code. Enter it to confirm.';
    } else if (mode === 'code') {
      const { nextStep } = await confirmSignUp({ username: email, confirmationCode: code });
      if (nextStep.signUpStep === 'COMPLETE_AUTO_SIGN_IN') await autoSignIn(); else await signIn({ username: email, password });
      await start();
    } else {
      await confirmResetPassword({ username: email, confirmationCode: code, newPassword: password });
      await signIn({ username: email, password });
      await start();
    }
  } catch (ex) {
    $('aErr').textContent = ex.name === 'NotAuthorizedException' || ex.name === 'UserNotFoundException' ? 'Email or password is incorrect.'
      : ex.name === 'UsernameExistsException' ? 'This email already has an account: sign in instead.' : (ex.message || 'Something went wrong.');
  } finally { b.disabled = false; }
});
$('signOutBtn').onclick = async () => { await signOut(); $('who').textContent = ''; profile = null; show('loginView'); setMode('in'); };

// ---------- application ----------
const AF = { sWeb: 'portfolio', sBiz: 'business', sName: 'contactName', sPhone: 'phone', sEmirate: 'emirate', sAddr: 'address', sLic: 'tradeLicence', sAbout: 'about', sBank: 'bankName', sAcc: 'accountName', sIban: 'iban' };
function fillApply() {
  Object.entries(AF).forEach(([id, k]) => { if (profile?.[k] != null) $(id).value = profile[k]; });
  const t = profile?.type === 'COURIER' ? 'COURIER' : new URLSearchParams(location.search).get('as') === 'courier' ? 'COURIER' : 'FRAMER';
  document.querySelector(`input[name="sType"][value="${t}"]`).checked = true;
  document.querySelectorAll('input[name="sType"]').forEach((r) => { r.disabled = !!profile?.type && profile.status !== 'REJECTED'; r.onchange = typeText; });
  typeText();
}
function typeText() {
  const fr = document.querySelector('input[name="sType"]:checked').value === 'FRAMER';
  $('sAddrL').textContent = fr ? 'Workshop address (where works are dropped off and collected)' : 'Your address / base';
  $('sAboutL').textContent = fr ? 'Your services: frame styles and mouldings, glass/acrylic, mount, usual turnaround, and whether you deliver' : 'Your services: vehicles, areas you cover (emirates), same-day or next-day, and your usual rates';
}
$('applyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(Object.entries(AF).map(([id, k]) => [k, $(id).value.trim()]));
  data.type = document.querySelector('input[name="sType"]:checked').value;
  if (data.portfolio && !/^https?:\/\//i.test(data.portfolio)) data.portfolio = `https://${data.portfolio}`;
  data.country = 'UAE';
  const b = $('sBtn'); b.disabled = true; $('sErr').textContent = '';
  try { profile = (await call('apply', data)).profile; route(); } catch (ex) { $('sErr').textContent = ex.message; } finally { b.disabled = false; }
});

// ---------- jobs ----------
const FR_STEPS = [['ASSIGNED', 'New'], ['ACCEPTED', 'Accepted'], ['READY', 'Framed, ready'], ['COLLECTED', 'Collected']];
const DL_STEPS = [['ASSIGNED', 'New'], ['ACCEPTED', 'Accepted'], ['PICKED', 'Picked up'], ['DELIVERED', 'Delivered']];
const isDone = (j) => j.cancelled || !!j.invoiceNo;
async function loadJobs() {
  $('jList').innerHTML = '<p class="muted">Loading…</p>';
  try { jobs = (await call('jobs')).jobs || []; drawJobs(); } catch (ex) { $('jList').innerHTML = `<p class="err">${esc(ex.message)}</p>`; }
}
$('jReload').onclick = loadJobs;
$('jTabs').querySelectorAll('[data-t]').forEach((b) => { b.onclick = () => { if (b.dataset.t === 'rates') { openRates('jobsView'); return; } if (b.dataset.t === 'frames') { openFrames('jobsView'); return; } tab = b.dataset.t; $('jTabs').querySelectorAll('[data-t]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); drawJobs(); }; });

function addr(x) { return x ? `<b>${esc(x.name)}</b>${x.phone ? ` · <a href="tel:${esc(x.phone)}">${esc(x.phone)}</a>` : ''}${x.address ? `<br>${esc(x.address)}` : ''}` : '–'; }
function jobCard(j) {
  const fr = j.role === 'framer';
  const steps = fr ? FR_STEPS : DL_STEPS;
  const at = steps.findIndex((s) => s[0] === j.stage);
  const label = j.cancelled ? 'Cancelled: please stop' : j.invoiceNo ? `Invoiced ${j.invoiceNo}` : steps[Math.max(0, at)][1];
  const key = `${j.id}:${j.role}`;
  let act = '';
  if (!j.cancelled) {
    if (j.stage === 'ASSIGNED') {
      act = `${fr && j.canDeliver ? `<label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" data-deliver style="width:auto"> We will also deliver it to the customer${j.deliveryPrice != null ? ` (${aed(j.deliveryPrice)})` : ''}</label>` : ''}
        <button class="btn small" data-a="jobAccept">Accept the job</button>`;
    } else if (fr && j.stage === 'ACCEPTED') act = '<button class="btn small" data-a="jobReady">Framed, ready for pickup</button>';
    else if (!fr && ['ASSIGNED', 'ACCEPTED'].includes(j.stage)) {
      act = j.from && !j.from.ready ? `<span class="muted">Waiting: ${esc(j.from.name)} hasn't finished framing yet.</span>`
        : `<div class="inline"><div class="field"><label>Tracking / AWB (optional)</label><input data-awb maxlength="60"></div><button class="btn small" data-a="jobPicked">${j.selfDelivery ? 'Out for delivery' : 'Picked up'}</button></div>`;
    } else if (!fr && j.stage === 'PICKED') act = '<button class="btn small" data-a="jobDelivered">Delivered to the customer</button>';
    const canInvoice = fr ? ['READY', 'COLLECTED'].includes(j.stage) : j.stage === 'DELIVERED';
    if (canInvoice && !j.invoiceNo) act += `<div class="inline"><div class="field"><label>Your invoice no.</label><input data-inv maxlength="40"></div><div class="field"><label>Amount (AED)</label><input data-amt type="number" min="0" step="0.01" value="${j.price ?? ''}"></div><button class="btn small" data-a="jobInvoice">Send invoice</button></div>`;
  }
  return `<article class="job" data-key="${esc(key)}">
    <div class="row"><h3>${fr ? 'Framing' : 'Delivery'} · ${esc(j.title)}</h3><span class="stage ${j.cancelled ? 'new' : j.invoiceNo || j.stage === 'DELIVERED' ? 'done' : j.stage === 'ASSIGNED' ? 'new' : ''}">${esc(label)}</span>
      <span class="muted" style="margin-left:auto">Order ${esc(j.ref)} · ${esc(j.kind)} · given ${esc(day(j.assignedAt))}</span></div>
    <div class="steps">${steps.map((s, i) => `<i class="${i <= at ? 'on' : ''}" title="${esc(s[1])}"></i>`).join('')}</div>
    <div class="grid2">
      <dl>
        <dt>Agreed price</dt><dd><b>${aed(j.price)}</b></dd>
        ${j.due ? `<dt>Please finish by</dt><dd>${esc(j.due)}</dd>` : ''}
        ${j.note ? `<dt>Note from us</dt><dd>${esc(j.note)}</dd>` : ''}
        ${fr && j.delivering ? '<dt>Delivery</dt><dd>You deliver this one too (see the delivery job)</dd>' : ''}
        ${j.specs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
        ${j.awb ? `<dt>Tracking</dt><dd>${esc(j.awb)}</dd>` : ''}
        ${j.invoiceNo ? `<dt>Your invoice</dt><dd>${esc(j.invoiceNo)} · ${aed(j.invoiceAmt)}${j.bill ? ' · received' : ''}${j.hasBill ? ' · <button type="button" class="linkbtn" data-invpdf>📄 Open invoice</button>' : ''}</dd>` : ''}
      </dl>
      <dl>
        ${!fr ? `<dt>Pick up from</dt><dd>${addr(j.from)}</dd>` : ''}
        <dt>Deliver to</dt><dd>${addr(j.to)}</dd>
      </dl>
    </div>
    ${j.hasPhoto ? `<div><button class="linkbtn" data-photo>Show the artwork photo</button><div data-img></div></div>` : ''}
    <div style="display:grid;gap:8px;justify-items:start">${act}</div>
    <div class="err" data-msg></div>
  </article>`;
}
function drawJobs() {
  const list = jobs.filter((j) => (tab === 'all' ? true : tab === 'done' ? isDone(j) : !isDone(j)));
  $('jList').innerHTML = list.length ? list.map(jobCard).join('') : `<div class="sbox"><p class="muted" style="margin:0">${tab === 'open' ? 'No open jobs right now. We email you when there is a new one.' : 'Nothing here yet.'}</p></div>`;
  $('jList').querySelectorAll('.job').forEach((card) => {
    const [id, role] = card.dataset.key.split(':');
    const msg = card.querySelector('[data-msg]');
    card.querySelector('[data-invpdf]')?.addEventListener('click', () => openPdf(() => call('jobInvoicePdf', { id, role }), (ex) => { msg.textContent = ex.message; }));
    const ph = card.querySelector('[data-photo]');
    if (ph) ph.onclick = async () => {
      ph.disabled = true;
      try { const r = await call('jobPhoto', { id, role }); card.querySelector('[data-img]').innerHTML = `<a href="${esc(r.url)}" target="_blank" rel="noopener"><img class="photo" alt="Artwork to frame" src="${esc(r.url)}"></a><div class="muted">Tap to open full size (link works for 15 minutes).</div>`; ph.hidden = true; }
      catch (ex) { msg.textContent = ex.message; ph.disabled = false; }
    };
    card.querySelectorAll('[data-a]').forEach((b) => {
      b.onclick = async () => {
        const a = b.dataset.a, data = { id, role };
        if (a === 'jobAccept' && card.querySelector('[data-deliver]')) data.deliver = card.querySelector('[data-deliver]').checked;
        if (a === 'jobPicked') data.awb = card.querySelector('[data-awb]')?.value.trim() || '';
        if (a === 'jobInvoice') { data.invoiceNo = card.querySelector('[data-inv]').value.trim(); data.amount = card.querySelector('[data-amt]').value; }
        b.disabled = true; msg.textContent = '';
        try {
          await call(a, data);
          await loadJobs();
        } catch (ex) { msg.textContent = ex.message; b.disabled = false; }
      };
    });
  });
}

// ---------- price list ----------
let ratesBack = 'jobsView';
const cell = (name, v) => `<input type="number" min="0" step="0.5" data-n="${esc(name)}" value="${v ?? ''}" placeholder="–">`;
// One row of a courier's price list; older small / large prices fill the matching sizes.
const pRow = (path, row) => RC_PARCELS.map(([k]) => `<td>${cell(`${path}.${k}`, parcelPrice(row, k === 's1' ? 'A3' : k))}</td>`).join('');
function openRates(back) {
  ratesBack = back;
  const card = parseCard(profile), fr = profile.type === 'FRAMER';
  $('rTitle').textContent = fr ? 'My frame price list' : 'My delivery charges';
  $('rNote').textContent = fr
    ? "Your price per frame, in AED, for each style and size you offer (leave blank if you don't offer it). A4 = 21×30 cm, A3 = 30×42 cm; other sizes are the outside frame size in cm. Add the fixing charge per size (mount, glass and fitting the work), or tick “included” if your frame prices already include it."
    : 'Your charge in AED to deliver one framed work (packed, with glass) from Dubai, by frame size. Leave a size blank if you don\'t take it. Outside the UAE is optional.';
  $('rGrid').innerHTML = fr
    ? `<table class="rc"><thead><tr><th>Size</th>${RC_STYLES.map(([, n]) => `<th>${esc(n)}</th>`).join('')}<th>Fixing charge</th></tr></thead><tbody>
        ${RC_SIZES.map((sz) => `<tr><th>${esc(sz)}</th>${RC_STYLES.map(([k]) => `<td>${cell(`frames.${k}.${sz}`, card.frames?.[k]?.[sz])}</td>`).join('')}<td>${cell(`fixing.${sz}`, card.fixing?.[sz])}</td></tr>`).join('')}</tbody></table>
       <label style="display:flex;gap:8px;align-items:center;font-weight:400;margin-top:8px"><input type="checkbox" id="rIncl" style="width:auto" ${card.fixingIncluded ? 'checked' : ''}> Fixing (mount, glass, fitting) is included in my frame prices</label>
       <h3 style="font-size:15px;margin:14px 0 4px">If you also deliver: your delivery charge to each emirate (optional)</h3>
       <table class="rc"><thead><tr><th>To</th><th>Small parcel (up to A3 / 40×50)</th><th>Large parcel</th></tr></thead><tbody>
        ${RC_EMIRATES.map((em) => `<tr><th>${esc(em)}</th><td>${cell(`uae.${em}.small`, card.uae?.[em]?.small)}</td><td>${cell(`uae.${em}.large`, card.uae?.[em]?.large)}</td></tr>`).join('')}</tbody></table>`
    : `<table class="rc"><thead><tr><th>To</th>${RC_PARCELS.map(([, n]) => `<th>${esc(n)}</th>`).join('')}</tr></thead><tbody>
        ${RC_EMIRATES.map((em) => `<tr><th>${esc(em)}</th>${pRow(`uae.${em}`, card.uae?.[em])}</tr>`).join('')}
        <tr><th colspan="${RC_PARCELS.length + 1}" style="padding-top:12px">Outside the UAE (optional)</th></tr>
        ${RC_ZONES.map(([z, n]) => `<tr><th>${esc(n)}</th>${pRow(`intl.${z}`, card.intl?.[z])}</tr>`).join('')}</tbody></table>`;
  $('rNotes').value = card.notes || '';
  // Studio only: fill a courier's empty list with market estimates (Aramex-type retail rates, Oct 2026) until real prices come.
  $('rEst')?.remove();
  if (!fr && isAdmin() && viewAs) {
    const b = document.createElement('button'); b.type = 'button'; b.id = 'rEst'; b.className = 'btn small ghost'; b.style.margin = '0 0 10px';
    b.textContent = 'Fill with market estimates (until real prices)';
    b.onclick = () => {
      const near = [22, 35, 55, 75, 130], far = [32, 45, 65, 90, 150];
      RC_EMIRATES.forEach((em) => RC_PARCELS.forEach(([k], i) => {
        const inp = $('rGrid').querySelector(`[data-n="uae.${em}.${k}"]`);
        if (inp) inp.value = (['Dubai', 'Sharjah', 'Ajman'].includes(em) ? near : far)[i];
      }));
      if (!$('rNotes').value.trim()) $('rNotes').value = 'Estimates only, until business rates. Charged on volumetric weight (L×W×H ÷ 5000). Remote areas (Liwa, Ruwais, Western Region, RAK mountains) add about AED 20+. 70×100 may need freight handling. Glass is fragile: pack well or use acrylic for large sizes. Artworks may be excluded from courier cover.';
      $('rMsg').textContent = 'Estimates filled in. Check them, then press Save my price list.';
    };
    $('rGrid').before(b);
  }
  $('rErr').textContent = ''; $('rMsg').textContent = card.at ? `Last saved ${new Date(card.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : '';
  show('ratesView');
}
$('rBack').onclick = () => { show(ratesBack); };
$('rateForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const data = { notes: $('rNotes').value.trim() };
  let bad = false;
  $('rGrid').querySelectorAll('[data-n]').forEach((i) => {
    if (i.value === '') return;
    const v = Number(i.value); if (!(v >= 0 && v <= 5000)) { bad = true; return; }
    const path = i.dataset.n.split('.'); let o = data;
    path.slice(0, -1).forEach((k) => { o = o[k] ??= {}; });
    o[path[path.length - 1]] = v;
  });
  if (bad) { $('rErr').textContent = 'Enter amounts in AED from 0 to 5,000.'; return; }
  if ($('rIncl')) data.fixingIncluded = $('rIncl').checked;
  const b = $('rBtn'); b.disabled = true; $('rErr').textContent = '';
  try { profile = (await call('saveRates', data)).profile; $('rMsg').textContent = 'Saved. Kalai Art House sees your prices when giving out jobs.'; } catch (ex) { $('rErr').textContent = ex.message; } finally { b.disabled = false; }
});

// ---------- frame catalogue (frame shops) ----------
let frames = [];
let framesBack = 'jobsView';
const urlCache = new Map();
const imgUrl = (k) => { if (!urlCache.has(k)) urlCache.set(k, getUrl({ path: k, options: { expiresIn: 3600 } }).then((r) => r.url.toString()).catch(() => '')); return urlCache.get(k); };
const STY = [...RC_STYLES, ['other', 'Other']];
function openFrames(back) {
  framesBack = back;
  try { frames = JSON.parse(profile.catalogue || '[]') || []; } catch { frames = []; }
  drawFrames(); show('framesView');
}
function readFrames() {
  $('fList').querySelectorAll('.fr-item').forEach((el, i) => {
    const v = (k) => el.querySelector(`[data-k="${k}"]`).value.trim();
    Object.assign(frames[i], { name: v('name'), style: v('style'), material: v('material'), colour: v('colour'), widthMm: v('widthMm'), extra: v('extra'), note: v('note') });
  });
}
function drawFrames() {
  $('fList').innerHTML = frames.length ? frames.map((f, i) => `<div class="fr-item" data-i="${i}">
    <div><img data-photo alt="${esc(f.name || 'Frame')}" ${f.photoKey ? `data-key="${esc(f.photoKey)}"` : ''}><label class="linkbtn" style="display:block;margin-top:4px;cursor:pointer">${f.photoKey ? 'Change photo' : 'Add photo'}<input type="file" accept="image/*" data-file hidden></label></div>
    <div class="g">
      <div class="field"><label>Name / code</label><input data-k="name" maxlength="80" value="${esc(f.name)}" placeholder="e.g. Oak flat 25 mm"></div>
      <div class="field"><label>Style</label><select data-k="style">${STY.map(([k, n]) => `<option value="${k}" ${f.style === k ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
      <div class="field"><label>Material</label><input data-k="material" maxlength="40" value="${esc(f.material)}" placeholder="Wood, aluminium…"></div>
      <div class="field"><label>Colour / finish</label><input data-k="colour" maxlength="40" value="${esc(f.colour)}"></div>
      <div class="field"><label>Width (mm)</label><input data-k="widthMm" type="number" min="0" max="300" value="${f.widthMm ?? ''}"></div>
      <div class="field"><label>Extra over price list (AED)</label><input data-k="extra" type="number" min="0" step="0.5" value="${f.extra ?? ''}" placeholder="0"></div>
      <div class="field" style="grid-column:1/-1"><label>Note</label><input data-k="note" maxlength="200" value="${esc(f.note)}"></div>
      <button type="button" class="linkbtn" data-del style="justify-self:start">Remove</button>
    </div></div>`).join('') : '<p class="muted" style="margin:0">No frames yet. Click “Add a frame”.</p>';
  $('fList').querySelectorAll('img[data-key]').forEach(async (img) => { img.src = await imgUrl(img.dataset.key); });
  $('fList').querySelectorAll('.fr-item').forEach((el) => {
    const i = Number(el.dataset.i);
    el.querySelector('[data-del]').onclick = () => { readFrames(); frames.splice(i, 1); drawFrames(); };
    el.querySelector('[data-file]').onchange = async (ev) => {
      const file = ev.target.files?.[0]; if (!file) return;
      if (!/^image\//.test(file.type) || file.size > 10 * 1024 * 1024) { $('fErr').textContent = 'Use a photo (JPG or PNG) up to 10 MB.'; return; }
      readFrames(); $('fMsg').textContent = 'Uploading…';
      try {
        const name = `${Date.now()}-${file.name.replace(/[^\w.\-]+/g, '_').slice(-40)}`;
        const r = await uploadData({ path: ({ identityId }) => `market/${identityId}/frames/${name}`, data: file, options: { contentType: file.type } }).result;
        frames[i].photoKey = r.path; $('fMsg').textContent = 'Photo added: click Save my frames.'; drawFrames();
      } catch (ex) { $('fErr').textContent = ex.message; $('fMsg').textContent = ''; }
    };
  });
}
$('fAdd').onclick = () => { readFrames(); frames.push({ name: '', style: 'black', material: '', colour: '', widthMm: '', extra: '', note: '', photoKey: '' }); drawFrames(); };
$('fBack').onclick = () => show(framesBack);
$('fSave').onclick = async () => {
  readFrames();
  const b = $('fSave'); b.disabled = true; $('fErr').textContent = ''; $('fMsg').textContent = 'Saving…';
  try { profile = (await call('saveCatalogue', { items: frames.filter((f) => f.name) })).profile; frames = JSON.parse(profile.catalogue || '[]'); drawFrames(); $('fMsg').textContent = 'Saved. Kalai Art House sees your frames when choosing a frame shop.'; }
  catch (ex) { $('fErr').textContent = ex.message; $('fMsg').textContent = ''; } finally { b.disabled = false; }
};

start();
