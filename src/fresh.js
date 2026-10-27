// A tab left open across an update keeps running the old code. Every 3 minutes (and when the tab comes back into view)
// compare this page's script with the one the site serves now; when it changed, show a banner with a Reload button.
const mine = [...document.scripts].map((s) => s.src).find((s) => /\/assets\/[^/]+\.js$/.test(s)) || '';
let shown = false;
async function check() {
  if (shown || !mine || document.hidden) return;
  try {
    const html = await (await fetch(location.pathname, { cache: 'no-store' })).text();
    const name = mine.split('/').pop();
    if (html.includes('/assets/') && !html.includes(name)) show();
  } catch { /* offline: try later */ }
}
function show() {
  shown = true;
  const b = document.createElement('div');
  b.id = 'freshBar';
  b.setAttribute('role', 'alert');
  b.style.cssText = 'position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:9999;background:#1f2a22;color:#fff;border-radius:999px;padding:8px 10px 8px 16px;font:600 14px system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.3);display:flex;gap:10px;align-items:center;max-width:calc(100vw - 24px)';
  b.innerHTML = '<span>A new version of this page is ready.</span><button type="button" style="border:0;border-radius:999px;padding:6px 14px;font:inherit;cursor:pointer;background:#9bc53d;color:#1f2a22">Reload</button>';
  b.querySelector('button').onclick = () => location.reload();
  document.body.appendChild(b);
}
setInterval(check, 180000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
export { check as checkForNewVersion };
