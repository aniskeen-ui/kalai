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
html[data-skin="green"] header.top{border-top:4px solid #5f8a1e}`;

function apply(look) {
  const el = document.documentElement;
  if (look === 'green') el.setAttribute('data-skin', 'green'); else el.removeAttribute('data-skin');
}
const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
let preview = null;
try { preview = localStorage.getItem('kalaiLookPreview'); apply(preview || localStorage.getItem('kalaiLook')); } catch { /* storage blocked */ }
// Confirm with the saved setting (it may have changed since this browser last saw the website).
if (!preview) {
  generateClient().models.SiteSetting.get({ id: 'site' }, { authMode: 'apiKey' })
    .then((r) => { const look = r?.data?.siteLook === 'green' ? 'green' : 'classic'; try { localStorage.setItem('kalaiLook', look); } catch { /* ignore */ } apply(look); })
    .catch(() => {});
}
/** Called by Settings after saving, so the change shows at once. */
window.kalaiApplyLook = (look) => { try { localStorage.setItem('kalaiLook', look); } catch { /* ignore */ } apply(look); };
