// Mobile numbers with the country code picked from a list (every country; UAE and India first), and the address lists per country.
// Every tel field on a page gets a code picker automatically. The original input stays (hidden) with its id and
// name and always holds the full number ("+971 50 123 4567"), so existing form code keeps reading it as before.
// UAE and India first (their own emirate/state lists), then every other country (state or city typed in).
const OTHER = 'AF|Afghanistan|+93;AL|Albania|+355;DZ|Algeria|+213;AS|American Samoa|+1 684;AD|Andorra|+376;AO|Angola|+244;AI|Anguilla|+1 264;AG|Antigua and Barbuda|+1 268;AR|Argentina|+54;AM|Armenia|+374;AW|Aruba|+297;AU|Australia|+61;AT|Austria|+43;AZ|Azerbaijan|+994;BS|Bahamas|+1 242;BH|Bahrain|+973;BD|Bangladesh|+880;BB|Barbados|+1 246;BY|Belarus|+375;BE|Belgium|+32;BZ|Belize|+501;BJ|Benin|+229;BM|Bermuda|+1 441;BT|Bhutan|+975;BO|Bolivia|+591;BA|Bosnia and Herzegovina|+387;BW|Botswana|+267;BR|Brazil|+55;VG|British Virgin Islands|+1 284;BN|Brunei|+673;BG|Bulgaria|+359;BF|Burkina Faso|+226;BI|Burundi|+257;KH|Cambodia|+855;CM|Cameroon|+237;CA|Canada|+1;CV|Cape Verde|+238;KY|Cayman Islands|+1 345;CF|Central African Republic|+236;TD|Chad|+235;CL|Chile|+56;CN|China|+86;CO|Colombia|+57;KM|Comoros|+269;CG|Congo|+242;CD|Congo (DR)|+243;CK|Cook Islands|+682;CR|Costa Rica|+506;CI|Côte d\'Ivoire|+225;HR|Croatia|+385;CU|Cuba|+53;CW|Curaçao|+599;CY|Cyprus|+357;CZ|Czechia|+420;DK|Denmark|+45;DJ|Djibouti|+253;DM|Dominica|+1 767;DO|Dominican Republic|+1 809;EC|Ecuador|+593;EG|Egypt|+20;SV|El Salvador|+503;GQ|Equatorial Guinea|+240;ER|Eritrea|+291;EE|Estonia|+372;SZ|Eswatini|+268;ET|Ethiopia|+251;FK|Falkland Islands|+500;FO|Faroe Islands|+298;FJ|Fiji|+679;FI|Finland|+358;FR|France|+33;GF|French Guiana|+594;PF|French Polynesia|+689;GA|Gabon|+241;GM|Gambia|+220;GE|Georgia|+995;DE|Germany|+49;GH|Ghana|+233;GI|Gibraltar|+350;GR|Greece|+30;GL|Greenland|+299;GD|Grenada|+1 473;GP|Guadeloupe|+590;GU|Guam|+1 671;GT|Guatemala|+502;GG|Guernsey|+44;GN|Guinea|+224;GW|Guinea-Bissau|+245;GY|Guyana|+592;HT|Haiti|+509;HN|Honduras|+504;HK|Hong Kong|+852;HU|Hungary|+36;IS|Iceland|+354;ID|Indonesia|+62;IR|Iran|+98;IQ|Iraq|+964;IE|Ireland|+353;IM|Isle of Man|+44;IL|Israel|+972;IT|Italy|+39;JM|Jamaica|+1 876;JP|Japan|+81;JE|Jersey|+44;JO|Jordan|+962;KZ|Kazakhstan|+7;KE|Kenya|+254;KI|Kiribati|+686;XK|Kosovo|+383;KW|Kuwait|+965;KG|Kyrgyzstan|+996;LA|Laos|+856;LV|Latvia|+371;LB|Lebanon|+961;LS|Lesotho|+266;LR|Liberia|+231;LY|Libya|+218;LI|Liechtenstein|+423;LT|Lithuania|+370;LU|Luxembourg|+352;MO|Macao|+853;MG|Madagascar|+261;MW|Malawi|+265;MY|Malaysia|+60;MV|Maldives|+960;ML|Mali|+223;MT|Malta|+356;MH|Marshall Islands|+692;MQ|Martinique|+596;MR|Mauritania|+222;MU|Mauritius|+230;YT|Mayotte|+262;MX|Mexico|+52;FM|Micronesia|+691;MD|Moldova|+373;MC|Monaco|+377;MN|Mongolia|+976;ME|Montenegro|+382;MS|Montserrat|+1 664;MA|Morocco|+212;MZ|Mozambique|+258;MM|Myanmar|+95;NA|Namibia|+264;NR|Nauru|+674;NP|Nepal|+977;NL|Netherlands|+31;NC|New Caledonia|+687;NZ|New Zealand|+64;NI|Nicaragua|+505;NE|Niger|+227;NG|Nigeria|+234;NU|Niue|+683;KP|North Korea|+850;MK|North Macedonia|+389;MP|Northern Mariana Islands|+1 670;NO|Norway|+47;OM|Oman|+968;PK|Pakistan|+92;PW|Palau|+680;PS|Palestine|+970;PA|Panama|+507;PG|Papua New Guinea|+675;PY|Paraguay|+595;PE|Peru|+51;PH|Philippines|+63;PL|Poland|+48;PT|Portugal|+351;PR|Puerto Rico|+1 787;QA|Qatar|+974;RE|Réunion|+262;RO|Romania|+40;RU|Russia|+7;RW|Rwanda|+250;KN|Saint Kitts and Nevis|+1 869;LC|Saint Lucia|+1 758;VC|Saint Vincent and the Grenadines|+1 784;WS|Samoa|+685;SM|San Marino|+378;ST|São Tomé and Príncipe|+239;SA|Saudi Arabia|+966;SN|Senegal|+221;RS|Serbia|+381;SC|Seychelles|+248;SL|Sierra Leone|+232;SG|Singapore|+65;SX|Sint Maarten|+1 721;SK|Slovakia|+421;SI|Slovenia|+386;SB|Solomon Islands|+677;SO|Somalia|+252;ZA|South Africa|+27;KR|South Korea|+82;SS|South Sudan|+211;ES|Spain|+34;LK|Sri Lanka|+94;SD|Sudan|+249;SR|Suriname|+597;SE|Sweden|+46;CH|Switzerland|+41;SY|Syria|+963;TW|Taiwan|+886;TJ|Tajikistan|+992;TZ|Tanzania|+255;TH|Thailand|+66;TL|Timor-Leste|+670;TG|Togo|+228;TO|Tonga|+676;TT|Trinidad and Tobago|+1 868;TN|Tunisia|+216;TR|Türkiye|+90;TM|Turkmenistan|+993;TC|Turks and Caicos Islands|+1 649;TV|Tuvalu|+688;UG|Uganda|+256;UA|Ukraine|+380;GB|United Kingdom|+44;US|United States|+1;UY|Uruguay|+598;VI|US Virgin Islands|+1 340;UZ|Uzbekistan|+998;VU|Vanuatu|+678;VA|Vatican City|+39;VE|Venezuela|+58;VN|Vietnam|+84;WF|Wallis and Futuna|+681;YE|Yemen|+967;ZM|Zambia|+260;ZW|Zimbabwe|+263';
const flagOf = (iso) => iso.replace(/./g, (ch) => String.fromCodePoint(127397 + ch.charCodeAt(0)));
export const COUNTRIES = [
  { key: 'UAE', name: 'UAE', dial: '+971', flag: '🇦🇪', hint: '50 123 4567', region: 'Emirate' },
  { key: 'India', name: 'India', dial: '+91', flag: '🇮🇳', hint: '98765 43210', region: 'State' },
  ...OTHER.split(';').map((x) => { const [iso, name, dial] = x.split('|'); return { key: name, name, dial, flag: flagOf(iso), iso, hint: 'Mobile number', region: 'State / province / city' }; }),
];
// Shared codes: a number "+1 …" is read as the United States, "+7" Russia, "+44" the UK, "+39" Italy, "+262" Réunion.
const MAIN = ['United States', 'Russia', 'United Kingdom', 'Italy', 'Réunion'];
const compactDial = (c) => c.dial.replace(/\s/g, '');
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
  const hits = COUNTRIES.filter((x) => compact.startsWith(compactDial(x)));
  const len = Math.max(0, ...hits.map((x) => compactDial(x).length));
  const best = hits.filter((x) => compactDial(x).length === len);
  const c = best.find((x) => MAIN.includes(x.name)) || best[0];
  if (c) {
    // Drop the code's digits (however they were spaced) from the front of the number.
    let digits = compactDial(c).length - 1, i = 0; const t = raw.replace(/^\s*(\+|00)\s*/, '');
    while (digits > 0 && i < t.length) { if (/\d/.test(t[i])) digits--; i++; }
    return { c, num: t.slice(i).replace(/^[\s-]+/, '').trim() };
  }
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
  sel.style.cssText = 'width:auto;max-width:130px;flex:0 0 auto;padding-inline:6px';
  sel.innerHTML = COUNTRIES.map((c, i) => `${i === 2 ? '<option disabled>──────────</option>' : ''}<option value="${c.key.replace(/"/g, '&quot;')}">${c.flag} ${c.name} ${c.dial}</option>`).join('');
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

