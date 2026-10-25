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
/** Downloads the label as AWB-<number>.png. */
export async function downloadAwb(l, mode) {
  const cv = await awbCanvas(l, mode);
  const a = document.createElement('a');
  a.href = cv.toDataURL('image/png'); a.download = `AWB-${l.awb}-${mode === 'qr' ? 'QR' : 'barcode'}.png`;
  document.body.appendChild(a); a.click(); a.remove();
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
