/* Kalai as an app: registers the service worker and adds an "Install app" button to the page header when the phone or
   browser can install it (Android / Chrome / Edge: the system prompt; iPhone / iPad Safari: how to add it to the home
   screen). Hidden once installed (opened as an app) or when the visitor closes it. Each page links its own manifest,
   so the shop, Order Management and the portals install as separate apps with their own icon. */
(function () {
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(function () {});
  var standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) { document.documentElement.setAttribute('data-app', '1'); return; }
  var ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var key = 'kalaiAppHide:' + location.pathname, prompt = null, btn = null;
  try { if (localStorage.getItem(key)) return; } catch (e) { /* storage blocked */ }
  function name() { var m = document.querySelector('meta[name="apple-mobile-web-app-title"]'); return (m && m.content) || 'Kalai'; }
  function close(el) { el.remove(); }
  function iosHelp() {
    var d = document.createElement('div');
    d.className = 'kapp-sheet'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Install the app');
    d.innerHTML = '<div class="kapp-card"><img src="' + (document.querySelector('link[rel="apple-touch-icon"]') || {}).href + '" alt="" width="56" height="56">' +
      '<b>Add ' + name() + ' to your home screen</b><ol><li>Tap the <b>Share</b> button <span aria-hidden="true">⬆︎</span> at the bottom (or top) of Safari.</li>' +
      '<li>Choose <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b>. The app opens full screen from its icon.</li></ol>' +
      '<div class="kapp-row"><button type="button" data-k="ok">OK</button><button type="button" data-k="never" class="kapp-ghost">Don\'t show again</button></div></div>';
    d.addEventListener('click', function (e) {
      var k = e.target.getAttribute('data-k');
      if (k === 'never') { try { localStorage.setItem(key, '1'); } catch (x) { /* */ } if (btn) btn.remove(); }
      if (k || e.target === d) close(d);
    });
    document.body.appendChild(d);
  }
  function addButton() {
    if (btn) return;
    var slot = document.querySelector('header.top .theme-btn');
    btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'theme-btn kapp-btn'; btn.id = 'appInstall';
    btn.innerHTML = '<span aria-hidden="true">📱</span><span class="kapp-t"> Install app</span>';
    btn.title = 'Install ' + name() + ' as an app';
    btn.onclick = function () {
      if (prompt) { prompt.prompt(); prompt.userChoice.then(function (c) { if (c.outcome === 'accepted' && btn) btn.remove(); prompt = null; }); }
      else iosHelp();
    };
    if (slot) slot.parentNode.insertBefore(btn, slot); else { btn.classList.add('kapp-float'); document.body.appendChild(btn); }
  }
  var css = document.createElement('style');
  css.textContent = '.kapp-btn{white-space:nowrap}.kapp-float{position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:60}' +
    '@media (max-width:520px){.kapp-btn .kapp-t{display:none}}' +
    '.kapp-sheet{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.45);display:grid;align-items:end;justify-items:center;padding:12px}' +
    '.kapp-card{background:#fff;color:#1f2a22;border-radius:18px;padding:18px;max-width:420px;width:100%;display:grid;gap:8px;justify-items:start;font:15px/1.5 system-ui,sans-serif;margin-bottom:env(safe-area-inset-bottom,0px)}' +
    '.kapp-card img{border-radius:12px}.kapp-card ol{margin:0;padding-left:20px}.kapp-row{display:flex;gap:8px}' +
    '.kapp-card button{font:inherit;padding:8px 16px;border-radius:999px;border:0;background:#a3242f;color:#fff}.kapp-card .kapp-ghost{background:transparent;color:#555;border:1px solid #ccc}';
  document.head.appendChild(css);
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); prompt = e; if (document.body) addButton(); else document.addEventListener('DOMContentLoaded', addButton); });
  window.addEventListener('appinstalled', function () { if (btn) btn.remove(); });
  if (ios) { if (document.body) addButton(); else document.addEventListener('DOMContentLoaded', addButton); }
  window.kalaiInstallApp = function () { if (!btn) addButton(); btn.click(); };
})();
