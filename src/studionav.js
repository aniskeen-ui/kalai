// Studio view in the portals (artist portal, artist desk, supplier portal): jump straight to any artist, frame shop,
// print shop or courier's portal from four drop-downs, and on every order card see the whole chain for that order:
// artist → courier to the frame shop → print shop → frame shop → courier to the customer → customer, with who did
// what, where this portal sits (before / next) and a link to each party's portal. Studio (ADMINS) only.
import { generateClient } from 'aws-amplify/data';

const client = generateClient();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (v) => { try { let x = v; for (let i = 0; i < 2 && typeof x === 'string'; i++) x = JSON.parse(x); return x && typeof x === 'object' ? x : {}; } catch { return {}; } };

let people = null;
async function loadPeople() {
  if (people) return people;
  const out = []; let nextToken = null;
  do { const r = await client.models.SellerProfile.list({ limit: 500, nextToken }); out.push(...(r.data || [])); nextToken = r.nextToken; } while (nextToken);
  people = out.filter((p) => p.status === 'APPROVED' && ['ARTIST', 'FRAMER', 'PRINTER', 'COURIER'].includes(p.type))
    .sort((a, b) => String(a.business).localeCompare(String(b.business)));
  return people;
}
const portalOf = (p) => (p.type === 'ARTIST' ? `/seller.html?view=${encodeURIComponent(p.id)}` : `/supplier.html?view=${encodeURIComponent(p.id)}`);
const byName = (name, type) => people?.find((p) => (!type || p.type === type) && String(p.business || '').trim().toLowerCase() === String(name || '').trim().toLowerCase());

const CSS = `.sn-bar{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin-top:8px}
.sn-bar label{display:grid;gap:2px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.sn-bar select{font:inherit;font-size:13px;text-transform:none;letter-spacing:0;font-weight:400;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface,#fff);color:var(--fg)}
.sn-chain{margin:8px 0 0;padding:8px 10px;border:1px dashed var(--gold,#b0832b);border-radius:8px;font-size:12px;background:color-mix(in srgb,var(--gold,#b0832b) 6%,transparent)}
.sn-chain b.t{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--gold,#b0832b)}
.sn-steps{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;margin:6px 0 4px}
.sn-step{display:inline-flex;flex-direction:column;border:1px solid var(--line);border-radius:6px;padding:3px 7px;background:var(--surface,#fff);line-height:1.25}
.sn-step small{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.04em}
.sn-step.done{border-color:#2f7d4f}.sn-step.done small::before{content:"✓ ";color:#2f7d4f}
.sn-step.me{border:2px solid var(--gold,#b0832b);font-weight:700}
.sn-step a{color:inherit}
.sn-arrow{color:var(--muted)}
.sn-pn{color:var(--muted)}.sn-pn b{color:var(--fg)}`;
function css() { if (document.getElementById('snCss')) return; const s = document.createElement('style'); s.id = 'snCss'; s.textContent = CSS; document.head.appendChild(s); }

/** Four drop-downs (artists, frame shops, print shops, couriers): choosing one opens that portal. */
export async function studioBar(host, currentId = '') {
  if (!host || host.querySelector('.sn-bar')) return;
  css();
  const list = await loadPeople().catch(() => []);
  const sel = (type, label, ph) => {
    const rows = list.filter((p) => p.type === type);
    return `<label>${label}<select data-sn="${type}"><option value="">${rows.length ? ph : `no ${label.toLowerCase()} yet`}</option>${rows.map((p) => `<option value="${esc(p.id)}" ${p.id === currentId ? 'selected' : ''}>${esc(p.business || p.contactName || p.email)}</option>`).join('')}</select></label>`;
  };
  host.insertAdjacentHTML('beforeend', `<div class="sn-bar">${sel('ARTIST', 'Artists', 'Open an artist…')}${sel('FRAMER', 'Frame shops', 'Open a frame shop…')}${sel('PRINTER', 'Print shops', 'Open a print shop…')}${sel('COURIER', 'Couriers', 'Open a courier…')}</div>`);
  host.querySelectorAll('[data-sn]').forEach((s) => { s.onchange = () => { const p = list.find((x) => x.id === s.value); if (p) location.href = portalOf(p); }; });
}

