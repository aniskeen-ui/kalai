// Artist desk (Siva): price works for Kalai Art House. No customer details or selling prices are shown here.
import './amplify-config.js';
import { signIn, signOut, getCurrentUser, fetchAuthSession, fetchUserAttributes } from 'aws-amplify/auth';
import { generateClient } from 'aws-amplify/data';

const client = generateClient();
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

let items = [];
let filter = 'NEEDED';

function show(view) {
  ['loginView', 'denyView', 'deskView'].forEach((v) => { $(v).hidden = v !== view; });
  $('signOutBtn').hidden = view === 'loginView';
}

async function start() {
  try { await getCurrentUser(); } catch { show('loginView'); $('lEmail').focus(); return; }
  const attrs = await fetchUserAttributes().catch(() => ({}));
  $('who').textContent = attrs.email || '';
  const session = await fetchAuthSession();
  const groups = session.tokens?.accessToken?.payload?.['cognito:groups'] || [];
  if (!groups.includes('ARTISTS') && !groups.includes('ADMINS')) { show('denyView'); return; }
  show('deskView');
  await load();
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const b = e.target.querySelector('button'); b.disabled = true; $('loginErr').textContent = '';
  try {
    const { nextStep } = await signIn({ username: $('lEmail').value.trim().toLowerCase(), password: $('lPass').value });
    if (nextStep.signInStep !== 'DONE') throw new Error('Finish setting up this account on art.pranixtechno.com first.');
    await start();
  } catch (ex) {
    $('loginErr').textContent = ex.name === 'NotAuthorizedException' || ex.name === 'UserNotFoundException' ? 'Email or password is incorrect.' : (ex.message || 'Sign-in failed.');
  } finally { b.disabled = false; }
});
$('signOutBtn').onclick = async () => { await signOut(); $('who').textContent = ''; show('loginView'); };
$('reload').onclick = load;
document.querySelectorAll('.tabs [data-f]').forEach((b) => {
  b.onclick = () => {
    filter = b.dataset.f;
    document.querySelectorAll('.tabs [data-f]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  };
});

async function load() {
  $('list').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { data, errors } = await client.queries.artistList();
    if (errors?.length) throw new Error(errors[0].message);
    items = parse(data) || [];
    render();
  } catch (ex) {
    $('list').innerHTML = `<p class="err">Could not load the list: ${esc(ex.message)}</p>`;
  }
}

function render() {
  const needed = items.filter((x) => x.stage === 'NEEDED');
  $('cNeeded').textContent = needed.length ? `(${needed.length})` : '';
  const list = filter === 'NEEDED' ? needed
    : filter === 'OPEN' ? items.filter((x) => ['ORDERED', 'INVOICED', 'PAID'].includes(x.stage))
    : items;
  if (!list.length) {
    $('list').innerHTML = `<p class="muted">${filter === 'NEEDED' ? 'Nothing to price right now.' : filter === 'OPEN' ? 'No orders yet. Orders appear here once a customer has paid.' : 'No enquiries yet.'}</p>`;
    return;
  }
  $('list').innerHTML = list.map(card).join('');
  list.forEach((x) => wire(x));
}

function card(x) {
  const brief = x.brief.map(({ k, v }) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  const dis = x.locked ? 'disabled' : '';
  return `<article class="acard" id="c-${esc(x.id)}">
    <div class="ameta"><span class="mono">${esc(x.ref)}</span><span>${esc(day(x.createdAt))}</span><span>${x.kind === 'COMMISSION' ? 'Commission' : 'Catalogue work'}</span><span class="stage ${esc(x.stage)}">${esc(x.label)}</span></div>
    <h2>${esc(x.title)}</h2>
    ${brief ? `<dl class="brief">${brief}</dl>` : ''}
    ${x.hasPhoto ? `<div><button type="button" class="linkbtn" data-photo="${esc(x.id)}">View the customer's reference photo</button> <span class="muted" id="ph-${esc(x.id)}" style="font-size:13px"></span></div>` : ''}
    <form class="aform" data-id="${esc(x.id)}" novalidate>
      <div class="field"><label for="p-${esc(x.id)}">Your price (INR)</label><input id="p-${esc(x.id)}" type="number" min="1" step="1" inputmode="numeric" value="${x.artistPriceInr ?? ''}" ${dis} required></div>
      <div class="field"><label for="r-${esc(x.id)}">Ready to ship by</label><input id="r-${esc(x.id)}" type="date" value="${esc(x.artistReadyBy)}" ${dis}></div>
      <div class="field"><label for="n-${esc(x.id)}">Note (optional)</label><input id="n-${esc(x.id)}" value="${esc(x.artistNote)}" placeholder="e.g. needs 5 days" ${dis}></div>
      <div class="field wide"><button class="btn" type="submit" ${dis}>${x.artistPriceInr ? 'Update price' : 'Send price'}</button></div>
      <div class="wide ok" id="m-${esc(x.id)}" role="status">${x.locked ? 'Price fixed: order placed.' : ''}</div>
    </form>
  </article>`;
}

function wire(x) {
  const form = document.querySelector(`form[data-id="${CSS.escape(x.id)}"]`);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = $('m-' + x.id);
    form.querySelectorAll('.err').forEach((e) => e.remove());
    const price = Number($('p-' + x.id).value);
    if (!(price > 0)) { msg.insertAdjacentHTML('afterend', '<div class="wide err">Enter your price in INR.</div>'); return; }
    const b = form.querySelector('button'); b.disabled = true; msg.textContent = 'Sending…';
    try {
      const { errors } = await client.mutations.artistQuote({ id: x.id, priceInr: price, readyBy: $('r-' + x.id).value || null, note: $('n-' + x.id).value.trim() || null });
      if (errors?.length) throw new Error(errors[0].message);
      Object.assign(x, { artistPriceInr: price, artistReadyBy: $('r-' + x.id).value, artistNote: $('n-' + x.id).value.trim() });
      if (x.stage === 'NEEDED') Object.assign(x, { stage: 'PRICED', label: 'Price given · waiting for customer' });
      msg.textContent = `Sent: INR ${price.toLocaleString('en-IN')}. Kalai Art House can see it now.`;
      b.textContent = 'Update price';
      const pill = document.querySelector(`#c-${CSS.escape(x.id)} .stage`);
      if (pill) { pill.className = `stage ${x.stage}`; pill.textContent = x.label; }
      $('cNeeded').textContent = items.filter((i) => i.stage === 'NEEDED').length ? `(${items.filter((i) => i.stage === 'NEEDED').length})` : '';
    } catch (ex) {
      msg.textContent = '';
      msg.insertAdjacentHTML('afterend', `<div class="wide err">Could not send: ${esc(ex.message)}</div>`);
    } finally { b.disabled = x.locked; }
  });
  const pb = document.querySelector(`[data-photo="${CSS.escape(x.id)}"]`);
  if (pb) pb.onclick = async () => {
    const out = $('ph-' + x.id); out.textContent = 'Opening…';
    try {
      const { data, errors } = await client.queries.artistPhoto({ id: x.id });
      if (errors?.length) throw new Error(errors[0].message);
      const { url } = parse(data);
      out.innerHTML = `<a href="${esc(url)}" target="_blank" rel="noopener">Open photo</a> (link works for 15 minutes)`;
    } catch (ex) { out.textContent = 'Could not open the photo: ' + ex.message; }
  };
}

start();
