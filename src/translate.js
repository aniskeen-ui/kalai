// Website in other languages: the visitor picks a language in the header and every text on the page (including
// what appears later: product pages, forms, My enquiries) is translated by Amazon Translate through the function,
// which keeps each translation (so a sentence is translated once for all visitors). Prices, codes and the
// Thirukkural card (data-notranslate) stay as they are. Orders still reach the studio in English (kalaiEN).
import { generateClient } from 'aws-amplify/data';

const client = generateClient();
import { ALL_LANGS, DEFAULT_LANGS, RTL_LANGS as RTL } from './langs.js';
// The languages offered: chosen in Order Management → Settings (window.kalaiSiteLangs), English always first.
const offered = () => { const pick = String(window.kalaiSiteLangs || '').split(',').map((x) => x.trim()).filter(Boolean); const want = new Set(['en', ...(pick.length ? pick : DEFAULT_LANGS)]); return ALL_LANGS.filter(([k]) => want.has(k)); };
export const LANGS = ALL_LANGS;
const orig = new WeakMap(); // text node / element+attr → English
let lang = 'en';
let chosen = false; // the visitor picked a language themselves (else the studio's default applies)
try { const v = localStorage.getItem('kalaiLang'); if (v) { lang = v; chosen = true; } } catch { /* */ }
if (!LANGS.some(([k]) => k === lang)) lang = 'en';
const memo = new Map(); // `${lang}|${text}` → translation
function loadCache(l) { try { const o = JSON.parse(localStorage.getItem(`kalaiTr_${l}`) || '{}'); Object.entries(o).forEach(([k, v]) => memo.set(`${l}|${k}`, v)); } catch { /* */ } }
function saveCache(l) { try { const o = {}; let n = 0; for (const [k, v] of memo) if (k.startsWith(`${l}|`) && n++ < 4000) o[k.slice(l.length + 1)] = v; localStorage.setItem(`kalaiTr_${l}`, JSON.stringify(o)); } catch { /* storage full */ } }

const SKIP = 'script,style,noscript,code,pre,textarea,svg,[data-notranslate],.notranslate,.mono,.dhs';
// Prices ("≈ OMR 141", "Dhs 800", "$46"), codes and numbers are not text to translate.
const MONEY = /(?:≈\s*)?(?:(?:SAR|QAR|KD|BD|OMR|JD|Dhs|AED|USD|INR|GBP|EUR)\s?[\d.,]+|[$£€₹⃃]\s?[\d.,]+|[\d.,]+\s?(?:Dhs|AED))|\b(?:AT|KA|BP)-[\w-]+/g;
const worth = (t) => (t.replace(MONEY, '').match(/[A-Za-z]/g) || []).length >= 2;
const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

