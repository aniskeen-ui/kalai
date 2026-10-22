// Mobile numbers with the country code picked from a list (UAE / India), and the address lists per country.
// Every tel field on a page gets a code picker automatically. The original input stays (hidden) with its id and
// name and always holds the full number ("+971 50 123 4567"), so existing form code keeps reading it as before.
export const COUNTRIES = [
  { key: 'UAE', name: 'UAE', dial: '+971', flag: '🇦🇪', hint: '50 123 4567', region: 'Emirate' },
  { key: 'India', name: 'India', dial: '+91', flag: '🇮🇳', hint: '98765 43210', region: 'State' },
];
export const EMIRATES = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'];
export const IN_STATES = ['Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka',
  'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal'];
export const regionsOf = (country) => (country === 'India' ? IN_STATES : EMIRATES);
export const countryOf = (key) => COUNTRIES.find((c) => c.key === key) || COUNTRIES[0];

/** "+971 50 123 4567" → { c, num: "50 123 4567" }. Numbers without a code are taken as UAE. */
export function splitPhone(v) {
  const raw = String(v ?? '').trim();
  const compact = raw.replace(/[\s()-]/g, '').replace(/^00/, '+');
  const c = COUNTRIES.find((x) => compact.startsWith(x.dial));
  if (c) return { c, num: raw.replace(/^\s*(\+|00)\s*/, '').replace(new RegExp('^' + c.dial.slice(1) + '\\s*'), '').trim() };
  return { c: null, num: raw };
}
export function joinPhone(c, num) {
  const n = String(num ?? '').replace(/[^\d\s]/g, '').trim().replace(/^0+/, '');
  return n ? `${c.dial} ${n}` : '';
}

const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

export function enhancePhone(input) {
  if (!input || input.dataset.cc || input.dataset.plain !== undefined || input.type === 'hidden') return;
  input.dataset.cc = '1';
  const wrap = document.createElement('div');
  wrap.className = 'cc-phone';
  wrap.style.cssText = 'display:flex;gap:6px;align-items:stretch;min-width:0';
  const sel = document.createElement('select');
  sel.setAttribute('aria-label', 'Country code');
  sel.style.cssText = 'width:auto;flex:0 0 auto;padding-inline:6px';
  sel.innerHTML = COUNTRIES.map((c) => `<option value="${c.key}">${c.name} ${c.dial}</option>`).join('');
  const vis = document.createElement('input');
  vis.type = 'tel'; vis.inputMode = 'tel'; vis.autocomplete = 'tel-national';
  vis.dataset.cc = 'num'; // the number box itself is never enhanced again
  vis.className = input.className;
  vis.style.cssText = 'flex:1;min-width:0';
  vis.id = input.id ? input.id + 'Num' : '';
  if (input.getAttribute('aria-label')) vis.setAttribute('aria-label', input.getAttribute('aria-label'));
  if (input.disabled) { vis.disabled = true; sel.disabled = true; }
  input.parentNode.insertBefore(wrap, input);
  wrap.append(sel, vis, input);
  input.type = 'hidden';
  if (input.id) document.querySelectorAll(`label[for="${CSS.escape(input.id)}"]`).forEach((l) => { l.htmlFor = vis.id; });
  const apply = (v) => {
    const { c, num } = splitPhone(v);
    if (c) sel.value = c.key;
    vis.value = num;
    vis.placeholder = countryOf(sel.value).hint;
  };
  const sync = () => { nativeValue.set.call(input, joinPhone(countryOf(sel.value), vis.value)); vis.placeholder = countryOf(sel.value).hint; };
  // Code that sets or reads the original field still works.
  Object.defineProperty(input, 'value', { configurable: true, get() { return nativeValue.get.call(input); }, set(v) { apply(v); sync(); } });
  input.focus = () => vis.focus();
  apply(nativeValue.get.call(input));
  sync();
  vis.addEventListener('input', () => { sync(); input.dispatchEvent(new Event('input', { bubbles: true })); });
  sel.addEventListener('change', () => { sync(); input.dispatchEvent(new Event('input', { bubbles: true })); vis.focus(); });
  // A country picker in the same form (address forms) sets the code too.
  const scope = input.closest('form, fieldset, .req, .acct-body, section') || document;
  const country = scope.querySelector('select[data-country]');
  if (country) {
    const follow = () => { sel.value = countryOf(country.value).key; sync(); };
    country.addEventListener('change', follow);
    if (!splitPhone(nativeValue.get.call(input)).c) follow();
  }
}

/** Enhance every mobile field on the page now and whenever new forms appear. */
export function autoPhones(root = document) {
  const run = (el) => el.querySelectorAll?.('input[type="tel"], input[inputmode="tel"]').forEach(enhancePhone);
  run(root);
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) { if (n.matches?.('input[type="tel"], input[inputmode="tel"]')) enhancePhone(n); run(n); } }))).observe(root.body || root, { childList: true, subtree: true });
}

/** Country + emirate/state pickers that switch together. Returns HTML; call wireRegion(form) after inserting it. */
export function countryRegionHtml({ country = 'UAE', region = '', pin = '', prefix = 'ad', names = true } = {}) {
  const c = countryOf(country);
  const n = (x) => (names ? `name="${x}"` : '');
  return `<div class="field"><label for="${prefix}Country">Country</label><select id="${prefix}Country" ${n('country')} data-country>${COUNTRIES.map((x) => `<option value="${x.key}" ${x.key === c.key ? 'selected' : ''}>${x.name}</option>`).join('')}</select></div>
    <div class="field"><label for="${prefix}Region" data-region-label>${c.region}</label><select id="${prefix}Region" ${n('emirate')} data-region><option value="">Choose…</option>${regionsOf(c.key).map((x) => `<option ${x === region ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
    <div class="field" data-pin-box ${c.key === 'India' ? '' : 'hidden'}><label for="${prefix}Pin">PIN code</label><input id="${prefix}Pin" ${n('pin')} inputmode="numeric" maxlength="6" value="${String(pin ?? '').replace(/"/g, '')}" placeholder="6 digits"></div>`;
}
export function wireRegion(scope) {
  const country = scope.querySelector('select[data-country]');
  const region = scope.querySelector('select[data-region]');
  if (!country || !region) return;
  country.addEventListener('change', () => {
    const c = countryOf(country.value);
    region.innerHTML = `<option value="">Choose…</option>${regionsOf(c.key).map((x) => `<option>${x}</option>`).join('')}`;
    const lab = scope.querySelector('[data-region-label]'); if (lab) lab.textContent = c.region;
    const pin = scope.querySelector('[data-pin-box]'); if (pin) pin.hidden = c.key !== 'India';
  });
}
/** One line for display: "Villa 12, Mirdif, Dubai" / "12 MG Road, Chennai, Tamil Nadu 600001, India". */
export function addressLine(e) {
  const india = e.deliveryCountry === 'India';
  return [e.deliveryAddress, e.deliveryLandmark ? `near ${e.deliveryLandmark}` : '', `${e.deliveryEmirate || ''}${india && e.deliveryPin ? ` ${e.deliveryPin}` : ''}`.trim(), india ? 'India' : ''].filter(Boolean).join(', ');
}
