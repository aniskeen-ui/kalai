// Airway bill label (4 × 6 in, 800 × 1200 px at 200 dpi: the size thermal label printers use), drawn on a canvas
// with the AWB as a Code 128 barcode or a QR code. Downloaded as PNG or printed. Used by the supplier portal.

/* ---------- Code 128 (set B, with set C for long digit runs) ---------- */
const C128 = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112'];
/** Code values for text: set B, switching to set C for runs of 4+ digits (shorter, easier to scan). */
function c128Codes(text) {
  const s = String(text).replace(/[^\x20-\x7e]/g, '');
  const codes = [];
  let set = '', i = 0;
  const digitsAt = (k) => { let n = 0; while (k + n < s.length && /\d/.test(s[k + n])) n++; return n; };
  while (i < s.length) {
    const run = digitsAt(i);
    if (run >= 4) {
      let take = run - (run % 2);
      if (set !== 'C') { codes.push(set ? 99 : 105); set = 'C'; }
      for (let k = 0; k < take; k += 2) codes.push(Number(s.substr(i + k, 2)));
      i += take;
    } else {
      if (set !== 'B') { codes.push(set ? 100 : 104); set = 'B'; }
      codes.push(s.charCodeAt(i) - 32); i++;
    }
  }
  const check = codes.reduce((sum, c, k) => sum + c * (k || 1), 0) % 103;
  return [...codes, check, 106];
}
/** Draws the barcode in the box (x, y, w, h), with the 10-module quiet zones inside the box. */
function drawBarcode(g, text, x, y, w, h) {
  const pattern = c128Codes(text).map((c) => C128[c]).join('');
  const modules = [...pattern].reduce((a, d) => a + Number(d), 0) + 20;
  const m = Math.max(1, Math.floor(w / modules));
  let cx = x + Math.floor((w - m * (modules - 20)) / 2);
  g.fillStyle = '#000';
  [...pattern].forEach((d, k) => { const wd = Number(d) * m; if (k % 2 === 0) g.fillRect(cx, y, wd, h); cx += wd; });
}