/** The chain of one order as HTML. role = the portal it is shown in: artist | inbound | printer | framer | delivery. */
async function chainHtml(enquiryId, role) {
  await loadPeople().catch(() => []);
  const [er, cr] = await Promise.all([client.models.Enquiry.get({ id: enquiryId }).catch(() => null), client.models.Costing.get({ enquiryId }).catch(() => null)]);
  const e = er?.data, j = json(cr?.data?.supplierJobs);
  if (!e) return '';
  const art = ['PRICE', 'COMMISSION'].includes(e.kind);
  const link = (name, href) => (href ? `<a href="${href}">${esc(name)}</a>` : esc(name));
  const sup = (job, type) => { if (!job) return null; const p = (job.supplierId && people?.find((x) => x.id === job.supplierId)) || byName(job.name, type); return { name: job.name || p?.business || '?', href: p ? portalOf(p) : '' }; };
  const S = [];
  if (art) {
    const a = e.artistId && people?.find((p) => p.id === e.artistId);
    S.push({ k: 'artist', what: 'Artist makes it', name: e.artistName || a?.business || 'Siva Raja', href: a ? portalOf(a) : (e.artistId ? `/seller.html?view=${encodeURIComponent(e.artistId)}` : '/artist.html'), done: e.artistStage === 'SHIPPED', state: { STARTED: 'working', FINISHED: 'finished, not sent', SHIPPED: 'sent' }[e.artistStage] || (e.zohoPOId ? 'not started' : 'price / order') });
    const ib = sup(j.inbound, 'COURIER');
    const ibc = !ib && e.artistCourier ? (people?.find((p) => p.type === 'COURIER' && String(p.business || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(String(e.artistCourier).toLowerCase().replace(/[^a-z0-9]/g, ''))) || null) : null;
    S.push({ k: 'inbound', what: 'Artist → frame shop', name: ib?.name || e.artistCourier || 'not allocated', href: ib?.href || (ibc ? portalOf(ibc) : ''), done: e.artistStage === 'SHIPPED', state: (j.inbound?.awb || e.artistAwb) ? `AWB ${j.inbound?.awb || e.artistAwb}${!ib && e.artistCourier ? ' · by the artist' : ''}` : '' });
  }
  if (j.printer || ['PHOTO', 'GIFT'].includes(e.kind)) { const p = sup(j.printer, 'PRINTER'); S.push({ k: 'printer', what: 'Print shop', name: p?.name || 'not given', href: p?.href, done: ['READY', 'COLLECTED'].includes(j.printer?.stage), state: (j.printer?.stage || '').toLowerCase() }); }
  if (j.printer && j.framer) S.push({ k: 'handover', what: 'Print shop → frame shop', name: `${j.framer.name} collects`, href: '', done: j.printer.stage === 'COLLECTED', state: j.printer.stage === 'COLLECTED' ? 'collected' : j.printer.stage === 'READY' ? 'ready to collect' : '' });
  if (e.kind !== 'LICENCE' && e.kind !== 'MARKET') { const f = sup(j.framer, 'FRAMER'); S.push({ k: 'framer', what: 'Frame shop', name: f?.name || 'not given', href: f?.href, done: ['READY', 'COLLECTED'].includes(j.framer?.stage), state: (j.framer?.stage || '').toLowerCase() }); }
  { const d = sup(j.delivery, 'COURIER'); S.push({ k: 'delivery', what: `${j.printer && !j.framer ? 'Print shop' : 'Frame shop'} → customer`, name: d?.name || (j.framer?.canDeliver ? `${j.framer.name} delivers` : 'not allocated'), href: d?.href, done: !!j.delivery?.deliveredAt || e.status === 'DELIVERED', state: j.delivery?.awb ? `AWB ${j.delivery.awb}` : '' }); }
  S.push({ k: 'customer', what: 'Customer', name: e.customerCode || 'customer', href: '', done: e.status === 'DELIVERED', state: e.status === 'DELIVERED' ? 'delivered' : '' });
  const at = S.findIndex((s) => s.k === role);
  const prev = at > 0 ? S[at - 1] : null, next = at >= 0 && at < S.length - 1 ? S[at + 1] : null;
  return `<div class="sn-chain"><b class="t">Order chain · studio view</b> · <a href="/admin.html#order=${esc(e.id)}">${esc(e.ref)} in Order Management</a>
    <div class="sn-steps">${S.map((s, i) => `${i ? '<span class="sn-arrow">→</span>' : ''}<span class="sn-step ${s.done ? 'done' : ''} ${i === at ? 'me' : ''}"><small>${esc(s.what)}${i === at ? ' · this portal' : ''}</small>${link(s.name, s.href)}${s.state ? ` <span class="sn-pn">· ${esc(s.state)}</span>` : ''}</span>`).join('')}</div>
    ${at >= 0 ? `<div class="sn-pn">${prev ? `Before: <b>${esc(prev.what)}</b> (${link(prev.name, prev.href)})${prev.done ? ' ✓' : ' · not done yet'}` : 'This is the first step.'} &nbsp;·&nbsp; ${next ? `Next: <b>${esc(next.what)}</b> (${link(next.name, next.href)})` : 'Last step.'}</div>` : ''}</div>`;
}

/** Watches a list of order cards and adds the chain under each. idRole(card) → [enquiryId, role] or null. */
export function chainOnCards(root, selector, idRole) {
  if (!root) return;
  css();
  const run = () => root.querySelectorAll(selector).forEach((card) => {
    if (card.dataset.sn) return; const ir = idRole(card); if (!ir || !ir[0]) return;
    card.dataset.sn = '1';
    chainHtml(ir[0], ir[1]).then((h) => { if (h) card.insertAdjacentHTML('beforeend', h); }).catch(() => {});
  });
  run();
  new MutationObserver(run).observe(root, { childList: true, subtree: true });
}
