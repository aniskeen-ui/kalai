// Pricing → one work → Competitor simulation (UAE). Four boxes: three competitors and a "Mix" of them.
// Each competitor has a price for a comparable framed piece per artwork size (S / M / L) and our position against it
// (−10% = 10% under them; +30% = an original priced 30% over their framed print). Clicking a box simulates our
// black-frame price from that competitor (never below our cost-based price), lifts every frame style by the same
// amount (as "Set to the middle of the band" does) and shows the margin. "Use these prices" copies them into
// "New price for the website". The Mix box combines the three by the rule chosen on the right.
// Saved in the Rates table under key 'competitors'.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DHS = '<i class="dhs" aria-label="Dhs">⃃</i>';
const aed = (v) => (v == null || !Number.isFinite(v) ? '–' : DHS + Math.round(v).toLocaleString('en-US'));
const r25 = (v) => Math.ceil(v / 25) * 25;

// Researched 28 Oct 2026 (public listings). Prices are for a comparable framed piece; estimates where marked.
export const DEFAULT_COMP = {
  list: [
    { name: 'Artezaar', what: 'UAE online gallery: originals by UAE-based artists', p: { S: 650, M: 1100, L: 2200 }, pos: -10,
      url: 'https://artezaar.com/collections/all-paintings',
      note: 'Originals 20×20 cm ⃃550–1,100 · 59×42 cm ⃃699 · 48×48 cm ⃃2,700 · 60×90 cm ⃃1,800 · framed prints 46×35 cm ⃃300 (Oct 2026).' },
    { name: 'Gallery One', what: 'Dubai: framed art prints (copies, not originals)', p: { S: 400, M: 550, L: 850 }, pos: 30,
      url: 'https://whatson.ae/2024/12/heres-where-you-can-buy-beautiful-wall-art-in-dubai-for-under-dhs500/',
      note: 'Prints from ⃃400; M and L are estimates. An original is priced over a print (position +30%).' },
    { name: 'Art Smiley', what: 'Dubai online marketplace: mostly prints, frame extra', p: { S: 250, M: 330, L: 500 }, pos: 60,
      url: 'https://artsmileydecor.com/collections/all',
      note: 'Prints ⃃132–199 (40×50 cm and up, frame an add-on); framed prices here are estimates. Position +60% for an original.' },
  ],
  rule: 'weighted', // avg | low | high | median | weighted
  w: [50, 25, 25],
  sketch: 80, // a pencil sketch: % of a watercolour's comparable price
};
export let comp = structuredClone(DEFAULT_COMP);
let tab = 0; // 0–2 a competitor, 3 the mix

export async function loadComp(client) {
  try {
    const r = await client.models.Rates.get({ key: 'competitors' });
    const d = r?.data?.data ? (typeof r.data.data === 'string' ? JSON.parse(r.data.data) : r.data.data) : null;
    comp = d?.list?.length === 3 ? { ...structuredClone(DEFAULT_COMP), ...d } : structuredClone(DEFAULT_COMP);
  } catch { comp = structuredClone(DEFAULT_COMP); }
}
async function saveComp(client) {
  const rec = { key: 'competitors', data: JSON.stringify(comp) };
  const got = await client.models.Rates.get({ key: 'competitors' }).catch(() => null);
  const r = got?.data ? await client.models.Rates.update(rec) : await client.models.Rates.create(rec);
  if (r.errors?.length) throw new Error(r.errors[0].message);
}

const RULES = [['avg', 'Average'], ['median', 'Middle (median)'], ['low', 'Lowest'], ['high', 'Highest'], ['weighted', 'Weighted']];
/** Our black-frame target from one competitor (before the cost floor), or null when it has no price for the size. */
export function targetOf(c, tier, md) {
  const base = Number(c?.p?.[tier]);
  if (!(base > 0)) return null;
  return base * (md === 'sk' ? (Number(comp.sketch) || 100) / 100 : 1) * (1 + (Number(c.pos) || 0) / 100);
}
export function mixOf(ts, rule = comp.rule, w = comp.w) {
  const v = ts.map((t, i) => [t, Number(w[i]) || 0]).filter(([t]) => t != null);
  if (!v.length) return null;
  const xs = v.map(([t]) => t).sort((a, b) => a - b);
  if (rule === 'low') return xs[0];
  if (rule === 'high') return xs[xs.length - 1];
  if (rule === 'median') return xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
  if (rule === 'weighted') { const sw = v.reduce((a, [, x]) => a + x, 0); if (sw > 0) return v.reduce((a, [t, x]) => a + t * x, 0) / sw; }
  return xs.reduce((a, t) => a + t, 0) / xs.length;
}

