// Country themes for the website: the visitor sees colours, a pattern inspired by local art, a headline font and a
// greeting that follow the website language they read (English: their time zone; changeable with the flag button), and a
// festival look around the big local festivals (Diwali, Eid, Ramadan, Lunar New Year, Pongal, Onam, national days,
// Christmas…). Order Management → Settings → Country themes switches them on or off.
import { generateClient } from 'aws-amplify/data';

const T = {
  // Gulf and the Arab world: deep greens and maroons with gold, Islamic geometric star pattern, Reem Kufi headlines.
  AE: ['United Arab Emirates', '#14352f', '#b8893b', '#e9cf8f', '#00732f', 'star', 'Reem Kufi', 'Ahlan wa sahlan · أهلاً وسهلاً'],
  SA: ['Saudi Arabia', '#0b3d2a', '#c9a24a', '#e6cf8f', '#006c35', 'star', 'Reem Kufi', 'Marhaba · مرحباً'],
  QA: ['Qatar', '#3d0f1c', '#c8a15a', '#e8cfa0', '#8a1538', 'star', 'Reem Kufi', 'Ahlan · أهلاً'],
  KW: ['Kuwait', '#123a2c', '#c9a24a', '#e6d29b', '#007a3d', 'star', 'Reem Kufi', 'Ahlan wa sahlan · أهلاً وسهلاً'],
  BH: ['Bahrain', '#3a1115', '#c9a24a', '#efd0b0', '#ce1126', 'star', 'Reem Kufi', 'Marhaba · مرحباً'],
  OM: ['Oman', '#3a1013', '#c9a24a', '#efd0b0', '#db161b', 'star', 'Reem Kufi', 'Ahlan · أهلاً'],
  EG: ['Egypt', '#1f2f4a', '#c79b4b', '#e8d3a5', '#2f4f7f', 'star', 'Reem Kufi', 'Ahlan wa sahlan · أهلاً وسهلاً'],
  JO: ['Jordan', '#1f2f4a', '#c79b4b', '#e8d3a5', '#007a3d', 'star', 'Reem Kufi', 'Ahlan wa sahlan · أهلاً وسهلاً'],
  LB: ['Lebanon', '#1d3a2c', '#c79b4b', '#e8d3a5', '#00a651', 'star', 'Reem Kufi', 'Ahlan wa sahlan · أهلاً وسهلاً'],
  // South Asia: temple maroon, turmeric and kumkum, kolam dot pattern, Yeseva One headlines.
  IN: ['India', '#5a1414', '#e0a21a', '#f6d58a', '#c2410c', 'kolam', 'Yeseva One', 'Vanakkam · வணக்கம் · Namaste'],
  LK: ['Sri Lanka', '#4a1520', '#e8a33d', '#f6d08f', '#8d153a', 'kolam', 'Yeseva One', 'Ayubowan · ආයුබෝවන් · Vanakkam'],
  PK: ['Pakistan', '#0d3b26', '#c9a24a', '#e6d29b', '#01411c', 'star', 'Reem Kufi', 'Khush amdeed · خوش آمدید'],
  BD: ['Bangladesh', '#0b3a2a', '#d9a33c', '#f0d394', '#006a4e', 'kolam', 'Yeseva One', 'Swagatam · স্বাগতম'],
  NP: ['Nepal', '#3a1230', '#d9a33c', '#f0d394', '#dc143c', 'kolam', 'Yeseva One', 'Namaste · नमस्ते'],
  // East and South-East Asia.
  CN: ['China', '#5c0f0f', '#d4a017', '#f2d27a', '#b3261e', 'lattice', 'Noto Serif SC', '欢迎 · Huānyíng'],
  HK: ['Hong Kong', '#5c0f0f', '#d4a017', '#f2d27a', '#b3261e', 'lattice', 'Noto Serif SC', '歡迎 · Welcome'],
  TW: ['Taiwan', '#5c0f0f', '#d4a017', '#f2d27a', '#b3261e', 'lattice', 'Noto Serif SC', '歡迎 · Welcome'],
  SG: ['Singapore', '#1b3a4b', '#d4a017', '#f2d27a', '#c8102e', 'weave', 'Playfair Display', 'Welcome · 欢迎 · Selamat datang · வணக்கம்'],
  MY: ['Malaysia', '#1b2f5b', '#d4a017', '#f2d27a', '#cc0001', 'weave', 'Playfair Display', 'Selamat datang · Welcome'],
  ID: ['Indonesia', '#3b1f12', '#c9a24a', '#ecd29a', '#ce1126', 'weave', 'Playfair Display', 'Selamat datang'],
  PH: ['Philippines', '#0b2a5b', '#f2b705', '#ffe08a', '#ce1126', 'weave', 'Playfair Display', 'Mabuhay!'],
  JP: ['Japan', '#1b2a4a', '#c0392b', '#f3c1a7', '#bc002d', 'wave', 'Shippori Mincho', 'Yōkoso · ようこそ'],
  KR: ['South Korea', '#16243f', '#c4302b', '#f0b8b0', '#0047a0', 'lattice', 'Nanum Myeongjo', 'Hwanyeonghamnida · 환영합니다'],
  // Europe and the Americas: heritage navy and green, herringbone, classic serif headlines.
  GB: ['United Kingdom', '#1f2d3d', '#a6802d', '#e3cf9f', '#2f4f3a', 'herring', 'Playfair Display', 'Welcome'],
  IE: ['Ireland', '#1d3a2e', '#a6802d', '#e3cf9f', '#169b62', 'herring', 'Playfair Display', 'Fáilte · Welcome'],
  US: ['United States', '#1c2c44', '#b5452c', '#f0c7b8', '#7a2a2a', 'herring', 'Playfair Display', 'Welcome'],
  CA: ['Canada', '#2b1d24', '#b5452c', '#f0c7b8', '#d52b1e', 'herring', 'Playfair Display', 'Welcome · Bienvenue'],
  FR: ['France', '#22304a', '#b08d57', '#e6d4b0', '#3b4f7a', 'herring', 'Cormorant Garamond', 'Bienvenue'],
  DE: ['Germany', '#22304a', '#b08d57', '#e6d4b0', '#3b4f7a', 'herring', 'Cormorant Garamond', 'Willkommen'],
  IT: ['Italy', '#22304a', '#b08d57', '#e6d4b0', '#008c45', 'herring', 'Cormorant Garamond', 'Benvenuti'],
  ES: ['Spain', '#3a1a1a', '#c49a3a', '#ecd29a', '#aa151b', 'herring', 'Cormorant Garamond', 'Bienvenidos'],
  NL: ['Netherlands', '#22304a', '#d77a1f', '#f3cf9f', '#21468b', 'herring', 'Cormorant Garamond', 'Welkom'],
  PT: ['Portugal', '#1f3a2a', '#c49a3a', '#ecd29a', '#da291c', 'herring', 'Cormorant Garamond', 'Bem-vindo'],
  CH: ['Switzerland', '#3a1a1a', '#b08d57', '#e6d4b0', '#d52b1e', 'herring', 'Cormorant Garamond', 'Grüezi · Bienvenue'],
  RU: ['Russia', '#3d0d0d', '#d4a017', '#f2d27a', '#9b1c1c', 'lattice', 'Cormorant Garamond', 'Dobro pozhalovat · Добро пожаловать'],
  // Oceania and Africa: ochre and eucalyptus, dot pattern.
  AU: ['Australia', '#3a2a1a', '#c8742c', '#f1c48f', '#5a6b3a', 'dots', 'Playfair Display', "G'day · Welcome"],
  NZ: ['New Zealand', '#1d2b2a', '#c8742c', '#f1c48f', '#012169', 'dots', 'Playfair Display', 'Kia ora · Welcome'],
  ZA: ['South Africa', '#2b1d12', '#d99a2b', '#f2cf8a', '#007749', 'dots', 'Playfair Display', 'Welcome · Sawubona'],
  NG: ['Nigeria', '#14301f', '#d99a2b', '#f2cf8a', '#008751', 'dots', 'Playfair Display', 'Welcome · Ẹ kú àbọ̀'],
  KE: ['Kenya', '#2b1d12', '#d99a2b', '#f2cf8a', '#006600', 'dots', 'Playfair Display', 'Karibu · Welcome'],
};
// Time zone → country (the browser knows its time zone without asking the visitor anything).
const TZ = { 'Asia/Dubai': 'AE', 'Asia/Muscat': 'OM', 'Asia/Riyadh': 'SA', 'Asia/Qatar': 'QA', 'Asia/Kuwait': 'KW', 'Asia/Bahrain': 'BH', 'Africa/Cairo': 'EG', 'Asia/Amman': 'JO', 'Asia/Beirut': 'LB',
  'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Colombo': 'LK', 'Asia/Karachi': 'PK', 'Asia/Dhaka': 'BD', 'Asia/Kathmandu': 'NP', 'Asia/Katmandu': 'NP',
  'Asia/Shanghai': 'CN', 'Asia/Chongqing': 'CN', 'Asia/Urumqi': 'CN', 'Asia/Hong_Kong': 'HK', 'Asia/Taipei': 'TW', 'Asia/Singapore': 'SG', 'Asia/Kuala_Lumpur': 'MY', 'Asia/Jakarta': 'ID', 'Asia/Manila': 'PH', 'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR',
  'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Paris': 'FR', 'Europe/Berlin': 'DE', 'Europe/Rome': 'IT', 'Europe/Madrid': 'ES', 'Europe/Amsterdam': 'NL', 'Europe/Lisbon': 'PT', 'Europe/Zurich': 'CH', 'Europe/Moscow': 'RU',
  'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Brisbane': 'AU', 'Australia/Perth': 'AU', 'Australia/Adelaide': 'AU', 'Pacific/Auckland': 'NZ', 'Africa/Johannesburg': 'ZA', 'Africa/Lagos': 'NG', 'Africa/Nairobi': 'KE',
  'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Montreal': 'CA' };
