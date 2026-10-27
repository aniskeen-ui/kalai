import './fresh.js';
import './stage.js';
import { openPdf } from './pdf.js';
import { awbButtons, wireAwb } from './awb.js';
// Supplier portal: frame shops (FRAMER), delivery partners (COURIER) and print shops (PRINTER).
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
import { studioBar, chainOnCards } from './studionav.js';
import { countryOf } from './country.js';
import { RC_STYLES, RC_SIZES, RC_EMIRATES, RC_ZONES, RC_PARCELS, PRINT_SIZES, parcelPrice, parseCard, rawCard, zoneOf, countriesInZone } from './ratecard.js';
import { COUNTRIES, IN_STATES } from './phone.js';

autoPhones();
const client = generateClient();
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const aed = (n) => (n == null || n === '' ? '–' : '⃃ ' + Number(n).toLocaleString('en-GB', { maximumFractionDigits: 2 }));
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
// The studio login with no supplier chosen: nothing of its own to edit, so ask to pick one.
function studioNoPick() {
  if (!(isAdmin() && !viewAs)) return false;
  show('statusView'); $('statusBox').innerHTML = '<h2>Studio view</h2><p>Choose a frame shop, print shop or courier above to see and work in their portal (their frames, price list and details), exactly as they see it.</p>';
  return true;
}
function show(view) {
  ['loginView', 'applyView', 'statusView', 'jobsView', 'ratesView', 'framesView'].forEach((v) => { $(v).hidden = v !== view; });
  $('signOutBtn').hidden = view === 'loginView';
}

