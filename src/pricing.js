// Pricing tab: fixed website prices for catalogue works.
// Artist's price (Siva fills it on his desk, in ₹) + courier India → Dubai + customs + frame work + frame (by style)
// + margin + card charges + courier Dubai → customer = suggested price per frame style. Every input can be changed;
// the studio checks it against the market (Kalai bands, Saatchi Art) and approves the final prices, which then show
// on the website.
import { generateClient } from 'aws-amplify/data';
import { getUrl } from 'aws-amplify/storage';
import { parseCard, parcelPrice, setInrFx, servesKind } from './ratecard.js';
import { loadComp, drawSim } from './competitors.js';
import { cleanTitle } from './title.js';

const client = generateClient();
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// The UAE dirham sign, drawn (fonts don't have it yet).
export const DHS = '<i class="dhs" aria-label="Dhs">⃃</i>';
const aed = (v) => (v == null || !Number.isFinite(v) ? '–' : DHS + Math.round(v).toLocaleString('en-US'));
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

export const STYLES = [
  { k: 'none', n: 'No frame' }, { k: 'black', n: 'Black slim' }, { k: 'white', n: 'White' },
  { k: 'oak', n: 'Natural oak' }, { k: 'walnut', n: 'Walnut' }, { k: 'gold', n: 'Gold' },
];
const TIERS = ['S', 'M', 'L'];
// Standard frame sizes (outside of the mount, cm). The smallest that fits the work with a 4 cm mount is the base; the
// customer can pick a bigger one (wider mount) on the website.
export const FRAME_SIZES = [['30×40', 30, 40], ['40×50', 40, 50], ['50×70', 50, 70], ['60×80', 60, 80], ['70×100', 70, 100]];
const dims = (size) => { const n = String(size || '').match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i); return n ? [Number(n[1]), Number(n[2])] : [30, 40]; };
export function fitFrame(size) {
  const [a, b] = dims(size), lo = Math.min(a, b) + 8, hi = Math.max(a, b) + 8;
  return (FRAME_SIZES.find(([, s1, s2]) => s1 >= lo && s2 >= hi) || FRAME_SIZES[FRAME_SIZES.length - 1])[0];
}
const sizesFrom = (base) => FRAME_SIZES.slice(FRAME_SIZES.findIndex((f) => f[0] === base)).map((f) => f[0]);
const rnd = (raw) => (P.round25 !== false ? Math.ceil(raw / 25) * 25 : P.round9 ? Math.ceil((raw + 1) / 10) * 10 - 1 : Math.round(raw));
// Master inputs (saved with Rates). Frame work = mount, glass, backing and labour; frame = the moulding, plain style;
// the other styles cost a % more. Figures are starting points from Dubai framers' published ranges: replace them
// with real quotes.
const DEFAULT_P = {
  fx: 0.042, customs: 0.05, local: 30, margin: 0.25, fee: 0.03, ins: 0.01, reserve: 0.02, round9: false, round25: true,
  courier: { S: 45, M: 65, L: 110 },
  // per frame size
  frameWork: { '30×40': 45, '40×50': 65, '50×70': 95, '60×80': 120, '70×100': 160 },
  moulding: { '30×40': 75, '40×50': 105, '50×70': 155, '60×80': 195, '70×100': 260 },
  extra: { none: 0, black: 0, white: 0, oak: 0.2, walnut: 0.3, gold: 0.5 },
};
const DEFAULT_MARKET = {
  S: { sk: [390, 590], wc: [490, 790], saatchi: 'ink 20×15 cm ≈ ⃃ 1,100 · watercolour 30×23 cm ≈ ⃃ 4,300' },
  M: { sk: [590, 890], wc: [790, 1190], saatchi: 'ink 29×22 cm ≈ ⃃ 1,600–1,900 · watercolour 38×28 cm ≈ ⃃ 3,800–4,300' },
  L: { sk: [990, 1490], wc: [1290, 1990], saatchi: 'watercolour 51×38 to 56×76 cm ≈ ⃃ 3,900–7,500' },
};

// Frame costs can come from a frame shop's own price list (supplier portal → My price list), per size and style:
// frame price + fixing charge (or included). P.frameSource = '' (the master table), a frame shop's id, or 'cheapest'.
let framers = [];
/** {frame, fixing, from} for a style and frame size from the chosen frame shop(s), or null → master table. */
function supplierFrame(style, fsize) {
  const src = P.frameSource || 'cheapest';
  if (style === 'none') return null;
  // The default frame shop first; where it has no price for this size / style, the cheapest one that has.
  const mine = src !== 'cheapest' ? framers.filter((f) => f.id === src) : [];
  const pick = (list) => { let best = null; for (const f of list) { const card = parseCard(f); if (!servesKind(card, 'PRICE')) continue; /* original artworks: not shop-only frames */ const fr = card.frames?.[style]?.[fsize]; if (fr == null || fr === '') continue; const fix = card.fixingIncluded ? 0 : Number(card.fixing?.[fsize] || 0); if (!best || Number(fr) + fix < best.frame + best.fixing) best = { frame: Number(fr), fixing: fix, from: f.business }; } return best; };
  const got = pick(mine) || pick(framers);
  if (got) return got;
  const list = [];
  let best = null;
  for (const f of list) {
    const card = parseCard(f);
    const fr = card.frames?.[style]?.[fsize];
    if (fr == null || fr === '') continue;
    const fix = card.fixingIncluded ? 0 : Number(card.fixing?.[fsize] || 0);
    if (!best || Number(fr) + fix < best.frame + best.fixing) best = { frame: Number(fr), fixing: fix, from: f.business };
  }
  return best;
}
// Delivery partner's price to Dubai for this frame size (website prices are for UAE delivery).
let couriers = [];
function supplierLocal(fsize) {
  const src = P.deliverySource || 'cheapest';
  const priceOf = (s) => parcelPrice(parseCard(s).uae?.Dubai, fsize);
  const mine = src !== 'cheapest' ? couriers.find((c) => c.id === src) : null;
  if (mine && priceOf(mine) != null) return { cost: priceOf(mine), from: mine.business };
  const all = couriers.map((c) => ({ cost: priceOf(c), from: c.business })).filter((x) => x.cost != null).sort((a, b) => a.cost - b.cost);
  return all[0] || null;
}
let ratesRow = null; // the whole Rates JSON (other tabs' fields kept as they are)
let P = structuredClone(DEFAULT_P);
let market = structuredClone(DEFAULT_MARKET);
let works = [];
let prices = new Map(); // productId → ArtworkPrice
let filter = 'TODO';
let openId = null;
let wired = false;

