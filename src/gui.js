// Order Management look ("GUI"): Standard (the website colours) or one of three sharper studio looks.
// Chosen in Settings → Look & theme; remembered on this computer. Only changes how screens look.
const X = ':root:not(#_)'; // beats the light/dark colour rules
const card = (sel) => `${sel} fieldset.cost, ${sel} .detail .dtop, ${sel} #zohoBox, ${sel} .flowcard, ${sel} .lay-act, ${sel} .tablewrap, ${sel} .sbox, ${sel} .card`;
const LOOKS = {
  crisp: {
    vars: '--bg:#f2f5f9;--surface:#ffffff;--sunk:#f7f9fc;--line:#e2e8f0;--fg:#0f172a;--muted:#5b6577;--ink:#0f5132;--on-ink:#ffffff;--gold:#0f766e;--gold-soft:#e6f4f1;--ok:#15803d;--kumkum:#dc2626;--r:10px;color-scheme:light',
    accent: '#0f766e', tint: '#e6f4f1', head: 'linear-gradient(90deg,#0b3d2e,#145c3c)',
    extra: `{S} fieldset.cost,{S} .detail .dtop,{S} #zohoBox,{S} .flowcard,{S} .tablewrap,{S} .lay-act{background:#fff;border:1px solid #e2e8f0;box-shadow:0 1px 2px rgba(15,23,42,.05),0 4px 14px rgba(15,23,42,.06)}
{S} fieldset.cost [style*="border:1px solid var(--line)"],{S} #supplierBox>div[style*="border-top"],{S} .detail .dtop .kv,{S} fieldset.cost table{background:#f8fafc}
{S} thead th{background:#f8fafc!important;color:#475569}{S} tbody tr:hover td{background:#f1f7f5}`,
  },
  midnight: {
    vars: '--bg:#0a1020;--surface:#111a2e;--sunk:#0d1526;--line:#22304d;--fg:#e7ecf6;--muted:#93a1bb;--ink:#0e2a47;--on-ink:#ffffff;--gold:#22d3ee;--gold-soft:#0e2f3a;--ok:#34d399;--kumkum:#fb7185;--r:10px;color-scheme:dark',
    accent: '#22d3ee', tint: 'rgba(34,211,238,.12)', head: 'linear-gradient(90deg,#0b1730,#0e2a47 60%,#123a5a)',
    extra: `{S} fieldset.cost,{S} .detail .dtop,{S} #zohoBox,{S} .flowcard,{S} .tablewrap,{S} .lay-act{background:#111a2e;border:1px solid #22304d;box-shadow:0 0 0 1px rgba(34,211,238,.04),0 8px 24px rgba(0,0,0,.35)}
{S} fieldset.cost [style*="border:1px solid var(--line)"],{S} #supplierBox>div[style*="border-top"],{S} .detail .dtop .kv,{S} fieldset.cost table{background:#0d1526}
{S} input,{S} select,{S} textarea{background:#0b1324;border-color:#2a3a5c}{S} .btn{background:#22d3ee;color:#04202a}{S} .btn.ghost{background:transparent;color:#e7ecf6;border-color:#2a3a5c}
{S} thead th{background:#0d1526!important}{S} tbody tr:hover td{background:#13213a}`,
  },
  bold: {
    vars: '--bg:#eef1ea;--surface:#ffffff;--sunk:#f4f6f0;--line:#b9c4ad;--fg:#0e1a10;--muted:#3e4a3f;--ink:#14532d;--on-ink:#ffffff;--gold:#3f7d20;--gold-soft:#e5efd8;--ok:#166534;--kumkum:#b91c1c;--r:10px;color-scheme:light',
    accent: '#14532d', tint: '#dcebd0', head: 'linear-gradient(90deg,#0f3d22,#14532d)',
    extra: `{S} body{font-weight:500}
{S} fieldset.cost,{S} .detail .dtop,{S} #zohoBox,{S} .flowcard,{S} .tablewrap,{S} .lay-act{background:#fff;border:2px solid #b9c4ad;box-shadow:0 2px 0 #d6dfcc}
{S} fieldset.cost [style*="border:1px solid var(--line)"],{S} #supplierBox>div[style*="border-top"],{S} .detail .dtop .kv,{S} fieldset.cost table{background:#f7f9f4;border-width:2px!important;border-color:#c9d3bd!important}
{S} fieldset.cost>legend,{S} .flowhead h3,{S} .lay-h b{font-weight:800;font-size:16px}
{S} label,{S} .kv dt,{S} th{font-weight:700;color:#24301f}
{S} input,{S} select,{S} textarea{border:2px solid #b9c4ad;font-weight:500}
{S} .btn{font-weight:700;border:2px solid transparent}{S} .btn.ghost{border:2px solid #b9c4ad}
{S} .sec-ico{stroke-width:2.4}
{S} .df{border-width:2px}{S} .dfl{border-width:2px;border-left-width:5px}
{S} thead th{background:#f4f6f0!important}{S} tbody tr:hover td{background:#eef5e6}
{S} .muted{color:#4a5649}`,
  },
  aurora: {
    vars: '--bg:#f5f3ff;--surface:#ffffff;--sunk:#faf9ff;--line:#e6e1f7;--fg:#1e1b4b;--muted:#5f5a85;--ink:#4c1d95;--on-ink:#ffffff;--gold:#7c3aed;--gold-soft:#efe9ff;--ok:#059669;--kumkum:#e11d48;--r:12px;color-scheme:light',
    accent: '#7c3aed', tint: '#efe9ff', head: 'linear-gradient(90deg,#4c1d95,#6d28d9 45%,#0d9488)',
    extra: `{S} body{background:linear-gradient(160deg,#f5f3ff 0%,#eef6ff 45%,#ecfdf5 100%) fixed}
{S} fieldset.cost,{S} .detail .dtop,{S} #zohoBox,{S} .flowcard,{S} .tablewrap,{S} .lay-act{background:rgba(255,255,255,.85);border:1px solid #e6e1f7;box-shadow:0 10px 30px rgba(76,29,149,.08);backdrop-filter:blur(6px)}
{S} fieldset.cost{border-top:3px solid #7c3aed}
{S} fieldset.cost [style*="border:1px solid var(--line)"],{S} #supplierBox>div[style*="border-top"],{S} .detail .dtop .kv,{S} fieldset.cost table{background:#fbfaff}
{S} .btn{background:linear-gradient(90deg,#6d28d9,#7c3aed);box-shadow:0 4px 12px rgba(124,58,237,.25)}{S} .btn.ghost{background:transparent;box-shadow:none;color:var(--fg)}
{S} thead th{background:#faf9ff!important}{S} tbody tr:hover td{background:#f5f1ff}`,
  },
};
function css() {
  return Object.entries(LOOKS).map(([k, L]) => {
    const S = `html[data-gui="${k}"]`;
    return `${X}[data-gui="${k}"]{${L.vars}}
${S} body{background:var(--bg);color:var(--fg)}
${S} header.top{background:${L.head};border-top:0;box-shadow:0 2px 10px rgba(0,0,0,.12)}
${S} fieldset.cost{border-radius:12px;padding:14px 16px 16px}
${S} fieldset.cost>legend{font-size:15px;letter-spacing:.01em}
${S} .sec-ico{width:28px;height:28px;padding:5px;border-radius:8px;background:${L.tint};color:${L.accent}!important;vertical-align:-9px;margin-right:9px}
${S} .dft .lane-ico{width:22px;height:22px;padding:3px;border-radius:6px}
${S} .btn{border-radius:8px;font-weight:600}
${S} .mk-tabs button[aria-pressed="true"]{background:${L.accent};border-color:${L.accent};color:#fff}
${S} nav a.on,${S} .tabs [aria-selected="true"]{color:${L.accent}}
${S} input:focus,${S} select:focus,${S} textarea:focus{outline:2px solid ${L.accent};outline-offset:1px}
${L.extra.replaceAll('{S}', S)}`;
  }).join('\n');
}
const st = document.createElement('style'); st.id = 'gui-css'; st.textContent = css(); document.head.appendChild(st);
export const GUI_LOOKS = [['standard', 'Standard (website colours)'], ['crisp', 'Crisp: white cards, emerald'], ['bold', 'Bold: thicker lines and text, green'], ['midnight', 'Midnight: dark, cyan'], ['aurora', 'Aurora: violet to teal']];
export function applyGui(k) {
  const el = document.documentElement;
  if (LOOKS[k]) el.setAttribute('data-gui', k); else el.removeAttribute('data-gui');
  try { localStorage.setItem('kalaiGui', LOOKS[k] ? k : 'standard'); } catch { /* */ }
}
try { const k = localStorage.getItem('kalaiGui'); if (LOOKS[k]) document.documentElement.setAttribute('data-gui', k); } catch { /* */ }
window.kalaiGui = applyGui;