// Not a studio admin (or signed out): no studio bar, no "view as" supplier, and the address bar without ?view=.
function dropStudio() {
  viewAs = '';
  const b = document.getElementById('adminBar'); if (b) { b.hidden = true; b.querySelectorAll('.sn-bar').forEach((x) => x.remove()); }
  const u = new URL(location.href); if (u.searchParams.has('view')) { u.searchParams.delete('view'); history.replaceState(null, '', u); }
}
async function start() {
  try { await getCurrentUser(); } catch { show('loginView'); setMode('in'); return; }
  const attrs = await fetchUserAttributes().catch(() => ({}));
  $('who').textContent = attrs.email || '';
  groups = (await fetchAuthSession().catch(() => null))?.tokens?.accessToken?.payload?.['cognito:groups'] || [];
  if (isAdmin()) await adminBar(); else dropStudio();
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
    const supAll = all.filter((p) => ['FRAMER', 'COURIER', 'PRINTER'].includes(p.type));
    // Country filter (India / UAE …), remembered on this computer.
    let ctry = ''; try { ctry = localStorage.getItem('kalaiPortalCountry') || ''; } catch { /* */ }
    const cs = [...new Set(supAll.map(countryOf))].sort();
    $('pCountry').innerHTML = `<option value="">All countries</option>${cs.map((c) => `<option ${c === ctry ? 'selected' : ''}>${esc(c)}</option>`).join('')}`;
    const curP = supAll.find((p) => p.id === viewAs);
    if (curP && ctry && countryOf(curP) !== ctry) ctry = '';
    $('pCountry').value = cs.includes(ctry) ? ctry : '';
    let sup = supAll.filter((p) => !$('pCountry').value || countryOf(p) === $('pCountry').value);
    const opt = (p) => `<option value="${esc(p.id)}">${esc(p.business || p.contactName)} · ${p.type === 'FRAMER' ? 'frame shop' : p.type === 'PRINTER' ? 'print shop' : 'delivery'} · ${esc({ APPLIED: 'to approve', APPROVED: 'approved', REJECTED: 'rejected', SUSPENDED: 'suspended' }[p.status] || p.status)}</option>`;
    const grp = (t, l) => { const xs = sup.filter((p) => p.type === t); return xs.length ? `<optgroup label="${l}">${xs.map(opt).join('')}</optgroup>` : ''; };
    // Category filter: only frame shops, print shops or delivery partners in the list.
    const cur = sup.find((p) => p.id === viewAs);
    let cat = ''; try { cat = localStorage.getItem('kalaiSupCat') || ''; } catch { /* */ }
    if (cur && cat && cur.type !== cat) cat = cur.type;
    $('supCat').value = cat;
    const fill = () => {
      const c = $('supCat').value;
      $('viewAs').innerHTML = `<option value="">${c ? 'Choose…' : 'My own portal (studio login)'}</option>${(!c || c === 'FRAMER') ? grp('FRAMER', 'Frame shops') : ''}${(!c || c === 'PRINTER') ? grp('PRINTER', 'Print shops') : ''}${(!c || c === 'COURIER') ? grp('COURIER', 'Delivery partners') : ''}`;
      $('viewAs').value = sup.some((p) => p.id === viewAs && (!c || p.type === c)) ? viewAs : '';
    };
    fill();
    $('pCountry').onchange = () => { try { localStorage.setItem('kalaiPortalCountry', $('pCountry').value); } catch { /* */ } sup = supAll.filter((p) => !$('pCountry').value || countryOf(p) === $('pCountry').value); fill(); };
    $('supCat').onchange = () => { try { localStorage.setItem('kalaiSupCat', $('supCat').value); } catch { /* */ } fill(); };
    if (!$('viewAs').value) viewAs = '';
    $('adminNote').textContent = sup.length ? '' : 'No frame shops or delivery partners yet. Share art.pranixtechno.com/supplier.html with them.';
  } catch (ex) { $('adminNote').textContent = ex.message; }
  // Jump to any artist / frame shop / print shop / courier; the chain of each order under its job card.
  studioBar($('adminBar'), viewAs).catch(() => {});
  chainOnCards($('jList'), 'article.job[data-key]', (c) => c.dataset.key.split(':'));
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
  if (profile && !['FRAMER', 'COURIER', 'PRINTER'].includes(profile.type)) {
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
      <p><b>Please add your price list</b> (${profile.type === 'FRAMER' ? 'frame prices by style and size, and the fixing charge' : profile.type === 'PRINTER' ? 'your print price per size' : 'delivery charges by emirate'}): we compare suppliers on it.</p>
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
  $('jNote').textContent = profile.type === 'PRINTER'
    ? 'Printing jobs from Kalai Art House: accept, download the full-size file, print, mark it printed (the frame shop collects it), then enter your invoice.'
    : profile.type === 'FRAMER'
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
$('signOutBtn').onclick = async () => { await signOut(); groups = []; dropStudio(); $('who').textContent = ''; profile = null; show('loginView'); setMode('in'); };

// ---------- application ----------
const AF = { sWeb: 'portfolio', sBiz: 'business', sName: 'contactName', sPhone: 'phone', sEmirate: 'emirate', sAddr: 'address', sLic: 'tradeLicence', sAbout: 'about', sBank: 'bankName', sAcc: 'accountName', sIban: 'iban' };
function fillApply() {
  Object.entries(AF).forEach(([id, k]) => { if (profile?.[k] != null) $(id).value = profile[k]; });
  const as = new URLSearchParams(location.search).get('as');
  const t = ['COURIER', 'PRINTER'].includes(profile?.type) ? profile.type : as === 'courier' ? 'COURIER' : as === 'printer' ? 'PRINTER' : 'FRAMER';
  document.querySelector(`input[name="sType"][value="${t}"]`).checked = true;
  document.querySelectorAll('input[name="sType"]').forEach((r) => { r.disabled = !!profile?.type && profile.status !== 'REJECTED'; r.onchange = typeText; });
  typeText();
}
function typeText() {
  const ty = document.querySelector('input[name="sType"]:checked').value, fr = ty === 'FRAMER';
  $('sAddrL').textContent = fr ? 'Workshop address (where works are dropped off and collected)' : ty === 'PRINTER' ? 'Shop address (where prints are collected)' : 'Your address / base';
  $('sAboutL').textContent = fr ? 'Your services: frame styles and mouldings, glass/acrylic, mount, usual turnaround, and whether you deliver' : ty === 'PRINTER' ? 'Your services: printers and papers (matte / fine-art / photo), largest size, colour calibration, usual turnaround' : 'Your services: vehicles, areas you cover (emirates), same-day or next-day, and your usual rates';
}
// Approved suppliers (and the studio for them) update their details with the same form: name, contact, address, bank.
let editingDetails = false;
function openDetails() {
  if (studioNoPick()) return;
  editingDetails = true;
  show('applyView'); fillApply();
  $('applyTitle').textContent = 'My details';
  $('applyNote').textContent = 'Update your business, contact, address and bank details. Kalai Art House uses them for jobs, pickups and payments.';
  $('sBtn').textContent = 'Save my details'; $('sBack').hidden = false;
  $('sBack').onclick = () => { editingDetails = false; $('sBtn').textContent = 'Send application'; $('sBack').hidden = true; route(); };
}
$('applyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(Object.entries(AF).map(([id, k]) => [k, $(id).value.trim()]));
  data.type = document.querySelector('input[name="sType"]:checked').value;
  if (data.portfolio && !/^https?:\/\//i.test(data.portfolio)) data.portfolio = `https://${data.portfolio}`;
  data.country = 'UAE';
  const b = $('sBtn'); b.disabled = true; $('sErr').textContent = '';
  try { profile = (await call('apply', data)).profile; if (editingDetails) { $('sErr').textContent = ''; editingDetails = false; $('sBtn').textContent = 'Send application'; $('sBack').hidden = true; } route(); } catch (ex) { $('sErr').textContent = ex.message; } finally { b.disabled = false; }
});

// ---------- jobs ----------
const FR_STEPS = [['ASSIGNED', 'New'], ['ACCEPTED', 'Accepted'], ['READY', 'Framed, ready'], ['COLLECTED', 'Collected']];
const PR_STEPS = [['ASSIGNED', 'New'], ['ACCEPTED', 'Accepted'], ['READY', 'Printed, ready'], ['COLLECTED', 'Collected']];
const DL_STEPS = [['ASSIGNED', 'New'], ['ACCEPTED', 'Accepted'], ['PICKED', 'Picked up'], ['DELIVERED', 'Delivered']];
// Done = cancelled, or invoiced AND the work has left them (collected / delivered). An invoiced frame still waiting for pickup stays in To do.
const isDone = (j) => j.cancelled || (!!j.invoiceNo && (j.role === 'delivery' ? j.stage === 'DELIVERED' : j.stage === 'COLLECTED'));
async function loadJobs() {
  $('jList').innerHTML = '<p class="muted">Loading…</p>';
  // Studio looking at a courier / shop it only researched (prospect): no jobs yet, offer to approve it here.
  if (viewAs && isAdmin() && profile?.status === 'PROSPECT') {
    $('jList').innerHTML = `<div class="sbox" style="display:grid;gap:8px"><b>${esc(profile.business || 'This supplier')} is not a supplier yet</b>
      <span class="muted">It is on the list of suppliers to ask for quotes, so it gets no jobs. Its price list is used for planned costs only. Approve it when you have agreed prices with them: it can then be given jobs, and its prices are used first in costing.</span>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn" type="button" id="jPromote">Make supplier (approve)</button><span class="muted" id="jPromoteMsg"></span></div></div>`;
    $('jPromote').onclick = async () => {
      const b = $('jPromote'); b.disabled = true; $('jPromoteMsg').textContent = 'Saving…';
      try {
        const r = await client.mutations.marketAdmin({ action: 'promoteSupplier', data: JSON.stringify({ id: profile.id }) });
        if (r.errors?.length) throw new Error(r.errors[0].message.replace(/^.*?Error: /, ''));
        const out = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
        profile = out.profile || { ...profile, status: 'APPROVED' };
        $('jPromoteMsg').textContent = '✓ Approved.'; setTimeout(loadJobs, 600);
      } catch (ex) { $('jPromoteMsg').textContent = ex.message; b.disabled = false; }
    };
    return;
  }
  try { jobs = (await call('jobs')).jobs || []; drawJobs(); } catch (ex) { $('jList').innerHTML = `<p class="err">${esc(ex.message)}</p>`; }
}
$('jReload').onclick = loadJobs;
$('jQ').oninput = () => drawJobs(); $('jPick').onchange = () => drawJobs(); $('jClear').onclick = () => { $('jQ').value = ''; $('jPick').value = ''; drawJobs(); };
$('jTabs').querySelectorAll('[data-t]').forEach((b) => { b.onclick = () => { if (b.dataset.t === 'details') { openDetails(); return; } if (b.dataset.t === 'rates') { openRates('jobsView'); return; } if (b.dataset.t === 'frames') { openFrames('jobsView'); return; } tab = b.dataset.t; $('jTabs').querySelectorAll('[data-t]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); drawJobs(); }; });

function addr(x) { return x ? `<b>${esc(x.name)}</b>${x.phone ? ` · <a href="tel:${esc(x.phone)}">${esc(x.phone)}</a>` : ''}${x.address ? `<br>${esc(x.address)}` : ''}` : '–'; }
const STUDIO_WA = '971552996626'; // Kalai Art House WhatsApp
/** Clear instructions on each open job (frame shop, print shop, delivery partner), and who to ask. */
function supGuide(j, fr, pr) {
  if (j.cancelled || j.invoiceNo || ['DELIVERED', 'COLLECTED'].includes(j.stage)) return '';
  const spec = (k) => (j.specs.find(([a]) => a.toLowerCase() === k) || [])[1] || '';
  const ask = `https://wa.me/${STUDIO_WA}?text=${encodeURIComponent(`Hello Kalai Art House, a question about ${pr ? 'printing' : fr ? 'framing' : 'delivery'} job ${j.ref} (${j.title}): `)}`;
  const steps = fr ? [
    `Frame: <b>${esc(spec('framing') || spec('frame') || 'as given in the details above')}</b>.${spec('size') ? ` Size: <b>${esc(spec('size'))}</b>.` : ''} The frame size is the outer size; the artwork keeps its own size and the white mount fills the space around it.`,
    j.printJob ? 'Print first (or collect the print from the print shop shown), then frame it.' : 'When the artwork arrives, check it against the photo here: same picture, same size, no creases, stains or damage. If anything is different or damaged, <b>stop and send us photos</b> before you cut anything.',
    'Mount: acid-free white mount, artwork centred, the mount window overlapping the paper edge by about 5 mm. Keep the artist\'s signature visible. Never trim, glue or fold the artwork: hinge it with acid-free tape only.',
    'Glass: clean on both sides, no dust, hair or fingerprints inside. Close the back neatly and fit D-rings or a hanging wire.',
    `Finish by the date above${j.due ? ` (<b>${esc(j.due)}</b>)` : ''}. If you can't, tell us straight away.`,
    'When it\'s done: send us a photo of the front and back on WhatsApp, then tap <b>Framed, ready for pickup</b>.',
    'Packing: corner protectors, bubble wrap and a stiff carton, with the order number on the box.',
  ] : pr ? [
    `Print from the full-size file (<b>Download the full-size file to print</b>), at <b>${esc(spec('size') || 'the size given above')}</b>, on matte fine-art paper. Don\'t crop or stretch the picture.`,
    'Check the print before handing it over: sharp, true colours, no banding or marks. If the file looks soft or the colours look wrong, <b>ask us before printing</b>.',
    'Keep it flat in a clean sleeve, never rolled or folded, and hand it to the frame shop shown here. Then tap <b>Printed, ready to collect</b>.',
  ] : [
    'Pick up from the address here and check the parcel: corners and glass intact, box not crushed. If it looks damaged, take photos and <b>tell us before you take it</b>.',
    'Framed glass: keep it upright, never under heavy boxes, and keep it dry.',
    'Call the customer before you go, and get a name or photo as proof of delivery. Tap <b>Picked up</b> and <b>Delivered</b> as you go.',
  ];
  return `<details class="guide" ${j.stage === 'ASSIGNED' ? 'open' : ''}><summary><b>How to do this job</b> · ${pr ? 'print size and paper' : fr ? 'frame, mount, glass and packing' : 'pickup and delivery'}</summary>
    <ol>${steps.map((t) => `<li>${t}</li>`).join('')}</ol>
    <div class="guide-ask">Not sure about the ${pr ? 'size, paper or colours' : fr ? 'frame, size, mount or glass' : 'address or timing'}? <b>Please ask before you start.</b> <a href="${esc(ask)}" target="_blank" rel="noopener">Ask Kalai Art House on WhatsApp</a></div></details>`;
}
const podForm = (j, label, action) => `<div class="pod" data-pod><b>Proof of delivery</b> <span class="muted">(needed: name, plus signature or photo)</span>
  <div class="field"><label>Received by (name)</label><input data-podname maxlength="80" placeholder="${esc(j.to?.name || 'Name of the person')}"></div>
  <div class="field"><label>Signature of the receiver</label><canvas data-sign width="520" height="160" style="width:100%;max-width:520px;height:160px;border:1px dashed var(--line);border-radius:6px;background:#fff;touch-action:none"></canvas><button type="button" class="linkbtn" data-signclear>Clear signature</button></div>
  <div class="field"><label>Photos of the delivered parcel (optional, up to 4)</label><input data-podphotos type="file" accept="image/*" capture="environment" multiple></div>
  <div class="field"><label>Note (optional)</label><input data-podnote maxlength="200" placeholder="e.g. left with the building guard"></div>
  <button class="btn small" data-a="${action}">${label}</button></div>`;
function jobCard(j) {
  const fr = j.role === 'framer', pr = j.role === 'printer';
  const steps = fr ? FR_STEPS : pr ? PR_STEPS : DL_STEPS;
  const at = steps.findIndex((s) => s[0] === j.stage);
  const label = j.cancelled ? 'Cancelled: please stop' : j.invoiceNo ? `Invoiced ${j.invoiceNo}` : steps[Math.max(0, at)][1];
  const key = `${j.id}:${j.role}`;
  let act = '';
  if (!j.cancelled) {
    if (j.stage === 'ASSIGNED') {
      act = `${fr && j.canDeliver ? `<label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" data-deliver style="width:auto"> We will also deliver it to the customer${j.deliveryPrice != null ? ` (${aed(j.deliveryPrice)})` : ''}</label>` : ''}
        <button class="btn small" data-a="jobAccept">Accept the job</button>`;
    } else if (pr && j.stage === 'ACCEPTED') act = '<button class="btn small" data-a="jobPrinted">Printed, ready to collect</button>';
    else if (fr && j.stage === 'ACCEPTED' && j.artist && j.artist.stage !== 'SHIPPED') act = `<span class="waitnote">⏳ <b>Status now:</b> Waiting for the artist to send the artwork. You'll be emailed with the courier and AWB when it's on its way.</span>`;
    else if (fr && j.stage === 'ACCEPTED') act = j.collectFrom && !j.collectFrom.ready ? `<span class="waitnote">⏳ <b>Status now:</b> Waiting: ${esc(j.collectFrom.name)} hasn't printed it yet.</span>` : '<button class="btn small" data-a="jobReady">Framed, ready for pickup</button>';
    else if (!fr && !pr && ['ASSIGNED', 'ACCEPTED'].includes(j.stage)) {
      act = j.from && !j.from.ready ? `<span class="waitnote">⏳ <b>Status now:</b> Waiting: ${esc(j.from.name)} hasn't marked it ready yet.</span>`
        : `<div class="inline"><div class="field"><label>${j.label?.awb ? 'Scan or type the airway bill on the parcel' : 'Tracking / AWB (optional)'}</label><input data-awb maxlength="60" ${j.label?.awb ? `placeholder="${esc(j.label.awb)}"` : ''}></div><button class="btn small" data-a="jobPicked">${j.selfDelivery ? 'Out for delivery' : 'Picked up'}</button></div>`;
    } else if (!fr && !pr && j.stage === 'PICKED') act = podForm(j, 'Delivered to the customer', 'jobDelivered');
    else if (!fr && !pr && j.stage === 'DELIVERED' && !j.pod) act = podForm(j, 'Save proof of delivery', 'jobPod');
    const canInvoice = fr || pr ? ['READY', 'COLLECTED'].includes(j.stage) : j.stage === 'DELIVERED';
    if (canInvoice && !j.invoiceNo) act += `<div class="inline"><div class="field"><label>Your invoice no.</label>${j.autoInvoiceNo ? `<input data-inv value="${esc(j.autoInvoiceNo)}" readonly title="Numbered for you by Kalai Art House: your own running series" style="background:var(--sunk,#f3f0ea);font-family:monospace">` : '<input data-inv maxlength="40">'}</div><div class="field"><label>Amount (⃃)</label><input data-amt type="number" min="0" step="0.01" value="${j.price ?? ''}"></div><button class="btn small" data-a="jobInvoice">Send invoice</button></div>`;
  }
  return `<article class="job" data-key="${esc(key)}">
    <div class="row"><h3>${pr ? 'Printing' : fr ? (j.printJob ? 'Print & frame' : 'Framing') : 'Delivery'} · ${esc(j.title)}</h3><span class="stage ${j.cancelled ? 'new' : j.invoiceNo || j.stage === 'DELIVERED' ? 'done' : j.stage === 'ASSIGNED' ? 'new' : ''}">${esc(label)}</span>
      <span class="muted" style="margin-left:auto">Order ${esc(j.ref)} · ${esc(j.kind)} · given ${esc(day(j.assignedAt))}</span></div>
    <div class="steps">${steps.map((s, i) => `<i class="${i <= at ? 'on' : ''}" title="${esc(s[1])}"></i>`).join('')}</div>
    <div class="steplbl">${steps.map((s, i) => `<span class="${i < at ? 'done' : i === at ? 'now' : ''}">${i < at ? '✓ ' : ''}${esc(s[1])}</span>`).join('')}</div>
    <div class="grid2">
      <dl>
        <dt>Agreed price</dt><dd><b>${aed(j.price)}</b></dd>
        ${j.due ? `<dt>Please finish by</dt><dd>${esc(j.due)}</dd>` : ''}
        ${j.note ? `<dt>Note from us</dt><dd>${esc(j.note)}</dd>` : ''}
        ${j.artist ? `<dt>The artwork</dt><dd>${j.artist.stage === 'SHIPPED' ? `<b>On its way to you</b> since ${esc(day(j.artist.sentAt))}${j.artist.courier ? ` · ${esc(j.artist.courier)}` : ''}${j.artist.awb && j.artist.awb !== '–' ? ` · AWB <b>${esc(j.artist.awb)}</b>` : ''}` : j.artist.stage === 'FINISHED' ? `Finished by the artist ${esc(day(j.artist.finishedAt))}, not sent yet` : j.artist.stage === 'STARTED' ? `The artist is making it (started ${esc(day(j.artist.startedAt))})` : 'The artist hasn\'t started yet'}</dd>` : ''}
        ${fr && j.delivering ? '<dt>Delivery</dt><dd>You deliver this one too (see the delivery job)</dd>' : ''}
        ${j.specs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
        ${j.awb && !j.label ? `<dt>Tracking</dt><dd>${esc(j.awb)}</dd>` : ''}
        ${j.pod ? `<dt>Proof of delivery</dt><dd>Received by <b>${esc(j.pod.name)}</b>${j.pod.signed ? ' · signed' : ''}${j.pod.photos ? ` · ${j.pod.photos} photo${j.pod.photos > 1 ? 's' : ''}` : ''} · ${esc(day(j.pod.at))}</dd>` : ''}
        ${j.invoiceNo ? `<dt>Your invoice</dt><dd>${esc(j.invoiceNo)} · ${aed(j.invoiceAmt)}${j.bill ? ' · received' : ''}${j.hasBill ? ' · <button type="button" class="linkbtn" data-invpdf>📄 Open invoice</button>' : ''}</dd>` : ''}
      </dl>
      <dl>
        ${pr ? `<dt>Hand the print to</dt><dd>${addr(j.handTo)}</dd>` : fr ? `${j.collectFrom ? `<dt>Collect the print from</dt><dd>${addr(j.collectFrom)}${j.collectFrom.ready ? ' · <b>ready</b>' : ''}</dd>` : ''}<dt>Deliver to</dt><dd>${addr(j.to)}</dd>` : `<dt>Pick up from</dt><dd>${addr(j.from)}</dd><dt>Deliver to</dt><dd>${addr(j.to)}</dd>`}
      </dl>
    </div>
    ${j.hasPhoto ? `<div style="display:flex;gap:14px;flex-wrap:wrap"><button class="linkbtn" data-photo>Show the ${j.printJob ? 'drawing' : 'artwork photo'}</button>${j.printJob ? '<button class="linkbtn" data-dl>⬇ Download the full-size file to print</button>' : ''}</div><div data-img></div>` : ''}
    ${j.label ? `<div class="awb-box" data-awbbox><div><span class="muted">Airway bill</span> ${j.label.awb ? `<b class="mono">${esc(j.label.awb)}</b>` : ''} · courier <b>${esc(j.label.courier)}</b></div>
      ${awbButtons()}
      <div class="muted" style="font-size:12px">${j.role === 'delivery' ? 'The shop sticks this label on the parcel: scan it at pickup.' : 'Print it (4 × 6 in label, or on A4 and cut it out), stick it on the packed parcel: the courier scans it at pickup.'}</div></div>`
      : j.courier !== undefined && !j.cancelled && !j.invoiceNo ? `<div class="awb-box muted">${j.courier ? `Courier <b>${esc(j.courier)}</b> collects it from you: the airway bill (barcode / QR label) appears here when you mark it ${pr ? 'printed' : 'ready'}.` : pr ? (j.handTo?.name ? `<b>${esc(j.handTo.name)}</b> (frame shop) collects the print from you: no courier label needed.` : 'Kalai Art House tells you who collects the print (usually the frame shop): no courier label needed.') : 'Kalai Art House allocates the courier: the airway bill label appears here once it is.'}</div>` : ''}
    ${supGuide(j, fr, pr)}
    <div style="display:grid;gap:8px;justify-items:start">${act}</div>
    <div class="err" data-msg></div>
  </article>`;
}
// Search box + order drop-down above the jobs (order no., title, customer, addresses, AWB).
const jobText = (j) => [j.ref, j.title, j.kind, j.awb, j.label?.awb, j.to?.name, j.to?.address, j.from?.name, j.artist?.awb, j.artist?.courier, j.note, j.invoiceNo].filter(Boolean).join(' ').toLowerCase();
function drawJobs() {
  const inTab = jobs.filter((j) => (tab === 'all' ? true : tab === 'done' ? isDone(j) : !isDone(j)));
  const pick = $('jPick'), q = ($('jQ')?.value || '').trim().toLowerCase();
  if (pick) {
    const cur = pick.value, seen = new Set();
    pick.innerHTML = `<option value="">All orders (${inTab.length})</option>` + inTab.filter((j) => !seen.has(j.ref) && seen.add(j.ref)).map((j) => `<option value="${esc(j.ref)}">${esc(j.ref)} · ${esc(String(j.title || '').slice(0, 60))}${j.to?.name ? ` · ${esc(j.to.name)}` : ''}</option>`).join('');
    pick.value = seen.has(cur) ? cur : '';
  }
  const list = inTab.filter((j) => (!pick?.value || j.ref === pick.value) && (!q || q.split(/\s+/).every((w) => jobText(j).includes(w))));
  $('jList').innerHTML = list.length ? list.map(jobCard).join('') : `<div class="sbox"><p class="muted" style="margin:0">${($('jQ')?.value || $('jPick')?.value) && inTab.length ? 'No order matches the search.' : tab === 'open' ? 'No open jobs right now. We email you when there is a new one.' : 'Nothing here yet.'}</p></div>`;
  $('jList').querySelectorAll('.job').forEach((card) => {
    const [id, role] = card.dataset.key.split(':');
    const msg = card.querySelector('[data-msg]');
    const labelOf = async () => (await call('jobLabel', { id, role })).label;
    wireAwb(card.querySelector('[data-awbbox]'), labelOf, (t, ok) => { msg.textContent = t; msg.style.color = ok ? 'var(--ok, #2e7d32)' : ''; });
    card.querySelector('[data-invpdf]')?.addEventListener('click', () => openPdf(() => call('jobInvoicePdf', { id, role }), (ex) => { msg.textContent = ex.message; }));
    const dl = card.querySelector('[data-dl]');
    if (dl) dl.onclick = async () => {
      dl.disabled = true;
      try { const r = await call('jobPhoto', { id, role, download: true }); location.href = r.url; } catch (ex) { msg.textContent = ex.message; }
      dl.disabled = false;
    };
    const ph = card.querySelector('[data-photo]');
    if (ph) ph.onclick = async () => {
      ph.disabled = true;
      try { const r = await call('jobPhoto', { id, role }); card.querySelector('[data-img]').innerHTML = `<a href="${esc(r.url)}" target="_blank" rel="noopener"><img class="photo" alt="Artwork to frame" src="${esc(r.url)}" onload="this.closest('[data-img]').querySelector('[data-px]').textContent=this.naturalWidth+' × '+this.naturalHeight+' px'"></a><div class="muted" data-px></div><div class="muted">Tap to open full size (link works for 15 minutes).</div>`; ph.hidden = true; }
      catch (ex) { msg.textContent = ex.message; ph.disabled = false; }
    };
    const cv = card.querySelector('[data-sign]');
    let signed = false;
    if (cv) {
      const g = cv.getContext('2d'); g.lineWidth = 2.5; g.lineCap = 'round'; g.strokeStyle = '#111';
      let down = false;
      const pt = (ev) => { const r = cv.getBoundingClientRect(); return [(ev.clientX - r.left) * cv.width / r.width, (ev.clientY - r.top) * cv.height / r.height]; };
      cv.onpointerdown = (ev) => { down = true; cv.setPointerCapture(ev.pointerId); const [x, y] = pt(ev); g.beginPath(); g.moveTo(x, y); };
      cv.onpointermove = (ev) => { if (!down) return; const [x, y] = pt(ev); g.lineTo(x, y); g.stroke(); signed = true; };
      cv.onpointerup = () => { down = false; };
      card.querySelector('[data-signclear]').onclick = () => { g.clearRect(0, 0, cv.width, cv.height); signed = false; };
    }
    card.querySelectorAll('[data-a]').forEach((b) => {
      b.onclick = async () => {
        const a = b.dataset.a, data = { id, role };
        if (a === 'jobDelivered' || a === 'jobPod') {
          const name = card.querySelector('[data-podname]').value.trim(), files = [...(card.querySelector('[data-podphotos]').files || [])].slice(0, 4);
          if (!name) { msg.textContent = 'Enter the name of the person who received it.'; return; }
          if (!signed && !files.length) { msg.textContent = "Add the receiver's signature or a photo of the delivered parcel."; return; }
          b.disabled = true; msg.textContent = 'Uploading the proof…';
          try {
            const ref = (jobs.find((x) => x.id === id && x.role === role) || {}).ref || id;
            let signKey = '';
            if (signed) { const blob = await new Promise((ok) => cv.toBlob(ok, 'image/png')); signKey = (await uploadData({ path: ({ identityId }) => `uploads/${identityId}/pod/${ref}-signature-${Date.now()}.png`, data: blob, options: { contentType: 'image/png' } }).result).path; }
            const photoKeys = [];
            for (const [i, f] of files.entries()) { if (f.size > 12 * 1024 * 1024) throw new Error('A photo is too large (12 MB at most).'); photoKeys.push((await uploadData({ path: ({ identityId }) => `uploads/${identityId}/pod/${ref}-photo-${i + 1}-${Date.now()}.${(f.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')}`, data: f, options: { contentType: f.type || 'image/jpeg' } }).result).path); }
            data.pod = { name, signKey, photoKeys, note: card.querySelector('[data-podnote]').value.trim() };
          } catch (ex) { msg.textContent = ex.message || 'Upload failed.'; b.disabled = false; return; }
        }
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
// Courier prices per country (and optionally a region / state / city in it). These win over the zone price.
const CNAMES = COUNTRIES.map((c) => c.key).filter((k) => k !== 'UAE');
const ZONE_OF_NAME = Object.fromEntries(RC_ZONES);
const ccRow = (country, region, row) => `<tr data-cc>
  <td><select data-cc-country style="max-width:170px">${CNAMES.map((c) => `<option ${c === country ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
    <div class="muted" style="font-size:11px" data-cc-zone>Zone: ${esc(ZONE_OF_NAME[zoneOf(country)] || '')}</div></td>
  <td><input data-cc-region maxlength="60" value="${esc(region)}" placeholder="All of the country" ${country === 'India' ? 'list="rcInStates"' : ''} style="width:150px"></td>
  ${RC_PARCELS.map(([k]) => `<td><input type="number" min="0" step="0.5" data-cp="${k}" value="${parcelPrice(row, k === 's1' ? 'A3' : k) ?? ''}" placeholder="–"></td>`).join('')}
  <td><button type="button" class="linkbtn" data-cc-del title="Remove this row">✕</button></td></tr>`;
function countrySection(card) {
  const rows = Object.entries(card.country || {}).map(([k, v]) => { const [c, r = ''] = k.split('|'); return ccRow(c, r, v); }).join('');
  return `<h3 style="font-size:15px;margin:16px 0 4px">Prices by country and region (optional)</h3>
    <p class="muted" style="font-size:12px;margin:0 0 6px">Your price to a country, or to one state / province / city in it. Kalai uses the region price first, then the country price, then the zone price above. Leave the region empty for the whole country.</p>
    <div style="overflow-x:auto"><table class="rc" id="rcCountry"><thead><tr><th>Country</th><th>Region (optional)</th>${RC_PARCELS.map(([, n]) => `<th>${esc(n)}</th>`).join('')}<th></th></tr></thead>
      <tbody>${rows || '<tr data-cc-empty><td colspan="8" class="muted">No country prices yet.</td></tr>'}</tbody></table></div>
    <datalist id="rcInStates">${IN_STATES.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">
      <select id="rcAddPick" style="max-width:260px"><optgroup label="A whole zone">${RC_ZONES.map(([z, n]) => `<option value="zone:${z}">All of ${esc(n)} (${countriesInZone(z, CNAMES).length})</option>`).join('')}</optgroup>
        <optgroup label="One country">${CNAMES.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</optgroup></select>
      <button type="button" class="btn small ghost" id="rcAdd">Add</button>
      <input id="rcFind" placeholder="Find a country in the list…" style="max-width:200px">
    </div>`;
}
function wireCountries() {
  const tb = $('rcCountry')?.querySelector('tbody'); if (!tb) return;
  const have = () => new Set([...tb.querySelectorAll('[data-cc]')].map((r) => `${r.querySelector('[data-cc-country]').value}|${r.querySelector('[data-cc-region]').value.trim()}`.toLowerCase()));
  const add = (names) => {
    const h = have(); tb.querySelector('[data-cc-empty]')?.remove();
    const fresh = names.filter((c) => !h.has(`${c}|`.toLowerCase()));
    tb.insertAdjacentHTML('beforeend', fresh.map((c) => ccRow(c, '', null)).join(''));
    if (!fresh.length && names.length === 1) { tb.insertAdjacentHTML('beforeend', ccRow(names[0], '', null)); $('rMsg').textContent = `${names[0]} is already listed, so another ${names[0]} row was added: type the region (state / province / city) it is for.`; }
    else $('rMsg').textContent = fresh.length ? `${fresh.length} ${fresh.length === 1 ? 'country' : 'countries'} added. Fill in the prices, then press Save my price list.` : 'Those countries are already in the list.';
    tb.lastElementChild?.scrollIntoView({ block: 'nearest' });
  };
  $('rcAdd').onclick = () => { const v = $('rcAddPick').value; add(v.startsWith('zone:') ? countriesInZone(v.slice(5), CNAMES) : [v]); };
  $('rcFind').oninput = () => { const q = $('rcFind').value.trim().toLowerCase(); if (!q) return; const o = [...$('rcAddPick').options].find((x) => !x.value.startsWith('zone:') && x.value.toLowerCase().startsWith(q)) || [...$('rcAddPick').options].find((x) => !x.value.startsWith('zone:') && x.value.toLowerCase().includes(q)); if (o) $('rcAddPick').value = o.value; };
  tb.addEventListener('click', (ev) => { if (ev.target.closest('[data-cc-del]')) ev.target.closest('tr').remove(); });
  tb.addEventListener('change', (ev) => {
    const sel = ev.target.closest('[data-cc-country]'); if (!sel) return;
    const tr = sel.closest('tr'); tr.querySelector('[data-cc-zone]').textContent = `Zone: ${ZONE_OF_NAME[zoneOf(sel.value)] || ''}`;
    const r = tr.querySelector('[data-cc-region]'); if (sel.value === 'India') r.setAttribute('list', 'rcInStates'); else r.removeAttribute('list');
  });
}
/** Country rows from the screen: { "India": {...}, "India|Kerala": {...} }; rows without any price are dropped. */
function readCountries() {
  const out = {}; let bad = false;
  $('rGrid').querySelectorAll('[data-cc]').forEach((tr) => {
    const c = tr.querySelector('[data-cc-country]').value, r = tr.querySelector('[data-cc-region]').value.trim().replace(/\|/g, ' ');
    const row = {};
    tr.querySelectorAll('[data-cp]').forEach((i) => { if (i.value === '') return; const v = Number(i.value); if (!(v >= 0 && v <= 5000)) bad = true; else row[i.dataset.cp] = v; });
    if (Object.keys(row).length) out[r ? `${c}|${r}` : c] = row;
  });
  return { rows: out, bad };
}
function openRates(back) {
  if (studioNoPick()) return;
  ratesBack = back;
  // As entered: a supplier in India keeps its prices in rupees.
  const card = rawCard(profile), fr = profile.type === 'FRAMER';
  const pr = profile.type === 'PRINTER';
  const cur = card.currency || (/india/i.test(`${profile.country || ''} ${profile.city || ''} ${profile.address || ''}`) || card.from === 'India' ? 'INR' : 'AED'), S = cur === 'INR' ? '₹' : '⃃';
  $('rTitle').textContent = pr ? 'My print prices' : fr ? 'My frame price list' : 'My delivery charges';
  $('rNote').textContent = pr ? `Your price in ${S} to print one copy on good matte / fine-art paper from the full-size file we send, per size (leave blank if you don't print that size). A4 = 21×30 cm, A3 = 30×42 cm.` : fr
    ? `Your price per frame, in ${S}, for each style and size you offer (leave blank if you don't offer it). A4 = 21×30 cm, A3 = 30×42 cm; other sizes are the outside frame size in cm. Add the fixing charge per size (mount, glass and fitting the work), or tick “included” if your frame prices already include it.`
    : `Your charge in ${S} to deliver one framed work (packed, with glass) from where you ship (below), by frame size. Leave a size blank if you don\'t take it. Outside the UAE is optional: a price per zone, and if you like a price per country or region.`;
  $('rGrid').innerHTML = pr
    ? `<table class="rc"><thead><tr><th>Size</th><th>Print price (${S})</th></tr></thead><tbody>${['A4', 'A3', '30×40', '40×50', '50×70', '60×80', '70×100'].map((z) => `<tr><th>${esc(z)}</th><td>${cell(`print.${z}`, card.print?.[z])}</td></tr>`).join('')}</tbody></table>`
    : fr
    ? `<table class="rc"><thead><tr><th>Size</th>${RC_STYLES.map(([, n]) => `<th>${esc(n)}</th>`).join('')}<th>Fixing charge</th></tr></thead><tbody>
        ${RC_SIZES.map((sz) => `<tr><th>${esc(sz)}</th>${RC_STYLES.map(([k]) => `<td>${cell(`frames.${k}.${sz}`, card.frames?.[k]?.[sz])}</td>`).join('')}<td>${cell(`fixing.${sz}`, card.fixing?.[sz])}</td></tr>`).join('')}</tbody></table>
       <label style="display:flex;gap:8px;align-items:center;font-weight:400;margin-top:8px"><input type="checkbox" id="rIncl" style="width:auto" ${card.fixingIncluded ? 'checked' : ''}> Fixing (mount, glass, fitting) is included in my frame prices</label>
       <h3 style="font-size:15px;margin:14px 0 4px">Printing (customers' photos and children's drawings)</h3>
       <p class="muted" style="font-size:12px;margin:0 0 6px">Your price to print one copy on good matte / fine-art paper from the photo we send (we send the full-size file). Leave blank if you don't print.</p>
       <table class="rc"><thead><tr><th>Size</th><th>Print price</th></tr></thead><tbody>${PRINT_SIZES.map((z) => `<tr><th>${esc(z)}</th><td>${cell(`print.${z}`, card.print?.[z])}</td></tr>`).join('')}</tbody></table>
       <h3 style="font-size:15px;margin:14px 0 4px">If you also deliver: your delivery charge to each emirate (optional)</h3>
       <table class="rc"><thead><tr><th>To</th><th>Small parcel (up to A3 / 40×50)</th><th>Large parcel</th></tr></thead><tbody>
        ${RC_EMIRATES.map((em) => `<tr><th>${esc(em)}</th><td>${cell(`uae.${em}.small`, card.uae?.[em]?.small)}</td><td>${cell(`uae.${em}.large`, card.uae?.[em]?.large)}</td></tr>`).join('')}</tbody></table>`
    : `<div class="field" style="max-width:280px;margin:8px 0"><label for="rFrom">I ship from</label><select id="rFrom"><option value="UAE" ${(card.from || 'UAE') === 'UAE' ? 'selected' : ''}>UAE (Dubai)</option><option value="India" ${card.from === 'India' ? 'selected' : ''}>India</option></select></div>
       <table class="rc"><thead><tr><th>To</th>${RC_PARCELS.map(([, n]) => `<th>${esc(n)}</th>`).join('')}</tr></thead><tbody>
        ${RC_EMIRATES.map((em) => `<tr><th>${esc(em)}</th>${pRow(`uae.${em}`, card.uae?.[em])}</tr>`).join('')}
        <tr><th colspan="${RC_PARCELS.length + 1}" style="padding-top:12px">Outside the UAE (optional): price per zone</th></tr>
        ${RC_ZONES.map(([z, n]) => `<tr><th>${esc(n)}</th>${pRow(`intl.${z}`, card.intl?.[z])}</tr>`).join('')}</tbody></table>
       ${countrySection(card)}`;
  $('rNotes').value = card.notes || '';
  // Currency of the whole price list (frame shops and couriers in India quote in rupees).
  $('rCurWrap')?.remove();
  $('rGrid').insertAdjacentHTML('beforebegin', `<div class="field" id="rCurWrap" style="max-width:280px;margin:8px 0"><label for="rCur">My prices are in</label><select id="rCur"><option value="AED" ${cur === 'AED' ? 'selected' : ''}>UAE dirhams (⃃)</option><option value="INR" ${cur === 'INR' ? 'selected' : ''}>Indian rupees (₹)</option></select></div>`);
  if (!fr && !pr) wireCountries();
  // Studio only: fill a courier's empty list with market estimates (Aramex-type retail rates, Oct 2026) until real prices come.
  $('rEst')?.remove();
  if (!fr && !pr && isAdmin() && viewAs && (card.from || 'UAE') === 'UAE') { // UAE couriers only; fills empty cells only
    const b = document.createElement('button'); b.type = 'button'; b.id = 'rEst'; b.className = 'btn small ghost'; b.style.margin = '0 0 10px';
    b.textContent = 'Fill with market estimates (until real prices)';
    b.onclick = () => {
      const near = [22, 35, 55, 75, 130], far = [32, 45, 65, 90, 150];
      RC_EMIRATES.forEach((em) => RC_PARCELS.forEach(([k], i) => {
        const inp = $('rGrid').querySelector(`[data-n="uae.${em}.${k}"]`);
        if (inp && inp.value === '') inp.value = (['Dubai', 'Sharjah', 'Ajman'].includes(em) ? near : far)[i];
      }));
      // Outside the UAE: rough express-courier retail per zone, framed and boxed (volumetric weight).
      const zone = { A: [60, 85, 120, 160, 240], B: [90, 125, 175, 235, 340], C: [140, 195, 275, 365, 530], D: [170, 235, 325, 435, 630], E: [190, 265, 365, 485, 700] };
      RC_ZONES.forEach(([z]) => RC_PARCELS.forEach(([k], i) => { const inp = $('rGrid').querySelector(`[data-n="intl.${z}.${k}"]`); if (inp && inp.value === '') inp.value = zone[z][i]; }));
      if (!$('rNotes').value.trim()) $('rNotes').value = 'Estimates only, until business rates. Charged on volumetric weight (L×W×H ÷ 5000). Remote areas (Liwa, Ruwais, Western Region, RAK mountains) add about ⃃ 20+. 70×100 may need freight handling. Glass is fragile: pack well or use acrylic for large sizes. Artworks may be excluded from courier cover.';
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
    const v = Number(i.value); if (!(v >= 0 && v <= ($('rCur')?.value === 'INR' ? 200000 : 5000))) { bad = true; return; }
    const path = i.dataset.n.split('.'); let o = data;
    path.slice(0, -1).forEach((k) => { o = o[k] ??= {}; });
    o[path[path.length - 1]] = v;
  });
  if ($('rcCountry')) { const cc = readCountries(); if (cc.bad) bad = true; data.country = cc.rows; }
  if (bad) { $('rErr').textContent = $('rCur')?.value === 'INR' ? 'Enter amounts in ₹ from 0 to 2,00,000.' : 'Enter amounts in ⃃ from 0 to 5,000.'; return; }
  if ($('rCur')) data.currency = $('rCur').value;
  if ($('rIncl')) data.fixingIncluded = $('rIncl').checked;
  if ($('rFrom')) data.from = $('rFrom').value;
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
  if (studioNoPick()) return;
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
      <div class="field"><label>Extra over price list (⃃)</label><input data-k="extra" type="number" min="0" step="0.5" value="${f.extra ?? ''}" placeholder="0"></div>
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
