// The website theme chosen in Order Management → Settings (1. Original / 2. Monda) also colours Order Management,
// the artist desk and the artist & seller portal. Same green as the website; layouts stay as they are.
import { generateClient } from 'aws-amplify/data';

const CSS = `
html[data-skin="green"]{--ink:#1d4a2e;--gold:#6b8e23;--on-ink:#ffffff}
/* Light backgrounds only in light mode: a phone in dark mode keeps dark backgrounds, so the light text stays readable. */
html[data-skin="green"][data-theme="light"]{--bg:#f7f8f4;--surface:#ffffff;--sunk:#eef1e8;--line:#dfe5d8;--gold-soft:#eef3e1}
@media (prefers-color-scheme:light){html[data-skin="green"]:not([data-theme="dark"]){--bg:#f7f8f4;--surface:#ffffff;--sunk:#eef1e8;--line:#dfe5d8;--gold-soft:#eef3e1}}
@media (prefers-color-scheme:dark){html[data-skin="green"]:not([data-theme="light"]){--ink:#0f2418;--gold:#9cc24a;--gold-soft:#24301a}}
html[data-skin="green"][data-theme="dark"]{--ink:#0f2418;--gold:#9cc24a;--gold-soft:#24301a}
html[data-skin="green"] header.top{border-top:4px solid #5f8a1e}
html[data-skin="green"][data-hue="red"]{--ink:#7a1f24;--gold:#c0392b;--kumkum:#b02a2a;--on-ink:#ffffff;--ok:#c0392b}
html[data-skin="green"][data-hue="red"][data-theme="light"]{--bg:#fdf5f4;--surface:#ffffff;--sunk:#fbf3f2;--line:#f0dcda;--gold-soft:#fbe6e3}
@media (prefers-color-scheme:light){html[data-skin="green"][data-hue="red"]:not([data-theme="dark"]){--bg:#fdf5f4;--surface:#ffffff;--sunk:#fbf3f2;--line:#f0dcda;--gold-soft:#fbe6e3}}
html[data-skin="green"][data-hue="red"][data-theme="dark"]{--ink:#2a0f10;--gold:#f08a80;--kumkum:#f08a80;--gold-soft:#3a1c1b;--ok:#f08a80}
@media (prefers-color-scheme:dark){html[data-skin="green"][data-hue="red"]:not([data-theme="light"]){--ink:#2a0f10;--gold:#f08a80;--kumkum:#f08a80;--gold-soft:#3a1c1b;--ok:#f08a80}}
html[data-skin="green"][data-hue="red"] header.top{border-top-color:#d9534f}
html[data-skin="green"][data-hue="pink"]{--ink:#7a1f52;--gold:#d6336c;--kumkum:#c2255c;--on-ink:#ffffff;--ok:#d6336c}
html[data-skin="green"][data-hue="pink"][data-theme="light"]{--bg:#fef5f9;--surface:#ffffff;--sunk:#fdf3f7;--line:#f3dbe6;--gold-soft:#fce4ee}
@media (prefers-color-scheme:light){html[data-skin="green"][data-hue="pink"]:not([data-theme="dark"]){--bg:#fef5f9;--surface:#ffffff;--sunk:#fdf3f7;--line:#f3dbe6;--gold-soft:#fce4ee}}
html[data-skin="green"][data-hue="pink"][data-theme="dark"]{--ink:#2a0f1f;--gold:#f48fb8;--kumkum:#f48fb8;--gold-soft:#3a1b2a;--ok:#f48fb8}
@media (prefers-color-scheme:dark){html[data-skin="green"][data-hue="pink"]:not([data-theme="light"]){--ink:#2a0f1f;--gold:#f48fb8;--kumkum:#f48fb8;--gold-soft:#3a1b2a;--ok:#f48fb8}}
html[data-skin="green"][data-hue="pink"] header.top{border-top-color:#e64980}
html[data-skin="green"][data-hue="blue"]{--ink:#1c3d6e;--gold:#2f6fd1;--kumkum:#1f5fbf;--on-ink:#ffffff;--ok:#2f6fd1}
html[data-skin="green"][data-hue="blue"][data-theme="light"]{--bg:#f4f8fe;--surface:#ffffff;--sunk:#f2f6fc;--line:#dbe4f0;--gold-soft:#e3edfb}
@media (prefers-color-scheme:light){html[data-skin="green"][data-hue="blue"]:not([data-theme="dark"]){--bg:#f4f8fe;--surface:#ffffff;--sunk:#f2f6fc;--line:#dbe4f0;--gold-soft:#e3edfb}}
html[data-skin="green"][data-hue="blue"][data-theme="dark"]{--ink:#0d1a2e;--gold:#7fb0ff;--kumkum:#7fb0ff;--gold-soft:#1b2a40;--ok:#7fb0ff}
@media (prefers-color-scheme:dark){html[data-skin="green"][data-hue="blue"]:not([data-theme="light"]){--ink:#0d1a2e;--gold:#7fb0ff;--kumkum:#7fb0ff;--gold-soft:#1b2a40;--ok:#7fb0ff}}
html[data-skin="green"][data-hue="blue"] header.top{border-top-color:#3b82f6}
html[data-skin="green"][data-hue="orange"]{--ink:#7a3a12;--gold:#e8590c;--kumkum:#d9480f;--on-ink:#ffffff;--ok:#e8590c}
html[data-skin="green"][data-hue="orange"][data-theme="light"]{--bg:#fef7f1;--surface:#ffffff;--sunk:#fdf6f0;--line:#f2e1d2;--gold-soft:#fde9d9}
@media (prefers-color-scheme:light){html[data-skin="green"][data-hue="orange"]:not([data-theme="dark"]){--bg:#fef7f1;--surface:#ffffff;--sunk:#fdf6f0;--line:#f2e1d2;--gold-soft:#fde9d9}}
html[data-skin="green"][data-hue="orange"][data-theme="dark"]{--ink:#2b1508;--gold:#ffa25c;--kumkum:#ffa25c;--gold-soft:#3b2414;--ok:#ffa25c}
@media (prefers-color-scheme:dark){html[data-skin="green"][data-hue="orange"]:not([data-theme="light"]){--ink:#2b1508;--gold:#ffa25c;--kumkum:#ffa25c;--gold-soft:#3b2414;--ok:#ffa25c}}
html[data-skin="green"][data-hue="orange"] header.top{border-top-color:#f08c2c}
html[data-skin="green"][data-hue="yellow"]{--ink:#5c4700;--gold:#9a7400;--kumkum:#8a6800;--on-ink:#ffffff;--ok:#9a7400}
html[data-skin="green"][data-hue="yellow"][data-theme="light"]{--bg:#fffbea;--surface:#ffffff;--sunk:#fdfaef;--line:#efe6c8;--gold-soft:#fbf1cf}
@media (prefers-color-scheme:light){html[data-skin="green"][data-hue="yellow"]:not([data-theme="dark"]){--bg:#fffbea;--surface:#ffffff;--sunk:#fdfaef;--line:#efe6c8;--gold-soft:#fbf1cf}}
html[data-skin="green"][data-hue="yellow"][data-theme="dark"]{--ink:#2a2205;--gold:#f2c94c;--kumkum:#f2c94c;--gold-soft:#3a3112;--ok:#f2c94c}
@media (prefers-color-scheme:dark){html[data-skin="green"][data-hue="yellow"]:not([data-theme="light"]){--ink:#2a2205;--gold:#f2c94c;--kumkum:#f2c94c;--gold-soft:#3a3112;--ok:#f2c94c}}
html[data-skin="green"][data-hue="yellow"] header.top{border-top-color:#c9a000}`;

const HUES = ['red', 'pink', 'blue', 'orange', 'yellow'];
const lookOf = (v) => (v === 'green' || HUES.includes(v) ? v : 'classic');
function apply(look) {
  const el = document.documentElement;
  if (look === 'green' || HUES.includes(look)) el.setAttribute('data-skin', 'green'); else el.removeAttribute('data-skin');
  if (HUES.includes(look)) el.setAttribute('data-hue', look); else el.removeAttribute('data-hue');
}
const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
let preview = null;
try { preview = localStorage.getItem('kalaiLookPreview'); apply(preview || localStorage.getItem('kalaiLook')); } catch { /* storage blocked */ }
// Confirm with the saved setting (it may have changed since this browser last saw the website).
if (!preview) {
  generateClient().models.SiteSetting.get({ id: 'site' }, { authMode: 'apiKey' })
    .then((r) => { const look = lookOf(r?.data?.siteLook); try { localStorage.setItem('kalaiLook', look); } catch { /* ignore */ } apply(look); })
    .catch(() => {});
}
/** Called by Settings after saving, so the change shows at once. */
window.kalaiApplyLook = (look) => { try { localStorage.setItem('kalaiLook', look); } catch { /* ignore */ } apply(look); };