/** Size text → S / M / L by the longest side (A4 ≈ 30 cm, A3 ≈ 42 cm). */
export function tierOf(size) {
  const n = String(size || '').match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i);
  if (!n) return 'M';
  const long = Math.max(Number(n[1]), Number(n[2]));
  return long <= 31 ? 'S' : long <= 45 ? 'M' : 'L';
}
const mediumOf = (w) => (w.kind === 'sketch' || /pencil|ink|charcoal|graphite|chalk|sketch/i.test(`${w.medium} ${w.title}`) ? 'sk' : 'wc');

/** One price build-up per frame style. o = per-work overrides {artist, tier, fsize, courier, margin}. */
// Works by portal artists in the UAE: priced in ⃃, no India courier and no customs.
const isLocalArt = (w) => !!w.artistId && (w.artistCountry || 'UAE') === 'UAE';
const curOf = (w) => (prices.get(w.id)?.currency === 'AED' || isLocalArt(w) ? 'AED' : 'INR');
const artistPrice = (w, v) => (v == null ? '–' : curOf(w) === 'AED' ? `⃃ ${Number(v).toLocaleString('en-US')}` : '₹' + Number(v).toLocaleString('en-IN'));
// Website products made from an artist's listing stay hidden (DRAFT) until their prices are approved here.
const goLive = (w) => (w.status === 'DRAFT' ? { status: 'PUBLISHED' } : {});
function build(w, o = {}) {
  const tier = o.tier || tierOf(w.size);
  const fsize = o.fsize || fitFrame(w.size);
  const ap = prices.get(w.id);
  const inr = o.artist ?? ap?.artistPrice ?? null;
  const artistAed = inr == null ? null : (curOf(w) === 'AED' ? inr : inr * P.fx);
  const courier = o.courier ?? (isLocalArt(w) ? 0 : P.courier[tier] ?? 0);
  const margin = o.margin ?? P.margin;
  const pct = (P.fee || 0) + (P.ins || 0) + (P.reserve || 0);
  const sl = supplierLocal(fsize);
  const out = { tier, fsize, inr, artistAed, courier, margin, local: sl?.cost ?? null, localFrom: sl?.from || '', styles: {}, missing: [] };
  if (artistAed == null) return out;
  // No silent fallback: a frame or delivery price missing from every supplier's list blocks the price.
  if (sl == null) out.missing.push(`delivery to Dubai, ${fsize}`);
  for (const s of STYLES) if (s.k !== 'none' && !supplierFrame(s.k, fsize)) out.missing.push(`${s.n.toLowerCase()} frame ${fsize}`);
  if (out.missing.length) { out.blocked = true; return out; }
  out.customs = isLocalArt(w) ? 0 : (artistAed + courier) * P.customs;
  out.from = {};
  for (const s of STYLES) {
    const sf = supplierFrame(s.k, fsize);
    out.from[s.k] = sf ? sf.from : '';
    const frameWork = s.k === 'none' ? 0 : sf.fixing;
    const frame = s.k === 'none' ? 0 : sf.frame;
    const cost = artistAed + courier + out.customs + frameWork + frame + out.local;
    const raw = (cost * (1 + margin)) / (1 - pct);
    const price = rnd(raw);
    out.styles[s.k] = { frameWork, frame, cost, marginAmt: cost * margin, cardAmt: price * pct, price };
  }
  return out;
}

