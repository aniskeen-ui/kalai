// Supplier rate cards (supplier portal → My rates), and the cost of one order with each supplier (Order Management).
// Frame shop: frame price per style and size, plus a fixing charge per size (or "fixing included").
// Delivery partner: price per destination emirate and parcel size (older cards: small / large), and
// per zone outside the UAE, and per country (and region) to override the zone. Later a courier aggregator (e.g. Shipy) can quote live instead.
export const RC_STYLES = [['black', 'Black slim'], ['white', 'White'], ['oak', 'Natural wood / oak'], ['walnut', 'Walnut'], ['gold', 'Gold']];
export const RC_SIZES = ['A4', 'A3', '30×40', '40×50', '50×70', '60×80', '70×100'];
export const RC_EMIRATES = ['Dubai', 'Sharjah', 'Ajman', 'Abu Dhabi', 'Ras Al Khaimah', 'Umm Al Quwain', 'Fujairah'];
export const RC_ZONES = [['A', 'GCC'], ['B', 'South Asia'], ['C', 'UK & Europe'], ['D', 'USA, Canada, Australia, NZ'], ['E', 'Rest of the world']];
const SMALL = ['A4', 'A3', '30×40', '40×50'];
// Delivery partners price by parcel size (couriers bill by volumetric weight, so a 70×100 costs far more than a 30×40).
export const RC_PARCELS = [['s1', 'Up to 30×40 / A3'], ['40×50', '40×50'], ['50×70', '50×70'], ['60×80', '60×80'], ['70×100', '70×100']];
export const parcelOf = (size) => (['A4', 'A3', '30×40'].includes(size) ? 's1' : size);
/** A courier's price for one cell: the size price, else the older small/large price. */
export const parcelPrice = (row, size) => {
  if (!row) return null;
  const v = row[parcelOf(size)] ?? row[SMALL.includes(size) ? 'small' : 'large'];
  return v == null || v === '' ? null : Number(v);
};

export function rawCard(p) {
  let v = p?.rateCard;
  try { if (typeof v === 'string') v = JSON.parse(v); if (typeof v === 'string') v = JSON.parse(v); } catch { v = null; }
  return v && typeof v === 'object' ? v : {};
}
// A supplier in India keeps its price list in rupees (currency 'INR'). Costing works in dirhams, so parseCard
// converts every price at the Rates exchange rate (⃃ per ₹, set by the page with setInrFx). rawCard = as entered.
let INR_FX = 0.042;
export const setInrFx = (v) => { if (Number(v) > 0) INR_FX = Number(v); };
export const inrFx = () => INR_FX;
/** A supplier kept for some order kinds only (card.onlyFor, e.g. ['GIFT', 'PHOTO'] = Little Artists and framed prints:
 *  ready-made shop frames like Day to Day). No list = every kind. */
export const servesKind = (card, kind) => !Array.isArray(card?.onlyFor) || !card.onlyFor.length || !kind || card.onlyFor.includes(kind);
export const cardSym = (c) => (c?.currency === 'INR' ? '₹' : '⃃');
const PRICE_KEYS = ['frames', 'fixing', 'print', 'uae', 'intl', 'country'];
export function parseCard(p) {
  const c = rawCard(p);
  if (c.currency !== 'INR') return c;
  const conv = (o) => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, conv(v)]))
    : typeof o === 'number' || (typeof o === 'string' && o !== '' && !Number.isNaN(Number(o))) ? Math.round(Number(o) * INR_FX * 100) / 100 : o);
  const out = { ...c, currency: 'AED', currencyEntered: 'INR' };
  for (const k of PRICE_KEYS) if (c[k] != null) out[k] = conv(c[k]);
  return out;
}

/** Frame style and size of an order, from what the customer chose. */
const FIT = [['30×40', 30, 40], ['40×50', 40, 50], ['50×70', 50, 70], ['60×80', 60, 80], ['70×100', 70, 100]]; // = pricing.js FRAME_SIZES
export function specOf(e, det) {
  // "Natural oak frame 50×70 cm, white mount": the mount colour is not the frame's.
  const t = `${det.Framing || ''} ${det.Frame || ''} ${det['Frame style'] || ''}`.toLowerCase().replace(/(white|cream|black)?\s*mount/g, '');
  const style = /black/.test(t) ? 'black' : /white/.test(t) ? 'white' : /walnut/.test(t) ? 'walnut' : /gold/.test(t) ? 'gold' : /oak|wood|natural|teak|mango|pine|bamboo/.test(t) ? 'oak' : /unframed|no frame/.test(t) ? 'none' : 'black';
  const m = String(det.Framing || det['Frame size'] || (e.kind === 'COMMISSION' ? det.Size : '') || '').match(/(\d{2,3})\s*[x×]\s*(\d{2,3})/);
  let size = m ? `${m[1]}×${m[2]}` : '';
  // Photo framing: the size the customer picked ("A4 (21 × 30 cm)", "50 × 70 cm").
  if (e.kind === 'PHOTO') { const z = String(det.Size || ''); const n = z.match(/(\d{2,3})\s*[x×]\s*(\d{2,3})/); size = /^A4/.test(z) ? 'A4' : /^A3/.test(z) ? 'A3' : n ? `${n[1]}×${n[2]}` : 'A4'; }
  // A collection work with no frame size on the order ("Framed, ready to hang"): the frame that fits the work with its
  // mount, as the Pricing tab does (work + 8 cm each way → 21 × 30 cm in a 30×40). HDHX was costed at 40×50.
  if (!size && e.kind === 'PRICE') {
    const w = String(det.Artwork || det.Size || '').match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*cm/);
    if (w) { const lo = Math.min(+w[1], +w[2]) + 8, hi = Math.max(+w[1], +w[2]) + 8; size = (FIT.find(([, a, c]) => a >= lo && c >= hi) || FIT[FIT.length - 1])[0]; }
  }
  if (!RC_SIZES.includes(size)) size = e.kind === 'GIFT' ? (/A3|Large size/i.test(`${det.Extras || ''}`) ? 'A3' : 'A4') : size || '40×50';
  return { style, size, small: SMALL.includes(size) };
}

