// Dubai print shops researched 25 Oct 2026 (published contacts only). Prices: "est" = Claude's estimate for single
// prints on matte fine-art paper until the shop quotes; "pub" = the shop's own published price. fineArt: suitable for
// framed prints (used for the market estimate in costing until a print shop is approved).
export const PRINT_SHOPS = [
  { name: 'Gulf Photo Plus', phone: '+971506154203', email: 'info@gulfphotoplus.com', based: 'Warehouse D36, Alserkal Avenue, Al Quoz 1, Dubai',
    link: 'https://gulfphotoplus.com/pages/print-configurator', work: 'Fine-art lab: fine art paper, photo paper, canvas; 20×30 to 70×100 and A4–A0; online instant quote', fineArt: true,
    print: { 'A4': 45, 'A3': 75, '30×40': 75, '40×50': 120, '50×70': 180, '60×80': 240, '70×100': 300 }, basis: 'est' },
  { name: 'Qube Art Frames', phone: '+971524552404', email: '', based: 'Al Quoz 3 (M K Ghanim, Unit 45) · Dubai Hills Mall',
    link: 'https://www.qubeartgallery.com/print/giclee-printing/', work: 'Giclée on Hahnemühle, Breathing Color, Perma Jet; no minimum; same-day; also frames', fineArt: true,
    print: { 'A4': 50, 'A3': 80, '30×40': 80, '40×50': 130, '50×70': 190, '60×80': 250, '70×100': 320 }, basis: 'est' },
  { name: 'Monda Gallery', phone: '+971552690289', email: 'Printing@MondaGallery.com', based: 'Dubai',
    link: 'https://www.mondagallery.com/pages/fine-art-photo-printing', work: '300 gsm fine art matte, 260 gsm lustre, 230 gsm white matte (most affordable), cotton canvas; also framing', fineArt: true,
    print: { 'A4': 30, 'A3': 50, '30×40': 55, '40×50': 90, '50×70': 130, '60×80': 175, '70×100': 220 }, basis: 'est' },
  { name: 'AB Print House', phone: '+971552900350', email: 'print@abprintonline.ae', based: 'Dubai (P.O. Box 393536) · 04 254 7887',
    link: 'https://www.abprintonline.ae/product/standard-poster-printing/', work: 'Heavy satin photo paper (matt), A3–A0, 1–5 copies; published AED 18.90–428.75 by size. Photo paper, not fine art.', fineArt: false,
    print: { 'A3': 19 }, basis: 'pub' },
  { name: 'Print Arabia (Al Jafra Printing)', phone: '+971528200961', email: 'info@printarabia.ae', based: 'Dubai · 04 346 9415',
    link: 'https://www.printarabia.ae/rolled-canvas-printing-dubai', work: 'Rolled artist canvas, published: A4 255 · A3 325 · A2 425 · A1 565 (incl. VAT). Canvas only, not paper.', fineArt: false,
    print: {}, basis: 'pub' },
];