async function loadAll() {
  $('pcList').innerHTML = '<p class="muted">Loading…</p>';
  const r = await client.models.Rates.get({ key: 'default' }).catch(() => null);
  try { ratesRow = r?.data?.data ? (typeof r.data.data === 'string' ? JSON.parse(r.data.data) : r.data.data) : null; } catch { ratesRow = null; }
  // Start from the order calculator's figures where the pricing master hasn't been saved yet.
  const base = ratesRow || {};
  setInrFx(base.fx); // frame shops in India keep prices in ₹
  P = { ...structuredClone(DEFAULT_P), fx: base.fx ?? DEFAULT_P.fx, customs: base.customs ?? DEFAULT_P.customs, local: base.local ?? DEFAULT_P.local, margin: base.margins?.collection ?? base.margin ?? DEFAULT_P.margin,
    fee: base.fee ?? DEFAULT_P.fee, ins: base.ins ?? DEFAULT_P.ins, reserve: base.reserve ?? DEFAULT_P.reserve, round9: base.round9 ?? false, round25: base.round25 ?? true,
    courier: Object.fromEntries(TIERS.map((t) => [t, base.tiers?.[t]?.courier ?? base.pricing?.courier?.[t] ?? DEFAULT_P.courier[t]])),
    // Default suppliers (Pricing → Margin & charges); older Pricing pages saved the frame shop here.
    frameSource: base.defaults?.framer || base.pricing?.frameSource || 'cheapest', deliverySource: base.defaults?.delivery || 'cheapest' };
  market = { ...structuredClone(DEFAULT_MARKET), ...(base.market || {}) };
  await loadComp(client);
  try {
    const sp = ((await client.models.SellerProfile.list({ limit: 500 })).data || []).filter((p) => p.status === 'APPROVED').sort((a, b) => String(a.business).localeCompare(String(b.business)));
    framers = sp.filter((p) => p.type === 'FRAMER');
    couriers = sp.filter((p) => p.type === 'COURIER' || (p.type === 'FRAMER' && Object.keys(parseCard(p).uae || {}).length));
  } catch { framers = []; couriers = []; }
  works = [];
  let nextToken = null;
  do { const x = await client.models.Product.list({ limit: 500, nextToken }); works.push(...(x.data || [])); nextToken = x.nextToken; } while (nextToken);
  works = works.filter((w) => w.imageKey && w.status !== 'HIDDEN' && w.kind !== 'photo'); // framed prints use the size prices in Settings
  prices = new Map();
  nextToken = null;
  do { const x = await client.models.ArtworkPrice.list({ limit: 500, nextToken }); (x.data || []).forEach((p) => prices.set(p.productId, p)); nextToken = x.nextToken; } while (nextToken);
}

const matrixOf = (w) => { try { return w.priceMatrix ? JSON.parse(w.priceMatrix) : null; } catch { return null; } };
/** Price for a style at the base frame size, from either price format (v2 has frame sizes). */
const basePrice = (m, k) => (!m ? null : m.v === 2 ? (k === 'none' ? m.none : m.sizes?.[m.base]?.[k]) : m[k]);
const stateOf = (w) => {
  const ap = prices.get(w.id), m = matrixOf(w);
  // Changed = the artist's price now differs from the one the website price was approved with.
  let used = null; try { used = ap?.calc ? JSON.parse(ap.calc).artistUsed ?? null : null; } catch { used = null; }
  if (m && used != null && ap?.artistPrice != null && Number(ap.artistPrice) !== Number(used)) return ['CHANGED', `Artist changed his price (was ₹${Number(used).toLocaleString('en-IN')})`];
  // Supplier price lists changed since approval (frame, delivery) or the India courier / exchange rate: cost moved.
  if (m) {
    let sv = {}; try { sv = ap?.calc ? JSON.parse(ap.calc) : {}; } catch { sv = {}; }
    if (sv.costUsed != null) {
      const b = build(w, { tier: sv.tier || tierOf(w.size), fsize: (m.v === 2 && m.base) || sv.fsize || fitFrame(w.size), courier: sv.courier ?? null, margin: sv.margin ?? null });
      if (b.blocked) return ['CHANGED', 'No supplier price any more: check the price lists'];
      const now = b.styles.black?.cost;
      if (now != null && Math.abs(now - sv.costUsed) >= 1) return ['CHANGED', `Cost changed (was ⃃${Math.round(sv.costUsed)}, now ⃃${Math.round(now)})`];
    }
  }
  if (m) return ['LIVE', 'Price on website'];
  if (ap?.artistPrice != null) return ['TODO', 'To approve'];
  return ['WAIT', 'Waiting for artist price'];
};

function masterHtml() {
  const pc = (v) => `${+(Number(v || 0) * 100).toFixed(2)}%`;
  const fr = P.frameSource && P.frameSource !== 'cheapest' ? framers.find((f) => f.id === P.frameSource)?.business : '';
  const dl = P.deliverySource && P.deliverySource !== 'cheapest' ? couriers.find((c) => c.id === P.deliverySource)?.business : '';
  return `<div class="pc-master" style="display:flex;gap:6px 18px;flex-wrap:wrap;align-items:center;font-size:13px;padding:10px 12px;border:1px solid var(--line);border-radius:var(--r);background:var(--surface)">
    <b>Figures used</b>
    <span>Margin ${pc(P.margin)}</span><span>Ziina ${pc(P.fee)}</span><span>Insurance ${pc(P.ins)}</span><span>Reserve ${pc(P.reserve)}</span><span>Customs ${pc(P.customs)}</span><span>₹ → ⃃ ${P.fx}</span>
    <span>India courier ${TIERS.map((t) => `${t} ${P.courier[t]}`).join(' / ')}</span>
    <span>Frames: ${esc(fr || 'cheapest frame shop')}</span><span>Delivery: ${esc(dl || 'cheapest delivery partner')} (Dubai)</span>
    <button type="button" class="btn small ghost" id="pcToSettings" style="margin-left:auto">Change in Margin &amp; charges</button>
    <span class="muted" id="pcMasterMsg" style="font-size:12px;flex-basis:100%">Frame and delivery costs come from the suppliers' price lists. A work whose frame or delivery price is missing from every list shows "no supplier price" and can't be approved until the price list is filled in.</span>
  </div>`;
}
function readMaster() {}

