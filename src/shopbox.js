// "Send it to": the frame shop a finished work goes to (name, contact, address), on Siva's desk and in the artist portal.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** An address built from address + city + country can repeat itself (Guddis: "…Bengaluru 560042, India, No. 108, …, I,
 *  India"): keep each part once and drop stray stubs ("I") that start another part. */
export function tidyAddr(s) {
  const parts = String(s || '').split(/\s*,\s*/).filter(Boolean), seen = new Set(), out = [];
  for (const p of parts) { const k = p.toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push(p); }
  return out.filter((p) => !(p.length <= 2 && out.some((q) => q !== p && q.toLowerCase().startsWith(p.toLowerCase())))).join(', ');
}
/** The frame shop the finished work goes to: name, contact and address (from the framing job, or our only frame shop). */
export function shopBox(f) {
  if (!f) return `<div class="shopbox muted">Kalai Art House will confirm the frame shop's address: please ask on WhatsApp before sending.</div>`;
  return `<div class="shopbox"><div class="muted" style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em">Send it to</div>
    <div><b>${esc(f.name)}</b>${f.contact && f.contact.trim().toLowerCase() !== String(f.name || '').trim().toLowerCase() ? ` · ${esc(f.contact)}` : ''}${f.phone ? ` · <a href="tel:${esc(f.phone.replace(/[^+\d]/g, ''))}">${esc(f.phone)}</a>` : ''}</div>
    ${f.address ? `<div>${esc(tidyAddr(f.address))}</div>` : '<div class="muted">Address not on file yet: ask Kalai Art House.</div>'}${f.assigned === false ? '<div class="muted" style="font-size:12px">Planned frame shop: Kalai Art House is confirming the job with them. If it changes, this box changes too.</div>' : ''}</div>`;
}
