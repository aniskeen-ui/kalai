// Which site this is: the live shop (built from the "production" branch) or the test site (every other branch).
// The test site shows a ribbon on every page so nobody mistakes it for the live shop.
let built = '';
try { built = import.meta.env.VITE_KALAI_STAGE; } catch { /* not built with Vite */ }
export const STAGE = built === 'prod' ? 'prod' : 'test';
export const IS_TEST = STAGE !== 'prod';
if (IS_TEST && typeof document !== 'undefined' && !document.getElementById('testRibbon')) {
  const show = () => {
    if (document.getElementById('testRibbon')) return;
    const r = document.createElement('div');
    r.id = 'testRibbon';
    r.setAttribute('role', 'note');
    r.textContent = 'TEST SITE · orders, payments (Ziina test cards) and Zoho documents here are for testing only';
    r.style.cssText = 'position:sticky;top:0;z-index:9999;background:repeating-linear-gradient(135deg,#b45309 0 14px,#d97706 14px 28px);color:#fff;font:700 12px/1.2 system-ui,sans-serif;letter-spacing:.04em;text-align:center;padding:5px 10px;text-shadow:0 1px 1px rgba(0,0,0,.35)';
    document.body.prepend(r);
    if (!/^TEST · /.test(document.title)) document.title = `TEST · ${document.title}`;
  };
  if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
}
