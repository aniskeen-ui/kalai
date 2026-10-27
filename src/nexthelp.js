// "What next?" helper on the order screen: a small card in the corner (like the Thirukkural card on the website)
// that says, for the open order, what has happened, what to do now, who does it, and jumps to the right box.
// Settings → General → "What next? helper": on (opens with every order) | tab (folded until clicked) | off.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let mode = 'on';
try { mode = localStorage.getItem('kalaiHelpMode') || 'on'; } catch { /* */ }
let last = null;

const CSS = `.nh{position:fixed;right:14px;bottom:14px;z-index:40;width:min(340px,calc(100vw - 28px));background:var(--surface,#fff);color:var(--fg);border:1px solid var(--gold);border-left:5px solid var(--gold);border-radius:10px;box-shadow:0 14px 34px rgba(0,0,0,.18);padding:12px 14px 12px;font-size:13px;animation:nhIn .25s ease}
@keyframes nhIn{from{transform:translateY(10px);opacity:0}to{transform:none;opacity:1}}
.nh-h{display:flex;align-items:center;gap:8px;margin:0 0 6px}.nh-h b{font-size:14px}.nh-h small{color:var(--muted);font-size:11px;margin-left:auto;margin-right:18px;font-family:var(--mono,monospace)}
.nh-x{position:absolute;top:6px;right:8px;background:none;border:0;font-size:16px;color:var(--muted);cursor:pointer;line-height:1}
.nh-now{background:var(--sunk);border-radius:6px;padding:6px 8px;margin-bottom:8px;font-size:12.5px}
.nh ol{margin:0;padding:0;list-style:none;display:grid;gap:6px}
.nh li{display:grid;grid-template-columns:20px 1fr;gap:6px;align-items:start}
.nh li i{font-style:normal;display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:var(--gold);color:#fff;font-size:11px;font-weight:700}
.nh li.wait i{background:var(--line);color:var(--muted)}
.nh li .who{display:inline-block;font-size:10.5px;border:1px solid var(--line);border-radius:99px;padding:0 6px;margin-left:4px;color:var(--muted)}
.nh li button{background:none;border:0;padding:0;color:var(--kumkum,#a3242f);text-decoration:underline;cursor:pointer;font:inherit;font-size:12px;margin-left:4px}
.nh-tab{position:fixed;right:14px;bottom:14px;z-index:40;border:1px solid var(--gold);background:var(--surface,#fff);color:var(--fg);border-radius:999px;padding:7px 13px;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.15)}
.nh-flash{outline:3px solid var(--gold);outline-offset:3px;transition:outline-color 1.2s}`;

function ensure() {
  if (document.getElementById('nhCss')) return;
  const st = document.createElement('style'); st.id = 'nhCss'; st.textContent = CSS; document.head.appendChild(st);
  const box = document.createElement('aside'); box.className = 'nh'; box.id = 'nhBox'; box.hidden = true; box.setAttribute('aria-label', 'What next');
  const tab = document.createElement('button'); tab.type = 'button'; tab.className = 'nh-tab'; tab.id = 'nhTab'; tab.hidden = true; tab.textContent = '💡 What next?';
  document.body.append(box, tab);
  tab.onclick = () => { box.hidden = false; tab.hidden = true; };
}
function go(sel) {
  const el = document.querySelector(sel); if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('nh-flash'); setTimeout(() => el.classList.remove('nh-flash'), 1600);
  const f = el.matches('input,select,textarea') ? el : el.querySelector('input:not([type=hidden]):not([readonly]),select,textarea');
  if (f) setTimeout(() => f.focus({ preventScroll: true }), 500);
}

