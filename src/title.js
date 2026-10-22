// Turns an imported file name into a readable title; nothing meaningful left → "Original".
export function cleanTitle(raw) {
  let t = ' ' + String(raw || '').replace(/[_.]+/g, ' ') + ' ';
  t = t.replace(/\bsiva\s*raja\b/gi, ' ')
    .replace(/\b(freepik|newarc|midjourney|dall\s*e|stable\s*diffusion|ai|gr|seq|img|image|dsc|dscn|photo|pxl|screenshot|whatsapp|copy|final|edited|digital\s+painting)\b/gi, ' ')
    .replace(/\bo\s+painting\b/gi, ' ')
    .replace(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{6,}\b/gi, ' ') // random codes like Lpk98fnq…
    .replace(/\b\d+\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  t = t.replace(/(\s+\b(with|wit|and|of|in|a|an|the|on|at|by|for|to)\b)+$/i, '').trim();
  if ((t.match(/[a-z஀-௿]/gi) || []).length < 3) return 'Original';
  return t.replace(/\b([a-z])([a-z]*)/gi, (m, a, b) => a.toUpperCase() + b.toLowerCase()).replace(/\b(A|An|The|Of|In|And|On|At|With|To|For)\b(?!$)/g, (m, w, i) => (i === 0 ? w : w.toLowerCase()));
}
