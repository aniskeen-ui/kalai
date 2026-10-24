// Artwork / painting search box for any list: hides the cards that don't match (title, code, artist, size…).
// Matches every word typed, in any order, ignoring case. Cards are found by selector; data-find (if set) adds hidden text.
export function wireFind(input, selector, root = document) {
  if (!input) return () => {};
  const run = () => {
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0, all = 0;
    root.querySelectorAll(selector).forEach((el) => {
      all++;
      const hay = `${el.textContent} ${el.dataset.find || ''} ${[...el.querySelectorAll('input:not([type=checkbox]),textarea')].map((i) => i.value).join(' ')}`.toLowerCase();
      const ok = words.every((w) => hay.includes(w));
      el.hidden = !ok; if (ok) shown++;
    });
    const note = input.parentElement?.querySelector('.find-count');
    if (note) note.textContent = words.length ? `${shown} of ${all}` : '';
  };
  input.addEventListener('input', run);
  return run;
}