/** The steps for one order. x = { jobs, costing, artistOf, hasArtist, STATUS } from Order Management. */
export function stepsFor(e, x) {
  const s = e.status || 'RECEIVED', j = x.jobs || {}, c = x.costing || {}, art = x.hasArtist(e), name = x.artistOf(e);
  const kind = e.kind, print = ['PHOTO', 'GIFT'].includes(kind);
  const T = []; let now = '';
  const t = (text, who, sel, wait = false) => T.push({ text, who, sel, wait });
  const supplierTodo = () => {
    if (print && !j.printer) t('Give the print job to a print shop.', 'you', '#supplierBox');
    if (kind !== 'MARKET' && kind !== 'LICENCE' && !j.framer) t('Choose the frame shop, its price and finish-by date.', 'you', '#supplierBox');
    if (kind !== 'LICENCE' && !j.delivery && !j.framer?.canDeliver) t('Allocate the delivery partner (courier) to the customer.', 'you', '#supplierBox');
  };
  switch (s) {
    case 'RECEIVED':
      now = 'New order or enquiry: nothing sent to the customer yet.';
      if (art && !e.artistId && !e.artistName) t('Choose the artist doing this work (Costing) and Save: they get an email and see it in their portal.', 'you', '#cArtist');
      if (art && !c.artistPriceInr && !c.artistPriceAed) t(`${name} gives their price in the portal (Orders to make): it fills the Costing by itself and you get an email. Or type it here.`, 'artist', '#costing', true);
      t('Check the costing, then press “Use this price” (or type the price).', 'you', '#costing');
      t('Write a short message and Save: the status moves to Price sent and the customer gets the price and Ziina payment link.', 'you', '#eMsg');
      break;
    case 'PRICE_SENT':
      now = 'Price sent: waiting for the customer to pay.';
      t('Wait for the payment: a Ziina payment marks the order Paid by itself.', 'customer', '#payBox', true);
      t('Paid by bank transfer or cash? Set “Paid by” and the reference, choose Paid, Save.', 'you', '#payBox');
      t('No reply in 2–3 days? Send a reminder with “Send update on WhatsApp”.', 'you', '#eSave');
      break;
    case 'PAID':
      now = 'Paid: invoice in Zoho. Now the work starts.';
      if (art) {
        if (!e.artistId && !e.artistName) t('Choose the artist doing this work (Costing → Artist doing this work).', 'you', '#cArtist');
        if (!c.artistPriceInr && !c.artistPriceAed) t(`Enter ${name}'s price (Costing) so the purchase order can be placed.`, 'you', '#costing');
        if (!e.zohoPOId) t(`Save: the purchase order goes to ${name} in Zoho and their portal.`, 'you', '#eSave');
        t(`${name} starts the work and marks it Started in the portal.`, 'artist', null, true);
      }
      supplierTodo();
      break;
    case 'ARTIST_WORKING':
      now = `${name} is working on it${e.artistStartedAt ? ' (started)' : ''}.`;
      t(`${name} marks it Finished in the portal.`, 'artist', null, true);
      if (!j.inbound) t('Allocate the artist → frame shop courier, so the airway bill is ready when it is finished.', 'you', '[data-inbound]');
      supplierTodo();
      break;
    case 'ARTIST_DONE':
      now = `${name} finished it: not sent yet.`;
      if (!j.inbound) t('Allocate the artist → frame shop courier (from the artist\'s city).', 'you', '[data-inbound]');
      t(`${name} hands it to the courier and presses “Handed to …” (or do it for them in their portal).`, 'artist', null, true);
      supplierTodo();
      break;
    case 'ARTIST_SENT':
      now = `On its way from ${name} to the frame shop.`;
      if (!j.framer) t('Choose the frame shop now: it receives the artwork.', 'you', '#supplierBox');
      t(`${j.framer?.name || 'The frame shop'} accepts the job and frames it.`, 'supplier', null, true);
      supplierTodo();
      break;
    case 'PRINTING': case 'PRINTED':
      now = s === 'PRINTING' ? 'Being printed.' : 'Printed: ready for the frame shop.';
      t(`${j.printer?.name || 'The print shop'} marks it printed; ${j.framer?.name || 'the frame shop'} collects it.`, 'supplier', null, true);
      supplierTodo();
      break;
    case 'FRAMING':
      { const ready = ['READY', 'COLLECTED'].includes(j.framer?.stage);
      now = ready ? `Framed and ready for pickup at ${j.framer?.name || 'the frame shop'}.` : `Being framed${j.framer?.name ? ` by ${j.framer.name}` : ''}.`;
      if (!ready) t('The frame shop presses “Framed, ready for pickup”.', 'supplier', null, true); }
      if (!e.deliveryAddress && !e.deliveryEmirate) t('Add the customer\'s delivery address (Delivery address card), so the courier price and label are right.', 'you', '#addrBox');
      if (!j.delivery && !j.framer?.canDeliver) t('Send the delivery job: the cheapest courier is pre-selected in the Courier box (Frame shop → Customer). The airway bill is made when the frame is ready.', 'you', '#supplierBox');
      else t(`${j.delivery?.name || 'The courier'} picks it up: the order moves to Shipped by itself.`, 'supplier', null, true);
      break;
    case 'SHIPPED':
      now = `On its way to the customer${j.delivery?.awb ? ` (AWB ${j.delivery.awb})` : ''}.`;
      t(`${j.delivery?.name || 'The courier'} delivers and saves the proof of delivery: the order moves to Delivered by itself.`, 'supplier', null, true);
      t('Customer asking? Share the tracking with “Send update on WhatsApp”.', 'you', '#eSave');
      break;
    case 'DELIVERED':
      now = 'Delivered. Close the books.';
      if (art && !e.artistInvoiceNo) t(`Enter ${name}'s invoice number (purchase card) to create their bill.`, 'you', '#purchase');
      if (art && !e.artistPaidRef) t(`Pay ${name} and save the bank reference.`, 'you', '#purchase');
      t('Check the supplier invoices and actual costs, and pay them in Zoho.', 'you', '#actualBox');
      t('Kalai Circle points are added 48 hours after delivery: nothing to do.', 'system', null, true);
      break;
    case 'REPLACEMENT':
      now = 'Replacement in progress.';
      t('Follow the rework / return steps on the order and keep the customer posted.', 'you', '#eMsg');
      break;
    case 'REFUNDED': case 'CANCELLED':
      now = s === 'REFUNDED' ? 'Refunded: the order is closed.' : 'Cancelled: the order is closed.';
      t('Nothing more to do. Check the credit note / refund in Zoho if needed.', 'you', '#zohoBox');
      break;
    default:
      now = x.STATUS?.[s] || s;
  }
  return { now, steps: T };
}