// Market check for one work: Kalai's band for its size and medium; the proposed price lifts a cost-based price that
// is below the band to the middle of the band (rounded up to Dhs 25). Above the band it stays, flagged.
function marketOf(w, b) {
  const md = mediumOf(w), mk = market[b.tier] || DEFAULT_MARKET[b.tier], band = mk?.[md] || [0, 0];
  const cost = b.styles.black?.price;
  if (cost == null) return { band, md, cost: null, proposed: null, verdict: '' };
  const mid = Math.ceil((band[0] + band[1]) / 2 / 25) * 25;
  const verdict = cost < band[0] ? 'below' : cost > band[1] ? 'above' : 'inside';
  return { band, md, cost, proposed: verdict === 'below' ? mid : cost, verdict };
}
/** Full price list (frame sizes × styles) from the final prices at the base frame size. */
function matrixFor(w, o, fin) {
  const b = build(w, o), pct = (P.fee || 0) + (P.ins || 0) + (P.reserve || 0), out = {};
  for (const fs of sizesFrom(b.fsize)) {
    const bb = build(w, { ...o, fsize: fs });
    if (bb.blocked) continue; // a bigger frame size no supplier prices: not offered on the website
    out[fs] = Object.fromEntries(STYLES.filter((x) => x.k !== 'none').map((x) => {
      const extra = (bb.styles[x.k].cost - b.styles[x.k].cost) * (1 + b.margin) / (1 - pct);
      return [x.k, fs === b.fsize ? fin[x.k] : fin[x.k] + Math.ceil(extra / 25) * 25];
    }));
  }
  return { v: 2, base: b.fsize, none: fin.none, sizes: out };
}
const picked = new Set();
let bulkNote = '';