// Little Artists: the child's drawing arrives as a photo, so the frame shop prints it (A4 / A3) before framing.
export const PRINT_SIZES = ['A4', 'A3', '30×40', '40×50', '50×70', '60×80']; // A4/A3: Little Artists; all: Photo Framing
/** Copies to print and frame: 2 when the customer chose "a second framed copy". */
export const copiesOf = (det) => Math.max(1, Math.min(20, Number(det?.Copies) || (/second framed copy/i.test(`${det?.Extras || ''}`) ? 2 : 1)));
/** Print price for this spec, or null when the card has none (or the size isn't printed). */
export function printCost(card, spec) {
  const v = card.print?.[spec.size];
  return v == null || v === '' ? null : Number(v);
}

/** Frame shop's cost for this spec (frame + fixing), or null when its card has no price for it. */
export function frameCost(card, spec) {
  if (spec.style === 'none') return card.fixing?.[spec.size] != null ? Number(card.fixing[spec.size]) : null;
  const f = card.frames?.[spec.style]?.[spec.size];
  if (f == null || f === '') return null;
  const fix = card.fixingIncluded ? 0 : Number(card.fixing?.[spec.size] || 0);
  return Math.round((Number(f) + fix) * 100) / 100;
}

/** Where a courier's price for this order comes from: its price for the country + region, else the country, else
 *  the zone (outside the UAE), or the emirate (UAE). { price, from } — price null when the card has none. */
export function deliveryQuote(card, e, spec, zoneOf) {
  const country = e.deliveryCountry || 'UAE';
  if (country === 'UAE') { const em = String(e.deliveryEmirate || '').split(' (')[0]; return { price: parcelPrice(card.uae?.[em], spec.size), from: em || 'UAE' }; }
  const rows = card.country || {}, low = (x) => String(x || '').trim().toLowerCase();
  const find = (k) => { const key = Object.keys(rows).find((x) => low(x) === low(k)); return key ? parcelPrice(rows[key], spec.size) : null; };
  const region = String(e.deliveryEmirate || '').trim();
  if (region) { const v = find(`${country}|${region}`); if (v != null) return { price: v, from: `${region}, ${country}` }; }
  const c = find(country); if (c != null) return { price: c, from: country };
  const z = zoneOf ? zoneOf(country) : 'E';
  return { price: parcelPrice(card.intl?.[z], spec.size), from: `zone ${z} (${(RC_ZONES.find((x) => x[0] === z) || ['', ''])[1]})` };
}
/** Delivery partner's cost to this order's address, or null when its card has no price for it. */
export function deliveryCost(card, e, spec, zoneOf) { return deliveryQuote(card, e, spec, zoneOf).price; }

// Same zones as Little Artists shipping.
const ZONE = { A: ['Saudi Arabia', 'Oman', 'Qatar', 'Bahrain', 'Kuwait'], B: ['India', 'Sri Lanka', 'Pakistan', 'Bangladesh', 'Nepal', 'Maldives', 'Bhutan'],
  D: ['United States', 'Canada', 'Australia', 'New Zealand'] };
const EU = ['United Kingdom', 'Ireland', 'France', 'Germany', 'Italy', 'Spain', 'Portugal', 'Netherlands', 'Belgium', 'Luxembourg', 'Switzerland', 'Austria', 'Denmark', 'Sweden', 'Norway', 'Finland', 'Iceland', 'Poland', 'Czechia', 'Slovakia', 'Hungary', 'Slovenia', 'Croatia', 'Romania', 'Bulgaria', 'Greece', 'Cyprus', 'Malta', 'Estonia', 'Latvia', 'Lithuania', 'Monaco', 'Liechtenstein', 'Andorra', 'San Marino', 'Vatican City', 'Jersey', 'Guernsey', 'Isle of Man', 'Gibraltar', 'Serbia', 'Bosnia and Herzegovina', 'Montenegro', 'North Macedonia', 'Albania', 'Kosovo', 'Moldova', 'Ukraine'];
export const zoneOf = (c) => (EU.includes(c) ? 'C' : Object.keys(ZONE).find((z) => ZONE[z].includes(c)) || 'E');
/** Every country name in a zone (A–E), from the full country list. */
export const countriesInZone = (z, names) => names.filter((c) => c !== 'UAE' && zoneOf(c) === z);