/** Called each time an order is opened in Order Management. */
export function showNextHelp(e, x) {
  last = [e, x];
  ensure();
  const box = document.getElementById('nhBox'), tab = document.getElementById('nhTab');
  if (mode === 'off' || !e) { box.hidden = true; tab.hidden = true; return; }
  const { now, steps } = stepsFor(e, x);
  const WHO = { you: 'you', artist: 'artist', supplier: 'supplier', customer: 'customer', system: 'automatic' };
  box.innerHTML = `<button class="nh-x" type="button" aria-label="Fold">×</button>
    <div class="nh-h"><b>💡 What next?</b><small>${esc(e.ref)}</small></div>
    <div class="nh-now"><b>${esc(x.STATUS?.[e.status || 'RECEIVED'] || e.status)}</b> · ${esc(now)}</div>
    ${steps.length ? `<ol>${steps.map((st, i) => `<li class="${st.wait ? 'wait' : ''}"><i>${st.wait ? '…' : steps.slice(0, i + 1).filter((q) => !q.wait).length}</i><span>${esc(st.text)}<span class="who">${WHO[st.who] || st.who}</span>${st.sel ? `<button type="button" data-go="${esc(st.sel)}">Show me</button>` : ''}</span></li>`).join('')}</ol>` : '<div class="muted">Nothing to do right now.</div>'}`;
  box.querySelector('.nh-x').onclick = () => { box.hidden = true; tab.hidden = false; };
  box.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => go(b.dataset.go); });
  const folded = mode === 'tab';
  box.hidden = folded; tab.hidden = !folded;
}
export function hideNextHelp() { const b = document.getElementById('nhBox'), t = document.getElementById('nhTab'); if (b) b.hidden = true; if (t) t.hidden = true; }
/** Settings: 'on' | 'tab' | 'off'. */
export function setHelpMode(m) {
  mode = ['on', 'tab', 'off'].includes(m) ? m : 'on';
  try { localStorage.setItem('kalaiHelpMode', mode); } catch { /* */ }
  if (last) showNextHelp(...last); else if (mode === 'off') hideNextHelp();
}
window.kalaiHelpMode = setHelpMode;