const MUSLIM = ['AE', 'SA', 'QA', 'KW', 'BH', 'OM', 'EG', 'JO', 'LB', 'PK', 'BD', 'ID', 'MY'];
const INDIAN = ['IN', 'LK', 'NP', 'SG', 'MY', 'AE'];
const CHINESE = ['CN', 'HK', 'TW', 'SG', 'MY'];
const XMAS = ['GB', 'IE', 'US', 'CA', 'FR', 'DE', 'IT', 'ES', 'NL', 'PT', 'CH', 'AU', 'NZ', 'PH', 'ZA', 'NG', 'KE'];
// Festival looks: [from, to, countries, greeting, emoji, ink, accent, soft, band, pattern]. Fixed-date ones repeat
// every year (MM-DD); moon-calendar ones are dated (expected dates; check each year).
const F = [
  ['10-30', '11-10', INDIAN, 'Happy Diwali · Shubh Deepavali · தீபாவளி நல்வாழ்த்துகள்', '🪔', '#2a0f3d', '#f2a900', '#ffd27a', '#e85d04', 'kolam', 2026],
  ['11-18', '11-26', ['OM'], 'Happy National Day · العيد الوطني', '🇴🇲', '#3a1013', '#c9a24a', '#efd0b0', '#db161b', 'star'],
  ['11-27', '12-03', ['AE'], 'Happy Eid Al Etihad · عيد الاتحاد', '🇦🇪', '#0f3d2a', '#c9a24a', '#e9cf8f', '#ef3340', 'star'],
  ['12-14', '12-17', ['BH'], 'Happy National Day · العيد الوطني', '🇧🇭', '#3a1115', '#c9a24a', '#efd0b0', '#ce1126', 'star'],
  ['12-16', '12-19', ['QA'], 'Happy National Day · اليوم الوطني', '🇶🇦', '#3d0f1c', '#c8a15a', '#e8cfa0', '#8a1538', 'star'],
  ['12-12', '12-26', XMAS, 'Merry Christmas', '🎄', '#1f3d2b', '#b3261e', '#f0c7b8', '#b3261e', 'herring'],
  ['12-30', '01-02', '*', 'Happy New Year', '✨', null, null, null, null, null],
  ['01-13', '01-17', ['IN', 'LK'], 'Happy Pongal · பொங்கல் வாழ்த்துகள்', '🌾', '#5a3a0a', '#e0a21a', '#f6d58a', '#2f7a2f', 'kolam', 2027],
  ['02-21', '02-23', ['SA'], 'Happy Founding Day · يوم التأسيس', '🇸🇦', '#0b3d2a', '#c9a24a', '#e6cf8f', '#006c35', 'star'],
  ['02-24', '02-26', ['KW'], 'Happy National Day · العيد الوطني', '🇰🇼', '#123a2c', '#c9a24a', '#e6d29b', '#007a3d', 'star'],
  ['02-02', '02-14', CHINESE, '新年快乐 · Happy Lunar New Year', '🧧', '#7a0d0d', '#f2c14e', '#ffe08a', '#d62828', 'lattice', 2027],
  ['02-08', '03-08', MUSLIM, 'Ramadan Kareem · رمضان كريم', '🌙', '#0f1f3d', '#d4af37', '#f0dc94', '#1f3a6b', 'star', 2027],
  ['03-09', '03-13', [...MUSLIM, 'IN'], 'Eid Mubarak · عيد مبارك', '🌙', '#0f2f3d', '#d4af37', '#f0dc94', '#1f6b5a', 'star', 2027],
  ['03-20', '03-23', ['IN', 'NP'], 'Happy Holi · होली की शुभकामनाएं', '🎨', '#3d1066', '#ff4fa3', '#ffc2e2', '#00a6ed', 'dots', 2027],
  ['05-15', '05-19', [...MUSLIM, 'IN'], 'Eid Al Adha Mubarak · عيد أضحى مبارك', '🌙', '#0f2f3d', '#d4af37', '#f0dc94', '#1f6b5a', 'star', 2027],
  ['08-12', '08-14', ['PK'], 'Happy Independence Day · یوم آزادی مبارک', '🇵🇰', '#0d3b26', '#ffffff', '#d6f0e0', '#01411c', 'star'],
  ['08-13', '08-15', ['IN'], 'Happy Independence Day · स्वतंत्रता दिवस', '🇮🇳', '#1c2a5a', '#ff9933', '#ffd9a8', '#138808', 'kolam'],
  ['09-08', '09-13', ['IN'], 'Happy Onam · ഓണാശംസകൾ', '🌼', '#2e4a1b', '#f2b705', '#ffe08a', '#e85d04', 'kolam', 2027],
  ['09-13', '09-16', CHINESE, '中秋快乐 · Happy Mid-Autumn Festival', '🥮', '#2a1d3d', '#f2c14e', '#ffe08a', '#b3261e', 'lattice', 2027],
  ['09-21', '09-24', ['SA'], 'Happy National Day · اليوم الوطني', '🇸🇦', '#0b3d2a', '#c9a24a', '#e6cf8f', '#006c35', 'star'],
  ['10-22', '11-01', INDIAN, 'Happy Diwali · Shubh Deepavali · தீபாவளி நல்வாழ்த்துகள்', '🪔', '#2a0f3d', '#f2a900', '#ffd27a', '#e85d04', 'kolam', 2027],
];
const enc = (s) => `url("data:image/svg+xml,${encodeURIComponent(s)}")`;
const PAT = {
  star: (c) => enc(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><g fill="none" stroke="${c}" stroke-width="1.2" opacity=".22"><path d="M32 6l7 12 13 1-9 10 3 13-14-6-14 6 3-13-9-10 13-1z"/><rect x="20" y="20" width="24" height="24" transform="rotate(45 32 32)"/><rect x="20" y="20" width="24" height="24"/></g></svg>`),
  kolam: (c) => enc(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><g fill="none" stroke="${c}" stroke-width="1.3" opacity=".24"><circle cx="12" cy="12" r="1.6" fill="${c}"/><circle cx="36" cy="12" r="1.6" fill="${c}"/><circle cx="12" cy="36" r="1.6" fill="${c}"/><circle cx="36" cy="36" r="1.6" fill="${c}"/><circle cx="24" cy="24" r="1.6" fill="${c}"/><path d="M12 4c8 0 8 16 0 16S4 4 12 4zM36 28c8 0 8 16 0 16s-8-16 0-16zM4 36c0-8 16-8 16 0S4 44 4 36zM28 12c0-8 16-8 16 0s-16 8-16 0z"/></g></svg>`),
  lattice: (c) => enc(`<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44"><g fill="none" stroke="${c}" stroke-width="1.4" opacity=".22"><path d="M0 11h11V0M33 0v11h11M44 33H33v11M11 44V33H0M11 11h22v22H11zM22 11v8M22 25v8M11 22h8M25 22h8"/></g></svg>`),
  wave: (c) => enc(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24" viewBox="0 0 48 24"><g fill="none" stroke="${c}" stroke-width="1.1" opacity=".24"><path d="M0 24a24 24 0 0 1 48 0M8 24a16 16 0 0 1 32 0M16 24a8 8 0 0 1 16 0M-24 12a24 24 0 0 1 48 0M24 12a24 24 0 0 1 48 0"/></g></svg>`),
  herring: (c) => enc(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke="${c}" stroke-width="1" opacity=".16"><path d="M0 12l6-6 6 6 6-6 6 6M0 24l6-6 6 6 6-6 6 6"/></g></svg>`),
  weave: (c) => enc(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><g fill="none" stroke="${c}" stroke-width="1.2" opacity=".18"><path d="M0 8h16v16H0zM16 0v8h16M16 24v8M32 24H16"/></g></svg>`),
  dots: (c) => enc(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><g fill="${c}" opacity=".26"><circle cx="20" cy="20" r="2"/>${Array.from({ length: 10 }, (_, i) => { const a = i * Math.PI / 5; return `<circle cx="${(20 + 8 * Math.cos(a)).toFixed(1)}" cy="${(20 + 8 * Math.sin(a)).toFixed(1)}" r="1.2"/>`; }).join('')}<circle cx="2" cy="2" r="1"/><circle cx="38" cy="38" r="1"/></g></svg>`),
};
const flag = (cc) => String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0)));
const lsG = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsS = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } };
// The website language decides the look (Tamil → Tamil Nadu colours, Arabic → Gulf, Chinese → Chinese…). English
// has no country of its own, so it follows the visitor's time zone (a visitor in Dubai reading English sees the UAE look).
const LANG = { ar: 'AE', ur: 'PK', fa: 'AE', ta: 'IN', ml: 'IN', hi: 'IN', te: 'IN', kn: 'IN', mr: 'IN', gu: 'IN', pa: 'IN', bn: 'BD', or: 'IN', as: 'IN', si: 'LK', ne: 'NP',
  zh: 'CN', 'zh-TW': 'TW', ja: 'JP', ko: 'KR', tl: 'PH', fil: 'PH', ms: 'MY', id: 'ID', fr: 'FR', de: 'DE', it: 'IT', es: 'ES', 'es-MX': 'US', nl: 'NL', pt: 'PT', ru: 'RU', sw: 'KE', af: 'ZA', ga: 'IE' };
function byLang() {
  const l = document.documentElement.lang || 'en';
  return LANG[l] || LANG[l.split('-')[0]] || '';
}
function detect() {
  const fromLang = byLang();
  if (fromLang) return fromLang;
  let tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { tz = ''; }
  if (TZ[tz]) return TZ[tz];
  if (/^America\//.test(tz)) return 'US';
  const reg = (navigator.language || '').split('-')[1]?.toUpperCase();
  return reg && T[reg] ? reg : '';
}
function festivalFor(cc, now = new Date()) {
  const md = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`, y = now.getFullYear();
  const inWin = (a, b) => (a <= b ? md >= a && md <= b : md >= a || md <= b);
  // A specific festival beats New Year; dated (moon calendar) festivals only in their year.
  return F.filter((f) => (f[10] == null || f[10] === y) && (f[2] === '*' || f[2].includes(cc)) && inWin(f[0], f[1])).sort((a, b) => (a[2] === '*') - (b[2] === '*'))[0] || null;
}
let cfg = { on: true, fest: true };
try { cfg = { ...cfg, ...JSON.parse(lsG('kalai-ct-cfg') || '{}') }; } catch { /* default */ }
const style = document.createElement('style'); style.id = 'ctStyle'; document.head.appendChild(style);
const fontsLoaded = new Set();
function loadFont(f) {
  if (!f || fontsLoaded.has(f)) return; fontsLoaded.add(f);
  const l = document.createElement('link'); l.rel = 'stylesheet';
  l.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;600&display=swap`;
  document.head.appendChild(l);
}
const dark = (hex) => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 < 150; };
let current = '';
function apply() {
  const el = document.documentElement;
  const pick = lsG('kalai-ct');
  const cc = !cfg.on || pick === 'none' ? '' : (pick && T[pick] ? pick : detect());
  current = cc;
  const greet = document.getElementById('ctGreet');
  if (!cc) { el.removeAttribute('data-ct'); style.textContent = ''; if (greet) greet.remove(); drawBtn(); return; }
  const [name, ink0, acc0, soft0, band0, pat0, font, hello] = T[cc];
  const fe = cfg.fest ? festivalFor(cc) : null;
  const ink = fe?.[5] || ink0, acc = fe?.[6] || acc0, soft = fe?.[7] || soft0, band = fe?.[8] || band0, pat = fe?.[9] || pat0;
  loadFont(font);
  el.setAttribute('data-ct', cc);
  const btnFg = dark(acc) ? '#fff' : '#1a1a1a';
  style.textContent = `html[data-ct]{--ink:${ink}!important;--gold:${acc}!important;--kumkum:${acc}!important;--on-ink:#fff}
html[data-ct] header.top{border-top-color:${band}!important;background-color:${ink};background-image:${PAT[pat](soft)}}
html[data-ct] .hero{background-color:${ink};background-image:${PAT[pat](soft)}}
html[data-ct] .hero h1,html[data-ct] .brand b{font-family:'${font}',var(--display),serif}
html[data-ct] .hero h1 em,html[data-ct] .brand span,html[data-ct] nav.links a:hover{color:${soft}!important}
html[data-ct] .btn.gold{background:${acc}!important;color:${btnFg}!important;border-color:${acc}!important}
html[data-ct] .chip-f[aria-pressed="true"]{background:${ink}!important;border-color:${ink}!important}
.ct-greet{margin:0 0 10px;font-size:15px;letter-spacing:.04em;color:${soft};font-weight:600}
.ct-greet small{font-weight:400;opacity:.85;margin-left:6px}
.ct-pick{position:relative}.ct-btn{background:transparent;border:1px solid rgba(255,255,255,.45);border-radius:999px;padding:5px 10px;font-size:16px;line-height:1;color:var(--on-ink);cursor:pointer}
.ct-menu{position:absolute;right:0;top:calc(100% + 6px);background:var(--surface);color:var(--fg);border:1px solid var(--line);border-radius:8px;box-shadow:0 12px 30px rgba(0,0,0,.25);max-height:60vh;overflow:auto;z-index:30;min-width:230px;padding:4px}
.ct-menu button{display:flex;gap:8px;width:100%;text-align:left;background:none;border:0;padding:7px 10px;font-size:14px;color:inherit;cursor:pointer;border-radius:6px}.ct-menu button:hover,.ct-menu button[aria-current="true"]{background:var(--sunk)}`;
  const heroBox = document.querySelector('.hero .wrap > div');
  if (heroBox) {
    const g = greet || Object.assign(document.createElement('p'), { id: 'ctGreet', className: 'ct-greet' });
    g.setAttribute('data-notranslate', ''); g.setAttribute('translate', 'no');
    g.innerHTML = fe ? `${fe[4]} ${fe[3]}` : `${flag(cc)} ${hello}<small>from Kalai Art House, Dubai</small>`;
    if (!greet) heroBox.prepend(g);
  }
  drawBtn(name);
}
// The flag button in the header: Automatic, any country, or the classic Kalai look.
function drawBtn() {
  const anchor = document.querySelector('header.top .theme-btn');
  let wrap = document.getElementById('ctPick');
  if (!cfg.on) { wrap?.remove(); return; }
  if (!anchor) return;
  if (!wrap) {
    wrap = Object.assign(document.createElement('div'), { id: 'ctPick', className: 'ct-pick' });
    wrap.setAttribute('data-notranslate', ''); wrap.setAttribute('translate', 'no');
    anchor.before(wrap);
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) wrap.querySelector('.ct-menu')?.setAttribute('hidden', ''); });
  }
  const pick = lsG('kalai-ct') || '';
  wrap.innerHTML = `<button type="button" class="ct-btn" aria-haspopup="true" title="Country look: ${current ? T[current][0] : 'Kalai classic'}">${current ? flag(current) : '🎨'}</button>
    <div class="ct-menu" hidden><button type="button" data-ct="" aria-current="${!pick}">🌐 Follow my language${detect() ? ` (${T[detect()][0]})` : ''}</button><button type="button" data-ct="none" aria-current="${pick === 'none'}">🎨 Kalai classic look</button>
    ${Object.entries(T).sort((a, b) => a[1][0].localeCompare(b[1][0])).map(([k, v]) => `<button type="button" data-ct="${k}" aria-current="${pick === k}">${flag(k)} ${v[0]}</button>`).join('')}</div>`;
  const menu = wrap.querySelector('.ct-menu');
  wrap.querySelector('.ct-btn').onclick = () => { menu.hidden = !menu.hidden; };
  menu.querySelectorAll('[data-ct]').forEach((b) => { b.onclick = () => { lsS('kalai-ct', b.dataset.ct || null); menu.hidden = true; apply(); }; });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply); else apply();
// Language changed (the language picker sets <html lang>): change the look with it.
new MutationObserver(() => { if (!lsG('kalai-ct') || lsG('kalai-ct') === '') apply(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
// Settings → Country themes (on / festivals): confirm with the saved setting.
generateClient().models.SiteSetting.get({ id: 'site' }, { authMode: 'apiKey' }).then((r) => {
  let c = {}; try { c = JSON.parse(r?.data?.countryThemes || '{}') || {}; } catch { c = {}; }
  const next = { on: c.on !== false, fest: c.fest !== false };
  if (next.on !== cfg.on || next.fest !== cfg.fest) { cfg = next; lsS('kalai-ct-cfg', JSON.stringify(cfg)); apply(); }
}).catch(() => {});
window.kalaiCountryThemes = { list: T, festivals: F, apply };