function collect(root) {
  const nodes = [], attrs = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement && !n.parentElement.closest(SKIP) && worth(enOf(n)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
  for (let n = w.nextNode(); n; n = w.nextNode()) nodes.push(n);
  (root.querySelectorAll ? [root, ...root.querySelectorAll('[placeholder],[title],[aria-label],img[alt]')] : []).forEach((el) => {
    if (!el.getAttribute || el.closest(SKIP)) return;
    ATTRS.forEach((a) => { const m = orig.get(el); const v = (m && m[a] !== undefined) ? m[a] : el.getAttribute(a); if (v && worth(v)) attrs.push([el, a]); });
  });
  return { nodes, attrs };
}
const enOf = (n) => { const o = orig.get(n); return o !== undefined ? o : n.nodeValue; };
const attrKey = (el, a) => { let m = orig.get(el); if (!m) orig.set(el, (m = {})); return m; };

let busy = false, again = false;
async function translate(root = document.body) {
  if (busy) { again = true; return; }
  busy = true;
  try {
    const { nodes, attrs } = collect(root);
    if (lang === 'en') { // back to English
      nodes.forEach((n) => { const o = orig.get(n); if (o !== undefined && n.nodeValue !== o) n.nodeValue = o; });
      attrs.forEach(([el, a]) => { const m = orig.get(el); if (m && m[a] !== undefined) el.setAttribute(a, m[a]); });
      return;
    }
    const items = [];
    nodes.forEach((n) => { if (!orig.has(n)) orig.set(n, n.nodeValue); items.push([enOf(n).trim(), (t) => { const o = enOf(n); n.nodeValue = o.replace(o.trim(), t); }]); });
    attrs.forEach(([el, a]) => { const m = attrKey(el, a); if (m[a] === undefined) m[a] = el.getAttribute(a); items.push([m[a].trim(), (t) => el.setAttribute(a, t)]); });
    const need = [...new Set(items.map(([t]) => t).filter((t) => t && !memo.has(`${lang}|${t}`)))];
    // Show what is already known at once, then fill in the rest as each part arrives.
    // Known translations go in; anything not translated yet in THIS language shows English (not the previous language).
    const apply = () => { paused = true; items.forEach(([t, put]) => { const v = memo.get(`${lang}|${t}`); put(v || t); }); setTimeout(() => { paused = false; }, 0); };
    apply();
    const lb = document.getElementById('langBtn'); if (need.length && lb) lb.classList.add('working');
    for (let i = 0; i < need.length; i += 80) {
      const part = need.slice(i, i + 80);
      try {
        const r = await client.mutations.siteTranslate({ lang, texts: JSON.stringify(part) }, { authMode: 'apiKey' });
        const out = JSON.parse(typeof r.data === 'string' ? r.data : '[]');
        part.forEach((t, k) => { if (out[k]) memo.set(`${lang}|${t}`, out[k]); });
        apply();
      } catch (ex) { console.warn('Translation failed', ex); }
    }
    paused = true;
    items.forEach(([t, put]) => { const v = memo.get(`${lang}|${t}`); if (v) put(v); });
    setTimeout(() => { paused = false; }, 0);
    saveCache(lang);
    document.getElementById('langBtn')?.classList.remove('working');
  } finally {
    busy = false;
    if (again) { again = false; setTimeout(() => translate(), 50); }
  }
}

// New content (product pages, forms, lists) is translated as it appears.
let paused = false, timer = null;
new MutationObserver((recs) => { if (paused) return; recs.forEach((r) => { if (r.type === 'characterData') orig.delete(r.target); }); if (lang === 'en') return; clearTimeout(timer); timer = setTimeout(() => translate(), 250); })
  .observe(document.body, { childList: true, subtree: true, characterData: true });

/** The English text of an element (what the studio receives in an order), whatever the visitor's language. */
window.kalaiEN = (el) => {
  if (!el) return '';
  if (lang === 'en') return el.textContent;
  let s = '';
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) s += enOf(n);
  return s;
};

export function setLang(l, byVisitor = false) {
  lang = LANGS.some(([k]) => k === l) ? l : 'en';
  if (byVisitor) { chosen = true; try { localStorage.setItem('kalaiLang', lang); } catch { /* */ } }
  document.documentElement.lang = lang;
  document.documentElement.dir = RTL.includes(lang) ? 'rtl' : 'ltr';
  document.documentElement.dataset.tr = lang === 'en' ? '' : '1'; // header layout for longer words
  loadCache(lang);
  paint();
  translate();
}
function paint() {
  const b = document.getElementById('langBtn');
  if (b) b.textContent = `${(LANGS.find(([k]) => k === lang) || LANGS[0])[1]} ▾`;
}
function picker() {
  const host = document.querySelector('.cur-pick:not(.lang-pick)');
  if (!host) return;
  document.querySelector('.lang-pick')?.remove();
  const list = offered();
  if (list.length <= 1) { if (lang !== 'en') setLang('en'); return; } // only English: no picker
  host.insertAdjacentHTML('beforebegin', `<div class="cur-pick lang-pick" data-notranslate><button type="button" class="cur-sel" id="langBtn" aria-haspopup="true" aria-expanded="false" aria-label="Language"></button><div class="cur-menu" id="langMenu" hidden>${list.map(([k, n]) => `<button type="button" data-lang="${k}">${n}</button>`).join('')}</div></div>`);
  const btn = document.getElementById('langBtn'), menu = document.getElementById('langMenu');
  btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); };
  document.addEventListener('click', () => { const m = document.getElementById('langMenu'), b2 = document.getElementById('langBtn'); if (m) m.hidden = true; b2?.setAttribute('aria-expanded', 'false'); });
  menu.querySelectorAll('[data-lang]').forEach((x) => { x.onclick = () => { menu.hidden = true; setLang(x.dataset.lang, true); }; });
  paint();
}
picker();
if (lang !== 'en') setLang(lang);
/** Settings loaded (or changed): rebuild the picker with the studio's languages; a language no longer offered → English. */
window.kalaiLangPicker = () => {
  const def = String(window.kalaiSiteLangDefault || 'en');
  if (!chosen && offered().some(([k]) => k === def) && def !== lang) setLang(def); // first visit: the studio's default language
  if (!offered().some(([k]) => k === lang)) setLang(offered().some(([k]) => k === def) ? def : 'en');
  picker();
};