function drawList() {
  const fq = ($('pcFind')?.value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = works.filter((w) => filter === 'ALL' || stateOf(w)[0] === filter || (filter === 'TODO' && stateOf(w)[0] === 'CHANGED'))
    .filter((w) => !fq.length || fq.every((q) => `${w.title} ${w.code} ${w.artist || 'Siva Raja'} ${w.size} ${w.kind}`.toLowerCase().includes(q)))
    .sort((a, b) => String(a.code).localeCompare(String(b.code)));
  const counts = Object.fromEntries(['TODO', 'LIVE', 'WAIT'].map((k) => [k, works.filter((w) => stateOf(w)[0] === k || (k === 'TODO' && stateOf(w)[0] === 'CHANGED')).length]));
  $('pcTabs').innerHTML = [['TODO', 'To approve'], ['LIVE', 'On website'], ['WAIT', 'Waiting for artist price'], ['ALL', 'All']]
    .map(([k, l]) => `<button type="button" data-f="${k}" aria-pressed="${k === filter}">${l}${k !== 'ALL' ? ` <b>${counts[k]}</b>` : ''}</button>`).join('');
  $('pcTabs').querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { filter = b.dataset.f; openId = null; drawList(); }; });
  if ($('pcFind') && !$('pcFind').dataset.wired) { $('pcFind').dataset.wired = '1'; $('pcFind').addEventListener('input', () => { openId = null; drawList(); }); }
  if (!rows.length) { $('pcList').innerHTML = `${bulkNote ? `<p class="ok">${esc(bulkNote)}</p>` : ''}<p class="muted">${filter === 'TODO' ? 'Nothing to approve. Works appear here once the artist gives his price under "My works & prices".' : 'Nothing here.'}</p>`; return; }
  for (const id of [...picked]) if (!rows.some((w) => w.id === id)) picked.delete(id);
  $('pcList').innerHTML = `<div class="pc-bulk">
      <label><input type="checkbox" id="pcAll" ${rows.length && rows.every((w) => picked.has(w.id)) ? 'checked' : ''}> Select all shown</label>
      <b id="pcPickN">${picked.size} selected</b>
      <button class="btn small" type="button" id="pcBulkMarket">Approve selected at the proposed price</button>
      <button class="btn small ghost" type="button" id="pcBulkCost">Approve selected at the cost-based price</button>
      <span class="muted" id="pcBulkMsg" style="font-size:12px">${bulkNote ? esc(bulkNote) : 'All frame styles and sizes follow from the black-frame price. Open a work with Calculate to fine-tune.'}</span></div>
    <div class="tablewrap"><table class="pc-table"><thead><tr><th></th><th></th><th>Work</th><th>Size</th><th>Artist</th><th>Ready in</th><th>Cost-based (black frame)</th><th>Market check</th><th>Proposed price</th><th>On website</th><th></th></tr></thead><tbody>
    ${rows.map((w) => {
      const b = build(w), m = matrixOf(w), [st, label] = stateOf(w), mc = marketOf(w, b);
      return `<tr data-id="${esc(w.id)}" class="${w.id === openId ? 'sel' : ''}"><td><input type="checkbox" data-pick="${esc(w.id)}" ${picked.has(w.id) ? 'checked' : ''} ${b.artistAed == null ? 'disabled title="No artist price yet"' : b.blocked ? 'disabled title="No supplier price"' : ''}></td><td><img data-key="${esc(w.imageKey)}" alt=""></td>
        <td><b>${esc(w.named ? w.title : cleanTitle(w.title))}</b><br><span class="muted mono" style="font-size:11px">${esc(w.code || '')}</span></td>
        <td>${esc(w.size || '–')}<br><span class="muted" style="font-size:11px">${b.tier} · ${mediumOf(w) === 'sk' ? 'sketch' : 'watercolour'}</span></td>
        <td class="mono">${artistPrice(w, b.inr)}${w.artist ? `<br><span class="muted" style="font-size:11px;font-family:inherit">${esc(w.artist)}</span>` : ''}</td>
        <td style="font-size:12px">${w.leadDays != null ? (w.leadDays === 0 && !w.leadMax ? 'ready now' : `${w.leadDays}${w.leadMax && w.leadMax !== w.leadDays ? `–${w.leadMax}` : ''} days`) : '<span class="muted">–</span>'}</td>
        <td class="mono">${b.blocked ? `<span class="pc-st TODO" title="${esc(b.missing.join(', '))}">no supplier price</span><br><span class="muted" style="font-size:11px;font-family:inherit;white-space:normal">${esc(b.missing.slice(0, 2).join(', '))}${b.missing.length > 2 ? '…' : ''}</span>` : aed(b.styles.black?.price)}</td>
        <td style="font-size:12px">${mc.cost == null ? '–' : `${aed(mc.band[0])}–${aed(mc.band[1])}<br><span class="pc-st ${mc.verdict === 'inside' ? 'LIVE' : 'TODO'}">${mc.verdict === 'below' ? 'below the band' : mc.verdict === 'above' ? 'above the band' : 'inside the band'}</span>`}</td>
        <td class="mono"><b>${aed(mc.proposed)}</b></td>
        <td class="mono">${m ? aed(basePrice(m, 'black')) : '–'}${m?.v === 2 ? ` <span class="muted" style="font-size:11px">${esc(m.base)}</span>` : ''}<br><span class="pc-st ${st}">${label}</span></td>
        <td><button class="btn small ghost" type="button" data-open="${esc(w.id)}">${w.id === openId ? 'Close' : 'Calculate'}</button></td></tr>
        ${w.id === openId ? `<tr class="pc-open"><td colspan="11" id="pcCalc"></td></tr>` : ''}`;
    }).join('')}</tbody></table></div>`;
  $('pcList').querySelectorAll('img[data-key]').forEach(async (img) => { try { img.src = (await getUrl({ path: img.dataset.key, options: { expiresIn: 3600 } })).url.toString(); } catch { /* none */ } });
  $('pcList').querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => { openId = openId === b.dataset.open ? null : b.dataset.open; drawList(); }; });
  const countPick = () => { $('pcPickN').textContent = `${picked.size} selected`; };
  $('pcList').querySelectorAll('[data-pick]').forEach((c) => { c.onchange = () => { c.checked ? picked.add(c.dataset.pick) : picked.delete(c.dataset.pick); countPick(); }; });
  $('pcAll').onchange = () => { rows.forEach((w) => { const bb = build(w); if (bb.artistAed == null || bb.blocked) return; $('pcAll').checked ? picked.add(w.id) : picked.delete(w.id); }); drawList(); };
  const bulk = async (useMarket) => {
    bulkNote = '';
    const list = rows.filter((w) => picked.has(w.id));
    if (!list.length) { $('pcBulkMsg').textContent = 'Tick the works to approve first.'; return; }
    $('pcBulkMarket').disabled = true; $('pcBulkCost').disabled = true;
    let ok = 0; const bad = [];
    for (const w of list) {
      const ap = prices.get(w.id); let saved = {}; try { saved = ap?.calc ? JSON.parse(ap.calc) : {}; } catch { saved = {}; }
      const o = { tier: saved.tier || tierOf(w.size), fsize: saved.fsize || fitFrame(w.size), courier: saved.courier ?? null, margin: saved.margin ?? null };
      const b = build(w, o);
      if (b.artistAed == null || b.blocked) { bad.push(w.code); continue; }
      const mc = marketOf(w, b), diff = useMarket ? mc.proposed - b.styles.black.price : 0;
      const fin = Object.fromEntries(STYLES.map((x) => [x.k, Math.ceil((b.styles[x.k].price + diff) / 25) * 25]));
      const matrix = matrixFor(w, o, fin), now = new Date().toISOString();
      try {
        const r1 = await client.models.Product.update({ id: w.id, priceMatrix: JSON.stringify(matrix), priceApprovedAt: now, ...goLive(w) });
        if (r1.errors?.length) throw new Error(r1.errors[0].message);
        Object.assign(w, { priceMatrix: JSON.stringify(matrix), priceApprovedAt: now, ...goLive(w) });
        const rec = { productId: w.id, calc: JSON.stringify({ ...o, artistUsed: ap?.artistPrice ?? null, costUsed: b.styles.black.cost, master: P, at: now, bulk: useMarket ? 'market' : 'cost' }), approvedAt: now };
        const r2 = ap ? await client.models.ArtworkPrice.update(rec) : await client.models.ArtworkPrice.create({ currency: curOf(w), ...rec });
        if (!r2.errors?.length) prices.set(w.id, { ...(ap || {}), ...r2.data });
        ok++; picked.delete(w.id);
      } catch { bad.push(w.code); }
      $('pcBulkMsg').textContent = `Approving… ${ok} of ${list.length}`;
    }
    bulkNote = `${ok} works now priced on the website.${bad.length ? ` Not done: ${bad.join(', ')}` : ''}`;
    drawList();
  };
  $('pcBulkMarket').onclick = () => bulk(true);
  $('pcBulkCost').onclick = () => bulk(false);
  if (openId) drawCalc(works.find((w) => w.id === openId));
}