/** ctx: { tier, md, styles: [{k, n}], b: build() result, pct, now(k), setFinals(fn), client } */
export function drawSim(el, ctx) {
  const { tier, md, styles, b, pct } = ctx;
  const ts = comp.list.map((c) => targetOf(c, tier, md));
  const raw = tab === 3 ? mixOf(ts) : ts[tab];
  const floor = b.styles.black.price;
  const target = raw == null ? null : r25(Math.max(raw, floor));
  const diff = target == null ? 0 : target - floor;
  const priceOf = (k) => Math.max(0, Math.round(b.styles[k].price + diff));
  const marg = (k) => { const p = priceOf(k), net = p * (1 - pct) - b.styles[k].cost; return `${Math.round(net)} (${p ? Math.round((net / p) * 100) : 0}%)`; };
  const c = comp.list[tab];
  const ruleTxt = (RULES.find(([k]) => k === comp.rule) || RULES[0])[1];
  const box = (i, label, sub) => `<button type="button" class="pc-simbox" data-sim="${i}" aria-pressed="${tab === i}"><b>${esc(label)}</b><span>${sub}</span></button>`;
  el.innerHTML = `<div class="pc-sim">
    <div class="pc-simhead"><b>Competitor simulation (UAE)</b><span class="muted" style="font-size:12px">Artwork size ${esc(tier)} · ${md === 'sk' ? `sketch (${comp.sketch}% of a painting's price)` : 'watercolour'} · click a box to simulate</span></div>
    <div class="pc-simrow">
      ${comp.list.map((x, i) => box(i, `${i + 1}. ${x.name}`, ts[i] == null ? 'no price for this size' : `them ${aed(Number(x.p[tier]) * (md === 'sk' ? comp.sketch / 100 : 1))} · us ${x.pos > 0 ? '+' : ''}${x.pos}%`)).join('')}
      ${box(3, '4. Mix', `${esc(ruleTxt)}${comp.rule === 'weighted' ? ` ${comp.w.join(' / ')}` : ''}`)}
      <div class="pc-simrule"><label style="display:grid;gap:2px">Mix rule <select id="simRule">${RULES.map(([k, l]) => `<option value="${k}" ${k === comp.rule ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <div id="simW" ${comp.rule === 'weighted' ? '' : 'hidden'} style="display:flex;gap:4px;align-items:center;font-size:12px">Weights ${comp.list.map((x, i) => `<input type="number" min="0" max="100" step="5" data-w="${i}" value="${comp.w[i]}" title="${esc(x.name)}" style="width:52px">`).join('')}</div></div>
    </div>
    <div class="pc-simout">
      ${raw == null ? '<p class="muted" style="margin:0">No competitor price for this size: add one under “Competitors and their prices”.</p>' : `
      <div style="font-size:13px;line-height:1.6">${tab === 3
        ? `${comp.list.map((x, i) => `${esc(x.name)} ${ts[i] == null ? '–' : aed(ts[i])}`).join(' · ')} → <b>${esc(ruleTxt)}</b> ${aed(raw)}`
        : `${esc(c.name)}: comparable framed piece ${aed(Number(c.p[tier]) * (md === 'sk' ? comp.sketch / 100 : 1))} · our position ${c.pos > 0 ? '+' : ''}${c.pos}% → ${aed(raw)}`}
        · our cost-based black frame ${aed(floor)}
        <br>Suggested black-frame price <b>${aed(target)}</b>${raw < floor ? ' <b class="warn-t">· their price is under our cost-based price: kept at cost-based</b>' : ''}</div>
      <div class="tablewrap"><table class="costs"><thead><tr><th></th>${styles.map((s) => `<th class="num">${esc(s.n)}</th>`).join('')}</tr></thead><tbody>
        <tr class="tot"><td>Suggested price</td>${styles.map((s) => `<td class="num mono" data-simp="${s.k}">${priceOf(s.k)}</td>`).join('')}</tr>
        <tr><td>Your margin</td>${styles.map((s) => `<td class="num mono">${marg(s.k)}</td>`).join('')}</tr>
        <tr><td>Now on the website</td>${styles.map((s) => `<td class="num mono">${ctx.now(s.k) ?? '–'}</td>`).join('')}</tr>
      </tbody></table></div>
      <button type="button" class="btn small" id="simUse">Use these prices</button> <span class="muted" style="font-size:12px">Copies them into “New price for the website”; nothing is saved until you approve.</span>`}
    </div>
    <details class="pc-simedit"><summary>Competitors and their prices</summary>
      <div class="tablewrap"><table class="costs"><thead><tr><th>Competitor</th><th>What they sell</th><th class="num">S</th><th class="num">M</th><th class="num">L</th><th class="num">Our position %</th><th>Source</th></tr></thead><tbody>
      ${comp.list.map((x, i) => `<tr data-ci="${i}"><td><input data-c="name" value="${esc(x.name)}" style="width:120px"></td><td><input data-c="what" value="${esc(x.what)}" style="width:220px"><div class="muted" style="font-size:11px;max-width:300px;white-space:normal">${esc(x.note || '')}</div></td>
        ${['S', 'M', 'L'].map((t) => `<td><input data-c="p.${t}" type="number" min="0" step="25" value="${x.p?.[t] ?? ''}" style="width:72px"></td>`).join('')}
        <td><input data-c="pos" type="number" step="5" value="${x.pos}" style="width:64px"></td><td>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer" style="font-size:12px">open</a>` : ''}</td></tr>`).join('')}
      </tbody></table></div>
      <label style="font-size:13px">A pencil sketch is <input id="simSk" type="number" min="10" max="150" step="5" value="${comp.sketch}" style="width:60px">% of a painting's price</label>
      <div style="margin-top:6px"><button type="button" class="btn small" id="simSave">Save competitors</button> <button type="button" class="btn small ghost" id="simReset">Back to the researched figures</button> <span class="muted" id="simMsg" style="font-size:12px">S = artwork up to 30 cm, M up to 45 cm, L larger. Prices for a comparable framed piece, in ⃃.</span></div>
    </details></div>`;
  const redraw = () => drawSim(el, ctx);
  el.querySelectorAll('[data-sim]').forEach((x) => { x.onclick = () => { tab = Number(x.dataset.sim); redraw(); }; });
  // The mix rule and weights are kept straight away (for every work).
  const keep = () => saveComp(ctx.client).catch(() => {});
  el.querySelector('#simRule').onchange = (e) => { comp.rule = e.target.value; tab = 3; keep(); redraw(); };
  el.querySelectorAll('[data-w]').forEach((x) => { x.onchange = () => { comp.w[Number(x.dataset.w)] = Number(x.value) || 0; tab = 3; keep(); redraw(); }; });
  if (el.querySelector('#simUse')) el.querySelector('#simUse').onclick = () => ctx.setFinals((s) => priceOf(s.k));
  const read = () => {
    el.querySelectorAll('[data-ci]').forEach((tr) => {
      const x = comp.list[Number(tr.dataset.ci)];
      tr.querySelectorAll('[data-c]').forEach((i) => {
        const k = i.dataset.c;
        if (k.startsWith('p.')) { (x.p ||= {})[k.slice(2)] = i.value === '' ? null : Number(i.value); } else if (k === 'pos') x.pos = Number(i.value) || 0; else x[k] = i.value.trim();
      });
    });
    comp.sketch = Number(el.querySelector('#simSk').value) || 100;
  };
  el.querySelectorAll('.pc-simedit input').forEach((i) => { i.addEventListener('change', () => { read(); redraw(); el.querySelector('.pc-simedit').open = true; }); });
  el.querySelector('#simSave').onclick = async () => {
    read(); const m = el.querySelector('#simMsg'); m.textContent = 'Saving…';
    try { await saveComp(ctx.client); redraw(); el.querySelector('.pc-simedit').open = true; el.querySelector('#simMsg').textContent = 'Saved: used for every work.'; } catch (ex) { m.textContent = ex.message; }
  };
  el.querySelector('#simReset').onclick = () => { comp = structuredClone(DEFAULT_COMP); redraw(); el.querySelector('.pc-simedit').open = true; el.querySelector('#simMsg').textContent = 'Researched figures back: press Save competitors to keep them.'; };
}