/* ---------- QR (qrcode-generator from cdnjs, as for the voucher cards) ---------- */
let qrLib = null;
const loadQr = () => (qrLib ||= new Promise((ok, no) => { if (window.qrcode) { ok(window.qrcode); return; } const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js'; s.onload = () => ok(window.qrcode); s.onerror = () => { qrLib = null; no(new Error('The QR code library did not load: check the connection, or use the barcode.')); }; document.head.appendChild(s); }));
async function drawQr(g, text, x, y, size) {
  const q = (await loadQr())(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), cell = Math.floor(size / (n + 8)), off = Math.floor((size - cell * n) / 2);
  g.fillStyle = '#fff'; g.fillRect(x, y, size, size); g.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) g.fillRect(x + off + c * cell, y + off + r * cell, cell, cell);
}

/* ---------- the label ---------- */
function wrap(g, text, x, y, maxW, lh, maxLines = 4) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  let line = '', n = 0;
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (g.measureText(t).width > maxW && line) { g.fillText(line, x, y); y += lh; line = w; if (++n >= maxLines - 1) break; } else line = t;
  }
  if (line) { g.fillText(line, x, y); y += lh; }
  return y;
}
/** Canvas of the label. mode: 'bar' or 'qr'. l = the label data from the server (jobLabel). */
export async function awbCanvas(l, mode = 'bar') {
  const W = 800, H = 1200, P = 28;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#000'; g.lineWidth = 4; g.strokeRect(2, 2, W - 4, H - 4);
  g.fillStyle = '#000'; g.textBaseline = 'alphabetic';
  const line = (y) => { g.fillRect(0, y, W, 3); };
  const font = (px, w = 400) => { g.font = `${w} ${px}px Arial, Helvetica, sans-serif`; };
  // Header: courier and service
  const cn = String(l.courier || 'Courier').toUpperCase().slice(0, 40);
  let fs = 40; do { font(fs, 700); } while (g.measureText(cn).width > W - P * 2 - 250 && --fs > 18);
  g.fillText(cn, P, 62);
  font(24); g.fillText(l.service || 'Prepaid', P, 98);
  font(24, 700); g.textAlign = 'right'; g.fillText('KALAI ART HOUSE', W - P, 62); font(22); g.fillText(l.date || '', W - P, 98); g.textAlign = 'left';
  line(120);
  // Code
  let y = 140;
  if (mode === 'qr') {
    await drawQr(g, l.awb, P, y, 300);
    font(22); g.fillText('AIRWAY BILL', P + 330, y + 50);
    font(46, 700); wrap(g, l.awb, P + 330, y + 110, W - P * 2 - 330, 54, 2);
    font(24); g.fillText(`Order ${l.ref}`, P + 330, y + 230); g.fillText(`Pieces ${l.pieces || '1 of 1'}`, P + 330, y + 268);
    y += 320;
  } else {
    drawBarcode(g, l.awb, P, y, W - P * 2, 190);
    font(44, 700); g.textAlign = 'center'; g.fillText(l.awb, W / 2, y + 245); g.textAlign = 'left';
    font(24); g.fillText(`Order ${l.ref}`, P, y + 290); g.textAlign = 'right'; g.fillText(`Pieces ${l.pieces || '1 of 1'}`, W - P, y + 290); g.textAlign = 'left';
    y += 310;
  }
  line(y);
  // Deliver to
  y += 44; font(24, 700); g.fillText('DELIVER TO', P, y);
  y += 46; font(38, 700); y = wrap(g, l.to?.name, P, y, W - P * 2, 44, 2);
  font(30); y = wrap(g, l.to?.address, P, y + 4, W - P * 2, 38, 4);
  font(32, 700); if (l.to?.phone) { g.fillText(`Tel ${l.to.phone}`, P, y + 8); y += 44; }
  y += 10; line(y);
  // From
  y += 38; font(22, 700); g.fillText('FROM (PICKUP)', P, y);
  y += 36; font(28, 700); y = wrap(g, l.from?.name, P, y, W - P * 2, 34, 1);
  font(24); y = wrap(g, l.from?.address, P, y, W - P * 2, 30, 3);
  if (l.from?.phone) { g.fillText(`Tel ${l.from.phone}`, P, y); y += 30; }
  y += 6; line(y);
  // Contents and handling
  y += 38; font(24); g.fillText(`Contents: ${l.contents || ''}`.slice(0, 60), P, y);
  if (l.returnTo) { y += 34; font(20); g.fillText(`If undelivered return to: ${l.returnTo}`.slice(0, 72), P, y); }
  if (l.fragile) {
    const by = H - 110; g.fillRect(0, by, W, 110 - 4);
    g.fillStyle = '#fff'; font(42, 700); g.textAlign = 'center'; g.fillText('FRAGILE · GLASS · THIS WAY UP', W / 2, by + 68); g.textAlign = 'left'; g.fillStyle = '#000';
  }
  return cv;
}
/** The label as a one-page PDF (4 × 6 in), the picture embedded losslessly (greyscale, deflate) so bars stay sharp. */
export async function awbPdf(l, mode) {
  const cv = await awbCanvas(l, mode);
  const W = cv.width, H = cv.height;
  const px = cv.getContext('2d').getImageData(0, 0, W, H).data;
  const grey = new Uint8Array(W * H);
  for (let i = 0; i < grey.length; i++) grey[i] = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000;
  let img, dict;
  if (typeof CompressionStream === 'function') {
    img = new Uint8Array(await new Response(new Blob([grey]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    dict = `/Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.length}`;
  } else {
    img = new Uint8Array(await (await fetch(cv.toDataURL('image/jpeg', 1))).arrayBuffer());
    dict = `/Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length}`;
  }
  const enc = new TextEncoder();
  const content = 'q 288 0 0 432 0 0 cm /Im0 Do Q';
  const parts = [], offs = [];
  let len = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  push('%PDF-1.4\n%\xE2\xE3\n');
  const obj = (n, body, stream) => { offs[n] = len; push(`${n} 0 obj\n${body}\n`); if (stream) { push('stream\n'); push(stream); push('\nendstream\n'); } push('endobj\n'); };
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 288 432] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>');
  obj(4, `<< /Length ${content.length} >>`, enc.encode(content));
  obj(5, `<< ${dict} >>`, img);
  obj(6, `<< /Title (Airway bill ${String(l.awb).replace(/[()\\]/g, '')}) /Producer (Kalai Art House) >>`);
  const xref = len;
  push(`xref\n0 7\n0000000000 65535 f \n${[1, 2, 3, 4, 5, 6].map((n) => `${String(offs[n]).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
/** Downloads the label as AWB-<number>.pdf. */
export async function downloadAwb(l, mode) {
  const blob = await awbPdf(l, mode);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `AWB-${l.awb}-${mode === 'qr' ? 'QR' : 'barcode'}.pdf`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
/** The label as a picture to show on the screen (scan it straight from the phone / screen). */
export async function awbImage(l, mode) {
  const cv = await awbCanvas(l, mode);
  return cv.toDataURL('image/png');
}
/** Prints the label at 4 × 6 in (through a hidden frame, so no pop-up is needed). */
export async function printAwb(l, mode) {
  const cv = await awbCanvas(l, mode);
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(f);
  const d = f.contentDocument;
  d.open(); d.write(`<!doctype html><html><head><title>AWB ${l.awb}</title><style>@page{size:4in 6in;margin:0}html,body{margin:0}img{width:4in;height:6in;display:block}</style></head><body><img src="${cv.toDataURL('image/png')}"></body></html>`); d.close();
  const img = d.querySelector('img');
  const go = () => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 60000); };
  if (img.complete) go(); else img.onload = go;
}

/* ---------- buttons shared by the supplier portal, artist desk and artist portal ---------- */
const AWB_CSS = '.awb-acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0 2px}.awb-show{margin-top:8px;display:grid;gap:6px;justify-items:start}.awb-show img{width:100%;max-width:400px;border:1px solid #ccc;border-radius:6px;background:#fff}';
if (typeof document !== 'undefined' && !document.getElementById('awb-css')) { const st = document.createElement('style'); st.id = 'awb-css'; st.textContent = AWB_CSS; document.head.appendChild(st); }
/** The label buttons: Display (shows it on the screen), PDF download and Print, each as barcode or QR code. */
export function awbButtons() {
  const fmt = `<select data-awbfmt aria-label="Label code" style="width:auto"><option value="bar">Barcode</option><option value="qr">QR code</option></select>`;
  return `<div class="awb-acts">${fmt}<button type="button" class="btn small" data-awbdo="show">👁 Display</button><button type="button" class="btn small ghost" data-awbdo="pdf">📄 Download PDF</button><button type="button" class="btn small ghost" data-awbdo="print">🖨 Print</button></div><div class="awb-show" data-awbshow hidden></div>`;
}
/** Wires the buttons in box. getLabel() fetches the label data; say(text, ok) shows a message. */
export function wireAwb(box, getLabel, say) {
  if (!box || box.dataset.awbWired) return;
  box.dataset.awbWired = '1';
  let cache = null;
  box.querySelectorAll('[data-awbdo]').forEach((b) => {
    b.addEventListener('click', async () => {
      const mode = box.querySelector('[data-awbfmt]')?.value || 'bar';
      const show = box.querySelector('[data-awbshow]');
      if (b.dataset.awbdo === 'show' && !show.hidden && show.dataset.mode === mode) { show.hidden = true; b.textContent = '👁 Display'; return; }
      say('Making the airway bill…', true);
      try {
        cache = cache || await getLabel();
        if (b.dataset.awbdo === 'show') {
          show.innerHTML = `<img alt="Airway bill ${cache.awb}" src="${await awbImage(cache, mode)}"><span class="muted" style="font-size:12px">The courier can scan the ${mode === 'qr' ? 'QR code' : 'barcode'} straight from this screen.</span>`;
          show.hidden = false; show.dataset.mode = mode; b.textContent = '✕ Hide';
        } else if (b.dataset.awbdo === 'pdf') await downloadAwb(cache, mode);
        else await printAwb(cache, mode);
        say(`Airway bill ${cache.awb} ready.`, true);
      } catch (ex) { say(ex.message, false); }
    });
  });
  box.querySelector('[data-awbfmt]')?.addEventListener('change', () => { const show = box.querySelector('[data-awbshow]'); if (!show.hidden) box.querySelector('[data-awbdo="show"]').click(); });
}
