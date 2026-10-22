// Offers page: active promotions from Order Management → Offers (public, read-only).
import './amplify-config.js';
import { generateClient } from 'aws-amplify/data';
import { getUrl } from 'aws-amplify/storage';

const client = generateClient();
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const AREA = { ALL: 'all orders', ART: 'artworks and commissions', CRAFTS: 'Crafts shop items', GIFT: 'Little Artists gifts' };

export function liveOffers(list, now = new Date().toISOString()) {
  return list.filter((p) => p.active && (!p.startAt || p.startAt <= now) && (!p.endAt || p.endAt >= now))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a.endAt || '9').localeCompare(String(b.endAt || '9')));
}

async function main() {
  try {
    const r = await client.models.Promotion.list({ authMode: 'apiKey', limit: 200 });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    const live = liveOffers(r.data || []);
    if (!live.length) { $('offers').innerHTML = '<p>No offers running right now. Have a look at <a href="/#collection">the collection</a>, or come back soon.</p>'; return; }
    const imgs = await Promise.all(live.map((p) => (p.imageKey ? getUrl({ path: p.imageKey, options: { expiresIn: 3600 } }).then((u) => u.url.toString()).catch(() => '') : '')));
    $('offers').style.cssText = 'display:grid;gap:22px';
    $('offers').innerHTML = live.map((p, i) => {
      const off = p.code && p.discountValue ? (p.discountType === 'AED' ? `AED ${p.discountValue} off` : `${p.discountValue}% off`) : '';
      const area = p.appliesTo === 'CRAFTS' ? '/#market' : p.appliesTo === 'GIFT' ? '/#little' : '/#collection';
      return `<article class="offer ${imgs[i] ? '' : 'noimg'}" id="o-${esc(p.id)}">${imgs[i] ? `<img src="${esc(imgs[i])}" alt="">` : ''}
        <div class="body"><h2>${esc(p.title)}</h2>
          ${p.details ? `<p class="details">${esc(p.details)}</p>` : ''}
          ${p.code ? `<div class="code"><b>${esc(p.code)}</b><button type="button" data-copy="${esc(p.code)}">Copy code</button><span class="small">${esc(off)} on ${esc(AREA[p.appliesTo || 'ALL'])}${p.minOrder ? ` over AED ${p.minOrder}` : ''}</span></div>` : ''}
          ${p.endAt ? `<div class="small">Valid until ${esc(day(p.endAt))}</div>` : ''}
          <div class="ctas"><a class="primary" href="${area}">${p.appliesTo === 'CRAFTS' ? 'Shop crafts' : p.appliesTo === 'GIFT' ? 'Send a Little Artists gift' : 'Browse the collection'}</a>${p.appliesTo === 'ART' || !p.appliesTo || p.appliesTo === 'ALL' ? '<a href="/#commission">Commission a painting</a>' : ''}</div>
        </div></article>`;
    }).join('');
    $('how').hidden = !live.some((p) => p.code);
    document.querySelectorAll('[data-copy]').forEach((b) => {
      b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied ✓'; } catch { b.textContent = b.dataset.copy; } };
    });
    if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
  } catch (ex) { $('offers').innerHTML = `<p>Could not load the offers: ${esc(ex.message)}</p>`; }
}
main();
