// Proof of delivery document (A4): order, courier and airway bill, who received it and when, the signature and the
// photos the delivery partner took. Shown on the screen or downloaded as a PDF from the order screen.
import { getUrl } from 'aws-amplify/storage';
import { pdfFromCanvases } from './awb.js';

const loadImg = (src) => new Promise((ok, no) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = () => no(new Error('A proof-of-delivery picture could not be loaded.')); im.src = src; });
async function picture(key) {
  const { url } = await getUrl({ path: key, options: { expiresIn: 600 } });
  return loadImg(url.toString());
}
const fit = (im, w, h) => { const r = Math.min(w / im.width, h / im.height, 1.5); return [im.width * r, im.height * r]; };

/** The POD page as a canvas (A4 at 150 dpi). d = { ref, title, awb, courier, deliveredAt, pickedAt, to: {name, phone, address}, pod: {name, at, note, signKey, photoKeys} } */
export async function podCanvas(d) {
  const W = 1240, H = 1754, P = 80;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.fillStyle = '#111';
  const font = (px, w = 400) => { g.font = `${w} ${px}px Arial, Helvetica, sans-serif`; };
  const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' (Dubai)' : '');
  font(30, 700); g.fillText('KALAI ART HOUSE', P, P + 10);
  font(22); g.fillStyle = '#555'; g.fillText('art.pranixtechno.com · +971 55 299 6626', P, P + 44); g.fillStyle = '#111';
  font(54, 700); g.textAlign = 'right'; g.fillText('Proof of delivery', W - P, P + 30); g.textAlign = 'left';
  g.fillRect(P, P + 70, W - P * 2, 4);
  let y = P + 140;
  const row = (k, v) => { if (!v) return; font(26, 700); g.fillText(k, P, y); font(26); const words = String(v).split(/\s+/); let line = ''; const x = P + 300, max = W - P - x; for (const w of words) { const t = line ? `${line} ${w}` : w; if (g.measureText(t).width > max && line) { g.fillText(line, x, y); y += 36; line = w; } else line = t; } g.fillText(line, x, y); y += 50; };
  row('Order', d.ref);
  row('Item', d.title);
  row('Courier', d.courier);
  row('Airway bill', d.awb);
  row('Picked up', when(d.pickedAt));
  row('Delivered', when(d.pod?.at || d.deliveredAt));
  row('Deliver to', [d.to?.name, d.to?.address, d.to?.phone].filter(Boolean).join(', '));
  row('Received by', d.pod?.name);
  row('Note', d.pod?.note);
  y += 10; g.fillStyle = '#ccc'; g.fillRect(P, y, W - P * 2, 2); g.fillStyle = '#111'; y += 60;
  if (d.pod?.signKey) {
    font(26, 700); g.fillText('Signature of the receiver', P, y); y += 20;
    try { const im = await picture(d.pod.signKey); const [w, h] = fit(im, 700, 230); g.strokeStyle = '#bbb'; g.lineWidth = 2; g.strokeRect(P, y, 720, 250); g.drawImage(im, P + 10, y + 10 + (230 - h) / 2, w, h); } catch (ex) { font(22); g.fillText(ex.message, P, y + 40); }
    y += 290;
  }
  const photos = d.pod?.photoKeys || [];
  if (photos.length) {
    font(26, 700); g.fillText(`Photo${photos.length > 1 ? 's' : ''} of the delivered parcel`, P, y); y += 20;
    const cw = (W - P * 2 - 30) / 2, ch = Math.min(420, (H - y - 140) / Math.ceil(photos.length / 2) - 30);
    for (let i = 0; i < photos.length; i++) {
      const x = P + (i % 2) * (cw + 30), yy = y + Math.floor(i / 2) * (ch + 30);
      try { const im = await picture(photos[i]); const [w, h] = fit(im, cw, ch); g.drawImage(im, x + (cw - w) / 2, yy + (ch - h) / 2, w, h); g.strokeStyle = '#bbb'; g.strokeRect(x, yy, cw, ch); } catch (ex) { font(20); g.fillText(ex.message, x, yy + 30); }
    }
  }
  font(20); g.fillStyle = '#777'; g.fillText(`Recorded by ${d.courier || 'the delivery partner'} in the Kalai Art House supplier portal. Generated ${when(new Date().toISOString())}.`, P, H - P);
  return cv;
}
/** Downloads POD-<order>.pdf (A4). */
export async function downloadPod(d) {
  const blob = await pdfFromCanvases([await podCanvas(d)], 595, 842, `Proof of delivery ${d.ref}`, true);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `POD-${d.ref}.pdf`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
/** The POD page as a picture for the screen. */
export async function podImage(d) { return (await podCanvas(d)).toDataURL('image/jpeg', 0.9); }