function drawCalc(w) {
  const ap = prices.get(w.id);
  let saved = {}; try { saved = ap?.calc ? JSON.parse(ap.calc) : {}; } catch { saved = {}; }
  const m = matrixOf(w);
  const o = { tier: saved.tier || tierOf(w.size), fsize: (m?.v === 2 && m.base) || saved.fsize || fitFrame(w.size), artist: ap?.artistPrice ?? null, courier: saved.courier ?? null, margin: saved.margin ?? null };
  const box = $('pcCalc');
  let fresh = stateOf(w)[0] !== 'CHANGED'; // first view: show the prices now on the website; after any change: the recalculated ones
  const render = () => {
    const b = build(w, o);
    const lift = b.artistAed == null || b.blocked ? 0 : marketOf(w, b).proposed - b.styles.black.price; // market lift on every style
    const md = mediumOf(w), mk = market[b.tier] || DEFAULT_MARKET[b.tier], band = mk?.[md] || [0, 0];
    const cell = (fn) => STYLES.map((s) => `<td class="num mono">${b.styles[s.k] ? fn(b.styles[s.k], s) : '–'}</td>`).join('');
    box.innerHTML = `<div class="pc-calc">
      <div class="pc-grid">
        <label>Artist price ${curOf(w) === 'AED' ? 'AED' : '₹'} <input id="pcA" type="number" min="0" step="${curOf(w) === 'AED' ? 1 : 50}" value="${o.artist ?? ''}" style="width:100px"></label>
        <label>Artwork size <select id="pcT">${TIERS.map((t) => `<option ${t === b.tier ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>Base frame size <select id="pcF">${FRAME_SIZES.map(([f]) => `<option ${f === b.fsize ? 'selected' : ''}>${f}</option>`).join('')}</select> cm</label>
        <label>${isLocalArt(w) ? 'Pickup from the artist' : 'Courier India → Dubai'} <input id="pcC" type="number" min="0" step="1" value="${o.courier ?? ''}" placeholder="${isLocalArt(w) ? 0 : P.courier[b.tier]}" style="width:80px"> ⃃</label>
        <label>Margin <input id="pcM" type="number" min="0" step="1" value="${o.margin != null ? Math.round(o.margin * 100) : ''}" placeholder="${Math.round(P.margin * 100)}" style="width:60px">%</label>
        <span class="muted" style="font-size:12px">${ap?.artistPriceAt ? `Artist's price given ${new Date(ap.artistPriceAt).toLocaleDateString('en-GB')}` : 'No price from the artist yet: type one to simulate.'}</span>
      </div>
      ${b.artistAed == null ? '<p class="muted">Enter the artist\'s price to see the calculation.</p>' : b.blocked ? `<p class="err">No supplier price for: ${esc(b.missing.join(', '))}. Add it to a frame shop's / delivery partner's price list (Artists &amp; sellers → Frame, print &amp; delivery → their price list), or pick another frame size above.</p>` : `
      <div class="tablewrap"><table class="costs pc-break"><thead><tr><th>${DHS} · frame ${esc(b.fsize)} cm</th>${STYLES.map((s) => `<th class="num">${s.n}</th>`).join('')}</tr></thead><tbody>
        <tr><td>${curOf(w) === 'AED' ? `Artist${w.artist ? ` (${esc(w.artist)})` : ''}` : `Artist (₹${Number(b.inr).toLocaleString('en-IN')} × ${P.fx})`}</td>${cell(() => Math.round(b.artistAed))}</tr>
        <tr><td>${isLocalArt(w) ? 'Pickup from the artist' : 'Courier India → Dubai'}</td>${cell(() => Math.round(b.courier))}</tr>
        <tr><td>Customs ${isLocalArt(w) ? '(none: made in the UAE)' : `${(P.customs * 100).toFixed(1)}%`}</td>${cell(() => Math.round(b.customs))}</tr>
        <tr><td>Fixing (mount, glass, fitting)</td>${cell((x) => Math.round(x.frameWork))}</tr>
        <tr><td>Frame</td>${cell((x) => Math.round(x.frame))}</tr>
        ${true ? `<tr><td class="muted" style="font-size:12px">Frame price from</td>${STYLES.map((s) => `<td class="num muted" style="font-size:11px">${esc(b.from?.[s.k] === 'master' ? 'master table' : b.from?.[s.k] || '–')}</td>`).join('')}</tr>` : ''}
        <tr><td>Courier Dubai → customer${b.localFrom ? ` <span class="muted" style="font-size:11px">${esc(b.localFrom)}</span>` : ''}</td>${cell(() => Math.round(b.local))}</tr>
        <tr class="tot"><td>Total cost</td>${cell((x) => Math.round(x.cost))}</tr>
        <tr><td>Margin ${Math.round(b.margin * 100)}%</td>${cell((x) => Math.round(x.marginAmt))}</tr>
        <tr><td>Card charges, insurance, reserve ${(((P.fee || 0) + (P.ins || 0) + (P.reserve || 0)) * 100).toFixed(1)}%</td>${cell((x) => Math.round(x.cardAmt))}</tr>
        <tr class="tot"><td>Cost-based price</td>${cell((x) => x.price)}</tr>
        <tr><td>Proposed price (after market check)</td>${cell((x) => x.price + lift)}</tr>
        ${m ? `<tr><td>Now on the website${m.v === 2 ? ` (${esc(m.base)})` : ''}</td>${STYLES.map((s) => `<td class="num mono">${basePrice(m, s.k) ?? '–'}</td>`).join('')}</tr>` : ''}
        <tr class="pc-final"><td><b>New price for the website</b><div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap"><button type="button" class="btn small ghost" id="pcUseProp">= proposed</button><button type="button" class="btn small ghost" id="pcUseCost">= cost-based</button>${m ? '<button type="button" class="btn small ghost" id="pcUseNow">= now on website</button>' : ''}</div></td>${STYLES.map((s) => `<td><input data-final="${s.k}" type="number" min="0" step="1" value="${fresh && m ? basePrice(m, s.k) ?? b.styles[s.k].price + lift : b.styles[s.k].price + lift}" style="width:84px"></td>`).join('')}</tr>
        <tr><td>Your margin at that price</td>${STYLES.map((s) => `<td class="num mono" data-mg="${s.k}"></td>`).join('')}</tr>
      </tbody></table></div>
      <div class="tablewrap"><table class="costs pc-break"><thead><tr><th>Bigger frames (customer's choice), ${DHS}</th>${STYLES.filter((s) => s.k !== 'none').map((s) => `<th class="num">${s.n}</th>`).join('')}</tr></thead><tbody id="pcSizes"></tbody></table></div>
      <div class="muted" style="font-size:12px;margin-top:-6px">A bigger frame adds its extra frame cost, with your margin and card charges, rounded up to Dhs 25. "No frame" has one price.</div>
      <div class="marketline">Market check (${b.tier}, ${md === 'sk' ? 'sketch' : 'watercolour'}): Kalai band <b>${aed(band[0])}–${aed(band[1])}</b> · <span id="pcVerdict"></span><br>
        <span class="muted">Competitors, similar originals: Saatchi Art ${esc(mk?.saatchi || '')} · Dubai print shops (copies, not originals) ⃃ 125–400.</span>
        <div style="margin-top:4px"><button type="button" class="linkbtn" id="pcBand">Set the black-frame price to the middle of the band</button></div></div>
      <div id="pcSim"></div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn" type="button" id="pcApprove">${m ? 'Update prices on the website' : 'Approve and show on the website'}</button>
        ${m ? '<button class="btn ghost small" type="button" id="pcRemove">Remove price (back to "Ask for price")</button>' : ''}
        <span class="muted" id="pcMsg" style="font-size:13px"></span></div>`}
    </div>`;
    const re = () => { fresh = false; o.artist = num($('pcA').value); o.tier = $('pcT').value; o.fsize = $('pcF').value; o.courier = num($('pcC').value); o.margin = num($('pcM').value) != null ? num($('pcM').value) / 100 : null; render(); };
    ['pcA', 'pcC', 'pcM'].forEach((id) => $(id).addEventListener('change', re)); $('pcT').addEventListener('change', re); $('pcF').addEventListener('change', re);
    if (b.artistAed == null || b.blocked) return;
    // Prices for every frame size from the base one: base final price + (extra frame cost × margin ÷ card share), to Dhs 25.
    const pct = (P.fee || 0) + (P.ins || 0) + (P.reserve || 0);
    const sizesMatrix = () => {
      const fin = Object.fromEntries(STYLES.map((s) => [s.k, num(box.querySelector(`[data-final="${s.k}"]`).value) ?? 0]));
      const out = {};
      for (const fs of sizesFrom(b.fsize)) {
        const bb = build(w, { ...o, fsize: fs });
        if (bb.blocked) continue;
        out[fs] = Object.fromEntries(STYLES.filter((s) => s.k !== 'none').map((s) => {
          const extra = (bb.styles[s.k].cost - b.styles[s.k].cost) * (1 + b.margin) / (1 - pct);
          return [s.k, fs === b.fsize ? fin[s.k] : fin[s.k] + Math.ceil(extra / 25) * 25];
        }));
      }
      return { v: 2, base: b.fsize, none: fin.none, sizes: out };
    };
    const check = () => {
      const sm = sizesMatrix();
      $('pcSizes').innerHTML = Object.entries(sm.sizes).map(([fs, row]) => `<tr><td>${esc(fs)} cm${fs === sm.base ? ' (base)' : ''}</td>${STYLES.filter((s) => s.k !== 'none').map((s) => `<td class="num mono">${row[s.k]}</td>`).join('')}</tr>`).join('');
      STYLES.forEach((s) => {
        const p = num(box.querySelector(`[data-final="${s.k}"]`).value) ?? 0, x = b.styles[s.k];
        const net = p * (1 - ((P.fee || 0) + (P.ins || 0) + (P.reserve || 0))) - x.cost;
        const c = box.querySelector(`[data-mg="${s.k}"]`); c.textContent = `${Math.round(net)} (${p ? Math.round((net / p) * 100) : 0}%)`; c.style.color = net < p * 0.1 ? 'var(--kumkum)' : '';
      });
      const bp = num(box.querySelector('[data-final="black"]').value) ?? 0;
      $('pcVerdict').innerHTML = bp < band[0] ? `black-frame price ${aed(bp)} is <b class="warn-t">below the band</b>` : bp > band[1] ? `black-frame price ${aed(bp)} is <b class="warn-t">above the band</b>` : `black-frame price ${aed(bp)} is <b class="ok-t">inside the band</b>`;
    };
    box.querySelectorAll('[data-final]').forEach((i) => i.addEventListener('input', check)); check();
    const setFinals = (fn) => { STYLES.forEach((s) => { box.querySelector(`[data-final="${s.k}"]`).value = fn(s); }); check(); };
    $('pcUseProp').onclick = () => setFinals((s) => b.styles[s.k].price + lift);
    $('pcUseCost').onclick = () => setFinals((s) => b.styles[s.k].price);
    drawSim($('pcSim'), { tier: b.tier, md, styles: STYLES, b, pct, now: (k) => basePrice(m, k), setFinals, client });
    if ($('pcUseNow')) $('pcUseNow').onclick = () => setFinals((s) => basePrice(m, s.k) ?? b.styles[s.k].price);
    $('pcBand').onclick = () => {
      // Lift every frame style by the same amount, so the black frame sits mid-band.
      const target = Math.ceil((band[0] + band[1]) / 2 / 25) * 25, diff = target - b.styles.black.price;
      STYLES.forEach((s) => { const i = box.querySelector(`[data-final="${s.k}"]`); i.value = Math.max(0, Math.round(b.styles[s.k].price + diff)); });
      check();
    };
    $('pcApprove').onclick = async () => {
      const flat = Object.fromEntries(STYLES.map((s) => [s.k, num(box.querySelector(`[data-final="${s.k}"]`).value)]));
      if (STYLES.some((s) => !(flat[s.k] > 0))) { $('pcMsg').textContent = 'Every frame style needs a price.'; return; }
      const matrix = sizesMatrix();
      $('pcApprove').disabled = true; $('pcMsg').textContent = 'Saving…';
      try {
        const now = new Date().toISOString();
        const r1 = await client.models.Product.update({ id: w.id, priceMatrix: JSON.stringify(matrix), priceApprovedAt: now, ...goLive(w) });
        if (r1.errors?.length) throw new Error(r1.errors[0].message);
        Object.assign(w, { priceMatrix: JSON.stringify(matrix), priceApprovedAt: now, ...goLive(w) });
        const rec = { productId: w.id, calc: JSON.stringify({ artistUsed: o.artist ?? ap?.artistPrice ?? null, costUsed: build(w, o).styles.black?.cost ?? null, tier: o.tier, fsize: o.fsize, courier: o.courier, margin: o.margin, master: P, at: now }), approvedAt: now,
          ...(o.artist != null && o.artist !== ap?.artistPrice ? { artistPrice: o.artist, currency: curOf(w), artistNote: 'Entered by the studio' } : {}) };
        const r2 = ap ? await client.models.ArtworkPrice.update(rec) : await client.models.ArtworkPrice.create({ currency: curOf(w), ...rec });
        if (!r2.errors?.length) prices.set(w.id, { ...(ap || {}), ...r2.data });
        $('pcMsg').textContent = 'Saved: the website now shows these prices.';
        setTimeout(() => { openId = null; drawList(); }, 900);
      } catch (ex) { $('pcMsg').textContent = ex.message; $('pcApprove').disabled = false; }
    };
    if ($('pcRemove')) $('pcRemove').onclick = async () => {
      try { const r = await client.models.Product.update({ id: w.id, priceMatrix: null, priceApprovedAt: null }); if (r.errors?.length) throw new Error(r.errors[0].message); w.priceMatrix = null; openId = null; drawList(); }
      catch (ex) { $('pcMsg').textContent = ex.message; }
    };
  };
  render();
}

/** Prices approved before frame sizes existed (style only): add the frame sizes, keeping the approved prices
 *  (rounded up to Dhs 25) for the base size. Runs when the Pricing tab opens. */
async function upgradeOld() {
  let n = 0;
  for (const w of works) {
    const m = matrixOf(w);
    if (!m || m.v === 2) continue;
    const b = build(w);
    if (b.artistAed == null || b.blocked) continue;
    const pct = (P.fee || 0) + (P.ins || 0) + (P.reserve || 0), up = (x) => Math.ceil(x / 25) * 25;
    const sizes = {};
    for (const fs of sizesFrom(b.fsize)) {
      const bb = build(w, { fsize: fs });
      if (bb.blocked) continue;
      sizes[fs] = Object.fromEntries(STYLES.filter((s) => s.k !== 'none').map((s) => [s.k, up(m[s.k] ?? b.styles[s.k].price) + (fs === b.fsize ? 0 : up((bb.styles[s.k].cost - b.styles[s.k].cost) * (1 + b.margin) / (1 - pct)))]));
    }
    const matrix = { v: 2, base: b.fsize, none: up(m.none ?? b.styles.none.price), sizes };
    const r = await client.models.Product.update({ id: w.id, priceMatrix: JSON.stringify(matrix) }).catch(() => null);
    if (r && !r.errors?.length) { w.priceMatrix = JSON.stringify(matrix); n++; }
  }
  return n;
}

/** Opens one work's price calculation (from an order: the artwork no. AT-… or the product id). */
export async function openPriceFor(key) {
  await showPricing();
  const k = String(key || '').trim().toLowerCase(), w = works.find((x) => String(x.id).toLowerCase() === k || String(x.code || '').toLowerCase() === k);
  if (!w) { if ($('pcFind')) { $('pcFind').value = key || ''; drawList(); } return false; }
  filter = 'ALL'; openId = w.id; if ($('pcFind')) $('pcFind').value = w.code || '';
  drawList(); document.querySelector(`#pcList tr[data-id="${CSS.escape(w.id)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  return true;
}
export async function showPricing() {
  if (!wired) {
    wired = true;
    $('pcReload').onclick = () => showPricing();
  }
  try { await loadAll(); } catch (ex) { $('pcList').innerHTML = `<p class="err">${esc(ex.message)}</p>`; return; }
  upgradeOld().then((n) => { if (n) { $('pcMasterMsg') && ($('pcMasterMsg').textContent = `${n} earlier price list(s) now have frame sizes and Dhs 25 rounding.`); drawList(); } });
  $('pcMaster').innerHTML = masterHtml();
  $('pcToSettings').onclick = () => window.kalaiPriceTab?.('charges');
  drawList();
}
