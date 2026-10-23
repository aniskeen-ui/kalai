// Supplier rate cards (supplier portal → My rates), and the cost of one order with each supplier (Order Management).
// Frame shop: frame price per style and size, plus a fixing charge per size (or "fixing included").
// Delivery partner: price per destination emirate for a small parcel (up to A3 / 40×50) and a large one, and
// optionally per zone outside the UAE. Later a courier aggregator (e.g. Shipy) can quote live instead.
export const RC_STYLES = [['black', 'Black slim'], ['white', 'White'], ['oak', 'Natural wood / oak'], ['walnut', 'Walnut'], ['gold', 'Gold']];
export const RC_SIZES = ['A4', 'A3', '30×40', '40×50', '50×70', '60×80', '70×100'];
export const RC_EMIRATES = ['Dubai', 'Sharjah', 'Ajman', 'Abu Dhabi', 'Ras Al Khaimah', 'Umm Al Quwain', 'Fujairah'];
export const RC_ZONES = [['A', 'GCC'], ['B', 'South Asia'], ['C', 'UK & Europe'], ['D', 'USA, Canada, Australia, NZ'], ['E', 'Rest of the world']];
const SMALL = ['A4', 'A3', '30×40', '40×50'];

export function parseCard(p) {
  let v = p?.rateCard;
  try { if (typeof v === 'string') v = JSON.parse(v); if (typeof v === 'string') v = JSON.parse(v); } catch { v = null; }
  return v && typeof v === 'object' ? v : {};
}

/** Frame style and size of an order, from what the customer chose. */
export function specOf(e, det) {
  // "Natural oak frame 50×70 cm, white mount": the mount colour is not the frame's.
  const t = `${det.Framing || ''} ${det.Frame || ''} ${det['Frame style'] || ''}`.toLowerCase().replace(/(white|cream|black)?\s*mount/g, '');
  const style = /black/.test(t) ? 'black' : /white/.test(t) ? 'white' : /walnut/.test(t) ? 'walnut' : /gold/.test(t) ? 'gold' : /oak|wood|natural/.test(t) ? 'oak' : /unframed|no frame/.test(t) ? 'none' : 'black';
  const m = String(det.Framing || det['Frame size'] || '').match(/(\d{2,3})\s*[x×]\s*(\d{2,3})/);
  let size = m ? `${m[1]}×${m[2]}` : '';
  if (!RC_SIZES.includes(size)) size = e.kind === 'GIFT' ? (/A3|Large size/i.test(`${det.Extras || ''}`) ? 'A3' : 'A4') : size || '40×50';
  return { style, size, small: SMALL.includes(size) };
}

/** Frame shop's cost for this spec (frame + fixing), or null when its card has no price for it. */
export function frameCost(card, spec) {
  if (spec.style === 'none') return card.fixing?.[spec.size] != null ? Number(card.fixing[spec.size]) : null;
  const f = card.frames?.[spec.style]?.[spec.size];
  if (f == null || f === '') return null;
  const fix = card.fixingIncluded ? 0 : Number(card.fixing?.[spec.size] || 0);
  return Math.round((Number(f) + fix) * 100) / 100;
}

/** Delivery partner's cost to this order's address, or null when its card has no price for it. */
export function deliveryCost(card, e, spec, zoneOf) {
  const country = e.deliveryCountry || 'UAE';
  const big = spec.small ? 'small' : 'large';
  if (country === 'UAE') {
    const em = String(e.deliveryEmirate || '').split(' (')[0];
    const v = card.uae?.[em]?.[big];
    return v == null || v === '' ? null : Number(v);
  }
  const z = zoneOf ? zoneOf(country) : 'E';
  const v = card.intl?.[z]?.[big];
  return v == null || v === '' ? null : Number(v);
}

// Same zones as Little Artists shipping.
const ZONE = { A: ['Saudi Arabia', 'Oman', 'Qatar', 'Bahrain', 'Kuwait'], B: ['India', 'Sri Lanka', 'Pakistan', 'Bangladesh', 'Nepal', 'Maldives', 'Bhutan'],
  D: ['United States', 'Canada', 'Australia', 'New Zealand'] };
const EU = ['United Kingdom', 'Ireland', 'France', 'Germany', 'Italy', 'Spain', 'Portugal', 'Netherlands', 'Belgium', 'Luxembourg', 'Switzerland', 'Austria', 'Denmark', 'Sweden', 'Norway', 'Finland', 'Iceland', 'Poland', 'Czechia', 'Slovakia', 'Hungary', 'Slovenia', 'Croatia', 'Romania', 'Bulgaria', 'Greece', 'Cyprus', 'Malta', 'Estonia', 'Latvia', 'Lithuania', 'Monaco', 'Liechtenstein', 'Andorra', 'San Marino', 'Vatican City', 'Jersey', 'Guernsey', 'Isle of Man', 'Gibraltar', 'Serbia', 'Bosnia and Herzegovina', 'Montenegro', 'North Macedonia', 'Albania', 'Kosovo', 'Moldova', 'Ukraine'];
export const zoneOf = (c) => (EU.includes(c) ? 'C' : Object.keys(ZONE).find((z) => ZONE[z].includes(c)) || 'E');
