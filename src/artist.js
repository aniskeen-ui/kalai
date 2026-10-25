// Artist desk (Siva): price works for Kalai Art House. No customer details or selling prices are shown here.
import './amplify-config.js';
import './skin.js';
import { signIn, signOut, getCurrentUser, fetchAuthSession, fetchUserAttributes } from 'aws-amplify/auth';
import { generateClient } from 'aws-amplify/data';
import { getUrl } from 'aws-amplify/storage';
import { wireFind } from './find.js';
import { SUGGEST } from './suggest.js';
import { cleanTitle } from './title.js';

const client = generateClient();
// Shown inside the artist & seller portal (seller.html "Studio orders" tab): no own header there.
if (new URLSearchParams(location.search).get('embed') === '1') {
  document.documentElement.classList.add('embed');
  const st = document.createElement('style'); st.textContent = 'html.embed header.top{display:none} html.embed body{background:transparent}'; document.head.appendChild(st);
}
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

let items = [];
let filter = 'OPEN';

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
  isAdmin = groups.includes('ADMINS');
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
$('reload').onclick = () => (filter === 'WORKS' ? renderWorks(true) : load());
document.querySelectorAll('.tabs [data-f]').forEach((b) => {
  b.onclick = () => {
    filter = b.dataset.f;
    $('qSt').value = filter === 'ALL' ? '' : 'OPEN';
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
    if (filter !== 'WORKS') renderWorks().catch(() => {});
  } catch (ex) {
    $('list').innerHTML = `<p class="err">Could not load the list: ${esc(ex.message)}</p>`;
  }
}

// ---------- Name my works: give each catalogue picture a real title (shown on the website) ----------
let works = null;
async function renderWorks(force = false) {
  if (!works || force) {
    if (filter === 'WORKS') $('list').innerHTML = '<p class="muted">Loading your works…</p>';
    try {
      const r = await client.mutations.artistWorks({ action: 'list' });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      works = (parse(r.data) || {}).works || [];
    } catch (ex) { if (filter === 'WORKS') $('list').innerHTML = `<p class="err">Could not load your works: ${esc(ex.message)}</p>`; return; }
  }
  const todo = works.filter((w) => !w.named || w.artistPrice == null).length;
  $('cWorks').textContent = todo ? `(${todo})` : '';
  if (filter !== 'WORKS') return;
  if (!works.length) { $('list').innerHTML = '<p class="muted">No works in the catalogue yet.</p>'; return; }
  $('list').innerHTML = `<div style="display:flex;gap:8px;align-items:center"><input id="wFind" type="search" placeholder="Find a work: AT-… code or title" aria-label="Find a work" style="max-width:320px"><select id="wFilter" aria-label="Show" style="width:auto"><option value="">All works</option><option value="priced">Priced</option><option value="unpriced">Not priced</option><option value="unnamed">Not named</option><option value="live">On the website</option><option value="notlive">Not on the website (draft / scheduled)</option><option value="sold">Sold</option></select><span class="muted find-count" style="font-size:12px"></span></div><p class="muted" style="margin:0 0 4px">Give each work a real title, as customers will see it on the website (e.g. “Temple Steps at Dawn”). Until then the website shows a tidied-up version of the file name, or just “Original”. Also give <b>your price in rupees</b> for the artwork itself (paper only, no frame): Kalai Art House adds framing and delivery. ${todo ? `<b>${todo} still to name or price.</b>` : '<b class="wdone">All named and priced. Thank you!</b>'}</p>
    <div class="saveall"><button type="button" class="btn small" id="saveAllW">Save all changes</button><span class="muted" id="saveAllMsg" style="font-size:12px">Change titles, sizes, prices or days on as many works as you like, then save them all at once.</span></div>`
    + works.map((w) => `<article class="acard wcard" data-w="${esc(w.id)}" data-code="${esc(w.code)}"><img alt="" data-key="${esc(w.imageKey)}">
      <form novalidate>
        ${w.code ? `<div class="muted" style="font-size:12px;font-family:var(--mono)">${esc(w.code)} · <span style="font-family:var(--body)">${w.status === 'PUBLISHED' ? '<b style="color:var(--ok)">On the website</b>' : w.status === 'SOLD' ? '<b>Sold</b>' : 'Not on the website yet'}${w.artistPrice != null ? ' · priced' : ' · <b style="color:var(--kumkum)">no price</b>'}</span></div>` : ''}<div class="field"><label>Title${!w.named && shownTitle(w) ? ` <span class="muted" style="font-weight:400">(${webTitle(w) ? 'as on the website' : 'suggested'}: change it if you like, then Save)</span>` : ''}</label><input name="title" maxlength="80" value="${esc(shownTitle(w))}" placeholder="A short, meaningful title"></div>
        <div class="two" style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div class="field"><label>Size (paper)</label><input name="size" maxlength="40" value="${esc(w.size)}" placeholder="e.g. 38 × 28 cm"></div>
        <div class="field"><label>My price (₹, artwork only)</label><input name="price" type="number" min="100" step="50" inputmode="numeric" value="${w.artistPrice ?? ''}" placeholder="e.g. 3000"></div></div>
        <div class="field" style="max-width:260px"><label>Ready to send in (days)</label><input name="leadDays" maxlength="9" value="${w.leadDays == null ? '' : w.leadMax != null && w.leadMax !== w.leadDays ? `${w.leadDays}-${w.leadMax}` : w.leadDays}" placeholder="e.g. 7 or 10-15 (0 = ready now)"></div>
        <div class="field"><label>About this work (optional)</label><textarea name="description" rows="2" maxlength="1000" placeholder="What it shows, where, the story behind it">${esc(w.description || (!w.named && SUGGEST[w.code] ? SUGGEST[w.code][2] : ''))}</textarea></div>
        <div style="display:flex;gap:10px;align-items:center"><button class="btn small" type="submit">Save</button><span class="ok" data-m>${w.named ? `<span class="wdone">✓ Named${w.artistPrice != null ? ' · priced' : ''}</span>` : ''}</span></div>
      </form></article>`).join('');
  const findRun = wireFind($('wFind'), '.wcard', document, (el) => `${el.dataset.code || ''} ${el.querySelector('[name=title]')?.value || ''}`);
  // Filter by state on top of the search (title or AT- code).
  const wf = () => {
    const v = $('wFilter').value;
    findRun();
    let shown = 0;
    document.querySelectorAll('.wcard').forEach((el) => {
      const w = works.find((x) => x.id === el.dataset.w) || {};
      const ok = !v || (v === 'priced' ? w.artistPrice != null : v === 'unpriced' ? w.artistPrice == null : v === 'unnamed' ? !w.named : v === 'live' ? w.status === 'PUBLISHED' : v === 'sold' ? w.status === 'SOLD' : !['PUBLISHED', 'SOLD'].includes(w.status));
      if (!ok) el.hidden = true; else if (!el.hidden) shown++;
    });
    const note = $('wFind').parentElement.querySelector('.find-count'); if (note && v) note.textContent = `${shown} of ${works.length}`;
  };
  $('wFilter').onchange = wf; $('wFind').addEventListener('input', () => setTimeout(wf, 0));
  document.querySelectorAll('.wcard img[data-key]').forEach(async (img) => {
    try { img.src = (await getUrl({ path: img.dataset.key, options: { expiresIn: 3600 } })).url.toString(); } catch { /* no picture */ }
  });
  // Each work remembers whether it was changed; "Save all changes" saves just those (unnamed works with a suggested title too).
  document.querySelectorAll('.wcard form').forEach((f) => f.addEventListener('input', () => { f.dataset.dirty = '1'; $('saveAllMsg').textContent = `${document.querySelectorAll('.wcard form[data-dirty]').length} work(s) changed: press Save all changes.`; }));
  if ($('saveAllW')) $('saveAllW').onclick = async () => {
    const forms = [...document.querySelectorAll('.wcard form')].filter((f) => f.dataset.dirty || (!works.find((x) => x.id === f.closest('.wcard').dataset.w)?.named && f.title.value.trim().length >= 2));
    if (!forms.length) { $('saveAllMsg').textContent = 'Nothing changed yet.'; return; }
    $('saveAllW').disabled = true; let n = 0, bad = 0;
    for (const f of forms) {
      await f.onsubmit(new Event('submit')); n++;
      if (f.querySelector('.err')) bad++; else delete f.dataset.dirty;
      $('saveAllMsg').textContent = `Saving… ${n} of ${forms.length}`;
    }
    $('saveAllMsg').textContent = bad ? `${n - bad} saved, ${bad} need a fix (see the red notes).` : `${n} works saved.`; $('saveAllW').disabled = false;
  };
  document.querySelectorAll('.wcard form').forEach((f) => {
    f.onsubmit = async (e) => {
      e.preventDefault();
      const id = f.closest('.wcard').dataset.w;
      const m = f.querySelector('[data-m]'); const b = f.querySelector('button'); b.disabled = true; m.textContent = 'Saving…';
      try {
        const r = await client.mutations.artistWorks({ action: 'save', data: JSON.stringify({ id, title: f.title.value, size: f.size.value, description: f.description.value, price: f.price.value, leadDays: f.leadDays.value }) });
        if (r.errors?.length) throw new Error(r.errors[0].message.replace(/^.*?Error: /, ''));
        const w = works.find((x) => x.id === id); Object.assign(w, { title: f.title.value.trim() || w.title, size: f.size.value.trim(), description: f.description.value.trim(), named: f.title.value.trim() ? 'yes' : w.named, artistPrice: f.price.value ? Number(f.price.value) : w.artistPrice, leadDays: f.leadDays.value.trim() === '' ? w.leadDays : Number(f.leadDays.value.match(/\d+/)?.[0]), leadMax: f.leadDays.value.trim() === '' ? w.leadMax : Number((f.leadDays.value.match(/\d+/g) || []).pop()) });
        m.innerHTML = f.title.value.trim() ? '<span class="wdone">✓ Saved: now on the website</span>' : '<span class="wdone">✓ Price saved</span> <span class="muted">· add a title too</span>';
        const todo2 = works.filter((x) => !x.named || x.artistPrice == null).length; $('cWorks').textContent = todo2 ? `(${todo2})` : '';
      } catch (ex) { m.innerHTML = `<span class="err">${esc(ex.message)}</span>`; } finally { b.disabled = false; }
    };
  });
}

// Search: order no. / artwork, customer (code; the studio also sees the name), dates (Dubai time).
let finderSig = '';
function fillFinder() {
  const sig = items.map((x) => x.id + x.customerCode).join();
  if (sig === finderSig) return;
  finderSig = sig;
  $('dlRefs').innerHTML = items.map((x) => `<option value="${esc(x.ref)}">${esc(x.title)}</option>`).join('');
  const cs = new Map();
  items.forEach((x) => { if (!x.customerCode) return; const c = cs.get(x.customerCode) || { code: x.customerCode, name: x.customerName, n: 0 }; c.n++; cs.set(x.customerCode, c); });
  const cur = $('qCust').value;
  $('qCust').innerHTML = '<option value="">All customers</option>' + [...cs.values()].sort((a, b) => (a.name || a.code).localeCompare(b.name || b.code))
    .map((c) => `<option value="${esc(c.code)}">${c.name ? `${esc(c.name)} · ` : ''}${esc(c.code)} (${c.n})</option>`).join('');
  $('qCust').value = cs.has(cur) ? cur : '';
}
const dubaiDay = (iso) => (iso ? new Date(new Date(iso).getTime() + 4 * 3600_000).toISOString().slice(0, 10) : '');
/** The artist's step for the Status filter (what is left for the artist to do). */
function stOf(x) {
  if (x.stage === 'NEEDED') return 'NEEDED';
  if (x.stage === 'PRICED') return 'PRICED';
  if (x.stage === 'CLOSED') return 'CLOSED';
  if (x.stage === 'PAID') return 'PAID';
  if (x.stage === 'INVOICED') return 'INVOICED';
  if (x.stopped) return 'INVOICE'; // cancelled after he started: invoice 50%
  if (x.onHold) return 'HOLD';
  if (x.rework) return 'REWORK';
  return x.progress === 'SHIPPED' ? 'INVOICE' : x.progress === 'FINISHED' ? 'TO_SEND' : x.progress === 'STARTED' ? 'WORKING' : 'TO_START';
}
const OPEN_ST = ['TO_START', 'WORKING', 'TO_SEND', 'REWORK', 'HOLD'];
function stMatch(x) {
  const v = $('qSt').value, st = stOf(x);
  if (!v) return true;
  if (v === 'DELIVERED') return x.orderStatus === 'DELIVERED';
  if (v === 'CANCELLED') return !!x.stopped || x.orderStatus === 'CANCELLED' || x.orderStatus === 'REFUNDED';
  // Work to do: not when the customer's order is already delivered, refunded or cancelled (rework excepted).
  if (v === 'OPEN') return OPEN_ST.includes(st) && (st === 'REWORK' || !['DELIVERED', 'REFUNDED', 'CANCELLED'].includes(x.orderStatus));
  return st === v;
}
function found(x) {
  const q = $('qRef').value.trim().toLowerCase(), c = $('qCust').value, from = $('qFrom').value, to = $('qTo').value;
  return (!q || [x.ref, x.title].some((v) => String(v || '').toLowerCase().includes(q))) && (!c || x.customerCode === c)
    && (!from || dubaiDay(x.createdAt) >= from) && (!to || dubaiDay(x.createdAt) <= to);
}
const searching = () => !!($('qRef').value.trim() || $('qCust').value || $('qFrom').value || $('qTo').value);
let qT;
$('qRef').addEventListener('input', () => { clearTimeout(qT); qT = setTimeout(render, 200); });
['qCust', 'qFrom', 'qTo', 'qSt'].forEach((id) => $(id).addEventListener('change', render));
$('qClear').onclick = () => { ['qRef', 'qCust', 'qFrom', 'qTo'].forEach((id) => { $(id).value = ''; }); render(); };

function render() {
  $('finder').hidden = filter === 'WORKS';
  $('qSt').hidden = filter === 'NEEDED';
  if (filter === 'WORKS') { renderWorks(); return; }
  fillFinder();
  // Collection works already have his price (My works & prices): only commissions (and rework) wait for a price here.
  const needed = items.filter((x) => (x.stage === 'NEEDED' && x.kind !== 'PRICE') || reworkPriceNeeded(x));
  $('cNeeded').textContent = needed.length ? `(${needed.length})` : '';
  const list = (filter === 'NEEDED' ? needed
    : filter === 'OPEN' ? items.filter((x) => ['ORDERED', 'INVOICED', 'PAID'].includes(x.stage)).filter(stMatch)
    : items.filter(stMatch)).filter(found);
  if (!list.length) {
    $('list').innerHTML = `<p class="muted">${searching() ? 'Nothing matches your search. <button type="button" class="linkbtn" onclick="document.getElementById(\'qClear\').click()">Clear search</button>' : filter === 'NEEDED' ? 'Nothing to price right now.' : filter === 'OPEN' && $('qSt').value ? 'No orders with this status. <button type="button" class="linkbtn" onclick="var s=document.getElementById(\'qSt\');s.value=\'\';s.dispatchEvent(new Event(\'change\'))">Show all statuses</button>' : filter === 'OPEN' ? 'No orders yet. Orders appear here once a customer has paid.' : 'No enquiries yet.'}</p>`;
    return;
  }
  $('list').innerHTML = list.map(card).join('');
  list.forEach((x) => wire(x));
}

/** The paper size to work on: the commission's chosen size, or the collection work's size (from "Artwork"). */
function paperOf(x) {
  const get = (k) => (x.brief.find((b) => b.k.toLowerCase() === k) || {}).v || '';
  const raw = get('size') || get('frame size') || (get('artwork').match(/(\d{2,3}(?:\.\d)?)\s*[x×]\s*(\d{2,3}(?:\.\d)?)\s*cm/i) || [])[0] || '';
  if (!raw) return '';
  const m = raw.match(/(\d{2,3}(?:\.\d)?)\s*[x×]\s*(\d{2,3}(?:\.\d)?)/);
  const [a, b] = m ? [Number(m[1]), Number(m[2])].sort((p, q) => p - q) : [0, 0];
  const iso = a >= 20 && a <= 22 && b >= 28 && b <= 31 ? 'A4' : a >= 28 && a <= 31 && b >= 40 && b <= 43 ? 'A3' : a >= 14 && a <= 15.5 && b >= 20 && b <= 22 ? 'A5' : '';
  return raw.replace(/\s*\(.*$/, '').trim() + (iso && !new RegExp(iso).test(raw) ? ` (${iso})` : '');
}
const STUDIO_WA = '971552996626'; // Kalai Art House WhatsApp
/** Clear instructions for the artist on each placed order: paper, size, medium, finishing, packing, and who to ask. */
function guide(x, paper) {
  if (!x.ordered || x.stopped || x.progress === 'SHIPPED') return '';
  const get = (k) => (x.brief.find((b) => b.k.toLowerCase() === k) || {}).v || '';
  const art = get('artwork'), medium = (art.match(/\(([^,]+),/) || [])[1] || get('style') || '';
  const ask = `https://wa.me/${STUDIO_WA}?text=${encodeURIComponent(`Hello Kalai Art House, a question about order ${x.ref} (${x.title}): `)}`;
  const steps = [
    paper ? `Paper size: <b>${esc(paper)}</b>${x.kind === 'PRICE' ? ' (the same size as the work shown on the website).' : ' (the size the customer chose).'}` : 'Paper size: not stated. Please ask us before you start.',
    medium ? `Medium: <b>${esc(medium)}</b>${x.kind === 'PRICE' ? ', as in the picture above' : ''}.` : '',
    x.kind === 'PRICE' ? 'Make it as shown in the picture above: same subject, composition and colours. It is a handmade original, so small natural differences are fine.' : 'Work from the customer\'s brief and reference photo above.',
    'Use good-quality, acid-free art paper. Leave about <b>2 cm clear margin</b> on every side: the frame shop mounts it, and the mount covers the edges.',
    'Sign it at the bottom right, inside the picture area (not in the margin).',
    'When finished: let it dry fully, tap <b>It\'s finished</b>, and send us a clear photo of the work on WhatsApp.',
    'Packing: flat, never rolled or folded, between two stiff boards, in a plastic sleeve against damp. Then send it to the frame shop shown below and enter the courier and AWB here.',
  ].filter(Boolean);
  return `<details class="guide" ${x.progress ? '' : 'open'}><summary><b>How to make this work</b> · paper, size and sending</summary>
    <ol>${steps.map((t) => `<li>${t}</li>`).join('')}</ol>
    <div class="guide-ask">Anything unclear (size, colours, paper, deadline)? <b>Please ask before you start.</b> <a href="${esc(ask)}" target="_blank" rel="noopener">Ask Kalai Art House on WhatsApp</a></div></details>`;
}
function card(x) {
  const brief = x.brief.map(({ k, v }) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  const paper = paperOf(x);
  const dis = x.locked ? 'disabled' : '';
  return `<article class="acard" id="c-${esc(x.id)}">
    <div class="ameta"><span class="mono">${esc(x.ref)}</span><span>${esc(day(x.createdAt))}</span><span class="catchip" title="Sales category">${x.kind === 'COMMISSION' ? 'Commission' : 'Collection'}</span>${x.customerCode ? `<span class="mono" title="Customer">${x.customerName ? esc(x.customerName) + ' · ' : ''}${esc(x.customerCode)}</span>` : ''}${x.orderStatus === 'DELIVERED' ? '<span class="stage PAID" title="The customer has received it">Delivered to customer</span>' : ''}<span class="stage ${esc(x.stage)}">${esc(x.label)}</span></div>
    ${x.studioNote ? `<div class="studionote"><b>Note from Kalai Art House</b>${x.studioNoteAt ? ` <span class="muted" style="font-size:11px">${esc(day(x.studioNoteAt))}</span>` : ''}<div>${esc(x.studioNote)}</div></div>` : ''}
    <h2>${esc(x.title)}</h2>
    ${x.imageKey ? `<img class="opic" alt="${esc(x.title)}" data-okey="${esc(x.imageKey)}" style="max-width:220px;max-height:220px;object-fit:contain;border:1px solid var(--line);border-radius:4px;display:block">` : ''}
    ${paper ? `<div class="paper">Paper size: <b>${esc(paper)}</b>${x.kind === 'PRICE' ? ' <span class="muted">· same size as the work on the website</span>' : ' <span class="muted">· as the customer chose</span>'}</div>` : ''}
    ${guide(x, paper)}
    ${brief ? `<dl class="brief">${brief}</dl>` : ''}
    ${x.hasPhoto ? `<div><button type="button" class="linkbtn" data-photo="${esc(x.id)}">View the customer's reference photo</button> <span class="muted" id="ph-${esc(x.id)}" style="font-size:13px"></span></div>` : ''}
    ${reworkBlock(x)}
    ${progressBlock(x)}
    ${x.locked ? `<div class="pricefix">Your price: <b>₹${Number(x.artistPriceInr || 0).toLocaleString('en-IN')}</b>${x.artistReadyBy ? ` · ready by ${esc(x.artistReadyBy)}` : ''}${x.artistNote ? ` · “${esc(x.artistNote)}”` : ''} <span class="muted">· fixed: order placed${x.priceBy && x.priceBy !== 'Siva' ? ' (entered for you by Kalai Art House)' : ''}</span></div>` : ''}
    <form class="aform" data-id="${esc(x.id)}" novalidate ${x.locked ? 'hidden' : ''}>
      <div class="field"><label for="p-${esc(x.id)}">Your price (₹)</label><input id="p-${esc(x.id)}" type="number" min="1" step="1" inputmode="numeric" value="${x.artistPriceInr ?? ''}" ${dis} required></div>
      <div class="field"><label for="r-${esc(x.id)}">Ready to ship by</label><input id="r-${esc(x.id)}" type="date" value="${esc(x.artistReadyBy)}" ${dis}></div>
      <div class="field"><label for="n-${esc(x.id)}">Note (optional)</label><input id="n-${esc(x.id)}" value="${esc(x.artistNote)}" placeholder="e.g. needs 5 days" ${dis}></div>
      <div class="field wide"><button class="btn" type="submit" ${dis}>${x.artistPriceInr ? 'Update price' : 'Send price'}</button></div>
      <div class="wide ok" id="m-${esc(x.id)}" role="status">${x.locked ? 'Price fixed: order placed.' : ''}${x.priceBy && x.priceBy !== 'Siva' && x.artistPriceInr ? ' Price entered for you by Kalai Art House.' : ''}</div>
    </form>
  </article>`;
}

/** The title the website shows for an unnamed work (its tidied file name), or '' when that is just "Original". */
function webTitle(w) { const t = cleanTitle(w.title); return t === 'Original' ? '' : t; }
function shownTitle(w) { return w.named ? w.title : webTitle(w) || SUGGEST[w.code]?.[0] || ''; }
let isAdmin = false; // Kalai Art House signed in on Siva's page: may correct a courier / AWB after it was sent.
const COURIERS = ['DHL', 'Aramex', 'FedEx', 'ShiprocketX', 'India Post (Speed Post)'];
/** The frame shop the finished work goes to: name, contact and address (from the framing job, or our only frame shop). */
function shopBox(f) {
  if (!f) return `<div class="shopbox muted">Kalai Art House will confirm the frame shop's address: please ask on WhatsApp before sending.</div>`;
  return `<div class="shopbox"><div class="muted" style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em">Send it to</div>
    <div><b>${esc(f.name)}</b>${f.contact ? ` · ${esc(f.contact)}` : ''}${f.phone ? ` · <a href="tel:${esc(f.phone.replace(/[^+\d]/g, ''))}">${esc(f.phone)}</a>` : ''}</div>
    ${f.address ? `<div>${esc(f.address)}</div>` : '<div class="muted">Address not on file yet: ask Kalai Art House.</div>'}</div>`;
}
function progressBlock(x) {
  if (!x.ordered) return '';
  // During a rework the original steps are done: the Rework card above has the buttons.
  if (x.rework) return '';
  if (x.stopped) {
    const done = [x.startedAt && `started ${esc(day(x.startedAt))}`, x.finishedAt && `finished ${esc(day(x.finishedAt))}`, x.shippedAt && `sent ${esc(day(x.shippedAt))}`].filter(Boolean).join(', ');
    return `<div class="progress"><div class="err" style="font-size:13px">The customer cancelled this order${done ? ` (you had ${done})` : ''}. Please stop work. You are paid <b>50% of your price${x.artistPriceInr ? `: ₹${(x.artistPriceInr / 2).toLocaleString('en-IN')}` : ''}</b>${x.shippedAt ? ', plus the courier' : ''}. Send your invoice for that amount.</div></div>`;
  }
  if (x.onHold) return `<div class="progress"><div class="err" style="font-size:14px">On hold: the customer has asked to cancel. Please don't continue with this work until Kalai Art House confirms.</div></div>`;
  const p = x.progress || '';
  const step = (key, label, at) => `<li class="${at ? 'done' : ''}"><span>${at ? '✓' : '○'}</span> ${label}${at ? ` <span class="muted">${esc(day(at))}</span>` : ''}</li>`;
  const next = !p ? `<button type="button" class="btn" data-step="STARTED">I've started this work</button>`
    : p === 'STARTED' ? `<button type="button" class="btn" data-step="FINISHED">It's finished</button>`
    : '';
  const lockedShip = p === 'SHIPPED' && !x.editShip;
  const shop = p ? shopBox(x.frameShop) : ''; // from the moment the artist confirms (Started)
  const ship = lockedShip ? (isAdmin ? `<div><button type="button" class="linkbtn" data-fixship="${esc(x.id)}">Correct courier / AWB (Kalai Art House only)</button></div>` : '')
    : p === 'FINISHED' || p === 'SHIPPED' ? `<div class="aform">
      <div class="field"><label for="sc-${esc(x.id)}">Courier to the frame shop</label><select id="sc-${esc(x.id)}">${['', ...COURIERS, 'Other'].map((c) => `<option value="${esc(c)}" ${x.artistCourier === c || (c === 'Other' && x.artistCourier && !COURIERS.includes(x.artistCourier)) ? 'selected' : ''}>${c || 'Choose…'}</option>`).join('')}</select>
        <input id="sco-${esc(x.id)}" placeholder="Courier name" value="${x.artistCourier && !COURIERS.includes(x.artistCourier) ? esc(x.artistCourier) : ''}" ${x.artistCourier && !COURIERS.includes(x.artistCourier) ? '' : 'hidden'} style="margin-top:6px"></div>
      <div class="field"><label for="sa-${esc(x.id)}">AWB / tracking no.</label><input id="sa-${esc(x.id)}" value="${esc(x.artistAwb)}"></div>
      <div class="field"><button type="button" class="btn" data-step="SHIPPED">${p === 'SHIPPED' ? 'Update shipping' : 'Sent to frame shop'}</button></div>
    </div>` : '';
  return `<div class="progress" id="pg-${esc(x.id)}">
    <ol>${step('STARTED', 'Started', x.startedAt)}${step('FINISHED', 'Finished', x.finishedAt)}${step('SHIPPED', 'Sent to frame shop', x.shippedAt)}${x.artistAwb ? ` <li class="muted" style="list-style:none">${esc(x.artistCourier)} · AWB ${esc(x.artistAwb)}</li>` : ''}</ol>
    ${x.progressBy && x.progressBy !== 'Siva' ? `<div class="muted" style="font-size:12px">Last update made for you by Kalai Art House.</div>` : ''}
    ${next}${shop}${ship}
    <div class="ok" id="pm-${esc(x.id)}" role="status"></div>
  </div>`;
}

function wireProgress(x) {
  const box = document.getElementById('pg-' + x.id);
  if (!box) return;
  const fix = box.querySelector('[data-fixship]');
  if (fix) fix.onclick = () => { x.editShip = true; render(); };
  const sel = document.getElementById('sc-' + x.id);
  if (sel) sel.onchange = () => { document.getElementById('sco-' + x.id).hidden = sel.value !== 'Other'; };
  box.querySelectorAll('[data-step]').forEach((b) => {
    b.onclick = async () => {
      const msg = document.getElementById('pm-' + x.id);
      box.querySelectorAll('.err').forEach((e) => e.remove());
      const step = b.dataset.step;
      let courier = null, awb = null;
      if (step === 'SHIPPED') {
        courier = sel.value === 'Other' ? document.getElementById('sco-' + x.id).value.trim() : sel.value;
        awb = document.getElementById('sa-' + x.id).value.trim();
        if (!courier || !awb) { msg.insertAdjacentHTML('afterend', '<div class="err">Choose the courier and enter the AWB / tracking number.</div>'); return; }
      }
      b.disabled = true; msg.textContent = 'Saving…';
      try {
        const { data, errors } = await client.mutations.artistProgress({ id: x.id, step, courier, awb });
        if (errors?.length) throw new Error(errors[0].message);
        const r = parse(data) || {};
        Object.assign(x, { progress: r.artistStage || step, startedAt: r.artistStartedAt || x.startedAt, finishedAt: r.artistFinishedAt || x.finishedAt, progressBy: r.artistBy || x.progressBy, shippedAt: r.artistShippedAt || x.shippedAt, artistCourier: r.artistCourier || x.artistCourier, artistAwb: r.artistAwb || x.artistAwb });
        x.editShip = false;
        x.label = x.progress === 'SHIPPED' ? 'Sent to frame shop · send your invoice' : x.progress === 'FINISHED' ? 'Finished · send it to the frame shop' : 'In progress';
        render();
        const m2 = document.getElementById('pm-' + x.id);
        if (m2) m2.textContent = 'Saved. Kalai Art House can see it now.';
      } catch (ex) {
        msg.textContent = '';
        msg.insertAdjacentHTML('afterend', `<div class="err">Could not save: ${esc(ex.message)}</div>`);
        b.disabled = false;
      }
    };
  });
}

// ---------- Rework (the work arrived damaged and needs repair or a repaint) ----------
const reworkPriceNeeded = (x) => !!x.rework && x.rework.priceInr == null && x.rework.stage !== 'READY';
function reworkBlock(x) {
  const r = x.rework;
  if (!r) return '';
  const id = esc(x.id);
  const kind = r.type === 'SIVA_REPAINT' ? 'a new painting (repaint)' : 'a repair';
  const step = (label, at) => `<li class="${at ? 'done' : ''}"><span>${at ? '✓' : '○'}</span> ${label}${at ? ` <span class="muted">${esc(day(at))}</span>` : ''}</li>`;
  const ready = r.stage === 'READY';
  const repair = r.type === 'SIVA_REPAIR';
  const waiting = repair && !r.receivedAt;
  const inbound = !repair ? '' : !r.toSivaSentAt ? '<div class="muted" style="font-size:14px">The damaged piece will be sent to you from Dubai. The courier and AWB will appear here.</div>'
    : !r.receivedAt ? `<div style="font-size:14px"><b>On its way to you:</b> ${esc(r.toSivaCourier)} · AWB ${esc(r.toSivaAwb)} · sent ${esc(day(r.toSivaSentAt))}</div><div><button type="button" class="btn" data-rw="RECEIVED">I've received it</button></div>`
    : `<div class="muted" style="font-size:13px">Damaged piece received ${esc(day(r.receivedAt))} (${esc(r.toSivaCourier)} · AWB ${esc(r.toSivaAwb)})</div>`;
  const next = ready || waiting ? '' : !r.stage ? `<button type="button" class="btn" data-rw="STARTED">I've started the rework</button>`
    : r.stage === 'STARTED' ? `<button type="button" class="btn" data-rw="FINISHED">Rework finished</button>` : '';
  const ship = !ready && (r.stage === 'FINISHED' || (r.stage === 'SENT' && x.editRwShip)) ? `<div class="aform">
      <div class="field"><label for="rc-${id}">Courier to the frame shop</label><select id="rc-${id}">${['', ...COURIERS, 'Other'].map((c) => `<option value="${esc(c)}" ${r.courier === c || (c === 'Other' && r.courier && !COURIERS.includes(r.courier)) ? 'selected' : ''}>${c || 'Choose…'}</option>`).join('')}</select>
        <input id="rco-${id}" placeholder="Courier name" value="${r.courier && !COURIERS.includes(r.courier) ? esc(r.courier) : ''}" ${r.courier && !COURIERS.includes(r.courier) ? '' : 'hidden'} style="margin-top:6px"></div>
      <div class="field"><label for="ra-${id}">AWB / tracking no.</label><input id="ra-${id}" value="${esc(r.awb)}"></div>
      <div class="field"><button type="button" class="btn" data-rw="SENT">${r.stage === 'SENT' ? 'Update shipping' : 'Sent to frame shop'}</button></div>
    </div>` : '';
  const rwShop = !ready && (r.stage === 'FINISHED' || r.stage === 'SENT') ? shopBox(x.frameShop) : '';
  const priceLocked = r.billed || ready && r.priceInr != null;
  return `<div class="progress rework" id="rw-${id}">
    <div><b>Rework needed:</b> the work arrived damaged at the customer. Kalai Art House asks you for ${kind}.${r.note ? ` <span class="muted">“${esc(r.note)}”</span>` : ''}</div>
    <div class="aform">
      <div class="field"><label for="rp-${id}">Your rework price (₹, 0 if no charge)</label><input id="rp-${id}" type="number" min="0" step="1" inputmode="numeric" value="${r.priceInr ?? ''}" ${priceLocked ? 'disabled' : ''}></div>
      <div class="field"><button type="button" class="btn" data-rw="PRICE" ${priceLocked ? 'disabled' : ''}>${r.priceInr != null ? 'Update rework price' : 'Send rework price'}</button></div>
    </div>
    ${r.priceBy && r.priceBy !== 'Siva' && r.priceInr != null ? '<div class="muted" style="font-size:12px">Rework price entered for you by Kalai Art House.</div>' : ''}
    ${inbound}
    <ol>${repair ? step('Received', r.receivedAt) : ''}${step('Rework started', r.startedAt)}${step('Rework finished', r.finishedAt)}${step('Sent to frame shop', r.sentAt)}${step('Checked and ready (Kalai Art House)', r.readyAt)}${r.awb ? ` <li class="muted" style="list-style:none">${esc(r.courier)} · AWB ${esc(r.awb)}</li>` : ''}</ol>
    ${next}${rwShop}${ship}
    ${!ready && r.stage === 'SENT' && !x.editRwShip && isAdmin ? `<div><button type="button" class="linkbtn" data-fixrwship="${id}">Correct courier / AWB (Kalai Art House only)</button></div>` : ''}
    ${r.priceInr > 0 ? `<div class="muted" style="font-size:13px">${r.paid ? `Rework paid to you · ref ${esc(r.paidRef)}` : r.billed ? `Your rework invoice ${esc(r.invoiceNo)} received · payment pending` : 'Send your rework invoice to Kalai Art House when it is done.'}</div>` : ''}
    <div class="ok" id="rwm-${id}" role="status"></div>
  </div>`;
}
function wireRework(x) {
  const box = document.getElementById('rw-' + x.id);
  if (!box) return;
  const fix = box.querySelector('[data-fixrwship]');
  if (fix) fix.onclick = () => { x.editRwShip = true; render(); };
  const sel = document.getElementById('rc-' + x.id);
  if (sel) sel.onchange = () => { document.getElementById('rco-' + x.id).hidden = sel.value !== 'Other'; };
  box.querySelectorAll('[data-rw]').forEach((b) => {
    b.onclick = async () => {
      const msg = document.getElementById('rwm-' + x.id);
      box.querySelectorAll('.err').forEach((e) => e.remove());
      const step = b.dataset.rw;
      const args = { id: x.id, step };
      if (step === 'PRICE') {
        const v = document.getElementById('rp-' + x.id).value;
        if (v === '' || !(Number(v) >= 0)) { msg.insertAdjacentHTML('afterend', '<div class="err">Enter your rework price in ₹ (0 if there is no charge).</div>'); return; }
        args.priceInr = Number(v);
      }
      if (step === 'SENT') {
        args.courier = sel.value === 'Other' ? document.getElementById('rco-' + x.id).value.trim() : sel.value;
        args.awb = document.getElementById('ra-' + x.id).value.trim();
        if (!args.courier || !args.awb) { msg.insertAdjacentHTML('afterend', '<div class="err">Choose the courier and enter the AWB / tracking number.</div>'); return; }
      }
      b.disabled = true; msg.textContent = 'Saving…';
      try {
        const { data, errors } = await client.mutations.artistRework(args);
        if (errors?.length) throw new Error(errors[0].message);
        const r = parse(data) || {};
        if (step === 'PRICE') Object.assign(x.rework, { priceInr: r.reworkPriceInr, priceBy: '' });
        else if (step === 'RECEIVED') { Object.assign(x.rework, { receivedAt: r.sivaReceivedAt }); x.label = 'Rework needed (damaged in transit) · give your rework price'; }
        else Object.assign(x.rework, { stage: r.reworkStage, startedAt: r.reworkStartedAt || x.rework.startedAt, finishedAt: r.reworkFinishedAt || x.rework.finishedAt, sentAt: r.reworkSentAt || x.rework.sentAt, courier: r.reworkCourier || x.rework.courier, awb: r.reworkAwb || x.rework.awb });
        x.editRwShip = false;
        x.label = x.rework.stage === 'SENT' ? 'Rework sent to frame shop · send your rework invoice' : x.rework.stage === 'FINISHED' ? 'Rework finished · send it to the frame shop' : x.rework.stage === 'STARTED' ? 'Rework in progress' : x.label;
        render();
        const m2 = document.getElementById('rwm-' + x.id);
        if (m2) m2.textContent = 'Saved. Kalai Art House can see it now.';
      } catch (ex) {
        msg.textContent = '';
        msg.insertAdjacentHTML('afterend', `<div class="err">Could not save: ${esc(ex.message)}</div>`);
        b.disabled = false;
      }
    };
  });
}

function wire(x) {
  wireProgress(x);
  wireRework(x);
  const form = document.querySelector(`form[data-id="${CSS.escape(x.id)}"]`);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = $('m-' + x.id);
    form.querySelectorAll('.err').forEach((e) => e.remove());
    const price = Number($('p-' + x.id).value);
    if (!(price > 0)) { msg.insertAdjacentHTML('afterend', '<div class="wide err">Enter your price in ₹.</div>'); return; }
    const b = form.querySelector('button'); b.disabled = true; msg.textContent = 'Sending…';
    try {
      const { errors } = await client.mutations.artistQuote({ id: x.id, priceInr: price, readyBy: $('r-' + x.id).value || null, note: $('n-' + x.id).value.trim() || null });
      if (errors?.length) throw new Error(errors[0].message);
      Object.assign(x, { artistPriceInr: price, artistReadyBy: $('r-' + x.id).value, artistNote: $('n-' + x.id).value.trim() });
      if (x.stage === 'NEEDED') Object.assign(x, { stage: 'PRICED', label: 'Price given · waiting for customer' });
      msg.textContent = `Sent: ₹${price.toLocaleString('en-IN')}. Kalai Art House can see it now.`;
      b.textContent = 'Update price';
      const pill = document.querySelector(`#c-${CSS.escape(x.id)} .stage`);
      if (pill) { pill.className = `stage ${x.stage}`; pill.textContent = x.label; }
      { const k = items.filter((i) => (i.stage === 'NEEDED' && i.kind !== 'PRICE') || reworkPriceNeeded(i)).length; $('cNeeded').textContent = k ? `(${k})` : ''; }
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

// Order cards: load the catalogue work's picture.
new MutationObserver(() => {
  document.querySelectorAll('img[data-okey]:not([src])').forEach(async (img) => {
    img.setAttribute('src', '');
    // If the picture can't be read directly (folder rules, expired link), ask the server to sign it for this order.
    img.onerror = async () => {
      img.onerror = null;
      const id = img.closest('.acard')?.id?.replace(/^c-/, '');
      try { const { data } = await client.queries.artistPhoto({ id }); const u = (typeof data === 'string' ? JSON.parse(data) : data)?.url; if (u) img.src = u; else img.remove(); } catch { img.remove(); }
    };
    try { img.src = (await getUrl({ path: img.dataset.okey, options: { expiresIn: 3600 } })).url.toString(); } catch { img.onerror?.(); }
  });
}).observe(document.body, { childList: true, subtree: true });
