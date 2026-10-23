// Open a document PDF that the function returns as base64 ({ pdf, name }) in a new tab.
// The tab is opened at once (on the click), so browsers don't block it, then filled when the file arrives.
export async function openPdf(load, onError) {
  const w = window.open('', '_blank');
  try {
    if (w) w.document.write('<p style="font:16px system-ui;padding:24px">Opening the document…</p>');
    const r = await load();
    const bin = atob(r.pdf);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    if (w) w.location.href = url;
    else { const a = document.createElement('a'); a.href = url; a.download = r.name || 'document.pdf'; a.click(); }
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  } catch (ex) {
    if (w) w.close();
    if (onError) onError(ex); else alert(ex.message); // eslint-disable-line no-alert
  }
}