/** Country + emirate/state pickers that switch together. Returns HTML; call wireRegion(form) after inserting it.
 *  only: limit the countries (the artist/seller portal is for the UAE and India). Other countries: state/city typed in. */
const attr = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
function regionField(c, region, id, n) {
  if (c.key === 'UAE' || c.key === 'India') return `<select id="${id}" ${n} data-region><option value="">Choose…</option>${regionsOf(c.key).map((x) => `<option ${x === region ? 'selected' : ''}>${x}</option>`).join('')}</select>`;
  return `<input id="${id}" ${n} data-region maxlength="60" value="${attr(region)}" placeholder="e.g. California, Ontario, London">`;
}
export function countryRegionHtml({ country = 'UAE', region = '', pin = '', prefix = 'ad', names = true, only = null } = {}) {
  const list = only ? COUNTRIES.filter((x) => only.includes(x.key)) : COUNTRIES;
  const c = list.find((x) => x.key === country) || countryOf(country);
  const n = (x) => (names ? `name="${x}"` : '');
  return `<div class="field"><label for="${prefix}Country">Country</label><select id="${prefix}Country" ${n('country')} data-country>${list.map((x, i) => `${i === 2 && !only ? '<option disabled>──────────</option>' : ''}<option value="${attr(x.key)}" ${x.key === c.key ? 'selected' : ''}>${x.name}</option>`).join('')}</select></div>
    <div class="field"><label for="${prefix}Region" data-region-label>${c.region}</label>${regionField(c, region, `${prefix}Region`, n('emirate'))}</div>
    <div class="field" data-pin-box ${c.key === 'UAE' ? 'hidden' : ''}><label for="${prefix}Pin" data-pin-label>${c.key === 'India' ? 'PIN code' : 'Postal code'}</label><input id="${prefix}Pin" ${n('pin')} ${c.key === 'India' ? 'inputmode="numeric" maxlength="6" placeholder="6 digits"' : 'maxlength="12" placeholder="If your country uses one"'} value="${attr(pin)}"></div>`;
}
export function wireRegion(scope) {
  const country = scope.querySelector('select[data-country]');
  if (!country || !scope.querySelector('[data-region]')) return;
  country.addEventListener('change', () => {
    const c = countryOf(country.value);
    const old = scope.querySelector('[data-region]');
    const tmp = document.createElement('div');
    tmp.innerHTML = regionField(c, '', old.id, old.getAttribute('name') ? `name="${old.getAttribute('name')}"` : '');
    old.replaceWith(tmp.firstElementChild);
    const lab = scope.querySelector('[data-region-label]'); if (lab) lab.textContent = c.region;
    const box = scope.querySelector('[data-pin-box]');
    if (box) {
      box.hidden = c.key === 'UAE';
      const pl = box.querySelector('[data-pin-label]'), pi = box.querySelector('input');
      if (pl) pl.textContent = c.key === 'India' ? 'PIN code' : 'Postal code';
      if (pi) { pi.maxLength = c.key === 'India' ? 6 : 12; pi.placeholder = c.key === 'India' ? '6 digits' : 'If your country uses one'; pi.inputMode = c.key === 'India' ? 'numeric' : 'text'; }
    }
  });
}
/** One line for display: "Villa 12, Mirdif, Dubai" / "12 MG Road, Chennai, Tamil Nadu 600001, India" / "…, London SW1A 1AA, United Kingdom". */
export function addressLine(e) {
  const c = e.deliveryCountry || 'UAE';
  return [e.deliveryAddress, e.deliveryLandmark ? `near ${e.deliveryLandmark}` : '', `${e.deliveryEmirate || ''}${c !== 'UAE' && e.deliveryPin ? ` ${e.deliveryPin}` : ''}`.trim(), c !== 'UAE' ? c : ''].filter(Boolean).join(', ');
}
