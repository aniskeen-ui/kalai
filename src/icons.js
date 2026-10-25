// Line icons for the order screen sections (24 × 24, stroke = the theme's accent colour). Added to each card's title
// automatically, also when a card is redrawn.
const P = {
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  pin: '<path d="M12 22s7-7.2 7-12.5A7 7 0 0 0 5 9.5C5 14.8 12 22 12 22z"/><circle cx="12" cy="9.5" r="2.5"/>',
  truck: '<path d="M2 6h11v10H2z"/><path d="M13 9h4l4 4v3h-8"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  frame: '<rect x="3" y="3" width="18" height="18" rx="1"/><rect x="7" y="7" width="10" height="10"/><path d="M3 3l4 4M21 3l-4 4M3 21l4-4M21 21l-4-4"/>',
  printer: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
  receipt: '<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
  calc: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M8 6h8v4H8zM8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/>',
  bag: '<path d="M5 7h14l-1 14H6z"/><path d="M9 10V6a3 3 0 0 1 6 0v4"/>',
  refund: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/><path d="M12 8v8M9.5 10.5c0-1 1-1.5 2.5-1.5s2.5.6 2.5 1.6-1 1.4-2.5 1.4-2.5.5-2.5 1.5 1 1.5 2.5 1.5 2.5-.5 2.5-1.5"/>',
  star: '<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>',
  tag: '<path d="M3 12V3h9l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  licence: '<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6"/><circle cx="12" cy="14" r="3"/><path d="M10.5 16.5 10 21l2-1 2 1-.5-4.5"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  store: '<path d="M3 9l2-5h14l2 5"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M5 12v9h14v-9M10 21v-5h4v5"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v14a2 2 0 0 0-2-2H4z"/><path d="M20 4h-6a3 3 0 0 0-3 3v14a2 2 0 0 1 2-2h7z"/>',
  flow: '<rect x="2" y="3" width="7" height="6" rx="1"/><rect x="15" y="3" width="7" height="6" rx="1"/><rect x="8.5" y="15" width="7" height="6" rx="1"/><path d="M9 6h6M5.5 9v3h13V9M12 12v3"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  palette: '<path d="M12 3a9 9 0 0 0 0 18c1.5 0 2-1 2-2s-1-1.5-1-2.5 1-1.5 2-1.5h2a4 4 0 0 0 4-4c0-4.5-4-8-9-8z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7" r="1"/>',
};
// Card title → icon (first match wins).
const RULES = [
  [/^customer review/i, 'star'], [/^customer'?s offer/i, 'tag'], [/^customer/i, 'user'],
  [/^delivery address/i, 'pin'], [/^frame shop/i, 'frame'], [/^delivery/i, 'truck'],
  [/^actual cost/i, 'receipt'], [/^cost/i, 'calc'], [/^payment/i, 'card'], [/^online payments/i, 'card'],
  [/^purchase/i, 'bag'], [/^cancellation|refund/i, 'refund'], [/^image licence|licence/i, 'licence'],
  [/^rework|repair/i, 'wrench'], [/^market|seller/i, 'store'], [/^action/i, 'bolt'], [/zoho/i, 'book'],
  [/document flow/i, 'flow'], [/^printing/i, 'printer'], [/^framing/i, 'frame'], [/^artist/i, 'palette'],
];
const svg = (k) => `<svg class="sec-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[k]}</svg>`;
const pick = (t) => (RULES.find(([re]) => re.test(t.trim())) || [])[1];

function add(el, text) {
  if (!el || el.dataset.ico) return;
  const k = pick(text ?? el.textContent ?? '');
  el.dataset.ico = '1';
  if (k) el.insertAdjacentHTML('afterbegin', svg(k));
}
/** Puts the icons on every card title inside root. */
export function iconize(root) {
  if (!root) return;
  root.querySelectorAll('fieldset.cost > legend').forEach((l) => add(l));
  root.querySelectorAll('#supplierBox > div > div:first-child > b:first-child').forEach((b) => add(b));
  root.querySelectorAll('[data-inbound] > div:first-child > b:first-child').forEach((b) => add(b));
  root.querySelectorAll('.lay-h > b').forEach((b) => add(b));
  root.querySelectorAll('#zohoBox > div:first-child > b:first-child').forEach((b) => add(b, 'zoho'));
  root.querySelectorAll('.dfl .dft > i').forEach((i) => {
    if (i.dataset.ico) return; i.dataset.ico = '1';
    const lane = i.closest('.dfl');
    const k = lane.classList.contains('cust') ? 'user' : lane.classList.contains('art') ? 'palette' : /🚚/.test(i.textContent) ? 'truck' : /print/i.test(lane.textContent) ? 'printer' : 'frame';
    i.innerHTML = svg(k).replace('class="sec-ico"', 'class="sec-ico lane-ico"');
  });
  root.querySelectorAll('.flowhead h3').forEach((h) => { if (!h.dataset.ico) { h.textContent = h.textContent.replace(/^\s*✨\s*/, ''); add(h); } });
}
/** Keeps the icons on while the screen is redrawn. */
export function watchIcons(...roots) {
  const run = () => roots.forEach((r) => iconize(typeof r === 'string' ? document.getElementById(r) : r));
  run();
  const mo = new MutationObserver(() => { mo.disconnect(); run(); roots.forEach((r) => { const el = typeof r === 'string' ? document.getElementById(r) : r; if (el) mo.observe(el, { childList: true, subtree: true }); }); });
  roots.forEach((r) => { const el = typeof r === 'string' ? document.getElementById(r) : r; if (el) mo.observe(el, { childList: true, subtree: true }); });
}
