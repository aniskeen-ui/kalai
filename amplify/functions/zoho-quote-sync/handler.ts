import { env } from '$amplify/env/zoho-quote-sync';
import { DynamoDBClient, UpdateItemCommand, GetItemCommand, ScanCommand, BatchGetItemCommand, PutItemCommand, DeleteItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { KURALS } from './kural-data';
import { S3Client, GetObjectCommand, PutObjectCommand, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { TranslateClient, TranslateTextCommand, TranslateDocumentCommand } from '@aws-sdk/client-translate';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Kalai Art House ↔ Zoho Books.
 *  - New enquiry            → quote (estimate) against the fixed customer.
 *  - Price changed          → quote price updated.
 *  - Status changed to Paid → invoice (KAH-INV-0001 series) + payment recorded, quote marked accepted.
 *  - Zoho's result is written back onto the enquiry (zohoState / zohoMessage …) for the Studio desk.
 *  - Once Zoho holds the payment, the enquiry is locked: it can't go back to Received / Price sent /
 *    Cancelled and the price can't change, until the invoice or payment is reversed in Zoho and
 *    "Check Zoho" is pressed in the Studio desk (the checkZoho mutation, also handled here).
 *  - VAT: off until the SSM parameter /kalai/zoho/vat_tax_id holds the Zoho 5% tax ID.
 *    Prices are VAT-inclusive.
 *  - Purchase side (artist Siva Raja; this Zoho plan has no purchase orders): once paid, Siva's order is
 *    recorded on the enquiry (price fixed); his invoice number → bill for his price + India courier
 *    from the Costing record; payment reference → payment made against the bill.
 *  - Artist desk API (artistList / artistQuote / artistPhoto): Siva sees and prices works without
 *    customer details or selling prices.
 */

type Attr = AttributeValue & { S?: string; N?: string };
type Img = Record<string, Attr>;
type StreamRecord = { eventID?: string; eventName?: string; dynamodb?: { NewImage?: Img; OldImage?: Img } };
type StreamEvent = { Records: StreamRecord[] };
type ApiEvent = {
  identity?: { sub?: string; username?: string; groups?: string[] | null; claims?: Record<string, unknown> };
  arguments: { data?: string | null; code?: string | null; country?: string | null; pin?: string | null; text?: string; source?: string | null; mode?: string; links?: string; name?: string; emirate?: string; address?: string; landmark?: string | null; ref?: string; title?: string; details?: string | null; customerName?: string; phone?: string; email?: string | null; id?: string; priceInr?: number | null; readyBy?: string | null; note?: string | null; step?: string; courier?: string | null; awb?: string | null; action?: string; reason?: string | null; photos?: string | null };
  info?: { fieldName?: string };
  fieldName?: string;
  request?: { headers?: Record<string, string> };
};
type LineItem = { line_item_id?: string; name?: string; description?: string; rate?: number; quantity?: number; tax_id?: string; discount?: number | string };
type ZohoBody = {
  code?: number;
  message?: string;
  contacts?: { contact_id: string; contact_name: string }[];
  contact?: { contact_id: string };
  estimate?: { estimate_id: string; estimate_number: string; customer_id?: string; status?: string; line_items?: LineItem[] };
  estimates?: { estimate_id: string; estimate_number: string; reference_number?: string; status?: string }[];
  invoice?: { invoice_id: string; invoice_number: string; status?: string; balance?: number; total?: number; customer_id?: string };
  invoices?: { invoice_id: string; invoice_number: string; reference_number?: string; status?: string; balance?: number }[];
  payment?: { payment_id: string; payment_number?: string };
  payments?: { payment_id: string; payment_number?: string; amount?: number }[];
  purchaseorder?: { purchaseorder_id: string; purchaseorder_number: string; status?: string; line_items?: (LineItem & { account_id?: string })[] };
  bill?: { bill_id: string; bill_number: string; balance?: number; total?: number; status?: string };
  vendorpayment?: { payment_id: string; payment_number?: string };
};

// Sales category (as on the website menu), used in emails, Zoho and the supplier portal.
const KIND: Record<string, string> = { PRICE: 'Collection', COMMISSION: 'Commission', GIFT: 'Little Artists', MARKET: 'Crafts shop', PHOTO: 'Framed Prints', LICENCE: 'Image licence' };
const INVOICE_PREFIX = 'KAH-INV-';
// Kalai's own credit note series. Like KAH-INV, the next number is worked out from the credit notes that exist,
// so deleting the test drafts before going live makes the live series start again at KAH-CN-0001.
const CREDIT_PREFIX = 'KAH-CN-';

/* ---------- Number series (Settings → Number series; Rates key "numberSeries") ----------
 * Per document: prefix, mode (alpha = prefix + digits, numeric = digits only), source (internal = Kalai numbers it,
 * external = typed by the supplier / numbered by Zoho), digits. Supplier invoices: each supplier has its own 2-letter
 * code (Master Frames → MF) and running number: MF00000001, MF00000002 … */
type SeriesDoc = { prefix: string; mode: 'alpha' | 'numeric'; source: 'internal' | 'external'; digits: number };
type NumberSeries = { docs: Record<string, SeriesDoc>; sup: Record<string, { code: string; next: number; name?: string }>; counters?: Record<string, number> };
const SERIES_DEF: Record<string, SeriesDoc> = {
  supInv: { prefix: '', mode: 'alpha', source: 'external', digits: 8 },
  inv: { prefix: INVOICE_PREFIX, mode: 'alpha', source: 'internal', digits: 4 },
  cn: { prefix: CREDIT_PREFIX, mode: 'alpha', source: 'internal', digits: 4 },
  qt: { prefix: 'KAH-QT-', mode: 'alpha', source: 'external', digits: 4 },
  dc: { prefix: 'KAH-DC-', mode: 'alpha', source: 'external', digits: 4 },
  // Airway bill: tokens in the prefix: {C} = the courier's 2 letters, {YY} {MM} {DD} = today (Dubai).
  awb: { prefix: 'KA{C}', mode: 'alpha', source: 'internal', digits: 8 },
};
async function numberSeries(): Promise<NumberSeries> {
  let d: unknown = null;
  try { const row = plain(await getRow(process.env.RATES_TABLE!, { key: { S: 'numberSeries' } })); d = row?.data; for (let i = 0; i < 2 && typeof d === 'string'; i++) d = JSON.parse(d); } catch { d = null; }
  const o = (d && typeof d === 'object' ? d : {}) as Partial<NumberSeries>;
  const docs: Record<string, SeriesDoc> = {};
  for (const [k, def] of Object.entries(SERIES_DEF)) {
    const x = (o.docs?.[k] ?? {}) as Partial<SeriesDoc>;
    docs[k] = {
      prefix: typeof x.prefix === 'string' ? x.prefix.slice(0, 16) : def.prefix,
      mode: x.mode === 'numeric' ? 'numeric' : x.mode === 'alpha' ? 'alpha' : def.mode,
      source: x.source === 'external' ? 'external' : x.source === 'internal' ? 'internal' : def.source,
      digits: Math.min(12, Math.max(3, Number(x.digits) || def.digits)),
    };
  }
  // Test site: its Zoho documents get their own TEST- numbers, so the live series (KAH-INV-0001…) stays untouched.
  if (TEST_SITE) for (const k of ['inv', 'cn', 'qt', 'dc']) docs[k] = { ...docs[k], mode: 'alpha', source: 'internal', prefix: docs[k].prefix.startsWith('TEST-') ? docs[k].prefix : `TEST-${docs[k].prefix}` };
  return { ...(o as object), docs: { ...((o.docs ?? {}) as Record<string, SeriesDoc>), ...docs }, sup: (o.sup && typeof o.sup === 'object' ? o.sup : {}) } as NumberSeries;
}
async function saveSeries(ns: NumberSeries) {
  const row = plain(await getRow(process.env.RATES_TABLE!, { key: { S: 'numberSeries' } }));
  const now = new Date().toISOString();
  await putRow(process.env.RATES_TABLE!, { ...(row ?? {}), key: 'numberSeries', __typename: 'Rates', data: JSON.stringify(ns), createdAt: String(row?.createdAt ?? now), updatedAt: now });
}
const seriesNo = (doc: SeriesDoc, n: number) => `${doc.mode === 'numeric' ? '' : doc.prefix}${String(n).padStart(doc.digits, '0')}`;
/** 2 letters from the supplier's name, not used by another supplier: Master Frames → MF, Glassworks → GL. */
function supplierCode(name: string, taken: Set<string>) {
  const w = name.toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean);
  const letters = w.join('');
  const tries: string[] = [];
  if (w.length >= 2) tries.push(w[0][0] + w[1][0]);
  for (let i = 1; i < letters.length; i++) tries.push((letters[0] ?? 'S') + letters[i]);
  for (const a of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') for (const b of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') tries.push(a + b);
  return tries.find((c) => c.length === 2 && !taken.has(c))!;
}
/** Next airway bill number (Settings → Number series → Airway bill), moving the counter on. Null when the courier gives it. */
async function nextAwb(courierId: string, courierName: string): Promise<string | null> {
  const ns = await numberSeries();
  const doc = ns.docs.awb;
  if (doc.source !== 'internal') return null;
  let s = ns.sup[courierId];
  if (!s?.code) {
    const taken = new Set(Object.entries(ns.sup).filter(([k]) => k !== courierId).map(([, v]) => v.code));
    s = { code: supplierCode(courierName || 'Courier', taken), next: s?.next || 1, name: courierName };
    ns.sup[courierId] = s;
  }
  const t = dubaiToday(); // YYYY-MM-DD
  const pre = doc.mode === 'numeric' ? '' : doc.prefix.replace(/\{C\}/g, s.code).replace(/\{YY\}/g, t.slice(2, 4)).replace(/\{MM\}/g, t.slice(5, 7)).replace(/\{DD\}/g, t.slice(8, 10));
  const counters = ns.counters ?? (ns.counters = {});
  const n = (counters.awb || 0) + 1;
  counters.awb = n;
  await saveSeries(ns);
  return `${pre}${String(n).padStart(doc.digits, '0')}`;
}
/** The shop the courier collects from: the frame shop, or the print shop when there is no framing. */
const shipRole = (jobs: Jobs): Role | null => (jobs.framer ? 'framer' : jobs.printer ? 'printer' : null);
/** The finished parcel gets its airway bill: once the shop has it ready and a courier is allocated. Returns true when one was made. */
async function ensureAwb(jobs: Jobs): Promise<boolean> {
  const sr = shipRole(jobs), dj = jobs.delivery;
  if (!sr || !dj || dj.awb || !['READY', 'COLLECTED'].includes(jobs[sr]!.stage)) return false;
  const no = await nextAwb(dj.supplierId, dj.name);
  if (!no) return false;
  dj.awb = no; dj.awbAt = new Date().toISOString();
  return true;
}

/** Label data for the parcel to the customer (from the shop the courier collects from). */
async function deliveryLabel(e: Img, jobs: Jobs) {
  const sr = shipRole(jobs), dj = jobs.delivery;
  if (!sr || !dj) throw new Error('No courier allocated for this order yet.');
  if (!dj.awb) throw new Error('No airway bill yet: it is made when the shop marks the job ready (or the courier gives it).');
  const { S } = mtables();
  const shop = plain(await getRow(S, { id: { S: jobs[sr]!.supplierId } }));
  const det = parseDetails(detStr(e));
  const kind = str(e, 'kind');
  const parcel = sr === 'printer' && !['GIFT', 'PHOTO'].includes(kind) ? 'Print' : sr === 'printer' ? 'Print (flat, do not bend)' : parcelOf(det);
  return {
    awb: dj.awb, courier: dj.name, ref: str(e, 'ref'), date: dubaiToday(), service: 'Prepaid · Standard', pieces: '1 of 1',
    contents: parcel, fragile: sr === 'framer' && !/unframed/i.test(parcel),
    from: { name: String(shop?.business ?? jobs[sr]!.name), phone: String(shop?.phone ?? ''), address: String(shop?.address ?? '') },
    to: { name: str(e, 'deliveryName') || str(e, 'customerName'), phone: str(e, 'deliveryPhone') || str(e, 'phone'), address: addressText(e) },
    returnTo: 'Kalai Art House, Dubai · +971 55 299 6626',
  };
}
/** The artist's parcel gets its airway bill once the work is finished and a courier is allocated. */
async function ensureArtistAwb(e: Img, jobs: Jobs): Promise<boolean> {
  const ib = jobs.inbound;
  if (!ib || ib.awb || str(e, 'artistStage') !== 'FINISHED') return false;
  const no = await nextAwb(ib.supplierId, ib.name);
  if (!no) return false;
  ib.awb = no; ib.awbAt = new Date().toISOString();
  return true;
}
/** Label data for the artist's parcel: from the artist, to the frame shop on the order (else the studio). */
async function artistLabel(e: Img, jobs: Jobs) {
  const ib = jobs.inbound!;
  const { S } = mtables();
  const fp = jobs.framer ? plain(await getRow(S, { id: { S: jobs.framer.supplierId } })) : null;
  const det = parseDetails(detStr(e));
  return {
    awb: ib.awb!, courier: ib.name, ref: str(e, 'ref'), date: dubaiToday(), service: 'Prepaid · Standard', pieces: '1 of 1',
    contents: `${str(e, 'kind') === 'COMMISSION' ? 'Commissioned artwork' : 'Original artwork'} (unframed, flat)${det['Size'] ? `, ${String(det['Size']).slice(0, 30)}` : ''}`, fragile: false,
    from: ib.from ?? { name: 'Artist', phone: '', address: '' },
    to: fp ? { name: String(fp.business ?? jobs.framer!.name), phone: String(fp.phone ?? ''), address: [fp.address, fp.city, fp.emirate, fp.country || 'UAE'].filter(Boolean).map(String).join(', ') }
      : { name: 'Kalai Art House', phone: '+971 55 299 6626', address: 'Studio, Dubai, UAE' },
    returnTo: 'Kalai Art House, Dubai · +971 55 299 6626',
  };
}

/** The supplier's next invoice number (peek; take = true also moves the counter on). Null when suppliers type their own. */
async function supplierInvoiceNo(sellerId: string, name: string, take = false): Promise<string | null> {
  const ns = await numberSeries();
  const doc = ns.docs.supInv;
  if (doc.source !== 'internal') return null;
  let s = ns.sup[sellerId];
  if (!s?.code) {
    const taken = new Set(Object.entries(ns.sup).filter(([k]) => k !== sellerId).map(([, v]) => v.code));
    s = { code: supplierCode(name || 'Supplier', taken), next: s?.next || 1, name };
  }
  const no = `${TEST_SITE ? 'T-' : ''}${doc.mode === 'numeric' ? '' : s.code}${String(s.next || 1).padStart(doc.digits, '0')}`;
  if (take) { ns.sup[sellerId] = { ...s, next: (s.next || 1) + 1, name }; await saveSeries(ns); }
  return no;
}
const VAT_PARAM = '/kalai/zoho/vat_tax_id';
// Test mode (default ON until /kalai/zoho/test_mode is set to "off"): drafts only, nothing posted to the accounts.
const TEST_PARAM = '/kalai/zoho/test_mode';
// Statuses an enquiry may not go back to once Zoho holds its payment.
const BEFORE_PAYMENT = ['RECEIVED', 'PRICE_SENT', 'CANCELLED'];

const VENDOR_NAME = 'Siva Raja';

const ddb = new DynamoDBClient({});
const ssm = new SSMClient({});
const s3 = new S3Client({});

let cachedToken: { value: string; expires: number } | null = null;
let cachedCustomerId: string | null = null;
let cachedVendorId: string | null = null;
let cachedVat: { id: string | null; at: number } | null = null;
let cachedTest: { on: boolean; at: number } | null = null;

/** The test site (every branch except "production"): always in test mode, whatever the SSM switches say. */
const TEST_SITE = process.env.KALAI_STAGE !== 'prod';
/** True while testing: invoices and POs stay drafts; no payments, bills or vendor payments are posted. */
async function testMode(): Promise<boolean> {
  if (TEST_SITE) return true;
  if (cachedTest && Date.now() - cachedTest.at < 60_000) return cachedTest.on;
  let on = true;
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: TEST_PARAM }));
    on = (r.Parameter?.Value ?? '').trim().toLowerCase() !== 'off';
  } catch {
    on = true; // not created yet → test mode
  }
  cachedTest = { on, at: Date.now() };
  return on;
}

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
  const params = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN,
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const res = await fetch(`${env.ZOHO_ACCOUNTS_URL}/oauth/v2/token?${params}`, { method: 'POST' });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!body.access_token) throw new Error(`Zoho token refresh failed: ${body.error ?? 'no access_token'}`);
  cachedToken = { value: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}

async function zoho(path: string, init: RequestInit = {}) {
  const token = await accessToken();
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${env.ZOHO_API_URL}${path}${sep}organization_id=${env.ZOHO_ORG_ID}`, {
    ...init,
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  let body: ZohoBody = {};
  try {
    body = (await res.json()) as ZohoBody;
  } catch {
    body = { message: `HTTP ${res.status}` };
  }
  return { ok: res.ok && body.code === 0, status: res.status, body };
}

/** A Zoho document as a PDF (base64), for the invoice links in the portals: e.g. /invoices/{id}, /bills/{id}. */
async function zohoPdf(path: string, name: string) {
  const token = await accessToken();
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${env.ZOHO_API_URL}${path}${sep}accept=pdf&organization_id=${env.ZOHO_ORG_ID}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  if (!res.ok) throw new Error(`The document could not be opened (${res.status}). Please try again later.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 4_000_000) throw new Error('The document is too large to open here.');
  return { pdf: buf.toString('base64'), name: `${name.replace(/[^A-Za-z0-9._-]+/g, '-')}.pdf` };
}

/** Zoho 5% VAT tax ID, or null while VAT is off. Re-read every 10 minutes. */
async function vatTaxId(): Promise<string | null> {
  if (cachedVat && Date.now() - cachedVat.at < 600_000) return cachedVat.id;
  let id: string | null = null;
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: VAT_PARAM }));
    const v = (r.Parameter?.Value ?? '').trim();
    id = v && v.toLowerCase() !== 'off' ? v : null;
  } catch {
    id = null; // parameter not created yet → VAT off
  }
  cachedVat = { id, at: Date.now() };
  return id;
}

/** Fields that make a quote/invoice VAT-inclusive at 5%, or nothing while VAT is off. */
async function vatFields() {
  const taxId = await vatTaxId();
  return taxId ? { taxId, header: { is_inclusive_tax: true, place_of_supply: 'DU' } } : { taxId: null, header: {} };
}

/** The single fixed customer all website quotes are raised against. */
async function fixedCustomerId(): Promise<string> {
  if (cachedCustomerId) return cachedCustomerId;
  const name = env.ZOHO_CUSTOMER_NAME;
  const found = await zoho(`/contacts?contact_name=${encodeURIComponent(name)}`);
  if (!found.ok) throw new Error(`Zoho customer search failed (${found.status}): ${found.body.message}`);
  const match = found.body.contacts?.find((c) => c.contact_name === name);
  if (match) return (cachedCustomerId = match.contact_id);
  const created = await zoho('/contacts', {
    method: 'POST',
    body: JSON.stringify({
      contact_name: name,
      contact_type: 'customer',
      customer_sub_type: 'business',
      notes: 'Fixed customer for quotes raised automatically from art.pranixtechno.com enquiries.',
    }),
  });
  if (!created.ok || !created.body.contact) throw new Error(`Zoho customer create failed (${created.status}): ${created.body.message}`);
  return (cachedCustomerId = created.body.contact.contact_id);
}

/** The customer as their own Zoho contact ("Name (BP-0000009)"), created on first use; the fixed website contact
 *  only when the order has no name. */
const customerCache = new Map<string, string>();
async function customerIdFor(img: Img): Promise<string> {
  const nm = str(img, 'customerName').replace(/\s+/g, ' ').trim();
  if (!nm) return fixedCustomerId();
  const code = str(img, 'customerCode');
  const name = (code ? `${nm} (${code})` : nm).slice(0, 190);
  const hit = customerCache.get(name);
  if (hit) return hit;
  const found = await zoho(`/contacts?contact_name=${encodeURIComponent(name)}`);
  const match = found.ok ? found.body.contacts?.find((c) => c.contact_name === name) : undefined;
  if (match) { customerCache.set(name, match.contact_id); return match.contact_id; }
  const [first, ...rest] = nm.split(' ');
  const created = await zoho('/contacts', {
    method: 'POST',
    body: JSON.stringify({
      contact_name: name, contact_type: 'customer', customer_sub_type: 'individual',
      contact_persons: [{ first_name: first, last_name: rest.join(' ') || undefined, email: str(img, 'email') || undefined, phone: str(img, 'phone') || undefined, is_primary_contact: true }],
      notes: `Website customer ${code || ''} (art.pranixtechno.com).`.trim(),
    }),
  });
  if (!created.ok || !created.body.contact) { console.warn(`Zoho customer ${name} not created (${created.status}): ${created.body.message}`); return fixedCustomerId(); }
  customerCache.set(name, created.body.contact.contact_id);
  return created.body.contact.contact_id;
}
/** The customer the order's invoice is made out to (older orders: the website contact), so challans and credit notes match it. */
async function invoiceCustomerId(img: Img): Promise<string> {
  const invId = str(img, 'zohoInvoiceId');
  if (invId) {
    const r = await zoho(`/invoices/${invId}`);
    if (r.ok && r.body.invoice?.customer_id) return r.body.invoice.customer_id;
  }
  return customerIdFor(img);
}

/** The artist as a Zoho vendor (created on first use). */
async function vendorId(): Promise<string> {
  if (cachedVendorId) return cachedVendorId;
  const found = await zoho(`/contacts?contact_name=${encodeURIComponent(VENDOR_NAME)}&contact_type=vendor`);
  if (!found.ok) throw new Error(`Zoho vendor search failed (${found.status}): ${found.body.message}`);
  const match = found.body.contacts?.find((c) => c.contact_name === VENDOR_NAME);
  if (match) return (cachedVendorId = match.contact_id);
  const created = await zoho('/contacts', {
    method: 'POST',
    body: JSON.stringify({ contact_name: VENDOR_NAME, contact_type: 'vendor', notes: 'Artist for Kalai Art House (art.pranixtechno.com).' }),
  });
  if (!created.ok || !created.body.contact) throw new Error(`Zoho vendor create failed (${created.status}): ${created.body.message}`);
  return (cachedVendorId = created.body.contact.contact_id);
}

/** The artist doing this order: Siva (default) or an approved artist from the portal (artistId = their account). */
async function orderVendor(img: Img): Promise<{ id: string; name: string }> {
  const aid = (img?.artistId?.S ?? '').trim();
  if (aid) return sellerVendorId(aid);
  return { id: await vendorId(), name: VENDOR_NAME };
}
const vendorName = (img: Img) => (img?.artistName?.S ?? '').trim() || VENDOR_NAME;

const str = (img: Img | undefined, k: string) => (img?.[k]?.S ?? '').trim();
/** The order's details as JSON text: saved as a string by the Lambda, but as a DynamoDB map when the website wrote it (AWSJSON). */
const detStr = (img: Img | undefined): string => {
  const a = img?.details as AttributeValue | undefined;
  if (!a) return '';
  if ('S' in a && a.S != null) return a.S.trim();
  try { return JSON.stringify(fromAttr(a)); } catch { return ''; }
};
const num = (img: Img | undefined, k: string) => {
  const v = img?.[k]?.N;
  return v === undefined ? null : Number(v);
};
const amount = (v: unknown) => {
  const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

function parseDetails(raw: string): Record<string, string> {
  if (!raw) return {};
  try {
    let v: unknown = JSON.parse(raw);
    if (typeof v === 'string') v = JSON.parse(v);
    return (v && typeof v === 'object' ? v : {}) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Build the quote fields (item line + notes) from an enquiry record. */
function quoteParts(img: Img) {
  const ref = str(img, 'ref');
  const kind = str(img, 'kind');
  const title = str(img, 'title') || KIND[kind] || 'Website enquiry';
  const details = parseDetails(detStr(img));
  const customerLines = [
    `Website enquiry ${ref} (${KIND[kind] ?? kind})`,
    `Customer: ${str(img, 'customerName')}`,
    `Mobile: ${str(img, 'phone')}`,
    `Email: ${str(img, 'email')}`,
  ];
  const detailLines = Object.entries(details)
    .filter(([k, v]) => v && !['Reference', 'Name', 'Mobile', 'Parent', 'Estimate', 'Total', 'Email', 'Offer', 'Frame tried on the website', 'Message', 'Payment'].includes(k))
    .map(([k, v]) => `${k}: ${v}`);
  // Price enquiries start at 0. Commissions use the website estimate, gifts the total shown.
  const startRate = kind === 'COMMISSION' ? amount(details['Estimate']) : kind === 'GIFT' || kind === 'PHOTO' ? amount(details['Total']) : kind === 'MARKET' || kind === 'LICENCE' ? num(img, 'quotedPrice') ?? 0 : 0;
  return {
    ref,
    name: title.slice(0, 100),
    description: detailLines.join('\n').slice(0, 2000),
    notes: customerLines.join('\n'),
    startRate,
  };
}

// ---------- write Zoho's result back onto the enquiry ----------

// Every write-back gets a strictly increasing zohoAt, so our own writes are always recognised as ours.
let lastWriteTs = 0;

async function writeBack(id: string, set: Record<string, string | number | null>) {
  const table = process.env.ENQUIRY_TABLE;
  if (!table || !id) return;
  lastWriteTs = Math.max(Date.now(), lastWriteTs + 1);
  const at = new Date(lastWriteTs).toISOString();
  const fields = { ...set, zohoAt: at, updatedAt: at };
  const sets: string[] = [];
  const removes: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, AttributeValue> = {};
  Object.entries(fields).forEach(([k, v], i) => {
    names[`#f${i}`] = k;
    if (v === null || v === '') removes.push(`#f${i}`);
    else {
      sets.push(`#f${i} = :v${i}`);
      values[`:v${i}`] = typeof v === 'number' ? { N: String(v) } : { S: v };
    }
  });
  const expr = [sets.length ? `SET ${sets.join(', ')}` : '', removes.length ? `REMOVE ${removes.join(', ')}` : ''].join(' ').trim();
  try {
    await ddb.send(
      new UpdateItemCommand({
        TableName: table,
        Key: { id: { S: id } },
        UpdateExpression: expr,
        ExpressionAttributeNames: names,
        ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
        ConditionExpression: 'attribute_exists(id)',
      }),
    );
  } catch (err) {
    console.warn(`Could not write Zoho result back to enquiry ${id}:`, err);
  }
}

// ---------- quotes ----------

/** The price line for Zoho: the full (list) price with the discount in Zoho's Discount column, and why, so the quote
 *  and invoice show "AED 1,000 − 500 discount = 500" instead of only 500. */
function priceLine(img: Img, price: number) {
  const list = num(img, 'listPrice') ?? 0;
  const off = list > price ? r2(list - price) : 0;
  if (!off) return { rate: price, discount: undefined as number | undefined, header: {}, why: '' };
  const parts: string[] = [];
  const code = str(img, 'discountCode'), note = str(img, 'discountNote'), pts = num(img, 'loyaltyRedeemed') ?? 0;
  const dAmt = num(img, 'discountAmount') ?? 0, lAmt = num(img, 'loyaltyAmount') ?? 0;
  if (code && dAmt) parts.push(`code ${code} AED ${dAmt.toLocaleString('en-US')}`);
  else if (dAmt) parts.push(`${note || 'discount'} AED ${dAmt.toLocaleString('en-US')}`);
  if (pts && lAmt) parts.push(`${pts} Kalai Circle points AED ${lAmt.toLocaleString('en-US')}`);
  return { rate: list, discount: off, header: { discount_type: 'item_level', is_discount_before_tax: true }, why: `Discount: ${parts.join(' + ') || `AED ${off}`}` };
}

async function createQuote(img: Img, rate?: number) {
  const q = quoteParts(img);
  const start = rate ?? (num(img, 'quotedPrice') && ['RECEIVED', 'PRICE_SENT'].includes(str(img, 'status') || 'RECEIVED') && num(img, 'listPrice') ? num(img, 'quotedPrice')! : q.startRate);
  const pl = priceLine(img, start);
  const customerId = await customerIdFor(img);
  const vat = await vatFields();
  const doc = (await numberSeries()).docs.qt;
  const own = doc.source === 'internal';
  const qn = own ? seriesNo(doc, await nextSeriesNumber(doc.mode === 'numeric' ? '' : doc.prefix, '/estimates', 'estimates', 'estimate_number')) : '';
  const r = await zoho(own ? '/estimates?ignore_auto_number_generation=true' : '/estimates', {
    method: 'POST',
    body: JSON.stringify({
      customer_id: customerId,
      ...(own ? { estimate_number: qn } : {}),
      reference_number: q.ref,
      ...vat.header,
      ...pl.header,
      line_items: [{ name: q.name, description: [q.description, pl.why].filter(Boolean).join('\n').slice(0, 2000), rate: pl.rate, quantity: 1, ...(pl.discount ? { discount: pl.discount } : {}), ...(vat.taxId ? { tax_id: vat.taxId } : {}) }],
      notes: q.notes,
    }),
  });
  if (!r.ok || !r.body.estimate) throw new Error(`Zoho quote create failed (${r.status}): ${r.body.message}`);
  console.log(`Created Zoho quote ${r.body.estimate.estimate_number} for ${q.ref}`);
  return { id: r.body.estimate.estimate_id, number: r.body.estimate.estimate_number };
}

/** Find the quote created for this website reference (KA-…). */
async function findQuote(ref: string) {
  const r = await zoho(`/estimates?reference_number=${encodeURIComponent(ref)}`);
  if (!r.ok) throw new Error(`Zoho quote search failed (${r.status}): ${r.body.message}`);
  const match = (r.body.estimates ?? []).find((e) => (e.reference_number ?? '').trim() === ref);
  return match ? { id: match.estimate_id, number: match.estimate_number, status: match.status ?? '' } : null;
}

/** Set the price on the quote's first line; add the studio message to the notes. */
async function updateQuotePrice(img: Img, price: number) {
  const q = quoteParts(img);
  const found = await findQuote(q.ref);
  if (!found) return createQuote(img, price); // enquiry from before the sync existed
  const got = await zoho(`/estimates/${found.id}`);
  if (!got.ok || !got.body.estimate) throw new Error(`Zoho quote read failed (${got.status}): ${got.body.message}`);
  const est = got.body.estimate;
  const vat = await vatFields();
  const tax = vat.taxId ? { tax_id: vat.taxId } : {};
  const pl = priceLine(img, price);
  const lines: LineItem[] = (est.line_items ?? []).map((li, i) => ({
    line_item_id: li.line_item_id,
    name: li.name,
    description: i === 0 ? [q.description, pl.why].filter(Boolean).join('\n').slice(0, 2000) : li.description,
    quantity: li.quantity ?? 1,
    rate: i === 0 ? pl.rate : li.rate,
    ...(i === 0 && pl.discount ? { discount: pl.discount } : i === 0 ? { discount: 0 } : {}),
    ...tax,
  }));
  if (!lines.length) lines.push({ name: q.name, description: [q.description, pl.why].filter(Boolean).join('\n'), quantity: 1, rate: pl.rate, ...(pl.discount ? { discount: pl.discount } : {}), ...tax });
  const msg = str(img, 'adminMessage');
  const notes = msg ? `${q.notes}\nStudio message: ${msg}` : q.notes;
  const r = await zoho(`/estimates/${found.id}`, {
    method: 'PUT',
    body: JSON.stringify({ customer_id: est.customer_id, reference_number: q.ref, ...vat.header, discount_type: 'item_level', is_discount_before_tax: true, line_items: lines, notes }),
  });
  if (!r.ok) throw new Error(`Zoho quote update failed (${r.status}): ${r.body.message}`);
  console.log(`Updated Zoho quote ${est.estimate_number} for ${q.ref} to AED ${price}`);
  return { id: found.id, number: est.estimate_number };
}

/** Draft → sent → accepted (Zoho only accepts a quote that has been sent). No email goes out. */
async function acceptQuote(quoteId: string, ref: string) {
  const sent = await zoho(`/estimates/${quoteId}/status/sent`, { method: 'POST' });
  if (!sent.ok) console.warn(`Quote for ${ref} not marked sent: ${sent.body.message}`);
  const acc = await zoho(`/estimates/${quoteId}/status/accepted`, { method: 'POST' });
  if (!acc.ok) console.warn(`Quote for ${ref} not marked accepted: ${acc.body.message}`);
}

// ---------- invoices and payments ----------

const PAY_MODE: Record<string, string> = { ZIINA: 'creditcard', CARD: 'creditcard', BANK: 'banktransfer', CASH: 'cash', OTHER: 'others' };
const PAY_LABEL: Record<string, string> = { ZIINA: 'Ziina', CARD: 'Card', BANK: 'Bank transfer', CASH: 'Cash', OTHER: 'Other' };
const dubaiToday = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);

/** The live (not void) invoice for this website reference, if any. */
async function findInvoice(ref: string) {
  const r = await zoho(`/invoices?reference_number=${encodeURIComponent(ref)}`);
  if (!r.ok) throw new Error(`Zoho invoice search failed (${r.status}): ${r.body.message}`);
  return (r.body.invoices ?? []).find((i) => (i.reference_number ?? '').trim() === ref && i.status !== 'void') ?? null;
}

/** Next number in the Kalai series: KAH-INV-0001, KAH-INV-0002 … */
async function nextInvoiceNumber(doc: SeriesDoc): Promise<number> {
  const pre = doc.mode === 'numeric' ? '' : doc.prefix;
  const r = await zoho(`/invoices?${pre ? `invoice_number_startswith=${encodeURIComponent(pre)}&` : ''}per_page=200&filter_by=Status.All`);
  if (!r.ok) throw new Error(`Zoho invoice numbering failed (${r.status}): ${r.body.message}`);
  let max = 0;
  for (const i of r.body.invoices ?? []) {
    if (!i.invoice_number.startsWith(pre)) continue;
    const rest = i.invoice_number.slice(pre.length);
    if (!/^\d+$/.test(rest)) continue;
    const n = Number(rest);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/** Next number in a Kalai series (KAH-CN-…) from the documents that exist in Zoho, in any status. */
async function nextSeriesNumber(prefix: string, listPath: string, listKey: string, numberKey: string): Promise<number> {
  const r = await zoho(`${listPath}?per_page=200&filter_by=Status.All&search_text=${encodeURIComponent(prefix)}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (r.ok ? ((r.body as any)[listKey] ?? []) : []) as Record<string, string>[];
  let max = 0;
  for (const d of rows) {
    const num = String(d[numberKey] ?? '');
    if (!num.startsWith(prefix)) continue;
    const rest = num.slice(prefix.length);
    if (!/^\d+$/.test(rest)) continue;
    const n = Number(rest);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * Test mode: keep a just-created document out of the accounts. Draft if Zoho allows it, otherwise void
 * (a void document has no effect and can be deleted). Returns the state it was left in.
 */
async function keepAsDraft(path: string, status?: string): Promise<'draft' | 'void'> {
  if (status === 'draft') return 'draft';
  const d = await zoho(`${path}/status/draft`, { method: 'POST' });
  if (d.ok) return 'draft';
  const v = await zoho(`${path}/status/void`, { method: 'POST' });
  if (v.ok) {
    // Zoho lets a voided credit note (and sometimes a bill) be turned into a draft: try, so it reads as a draft.
    const d2 = await zoho(`${path}/status/draft`, { method: 'POST' });
    return d2.ok ? 'draft' : 'void';
  }
  throw new Error(`Test mode: ${path.split('/')[1]} was created in Zoho but could not be set to draft or void (${v.body.message ?? d.body.message}). Void or delete it in Zoho by hand. If the message is about permission, add the UPDATE scope for it to the Zoho token.`);
}

async function createInvoice(img: Img, price: number) {
  const q = quoteParts(img);
  const pl = priceLine(img, price);
  const customerId = await customerIdFor(img);
  const vat = await vatFields();
  const doc = (await numberSeries()).docs.inv;
  const own = doc.source === 'internal';
  let n = own ? await nextInvoiceNumber(doc) : 0;
  for (let attempt = 0; attempt < 4; attempt++, n++) {
    const number = seriesNo(doc, n);
    const r = await zoho(own ? '/invoices?ignore_auto_number_generation=true' : '/invoices', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: customerId,
        ...(own ? { invoice_number: number } : {}),
        reference_number: q.ref,
        date: dubaiToday(),
        ...vat.header,
        ...pl.header,
        line_items: [{ name: q.name, description: [q.description, pl.why].filter(Boolean).join('\n').slice(0, 2000), rate: pl.rate, quantity: 1, ...(pl.discount ? { discount: pl.discount } : {}), ...(vat.taxId ? { tax_id: vat.taxId } : {}) }],
        notes: q.notes,
      }),
    });
    if (r.ok && r.body.invoice) {
      console.log(`Created Zoho invoice ${r.body.invoice.invoice_number} for ${q.ref}`);
      return { id: r.body.invoice.invoice_id, number: r.body.invoice.invoice_number };
    }
    // Number taken (another invoice raced us): try the next one.
    if (!own || !/already|exist|duplicate/i.test(r.body.message ?? '')) {
      throw new Error(`Zoho invoice create failed (${r.status}): ${r.body.message}`);
    }
  }
  throw new Error('Zoho invoice create failed: could not find a free invoice number');
}

async function invoicePayments(invoiceId: string) {
  const r = await zoho(`/invoices/${invoiceId}/payments`);
  return r.ok ? r.body.payments ?? [] : [];
}

/** Status set to Paid: quote → invoice (once), quote accepted, payment recorded (once). */
async function invoiceAndRecordPayment(img: Img) {
  const q = quoteParts(img);
  const price = num(img, 'quotedPrice') ?? 0;
  if (!(price > 0)) throw new Error('No price set, so no invoice was created');
  const method = str(img, 'paymentMethod') || 'OTHER';
  const payRef = str(img, 'paymentRef');

  const quote = (await findQuote(q.ref)) ?? (await createQuote(img, price));

  const existing = await findInvoice(q.ref);
  const inv = existing ? { id: existing.invoice_id, number: existing.invoice_number } : await createInvoice(img, price);
  if (await testMode()) {
    console.log(`TEST MODE: draft invoice ${inv.number} for ${q.ref}; nothing posted`);
    return { quote: quote?.number ?? '', invoiceId: inv.id, invoice: inv.number, paymentId: '', total: price, test: true };
  }
  if (!existing) {
    // A draft invoice can't take a payment: mark it as sent (no email goes to anyone).
    const sent = await zoho(`/invoices/${inv.id}/status/sent`, { method: 'POST' });
    if (!sent.ok) console.warn(`Could not mark invoice ${inv.number} as sent: ${sent.body.message}`);
  }
  if (quote?.id) await acceptQuote(quote.id, q.ref);

  const fresh = await zoho(`/invoices/${inv.id}`);
  if (!fresh.ok || !fresh.body.invoice) throw new Error(`Zoho invoice read failed (${fresh.status}): ${fresh.body.message}`);
  const total = Number(fresh.body.invoice.total ?? price);
  const balance = Number(fresh.body.invoice.balance ?? 0);
  if (fresh.body.invoice.status === 'paid' || balance <= 0) {
    const pays = await invoicePayments(inv.id);
    console.log(`Invoice ${inv.number} for ${q.ref} already paid; no payment recorded`);
    return { quote: quote?.number ?? '', invoiceId: inv.id, invoice: inv.number, paymentId: pays[0]?.payment_id ?? 'paid', total };
  }
  const customerId = fresh.body.invoice.customer_id || await customerIdFor(img);
  const pay = await zoho('/customerpayments', {
    method: 'POST',
    body: JSON.stringify({
      customer_id: customerId,
      payment_mode: PAY_MODE[method] ?? 'others',
      amount: balance,
      date: dubaiToday(),
      reference_number: payRef || q.ref,
      description: `${q.ref} paid by ${PAY_LABEL[method] ?? method}${payRef ? ` (ref ${payRef})` : ''}`,
      invoices: [{ invoice_id: inv.id, amount_applied: balance }],
    }),
  });
  if (!pay.ok || !pay.body.payment) throw new Error(`Invoice ${inv.number} created, but the payment could not be recorded: ${pay.body.message}`);
  console.log(`Recorded AED ${balance} payment on ${inv.number} for ${q.ref}`);
  return { quote: quote?.number ?? '', invoiceId: inv.id, invoice: inv.number, paymentId: pay.body.payment.payment_id, total };
}

const paidMessage = (r: { invoice: string; total: number }, img: Img) => {
  const method = str(img, 'paymentMethod');
  const ref = str(img, 'paymentRef');
  return `Invoice ${r.invoice} · payment of AED ${r.total.toLocaleString('en-US')} recorded${method ? ` (${PAY_LABEL[method] ?? method}${ref ? ` ${ref}` : ''})` : ''}`;
};

// ---------- purchase side: PO → bill → vendor payment ----------

type Costs = { artistInr?: number; fx?: number; artistAed?: number; indiaCourier?: number; readyBy?: string };

async function getCosting(enquiryId: string): Promise<{ img: Img | null; costs: Costs }> {
  const table = process.env.COSTING_TABLE;
  if (!table || !enquiryId) return { img: null, costs: {} };
  const r = await ddb.send(new GetItemCommand({ TableName: table, Key: { enquiryId: { S: enquiryId } } }));
  const img = (r.Item as Img | undefined) ?? null;
  let costs: Costs = {};
  const raw = img?.costs as AttributeValue | undefined;
  try {
    // AWSJSON may be stored as text (S) or as a DynamoDB map (M).
    let v: unknown = raw && 'M' in raw && raw.M ? fromAttr(raw) : JSON.parse(str(img ?? undefined, 'costs') || '{}');
    if (typeof v === 'string') v = JSON.parse(v);
    costs = (v ?? {}) as Costs;
  } catch {
    costs = {};
  }
  // Fall back to the INR price on the record if the cost snapshot has no AED amount yet.
  if (!(Number(costs.artistAed) > 0)) {
    const inr = num(img ?? undefined, 'artistPriceInr');
    if (inr && Number(costs.fx) > 0) costs.artistAed = inr * Number(costs.fx);
  }
  return { img, costs };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Plain value from a DynamoDB attribute (S, N, BOOL, NULL, M, L). */
function fromAttr(a: AttributeValue): unknown {
  if ('S' in a && a.S !== undefined) return a.S;
  if ('N' in a && a.N !== undefined) return Number(a.N);
  if ('BOOL' in a && a.BOOL !== undefined) return a.BOOL;
  if ('NULL' in a && a.NULL) return null;
  if ('M' in a && a.M) return Object.fromEntries(Object.entries(a.M).map(([k, v]) => [k, fromAttr(v)]));
  if ('L' in a && a.L) return a.L.map(fromAttr);
  return undefined;
}

/** Lines owed to Siva for this order, from the saved costing: his price + the India courier he paid. */
async function artistLines(img: Img) {
  const ref = str(img, 'ref');
  const { img: cimg, costs } = await getCosting(str(img, 'id'));
  // Customer cancelled after Siva started (50% refund): Siva is paid 50% of his price, plus the India courier only if he had sent it.
  const half = str(img, 'refundAction') === 'CANCEL_HALF';
  const artistAed = round2(Number(costs.artistAed ?? 0) * (half ? 0.5 : 1));
  const courier = half && !str(img, 'artistShippedAt') ? 0 : round2(Number(costs.indiaCourier ?? 0));
  const inr = Number(costs.artistInr ?? num(cimg ?? undefined, 'artistPriceInr') ?? 0);
  const q = quoteParts(img);
  const lines: LineItem[] = [];
  if (artistAed > 0) {
    lines.push({
      name: q.name,
      description: `${half ? '50% for work done (customer cancelled) · ' : ''}Artwork for ${ref}${inr ? ` · artist price INR ${inr.toLocaleString('en-IN')} @ ${costs.fx ?? ''} AED/INR` : ''}`,
      rate: artistAed,
      quantity: 1,
    });
  }
  if (artistAed > 0 && courier > 0) lines.push({ name: 'Courier India → UAE (reimbursement)', description: `Shipping for ${ref}`, rate: courier, quantity: 1 });
  return { lines, total: round2(artistAed + (artistAed > 0 ? courier : 0)) };
}

/** Customer paid: Siva's order is recorded on the enquiry (no Zoho document; this plan has no purchase orders). */
async function recordArtistOrder(img: Img) {
  const { lines, total } = await artistLines(img);
  if (!lines.length) {
    const { img: cimg, costs } = await getCosting(str(img, 'id'));
    console.log(`No artist price for ${str(img, 'ref')}: costing ${cimg ? 'found' : 'missing'}, costs type ${cimg?.costs ? Object.keys(cimg.costs)[0] : 'none'}, keys ${Object.keys(costs).join(',')}`);
    return null; // no artist price yet
  }
  return { id: 'ORDER', number: `Order ${str(img, 'ref')}`, total };
}

/** Expense account for Siva's bills: SSM /kalai/zoho/artist_account_id if set, else "Cost of Goods Sold" if readable. */
let cachedAccountAt = 0;
let cachedAccount: string | null | undefined;
async function artistAccountId(): Promise<string | null> {
  // Re-read every 10 minutes, and never remember "not set": saving the SSM parameter takes effect without a redeploy.
  if (cachedAccount && Date.now() - cachedAccountAt < 600_000) return cachedAccount;
  let id: string | null = null;
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: '/kalai/zoho/artist_account_id' }));
    id = (r.Parameter?.Value ?? '').trim() || null;
  } catch {
    id = null;
  }
  if (!id) {
    // Only an account clearly meant for artworks; never another business line's cost account.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (await zoho('/chartofaccounts?filter_by=AccountType.CostOfGoodsSold')).body as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acc = (r.chartofaccounts ?? []).find((a: any) => /artwork|kalai/i.test(a.account_name));
    id = acc?.account_id ?? null;
  }
  if (id) { cachedAccount = id; cachedAccountAt = Date.now(); }
  return id;
}

/** Siva's invoice arrived: a bill with his invoice number, from the costing. */
async function createArtistBill(img: Img) {
  const ref = str(img, 'ref');
  const { lines } = await artistLines(img);
  if (!lines.length) throw new Error('No artist price in the costing, so no bill was created');
  const account = await artistAccountId();
  const r = await zoho('/bills', {
    method: 'POST',
    body: JSON.stringify({
      vendor_id: (await orderVendor(img)).id,
      bill_number: str(img, 'artistInvoiceNo'),
      reference_number: ref,
      date: dubaiToday(),
      line_items: lines.map((l) => ({ ...l, ...(account ? { account_id: account } : {}) })),
      notes: `Kalai Art House order ${ref}.`,
    }),
  });
  if (!r.ok || !r.body.bill) {
    const hint = /account/i.test(r.body.message ?? '')
      ? ' Set the expense account: copy its ID from Zoho (Accountant → Chart of Accounts → the account, number at the end of the address) and save it as SSM parameter /kalai/zoho/artist_account_id.'
      : '';
    throw new Error(`Zoho bill failed (${r.status}): ${r.body.message}.${hint}`);
  }
  console.log(`Created bill ${r.body.bill.bill_number} for ${ref}`);
  return { id: r.body.bill.bill_id, number: r.body.bill.bill_number, total: Number(r.body.bill.total ?? 0), status: r.body.bill.status };
}

/** Siva paid: vendor payment against the bill. */
async function payVendor(img: Img) {
  const ref = str(img, 'ref');
  const billId = str(img, 'zohoBillId');
  const got = await zoho(`/bills/${billId}`);
  if (!got.ok || !got.body.bill) throw new Error(`Zoho bill read failed (${got.status}): ${got.body.message}`);
  const balance = Number(got.body.bill.balance ?? 0);
  if (balance <= 0 || got.body.bill.status === 'paid') return { id: 'paid', amount: 0 };
  const payRef = str(img, 'artistPaidRef');
  const r = await zoho('/vendorpayments', {
    method: 'POST',
    body: JSON.stringify({
      vendor_id: (await orderVendor(img)).id,
      payment_mode: 'banktransfer',
      amount: balance,
      date: dubaiToday(),
      reference_number: payRef,
      description: `Payment to ${vendorName(img)} for ${ref}`,
      bills: [{ bill_id: billId, amount_applied: balance }],
    }),
  });
  if (!r.ok || !r.body.vendorpayment) throw new Error(`Zoho vendor payment failed (${r.status}): ${r.body.message}`);
  console.log(`Recorded AED ${balance} payment to ${vendorName(img)} for ${ref}`);
  return { id: r.body.vendorpayment.payment_id, amount: balance };
}

/** Run whichever purchase step is due. Never throws: problems go to purchaseMessage. */
async function purchaseSteps(start: Img) {
  if (str(start, 'kind') === 'MARKET') { await marketSteps(start); return; }
  let img: Img = { ...start };
  const id = str(img, 'id');
  const testing = str(img, 'zohoState') === 'TEST' && !!str(img, 'zohoInvoiceId');
  if ((!str(img, 'zohoPaymentId') && !testing) || ['GIFT', 'PHOTO', 'LICENCE'].includes(str(img, 'kind')) || str(img, 'purchaseState') === 'CANCELLED' || str(img, 'refundAction') === 'CANCEL_FULL') return;
  try {
    if (!str(img, 'zohoPOId')) {
      const po = await recordArtistOrder(img);
      if (!po) {
        if (str(img, 'purchaseState') !== 'NEEDS_PRICE' || /PO for Siva/.test(str(img, 'purchaseMessage'))) {
          await writeBack(id, { purchaseState: 'NEEDS_PRICE', purchaseMessage: "No artist price in the costing yet, so Siva's order isn't recorded. Add it and save." });
        }
        return;
      }
      await writeBack(id, {
        purchaseState: 'ORDERED',
        zohoPO: po.number,
        zohoPOId: po.id,
        purchaseMessage: `${po.number}: ${vendorName(img)} · AED ${po.total.toLocaleString('en-US')} owed when the artist's invoice arrives (price fixed)`,
      });
      img = { ...img, zohoPO: { S: po.number }, zohoPOId: { S: po.id } };
    }
    if (testing) {
      // Test mode: Siva's bill as a draft (on his invoice number); the payment to him is never recorded.
      if (str(img, 'artistInvoiceNo') && !str(img, 'zohoBillId')) {
        const bill = await createArtistBill(img);
        const state = await keepAsDraft(`/bills/${bill.id}`, bill.status);
        await writeBack(id, {
          purchaseState: 'BILLED', zohoBill: bill.number, zohoBillId: bill.id,
          purchaseMessage: `Test mode: ${state === 'draft' ? 'draft' : 'void (test)'} bill ${bill.number} from ${vendorName(img)} · AED ${bill.total.toLocaleString('en-US')}. Payment to the artist is not recorded while testing.`,
        });
        return;
      }
      if (str(img, 'artistPaidRef') && str(img, 'zohoBillId') && !/payment not recorded/i.test(str(img, 'purchaseMessage'))) {
        await writeBack(id, { purchaseMessage: `Test mode: test bill ${str(img, 'zohoBill')} · payment not recorded while testing (ref ${str(img, 'artistPaidRef')}).` });
      }
      return;
    }
    if (str(img, 'artistInvoiceNo') && !str(img, 'zohoBillId')) {
      const bill = await createArtistBill(img);
      await writeBack(id, {
        purchaseState: 'BILLED',
        zohoBill: bill.number,
        zohoBillId: bill.id,
        purchaseMessage: `Bill ${bill.number} from ${vendorName(img)} · AED ${bill.total.toLocaleString('en-US')} to pay`,
      });
      img = { ...img, zohoBill: { S: bill.number }, zohoBillId: { S: bill.id } };
    }
    if (str(img, 'artistPaidRef') && str(img, 'zohoBillId') && !str(img, 'zohoVendorPaymentId')) {
      const pay = await payVendor(img);
      await writeBack(id, {
        purchaseState: 'ARTIST_PAID',
        zohoVendorPaymentId: pay.id,
        purchaseMessage: `${vendorName(img)} paid${pay.amount ? ` AED ${pay.amount.toLocaleString('en-US')}` : ''} (ref ${str(img, 'artistPaidRef')}) against bill ${str(img, 'zohoBill')}`,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Purchase step failed for ${str(img, 'ref')}:`, err);
    await writeBack(id, { purchaseState: 'ERROR', purchaseMessage: msg.slice(0, 500) });
  }
}

// ---------- delivery challan: Shipped → challan, Delivered → marked delivered ----------

type ChallanBody = { deliverychallan?: { deliverychallan_id: string; deliverychallan_number: string; status?: string } };

function challanNotes(img: Img) {
  const q = quoteParts(img);
  return [
    `Kalai Art House order ${q.ref}${str(img, 'zohoInvoice') ? ` · invoice ${str(img, 'zohoInvoice')}` : ''}`,
    `Courier: ${str(img, 'courierName') || '-'} · AWB / tracking: ${str(img, 'trackingNo') || '-'}`,
    str(img, 'deliveryAddress')
      ? `Deliver to: ${str(img, 'deliveryName') || str(img, 'customerName')} · ${str(img, 'deliveryPhone') || str(img, 'phone')}\n${addressText(img)}`
      : `Deliver to: ${str(img, 'customerName')} · ${str(img, 'phone')}`,
  ].join('\n');
}

/** Courier or AWB changed after the challan was made: rewrite its notes in Zoho. */
async function updateChallanNotes(img: Img) {
  const challanId = str(img, 'zohoChallanId');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const got = (await zoho(`/deliverychallans/${challanId}`)).body as any;
  const dc = got.deliverychallan;
  if (!dc) throw new Error(`Challan ${str(img, 'zohoChallan')} could not be read from Zoho`);
  const r = await zoho(`/deliverychallans/${challanId}`, {
    method: 'PUT',
    body: JSON.stringify({
      customer_id: dc.customer_id,
      reference_number: dc.reference_number,
      date: dc.date,
      ...(dc.challan_type ? { challan_type: dc.challan_type } : {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      line_items: (dc.line_items ?? []).map((li: any) => ({ line_item_id: li.line_item_id, name: li.name, description: li.description, rate: li.rate, quantity: li.quantity })),
      notes: challanNotes(img),
    }),
  });
  if (!r.ok) throw new Error(`Challan ${str(img, 'zohoChallan')} courier/AWB not updated: ${r.body.message}`);
  console.log(`Updated courier/AWB on challan ${str(img, 'zohoChallan')} for ${str(img, 'ref')}`);
}

async function createChallan(img: Img) {
  const q = quoteParts(img);
  const price = num(img, 'quotedPrice') ?? 0;
  const notes = challanNotes(img);
  const body: Record<string, unknown> = {
    customer_id: await invoiceCustomerId(img),
    reference_number: q.ref,
    date: dubaiToday(),
    challan_type: 'others',
    line_items: [{ name: q.name, description: q.description, rate: price, quantity: 1 }],
    notes,
  };
  const doc = (await numberSeries()).docs.dc;
  const own = doc.source === 'internal';
  if (own) body.deliverychallan_number = seriesNo(doc, await nextSeriesNumber(doc.mode === 'numeric' ? '' : doc.prefix, '/deliverychallans', 'deliverychallans', 'deliverychallan_number'));
  const dcPath = own ? '/deliverychallans?ignore_auto_number_generation=true' : '/deliverychallans';
  let r = await zoho(dcPath, { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok && /challan_type/i.test(r.body.message ?? '')) {
    delete body.challan_type; // not used in every edition
    r = await zoho(dcPath, { method: 'POST', body: JSON.stringify(body) });
  }
  const dc = (r.body as ChallanBody).deliverychallan;
  if (!r.ok || !dc) throw new Error(`Zoho delivery challan failed (${r.status}): ${r.body.message}`);
  console.log(`Created delivery challan ${dc.deliverychallan_number} for ${q.ref}`);
  return { id: dc.deliverychallan_id, number: dc.deliverychallan_number };
}

/** Never throws: problems go to deliveryMessage. */
async function deliverySteps(img: Img, old?: Img) {
  const id = str(img, 'id');
  const status = str(img, 'status');
  if (!['SHIPPED', 'DELIVERED'].includes(status) || !str(img, 'zohoInvoiceId')) return;
  const testing = await testMode();
  const courierLine = `${str(img, 'courierName') || 'courier'}${str(img, 'trackingNo') ? ` · AWB ${str(img, 'trackingNo')}` : ''}`;
  try {
    let challanId = str(img, 'zohoChallanId');
    let challanNo = str(img, 'zohoChallan');
    // Update the challan whenever its courier/AWB (as last recorded in deliveryMessage) differ from the order.
    const courierChanged =
      (!!old && (str(old, 'courierName') !== str(img, 'courierName') || str(old, 'trackingNo') !== str(img, 'trackingNo'))) ||
      (!!str(img, 'courierName') && !str(img, 'deliveryMessage').includes(courierLine));
    if (challanId && courierChanged) {
      await updateChallanNotes(img);
      await writeBack(id, {
        deliveryMessage: `${testing ? 'Test mode: draft ' : ''}delivery challan ${challanNo} · ${status === 'DELIVERED' && str(img, 'deliveryState') === 'DELIVERED' ? 'delivered' : 'shipped'} with ${courierLine} (courier/AWB updated in Zoho)`,
      });
    }
    if (!challanId) {
      const dc = await createChallan(img);
      challanId = dc.id;
      challanNo = dc.number;
      if (!testing) {
        const open = await zoho(`/deliverychallans/${dc.id}/status/open`, { method: 'POST' });
        if (!open.ok) console.warn(`Challan ${dc.number} not marked open: ${open.body.message}`);
      }
      await writeBack(id, {
        zohoChallan: challanNo,
        zohoChallanId: challanId,
        deliveryState: testing ? 'DRAFT' : 'OPEN',
        deliveryMessage: `${testing ? 'Test mode: draft ' : ''}delivery challan ${challanNo} · shipped with ${courierLine}`,
      });
    }
    if (status === 'DELIVERED' && str(img, 'deliveryState') !== 'DELIVERED') {
      if (testing) {
        if (/not marked delivered/.test(str(img, 'deliveryMessage'))) return;
        await writeBack(id, { deliveryState: 'DRAFT', deliveryMessage: `Test mode: draft delivery challan ${challanNo} (not marked delivered while testing) · ${courierLine}` });
        return;
      }
      const d = await zoho(`/deliverychallans/${challanId}/status/delivered`, { method: 'POST' });
      if (!d.ok) throw new Error(`Challan ${challanNo} not marked delivered: ${d.body.message}`);
      await writeBack(id, { deliveryState: 'DELIVERED', deliveryMessage: `Delivery challan ${challanNo} delivered · ${courierLine}` });
      console.log(`Challan ${challanNo} for ${str(img, 'ref')} marked delivered`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Delivery step failed for ${str(img, 'ref')}:`, err);
    await writeBack(id, { deliveryState: 'ERROR', deliveryMessage: msg.slice(0, 500) });
  }
}

// ---------- after-sales: cancellations, damage, replacement ----------
// Policy: no change-of-mind returns; cancel before Siva starts = full refund; after he starts = 50% refund;
// damaged in transit = customer chooses full refund or replacement/repair.

const AFTER_LABEL: Record<string, string> = {
  CANCEL_FULL: 'Cancelled before work started: full refund',
  CANCEL_HALF: 'Cancelled after work started: 50% refund',
  DAMAGED_REFUND: 'Damaged in transit: full refund',
  DAMAGED_REPLACE: 'Damaged in transit: replacement / repair',
};
const AFTER_DONE = ['DONE', 'TEST', 'REPLACEMENT'];

async function optionalParam(name: string): Promise<string | null> {
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: name }));
    return (r.Parameter?.Value ?? '').trim() || null;
  } catch {
    return null;
  }
}

/** Credit note for the refunded amount, linked to the invoice, then the refund to the customer. */
async function creditNoteAndRefund(img: Img, amount: number) {
  const q = quoteParts(img);
  const action = str(img, 'refundAction');
  // A retry after a failed refund: reuse the credit note already created, don't make a second one.
  const existingId = str(img, 'zohoCreditNoteId');
  if (existingId) return refundCreditNote(img, amount, { creditnote_id: existingId, creditnote_number: str(img, 'zohoCreditNote') });
  const vat = await vatFields();
  const body: Record<string, unknown> = {
    customer_id: await invoiceCustomerId(img),
    reference_number: q.ref,
    date: dubaiToday(),
    invoice_id: str(img, 'zohoInvoiceId'),
    ...vat.header,
    line_items: [{ name: `Refund: ${q.name}`, description: AFTER_LABEL[action] ?? action, rate: amount, quantity: 1, ...(vat.taxId ? { tax_id: vat.taxId } : {}) }],
    notes: [`${AFTER_LABEL[action] ?? action} · order ${q.ref} · invoice ${str(img, 'zohoInvoice')}`, str(img, 'refundNote')].filter(Boolean).join('\n'),
  };
  const cn = await postCreditNote(body);
  console.log(`Created credit note ${cn.creditnote_number} for ${q.ref} (AED ${amount})`);
  return refundCreditNote(img, amount, cn);
}

/** Credit note in Kalai's own series (KAH-CN-0001…). Retries the next number if one is taken. */
async function postCreditNote(body: Record<string, unknown>) {
  const doc = (await numberSeries()).docs.cn;
  const own = doc.source === 'internal';
  const path = own ? '/creditnotes?ignore_auto_number_generation=true' : '/creditnotes';
  let n = own ? await nextSeriesNumber(doc.mode === 'numeric' ? '' : doc.prefix, '/creditnotes', 'creditnotes', 'creditnote_number') : 0;
  for (let attempt = 0; attempt < 4; attempt++, n++) {
    const b = { ...body, ...(own ? { creditnote_number: seriesNo(doc, n) } : {}) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let r = await zoho(path, { method: 'POST', body: JSON.stringify(b) }) as any;
    // Not allowed against this invoice (e.g. a draft invoice in test mode): create it without the link.
    if (!r.ok && /invoice/i.test(r.body.message ?? '') && (b as Record<string, unknown>).invoice_id) {
      delete (b as Record<string, unknown>).invoice_id;
      r = await zoho(path, { method: 'POST', body: JSON.stringify(b) });
    }
    if (r.ok && r.body.creditnote) return r.body.creditnote as { creditnote_id: string; creditnote_number: string; status?: string };
    if (!own || !/already|exist|duplicate/i.test(r.body.message ?? '')) throw new Error(`Zoho credit note failed (${r.status}): ${r.body.message}`);
  }
  throw new Error('Zoho credit note failed: could not find a free credit note number');
}

/** Test mode: the credit note only, kept as a draft (no refund, nothing posted). */
async function draftCreditNote(img: Img, amount: number) {
  const q = quoteParts(img);
  const action = str(img, 'refundAction');
  if (str(img, 'zohoCreditNoteId')) return { number: str(img, 'zohoCreditNote'), id: str(img, 'zohoCreditNoteId'), state: 'draft' as const };
  const vat = await vatFields();
  const cn = await postCreditNote({
    customer_id: await invoiceCustomerId(img), reference_number: q.ref, date: dubaiToday(), invoice_id: str(img, 'zohoInvoiceId'), ...vat.header,
    line_items: [{ name: `Refund: ${q.name}`, description: AFTER_LABEL[action] ?? action, rate: amount, quantity: 1, ...(vat.taxId ? { tax_id: vat.taxId } : {}) }],
    notes: [`TEST · ${AFTER_LABEL[action] ?? action} · order ${q.ref}`, str(img, 'refundNote')].filter(Boolean).join('\n'),
  });
  const state = await keepAsDraft(`/creditnotes/${cn.creditnote_id}`, cn.status);
  return { number: cn.creditnote_number, id: cn.creditnote_id, state };
}

async function refundCreditNote(img: Img, amount: number, cn: { creditnote_id: string; creditnote_number: string }) {
  const q = quoteParts(img);

  const method = str(img, 'refundMethod') || str(img, 'paymentMethod') || 'OTHER';
  const fromAccount = await optionalParam('/kalai/zoho/refund_account_id');
  const ref = str(img, 'refundRef');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rf = await zoho(`/creditnotes/${cn.creditnote_id}/refunds`, {
    method: 'POST',
    body: JSON.stringify({
      date: dubaiToday(),
      refund_mode: PAY_MODE[method] ?? 'others',
      amount,
      reference_number: ref || q.ref,
      description: `Refund for ${q.ref}${ref ? ` (ref ${ref})` : ''}`,
      ...(fromAccount ? { from_account_id: fromAccount } : {}),
    }),
  }) as any;
  if (!rf.ok) {
    const hint = /account/i.test(rf.body.message ?? '')
      ? ' Set the account refunds are paid from: copy its ID from Zoho (Banking → the account, number at the end of the address) and save it as SSM parameter /kalai/zoho/refund_account_id.'
      : '';
    return { creditNote: cn.creditnote_number as string, creditNoteId: cn.creditnote_id as string, refundId: '', refundError: `${rf.body.message}.${hint}` };
  }
  const refundId = rf.body.creditnote_refund?.creditnote_refund_id ?? rf.body.refund?.refund_id ?? 'refunded';
  console.log(`Recorded refund AED ${amount} on ${cn.creditnote_number} for ${q.ref}`);
  return { creditNote: cn.creditnote_number as string, creditNoteId: cn.creditnote_id as string, refundId: String(refundId), refundError: '' };
}

/** Never throws: problems go to refundMessage. Runs once per action (re-runs after an error on the next save). */
async function afterSales(img: Img) {
  const id = str(img, 'id');
  const action = str(img, 'refundAction');
  // Test mode whose draft credit note failed (e.g. missing Zoho permission): try again on the next save of the order.
  const retryTestNote = str(img, 'refundState') === 'TEST' && !str(img, 'zohoCreditNoteId') && /Credit note not created|Credit note and refund of .* not posted/.test(str(img, 'refundMessage')) && action !== 'DAMAGED_REPLACE';
  if (!action || (AFTER_DONE.includes(str(img, 'refundState')) && !retryTestNote)) return;
  const testing = await testMode();
  const amount = round2(Number(num(img, 'refundAmount') ?? 0));
  const label = AFTER_LABEL[action] ?? action;
  try {
    // Damaged: the delivery challan goes back as "returned" (live), and the order can ship again.
    if (action.startsWith('DAMAGED') && str(img, 'zohoChallanId') && !testing) {
      const ret = await zoho(`/deliverychallans/${str(img, 'zohoChallanId')}/status/returned`, { method: 'POST' });
      if (!ret.ok) console.warn(`Challan ${str(img, 'zohoChallan')} not marked returned: ${ret.body.message}`);
    }
    if (action === 'DAMAGED_REPLACE') {
      await writeBack(id, {
        refundState: 'REPLACEMENT',
        prevChallans: [str(img, 'prevChallans'), str(img, 'zohoChallanId')].filter(Boolean).join(',') || null,
        refundMessage: `${label}. ${testing ? 'Test mode: challan not marked returned. ' : str(img, 'zohoChallan') ? `Challan ${str(img, 'zohoChallan')} marked returned. ` : ''}Set Shipped again with the new courier and AWB to create a new delivery challan.`,
        zohoChallan: null,
        zohoChallanId: null,
        deliveryState: null,
        deliveryMessage: str(img, 'zohoChallan') ? `Previous challan ${str(img, 'zohoChallan')} returned (damaged). Waiting for the replacement to ship.` : null,
        courierName: null,
        trackingNo: null,
      });
      return;
    }

    // Siva: a cancellation before he started cancels his order (if no bill yet).
    const sivaCancelled = action === 'CANCEL_FULL' && !['GIFT', 'PHOTO'].includes(str(img, 'kind')) && !str(img, 'zohoBillId');
    const sivaNote =
      action === 'CANCEL_FULL'
        ? sivaCancelled ? " Siva's order cancelled (nothing owed)." : " Siva's bill already exists: agree with him what is owed."
        : ['GIFT', 'PHOTO'].includes(str(img, 'kind')) ? '' : action === 'CANCEL_HALF' ? " Siva's order stopped: he is paid 50% of his price (his invoice no. → bill)." : ' Siva had started / finished: pay him as agreed.';

    if (!(amount > 0)) throw new Error('Enter the refund amount.');
    if (testing) {
      let cnText = 'Credit note not created';
      let cnSet: Record<string, string> = {};
      try {
        const d = await draftCreditNote(img, amount);
        cnText = `${d.state === 'draft' ? 'Draft' : 'Void (test)'} credit note ${d.number}`;
        cnSet = { zohoCreditNote: d.number, zohoCreditNoteId: d.id };
      } catch (e) {
        cnText = `Credit note not created (${e instanceof Error ? e.message : String(e)})`.slice(0, 300);
      }
      await writeBack(id, {
        refundState: 'TEST',
        ...cnSet,
        refundMessage: `Test mode: ${label}. ${cnText} · AED ${amount.toLocaleString('en-US')}; refund not recorded.${sivaNote}`,
        ...(sivaCancelled ? { purchaseState: 'CANCELLED', purchaseMessage: 'Order cancelled: customer cancelled before work started.' } : {}),
      });
      return;
    }
    if (!str(img, 'zohoInvoiceId')) throw new Error('No invoice in Zoho for this order, so nothing to refund. Use status Cancelled instead.');
    const r = await creditNoteAndRefund(img, amount);
    await writeBack(id, {
      refundState: r.refundError ? 'ERROR' : 'DONE',
      zohoCreditNote: r.creditNote,
      zohoCreditNoteId: r.creditNoteId,
      zohoRefundId: r.refundId || null,
      refundMessage: r.refundError
        ? `Credit note ${r.creditNote} created, but the refund could not be recorded: ${r.refundError}`
        : `${label}. Credit note ${r.creditNote} · refund AED ${amount.toLocaleString('en-US')} recorded.${sivaNote}`,
      ...(sivaCancelled ? { purchaseState: 'CANCELLED', purchaseMessage: 'Order cancelled: customer cancelled before work started.' } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`After-sales step failed for ${str(img, 'ref')}:`, err);
    await writeBack(id, { refundState: 'ERROR', refundMessage: msg.slice(0, 500) });
  }
}

/** Cancelled before payment: decline the quote (live only). */
async function declineQuote(img: Img) {
  if (await testMode()) return;
  const quote = await findQuote(str(img, 'ref'));
  if (!quote || ['declined', 'invoiced'].includes(quote.status)) return;
  if (quote.status === 'draft') await zoho(`/estimates/${quote.id}/status/sent`, { method: 'POST' });
  const d = await zoho(`/estimates/${quote.id}/status/declined`, { method: 'POST' });
  if (!d.ok) console.warn(`Quote ${quote.number} not marked declined: ${d.body.message}`);
  else await writeBack(str(img, 'id'), { zohoMessage: `Quote ${quote.number} marked declined (order cancelled)` });
}

// ---------- Artist desk (Siva): no customer details, no selling price ----------

// Never shown to artists: who the customer is, and what the customer pays (price, offer, payment, discount).
const PRIVATE_KEY = /name|mobile|phone|whats|email|address|parent|contact|reference|deliver|to$|gift for|price|offer|payment|discount|total|instal/i;

async function scanAll(table: string) {
  const items: Img[] = [];
  let start: Record<string, AttributeValue> | undefined;
  do {
    const r = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: start }));
    items.push(...((r.Items ?? []) as Img[]));
    start = r.LastEvaluatedKey;
  } while (start);
  return items;
}

async function costingFor(ids: string[]) {
  const table = process.env.COSTING_TABLE;
  const out = new Map<string, Img>();
  if (!table) return out;
  for (let i = 0; i < ids.length; i += 100) {
    const keys = ids.slice(i, i + 100).map((id) => ({ enquiryId: { S: id } }));
    if (!keys.length) continue;
    const r = await ddb.send(new BatchGetItemCommand({ RequestItems: { [table]: { Keys: keys } } }));
    for (const it of (r.Responses?.[table] ?? []) as Img[]) out.set(str(it, 'enquiryId'), it);
  }
  return out;
}

/** Customer cancelled after Siva started (50% refund): his order stops, he is still paid for the work done. */
const sivaStopped = (e: Img) => str(e, 'refundAction').startsWith('CANCEL') && ['REFUNDED', 'CANCELLED'].includes(str(e, 'status')) && str(e, 'purchaseState') !== 'CANCELLED' && !!str(e, 'zohoPOId');

function artistStage(e: Img, c: Img | undefined) {
  if (str(e, 'purchaseState') === 'CANCELLED') return { stage: 'CLOSED', label: 'Order cancelled by the customer' };
  if (str(e, 'zohoVendorPaymentId')) return { stage: 'PAID', label: `Paid to you${str(e, 'artistPaidRef') ? ` · ref ${str(e, 'artistPaidRef')}` : ''}` };
  if (str(e, 'zohoBillId')) return { stage: 'INVOICED', label: `Your invoice ${str(e, 'artistInvoiceNo')} received · payment pending` };
  if (sivaStopped(e)) {
    const inr = num(c, 'artistPriceInr');
    return { stage: 'ORDERED', label: `Customer cancelled · please stop · invoice 50% of your price${inr ? ` (INR ${(inr / 2).toLocaleString('en-IN')})` : ''}` };
  }
  const rw = str(e, 'reworkType').startsWith('SIVA') ? str(e, 'reworkStage') : null;
  if (rw !== null && rw !== 'READY' && str(e, 'reworkType') === 'SIVA_REPAIR' && !str(e, 'sivaReceivedAt')) {
    return { stage: 'ORDERED', label: str(e, 'toSivaSentAt') ? 'Damaged piece on its way to you · tap Received when it arrives' : 'Repair needed · the damaged piece will be sent to you' };
  }
  if (rw !== null && rw !== 'READY') {
    return { stage: 'ORDERED', label: rw === 'SENT' ? 'Rework sent to frame shop · send your rework invoice' : rw === 'FINISHED' ? 'Rework finished · send it to the frame shop' : rw === 'STARTED' ? 'Rework in progress' : 'Rework needed (damaged in transit) · give your rework price' };
  }
  if (str(e, 'zohoPOId') && str(e, 'cancelState') === 'REQUESTED' && str(e, 'cancelRequest') === 'CANCEL') {
    return { stage: 'ORDERED', label: 'On hold · the customer asked to cancel · please wait' };
  }
  if (str(e, 'zohoPOId')) {
    const p = str(e, 'artistStage');
    const label = p === 'SHIPPED' ? 'Sent to frame shop · send your invoice' : p === 'FINISHED' ? 'Finished · send it to the frame shop' : p === 'STARTED' ? 'In progress' : 'Ordered · price fixed · tap Started when you begin';
    return { stage: 'ORDERED', label };
  }
  const status = str(e, 'status') || 'RECEIVED';
  if (status === 'CANCELLED') return { stage: 'CLOSED', label: 'Not going ahead' };
  if (num(c, 'artistPriceInr') || num(c, 'artistPriceAed')) return { stage: 'PRICED', label: PAID_LIKE.includes(status) ? 'Customer paid · order coming' : 'Price given · waiting for customer' };
  return { stage: 'NEEDED', label: 'Price needed' };
}

async function artistList(admin = false) {
  const table = process.env.ENQUIRY_TABLE;
  if (!table) throw new Error('ENQUIRY_TABLE is not configured');
  // Siva's desk: orders not allocated to another artist.
  const enquiries = (await scanAll(table)).filter((e) => ['PRICE', 'COMMISSION'].includes(str(e, 'kind')) && !str(e, 'artistId'));
  // Collection orders already have his price (My works & prices): fill it in where it is still missing, so only
  // commissions wait for a price on his desk.
  const open = enquiries.filter((e) => str(e, 'kind') === 'PRICE' && !str(e, 'zohoPOId'));
  if (open.length) {
    const cost = await costingFor(open.map((e) => str(e, 'id')));
    for (const e of open) {
      const c = cost.get(str(e, 'id'));
      if (num(c, 'artistPriceInr') == null && num(c, 'artistPriceAed') == null) await useCataloguePrice(str(e, 'id'), e).catch(() => {});
    }
  }
  await catchUpArtistStatus(enquiries);
  return artistRows(enquiries, admin);
}

/** A collection order: the artist's price for that work (ArtworkPrice, from "My works & prices") becomes the order's artist price. */
async function useCataloguePrice(id: string, e: Img) {
  const PT = process.env.PRODUCT_TABLE, AT = process.env.ARTPRICE_TABLE;
  if (!PT || !AT) return false;
  const det = parseDetails(detStr(e));
  const no = String(det['Artwork no.'] ?? '').trim();
  const all = await scanAll(PT);
  // Older orders have no "Artwork no." (KA-261022-65CF): find the work by its title, when exactly one work has it.
  const name = String(det.Artwork ?? str(e, 'title') ?? '').replace(/^(Price enquiry( \(offer\))?|Artwork order): /i, '').replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
  const byTitle = name ? all.filter((x) => String(str(x, 'title') || '').trim().toLowerCase() === name) : [];
  const pr = no ? all.find((x) => str(x, 'code') === no) : byTitle.length === 1 ? byTitle[0] : undefined;
  if (!pr) return false;
  const ap = await getRow(AT, { productId: { S: str(pr, 'id') } });
  let price = num(ap, 'artistPrice');
  let cur: 'AED' | 'INR' = str(ap, 'currency') === 'AED' ? 'AED' : 'INR';
  // A portal artist's work: their price is on their listing (what they receive) when the price table has none yet.
  if (!price && str(pr, 'listingId')) {
    const { L } = mtables();
    const l = plain(await getRow(L, { id: { S: str(pr, 'listingId') } }));
    price = Number(l?.sellerPrice ?? l?.costPrice ?? 0) || null;
    cur = 'AED';
    if (price) await putRow(AT, { ...(plain(ap) ?? {}), productId: str(pr, 'id'), __typename: 'ArtworkPrice', createdAt: str(ap, 'createdAt') || new Date().toISOString(), updatedAt: new Date().toISOString(), artistPrice: price, currency: 'AED', artistPriceAt: new Date().toISOString(), artistNote: 'From the artist portal (what the artist receives)' }).catch(() => {});
  }
  if (!price) return false;
  await artistQuote({ id, priceInr: price, note: str(pr, 'artistId') ? 'Catalogue price from the artist portal' : 'Catalogue price (My works & prices)' } as ApiEvent['arguments'], `${str(pr, 'artist') || 'Siva Raja'} · catalogue price`, cur);
  return true;
}

async function artistRows(enquiries: Img[], admin = false) {
  const costing = await costingFor(enquiries.map((e) => str(e, 'id')));
  // The catalogue work's picture (by its artwork no.), so the artist sees which drawing it is.
  const pics = new Map<string, string>();
  if (process.env.PRODUCT_TABLE && enquiries.some((e) => str(e, 'kind') === 'PRICE')) {
    for (const p of await scanAll(process.env.PRODUCT_TABLE)) if (str(p, 'code') && str(p, 'imageKey')) pics.set(str(p, 'code'), str(p, 'imageKey'));
  }
  // Where to send the finished work: the frame shop given the framing job, else (when there is only one) our frame shop.
  const shops = new Map<string, Img>();
  if (process.env.SELLER_TABLE) for (const p of await scanAll(process.env.SELLER_TABLE)) if (str(p, 'type') === 'FRAMER' && str(p, 'status') === 'APPROVED') shops.set(str(p, 'id'), p);
  // No framing job yet: the default frame shop (Pricing → Margin & charges), else the only frame shop.
  let defShop: Img | undefined;
  if (process.env.RATES_TABLE) {
    try {
      const row = plain(await getRow(process.env.RATES_TABLE, { key: { S: 'default' } }));
      let rd: unknown = row?.data;
      for (let i = 0; i < 2 && typeof rd === 'string'; i++) rd = JSON.parse(rd);
      const fid = String((rd as { defaults?: { framer?: string } } | undefined)?.defaults?.framer ?? '');
      defShop = fid && fid !== 'cheapest' ? shops.get(fid) : undefined;
    } catch (err) { console.warn('Default frame shop not read', err); }
  }
  const onlyShop = defShop ?? (shops.size === 1 ? [...shops.values()][0] : undefined);
  const shopOf = (c: Img | undefined) => {
    const fj = parseJobs(str(c, 'supplierJobs')).framer;
    // The frame shop on the order page (saved with the costing), else the default / only frame shop.
    let picked: Img | undefined;
    try { let cs: unknown = c?.costs ? fromAttr(c.costs as AttributeValue) : null; for (let i = 0; i < 2 && typeof cs === 'string'; i++) cs = JSON.parse(cs || '{}'); const fid = String((cs as { framerId?: string } | null)?.framerId ?? ''); picked = fid ? shops.get(fid) : undefined; } catch { picked = undefined; }
    const p = (fj?.supplierId && shops.get(fj.supplierId)) || (fj ? undefined : picked ?? onlyShop);
    if (!p) return fj ? { name: fj.name, contact: '', phone: '', address: '', assigned: true } : null;
    return { name: str(p, 'business'), contact: str(p, 'contactName'), phone: str(p, 'phone'),
      address: [str(p, 'address'), str(p, 'city'), str(p, 'emirate'), str(p, 'country') || 'UAE'].filter(Boolean).join(', '), assigned: !!fj };
  };
  return enquiries
    .map((e) => {
      const c = costing.get(str(e, 'id'));
      const brief = Object.entries(parseDetails(detStr(e)))
        .filter(([k, v]) => v && !PRIVATE_KEY.test(k))
        .map(([k, v]) => ({ k, v: String(v).slice(0, 500) }));
      return {
        id: str(e, 'id'),
        ref: str(e, 'ref'),
        kind: str(e, 'kind'),
        title: str(e, 'title'),
        createdAt: str(e, 'createdAt'),
        customerCode: str(e, 'customerCode'), // a code only: artists never see who the customer is
        customerName: admin ? str(e, 'customerName') : '',
        brief,
        hasPhoto: str(e, 'kind') === 'COMMISSION' && !!str(e, 'fileKey'),
        imageKey: str(e, 'kind') === 'PRICE' ? pics.get(String(parseDetails(detStr(e))['Artwork no.'] ?? '').trim()) ?? '' : '',
        artistPriceInr: num(c, 'artistPriceInr'),
        artistPriceAed: num(c, 'artistPriceAed'),
        artistReadyBy: str(c, 'artistReadyBy'),
        artistNote: str(c, 'artistNote'),
        studioNote: str(c, 'studioNote'), // Kalai Art House → artist
        studioNoteAt: str(c, 'studioNoteAt'),
        locked: !!str(e, 'zohoPOId'),
        ordered: !!str(e, 'zohoPOId') && str(e, 'purchaseState') !== 'CANCELLED',
        stopped: sivaStopped(e),
        progress: str(e, 'artistStage'),
        startedAt: str(e, 'artistStartedAt'),
        finishedAt: str(e, 'artistFinishedAt'),
        shippedAt: str(e, 'artistShippedAt'),
        artistCourier: str(e, 'artistCourier'),
        artistAwb: str(e, 'artistAwb'),
        progressBy: str(e, 'artistBy'),
        invoiceNo: str(e, 'artistInvoiceNo'),
        invoiceAt: str(e, 'artistInvoiceAt'),
        hasBill: !!str(e, 'zohoBillId'),
        hasPO: !!str(e, 'zohoPOId'),
        onHold: str(e, 'cancelState') === 'REQUESTED' && str(e, 'cancelRequest') === 'CANCEL',
        rework: reworkForArtist(e, c),
        frameShop: shopOf(c),
        // The courier Kalai allocated for this parcel and its airway bill (label to print once finished).
        inbound: (() => { const ib = parseJobs(str(c, 'supplierJobs')).inbound; return ib ? { courier: ib.name, awb: ib.awb ?? '', label: ['FINISHED', 'SHIPPED'].includes(str(e, 'artistStage')) } : null; })(),
        orderStatus: str(e, 'status'), // the customer's order (e.g. DELIVERED), for the artist's Status filter
        priceBy: str(c, 'artistBy'),
        ...artistStage(e, c),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function artistQuote(args: ApiEvent['arguments'], by = 'Siva', currency: 'INR' | 'AED' = 'INR') {
  const id = args.id ?? '';
  const enquiryTable = process.env.ENQUIRY_TABLE;
  const costingTable = process.env.COSTING_TABLE;
  if (!enquiryTable || !costingTable) throw new Error('Tables are not configured');
  const got = await ddb.send(new GetItemCommand({ TableName: enquiryTable, Key: { id: { S: id } } }));
  const e = got.Item as Img | undefined;
  if (!e || !['PRICE', 'COMMISSION'].includes(str(e, 'kind'))) throw new Error('Enquiry not found');
  if (str(e, 'zohoPOId')) throw new Error('Already ordered: the price can no longer change. Contact Kalai Art House.');
  const price = Number(args.priceInr);
  if (!(price > 0) || price > 10_000_000) throw new Error(`Enter your price in ${currency} (a number above 0).`);
  const readyBy = String(args.readyBy ?? '').slice(0, 10);
  const note = String(args.note ?? '').slice(0, 1000);
  const now = new Date().toISOString();
  const values: Record<string, AttributeValue> = {
    ':p': { N: String(price) },
    ':a': { S: now },
    ':c': { S: now },
    ':t': { S: 'Costing' },
  };
  values[':b'] = { S: by };
  const sets = [`${currency === 'AED' ? 'artistPriceAed' : 'artistPriceInr'} = :p`, 'artistAt = :a', 'artistBy = :b', 'updatedAt = :a', 'createdAt = if_not_exists(createdAt, :c)', '#tn = if_not_exists(#tn, :t)'];
  const removes: string[] = [currency === 'AED' ? 'artistPriceInr' : 'artistPriceAed'];
  if (readyBy) { sets.push('artistReadyBy = :r'); values[':r'] = { S: readyBy }; } else removes.push('artistReadyBy');
  if (note) { sets.push('artistNote = :n'); values[':n'] = { S: note }; } else removes.push('artistNote');
  await ddb.send(
    new UpdateItemCommand({
      TableName: costingTable,
      Key: { enquiryId: { S: id } },
      UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
      ExpressionAttributeNames: { '#tn': '__typename' },
      ExpressionAttributeValues: values,
    }),
  );
  console.log(`Artist price ${currency} ${price} saved for ${str(e, 'ref')}`);
  // Tell the studio: the costing on the order now has the artist's price; next is "Use this price" → send it to the customer.
  if (!by.startsWith('Kalai Art House') && !note.startsWith('Catalogue price')) await sendMail({ to: STUDIO_EMAIL, subject: `Price from ${by}: ${str(e, 'ref')} · ${currency} ${price}`,
    lines: [`${h(by)} gave their price for <b>${h(str(e, 'title'))}</b> (${h(str(e, 'ref'))}): <b>${currency} ${price.toLocaleString('en-US')}</b>${readyBy ? `, ready by ${h(readyBy)}` : ''}.`,
      ...(note ? [`Their note: ${h(note)}`] : []),
      'It is already in the order\'s Costing. Next: check the costing, press <b>Use this price</b> and Save to send the price and payment link to the customer.'],
    button: { label: 'Open the order', url: `${SITE}/admin.html#order=${id}` }, footer: 'Studio notification from art.pranixtechno.com' }).catch(() => {});
  return { ok: true, ref: str(e, 'ref'), currency, artistPriceInr: currency === 'INR' ? price : null, artistPriceAed: currency === 'AED' ? price : null, artistReadyBy: readyBy, artistNote: note };
}

/** Who made an Artist desk change: Siva (ARTISTS) or the studio (ADMINS), for the audit trail. */
function actor(ev: ApiEvent): string {
  const groups = ev.identity?.groups ?? (ev.identity?.claims?.['cognito:groups'] as string[] | undefined) ?? [];
  const email = String(ev.identity?.claims?.email ?? ev.identity?.username ?? '');
  if (groups.includes('ADMINS')) return `Kalai Art House${email ? ` (${email})` : ''}`;
  return 'Siva';
}

/** Siva reports progress on an ordered work: STARTED → FINISHED → SHIPPED (to the frame shop). */
const PROGRESS = ['STARTED', 'FINISHED', 'SHIPPED'];
async function artistProgress(args: ApiEvent['arguments'], by = 'Siva') {
  const table = process.env.ENQUIRY_TABLE;
  if (!table) throw new Error('ENQUIRY_TABLE is not configured');
  const id = args.id ?? '';
  const step = String(args.step ?? '').toUpperCase();
  if (!PROGRESS.includes(step) && step !== 'LABEL') throw new Error('Unknown step');
  const got = await ddb.send(new GetItemCommand({ TableName: table, Key: { id: { S: id } } }));
  const e = got.Item as Img | undefined;
  if (!e || !['PRICE', 'COMMISSION'].includes(str(e, 'kind'))) throw new Error('Order not found');
  const ajobs = await jobsOf(id);
  // The airway bill label for the artist's parcel (drawn in the portal with a barcode or QR code).
  if (step === 'LABEL') {
    if (!ajobs.inbound) throw new Error('Kalai Art House has not allocated the courier for this parcel yet.');
    if (!['FINISHED', 'SHIPPED'].includes(str(e, 'artistStage'))) throw new Error('Mark the work finished first: the airway bill is made then.');
    if (await ensureArtistAwb(e, ajobs)) await saveJobs(id, ajobs);
    if (!ajobs.inbound.awb) throw new Error('The courier gives the airway bill number for this parcel: it shows here once they have it.');
    return { label: await artistLabel(e, ajobs) };
  }
  if (str(e, 'purchaseState') === 'CANCELLED') throw new Error('This order was cancelled by the customer.');
  if (sivaStopped(e)) throw new Error('The customer cancelled this order: please stop. Send your invoice for the work done.');
  if (str(e, 'cancelState') === 'REQUESTED' && str(e, 'cancelRequest') === 'CANCEL') throw new Error('On hold: the customer asked to cancel. Please wait for Kalai Art House before continuing.');
  if (!str(e, 'zohoPOId')) throw new Error('Not ordered yet: wait until the customer has paid and the order is placed.');
  const current = PROGRESS.indexOf(str(e, 'artistStage'));
  const target = PROGRESS.indexOf(step);
  if (target < current) throw new Error(`Already marked ${str(e, 'artistStage').toLowerCase()}.`);
  // Artists in the UAE usually hand the work over (or the frame shop collects it): courier and AWB optional.
  const local = !!str(e, 'artistId') && (str(e, 'artistCountry') || 'UAE') === 'UAE';
  // Kalai allocated the courier and made the airway bill: that is the courier and AWB.
  const ib = ajobs.inbound?.awb ? ajobs.inbound : null;
  const courier = (ib && !by.startsWith('Kalai Art House') ? ib.name : '') || String(args.courier ?? '').trim().slice(0, 60) || (ib ? ib.name : '') || (local && step === 'SHIPPED' ? 'Handed over' : '');
  const awb = (ib && !by.startsWith('Kalai Art House') ? ib.awb! : '') || String(args.awb ?? '').trim().slice(0, 60) || (ib ? ib.awb! : '') || (local && step === 'SHIPPED' ? '–' : '');
  if (step === 'SHIPPED' && (!courier || !awb)) throw new Error('Enter the courier and the AWB / tracking number.');
  // Once sent, the courier and AWB are fixed for Siva; only Kalai Art House can correct them.
  if (step === 'SHIPPED' && str(e, 'artistStage') === 'SHIPPED' && !by.startsWith('Kalai Art House')) throw new Error('Already sent: the courier and AWB can only be corrected by Kalai Art House.');
  const now = new Date().toISOString();
  const set: Record<string, string> = { artistStage: PROGRESS[Math.max(target, current)], artistBy: by, updatedAt: now };
  // Earlier steps are filled in too if skipped (e.g. "Finished" without "Started").
  if (!str(e, 'artistStartedAt')) set.artistStartedAt = now;
  if (target >= 1 && !str(e, 'artistFinishedAt')) set.artistFinishedAt = now;
  if (target >= 2) {
    if (!str(e, 'artistShippedAt')) set.artistShippedAt = now;
    set.artistCourier = courier;
    set.artistAwb = awb;
  }
  const names: Record<string, string> = {};
  const values: Record<string, AttributeValue> = {};
  const parts = Object.entries(set).map(([k, v], i) => { names[`#p${i}`] = k; values[`:p${i}`] = { S: v }; return `#p${i} = :p${i}`; });
  await ddb.send(new UpdateItemCommand({ TableName: table, Key: { id: { S: id } }, UpdateExpression: `SET ${parts.join(', ')}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
  console.log(`Artist progress ${set.artistStage} for ${str(e, 'ref')}`);
  if (set.artistStage === 'FINISHED' && ajobs.inbound && !ajobs.inbound.awb) {
    try { if (await ensureArtistAwb({ ...e, artistStage: { S: 'FINISHED' } }, ajobs)) await saveJobs(id, ajobs); } catch (err) { console.warn('Artist AWB not made', err); }
  }
  // Sent to the frame shop and the frame shop has already accepted the job: the order is now "Being framed".
  // The order's status follows the artist: Started → Artist working, Finished → Artist finished, sent with an AWB →
  // Sent by artist (or straight to Being framed when the frame shop has already accepted the job). Only forward.
  await followArtist(e, PROGRESS[Math.max(target, current)]);
  // Just sent: tell the frame shop that has the job that the artwork is on its way (courier and AWB).
  if (target >= 2 && current < 2) {
    try {
      const fj = (await jobsOf(id)).framer;
      const fp = fj ? plain(await getRow(mtables().S, { id: { S: fj.supplierId } })) : null;
      if (fp?.email) await sendMail({ to: String(fp.email), subject: `Artwork on its way to you: ${str(e, 'ref')}`, lines: [`Hello ${h(fp.contactName || fp.business)},`, `The artist has sent <b>${h(str(e, 'title'))}</b> (order ${h(str(e, 'ref'))}) to you for framing: <b>${h(courier)}</b>, AWB / tracking <b>${h(awb)}</b>.`, 'When it arrives, check it against the photo in your portal before you cut anything, then frame it and tap <b>Framed, ready for pickup</b>.'], button: { label: 'Open my jobs', url: `${SITE}/supplier.html#jobs` } });
    } catch (err) { console.warn('Frame shop not told about the artwork', err); }
  }
  return { ok: true, ref: str(e, 'ref'), ...set };
}
/** The order's status follows the artist's step (paid orders only, forward only). Also catches up older orders. */
async function followArtist(e: Img, stage: string) {
  const target = PROGRESS.indexOf(stage);
  if (target < 0 || !PAID_LIKE.includes(str(e, 'status')) || sivaStopped(e)) return;
  const id = str(e, 'id');
  const fj = target >= 2 ? (await jobsOf(id)).framer : undefined;
  const next = target >= 2 ? (fj && ['ACCEPTED', 'READY', 'COLLECTED'].includes(String(fj.stage)) ? 'FRAMING' : 'ARTIST_SENT') : target === 1 ? 'ARTIST_DONE' : 'ARTIST_WORKING';
  if (STATUS_RANK.indexOf(next) > STATUS_RANK.indexOf(str(e, 'status'))) await updateEnquiry(id, { status: next }).catch((err) => console.warn(`Status not moved to ${next}`, err));
}
/** Older orders: bring the status up to the artist's step (once; later steps move it as they happen). */
async function catchUpArtistStatus(list: Img[]) {
  for (const e of list) if (str(e, 'artistStage') && PAID_LIKE.includes(str(e, 'status'))) await followArtist(e, str(e, 'artistStage')).catch(() => {});
}

async function artistPhoto(id: string) {
  const table = process.env.ENQUIRY_TABLE;
  const bucket = process.env.UPLOADS_BUCKET;
  if (!table || !bucket) throw new Error('Not configured');
  const got = await ddb.send(new GetItemCommand({ TableName: table, Key: { id: { S: id } } }));
  const e = got.Item as Img | undefined;
  let key = str(e, 'fileKey');
  // A collection order: the catalogue work's picture (signed here, so it opens whatever folder it is in).
  if (e && str(e, 'kind') === 'PRICE' && process.env.PRODUCT_TABLE) {
    const no = String(parseDetails(detStr(e))['Artwork no.'] ?? '').trim();
    const pr = no ? (await scanAll(process.env.PRODUCT_TABLE)).find((x) => str(x, 'code') === no) : undefined;
    key = str(pr, 'imageKey');
    if (!key) throw new Error('No picture for this work');
    return { url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 3600 }) };
  }
  if (!e || str(e, 'kind') !== 'COMMISSION' || !key.startsWith('uploads/')) throw new Error('No reference photo for this enquiry');
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 900 });
  return { url };
}

// ---------- "Check Zoho" from the Studio desk ----------

// ---------- all Zoho documents for one order (shown on the Studio desk) ----------

const BOOKS_APP = `https://books.zoho.com/app/${env.ZOHO_ORG_ID}#`;
type Doc = { group: 'SALES' | 'PURCHASE' | 'DELIVERY'; type: string; id: string; number: string; status: string; date?: string; total?: number; balance?: number; url: string; vendor?: string; amount?: number; shared?: boolean };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function zget(path: string): Promise<any> {
  const r = await zoho(path);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return r.ok ? (r.body as any) : {};
}

async function collectDocs(ref: string, prevChallans: string[] = []): Promise<Doc[]> {
  const q = encodeURIComponent(ref);
  const rw = encodeURIComponent(`${ref}-RW`);
  const [est, inv, bill, rwBill, dcs, cns, shared] = await Promise.all([
    zget(`/estimates?reference_number=${q}`),
    zget(`/invoices?reference_number=${q}&filter_by=Status.All`),
    zget(`/bills?reference_number=${q}`),
    zget(`/bills?reference_number=${rw}`),
    zget(`/deliverychallans?reference_number=${q}&filter_by=Status.All`),
    zget(`/creditnotes?reference_number=${q}`),
    // Vendor bills (frame shop, courier, customs) whose Reference# mentions this order, also bills for several orders.
    zget(`/bills?reference_number_contains=${q}`),
  ]);
  const seen = new Set((bill.bills ?? []).map((b: { bill_id: string }) => b.bill_id));
  const extra = (shared.bills ?? []).filter((b: { bill_id: string; reference_number?: string }) => !seen.has(b.bill_id) && String(b.reference_number ?? '').includes(ref) && !String(b.reference_number ?? '').includes(`${ref}-RW`));
  // Siva's rework bill carries "<ref>-RW".
  bill.bills = [...(bill.bills ?? []), ...(rwBill.bills ?? []).map((b: { reference_number?: string }) => ({ ...b, reference_number: ref, rework: true }))];
  // Challans of earlier deliveries (a damaged one before a replacement) are read by id, in case the list leaves them out.
  const listed = new Set((dcs.deliverychallans ?? []).map((c: { deliverychallan_id: string }) => c.deliverychallan_id));
  for (const id of prevChallans.filter((x) => x && !listed.has(x))) {
    const one = await zget(`/deliverychallans/${id}`);
    if (one.deliverychallan) (dcs.deliverychallans ??= []).push({ ...one.deliverychallan, reference_number: ref });
  }
  const same = (x: { reference_number?: string }) => (x.reference_number ?? '').trim() === ref;
  const docs: Doc[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const e of (est.estimates ?? []).filter(same) as any[]) {
    docs.push({ group: 'SALES', type: 'Quote', id: e.estimate_id, number: e.estimate_number, status: e.status, date: e.date, total: e.total, url: `${BOOKS_APP}/quotes/${e.estimate_id}` });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const i of (inv.invoices ?? []).filter(same) as any[]) {
    docs.push({ group: 'SALES', type: 'Invoice', id: i.invoice_id, number: i.invoice_number, status: i.status, date: i.date, total: i.total, balance: i.balance, url: `${BOOKS_APP}/invoices/${i.invoice_id}` });
    if (['draft', 'void'].includes(i.status)) continue;
    const pays = await zget(`/invoices/${i.invoice_id}/payments`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const p of (pays.payments ?? []) as any[]) {
      docs.push({ group: 'SALES', type: 'Payment received', id: p.payment_id, number: p.payment_number || p.reference_number || '', status: p.payment_mode || 'recorded', date: p.date, total: p.amount, url: `${BOOKS_APP}/paymentsreceived/${p.payment_id}` });
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const b of (bill.bills ?? []).filter(same) as any[]) {
    docs.push({ group: 'PURCHASE', type: b.rework ? 'Bill (rework)' : 'Bill', id: b.bill_id, number: b.bill_number, status: b.status, date: b.date, total: b.total, balance: b.balance, url: `${BOOKS_APP}/bills/${b.bill_id}`, vendor: b.vendor_name, amount: b.total });
    if (['draft', 'void'].includes(b.status)) continue;
    const pays = await zget(`/bills/${b.bill_id}/payments`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const p of (pays.payments ?? []) as any[]) {
      docs.push({ group: 'PURCHASE', type: 'Payment made', id: p.payment_id, number: p.payment_number || p.reference_number || '', status: p.payment_mode || 'recorded', date: p.date, total: p.amount, url: `${BOOKS_APP}/paymentsmade/${p.payment_id}` });
    }
  }
  // A bill for several orders ("KA-…, KA-…" in Reference#): this order's lines (description mentions the ref),
  // else the bill split equally between the orders named.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const b of extra as any[]) {
    let amount = Number(b.total || 0);
    const refs = String(b.reference_number ?? '').match(/KA-\d{6}-[A-Z0-9]{3,6}/g) ?? [ref];
    try {
      const one = await zget(`/bills/${b.bill_id}`);
      const lines = (one.bill?.line_items ?? []) as { description?: string; name?: string; item_total?: number }[];
      const mine = lines.filter((l) => `${l.description ?? ''} ${l.name ?? ''}`.includes(ref));
      amount = mine.length ? mine.reduce((t, l) => t + Number(l.item_total || 0), 0) : Number(b.total || 0) / Math.max(1, new Set(refs).size);
    } catch { amount = Number(b.total || 0) / Math.max(1, new Set(refs).size); }
    docs.push({ group: 'PURCHASE', type: 'Vendor bill', id: b.bill_id, number: b.bill_number, status: b.status, date: b.date, total: b.total, balance: b.balance, url: `${BOOKS_APP}/bills/${b.bill_id}`, vendor: b.vendor_name, amount: Math.round(amount * 100) / 100, shared: true });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of (cns.creditnotes ?? []).filter(same) as any[]) {
    docs.push({ group: 'SALES', type: 'Credit note', id: c.creditnote_id, number: c.creditnote_number, status: c.status, date: c.date, total: c.total, balance: c.balance, url: `${BOOKS_APP}/creditnotes/${c.creditnote_id}` });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of (dcs.deliverychallans ?? []).filter(same) as any[]) {
    docs.push({ group: 'DELIVERY', type: prevChallans.includes(c.deliverychallan_id) ? 'Delivery challan (damaged delivery)' : 'Delivery challan', id: c.deliverychallan_id, number: c.deliverychallan_number, status: c.status, date: c.date, total: c.total, url: `${BOOKS_APP}/deliverychallans/${c.deliverychallan_id}` });
  }
  return docs;
}

/** Keep the document list on the admin-only Costing record (customers never see it). */
async function saveDocs(enquiryId: string, docs: Doc[]) {
  const table = process.env.COSTING_TABLE;
  if (!table) return;
  const now = new Date().toISOString();
  await ddb.send(
    new UpdateItemCommand({
      TableName: table,
      Key: { enquiryId: { S: enquiryId } },
      UpdateExpression: 'SET zohoDocs = :d, docsAt = :n, updatedAt = :n, createdAt = if_not_exists(createdAt, :n), #tn = if_not_exists(#tn, :t)',
      ExpressionAttributeNames: { '#tn': '__typename' },
      ExpressionAttributeValues: { ':d': { S: JSON.stringify({ checkedAt: now, docs }) }, ':n': { S: now }, ':t': { S: 'Costing' } },
    }),
  );
}

async function checkZoho(id: string) {
  const result = await reconcileZoho(id);
  const table = process.env.ENQUIRY_TABLE;
  const got = table ? await ddb.send(new GetItemCommand({ TableName: table, Key: { id: { S: id } } })) : null;
  const img = got?.Item as Img | undefined;
  if (!img) return result;
  try {
    const docs = await collectDocs(str(img, 'ref'), str(img, 'prevChallans').split(',').map((x) => x.trim()).filter(Boolean));
    await saveDocs(id, docs);
    // Backfill the purchase links if the documents exist in Zoho but the enquiry doesn't know them yet.
    // The artist's bill (vendor bills for the frame shop or courier can carry the same Reference#).
    const who = (str(img, 'artistName') || 'Siva').split(/\s+/)[0].toLowerCase();
    const bills = docs.filter((d) => d.type === 'Bill' && d.status !== 'void');
    const sj = await jobsOf(id).catch(() => ({} as Jobs));
    const supplierBills = new Set([sj.framer?.billId, sj.delivery?.billId, sj.printer?.billId].filter(Boolean));
    const artistBills = ['PRICE', 'COMMISSION'].includes(str(img, 'kind')) ? bills.filter((d) => !supplierBills.has(d.id)) : [];
    const bill = artistBills.find((d) => String(d.vendor ?? '').toLowerCase().includes(who)) ?? (artistBills.length === 1 ? artistBills[0] : undefined);
    const fill: Record<string, string | null> = {};
    if (bill && !str(img, 'zohoBillId')) Object.assign(fill, { zohoBill: bill.number, zohoBillId: bill.id });
    const dc = docs.find((d) => d.type === 'Delivery challan');
    if (dc && !str(img, 'zohoChallanId')) Object.assign(fill, { zohoChallan: dc.number, zohoChallanId: dc.id });
    if (dc && str(img, 'zohoChallanId') === dc.id && dc.status === 'delivered' && str(img, 'deliveryState') !== 'DELIVERED') fill.deliveryState = 'DELIVERED';
    if (Object.keys(fill).length) await writeBack(id, fill);
    return { ...result, documents: docs.length };
  } catch (err) {
    console.warn(`Could not list Zoho documents for ${str(img, 'ref')}:`, err);
    return result;
  }
}

async function reconcileZoho(id: string) {
  const table = process.env.ENQUIRY_TABLE;
  if (!table) throw new Error('ENQUIRY_TABLE is not configured');
  const got = await ddb.send(new GetItemCommand({ TableName: table, Key: { id: { S: id } } }));
  const img = got.Item as Img | undefined;
  if (!img) throw new Error('Enquiry not found');
  const ref = str(img, 'ref');
  const status = str(img, 'status') || 'RECEIVED';

  let invoiceId = str(img, 'zohoInvoiceId');
  let invoiceNumber = str(img, 'zohoInvoice');
  if (!invoiceId) {
    const found = await findInvoice(ref);
    if (found) {
      invoiceId = found.invoice_id;
      invoiceNumber = found.invoice_number;
    }
  }

  if (!invoiceId) {
    const quote = await findQuote(ref);
    const set = {
      zohoState: quote ? 'QUOTED' : 'NONE',
      zohoQuote: quote?.number ?? null,
      zohoInvoice: null,
      zohoInvoiceId: null,
      zohoPaymentId: null,
      zohoMessage: quote ? `Quote ${quote.number} in Zoho, no invoice yet` : 'Nothing in Zoho for this enquiry yet',
    };
    await writeBack(id, set);
    return set;
  }

  const r = await zoho(`/invoices/${invoiceId}`);
  const deleted = !r.ok && (r.status === 404 || /not exist|does not exist|invalid/i.test(r.body.message ?? ''));
  if (!r.ok && !deleted) throw new Error(`Zoho invoice read failed (${r.status}): ${r.body.message}`);
  const inv = r.body.invoice;
  const voided = deleted || inv?.status === 'void';
  const balance = Number(inv?.balance ?? 0);
  const pays = voided ? [] : await invoicePayments(invoiceId);
  const paid = !voided && (inv?.status === 'paid' || (balance <= 0 && pays.length > 0));

  if (!voided && inv?.status === 'draft') {
    const set = {
      zohoState: 'TEST',
      zohoInvoice: invoiceNumber || inv.invoice_number,
      zohoInvoiceId: invoiceId,
      zohoPaymentId: null,
      zohoMessage: `Draft invoice ${invoiceNumber || inv.invoice_number} (AED ${Number(inv.total ?? 0).toLocaleString('en-US')}): nothing posted`,
    };
    await writeBack(id, set);
    return set;
  }

  if (paid) {
    const set = {
      zohoState: 'PAID',
      zohoInvoice: invoiceNumber || inv?.invoice_number || '',
      zohoInvoiceId: invoiceId,
      zohoPaymentId: pays[0]?.payment_id ?? 'paid',
      zohoMessage: `Invoice ${invoiceNumber || inv?.invoice_number} · paid in Zoho (AED ${Number(inv?.total ?? 0).toLocaleString('en-US')})`,
    };
    await writeBack(id, set);
    return set;
  }

  // Reversed in Zoho: invoice voided/deleted, or its payment removed. Unlock the enquiry.
  const reason = voided
    ? `Invoice ${invoiceNumber} was ${deleted ? 'deleted' : 'voided'} in Zoho`
    : `Payment on invoice ${invoiceNumber} was removed in Zoho (AED ${balance.toLocaleString('en-US')} unpaid)`;
  const set: Record<string, string | null> = {
    zohoState: 'REVERSED',
    zohoInvoice: voided ? null : invoiceNumber,
    zohoInvoiceId: voided ? null : invoiceId,
    zohoPaymentId: null,
    zohoMessage: `${reason}. Unlocked${BEFORE_PAYMENT.includes(status) ? '' : ' and set back to Price sent'}.`,
  };
  if (!BEFORE_PAYMENT.includes(status)) set.status = 'PRICE_SENT';
  await writeBack(id, set);
  return set;
}

// ---------- entry point ----------

async function onStreamRecord(rec: StreamRecord) {
  const img = rec.dynamodb?.NewImage;
  if (!img) return;
  const id = str(img, 'id');

  if (rec.eventName === 'INSERT') {
    // Customer code for the new enquiry (same code as the customer's earlier orders).
    if (!str(img, 'customerCode')) await assignCodes().catch((err) => console.warn('Customer code not assigned', err));
    // A framed print of a painting: whose painting it is and their royalty %, for the costs (paid with their earnings).
    if (str(img, 'kind') === 'PHOTO' && process.env.PRODUCT_TABLE) {
      const d0 = parseDetails(detStr(img)), no = String(d0['Artwork no.'] ?? '').trim();
      const pr = no ? (await scanAll(process.env.PRODUCT_TABLE)).find((x) => str(x, 'code') === no) : undefined;
      if (pr && str(pr, 'kind') !== 'photo') {
        const pct = await printRoyaltyOf(pr); // the work's %, else the artist's (Artists & sellers; Siva's in Pricing)
        await writeBack(id, { artistName: str(pr, 'artist') || 'Siva Raja', ...(str(pr, 'artistId') ? { artistId: str(pr, 'artistId'), artistCountry: str(pr, 'artistCountry') || 'UAE' } : {}), royaltyPct: pct ?? 0 }).catch(() => {});
      }
    }
    // An order for a portal artist's collection work goes to that artist (their portal → Commissions).
    if (str(img, 'kind') === 'PRICE' && !str(img, 'artistId') && process.env.PRODUCT_TABLE) {
      const d0 = parseDetails(detStr(img)), no = String(d0['Artwork no.'] ?? '').trim();
      const pr = no ? (await scanAll(process.env.PRODUCT_TABLE)).find((x) => str(x, 'code') === no && str(x, 'artistId')) : undefined;
      if (pr) {
        await writeBack(id, { artistId: str(pr, 'artistId'), artistName: str(pr, 'artist'), artistCountry: str(pr, 'artistCountry') || 'UAE' }).catch(() => {});
        // Their price is already known (what they receive for this work: price table, else their listing).
        await useCataloguePrice(id, img).catch((err) => console.warn('Artist catalogue price not used', err));
      } else {
        // Siva's collection work: his price is the one he gave under "My works & prices", so the order doesn't ask him again.
        await useCataloguePrice(id, img).catch((err) => console.warn('Catalogue price not used', err));
      }
    }
    const quote = await createQuote(img);
    // Little Artists: the form already priced it (framing by age + delivery + extras), so the order starts with that
    // price (the studio checks it before "Price sent"). Not when overseas shipping is still to be quoted.
    const det = parseDetails(detStr(img));
    const kidsTotal = ['GIFT', 'PHOTO'].includes(str(img, 'kind')) && !/\+/.test(String(det['Total'] ?? '')) ? amount(det['Total']) : 0;
    await writeBack(id, { zohoState: 'QUOTED', zohoQuote: quote.number, zohoMessage: `Quote ${quote.number} created in Zoho${kidsTotal ? ` (AED ${kidsTotal})` : ''}`, ...(kidsTotal > 0 && num(img, 'quotedPrice') == null ? { quotedPrice: kidsTotal } : {}) });
    return;
  }
  if (rec.eventName !== 'MODIFY') return;

  const old = rec.dynamodb?.OldImage;
  // Our own write-backs (they always change zohoAt) are not Studio desk edits: ignore them.
  if (old && str(img, 'zohoAt') !== str(old, 'zohoAt')) return;
  const status = str(img, 'status') || 'RECEIVED';
  const oldStatus = old ? str(old, 'status') || 'RECEIVED' : status;
  const price = num(img, 'quotedPrice');
  const oldPrice = old ? num(old, 'quotedPrice') : price;
  const locked = str(img, 'zohoPaymentId') !== '';

  // A commission allocated to a portal artist: tell them.
  await artistAssigned(img, old);
  // Price sent: create the Ziina payment link (unless the studio typed its own link), so the email carries it.
  await ziinaPriceLink(rec, img);
  // Refund approved on the desk and the customer paid by Ziina: send it back through Ziina.
  await ziinaRefund(img);

  // After-sales action chosen on the Studio desk (refund / replacement).
  if (str(img, 'refundAction')) await afterSales(img);
  // Siva's rework for a replacement: his bill and payment.
  await reworkPurchase(img);
  // Cancelled before payment: decline the quote.
  if (status === 'CANCELLED' && oldStatus !== 'CANCELLED' && !str(img, 'zohoInvoiceId')) await declineQuote(img);

  // Linked to Siva's page: a work can't be framed or shipped before Siva has sent it to the frame shop.
  // (The Studio desk blocks this too; this catches any other route.) Replacements and Little Artists are exempt.
  if (status !== oldStatus && ['FRAMING', 'SHIPPED', 'DELIVERED'].includes(status) && ['PRICE', 'COMMISSION'].includes(str(img, 'kind'))
    && str(img, 'zohoPOId') && str(img, 'purchaseState') !== 'CANCELLED' && str(img, 'refundAction') !== 'DAMAGED_REPLACE' && str(img, 'artistStage') !== 'SHIPPED') {
    await writeBack(id, { status: oldStatus, zohoMessage: `Status kept at ${oldStatus}: Siva hasn't marked the work "Sent to frame shop" yet. ${str(img, 'zohoMessage').replace(/^Status kept at [^:]+: [^.]+\. /, '')}`.slice(0, 500) });
    console.log(`Kept ${str(img, 'ref')} at ${oldStatus}: Siva not sent yet`);
    return;
  }
  // Delivered: remember when (the customer has 48 hours to report damage).
  if (status === 'DELIVERED' && oldStatus !== 'DELIVERED') await writeBack(id, { deliveredAt: new Date().toISOString() });
  // Shipped / Delivered: delivery challan in Zoho (needs the invoice first).
  if (['SHIPPED', 'DELIVERED'].includes(status)) await deliverySteps(img, old);

  // Paid online with Ziina before this edit (in test mode Zoho has no payment, so "locked" above is false):
  // a stale Order Management page must not move the order back to Received / Price sent / Cancelled.
  if (!locked && str(old, 'ziinaPaidAt') && BEFORE_PAYMENT.includes(status) && !BEFORE_PAYMENT.includes(oldStatus)) {
    await writeBack(id, { status: oldStatus, zohoMessage: `Status kept at ${oldStatus}: the customer has paid online with Ziina. Use the after-sales box for a refund.` });
    console.log(`Kept ${str(img, 'ref')} at ${oldStatus}: paid with Ziina`);
    return;
  }
  if (locked) {
    await purchaseSteps(img);
    // Zoho holds the payment: undo a step back or a price change made in the Studio desk.
    const undo: Record<string, string | number | null> = {};
    if (BEFORE_PAYMENT.includes(status) && !BEFORE_PAYMENT.includes(oldStatus)) undo.status = oldStatus;
    if (price !== oldPrice && oldPrice !== null) undo.quotedPrice = oldPrice;
    if (Object.keys(undo).length) {
      undo.zohoMessage = `Locked: invoice ${str(img, 'zohoInvoice')} is paid in Zoho. Reverse it in Zoho first, then press Check Zoho.`;
      await writeBack(id, undo);
      console.log(`Kept ${str(img, 'ref')} locked (undid ${Object.keys(undo).filter((k) => k !== 'zohoMessage').join(', ')})`);
    }
    return;
  }

  // An invoice exists (draft in test mode): the price can't change any more; put it back.
  if (str(img, 'zohoInvoiceId') && price !== oldPrice && oldPrice !== null) {
    await writeBack(id, {
      quotedPrice: oldPrice,
      zohoMessage: `Price kept at AED ${oldPrice.toLocaleString('en-US')}: invoice ${str(img, 'zohoInvoice')} exists in Zoho. Delete or void it in Zoho first, then press Check Zoho.`,
    });
    console.log(`Kept ${str(img, 'ref')} price at ${oldPrice} (invoice exists)`);
    return;
  }

  // Test mode order already invoiced as a draft: run the purchase steps (draft PO) on later saves.
  // (Paid or any later status: Being framed, Shipped, Delivered.)
  if (str(img, 'zohoState') === 'TEST' && !BEFORE_PAYMENT.includes(status) && !(status === 'PAID' && oldStatus !== 'PAID')) {
    await purchaseSteps(img);
    return;
  }

  if (status === 'PAID' && oldStatus !== 'PAID') {
    const r = await invoiceAndRecordPayment(img);
    if ('test' in r && r.test) {
      await writeBack(id, {
        zohoState: 'TEST',
        zohoQuote: r.quote || null,
        zohoInvoice: r.invoice,
        zohoInvoiceId: r.invoiceId,
        zohoPaymentId: null,
        zohoMessage: `Test mode: draft invoice ${r.invoice} · AED ${r.total.toLocaleString('en-US')}. Nothing posted (no payment recorded).`,
      });
      if (!['GIFT', 'PHOTO', 'LICENCE'].includes(str(img, 'kind'))) {
        await purchaseSteps({ ...img, zohoState: { S: 'TEST' }, zohoInvoiceId: { S: r.invoiceId }, zohoInvoice: { S: r.invoice } });
      }
      await licenceDelivered(img);
      return;
    }
    await writeBack(id, {
      zohoState: 'PAID',
      zohoQuote: r.quote || null,
      zohoInvoice: r.invoice,
      zohoInvoiceId: r.invoiceId,
      zohoPaymentId: r.paymentId,
      zohoMessage: paidMessage(r, img),
    });
    if (!['GIFT', 'PHOTO', 'LICENCE'].includes(str(img, 'kind'))) await purchaseSteps({ ...img, zohoPaymentId: { S: r.paymentId } });
    await licenceDelivered(img);
    return;
  }

  if (price !== null && price > 0 && price !== oldPrice && !PAID_LIKE.includes(status)) {
    const quote = await updateQuotePrice(img, price);
    await writeBack(id, { zohoState: 'QUOTED', zohoQuote: quote.number, zohoMessage: `Quote ${quote.number} updated to AED ${price.toLocaleString('en-US')}` });
  }
}

// ---------- Rework for a replacement (damaged in transit) ----------
// The studio picks the fix on the order: REFRAME (frame shop: new glass / frame), SIVA_REPAIR or SIVA_REPAINT.
// Siva sees a Rework card on his page: his rework price (INR, 0 if free) and Started → Finished → Sent to frame shop.
// The studio confirms READY after checking it at the frame shop; only then can the order ship again.
// His rework invoice no. → a second Zoho bill (rework price + India courier); bank ref → payment made.
const REWORK_STEPS = ['STARTED', 'FINISHED', 'SENT'];
type Rework = { framing?: number; indiaCourier?: number; localCourier?: number; other?: number; insurer?: string; claimRef?: string; claimed?: number; received?: number; receivedRef?: string };

async function getRework(enquiryId: string): Promise<{ priceInr: number | null; fx: number; rework: Rework }> {
  const { img, costs } = await getCosting(enquiryId);
  const raw = img?.rework as AttributeValue | undefined;
  let rework: Rework = {};
  try {
    let v: unknown = raw && 'M' in raw && raw.M ? fromAttr(raw) : JSON.parse(str(img ?? undefined, 'rework') || '{}');
    if (typeof v === 'string') v = JSON.parse(v);
    rework = (v ?? {}) as Rework;
  } catch { rework = {}; }
  return { priceInr: num(img ?? undefined, 'reworkPriceInr'), fx: Number(costs.fx) > 0 ? Number(costs.fx) : 0.042, rework };
}

async function artistRework(args: ApiEvent['arguments'], by = 'Siva') {
  const table = process.env.ENQUIRY_TABLE;
  const costingTable = process.env.COSTING_TABLE;
  if (!table || !costingTable) throw new Error('Not configured');
  const id = args.id ?? '';
  const step = String(args.step ?? '').toUpperCase();
  const got = await ddb.send(new GetItemCommand({ TableName: table, Key: { id: { S: id } } }));
  const e = got.Item as Img | undefined;
  if (!e || !str(e, 'reworkType').startsWith('SIVA')) throw new Error('No rework requested for this work.');
  if (str(e, 'reworkStage') === 'READY') throw new Error('The rework is already checked and ready.');
  const now = new Date().toISOString();
  if (step === 'PRICE') {
    if (str(e, 'zohoReworkBillId')) throw new Error('Your rework invoice is already recorded: the price can no longer change.');
    const price = Number(args.priceInr);
    if (!(price >= 0) || price > 10_000_000) throw new Error('Enter your rework price in INR (0 if there is no charge).');
    await ddb.send(new UpdateItemCommand({
      TableName: costingTable, Key: { enquiryId: { S: id } },
      UpdateExpression: 'SET reworkPriceInr = :p, reworkPriceAt = :a, reworkPriceBy = :b, updatedAt = :a, createdAt = if_not_exists(createdAt, :a), #tn = if_not_exists(#tn, :t)',
      ExpressionAttributeNames: { '#tn': '__typename' },
      ExpressionAttributeValues: { ':p': { N: String(price) }, ':a': { S: now }, ':b': { S: by }, ':t': { S: 'Costing' } },
    }));
    console.log(`Rework price INR ${price} for ${str(e, 'ref')} by ${by}`);
    return { ok: true, reworkPriceInr: price, reworkPriceAt: now };
  }
  if (step === 'RECEIVED') {
    // Siva confirms the damaged piece reached him (repair only).
    if (!str(e, 'toSivaSentAt')) throw new Error('Nothing has been sent to you yet for this rework.');
    if (str(e, 'sivaReceivedAt')) return { ok: true, sivaReceivedAt: str(e, 'sivaReceivedAt') };
    await ddb.send(new UpdateItemCommand({ TableName: table, Key: { id: { S: id } }, UpdateExpression: 'SET sivaReceivedAt = :a, reworkBy = :b, updatedAt = :a', ExpressionAttributeValues: { ':a': { S: now }, ':b': { S: by } } }));
    console.log(`Siva received the damaged piece for ${str(e, 'ref')} (${by})`);
    return { ok: true, sivaReceivedAt: now };
  }
  if (!REWORK_STEPS.includes(step)) throw new Error('Unknown step');
  if (str(e, 'reworkType') === 'SIVA_REPAIR' && !str(e, 'sivaReceivedAt')) throw new Error('Tap "I\'ve received it" first: the damaged piece has to reach you before the repair starts.');
  const current = REWORK_STEPS.indexOf(str(e, 'reworkStage'));
  const target = REWORK_STEPS.indexOf(step);
  if (target < current) throw new Error(`Already marked ${str(e, 'reworkStage').toLowerCase()}.`);
  const courier = String(args.courier ?? '').trim().slice(0, 60);
  const awb = String(args.awb ?? '').trim().slice(0, 60);
  if (step === 'SENT' && (!courier || !awb)) throw new Error('Enter the courier and the AWB / tracking number.');
  if (step === 'SENT' && str(e, 'reworkStage') === 'SENT' && by === 'Siva') throw new Error('Already sent: the courier and AWB can only be corrected by Kalai Art House.');
  const set: Record<string, string> = { reworkStage: REWORK_STEPS[Math.max(target, current)], reworkBy: by, updatedAt: now };
  if (!str(e, 'reworkStartedAt')) set.reworkStartedAt = now;
  if (target >= 1 && !str(e, 'reworkFinishedAt')) set.reworkFinishedAt = now;
  if (target >= 2) { if (!str(e, 'reworkSentAt')) set.reworkSentAt = now; set.reworkCourier = courier; set.reworkAwb = awb; }
  if (args.note) set.reworkNote = String(args.note).slice(0, 500);
  const names: Record<string, string> = {};
  const values: Record<string, AttributeValue> = {};
  const parts = Object.entries(set).map(([k, v], i) => { names[`#r${i}`] = k; values[`:r${i}`] = { S: v }; return `#r${i} = :r${i}`; });
  await ddb.send(new UpdateItemCommand({ TableName: table, Key: { id: { S: id } }, UpdateExpression: `SET ${parts.join(', ')}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
  console.log(`Rework ${set.reworkStage} for ${str(e, 'ref')} by ${by}`);
  return { ok: true, ref: str(e, 'ref'), ...set };
}

/** Siva's rework: bill on his rework invoice number, then the payment made. Never throws (message on the order). */
async function reworkPurchase(img: Img) {
  const id = str(img, 'id');
  const ref = str(img, 'ref');
  if (!str(img, 'reworkType').startsWith('SIVA')) return;
  const needBill = !!str(img, 'reworkInvoiceNo') && !str(img, 'zohoReworkBillId');
  const needPay = !!str(img, 'zohoReworkBillId') && !!str(img, 'reworkPaidRef') && !str(img, 'zohoReworkPaymentId');
  if (!needBill && !needPay) return;
  try {
    const { priceInr, fx, rework } = await getRework(id);
    const aedPrice = round2((priceInr ?? 0) * fx);
    const courier = round2(Number(rework.indiaCourier ?? 0));
    if (needBill) {
      if (aedPrice + courier <= 0) { await writeBack(id, { reworkMessage: 'No rework price from Siva (or it is 0), so there is no bill to create.' }); return; }
      const testing = await testMode();
      const account = await artistAccountId();
      const lines: LineItem[] = [];
      if (aedPrice > 0) lines.push({ name: `Rework: ${str(img, 'reworkType') === 'SIVA_REPAINT' ? 'repaint' : 'repair'} (${str(img, 'title')})`, description: `Replacement for ${ref} · INR ${(priceInr ?? 0).toLocaleString('en-IN')} @ ${fx} AED/INR`, rate: aedPrice, quantity: 1 });
      if (courier > 0) lines.push({ name: 'Courier India → UAE (rework, reimbursement)', description: `Shipping for ${ref} rework`, rate: courier, quantity: 1 });
      const r = await zoho('/bills', {
        method: 'POST',
        body: JSON.stringify({
          vendor_id: await vendorId(), bill_number: str(img, 'reworkInvoiceNo'), reference_number: `${ref}-RW`, date: dubaiToday(),
          line_items: lines.map((l) => ({ ...l, ...(account ? { account_id: account } : {}) })), notes: `Rework for Kalai Art House order ${ref} (damaged in transit).`,
        }),
      });
      if (!r.ok || !r.body.bill) throw new Error(`Zoho rework bill failed (${r.status}): ${r.body.message}`);
      if (testing) {
        const state = await keepAsDraft(`/bills/${r.body.bill.bill_id}`, r.body.bill.status);
        await writeBack(id, { zohoReworkBill: r.body.bill.bill_number, zohoReworkBillId: r.body.bill.bill_id, reworkMessage: `Test mode: ${state === 'draft' ? 'draft' : 'void (test)'} rework bill ${r.body.bill.bill_number} · AED ${(aedPrice + courier).toLocaleString('en-US')}. Payment not recorded while testing.` });
        return;
      }
      await writeBack(id, { zohoReworkBill: r.body.bill.bill_number, zohoReworkBillId: r.body.bill.bill_id, reworkMessage: `Rework bill ${r.body.bill.bill_number} · AED ${(aedPrice + courier).toLocaleString('en-US')} owed to Siva` });
      return;
    }
    if (needPay) {
      if (await testMode()) {
        if (!/payment not recorded/i.test(str(img, 'reworkMessage'))) await writeBack(id, { reworkMessage: `Test mode: rework bill ${str(img, 'zohoReworkBill')} · payment not recorded while testing (ref ${str(img, 'reworkPaidRef')}).` });
        return;
      }
      const billId = str(img, 'zohoReworkBillId');
      const got = await zoho(`/bills/${billId}`);
      if (!got.ok || !got.body.bill) throw new Error(`Zoho bill read failed (${got.status}): ${got.body.message}`);
      const balance = Number(got.body.bill.balance ?? 0);
      let payId = 'paid';
      if (balance > 0 && got.body.bill.status !== 'paid') {
        const p = await zoho('/vendorpayments', {
          method: 'POST',
          body: JSON.stringify({ vendor_id: await vendorId(), payment_mode: 'banktransfer', amount: balance, date: dubaiToday(), reference_number: str(img, 'reworkPaidRef'), description: `Rework payment to ${VENDOR_NAME} for ${ref}`, bills: [{ bill_id: billId, amount_applied: balance }] }),
        });
        if (!p.ok || !p.body.vendorpayment) throw new Error(`Zoho vendor payment failed (${p.status}): ${p.body.message}`);
        payId = p.body.vendorpayment.payment_id;
      }
      await writeBack(id, { zohoReworkPaymentId: payId, reworkMessage: `Rework bill ${str(img, 'zohoReworkBill')} paid · ref ${str(img, 'reworkPaidRef')}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Rework purchase step failed for ${ref}:`, err);
    await writeBack(id, { reworkMessage: `Error: ${msg}`.slice(0, 500) });
  }
}

function reworkForArtist(e: Img, c: Img | undefined) {
  const type = str(e, 'reworkType');
  if (!type.startsWith('SIVA')) return null;
  return {
    type, stage: str(e, 'reworkStage'), note: str(e, 'reworkNote'),
    startedAt: str(e, 'reworkStartedAt'), finishedAt: str(e, 'reworkFinishedAt'), sentAt: str(e, 'reworkSentAt'), readyAt: str(e, 'reworkReadyAt'),
    courier: str(e, 'reworkCourier'), awb: str(e, 'reworkAwb'), by: str(e, 'reworkBy'),
    priceInr: num(c, 'reworkPriceInr'), priceBy: str(c, 'reworkPriceBy'),
    toSivaCourier: str(e, 'toSivaCourier'), toSivaAwb: str(e, 'toSivaAwb'), toSivaSentAt: str(e, 'toSivaSentAt'), receivedAt: str(e, 'sivaReceivedAt'),
    invoiceNo: str(e, 'reworkInvoiceNo'), billed: !!str(e, 'zohoReworkBillId'), paid: !!str(e, 'zohoReworkPaymentId'), paidRef: str(e, 'reworkPaidRef'),
  };
}

// ---------- Marketplace: seller portal and studio approval ----------
// Kalai collects the customer's money and pays the seller. The seller sets their own price (cost + markup + courier
// if they deliver + other charges = seller price). Kalai adds its commission % (fixed per seller at approval, adjustable
// per listing) and, when Kalai delivers, its delivery fee: that is the customer price shown on the website.
type Dict = Record<string, unknown>;
const r2 = (n: number) => Math.round(n * 100) / 100;
const numIn = (v: unknown, max = 1_000_000) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0; };
const txt = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);

function priceOf(l: { costPrice: number; markupPct: number; courierCharge: number; otherCharges: number; deliveryBy: string; commissionPct: number; kalaiDeliveryFee: number }) {
  const markup = r2(l.costPrice * l.markupPct / 100);
  const sellerPrice = r2(l.costPrice + markup + (l.deliveryBy === 'SELLER' ? l.courierCharge : 0) + l.otherCharges);
  const commission = r2(sellerPrice * l.commissionPct / 100);
  const delivery = l.deliveryBy === 'KALAI' ? l.kalaiDeliveryFee : 0;
  const customerPrice = Math.ceil(sellerPrice + commission + delivery);
  return { markup, sellerPrice, commission, delivery, customerPrice };
}

function toAttrs(o: Dict): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined || v === '') continue;
    out[k] = typeof v === 'number' ? { N: String(v) } : typeof v === 'boolean' ? { BOOL: v } : { S: String(v) };
  }
  return out;
}
const plain = (img: Img | undefined) => (img ? Object.fromEntries(Object.entries(img).map(([k, v]) => [k, fromAttr(v as AttributeValue)])) : null) as Dict | null;
async function getRow(table: string, key: Record<string, AttributeValue>) {
  return (await ddb.send(new GetItemCommand({ TableName: table, Key: key }))).Item as Img | undefined;
}
async function putRow(table: string, row: Dict) {
  await ddb.send(new PutItemCommand({ TableName: table, Item: toAttrs(row) }));
}
async function delRow(table: string, key: Record<string, AttributeValue>) {
  await ddb.send(new DeleteItemCommand({ TableName: table, Key: key }));
}
function mtables() {
  const S = process.env.SELLER_TABLE, L = process.env.LISTING_TABLE, M = process.env.MARKET_TABLE;
  if (!S || !L || !M) throw new Error('Marketplace is not configured');
  return { S, L, M };
}
/** Moves a seller / artist / supplier profile to a new account id, with everything that points at it (listings,
 *  orders, catalogue works, supplier jobs, the public artist card and their number series). */
async function moveSeller(old: Dict, newId: string, owner: string): Promise<Dict> {
  const { S, L, M } = mtables();
  const oldId = String(old.id);
  const row: Dict = { ...old, id: newId, owner, updatedAt: new Date().toISOString() };
  delete row.migrated;
  await putRow(S, row);
  const setStr = async (table: string, key: Record<string, AttributeValue>, f: Record<string, string>) => {
    const names: Record<string, string> = {}, values: Record<string, AttributeValue> = {};
    const parts = Object.entries(f).map(([k, v], i) => { names[`#f${i}`] = k; values[`:f${i}`] = { S: v }; return `#f${i} = :f${i}`; });
    await ddb.send(new UpdateItemCommand({ TableName: table, Key: key, UpdateExpression: `SET ${parts.join(', ')}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values })).catch((err) => console.warn('Move: not updated', err));
  };
  for (const l of await scanAll(L)) if (str(l, 'sellerId') === oldId) await setStr(L, { id: { S: str(l, 'id') } }, { sellerId: newId, owner });
  const et = process.env.ENQUIRY_TABLE;
  if (et) for (const e of await scanAll(et)) {
    const f: Record<string, string> = {};
    if (str(e, 'sellerId') === oldId) f.sellerId = newId;
    if (str(e, 'artistId') === oldId) f.artistId = newId;
    if (Object.keys(f).length) await setStr(et, { id: { S: str(e, 'id') } }, f);
  }
  const pt = process.env.PRODUCT_TABLE;
  if (pt) for (const p of await scanAll(pt)) if (str(p, 'artistId') === oldId) await setStr(pt, { id: { S: str(p, 'id') } }, { artistId: newId });
  const ct = process.env.COSTING_TABLE;
  if (ct) for (const c of await scanAll(ct)) {
    const js = parseJobs(c.supplierJobs?.S);
    let changed = false;
    for (const r of ['framer', 'delivery', 'printer', 'inbound'] as const) if (js[r]?.supplierId === oldId) { js[r]!.supplierId = newId; changed = true; }
    if (changed) await saveJobs(str(c, 'enquiryId'), js);
  }
  // The public artist card and the works shown under it.
  const A = process.env.ARTIST_TABLE;
  if (A && row.type === 'ARTIST') {
    const ok = artistKey(oldId), nk = artistKey(newId);
    for (const m of await scanAll(M)) if (str(m, 'artistKey') === ok) await setStr(M, { listingId: { S: str(m, 'listingId') } }, { artistKey: nk });
    const card = plain(await getRow(A, { id: { S: ok } }));
    if (card) { await putRow(A, { ...card, id: nk, updatedAt: new Date().toISOString() }); await delRow(A, { id: { S: ok } }); }
  }
  try { const ns = await numberSeries(); if (ns.sup[oldId]) { ns.sup[newId] = ns.sup[oldId]; delete ns.sup[oldId]; await saveSeries(ns); } } catch { /* none */ }
  await delRow(S, { id: { S: oldId } });
  console.log(`Profile ${oldId} moved to ${newId} (${String(row.email)})`);
  return row;
}
/** The website signs in with the access token, which has no email in it: read the signed-in person's email from
 *  Cognito with that same token (GetUser needs no other permission), so codes locked to an email, order emails and
 *  programme requests see who it is. Cached per user for the life of the function. */
const emailCache = new Map<string, string>();
async function ensureEmail(ev: ApiEvent) {
  const c = ev.identity?.claims;
  if (!ev.identity || !c || c.email) return;
  const sub = String(ev.identity.sub ?? c.sub ?? '');
  if (sub && emailCache.has(sub)) { c.email = emailCache.get(sub); return; }
  const raw = Object.entries(ev.request?.headers ?? {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? '';
  const token = String(raw).replace(/^Bearer\s+/i, '').trim();
  if (!token || String(c.token_use ?? 'access') !== 'access') return;
  try {
    const region = String(c.iss ?? '').match(/cognito-idp\.([a-z0-9-]+)\.amazonaws\.com/)?.[1] ?? process.env.AWS_REGION ?? 'us-east-1';
    const r = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, { method: 'POST', headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AWSCognitoIdentityProviderService.GetUser' }, body: JSON.stringify({ AccessToken: token }) });
    if (!r.ok) return;
    const body = await r.json() as { UserAttributes?: { Name: string; Value: string }[] };
    const email = body.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? '';
    if (email) { c.email = email; if (sub) emailCache.set(sub, email); }
  } catch (err) { console.warn('Email of the signed-in user not read', err); }
}

function who(ev: ApiEvent) {
  const sub = ev.identity?.sub ?? String(ev.identity?.claims?.sub ?? '');
  const username = ev.identity?.username ?? sub;
  if (!sub) throw new Error('Please sign in.');
  return { sub, owner: `${sub}::${username}`, email: String(ev.identity?.claims?.email ?? '') };
}
const parseData = (d: unknown): Dict => { try { return (typeof d === 'string' ? JSON.parse(d || '{}') : (d ?? {})) as Dict; } catch { return {}; } };

async function publishItem(l: Dict) {
  const { S, M } = mtables();
  // Artists' works go to the collection (with the artist's public key); sellers' products to the Crafts shop.
  const sp = plain(await getRow(S, { id: { S: String(l.sellerId) } }));
  const artist = sp?.type === 'ARTIST';
  await putRow(M, {
    listingId: l.id, __typename: 'MarketItem', createdAt: l.approvedAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(),
    sellerName: l.sellerName, title: l.title, description: l.description, category: l.category, imageKeys: l.imageKeys,
    price: l.customerPrice, stock: l.stock, deliveryBy: l.deliveryBy, publishedAt: l.approvedAt,
    sellerType: artist ? 'ARTIST' : 'SELLER', ...(artist ? { artistKey: artistKey(String(l.sellerId)) } : {}),
  });
}

// ---------- Public artist profiles ("Our artists" on the website) ----------
// Keyed by a hash of the artist's account id, so the account id itself is never public. No contact details.
const artistKey = (sub: string) => createHash('sha256').update(`kalai-artist:${sub}`).digest('hex').slice(0, 16);
async function publishArtist(p: Dict) {
  const A = process.env.ARTIST_TABLE;
  if (!A || p.type !== 'ARTIST') return;
  const now = new Date().toISOString();
  await putRow(A, {
    id: artistKey(String(p.id)), __typename: 'ArtistProfile', createdAt: String(p.approvedAt ?? now), updatedAt: now,
    name: p.business, photoKey: p.photoKey, about: p.about, mediums: p.mediums, region: p.emirate, country: p.country || 'UAE',
    commissions: p.commissions, publishedAt: String(p.approvedAt ?? now),
    training: p.training || '', city: p.city || '', experience: p.experience || '', ...(Number(p.bornYear) ? { bornYear: Number(p.bornYear) } : {}),
    featuredKey: (() => { try { return (JSON.parse(String(p.sampleKeys || '[]')) as string[])[0] || ''; } catch { return ''; } })(), sampleKeys: String(p.sampleKeys || '[]'),
  });
}
async function unpublishArtist(sub: string) {
  const A = process.env.ARTIST_TABLE;
  if (!A) return;
  try { await delRow(A, { id: { S: artistKey(sub) } }); } catch { /* not published */ }
}
// ---------- Portal artists' works join the collection like Siva's ----------
// Approving an artist's listing makes a catalogue work (Product, "Waiting for price" in Pricing) with the artist's
// price (what they receive, AED). The studio sets framed prices in Pricing; approving there puts it on the website
// with frames and sizes. Orders for it go to that artist (artist portal → Commissions).
const artProductId = (listingId: string) => `lst-${listingId}`;
async function upsertArtistProduct(l: Dict, seller: Dict, codes = true) {
  const P = process.env.PRODUCT_TABLE, AP = process.env.ARTPRICE_TABLE;
  if (!P) return;
  const id = artProductId(String(l.id)), now = new Date().toISOString();
  const old = plain(await getRow(P, { id: { S: id } })) || {};
  let keys: string[] = []; try { keys = JSON.parse(String(l.imageKeys || '[]')); } catch { keys = []; }
  const cat = String(l.category || '');
  const kind = /sketch|pencil|charcoal|graphite|ink|pen/i.test(cat) ? 'sketch' : 'water';
  const sz = String(l.description || '').match(/(\d{1,3}(?:\.\d)?)\s*[x×]\s*(\d{1,3}(?:\.\d)?)\s*cm/i);
  await putRow(P, {
    ...old, id, __typename: 'Product', createdAt: old.createdAt ?? now, updatedAt: now,
    title: l.title, named: 'yes', kind: old.kind ?? kind, subject: old.subject ?? 'nature', medium: old.medium ?? cat,
    size: old.size ?? (sz ? `${sz[1]} × ${sz[2]} cm` : ''), description: l.description, imageKey: keys[0] ?? old.imageKey,
    status: ['PUBLISHED', 'SOLD'].includes(String(old.status)) ? old.status : 'DRAFT', source: 'artist-portal',
    artist: seller.business, artistId: seller.id, artistCountry: seller.country || 'UAE', listingId: l.id, printRoyalty: Number(seller.royaltyPct ?? old.printRoyalty ?? 0) || undefined,
  });
  if (AP) {
    const ap = plain(await getRow(AP, { productId: { S: id } })) || {};
    await putRow(AP, { ...ap, productId: id, __typename: 'ArtworkPrice', createdAt: ap.createdAt ?? now, updatedAt: now,
      artistPrice: Number(l.sellerPrice ?? l.costPrice ?? 0) || undefined, currency: 'AED', artistPriceAt: now, artistNote: 'From the artist portal (what the artist receives)' });
  }
  if (codes) await assignCodes().catch(() => {});
}
async function hideArtistProduct(listingId: string) {
  const P = process.env.PRODUCT_TABLE; if (!P) return;
  const id = artProductId(listingId);
  const old = plain(await getRow(P, { id: { S: id } }));
  if (old && old.status !== 'SOLD') await putRow(P, { ...old, status: 'HIDDEN', updatedAt: new Date().toISOString() });
}

async function unpublishItem(id: string) {
  const { M } = mtables();
  try { await delRow(M, { listingId: { S: id } }); } catch { /* not published */ }
}

async function sellerAction(ev: ApiEvent) {
  const { S, L } = mtables();
  let me = who(ev);
  const action = String(ev.arguments.action ?? '');
  const d = parseData(ev.arguments.data);
  const now = new Date().toISOString();
  // The studio (ADMINS) can open any artist's or seller's portal and work in it on their behalf.
  const groups = ev.identity?.groups ?? (ev.identity?.claims?.['cognito:groups'] as string[] | undefined) ?? [];
  const admin = groups.includes('ADMINS');
  if (action === 'portals') {
    if (!admin) throw new Error('Not allowed');
    return { portals: (await scanAll(S)).map(plain).filter((p): p is Dict => !!p).map((p) => ({ id: p.id, business: p.business, contactName: p.contactName, type: p.type, status: p.status, country: p.country, city: p.city, emirate: p.emirate, address: txt(p.address, 200), from: (() => { try { let v: unknown = p.rateCard; for (let i = 0; i < 2 && typeof v === 'string'; i++) v = JSON.parse(v); return (v as Dict | null)?.from ?? null; } catch { return null; } })() }))
      .sort((a, b) => String(a.business).localeCompare(String(b.business))) };
  }
  const viewAs = txt(d.viewAs, 80);
  if (viewAs && viewAs !== me.sub) {
    if (!admin) throw new Error('Not allowed');
    const p = plain(await getRow(S, { id: { S: viewAs } }));
    if (!p) throw new Error('Portal not found');
    me = { sub: viewAs, owner: String(p.owner ?? ''), email: String(p.email ?? '') };
  }
  let profile = plain(await getRow(S, { id: { S: me.sub } }));
  // A frame shop / delivery partner the studio added by hand: the first time it signs in with that email, the
  // profile (and its jobs) becomes this login's.
  if (!profile && action === 'me' && me.email && !viewAs) {
    // Their profile under another id with the same (Cognito-verified) email: a supplier or artist prospect the studio
    // added (sup-/pro-), or a profile copied over from the test site (their old account): move it to this account.
    const mail = me.email.toLowerCase();
    const added = (await scanAll(S)).map(plain).find((p) => p && String(p.id) !== me.sub && String(p.email ?? '').toLowerCase() === mail
      && (!p.owner || String(p.id).startsWith('sup-') || String(p.id).startsWith('pro-') || p.migrated === true));
    if (added) profile = await moveSeller(added, me.sub, me.owner);
  }
  if (action === 'me') {
    const listings = profile ? (await scanAll(L)).filter((x) => str(x, 'sellerId') === me.sub).map(plain) : [];
    return { profile, listings, admin, viewing: viewAs && viewAs !== who(ev).sub ? viewAs : '' };
  }

  if (action === 'apply') {
    // Artists and sellers apply the same way; the type is fixed once approved.
    const type = profile?.type && profile.status !== 'REJECTED' ? String(profile.type) : d.type === 'ARTIST' ? 'ARTIST' : d.type === 'FRAMER' || d.type === 'COURIER' || d.type === 'PRINTER' ? String(d.type) : 'SELLER';
    const supplier = type === 'FRAMER' || type === 'COURIER' || type === 'PRINTER';
    const country = txt(d.country, 60) || 'UAE';
    const f = {
      type, country,
      business: txt(d.business, 120), contactName: txt(d.contactName, 80), phone: txt(d.phone, 30), tradeLicence: txt(d.tradeLicence, 60),
      emirate: txt(d.emirate, 60), address: txt(d.address, 300), about: txt(d.about, 2000), categories: txt(d.categories, 200),
      bankName: txt(d.bankName, 80), accountName: txt(d.accountName, 120), iban: txt(d.iban, 40).toUpperCase().replace(/\s+/g, ''),
      accountNumber: txt(d.accountNumber, 30).replace(/\s+/g, ''), ifsc: txt(d.ifsc, 20).toUpperCase().replace(/\s+/g, ''),
      mediums: txt(d.mediums, 200), experience: txt(d.experience, 40), commissions: d.commissions === 'NO' ? 'NO' : 'YES', allowPrints: d.allowPrints === 'NO' ? 'NO' : 'YES', allowLicences: d.allowLicences === 'YES' ? 'YES' : 'NO', portfolio: txt(d.portfolio, 300),
      training: txt(d.training, 120), city: txt(d.city, 60),
      sampleKeys: '[]', photoKey: '',
    };
    const artist = type === 'ARTIST';
    if (!f.business || !f.contactName || f.phone.replace(/\D/g, '').length < 9) throw new Error(artist ? 'Add your artist name, full name and mobile.' : 'Add your business name, contact name and mobile.');
    if (!f.about) throw new Error(artist ? 'Tell us about yourself and your art.' : supplier ? 'Tell us about your services.' : 'Tell us what you sell.');
    if (supplier && !f.address) throw new Error(type === 'FRAMER' ? 'Add your workshop address (where works are collected).' : 'Add your address.');
    if (f.portfolio && !/^https?:\/\/\S+$/i.test(f.portfolio)) throw new Error('The portfolio link should start with https://');
    if (country === 'UAE' && f.iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(f.iban)) throw new Error('Check the IBAN (e.g. AE07 0331 2345 6789 0123 456).');
    if (country === 'India' && f.ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(f.ifsc)) throw new Error('Check the IFSC code (e.g. SBIN0001234).');
    if (country === 'India' && f.accountNumber && !/^\d{9,18}$/.test(f.accountNumber)) throw new Error('Check the account number (9 to 18 digits).');
    let samples: string[] = [];
    try { samples = (JSON.parse(String(d.sampleKeys ?? '[]')) as unknown[]).filter((k): k is string => typeof k === 'string' && k.startsWith('market/')).slice(0, 8); } catch { samples = []; }
    if (artist && !f.mediums) throw new Error('Tick the mediums you work in.');
    if (artist && samples.length < 3) throw new Error('Upload at least 3 photos of your work.');
    if (!artist && !supplier && !samples.length) throw new Error('Upload at least 1 photo of your products.');
    f.sampleKeys = JSON.stringify(samples);
    const born = Math.floor(Number(d.bornYear));
    const bornYear = born >= 1920 && born <= new Date().getFullYear() - 10 ? born : null;
    const photo = txt(d.photoKey, 300);
    f.photoKey = photo.startsWith('market/') ? photo : '';
    const status = profile?.status === 'APPROVED' ? 'APPROVED' : profile?.status === 'SUSPENDED' ? 'SUSPENDED' : profile?.status === 'PROSPECT' ? 'PROSPECT' : 'APPLIED'; // editing details keeps the status
    const row = { ...(profile ?? {}), ...f, ...(bornYear ? { bornYear } : {}), id: me.sub, owner: me.owner, email: me.email || profile?.email, __typename: 'SellerProfile', status, appliedAt: profile?.appliedAt ?? now, createdAt: profile?.createdAt ?? now, updatedAt: now };
    await putRow(S, row);
    if (row.status === 'APPROVED' && type === 'ARTIST') await publishArtist(row);
    if (!profile || profile.status === 'REJECTED') {
      await sendMail({
        to: STUDIO_EMAIL, subject: `New ${artist ? 'artist' : type === 'FRAMER' ? 'frame shop' : type === 'COURIER' ? 'delivery partner' : type === 'PRINTER' ? 'print shop' : 'seller'} application: ${f.business}`,
        lines: [`<b>${h(f.business)}</b> · ${h(f.contactName)} · ${h(f.phone)} · ${h(me.email)} · ${h(f.emirate)}${country === 'India' ? ', India' : ''}`,
          artist ? `Mediums: ${h(f.mediums)} · ${h(f.experience || 'experience not given')} · commissions: ${f.commissions === 'YES' ? 'yes' : 'no'} · ${samples.length} sample photos` : `Sells: ${h(f.about)} · ${samples.length} product photos`,
          artist ? `About: ${h(f.about)}` : f.tradeLicence ? `Trade licence: ${h(f.tradeLicence)}` : 'No trade licence given.',
          f.portfolio ? `Portfolio: ${h(f.portfolio)}` : '',
          'Approve or reject under Sellers, and set the commission %.'].filter(Boolean),
        button: { label: 'Open Sellers', url: `${SITE}/admin.html#sellers` }, footer: 'Studio notification from art.pranixtechno.com',
      }).catch(() => {});
    }
    return { profile: row };
  }

  // Frame shops and delivery partners keep a price list (also while their application is being checked).
  if (action === 'saveRates') {
    if (!profile || !ROLE_OF[String(profile.type)]) throw new Error('Price lists are for frame shops and delivery partners.');
    // Prices in ⃃, or in ₹ for a supplier in India (card.currency 'INR'; costing converts at the Rates exchange rate).
    let prev0: Dict = {}; try { let v: unknown = profile.rateCard; for (let i = 0; i < 2 && typeof v === 'string'; i++) v = JSON.parse(v); prev0 = (v && typeof v === 'object' ? v : {}) as Dict; } catch { prev0 = {}; }
    const currency = d.currency === 'INR' || d.currency === 'AED' ? String(d.currency) : prev0.currency === 'INR' ? 'INR' : 'AED';
    const cap = currency === 'INR' ? 200000 : 5000;
    // Studio only: a supplier used for some order kinds only (e.g. Day to Day shop frames: Little Artists + framed prints).
    const KINDS = ['GIFT', 'PHOTO', 'PRICE', 'COMMISSION'];
    const onlyFor = admin && Array.isArray(d.onlyFor) ? (d.onlyFor as unknown[]).map(String).filter((k) => KINDS.includes(k)) : Array.isArray(prev0.onlyFor) ? prev0.onlyFor : [];
    const keepOnly = onlyFor.length ? { onlyFor } : {};
    const n = (v: unknown) => (v === '' || v == null ? undefined : Math.min(cap, Math.max(0, Math.round(Number(v) * 100) / 100)));
    const grid = (o: unknown, rows: string[], cols: string[]) => {
      const out: Record<string, Record<string, number>> = {};
      for (const r of rows) for (const c of cols) { const v = n((o as Record<string, Record<string, unknown>> | undefined)?.[r]?.[c]); if (v !== undefined && Number.isFinite(v)) (out[r] ??= {})[c] = v; }
      return out;
    };
    // Courier price per country, or "Country|Region" (state / province / city): up to 400 rows.
    const countryGrid = (o: unknown) => {
      const src = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
      const keys = Object.keys(src).map((k) => k.split('|').map((x) => txt(x, 60).trim()).filter(Boolean).slice(0, 2).join('|')).filter(Boolean);
      const out: Record<string, Record<string, number>> = {};
      Object.keys(src).slice(0, 400).forEach((k, i) => { const row = grid({ x: src[k] }, ['x'], PARCELS).x; if (row && keys[i]) out[keys[i]] = row; });
      return out;
    };
    const SZ = ['A4', 'A3', '30×40', '40×50', '50×70', '60×80', '70×100'];
    const PARCELS = ['s1', '40×50', '50×70', '60×80', '70×100']; // delivery partners: price by parcel (frame) size
    const PSZ = ['A4', 'A3', '30×40', '40×50', '50×70', '60×80', '70×100'];
    // Keep the studio's flags on a print shop's card (fine-art paper: used for the market estimate).
    let prev: Dict = {}; try { let v: unknown = profile.rateCard; for (let i = 0; i < 2 && typeof v === 'string'; i++) v = JSON.parse(v); prev = (v && typeof v === 'object' ? v : {}) as Dict; } catch { prev = {}; }
    const card = profile.type === 'PRINTER'
      ? { print: grid({ x: d.print }, ['x'], PSZ).x ?? {}, notes: txt(d.notes, 500), at: now, currency, ...(prev.fineArt !== undefined ? { fineArt: prev.fineArt } : {}), basis: 'list' }
      : profile.type === 'FRAMER'
      ? { frames: grid(d.frames, ['black', 'white', 'oak', 'walnut', 'gold'], SZ), fixing: grid({ x: d.fixing }, ['x'], SZ).x ?? {}, fixingIncluded: d.fixingIncluded === true, print: grid({ x: d.print }, ['x'], ['A4', 'A3', '30×40', '40×50', '50×70', '60×80']).x ?? {},
          uae: grid(d.uae, ['Dubai', 'Sharjah', 'Ajman', 'Abu Dhabi', 'Ras Al Khaimah', 'Umm Al Quwain', 'Fujairah'], ['small', 'large']), notes: txt(d.notes, 500), at: now, basis: 'list', currency, ...keepOnly, ...(prev.from ? { from: prev.from } : {}) }
      : { uae: grid(d.uae, ['Dubai', 'Sharjah', 'Ajman', 'Abu Dhabi', 'Ras Al Khaimah', 'Umm Al Quwain', 'Fujairah'], PARCELS), intl: grid(d.intl, ['A', 'B', 'C', 'D', 'E'], PARCELS), country: countryGrid(d.country), from: d.from === 'India' ? 'India' : 'UAE', notes: txt(d.notes, 500), at: now, basis: 'list', currency };
    const row = { ...profile, rateCard: JSON.stringify(card), updatedAt: now };
    await putRow(S, row);
    return { profile: row };
  }
  // Frame shops: their frame catalogue (photo, name, style, material, colour, width, extra price), for the studio.
  if (action === 'saveCatalogue') {
    if (!profile || profile.type !== 'FRAMER') throw new Error('The frame catalogue is for frame shops.');
    const STY = ['black', 'white', 'oak', 'walnut', 'gold', 'other'];
    const items = (Array.isArray(d.items) ? d.items : []).slice(0, 40).map((x) => {
      const o = (x ?? {}) as Dict;
      const photo = txt(o.photoKey, 300);
      return { id: txt(o.id, 40) || crypto.randomUUID().slice(0, 8), name: txt(o.name, 80), style: STY.includes(String(o.style)) ? String(o.style) : 'other', material: txt(o.material, 40), colour: txt(o.colour, 40),
        widthMm: o.widthMm === '' || o.widthMm == null ? null : Math.min(300, Math.max(0, Math.round(Number(o.widthMm)))), extra: o.extra === '' || o.extra == null ? null : Math.min(5000, Math.max(0, Number(o.extra))),
        photoKey: photo.startsWith('market/') ? photo : '', note: txt(o.note, 200) };
    }).filter((x) => x.name);
    const row = { ...profile, catalogue: JSON.stringify(items), updatedAt: now };
    await putRow(S, row);
    return { profile: row };
  }
  if (!profile || profile.status !== 'APPROVED') throw new Error('Your seller account is not approved yet.');

  if (action === 'saveListing') {
    const id = txt(d.id, 60) || crypto.randomUUID();
    const old = d.id ? plain(await getRow(L, { id: { S: id } })) : null;
    if (old && old.sellerId !== me.sub) throw new Error('Listing not found');
    let keys: string[] = [];
    try { keys = (JSON.parse(String(d.imageKeys ?? '[]')) as string[]).filter((k) => typeof k === 'string' && k.startsWith('market/')).slice(0, 6); } catch { keys = []; }
    const f = {
      title: txt(d.title, 120), description: txt(d.description, 2000), category: txt(d.category, 60), stock: Math.max(0, Math.floor(numIn(d.stock, 10000))),
      costPrice: numIn(d.costPrice), markupPct: numIn(d.markupPct, 1000), courierCharge: numIn(d.courierCharge), otherCharges: numIn(d.otherCharges),
      deliveryBy: d.deliveryBy === 'KALAI' ? 'KALAI' : 'SELLER', imageKeys: JSON.stringify(keys),
    };
    if (!f.title) throw new Error('Add a title.');
    if (!(f.costPrice > 0)) throw new Error('Enter your cost price.');
    const commissionPct = Number(old?.commissionPct ?? profile.commissionPct ?? 0);
    const kalaiDeliveryFee = Number(profile.kalaiDeliveryFee ?? 0);
    const p = priceOf({ ...f, commissionPct, kalaiDeliveryFee });
    // A change to anything but stock sends an approved listing back for review.
    const contentChanged = old && ['title', 'description', 'category', 'imageKeys', 'costPrice', 'markupPct', 'courierCharge', 'otherCharges', 'deliveryBy'].some((k) => String((old as Dict)[k] ?? '') !== String((f as Dict)[k] ?? ''));
    let status = String(old?.status ?? 'DRAFT');
    if (status === 'APPROVED' && contentChanged) status = 'SUBMITTED';
    const row = { ...(old ?? {}), ...f, id, owner: me.owner, sellerId: me.sub, sellerName: profile.business, __typename: 'Listing', commissionPct, kalaiDeliveryFee, sellerPrice: p.sellerPrice, customerPrice: p.customerPrice, status, createdAt: old?.createdAt ?? now, updatedAt: now, ...(status === 'SUBMITTED' && old?.status === 'APPROVED' ? { submittedAt: now } : {}) };
    await putRow(L, row);
    if (old?.status === 'APPROVED' && status === 'SUBMITTED') await unpublishItem(id);
    else if (status === 'APPROVED') await publishItem(row);
    return { listing: row, price: p, backToReview: old?.status === 'APPROVED' && status === 'SUBMITTED' };
  }

  if (action.startsWith('job')) return supplierJobs(action, d, me.sub, profile);
  if (['orders', 'orderReady', 'orderDispatched', 'orderDelivered'].includes(action)) return sellerOrders(action, d, me.sub, profile);
  if (action.startsWith('commission')) return artistCommissions(action, d, me.sub, profile);

  const id = txt(d.id, 60);
  const l = plain(await getRow(L, { id: { S: id } }));
  if (!l || l.sellerId !== me.sub) throw new Error('Listing not found');
  if (action === 'submitListing') {
    if (!['DRAFT', 'REJECTED'].includes(String(l.status))) throw new Error('Already submitted.');
    if (!(JSON.parse(String(l.imageKeys || '[]')) as string[]).length) throw new Error('Add at least one photo before submitting.');
    const row = { ...l, status: 'SUBMITTED', submittedAt: now, updatedAt: now, adminNote: '' };
    await putRow(L, row);
    await sendMail({ to: STUDIO_EMAIL, subject: `Listing to approve: ${l.title} (${profile.business})`, lines: [`<b>${h(l.title)}</b> from ${h(profile.business)}`, `Seller price AED ${l.sellerPrice} · customer price AED ${l.customerPrice} · delivery by ${l.deliveryBy === 'KALAI' ? 'Kalai' : 'the seller'}`], button: { label: 'Open Sellers', url: `${SITE}/admin.html#sellers` }, footer: 'Studio notification from art.pranixtechno.com' }).catch(() => {});
    return { listing: row };
  }
  if (action === 'pauseListing' || action === 'resumeListing') {
    const pause = action === 'pauseListing';
    if (pause && l.status !== 'APPROVED') throw new Error('Only a live listing can be paused.');
    if (!pause && l.status !== 'PAUSED') throw new Error('Not paused.');
    const row = { ...l, status: pause ? 'PAUSED' : 'APPROVED', updatedAt: now };
    await putRow(L, row);
    if (pause) await unpublishItem(id); else await publishItem(row);
    return { listing: row };
  }
  if (action === 'deleteListing') {
    await unpublishItem(id);
    await delRow(L, { id: { S: id } });
    return { deleted: id };
  }
  throw new Error('Unknown action');
}

// ---------- Supplier portal: frame shops (FRAMER) and delivery partners (COURIER) ----------
// The studio gives an order to a frame shop and/or a delivery partner (Order Management → order → Frame shop & delivery).
// The job lives on the admin-only Costing record (supplierJobs), so customers never see what Kalai pays its suppliers.
// Frame shop: Accept → Framed, ready for pickup → its invoice (Zoho bill). Delivery partner: Accept → Picked up
// (order Shipped, tracking no.) → Delivered (order Delivered) → its invoice (Zoho bill).
type Job = { supplierId: string; name: string; price: number | null; due: string; note: string; stage: string; assignedAt: string; acceptedAt?: string; readyAt?: string; canDeliver?: boolean; deliveryPrice?: number | null; byFramer?: boolean;
  pickedAt?: string; deliveredAt?: string; awb?: string; awbAt?: string; pod?: { name: string; at: string; signKey?: string; photoKeys?: string[]; note?: string }; invoiceNo?: string; invoiceAmt?: number; invoiceAt?: string; bill?: string; billId?: string; billState?: string; message?: string };
// Print shops print the customer's photo / child's drawing / our print file (Little Artists, Framed Prints) and hand
// the print to the frame shop. Without a print job, the frame shop prints it itself.
type Role = 'framer' | 'delivery' | 'printer';
// inbound: the courier Kalai allocates for the artist's parcel (artist → frame shop), with its airway bill.
type Inbound = { supplierId: string; name: string; at: string; awb?: string; awbAt?: string; from?: { name: string; phone: string; address: string } };
type Jobs = { framer?: Job; delivery?: Job; printer?: Job; inbound?: Inbound };
const ROLE_OF: Record<string, Role> = { FRAMER: 'framer', COURIER: 'delivery', PRINTER: 'printer' };
const ROLE_LABEL = { framer: 'frame shop', delivery: 'delivery partner', printer: 'print shop' };
const ROLE_WORD = { framer: 'framing', delivery: 'delivery', printer: 'printing' };
const asRole = (v: unknown): Role => (v === 'delivery' ? 'delivery' : v === 'printer' ? 'printer' : 'framer');

async function jobsOf(enquiryId: string): Promise<Jobs> {
  const t = process.env.COSTING_TABLE;
  if (!t) throw new Error('Not configured');
  const row = await getRow(t, { enquiryId: { S: enquiryId } });
  return parseJobs(row?.supplierJobs?.S);
}
// The JSON each jobs object was read from, so saveJobs can tell which roles this request changed.
const JOBS_READ = new WeakMap<object, string>();
function parseJobs(raw?: string): Jobs {
  let out: Jobs;
  try { let v: unknown = JSON.parse(raw || '{}'); if (typeof v === 'string') v = JSON.parse(v); out = (v && typeof v === 'object' ? v : {}) as Jobs; } catch { out = {}; }
  JOBS_READ.set(out, JSON.stringify(out));
  return out;
}
/** Saves the jobs of one order without losing a change made at the same time by another request (e.g. the frame shop job
 *  and the delivery job sent a second apart): only the roles this request changed are written over the latest saved copy,
 *  with a conditional write that retries if the row changed in between. `jobs` is updated to what was saved. */
async function saveJobs(enquiryId: string, jobs: Jobs) {
  const t = process.env.COSTING_TABLE;
  if (!t) throw new Error('Not configured');
  const before = JSON.parse(JOBS_READ.get(jobs) ?? '{}') as Record<string, unknown>;
  const mine = jobs as unknown as Record<string, unknown>;
  const changed = [...new Set([...Object.keys(before), ...Object.keys(mine)])].filter((r) => JSON.stringify(before[r]) !== JSON.stringify(mine[r]));
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = (await ddb.send(new GetItemCommand({ TableName: t, Key: { enquiryId: { S: enquiryId } }, ConsistentRead: true }))).Item as Img | undefined;
    const rawNow = row?.supplierJobs?.S;
    const latest = parseJobs(rawNow) as unknown as Record<string, unknown>;
    for (const r of changed) { if (mine[r] === undefined) delete latest[r]; else latest[r] = mine[r]; }
    const now = new Date().toISOString();
    try {
      await ddb.send(new UpdateItemCommand({ TableName: t, Key: { enquiryId: { S: enquiryId } },
        UpdateExpression: 'SET supplierJobs = :j, updatedAt = :n, createdAt = if_not_exists(createdAt, :n), #tn = if_not_exists(#tn, :t)',
        ConditionExpression: rawNow === undefined ? 'attribute_not_exists(supplierJobs)' : 'supplierJobs = :old',
        ExpressionAttributeNames: { '#tn': '__typename' },
        ExpressionAttributeValues: { ':j': { S: JSON.stringify(latest) }, ':n': { S: now }, ':t': { S: 'Costing' }, ...(rawNow === undefined ? {} : { ':old': { S: rawNow } }) } }));
      for (const k of Object.keys(mine)) delete mine[k];
      Object.assign(mine, latest);
      JOBS_READ.set(jobs, JSON.stringify(latest));
      return;
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      await new Promise((r) => setTimeout(r, 120 + attempt * 150)); // someone saved in between: read again and re-apply
    }
  }
  throw new Error('Another change to this order was being saved: please press again.');
}
async function enquiryRow(id: string) {
  const table = process.env.ENQUIRY_TABLE;
  if (!table) throw new Error('Not configured');
  return (await ddb.send(new GetItemCommand({ TableName: table, Key: { id: { S: id } } }))).Item as Img | undefined;
}

/** Studio (ADMINS): give an order's framing or delivery to a supplier, or take it back. */
async function assignJob(action: string, d: Dict) {
  const { S } = mtables();
  const id = txt(d.id, 80), role = asRole(d.role);
  const e = await enquiryRow(id);
  if (!e) throw new Error('Order not found');
  const jobs = await jobsOf(id);
  const cur = jobs[role];
  const now = new Date().toISOString();
  if (action === 'removeJob') {
    if (!cur) return { jobs };
    if (!['ASSIGNED', 'ACCEPTED'].includes(cur.stage)) throw new Error(`The ${ROLE_LABEL[role]} has already ${cur.stage === 'READY' ? 'framed it' : 'started'}: it can't be taken back here.`);
    delete jobs[role];
    await saveJobs(id, jobs);
    const p = plain(await getRow(S, { id: { S: cur.supplierId } }));
    if (p?.email) await sendMail({ to: String(p.email), subject: `Job withdrawn: ${str(e, 'ref')}`, lines: [`Hello ${h(p.contactName)},`, `Kalai Art House has withdrawn the ${ROLE_WORD[role]} job for order <b>${h(str(e, 'ref'))}</b>. Please don't start it. Sorry for any inconvenience.`] }).catch(() => {});
    return { jobs };
  }
  const sid = txt(d.supplierId, 80);
  const p = plain(await getRow(S, { id: { S: sid } }));
  // Delivery: a delivery partner, or a frame shop that delivers (it has delivery charges in its price list).
  if (!p || (ROLE_OF[String(p.type)] !== role && !(role === 'delivery' && p.type === 'FRAMER'))) throw new Error(`Choose a ${ROLE_LABEL[role]}.`);
  if (p.status !== 'APPROVED') throw new Error(`${String(p.business)} is not approved yet (Artists & sellers).`);
  if (cur && cur.supplierId !== sid && !['ASSIGNED', 'ACCEPTED'].includes(cur.stage)) throw new Error(`${cur.name} has already started this job.`);
  const price = d.price === '' || d.price == null ? null : numIn(d.price, 100000);
  // A frame shop may also be asked to deliver (it confirms when accepting); the delivery job is then its own too.
  const canDeliver = role === 'framer' && !!d.canDeliver && !jobs.delivery;
  const deliveryPrice = canDeliver && d.deliveryPrice !== '' && d.deliveryPrice != null ? numIn(d.deliveryPrice, 100000) : null;
  const job: Job = cur && cur.supplierId === sid
    ? { ...cur, price, due: txt(d.due, 10), note: txt(d.note, 500), canDeliver, deliveryPrice, ...(d.spec ? { spec: txt(d.spec, 160) } : {}) }
    : { supplierId: sid, name: String(p.business || p.contactName), price, due: txt(d.due, 10), note: txt(d.note, 500), stage: 'ASSIGNED', assignedAt: now, canDeliver, deliveryPrice, ...(d.spec ? { spec: txt(d.spec, 160) } : {}) };
  jobs[role] = job;
  if (role === 'delivery') await ensureAwb(jobs).catch((err) => console.warn('AWB not made', err));
  await saveJobs(id, jobs);
  if ((!cur || cur.supplierId !== sid) && p.email) {
    await sendMail({ to: String(p.email), subject: `New ${ROLE_WORD[role]} job: ${str(e, 'ref')}`,
      lines: [`Hello ${h(p.contactName)},`, `Kalai Art House has a ${ROLE_WORD[role]} job for you: <b>${h(str(e, 'title'))}</b> (order ${h(str(e, 'ref'))}).`,
        job.price != null ? `Agreed price: <b>${aed(job.price)}</b>.` : '', job.canDeliver ? `We'd also like you to deliver it to the customer${job.deliveryPrice != null ? ` for <b>${aed(job.deliveryPrice)}</b>` : ''}: please confirm when you accept.` : '', job.due ? `Please complete it by <b>${h(job.due)}</b>.` : '', job.note ? `Note: ${h(job.note)}` : '',
        role === 'framer' ? 'Before you cut: check the artwork you receive against the photo and the frame spec (frame, outer size, mount, glass). If anything is unclear, or the artwork arrives damaged or a different size, <b>please ask us first</b> on WhatsApp +971 55 299 6626.'
          : role === 'printer' ? 'Print from the full-size file in your portal, at the size given, on matte fine-art paper. If the file looks soft or the colours are off, <b>ask us before printing</b> on WhatsApp +971 55 299 6626.'
          : 'Handle it as fragile framed glass. If the parcel looks damaged at pickup, take photos and <b>tell us before you take it</b> on WhatsApp +971 55 299 6626.',
        'Open your supplier portal to see the details, the step-by-step instructions, and accept the job.'],
      button: { label: 'Open my jobs', url: `${SITE}/supplier.html#jobs` } }).catch((err) => console.warn('Supplier email failed', err));
  }
  if (cur && cur.supplierId !== sid) {
    const old = plain(await getRow(S, { id: { S: cur.supplierId } }));
    if (old?.email) await sendMail({ to: String(old.email), subject: `Job withdrawn: ${str(e, 'ref')}`, lines: [`Hello ${h(old.contactName)},`, `Kalai Art House has given order <b>${h(str(e, 'ref'))}</b> to another supplier. Please don't start it.`] }).catch(() => {});
  }
  return { jobs };
}

// What each supplier may see of the customer's order. Frame shops: the frame spec only (never the customer's price or
// offer). Delivery partners: just the parcel (framed work and its size), never frame or price details.
const FRAMER_KEYS = ['Artwork', 'Size', 'Framing', 'Frame', 'Frame tried on the website', 'Style', 'Extras', 'Card message', 'Child', 'Gift for'];
function parcelOf(det: Record<string, string>) {
  const m = String(det['Framing'] || '').match(/(\d{2,3})\s*[x×]\s*(\d{2,3})/);
  if (m) return `Framed work, ${m[1]}×${m[2]} cm`;
  if (det['Child']) return /A3|Large size/i.test(String(det['Extras'] || '')) ? 'Framed drawing, A3' : 'Framed drawing, A4';
  return /unframed/i.test(String(det['Framing'] || '')) ? 'Unframed artwork (flat or rolled)' : 'Framed work';
}
/** What a supplier sees of one order. */
/** Little Artists: what the frame shop prints from the customer's photo before framing. */
function giftPrintSpec(det: Record<string, string>) {
  const size = /A3|Large size/i.test(String(det['Extras'] ?? '')) ? 'A3' : 'A4';
  const copies = /second framed copy/i.test(String(det['Extras'] ?? '')) ? 2 : 1;
  return `${copies === 2 ? '2 copies' : '1 copy'}, ${size}, on matte / fine-art paper from the photo (download the full-size file below). Crop to the paper edge, keep the colours true.`;
}
/** Photo framing: the print the frame shop makes from the customer's photo. */
function photoPrintSpec(det: Record<string, string>) {
  const n = Math.max(1, Number(det['Copies']) || 1);
  return `${n === 1 ? '1 copy' : `${n} copies`}, ${det['Size'] || 'A4'}, fine-art matte print of ${det['Print'] ? `"${String(det['Print']).slice(0, 80)}"${det['Artwork no.'] ? ` (${det['Artwork no.']})` : ''} from our file` : "the customer's photo"} (download the full-size file below)${/print only/i.test(String(det['Frame'] ?? '')) ? '. Print only: no frame, pack flat' : ''}.${det['Note'] ? ` Customer's note: ${String(det['Note']).slice(0, 200)}` : ''}`;
}
function jobView(e: Img, jobs: Jobs, role: Role, framerProfile: Dict | null, printerProfile: Dict | null = null) {
  const j = jobs[role]!;
  const printed = ['GIFT', 'PHOTO'].includes(str(e, 'kind'));
  const selfDelivery = role === 'delivery' && !!jobs.framer && jobs.framer.supplierId === j.supplierId;
  const det = parseDetails(detStr(e));
  return {
    id: str(e, 'id'), role, ref: str(e, 'ref'), kind: KIND[str(e, 'kind')] ?? str(e, 'kind'), title: str(e, 'title'), orderStatus: str(e, 'status'),
    canDeliver: role === 'framer' && !!j.canDeliver && !jobs.delivery, deliveryPrice: j.deliveryPrice ?? null, delivering: role === 'framer' && jobs.delivery?.supplierId === j.supplierId, selfDelivery,
    stage: j.stage, price: j.price, due: j.due, note: j.note, assignedAt: j.assignedAt, awb: j.awb ?? '', invoiceNo: j.invoiceNo ?? '', invoiceAmt: j.invoiceAmt ?? null, hasBill: !!j.billId,
    bill: j.bill ?? '', billState: j.billState ?? '', message: j.message ?? '',
    // Collection / commission: the artist makes the work first; the frame shop sees where it is.
    artist: role === 'framer' && ['PRICE', 'COMMISSION'].includes(str(e, 'kind')) ? { stage: str(e, 'artistStage') || '', startedAt: str(e, 'artistStartedAt'), finishedAt: str(e, 'artistFinishedAt'), sentAt: str(e, 'artistShippedAt'), courier: str(e, 'artistCourier'), awb: str(e, 'artistAwb') } : null,
    pod: j.pod ? { name: j.pod.name, at: j.pod.at, signed: !!j.pod.signKey, photos: j.pod.photoKeys?.length ?? 0 } : null,
    specs: role === 'printer' ? [['Print', str(e, 'kind') === 'GIFT' ? giftPrintSpec(det) : photoPrintSpec(det)]]
      : role === 'framer' ? [...(j.spec ? [['Frame to make', String(j.spec)]] : []), ...(printed && jobs.printer ? [['Print', `Printed by ${jobs.printer.name}: collect it from them (see below), then frame it.`]] : str(e, 'kind') === 'GIFT' ? [['Print', giftPrintSpec(det)]] : str(e, 'kind') === 'PHOTO' ? [['Print', photoPrintSpec(det)]] : []), ...FRAMER_KEYS.filter((k) => det[k]).map((k) => [k, String(det[k]).slice(0, 300)])] : [['Parcel', parcelOf(det)]],
    printJob: role === 'printer' || (role === 'framer' && printed && !jobs.printer),
    hasPhoto: role === 'printer' || (role === 'framer' && (!!str(e, 'fileKey') || ['PRICE', 'PHOTO'].includes(str(e, 'kind')))),
    // Print shop: where the print goes (the frame shop). Frame shop: where to collect the print.
    handTo: role === 'printer' ? (jobs.framer && framerProfile ? { name: String(framerProfile.business ?? jobs.framer.name), phone: String(framerProfile.phone ?? ''), address: String(framerProfile.address ?? '') } : !jobs.framer && jobs.delivery ? { name: `${jobs.delivery.name} (courier) collects it from you`, phone: '', address: 'Pack it, stick the airway bill on the parcel and hand it over: it goes straight to the customer.' } : { name: 'Kalai Art House', phone: '+971 55 299 6626', address: 'We confirm where to send the print' }) : null,
    collectFrom: role === 'framer' && jobs.printer && printerProfile ? { name: String(printerProfile.business ?? jobs.printer.name), phone: String(printerProfile.phone ?? ''), address: String(printerProfile.address ?? ''), ready: ['READY', 'COLLECTED'].includes(jobs.printer.stage) } : null,
    to: { name: str(e, 'deliveryName') || str(e, 'customerName'), phone: str(e, 'deliveryPhone') || str(e, 'phone'), address: addressText(e) },
    from: role === 'delivery' ? (selfDelivery ? { name: 'Your workshop', phone: '', address: '', ready: ['READY', 'COLLECTED'].includes(jobs.framer!.stage) } : jobs.framer && framerProfile ? { name: String(framerProfile.business ?? ''), phone: String(framerProfile.phone ?? ''), address: String(framerProfile.address ?? ''), ready: jobs.framer.stage === 'READY' || jobs.framer.stage === 'COLLECTED' }
      : jobs.printer && printerProfile ? { name: String(printerProfile.business ?? jobs.printer.name), phone: String(printerProfile.phone ?? ''), address: String(printerProfile.address ?? ''), ready: ['READY', 'COLLECTED'].includes(jobs.printer.stage) }
      : { name: 'Kalai Art House', phone: '+971 55 299 6626', address: 'Studio, Dubai (we confirm the pickup point)', ready: true }) : null,
    cancelled: str(e, 'status') === 'CANCELLED' || String(str(e, 'refundAction')).startsWith('CANCEL'),
    // Airway bill label: for the shop the courier collects from (and the courier), once the parcel is ready and a courier is allocated.
    label: (() => {
      const sr = shipRole(jobs), dj = jobs.delivery;
      if (!sr || !dj || (role !== sr && role !== 'delivery') || !['READY', 'COLLECTED'].includes(jobs[sr]!.stage)) return null;
      return { awb: dj.awb ?? '', courier: dj.name };
    })(),
    courier: role !== 'delivery' && role === shipRole(jobs) ? (jobs.delivery ? jobs.delivery.name : '') : undefined,
  };
}

let supplierAccounts: Record<string, string | null> = {};
async function supplierAccount(role: Role) {
  if (!(role in supplierAccounts)) supplierAccounts[role] = (role === 'printer' ? await optionalParam('/kalai/zoho/print_account_id') : null) ?? (await optionalParam(role === 'delivery' ? '/kalai/zoho/delivery_account_id' : '/kalai/zoho/frame_account_id')) ?? (await optionalParam('/kalai/zoho/market_account_id')) ?? (await artistAccountId());
  return supplierAccounts[role];
}

/** Supplier portal actions (the signed-in frame shop or delivery partner). */
async function supplierJobs(action: string, d: Dict, sub: string, profile: Dict) {
  const own = ROLE_OF[String(profile.type)];
  if (!own) throw new Error('Jobs are for frame shops and delivery partners.');
  // A frame shop can also hold the delivery of its own orders; a delivery partner only deliveries.
  const roles: Role[] = own === 'framer' ? ['framer', 'delivery'] : [own];
  const role: Role = d.role === 'delivery' && roles.includes('delivery') ? 'delivery' : own;
  // The other party a job needs to know: delivery/print → the frame shop; frame shop → the print shop.
  const profilesFor = async (js: Jobs, r: Role) => {
    const fp = (r === 'delivery' || r === 'printer') && js.framer ? plain(await getRow(S, { id: { S: js.framer.supplierId } })) : null;
    const pp = (r === 'framer' || (r === 'delivery' && !js.framer)) && js.printer ? plain(await getRow(S, { id: { S: js.printer.supplierId } })) : null;
    return [fp, pp] as const;
  };
  const ct = process.env.COSTING_TABLE;
  if (!ct) throw new Error('Not configured');
  const { S } = mtables();
  const supName = String(profile.business || profile.contactName || '');
  const autoNo = ['jobs', 'jobInvoice'].includes(action) ? await supplierInvoiceNo(sub, supName).catch(() => null) : null;
  if (action === 'jobs') {
    const rows = (await scanAll(ct)).map((c) => ({ id: str(c, 'enquiryId'), jobs: parseJobs(c.supplierJobs?.S) })).filter((x) => roles.some((r) => x.jobs[r]?.supplierId === sub));
    const out = [];
    for (const x of rows) {
      const e = await enquiryRow(x.id);
      if (!e) continue;
      for (const r of roles.filter((r) => x.jobs[r]?.supplierId === sub)) {
        const [fp, pp] = await profilesFor(x.jobs, r);
        out.push({ ...jobView(e, x.jobs, r, fp, pp), autoInvoiceNo: autoNo });
      }
    }
    return { role: own, jobs: out.sort((a, b) => String(b.assignedAt).localeCompare(String(a.assignedAt))) };
  }
  const id = txt(d.id, 80);
  const e = await enquiryRow(id);
  const jobs = await jobsOf(id);
  const j = jobs[role];
  if (!e || !j || j.supplierId !== sub) throw new Error('Job not found');
  const ref = str(e, 'ref'), now = new Date().toISOString(), by = String(profile.business || profile.contactName);
  const view = async () => { const fresh = await enquiryRow(id); const js = await jobsOf(id); const [fp, pp] = await profilesFor(js, role); return { job: { ...jobView(fresh!, js, role, fp, pp), autoInvoiceNo: await supplierInvoiceNo(sub, supName).catch(() => null) } }; };
  // Their invoice as recorded with us (our Zoho bill), as a PDF.
  if (action === 'jobInvoicePdf') {
    if (!j.billId) throw new Error('Your invoice is not recorded yet.');
    return zohoPdf(`/bills/${j.billId}`, `invoice-${j.invoiceNo || ref}`);
  }
  // Airway bill label data (the portal draws it with a barcode or QR code to print and stick on the parcel).
  if (action === 'jobLabel') {
    const sr = shipRole(jobs);
    if (!sr || (role !== sr && role !== 'delivery')) throw new Error('The airway bill is for the shop the courier collects from.');
    if (!['READY', 'COLLECTED'].includes(jobs[sr]!.stage)) throw new Error(sr === 'printer' ? 'Mark it printed first.' : 'Mark it framed and ready first.');
    if (!jobs.delivery) throw new Error('Kalai Art House has not allocated the courier yet: we will let you know.');
    if (await ensureAwb(jobs)) await saveJobs(id, jobs);
    return { label: await deliveryLabel(e, jobs) };
  }
  if (action === 'jobPhoto') {
    if (role === 'delivery') throw new Error('The artwork photo is for the frame shop and print shop.');
    const bucket = process.env.UPLOADS_BUCKET;
    if (!bucket) throw new Error('Not configured');
    let key = str(e, 'fileKey');
    if (!key.startsWith('uploads/') && ['PRICE', 'PHOTO'].includes(str(e, 'kind')) && process.env.PRODUCT_TABLE) {
      const det = parseDetails(detStr(e));
      const name = String(det['Artwork'] || det['Print'] || str(e, 'title')).split(' (')[0].trim().toLowerCase();
      const pr = (await scanAll(process.env.PRODUCT_TABLE)).find((x) => str(x, 'title').trim().toLowerCase() === name || (str(x, 'code') && String(det['Code'] ?? det['Artwork no.'] ?? '').includes(str(x, 'code'))));
      key = (str(e, 'kind') === 'PHOTO' && str(pr, 'printKey')) || str(pr, 'imageKey'); // prints: the full-quality print file when uploaded
    }
    if (!key) throw new Error('No photo for this order yet: ask Kalai Art House.');
    // download: the original file as uploaded (full size), saved under the order number, for printing.
    const ext = (key.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? 'jpg').toLowerCase();
    return { url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key, ...(d.download ? { ResponseContentDisposition: `attachment; filename="${ref}-to-print.${ext}"` } : {}) }), { expiresIn: 900 }) };
  }
  if (str(e, 'status') === 'CANCELLED' || String(str(e, 'refundAction')).startsWith('CANCEL')) throw new Error('This order was cancelled. Please stop.');
  const studio = (subject: string, lines: string[]) => sendMail({ to: STUDIO_EMAIL, subject, lines, button: { label: 'Open in Order Management', url: `${SITE}/admin.html#order=${id}` }, footer: 'Studio notification from art.pranixtechno.com' }).catch(() => {});
  if (action === 'jobAccept') {
    if (j.stage !== 'ASSIGNED') throw new Error('Already accepted.');
    j.stage = 'ACCEPTED'; j.acceptedAt = now;
    // The print shop has it: the order is "Printing".
    if (role === 'printer' && ['PAID'].includes(str(e, 'status'))) await updateEnquiry(id, { status: 'PRINTING' });
    // The frame shop confirms it will also deliver: the delivery job is its own.
    const delivering = role === 'framer' && j.canDeliver && !jobs.delivery && d.deliver === true;
    if (delivering) jobs.delivery = { supplierId: sub, name: by, price: j.deliveryPrice ?? null, due: j.due, note: '', stage: 'ACCEPTED', assignedAt: now, acceptedAt: now, byFramer: true };
    await saveJobs(id, jobs);
    // The frame shop has it: the order is "Being framed" (the customer is emailed). Siva's works only once he has sent them.
    if (role === 'framer' && PAID_LIKE.includes(str(e, 'status')) && (['GIFT', 'PHOTO'].includes(str(e, 'kind')) || str(e, 'artistStage') === 'SHIPPED')) await updateEnquiry(id, { status: 'FRAMING' });
    await studio(`${by} accepted ${ref}`, [`${h(by)} accepted the ${ROLE_WORD[role]} of <b>${h(str(e, 'title'))}</b> (${h(ref)})${role === 'framer' && j.canDeliver ? (delivering ? ' <b>and will deliver it too</b>' : '. They will <b>not</b> deliver it: please assign a delivery partner') : ''}.`]);
    return view();
  }
  // Print shop: printed and ready → the frame shop is told where to collect it.
  if (role === 'printer' && action === 'jobPrinted') {
    if (j.stage !== 'ACCEPTED') throw new Error(j.stage === 'ASSIGNED' ? 'Accept the job first.' : 'Already marked printed.');
    j.stage = 'READY'; j.readyAt = now;
    if (!jobs.framer) await ensureAwb(jobs).catch((err) => console.warn('AWB not made', err));
    await saveJobs(id, jobs);
    if (['PAID', 'PRINTING'].includes(str(e, 'status'))) await updateEnquiry(id, { status: 'PRINTED' });
    const cj = jobs.delivery;
    if (!jobs.framer && cj && cj.supplierId !== sub) {
      const cp = plain(await getRow(S, { id: { S: cj.supplierId } }));
      if (cp?.email) await sendMail({ to: String(cp.email), subject: `Ready for pickup: ${ref}`, lines: [`Hello ${h(cp.contactName)},`, `Order <b>${h(ref)}</b> is printed and ready for pickup at <b>${h(by)}</b>, ${h(String(profile.address ?? ''))} (${h(String(profile.phone ?? ''))}).`, cj.awb ? `Airway bill <b>${h(cj.awb)}</b> is on the parcel: scan it at pickup.` : '', 'Please collect it and mark it picked up in your portal.'].filter(Boolean), button: { label: 'Open my jobs', url: `${SITE}/supplier.html#jobs` } }).catch(() => {});
    }
    await studio(`Printed: ${ref}`, [`${h(by)} has printed <b>${h(str(e, 'title'))}</b> (${h(ref)}). Ready to collect at ${h(String(profile.address ?? ''))}.`]);
    const fj = jobs.framer;
    if (fj) {
      const fp = plain(await getRow(S, { id: { S: fj.supplierId } }));
      if (fp?.email) await sendMail({ to: String(fp.email), subject: `Print ready to collect: ${ref}`, lines: [`Hello ${h(fp.contactName)},`, `The print for order <b>${h(ref)}</b> is ready at <b>${h(by)}</b>, ${h(String(profile.address ?? ''))} (${h(String(profile.phone ?? ''))}).`, 'Please collect it and frame it as in the job.'], button: { label: 'Open my jobs', url: `${SITE}/supplier.html#jobs` } }).catch(() => {});
    }
    return view();
  }
  if (role === 'framer' && action === 'jobReady') {
    if (j.stage !== 'ACCEPTED') throw new Error(j.stage === 'ASSIGNED' ? 'Accept the job first.' : 'Already marked ready.');
    if (jobs.printer && !['READY', 'COLLECTED'].includes(jobs.printer.stage)) throw new Error(`${jobs.printer.name} hasn't marked the print ready yet.`);
    if (['PRICE', 'COMMISSION'].includes(str(e, 'kind')) && str(e, 'artistStage') !== 'SHIPPED' && str(e, 'refundAction') !== 'DAMAGED_REPLACE') throw new Error('The artist hasn\'t sent the artwork yet: you can mark it framed once it has arrived.');
    if (jobs.printer) jobs.printer.stage = 'COLLECTED';
    j.stage = 'READY'; j.readyAt = now;
    await ensureAwb(jobs).catch((err) => console.warn('AWB not made', err));
    await saveJobs(id, jobs);
    await studio(`Framed and ready: ${ref}`, [`${h(by)} has framed <b>${h(str(e, 'title'))}</b> (${h(ref)}). It is ready for pickup at ${h(String(profile.address ?? ''))}.`]);
    const dj = jobs.delivery;
    if (dj && dj.supplierId !== sub) {
      const dp = plain(await getRow(S, { id: { S: dj.supplierId } }));
      if (dp?.email) await sendMail({ to: String(dp.email), subject: `Ready for pickup: ${ref}`, lines: [`Hello ${h(dp.contactName)},`, `Order <b>${h(ref)}</b> is framed and ready for pickup at <b>${h(by)}</b>, ${h(String(profile.address ?? ''))} (${h(String(profile.phone ?? ''))}).`, 'Please collect it and mark it Picked up in your portal.'], button: { label: 'Open my jobs', url: `${SITE}/supplier.html#jobs` } }).catch(() => {});
    }
    return view();
  }
  if (role === 'delivery' && action === 'jobPicked') {
    if (!['ASSIGNED', 'ACCEPTED'].includes(j.stage)) throw new Error('Already picked up.');
    if (jobs.framer && !['READY', 'COLLECTED'].includes(jobs.framer.stage)) throw new Error(jobs.framer.supplierId === sub ? 'Mark the framing ready first.' : `${jobs.framer.name} hasn't marked it ready yet.`);
    if (!jobs.framer && jobs.printer && !['READY', 'COLLECTED'].includes(jobs.printer.stage)) throw new Error(`${jobs.printer.name} hasn't marked it printed yet.`);
    // The scanned / typed airway bill must be this parcel's (when Kalai made one).
    const typed = txt(d.awb, 60).toUpperCase();
    if (j.awb && typed && typed !== j.awb.toUpperCase()) throw new Error(`That is not this parcel's airway bill: it should be ${j.awb}.`);
    j.stage = 'PICKED'; j.pickedAt = now; j.acceptedAt = j.acceptedAt ?? now; j.awb = j.awb || typed;
    if (jobs.framer) jobs.framer.stage = 'COLLECTED';
    else if (jobs.printer) jobs.printer.stage = 'COLLECTED';
    await saveJobs(id, jobs);
    if ([...PAID_LIKE, 'FRAMING'].includes(str(e, 'status'))) await updateEnquiry(id, { status: 'SHIPPED', courierName: by, trackingNo: j.awb || ref });
    await studio(`Picked up: ${ref}`, [`${h(by)} picked up <b>${h(str(e, 'title'))}</b> (${h(ref)})${j.awb ? `, tracking ${h(j.awb)}` : ''}. The order is now Shipped and the customer has been emailed.`]);
    return view();
  }
  // Proof of delivery: who received it, their signature and/or photos (uploaded to the partner's own folder).
  const podOf = () => {
    const p = (d.pod ?? {}) as Dict;
    const name = txt(p.name, 80);
    const signKey = txt(p.signKey, 300), photoKeys = (Array.isArray(p.photoKeys) ? p.photoKeys : []).map((k) => txt(k, 300)).filter((k) => k.startsWith('uploads/')).slice(0, 4);
    if (!name) throw new Error('Proof of delivery: enter the name of the person who received it.');
    if (!signKey.startsWith('uploads/') && !photoKeys.length) throw new Error('Proof of delivery: add the receiver\'s signature or a photo of the delivered parcel.');
    return { name, at: now, ...(signKey.startsWith('uploads/') ? { signKey } : {}), ...(photoKeys.length ? { photoKeys } : {}), ...(txt(p.note, 200) ? { note: txt(p.note, 200) } : {}) };
  };
  if (role === 'delivery' && action === 'jobPod') {
    if (j.stage !== 'DELIVERED') throw new Error('Proof of delivery is added when you mark it delivered.');
    j.pod = podOf(); await saveJobs(id, jobs);
    await studio(`Proof of delivery: ${ref}`, [`${h(by)} added proof of delivery for <b>${h(str(e, 'title'))}</b> (${h(ref)}): received by <b>${h(j.pod.name)}</b>${j.pod.signKey ? ', signed' : ''}${j.pod.photoKeys?.length ? `, ${j.pod.photoKeys.length} photo(s)` : ''}.`]);
    return view();
  }
  if (role === 'delivery' && action === 'jobDelivered') {
    if (j.stage !== 'PICKED') throw new Error('Mark it picked up first.');
    j.pod = podOf();
    j.stage = 'DELIVERED'; j.deliveredAt = now;
    await saveJobs(id, jobs);
    if (str(e, 'status') === 'SHIPPED') await updateEnquiry(id, { status: 'DELIVERED' });
    await studio(`Delivered: ${ref}`, [`${h(by)} delivered <b>${h(str(e, 'title'))}</b> (${h(ref)}) to ${h(str(e, 'deliveryName') || str(e, 'customerName'))}.`, `Proof of delivery: received by <b>${h(j.pod.name)}</b>${j.pod.signKey ? ', signed' : ''}${j.pod.photoKeys?.length ? `, ${j.pod.photoKeys.length} photo(s)` : ''} (see the order's Delivery box).`]);
    return view();
  }
  if (action === 'jobInvoice') {
    const ok = role === 'delivery' ? j.stage === 'DELIVERED' : ['READY', 'COLLECTED'].includes(j.stage);
    if (!ok) throw new Error(role === 'framer' ? 'Mark it framed and ready first.' : role === 'printer' ? 'Mark it printed first.' : 'Mark it delivered first.');
    if (j.billId) throw new Error(`Invoice ${j.invoiceNo} is already with us.`);
    const amt = numIn(d.amount, 100000);
    if (!(amt > 0)) throw new Error('Enter the invoice amount in AED.');
    // Kalai numbers supplier invoices (Settings → Number series): the next number in this supplier's own series.
    const no = autoNo ? (await supplierInvoiceNo(sub, supName, true))! : txt(d.invoiceNo, 40);
    if (!no) throw new Error('Enter your invoice number.');
    j.invoiceNo = no; j.invoiceAmt = r2(amt); j.invoiceAt = now;
    try {
      const vendor = await sellerVendorId(sub);
      const testing = await testMode();
      const account = await supplierAccount(role);
      const r = await zoho('/bills', { method: 'POST', body: JSON.stringify({
        vendor_id: vendor.id, bill_number: no, reference_number: ref, date: dubaiToday(),
        line_items: [{ name: `${ROLE_WORD[role][0].toUpperCase()}${ROLE_WORD[role].slice(1)} · ${ref}`.slice(0, 100), description: `${ROLE_WORD[role][0].toUpperCase()}${ROLE_WORD[role].slice(1)} of ${str(e, 'title')} (${ref})${j.price != null ? ` · agreed AED ${j.price}` : ''}`, rate: r2(amt), quantity: 1, ...(account ? { account_id: account } : {}) }],
        notes: `Kalai Art House ${ROLE_WORD[role]} job ${ref}, invoice entered by ${by} in the supplier portal.` }) });
      if (!r.ok || !r.body.bill) throw new Error(`Zoho bill failed (${r.status}): ${r.body.message}`);
      const bill = r.body.bill;
      const state = testing ? await keepAsDraft(`/bills/${bill.bill_id}`, bill.status) : 'open';
      j.bill = bill.bill_number; j.billId = bill.bill_id; j.billState = state; j.message = '';
    } catch (err) {
      j.message = `Invoice saved; Zoho bill not created yet: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400);
      console.warn(`Supplier bill for ${ref} failed`, err);
    }
    await saveJobs(id, jobs);
    await studio(`Invoice from ${by}: ${ref}`, [`${h(by)} sent invoice <b>${h(no)}</b> for <b>${aed(j.invoiceAmt)}</b> (${ROLE_WORD[role]} of ${h(ref)})${j.price != null ? `, agreed ${aed(j.price)}` : ''}.`,
      j.billId ? `Zoho bill ${h(j.bill)} ${j.billState === 'open' ? 'created' : `created as ${h(j.billState)} (test mode)`}.` : h(j.message ?? '')]);
    return view();
  }
  throw new Error('Unknown action');
}

async function marketAdmin(ev: ApiEvent) {
  const { S, L } = mtables();
  const action = String(ev.arguments.action ?? '');
  const d = parseData(ev.arguments.data);
  if (action === 'assignJob' || action === 'removeJob') return assignJob(action, d);
  // Studio: the airway bill label of an order (the parcel to the customer, or the artist's parcel to the frame shop).
  if (action === 'adminLabel') {
    const id = txt(d.id, 80);
    const e = await enquiryRow(id);
    if (!e) throw new Error('Order not found');
    const jobs = await jobsOf(id);
    if (d.leg === 'inbound') {
      if (!jobs.inbound?.awb) throw new Error('No airway bill for the artist\'s parcel yet: it is made when the artist marks the work finished.');
      return { label: await artistLabel(e, jobs) };
    }
    return { label: await deliveryLabel(e, jobs) };
  }
  // The courier for the artist's parcel (artist → frame shop): allocated here; the artist prints the airway bill.
  if (action === 'artistCourier') {
    const id = txt(d.id, 80);
    const e = await enquiryRow(id);
    if (!e || !['PRICE', 'COMMISSION'].includes(str(e, 'kind'))) throw new Error('Order not found');
    const jobs = await jobsOf(id);
    if (str(e, 'artistStage') === 'SHIPPED' && jobs.inbound?.awb) throw new Error('The artist has already sent it with this airway bill.');
    const sid = txt(d.supplierId, 80);
    if (!sid) { delete jobs.inbound; await saveJobs(id, jobs); return { jobs }; }
    const p = plain(await getRow(S, { id: { S: sid } }));
    if (!p || p.type !== 'COURIER') throw new Error('Choose a delivery partner / courier.');
    if (p.status !== 'APPROVED') throw new Error(`${String(p.business)} is not approved yet (Artists & sellers).`);
    // Pickup: the artist's address (from their profile unless typed here).
    let from = { name: txt(d.fromName, 120), phone: txt(d.fromPhone, 30), address: txt(d.fromAddress, 300) };
    if (!from.address && str(e, 'artistId')) {
      const ap = plain(await getRow(S, { id: { S: str(e, 'artistId') } }));
      if (ap) from = { name: from.name || String(ap.business ?? ''), phone: from.phone || String(ap.phone ?? ''), address: [ap.address, ap.city, ap.emirate, ap.country].filter(Boolean).map(String).join(', ') };
    }
    const same = jobs.inbound?.supplierId === sid;
    jobs.inbound = { ...(same ? jobs.inbound : {}), supplierId: sid, name: String(p.business || p.contactName), at: new Date().toISOString(), from: { name: from.name || 'Artist', phone: from.phone, address: from.address } } as Inbound;
    if (!same) { delete jobs.inbound.awb; delete jobs.inbound.awbAt; }
    await ensureArtistAwb(e, jobs).catch((err) => console.warn('Artist AWB not made', err));
    await saveJobs(id, jobs);
    if (!same && p.email) await sendMail({ to: String(p.email), subject: `Pickup from our artist: ${str(e, 'ref')}`, lines: [`Hello ${h(p.contactName)},`, `Kalai Art House has a pickup for you: an artwork from <b>${h(jobs.inbound.from?.name)}</b>${jobs.inbound.from?.address ? `, ${h(jobs.inbound.from.address)}` : ''}, to our frame shop (order ${h(str(e, 'ref'))}).`, 'The artist sticks our airway bill on the parcel when it is ready: scan it at pickup. We will confirm the pickup time.'] }).catch(() => {});
    return { jobs };
  }
  // Studio saved a note for the artist on an order: email it to them too.
  if (action === 'artistNoteMail') {
    const e = await enquiryRow(txt(d.id, 80));
    if (!e) throw new Error('Order not found');
    const c = (await costingFor([str(e, 'id')])).get(str(e, 'id'));
    const note = str(c, 'studioNote');
    if (!note) return { sent: false };
    const p = await artistContactOf(e);
    if (!p?.email) return { sent: false, reason: 'no artist email' };
    await mailArtist(e, `Note from Kalai Art House: ${str(e, 'title')} (${str(e, 'ref')})`, [`About order <b>${h(str(e, 'ref'))}</b> (<b>${h(str(e, 'title'))}</b>):`, `<b>${h(note)}</b>`, paperLine(e) ? `Paper size: ${h(paperLine(e))}` : '']);
    return { sent: true, to: String(p.email) };
  }
  // Studio: send the customer the email for the order's current status again (e.g. the email address was added later).
  if (action === 'resendMail') {
    const e = await enquiryRow(txt(d.id, 80));
    if (!e) throw new Error('Order not found');
    const to = str(e, 'email');
    if (!to) throw new Error('No email on this order: send the update on WhatsApp.');
    const old = { ...e, status: { S: '__resend' }, adminMessage: { S: '' } } as Img;
    let mails = mailsFor({ eventName: 'MODIFY', dynamodb: { NewImage: e, OldImage: old } }).filter((m) => m.to === to);
    if (!mails.length && str(e, 'adminMessage')) mails = mailsFor({ eventName: 'MODIFY', dynamodb: { NewImage: e, OldImage: { ...e, adminMessage: { S: '' } } as Img } }).filter((m) => m.to === to);
    if (!mails.length) throw new Error('There is no customer email for this status. Add a message and save, or use WhatsApp.');
    if (!(await emailsOn())) throw new Error('Emails are switched off (Settings).');
    for (const m of mails) await sendMail(m);
    return { sent: mails.map((m) => m.subject), to };
  }
  // Sample price lists for the frame shops (studio, Pricing → Margin & charges): Dubai trade framing prices, a different
  // level per shop (so "cheapest" picks one), only in empty cells: prices a shop typed itself are kept. Not couriers.
  if (action === 'sampleFrameRates') {
    const SZ = ['A4', 'A3', '30×40', '40×50', '50×70', '60×80', '70×100'];
    // Black slim moulding incl. glass, AED (Dubai framers, trade); fixing = mount, backing and fitting.
    const BASE: Record<string, number> = { 'A4': 45, 'A3': 65, '30×40': 75, '40×50': 105, '50×70': 150, '60×80': 195, '70×100': 260 };
    const FIX: Record<string, number> = { 'A4': 15, 'A3': 20, '30×40': 22, '40×50': 30, '50×70': 40, '60×80': 50, '70×100': 65 };
    const hash = (t: string) => { let x = 2166136261; for (const ch of t) { x ^= ch.charCodeAt(0); x = Math.imul(x, 16777619); } return (x >>> 0) / 4294967295; };
    const round5 = (v: number) => Math.max(5, Math.round(v / 5) * 5);
    const now = new Date().toISOString();
    const done: { name: string; level: string; filled: number }[] = [];
    for (const p of (await scanAll(S)).map(plain).filter((x): x is Dict => !!x)) {
      if (p.type !== 'FRAMER' || /aramex/i.test(String(p.business ?? ''))) continue;
      const id = String(p.id), r = (k: string) => hash(id + k);
      const level = 0.85 + r('lvl') * 0.35; // 0.85 … 1.20 of the market
      const prem = { black: 1, white: 1 + r('w') * 0.08, oak: 1.2 + r('o') * 0.15, walnut: 1.35 + r('n') * 0.15, gold: 1.45 + r('g') * 0.2 };
      const offers = { walnut: r('nw') > 0.25, gold: r('ng') > 0.35 }; // not every shop stocks walnut or gold
      const fixLvl = 0.8 + r('f') * 0.4;
      let card: Dict = {};
      try { let v: unknown = p.rateCard; for (let i = 0; i < 2 && typeof v === 'string'; i++) v = JSON.parse(v); card = (v && typeof v === 'object' ? v : {}) as Dict; } catch { card = {}; }
      const frames = (card.frames ?? {}) as Record<string, Record<string, number>>, fixing = (card.fixing ?? {}) as Record<string, number>;
      let filled = 0;
      for (const [st, m] of Object.entries(prem)) {
        if ((st === 'walnut' && !offers.walnut) || (st === 'gold' && !offers.gold)) continue;
        for (const z of SZ) {
          if (frames[st]?.[z] != null) continue;
          (frames[st] ??= {})[z] = round5(BASE[z] * level * m * (0.97 + r(st + z) * 0.06)); filled++;
        }
      }
      if (!card.fixingIncluded) for (const z of SZ) if (fixing[z] == null) { fixing[z] = round5(FIX[z] * fixLvl); filled++; }
      if (!filled) { done.push({ name: String(p.business ?? ''), level: 'kept (already complete)', filled: 0 }); continue; }
      const next = { ...card, frames, fixing, fixingIncluded: card.fixingIncluded === true, sample: `Sample market prices filled by Kalai Art House ${now.slice(0, 10)}: please check and correct`, at: now };
      await putRow(S, { ...p, rateCard: JSON.stringify(next), updatedAt: now });
      done.push({ name: String(p.business ?? ''), level: `${Math.round(level * 100)}% of market`, filled });
    }
    return { shops: done };
  }
  // The studio adds a frame shop or delivery partner by hand (approved straight away). It works through the studio
  // view of the supplier portal until the shop signs up with the same email and takes the account over.
  // Artist prospects (outreach): not artists yet, never on the website, not in "To approve". If one signs up with the
  // same email, the record becomes theirs and they finish the artist application.
  if (action === 'addProspects') {
    const items = Array.isArray(d.items) ? (d.items as Dict[]).slice(0, 200) : [];
    const all = (await scanAll(S)).map(plain).filter((x): x is Dict => !!x);
    const now = new Date().toISOString();
    let added = 0, skipped = 0, updated = 0;
    for (const it of items) {
      const name = txt(it.name, 120), email = txt(it.email, 120).toLowerCase();
      if (!name) { skipped++; continue; }
      const ptype = ['PRINTER', 'FRAMER', 'COURIER'].includes(String(it.type)) ? String(it.type) : 'ARTIST'; // supplier prospects too (print shops to ask for quotes)
      const same = all.find((x) => x.type === ptype && ((email && String(x.email ?? '').toLowerCase() === email) || String(x.business ?? '').toLowerCase() === name.toLowerCase()));
      // Researched frame shops (India, ₹ estimates): replace an older estimate (e.g. the first one in ⃃) on the prospect
      // or approved shop with the same name, as long as the shop hasn't saved its own price list.
      if (d.refresh === true && ptype === 'FRAMER' && same && it.rateCard && typeof it.rateCard === 'object') {
        let cur: Dict = {}; try { let v: unknown = same.rateCard; for (let i = 0; i < 2 && typeof v === 'string'; i++) v = JSON.parse(v); cur = (v && typeof v === 'object' ? v : {}) as Dict; } catch { cur = {}; }
        if (String(cur.basis ?? 'est') === 'est') { await putRow(S, { ...same, rateCard: JSON.stringify({ ...(it.rateCard as Dict), at: now }), updatedAt: now }); updated++; } else skipped++;
        continue;
      }
      // Researched couriers: refresh the estimate on a prospect that hasn't entered its own prices yet, and fill only
      // the empty cells of the approved courier with the same name (e.g. Aramex → "ARAMAX"); their own prices stay.
      if (d.refresh === true && ptype === 'COURIER' && it.rateCard && typeof it.rateCard === 'object') {
        const est = it.rateCard as Dict;
        const cardOf = (x: Dict): Dict => { try { let v: unknown = x.rateCard; for (let i = 0; i < 2 && typeof v === 'string'; i++) v = JSON.parse(v); return (v && typeof v === 'object' ? v : {}) as Dict; } catch { return {}; } };
        const fill = (mine: unknown, add: unknown): unknown => {
          if (add == null || typeof add !== 'object') return mine ?? add;
          const o = { ...((mine && typeof mine === 'object' ? mine : {}) as Dict) };
          for (const [k, v] of Object.entries(add as Dict)) o[k] = fill(o[k], v);
          return o;
        };
        const appr = all.find((x) => x.type === 'COURIER' && x.status === 'APPROVED' && String(x.business ?? '').trim().toLowerCase() === txt(it.approvedName, 120).toLowerCase());
        if (appr) {
          const cur = cardOf(appr);
          const next = { ...cur, uae: fill(cur.uae, est.uae), intl: fill(cur.intl, est.intl), country: fill(cur.country, est.country), from: cur.from ?? est.from, notes: cur.notes || est.notes, at: now };
          await putRow(S, { ...appr, rateCard: JSON.stringify(next), updatedAt: now }); updated++;
          if (!same) continue; // already a supplier: no prospect row as well
        }
        if (same && same.status === 'PROSPECT' && !['list'].includes(String(cardOf(same).basis ?? ''))) {
          await putRow(S, { ...same, rateCard: JSON.stringify(est), updatedAt: now }); updated++; continue;
        }
      }
      if (same) { skipped++; continue; }
      const link = txt(it.link, 300);
      const row = { id: `pro-${crypto.randomUUID()}`, __typename: 'SellerProfile', createdAt: now, updatedAt: now, appliedAt: now,
        type: ptype, status: 'PROSPECT', business: name, ...(ptype !== 'ARTIST' ? { address: txt(it.based, 300) || undefined, rateCard: it.rateCard ? JSON.stringify(it.rateCard) : undefined } : {}), contactName: name, email: email || undefined, phone: txt(it.phone, 40) || undefined,
        city: txt(it.based, 80) || undefined, country: /india/i.test(String(it.based ?? '')) ? 'India' : /oman/i.test(String(it.based ?? '')) ? 'Oman' : 'UAE',
        mediums: txt(it.work, 200) || undefined, about: txt(it.work, 2000) || undefined, portfolio: /^https?:\/\//i.test(link) ? link : undefined,
        adminNote: [txt(it.fit, 120) && `Fit: ${txt(it.fit, 120)}`, txt(it.how, 160) && `Reach: ${txt(it.how, 160)}`, txt(it.source, 120) && `Found via: ${txt(it.source, 120)}`].filter(Boolean).join(' · ') || undefined,
        outreach: txt(it.status, 40) || 'To contact', commissionPct: 0, sampleKeys: '[]' };
      await putRow(S, row); all.push(row); added++;
    }
    return { added, skipped, updated };
  }
  if (action === 'prospectUpdate' || action === 'removeProspect') {
    const p = plain(await getRow(S, { id: { S: txt(d.id, 80) } }));
    if (!p || p.status !== 'PROSPECT') throw new Error('Prospect not found');
    if (action === 'removeProspect') { await delRow(S, { id: { S: String(p.id) } }); return { removed: true }; }
    const row = { ...p, outreach: txt(d.outreach, 40) || p.outreach, outreachAt: new Date().toISOString(), adminNote: d.note !== undefined ? txt(d.note, 500) : p.adminNote, email: d.email !== undefined ? txt(d.email, 120).toLowerCase() || undefined : p.email, phone: d.phone !== undefined ? txt(d.phone, 40) || undefined : p.phone, updatedAt: new Date().toISOString() };
    await putRow(S, row);
    return { profile: row };
  }
  // A supplier prospect (e.g. a print shop that sent its quote) becomes an approved supplier, without the sign-up email:
  // it works through the studio view of the supplier portal until the shop signs up with the same email.
  // Studio edits any profile's details (status, type and approvals unchanged).
  if (action === 'editProfile') {
    const p = plain(await getRow(S, { id: { S: txt(d.id, 80) } }));
    if (!p) throw new Error('Profile not found');
    const f: Dict = {
      business: txt(d.business, 120), contactName: txt(d.contactName, 80), phone: txt(d.phone, 30), email: txt(d.email, 120).toLowerCase(), emirate: txt(d.emirate, 60),
      address: txt(d.address, 300), about: txt(d.about, 2000), tradeLicence: txt(d.tradeLicence, 60), portfolio: txt(d.portfolio, 300),
      bankName: txt(d.bankName, 80), accountName: txt(d.accountName, 120), iban: txt(d.iban, 40).toUpperCase().replace(/\s+/g, ''),
    };
    if (!f.business) throw new Error('Add the business / artist name.');
    if (f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(f.email))) throw new Error('Check the email address.');
    if (f.portfolio && !/^https?:\/\//i.test(String(f.portfolio))) f.portfolio = `https://${f.portfolio}`;
    if (f.iban && (p.country || 'UAE') === 'UAE' && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(String(f.iban))) throw new Error('Check the IBAN (e.g. AE07 0331 2345 6789 0123 456).');
    const row: Dict = { ...p, ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v || undefined])), updatedAt: new Date().toISOString() };
    await putRow(S, row);
    if (row.status === 'APPROVED' && row.type === 'ARTIST') await publishArtist(row);
    return { profile: row };
  }
  // Studio: add or take off Kalai Circle points for a customer (with a reason in the history).
  if (action === 'adjustPoints') {
    const cfg = await loyCfg();
    const code = txt(d.code, 20), pts = Math.round(Number(d.points));
    if (!code || !pts) throw new Error('Choose the customer and the points (+ or −).');
    const row = await loyAdd(code, pts, 'adjust', txt(d.note, 120) || 'Studio', cfg);
    return { points: row?.loyaltyPoints ?? 0, tier: row?.loyaltyTier ?? '' };
  }
  if (action === 'decideProgramme') return progDecide(d);
  if (action === 'promoteSupplier') {
    const p = plain(await getRow(S, { id: { S: txt(d.id, 80) } }));
    if (!p || p.status !== 'PROSPECT' || !ROLE_OF[String(p.type)]) throw new Error('Supplier prospect not found');
    const now = new Date().toISOString();
    const row = { ...p, status: 'APPROVED', approvedAt: now, updatedAt: now, outreach: 'Supplier' };
    await putRow(S, row);
    return { profile: row };
  }
  if (action === 'inviteArtist') {
    const p = plain(await getRow(S, { id: { S: txt(d.id, 80) } }));
    if (!p || p.status !== 'PROSPECT') throw new Error('Prospect not found');
    if (!p.email) throw new Error('Add their email first.');
    await sendMail({ to: String(p.email), subject: 'Invitation to list your work with Kalai Art House, Dubai',
      lines: [`Dear ${h(p.business)},`,
        "I'm Anis, founder of Kalai Art House in Dubai (art.pranixtechno.com). I came across your work and would love to have it in our gallery.",
        'We are an online gallery for original paintings, watercolours and sketches, and we take portrait commissions from customers\' photos. You set your own price for each work and receive it in full; we list it, frame it in Dubai, deliver it, collect the payment and pay you. Optionally, you earn a royalty on framed prints of your works.',
        `If you'd like to join, please create an account with this email address (${h(p.email)}) and complete the short artist application with a few sample photos. We review every application personally.`,
        txt(d.note, 500) ? h(txt(d.note, 500)) : ''].filter(Boolean),
      button: { label: 'Apply as an artist', url: `${SITE}/seller.html?as=artist` }, footer: 'Kalai Art House · Pranix Technologies FZCO, Dubai · +971 55 299 6626' });
    const row = { ...p, outreach: 'Contacted', outreachAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await putRow(S, row);
    return { sent: true, profile: row };
  }
  if (action === 'inviteSupplier') {
    const p = plain(await getRow(S, { id: { S: txt(d.id, 80) } }));
    if (!p || !ROLE_OF[String(p.type)]) throw new Error('Supplier not found');
    if (!p.email) throw new Error('Add their email first.');
    const fr = p.type === 'FRAMER';
    await sendMail({ to: String(p.email), subject: `Kalai Art House: your ${fr ? 'frame shop' : 'delivery partner'} portal`,
      lines: [`Hello ${h(p.contactName || p.business)},`,
        `Kalai Art House (art.pranixtechno.com, Dubai) is launching shortly, and we would like to work with <b>${h(p.business)}</b> as a ${fr ? 'framing' : 'delivery'} partner.`,
        `Please open our supplier portal and <b>create an account with this email address</b> (${h(p.email)}): your business is already set up there.`,
        fr ? 'Then add your <b>price list</b>: frame price per style and size, the fixing charge (or included), and your delivery charge if you also deliver.' : 'Then add your <b>delivery charges</b> to each emirate, by frame size.',
        'Every job we give you appears there with the photo, size, address and agreed price; you update each step and enter your invoice, and we pay against it.',
        txt(d.note, 500) ? h(txt(d.note, 500)) : ''].filter(Boolean),
      button: { label: 'Open the supplier portal', url: `${SITE}/supplier.html` } });
    return { sent: true };
  }
  if (action === 'addSupplier') {
    const type = d.type === 'COURIER' ? 'COURIER' : d.type === 'PRINTER' ? 'PRINTER' : 'FRAMER';
    const f = { business: txt(d.business, 120), contactName: txt(d.contactName, 80), phone: txt(d.phone, 30), email: txt(d.email, 120).toLowerCase(), emirate: txt(d.emirate, 60) || 'Dubai',
      address: txt(d.address, 300), about: txt(d.about, 2000), tradeLicence: txt(d.tradeLicence, 60), bankName: txt(d.bankName, 80), accountName: txt(d.accountName, 120), iban: txt(d.iban, 40).toUpperCase().replace(/\s+/g, ''),
      portfolio: txt(d.website, 300) && !/^https?:\/\//i.test(txt(d.website, 300)) ? `https://${txt(d.website, 300)}` : txt(d.website, 300) };
    if (!f.business) throw new Error('Add the business name.');
    if (f.phone.replace(/\D/g, '').length < 9) throw new Error('Add their mobile or phone number.');
    if (f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) throw new Error('Check the email address.');
    if (f.email && (await scanAll(S)).some((x) => str(x, 'email').toLowerCase() === f.email)) throw new Error('A supplier, artist or seller with this email already exists.');
    const now = new Date().toISOString();
    const row = { ...f, id: `sup-${crypto.randomUUID()}`, type, country: 'UAE', status: 'APPROVED', appliedAt: now, approvedAt: now, adminNote: 'Added by the studio', commissionPct: 0, __typename: 'SellerProfile', createdAt: now, updatedAt: now };
    await putRow(S, row);
    return { profile: row };
  }
  const now = new Date().toISOString();
  const id = txt(d.id, 80);
  if (action.endsWith('Seller')) {
    const p = plain(await getRow(S, { id: { S: id } }));
    if (!p) throw new Error('Seller not found');
    if (action === 'approveSeller') {
      const pct = numIn(d.commissionPct, 90), fee = numIn(d.kalaiDeliveryFee, 1000);
      const wasApproved = p.status === 'APPROVED';
      const extra: Dict = {};
      if (p.type === 'ARTIST' && d.royaltyPct !== undefined && d.royaltyPct !== '') extra.royaltyPct = numIn(d.royaltyPct, 50);
      if (p.type === 'ARTIST' && d.licenceRoyaltyPct !== undefined && d.licenceRoyaltyPct !== '') extra.licenceRoyaltyPct = numIn(d.licenceRoyaltyPct, 90);
      if (typeof d.photoKey === 'string' && /^market\//.test(d.photoKey)) extra.photoKey = txt(d.photoKey, 300);
      const row = { ...p, ...extra, status: 'APPROVED', commissionPct: pct, kalaiDeliveryFee: fee, approvedAt: p.approvedAt ?? now, adminNote: txt(d.note, 500), updatedAt: now };
      await putRow(S, row);
      if (p.type === 'ARTIST') {
        await publishArtist(row);
        // Their approved works are catalogue works (priced in Pricing); keep them in step, with the print royalty.
        for (const x of (await scanAll(L)).filter((x) => str(x, 'sellerId') === id && str(x, 'status') === 'APPROVED')) await upsertArtistProduct(plain(x)!, row, false);
        if (extra.royaltyPct !== undefined && process.env.PRODUCT_TABLE) {
          for (const pr of (await scanAll(process.env.PRODUCT_TABLE)).filter((x) => str(x, 'artistId') === id)) {
            await ddb.send(new UpdateItemCommand({ TableName: process.env.PRODUCT_TABLE, Key: { id: { S: str(pr, 'id') } }, UpdateExpression: 'SET printRoyalty = :r', ExpressionAttributeValues: { ':r': { N: String(extra.royaltyPct) } } }));
          }
          // Their print orders not yet delivered that were placed without a royalty: give them this one.
          if (process.env.ENQUIRY_TABLE) for (const e of (await scanAll(process.env.ENQUIRY_TABLE)).filter((x) => str(x, 'kind') === 'PHOTO' && str(x, 'artistId') === id && !num(x, 'royaltyPct') && !['DELIVERED', 'REFUNDED', 'CANCELLED'].includes(str(x, 'status')))) await writeBack(str(e, 'id'), { royaltyPct: Number(extra.royaltyPct) });
        }
      }
      if (wasApproved) return { profile: row }; // saving rates: no welcome email again
      if (ROLE_OF[String(p.type)]) {
        await sendMail({ to: String(p.email ?? ''), subject: `Your Kalai Art House ${ROLE_LABEL[ROLE_OF[String(p.type)]]} account is approved`, lines: [`Hello ${h(p.contactName)},`,
          `Welcome to Kalai Art House as a ${ROLE_LABEL[ROLE_OF[String(p.type)]]}. When we have a ${ROLE_WORD[ROLE_OF[String(p.type)]]} job for you, you get an email and it appears under My jobs in your supplier portal, with the agreed price.`,
          'Accept it there, update each step, and enter your invoice when done: we pay against it.'], button: { label: 'Open the supplier portal', url: `${SITE}/supplier.html` } }).catch(() => {});
      } else
      await sendMail({ to: String(p.email ?? ''), subject: `Your Kalai Art House ${p.type === 'ARTIST' ? 'artist' : 'seller'} account is approved`, lines: [`Hello ${h(p.contactName)},`, p.type === 'ARTIST' ? 'Welcome to Kalai Art House as one of our artists. You receive your full price for each work sold; we frame, price and deliver it.' : `Welcome to Kalai Art House. Your commission rate is <b>${pct}%</b> of your price${fee ? `, plus AED ${fee} when Kalai delivers` : ''}; it is added on top, so you receive your full price.`, p.type === 'ARTIST' ? 'You can now list your artworks with their price. Each one is checked by us before it goes live.' : 'You can now add your products. Each listing is checked by us before it goes live.'], button: { label: 'Open the seller portal', url: `${SITE}/seller.html` } }).catch(() => {});
      return { profile: row };
    }
    // Delete an artist / seller / supplier for good (e.g. a duplicate account). Only when not active and with no orders:
    // their unpublished listings and catalogue copies go too. Someone with orders stays (Suspended) so the history is kept.
    if (action === 'deleteSeller') {
      if (p.status === 'APPROVED') throw new Error('Suspend them first, then delete.');
      const ET = process.env.ENQUIRY_TABLE;
      const orders = ET ? (await scanAll(ET)).filter((e) => str(e, 'artistId') === id || str(e, 'sellerId') === id) : [];
      if (orders.length) throw new Error(`They have ${orders.length} order${orders.length === 1 ? '' : 's'} (${orders.slice(0, 3).map((e) => str(e, 'ref')).join(', ')}${orders.length > 3 ? '…' : ''}), so they can't be deleted: keep them suspended to keep the history.`);
      const jobsWith = process.env.COSTING_TABLE ? (await scanAll(process.env.COSTING_TABLE)).filter((c) => Object.values(parseJobs(c.supplierJobs?.S)).some((j) => j && (j as { supplierId?: string }).supplierId === id)) : [];
      if (jobsWith.length) throw new Error(`They have ${jobsWith.length} supplier job${jobsWith.length === 1 ? '' : 's'} on orders, so they can't be deleted: keep them suspended.`);
      await unpublishArtist(id).catch(() => {});
      let gone = 0;
      for (const x of (await scanAll(L)).filter((x) => str(x, 'sellerId') === id)) {
        await unpublishItem(str(x, 'id')).catch(() => {}); await hideArtistProduct(str(x, 'id')).catch(() => {});
        await delRow(L, { id: { S: str(x, 'id') } }); gone++;
      }
      await delRow(S, { id: { S: id } });
      console.log(`Deleted ${p.type} ${p.business} (${id}) and ${gone} listing(s)`);
      return { deleted: true, listings: gone };
    }
    if (action === 'rejectSeller' || action === 'suspendSeller') {
      const row = { ...p, status: action === 'rejectSeller' ? 'REJECTED' : 'SUSPENDED', adminNote: txt(d.note, 500), updatedAt: now };
      await putRow(S, row);
      await unpublishArtist(id);
      if (action === 'suspendSeller') for (const x of (await scanAll(L)).filter((x) => str(x, 'sellerId') === id && str(x, 'status') === 'APPROVED')) { await putRow(L, { ...plain(x), status: 'PAUSED', updatedAt: now }); await unpublishItem(str(x, 'id')); await hideArtistProduct(str(x, 'id')); }
      await sendMail({ to: String(p.email ?? ''), subject: action === 'rejectSeller' ? 'About your Kalai Art House seller application' : 'Your Kalai Art House seller account is paused', lines: [`Hello ${h(p.contactName)},`, action === 'rejectSeller' ? 'Thank you for applying. We are not able to accept your application at the moment.' : 'Your listings are paused for now.', txt(d.note, 500) ? h(txt(d.note, 500)) : ''], button: { label: 'Open the seller portal', url: `${SITE}/seller.html` } }).catch(() => {});
      return { profile: row };
    }
  }
  const l = plain(await getRow(L, { id: { S: id } }));
  if (!l) throw new Error('Listing not found');
  const seller = plain(await getRow(S, { id: { S: String(l.sellerId) } }));
  if (action === 'approveListing') {
    if (seller?.status !== 'APPROVED') throw new Error('The seller is not approved.');
    const commissionPct = d.commissionPct !== undefined && d.commissionPct !== '' ? numIn(d.commissionPct, 90) : Number(l.commissionPct ?? seller.commissionPct ?? 0);
    const kalaiDeliveryFee = Number(seller.kalaiDeliveryFee ?? 0);
    const p = priceOf({ costPrice: Number(l.costPrice), markupPct: Number(l.markupPct), courierCharge: Number(l.courierCharge), otherCharges: Number(l.otherCharges), deliveryBy: String(l.deliveryBy), commissionPct, kalaiDeliveryFee });
    const row = { ...l, commissionPct, kalaiDeliveryFee, sellerPrice: p.sellerPrice, customerPrice: p.customerPrice, status: 'APPROVED', approvedAt: now, adminNote: txt(d.note, 500), updatedAt: now };
    await putRow(L, row);
    if (seller.type === 'ARTIST') {
      // Artists: into the collection through Pricing (frames and sizes), not as a fixed-price item.
      await unpublishItem(id);
      await upsertArtistProduct(row, seller);
      await sendMail({ to: String(seller.email ?? ''), subject: `Approved: ${l.title}`, lines: [`Hello ${h(seller.contactName)},`, `<b>${h(l.title)}</b> is approved. We are setting its framed prices and it will be on the website shortly, in our collection.`, `You receive AED ${p.sellerPrice} when it sells. We frame and deliver it.`] }).catch(() => {});
      return { listing: row, price: p };
    }
    await publishItem(row);
    await sendMail({ to: String(seller.email ?? ''), subject: `Live on Kalai Art House: ${l.title}`, lines: [`Hello ${h(seller.contactName)},`, `<b>${h(l.title)}</b> is now on the website at AED ${p.customerPrice}. You receive AED ${p.sellerPrice} for each sale.`], button: { label: 'Open the seller portal', url: `${SITE}/seller.html` } }).catch(() => {});
    return { listing: row, price: p };
  }
  if (action === 'rejectListing' || action === 'unpublishListing') {
    const row = { ...l, status: action === 'rejectListing' ? 'REJECTED' : 'PAUSED', adminNote: txt(d.note, 500), updatedAt: now };
    await putRow(L, row);
    await unpublishItem(id);
    await hideArtistProduct(id);
    if (action === 'rejectListing') await sendMail({ to: String(seller?.email ?? ''), subject: `Changes needed: ${l.title}`, lines: [`Hello ${h(seller?.contactName ?? '')},`, `We could not publish <b>${h(l.title)}</b> yet.`, txt(d.note, 500) ? `<b>Our note:</b> ${h(txt(d.note, 500))}` : '', 'Edit it in the seller portal and submit it again.'], button: { label: 'Open the seller portal', url: `${SITE}/seller.html` } }).catch(() => {});
    return { listing: row };
  }
  throw new Error('Unknown action');
}


// ---------- Crafts shop orders ----------
// Customer orders on the website (marketOrder) → Enquiry kind MARKET at the listing's price, status Received.
// Studio sends the payment link (Price sent) and marks Paid as usual → invoice. Then marketSteps:
//   Paid      → the maker's order is recorded, stock goes down, the maker is emailed (address only if they deliver).
//   Maker     → "Ready for pickup" (Kalai delivers) or "Dispatched" with courier + AWB (status Shipped, challan).
//   Delivered → the maker's payout bill in Zoho (bill no. <ref>-MP); studio's bank ref → payment made (live only).
//   Cancelled with a refund before dispatch → the maker's order is cancelled and the stock put back.
function newRef() {
  const d = new Date(Date.now() + 4 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `KA-${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

async function marketOrder(ev: ApiEvent) {
  const { S, L } = mtables();
  const table = process.env.ENQUIRY_TABLE;
  if (!table) throw new Error('Not configured');
  const me = who(ev);
  const d = parseData(ev.arguments.data);
  const l = plain(await getRow(L, { id: { S: txt(d.listingId, 60) } }));
  if (!l || l.status !== 'APPROVED') throw new Error('Sorry, this item is no longer available.');
  const seller = plain(await getRow(S, { id: { S: String(l.sellerId) } }));
  if (seller?.status !== 'APPROVED') throw new Error('Sorry, this item is no longer available.');
  const qty = Math.max(1, Math.floor(numIn(d.qty, 99)));
  if (qty > Number(l.stock ?? 0)) throw new Error(Number(l.stock ?? 0) > 0 ? `Only ${l.stock} left in stock.` : 'Sorry, this item is out of stock.');
  const { name, phone, country, region: emirate, pin, address, landmark } = checkAddress(d);
  const unit = Number(l.customerPrice), listTotal = r2(unit * qty), sellerAmount = r2(Number(l.sellerPrice) * qty);
  // Discount code (Kalai's commission absorbs it: the maker still receives their full price).
  let total = listTotal;
  let promo: { code: string; amount: number } | null = null;
  const code = txt(d.code, 30).toUpperCase();
  if (code) {
    const f = await findPromo(code);
    if (!f || 'error' in f) throw new Error(f?.error ?? 'This code is not valid.');
    const dd = discountFor(f.p, 'MARKET', listTotal);
    if (dd.error) throw new Error(dd.error);
    promo = { code, amount: dd.amount };
    total = r2(listTotal - dd.amount);
  }
  const ref = newRef();
  const now = new Date().toISOString();
  // Artist names are not shown to customers: their order says "Artist" (the studio still sees the name in sellerName).
  const details = { Item: String(l.title), Maker: seller.type === 'ARTIST' ? 'Artist' : String(l.sellerName ?? seller.business), Quantity: String(qty), 'Unit price': `AED ${unit}`, Delivery: l.deliveryBy === 'KALAI' ? 'Kalai Art House delivers' : 'The maker delivers', Country: country === 'India' ? 'India: add the shipping to India to the price before sending the payment link' : '', Note: txt(d.note, 300) };
  const row: Dict = {
    id: crypto.randomUUID(), __typename: 'Enquiry', createdAt: now, updatedAt: now, owner: me.owner,
    ref, kind: 'MARKET', title: String(l.title), details: JSON.stringify(details), status: 'RECEIVED',
    customerName: txt(d.customerName, 80) || name, phone, email: me.email, quotedPrice: total,
    deliveryName: name, deliveryPhone: phone, deliveryCountry: country, deliveryEmirate: emirate, deliveryPin: pin, deliveryAddress: address, deliveryLandmark: landmark, addressAt: now, addressBy: 'Customer',
    listingId: String(l.id), sellerId: String(l.sellerId), sellerName: String(l.sellerName ?? seller.business), qty, unitPrice: unit, deliveryBy: String(l.deliveryBy),
    sellerAmount, commissionPct: Number(l.commissionPct ?? 0),
    ...(promo ? { listPrice: listTotal, discountAmount: promo.amount, discountCode: promo.code } : {}),
  };
  await ddb.send(new PutItemCommand({ TableName: table, Item: toAttrs(row), ConditionExpression: 'attribute_not_exists(id)' }));
  if (promo) await bumpUses(promo.code, 1);
  console.log(`Crafts shop order ${ref}: ${l.title} × ${qty} = AED ${total}${promo ? ` (code ${promo.code} −${promo.amount})` : ''}`);
  return { ok: true, ref, total };
}

/** Licence royalty % for a work: the work's own, else its portal artist's, else Siva's (Pricing); 30% by default. */
async function licenceRoyaltyOf(pr: Dict | Img): Promise<number> {
  const g = (k: string) => { const v = (pr as Dict)[k]; return v && typeof v === 'object' && ('N' in (v as object) || 'S' in (v as object)) ? Number((v as { N?: string; S?: string }).N ?? (v as { S?: string }).S) : v; };
  const own = Number(g('licenceRoyalty') ?? NaN);
  if (own >= 0 && g('licenceRoyalty') != null && g('licenceRoyalty') !== '') return own;
  const aid = String(g('artistId') ?? '');
  if (aid) { const { S } = mtables(); const a = plain(await getRow(S, { id: { S: aid } })); if (a?.licenceRoyaltyPct != null) return Number(a.licenceRoyaltyPct); return 30; }
  try { const row = plain(await getRow(process.env.RATES_TABLE!, { key: { S: 'default' } })); let rd: unknown = row?.data; for (let i = 0; i < 2 && typeof rd === 'string'; i++) rd = JSON.parse(rd); const v = (rd as { sivaLicenceRoyalty?: number } | undefined)?.sivaLicenceRoyalty; return v != null ? Number(v) : 30; } catch { return 30; }
}
/** Print royalty % for a work: the work's own, else its portal artist's (Artists & sellers), else Siva's (Pricing). */
async function printRoyaltyOf(pr: Img): Promise<number> {
  const own = num(pr, 'printRoyalty');
  if (own) return own;
  if (str(pr, 'artistId')) { const { S } = mtables(); const a = plain(await getRow(S, { id: { S: str(pr, 'artistId') } })); return Number(a?.royaltyPct ?? 0) || 0; }
  try { const row = plain(await getRow(process.env.RATES_TABLE!, { key: { S: 'default' } })); let rd: unknown = row?.data; for (let i = 0; i < 2 && typeof rd === 'string'; i++) rd = JSON.parse(rd); return Number((rd as { sivaRoyalty?: number } | undefined)?.sivaRoyalty ?? 10) || 0; } catch { return 10; }
}

// ---------- Website cart: checkout of several items, one payment ----------
// Each item still becomes its own order (artist, frame shop, supplier and tracking work as before); the orders share a
// basket reference. Prices are worked out here from the catalogue, the Settings and the listings, never taken from the
// browser. Delivery in the UAE: the orders start at "Price sent" with ONE Ziina payment for the whole basket. Abroad,
// or a Little Artists gift with overseas shipping: the orders start at "Received" and the studio quotes the shipping.
const CART_FRAMES: Record<string, string> = { none: 'No frame', black: 'Black slim', white: 'White', oak: 'Natural oak', walnut: 'Walnut', gold: 'Gold' };
const PRINT_SIZES: [string, string, number, number][] = [['A4', 'A4 (21 × 30 cm)', 169, 59], ['A3', 'A3 (30 × 42 cm)', 249, 79], ['40×50', '40 × 50 cm', 299, 99], ['50×70', '50 × 70 cm', 399, 139], ['60×80', '60 × 80 cm', 499, 179]];
const PRINT_FRAMES: Record<string, string> = { black: 'Black frame', white: 'White frame', wood: 'Natural wood frame', none: 'Print only (no frame)' };
const KIDS_EXTRAS: Record<string, [string, number]> = { premium: ['Premium frame', 45], large: ['Larger A3 frame', 35], copy: ['A second framed copy', 59], wrap: ['Gift wrap', 15] };
const KIDS_EMIRATE: Record<string, number> = { Dubai: 25, Sharjah: 25, Ajman: 25, 'Abu Dhabi': 35, 'Ras Al Khaimah': 35, 'Umm Al Quwain': 35, Fujairah: 35 };
const SHIP_ZONE: Record<string, string[]> = { A: ['Saudi Arabia', 'Oman', 'Qatar', 'Bahrain', 'Kuwait'], B: ['India', 'Sri Lanka', 'Pakistan', 'Bangladesh', 'Nepal', 'Maldives', 'Bhutan'],
  C: ['United Kingdom', 'Ireland', 'France', 'Germany', 'Italy', 'Spain', 'Portugal', 'Netherlands', 'Belgium', 'Luxembourg', 'Switzerland', 'Austria', 'Denmark', 'Sweden', 'Norway', 'Finland', 'Iceland', 'Poland', 'Czechia', 'Slovakia', 'Hungary', 'Slovenia', 'Croatia', 'Romania', 'Bulgaria', 'Greece', 'Cyprus', 'Malta', 'Estonia', 'Latvia', 'Lithuania', 'Monaco', 'Liechtenstein', 'Andorra', 'San Marino', 'Vatican City', 'Jersey', 'Guernsey', 'Isle of Man', 'Gibraltar', 'Serbia', 'Bosnia and Herzegovina', 'Montenegro', 'North Macedonia', 'Albania', 'Kosovo', 'Moldova', 'Ukraine'],
  D: ['United States', 'Canada', 'Australia', 'New Zealand'] };
const zoneOfCountry = (c: string) => Object.keys(SHIP_ZONE).find((z) => SHIP_ZONE[z].includes(c)) ?? 'E';
type CartLine = { kind: string; title: string; details: Dict; price: number; quote: boolean; extra: Dict; gift?: boolean; fileKey?: string };
/** A Product's website price for a frame and frame size (same table as the website: Pricing → price matrix). */
function matrixPrice(p: Dict, frame: string, size: string): number | null {
  let m: Dict; try { m = JSON.parse(String(p.priceMatrix ?? '')); } catch { return null; }
  if (!m) return null;
  if (m.v === 2) { if (frame === 'none') return Number(m.none) || null; const sizes = (m.sizes ?? {}) as Record<string, Dict>; const row = sizes[size] ?? sizes[String(m.base)]; return row ? Number(row[frame]) || null : null; }
  return Number(m[frame]) || null;
}
async function cartLine(it: Dict, site: Dict | null, used: Set<string>): Promise<CartLine> {
  const t = txt(it.t, 10);
  if (t === 'ART') {
    const P = process.env.PRODUCT_TABLE!;
    const p = plain(await getRow(P, { id: { S: txt(it.pid, 80) } }));
    if (!p || p.status !== 'PUBLISHED' || p.kind === 'photo') throw new Error(`Sorry, "${txt(it.name, 60) || 'an artwork'}" is no longer available. Please remove it from your cart.`);
    if (used.has(String(p.id))) throw new Error(`"${txt(it.name, 60)}" is in your cart twice: each work is one of a kind.`);
    used.add(String(p.id));
    const frame = CART_FRAMES[txt(it.frame, 10)] ? txt(it.frame, 10) : 'none';
    let m: Dict = {}; try { m = JSON.parse(String(p.priceMatrix ?? '{}')) ?? {}; } catch { m = {}; }
    const size = txt(it.size, 20) || String(m.base ?? '');
    const price = matrixPrice(p, frame, size);
    if (!price) throw new Error(`"${txt(it.name, 60)}" has no website price for this frame. Please ask us for the price instead.`);
    const name = txt(it.name, 120) || String(p.title ?? 'Artwork');
    const det: Dict = { Artwork: `${name} (${[p.medium, p.size].filter(Boolean).join(', ')})`, 'Artwork no.': String(p.code ?? ''), Framing: frame === 'none' ? 'Unframed' : `${CART_FRAMES[frame]} frame${size ? ` ${size} cm` : ''}, white mount`, Price: `AED ${price} (website price)` };
    if (txt(it.tried, 120)) det['Frame tried on the website'] = txt(it.tried, 120);
    if (it.inst) det.Payment = 'Asked about instalments';
    if (txt(it.msg, 300)) det['Note on this work'] = txt(it.msg, 300);
    return { kind: 'PRICE', title: name, details: det, price, quote: false, extra: {} };
  }
  if (t === 'PRINT') {
    const P = process.env.PRODUCT_TABLE!;
    const p = plain(await getRow(P, { id: { S: txt(it.pid, 80) } }));
    if (!p || !['PUBLISHED', 'SOLD'].includes(String(p.status)) || (p.kind !== 'photo' && !p.printable)) throw new Error(`Sorry, the print "${txt(it.name, 60)}" is no longer available.`);
    const sizes = (() => { const i = PRINT_SIZES.findIndex((z) => z[0] === p.printMax); return i >= 0 ? PRINT_SIZES.slice(0, i + 1) : PRINT_SIZES; })();
    const z = sizes.find((x) => x[0] === txt(it.size, 10));
    if (!z) throw new Error(`Choose another size for "${txt(it.name, 60)}".`);
    const fr = PRINT_FRAMES[txt(it.frame, 10)] ? txt(it.frame, 10) : 'black';
    let pp: Record<string, Dict> = {}; try { pp = JSON.parse(String(site?.photoPrices ?? '{}')) ?? {}; } catch { pp = {}; }
    const sp = pp[z[0]] ?? {};
    const base = fr === 'none' ? Number(sp.print ?? z[3]) : Number(sp.framed ?? z[2]);
    const roy = p.kind === 'photo' ? 0 : Number(p.printRoyalty ?? 0);
    const unit = roy ? Math.ceil(base * (1 + roy / 100) / 5) * 5 : base;
    const qty = Math.max(1, Math.min(5, Math.floor(numIn(it.qty, 5)) || 1));
    const name = txt(it.name, 120) || String(p.title ?? 'Print');
    const det: Dict = { Print: name + (p.kind === 'photo' ? '' : ' (print of the painting)'), 'Artwork no.': String(p.code ?? ''), Size: z[1], Frame: fr === 'none' ? PRINT_FRAMES.none : PRINT_FRAMES[fr] + (it.mount === false ? '' : ', white mount'), Copies: String(qty), 'Delivery charge': 'included in the UAE', Total: `AED ${(unit * qty).toLocaleString('en-US')}` };
    return { kind: 'PHOTO', title: `Framed print: ${name} (${z[1].split(' (')[0]})`, details: det, price: r2(unit * qty), quote: false, extra: {} };
  }
  if (t === 'CRAFT') {
    const { S, L } = mtables();
    const l = plain(await getRow(L, { id: { S: txt(it.listingId, 60) } }));
    const seller = l ? plain(await getRow(S, { id: { S: String(l.sellerId) } })) : null;
    if (!l || l.status !== 'APPROVED' || seller?.status !== 'APPROVED') throw new Error(`Sorry, "${txt(it.name, 60) || 'an item'}" is no longer available.`);
    const qty = Math.max(1, Math.floor(numIn(it.qty, 99)) || 1);
    if (qty > Number(l.stock ?? 0)) throw new Error(Number(l.stock ?? 0) > 0 ? `Only ${l.stock} left of "${l.title}".` : `Sorry, "${l.title}" is out of stock.`);
    const unit = Number(l.customerPrice);
    const det: Dict = { Item: String(l.title), Maker: seller.type === 'ARTIST' ? 'Artist' : String(l.sellerName ?? seller.business), Quantity: String(qty), 'Unit price': `AED ${unit}`, Delivery: l.deliveryBy === 'KALAI' ? 'Kalai Art House delivers' : 'The maker delivers' };
    return { kind: 'MARKET', title: String(l.title), details: det, price: r2(unit * qty), quote: false,
      extra: { listingId: String(l.id), sellerId: String(l.sellerId), sellerName: String(l.sellerName ?? seller.business), qty, unitPrice: unit, deliveryBy: String(l.deliveryBy), sellerAmount: r2(Number(l.sellerPrice) * qty), commissionPct: Number(l.commissionPct ?? 0) } };
  }
  if (t === 'GIFT') {
    const f = (it.f ?? {}) as Dict;
    const age = Math.max(3, Math.min(17, Math.floor(numIn(f.age, 17)) || 6));
    const country = txt(f.country, 60) || 'UAE';
    const uae = country === 'UAE';
    let zones: Record<string, number> = {}; try { zones = JSON.parse(String(site?.shipZones ?? '{}')) ?? {}; } catch { zones = {}; }
    const del = uae ? (KIDS_EMIRATE[txt(f.emirate, 40)] ?? 35) : (Number(zones[zoneOfCountry(country)]) > 0 ? Number(zones[zoneOfCountry(country)]) : null);
    const ex = (Array.isArray(f.extras) ? f.extras : []).map((k) => KIDS_EXTRAS[String(k)]).filter(Boolean);
    const total = (age <= 10 ? 0 : 79) + (del ?? 0) + ex.reduce((a, e) => a + e[1], 0);
    const key = txt(it.fileKey, 300);
    if (!key.startsWith('uploads/')) throw new Error("The child's drawing is missing: add the gift again.");
    const det: Dict = { Child: `${txt(f.child, 40)}, age ${age}`, 'Gift for': txt(f.to, 60), Country: country, [uae ? 'Emirate' : 'State / city']: uae ? txt(f.emirate, 40) : txt(f.region, 60),
      'Delivery charge': del == null ? 'to quote' : `AED ${del}`, Address: txt(f.address, 300), Frame: txt(f.frame, 20), Extras: ex.map((e) => e[0]).join(', '), 'Card message': txt(f.msg, 200), Parent: txt(f.parent, 80), Mobile: txt(f.phone, 30),
      Total: `AED ${total.toLocaleString('en-US')}${del == null ? ' + shipping' : ''}`, Consent: 'Parent/guardian confirmed' };
    if (!det['Gift for'] || !det.Address || !txt(f.child, 40)) throw new Error('A Little Artists gift is missing the child, who it is for or the address: add it again.');
    return { kind: 'GIFT', title: `Little Artists gift for ${det['Gift for']}`, details: det, price: total, quote: del == null, extra: {}, gift: true, fileKey: key };
  }
  throw new Error('Unknown item in the cart.');
}
async function basketCheckout(ev: ApiEvent) {
  const table = process.env.ENQUIRY_TABLE;
  if (!table) throw new Error('Not configured');
  const me = who(ev);
  const d = parseData(ev.arguments.data);
  const items = (Array.isArray(d.items) ? d.items : []).slice(0, 20) as Dict[];
  if (!items.length) throw new Error('Your cart is empty.');
  const site = process.env.SITE_TABLE ? plain(await getRow(process.env.SITE_TABLE, { id: { S: 'site' } })) : null;
  const used = new Set<string>();
  const lines: CartLine[] = [];
  for (const it of items) lines.push(await cartLine(it, site, used));
  const needsAddr = lines.some((l) => !l.gift);
  const dry = !!d.dry; // the cart's "Review total": prices and discount only, nothing saved
  let a: ReturnType<typeof checkAddress> | null = null;
  if (needsAddr) { try { a = checkAddress(d.address as Dict); } catch (err) { if (!dry) throw err; } }
  const dryCountry = txt((d.address as Dict)?.country, 60) || 'UAE';
  const contactName = a?.name || txt((d.address as Dict)?.name, 80) || String(lines.find((l) => l.gift)?.details.Parent ?? '');
  const contactPhone = a?.phone || txt((d.address as Dict)?.phone, 30) || String(lines.find((l) => l.gift)?.details.Mobile ?? '');
  // Outside the UAE: the studio adds the shipping before the payment.
  if ((a ? a.country : dryCountry) !== 'UAE') lines.forEach((l) => { if (!l.gift) l.quote = true; });
  const quote = lines.some((l) => l.quote);

  // Discount: the customer's standard / programme discount, or one code (offer, voucher, gift card, invite).
  const mine = (await scanAll(table)).filter((e) => ownsEnquiry(e, ev));
  const custCode = mine.map((e) => str(e, 'customerCode')).find(Boolean) ?? '';
  const cust = custCode ? await loyCustomer(custCode) : null;
  const myEmail = me.email || String(cust?.email ?? '') || mine.map((e) => str(e, 'email')).find(Boolean) || '';
  const AREA_OF = (k: string, area: string) => (AREA[area || 'ALL'] ?? AREA.ALL).includes(k);
  const disc = lines.map(() => 0);
  let codeUsed: { code: string; v: Img | null; amount: number } | null = null;
  let stdNote = '';
  const code = txt(d.code, 30).toUpperCase();
  if (cust?.discountType && Number(cust.discountValue) > 0) {
    if (code) throw new Error(`Your ${String(cust.discountNote || 'special')} discount is already taken off, so a code can't be added as well.`);
    lines.forEach((l, i) => { if (AREA_OF(l.kind, String(cust.discountArea || 'ALL'))) disc[i] = cust.discountType === 'AED' ? 0 : r2(l.price * Number(cust.discountValue) / 100); });
    if (cust.discountType === 'AED') { const idx = lines.findIndex((l) => AREA_OF(l.kind, String(cust.discountArea || 'ALL'))); if (idx >= 0) disc[idx] = Math.min(lines[idx].price - 2, Number(cust.discountValue)); }
    stdNote = String(cust.discountNote || 'Your standard discount');
  } else if (code) {
    const f = await findPromo(code);
    const v = f && 'p' in f ? null : await findVoucher(code);
    if (!v && (!f || 'error' in f)) throw new Error(f?.error ?? 'This code is not valid.');
    const p = v ?? (f as { p: Img }).p;
    if (v && str(v, 'kind') === 'REF' && (Number(cust?.paidCount ?? 0) > 0)) throw new Error('Invite codes are for a first order: you can earn your own by inviting friends.');
    if (v && str(v, 'kind') === 'REF' && str(v, 'refOwner') === custCode) throw new Error('This is your own invite code: share it with friends.');
    const area = str(p, 'appliesTo') || 'ALL';
    const okIdx = lines.map((l, i) => (v && str(v, 'kind') === 'GIFT') || AREA_OF(l.kind, area) ? i : -1).filter((i) => i >= 0);
    const base = r2(okIdx.reduce((s2, i) => s2 + lines[i].price, 0));
    if (!okIdx.length || !(base > 0)) throw new Error('This code does not apply to the items in your cart.');
    const pseudo = toAttrs({ email: myEmail, customerCode: custCode, kind: lines[okIdx[0]].kind }) as Img;
    const r = v ? voucherAmount(v, pseudo, base) : discountFor(p, lines[okIdx[0]].kind, base);
    if (r.error) throw new Error(r.error);
    const total = Math.min(r.amount, base - 2 * okIdx.length);
    let left = r2(total);
    okIdx.forEach((i, n) => { const share = n === okIdx.length - 1 ? left : r2(total * lines[i].price / base); disc[i] = share; left = r2(left - share); });
    codeUsed = { code, v, amount: r2(total) };
  }

  const basketRef = `BK-${newRef().slice(3)}`;
  const now = new Date().toISOString();
  const rows: Dict[] = lines.map((l, i) => {
    const price = r2(l.price - disc[i]);
    return { id: crypto.randomUUID(), __typename: 'Enquiry', createdAt: now, updatedAt: now, owner: me.owner, ref: newRef(), kind: l.kind, title: l.title,
      details: JSON.stringify({ ...l.details, Basket: `${basketRef} (${lines.length} item${lines.length > 1 ? 's' : ''})`, Name: contactName, Mobile: l.details.Mobile ?? contactPhone, ...(txt(d.note, 300) ? { Message: txt(d.note, 300) } : {}) }),
      status: l.quote ? 'RECEIVED' : 'PRICE_SENT', customerName: contactName, phone: contactPhone, email: myEmail, quotedPrice: price, basketRef, basketLead: i === 0,
      ...(l.fileKey ? { fileKey: l.fileKey } : {}),
      ...(a && !l.gift ? { deliveryName: a.name, deliveryPhone: a.phone, deliveryCountry: a.country, deliveryEmirate: a.region, deliveryPin: a.pin, deliveryAddress: a.address, deliveryLandmark: a.landmark, addressAt: now, addressBy: 'Customer' } : {}),
      ...(disc[i] > 0 ? { listPrice: l.price, discountAmount: disc[i], ...(codeUsed ? { discountCode: codeUsed.code, ...(codeUsed.v && str(codeUsed.v, 'kind') === 'REF' ? { referralBy: str(codeUsed.v, 'refOwner') } : {}) } : { discountType: String(cust?.discountType), discountValue: Number(cust?.discountValue), discountNote: stdNote }) } : {}),
      ...l.extra };
  });
  if (dry) {
    const tot = r2(rows.reduce((s2, r) => s2 + Number(r.quotedPrice), 0)), dsum = r2(disc.reduce((x, y) => x + y, 0));
    return { lines: rows.map((r, i) => ({ title: String(r.title), price: Number(r.quotedPrice), list: lines[i].price, discount: disc[i] })), total: tot, discount: dsum, quote,
      discountLabel: dsum > 0 ? (codeUsed ? `Code ${codeUsed.code}` : `${stdNote} discount`) : '' };
  }
  // Several pieces with a quote: no payment yet, the studio sends the price (one order at a time, as before).
  let payUrl = '';
  const total = r2(rows.reduce((s2, r) => s2 + Number(r.quotedPrice), 0));
  if (!quote && total >= 2 && (await secureParam('/kalai/ziina/token'))) {
    const test = await ziinaTest();
    const body = (message?: string) => JSON.stringify({ amount: fils(total), currency_code: 'AED', test, ...(message ? { message } : {}),
      success_url: `${SITE}/?paid=${encodeURIComponent(basketRef)}#my-enquiries`, cancel_url: `${SITE}/#my-enquiries`, failure_url: `${SITE}/?payfail=${encodeURIComponent(basketRef)}#my-enquiries` });
    let r = await ziinaCall('/payment_intent', { method: 'POST', body: body(`Kalai Art House ${basketRef}`) });
    if (r.status === 400 && /message/i.test(String(r.body?.message ?? ''))) r = await ziinaCall('/payment_intent', { method: 'POST', body: body() });
    if (r.ok && r.body?.redirect_url) {
      payUrl = String(r.body.redirect_url);
      rows.forEach((row) => Object.assign(row, { paymentLink: payUrl, ziinaIntentId: String(r.body.id), ziinaAmount: Number(row.quotedPrice), ziinaTest: test ? 'yes' : undefined, ziinaMessage: `${test ? 'Test ' : ''}Ziina basket payment for ${basketRef}: AED ${total.toLocaleString('en-US')} for ${rows.length} orders.` }));
    } else console.error(`Basket ${basketRef}: Ziina link failed (${r.status})`, r.body);
  }
  for (const row of rows) await ddb.send(new PutItemCommand({ TableName: table, Item: toAttrs(row), ConditionExpression: 'attribute_not_exists(id)' }));
  if (codeUsed) { if (codeUsed.v) await useVoucher(codeUsed.v, basketRef, codeUsed.amount); else await bumpUses(codeUsed.code, 1); }
  const lineTxt = rows.map((r) => `• ${h(String(r.title))} (${h(String(r.ref))}): <b>${aed(Number(r.quotedPrice))}</b>${Number(r.discountAmount) ? ` <span style="color:#6b6780">(was ${aed(Number(r.listPrice))})</span>` : ''}`).join('<br>');
  if (myEmail && (await emailsOn())) await sendMail({ to: myEmail, subject: `We've received your order ${basketRef}`, lines: [`Hello ${h(contactName.split(' ')[0] || 'there')},`, `Thank you for your order of ${rows.length} item${rows.length > 1 ? 's' : ''}:`, lineTxt,
    quote ? `Total so far <b>${aed(total)}</b>. We'll add the shipping${a && a.country !== 'UAE' ? ` to ${h(a.country)}` : ''} and send you the payment link, usually within 24 hours.` : `Total <b>${aed(total)}</b>, including delivery in the UAE${codeUsed ? ` and your code ${h(codeUsed.code)}` : stdNote ? ` and your ${h(stdNote)} discount` : ''}.`,
    !quote && payUrl ? 'If you did not finish the payment, use the button below; your order is confirmed once it is paid.' : '', 'You can follow each item under My enquiries & orders.'].filter(Boolean), button: payUrl ? { label: `Pay ${aed(total)} securely`, url: payUrl } : MY }).catch(() => {});
  await sendMail({ to: STUDIO_EMAIL, subject: `New basket order ${basketRef}: ${rows.length} items, ${aed(total)}`, lines: [`${h(contactName)} · ${h(contactPhone)} · ${h(myEmail)}`, lineTxt, quote ? '<b>Needs a price/shipping quote</b> before payment.' : payUrl ? 'Payment link sent (one Ziina payment for all items).' : 'No Ziina link: send the payment link yourself.'], button: { label: 'Open Order Management', url: `${SITE}/admin.html` }, footer: 'Studio notification from art.pranixtechno.com' }).catch(() => {});
  console.log(`Basket ${basketRef}: ${rows.length} orders, AED ${total}${quote ? ' (to quote)' : ''}`);
  return { ok: true, basketRef, total, payUrl, quote, refs: rows.map((r) => r.ref) };
}

// ---------- Image licences (website → artwork → Licences) ----------
// Sold from the work's full-size file (Catalogue → Prints → print file). Price = % of the original's price (unframed),
// set per type in Settings. Paid by Ziina; once paid the order is Delivered and the buyer downloads the file under
// My enquiries & orders. The artist's royalty % is kept on the order (settled like print royalties).
const LICENCES: Record<string, { label: string; allows: string; pct: number }> = {
  WEB: { label: 'Web licence', allows: 'Websites, blogs, social media and online ads, worldwide. Online use only: no printed copies, no products for sale, no reselling.', pct: 10 },
  MEDIA: { label: 'Media licence', allows: 'Print and digital media: magazines, books, brochures, flyers, adverts and TV, worldwide, up to 10,000 printed copies. No products for sale, no reselling.', pct: 25 },
  COMMERCIAL: { label: 'Commercial licence', allows: 'Products made for sale (posters, cards, textiles, packaging, merchandise), up to 1,000 products, plus all web and media uses. No reselling of the file.', pct: 50 },
};
async function licencePcts(): Promise<Record<string, number>> {
  const out: Record<string, number> = Object.fromEntries(Object.entries(LICENCES).map(([k, v]) => [k, v.pct]));
  const t = process.env.SITE_TABLE;
  if (!t) return out;
  try {
    const st = plain(await getRow(t, { id: { S: 'site' } }));
    const j = st?.licencePcts ? JSON.parse(String(st.licencePcts)) : {};
    for (const k of Object.keys(out)) if (Number(j[k]) > 0) out[k] = Number(j[k]);
  } catch { /* defaults */ }
  return out;
}
/** The original's price on the website: unframed when there is one, otherwise the lowest price shown. */
function artworkPrice(pr: Dict): number {
  try {
    const m = pr.priceMatrix ? JSON.parse(String(pr.priceMatrix)) : null;
    if (m) {
      if (Number(m.none) > 0) return Number(m.none);
      const all: number[] = [];
      const walk = (o: unknown) => { if (typeof o === 'number' && o > 0) all.push(o); else if (o && typeof o === 'object') Object.values(o as Dict).forEach(walk); };
      walk(m.v === 2 ? m.sizes : m);
      if (all.length) return Math.min(...all);
    }
  } catch { /* no matrix */ }
  return Number(pr.priceAed ?? 0) || 0;
}
async function licenceOrder(ev: ApiEvent) {
  const table = process.env.ENQUIRY_TABLE, PT = process.env.PRODUCT_TABLE;
  if (!table || !PT) throw new Error('Not configured');
  const me = who(ev);
  const d = parseData(ev.arguments.data);
  const type = String(d.type ?? '').toUpperCase();
  const lic = LICENCES[type];
  if (!lic) throw new Error('Choose a licence type.');
  const pr = plain(await getRow(PT, { id: { S: txt(d.productId, 80) } }));
  if (!pr || !['PUBLISHED', 'SOLD'].includes(String(pr.status)) || !pr.licensable || !pr.printKey) throw new Error('Sorry, licences are not available for this work.');
  if (pr.artistId && process.env.SELLER_TABLE) {
    const ap = plain(await getRow(process.env.SELLER_TABLE, { id: { S: String(pr.artistId) } }));
    if (ap?.allowLicences !== 'YES') throw new Error('Sorry, licences are not available for this work.');
  }
  const base = artworkPrice(pr);
  if (!(base > 0)) throw new Error('Sorry, this work has no price yet: please ask us.');
  const pct = (await licencePcts())[type];
  const total = Math.max(25, Math.ceil((base * pct) / 100 / 5) * 5);
  const ref = newRef();
  const now = new Date().toISOString();
  const name = txt(d.name, 80) || me.email.split('@')[0];
  const title = `Image licence: ${String(pr.title || 'Artwork')} (${lic.label})`;
  const details = { Artwork: String(pr.title || ''), 'Artwork no.': String(pr.code || ''), Licence: lic.label, Allows: lic.allows, File: 'Full-size image file, downloaded after payment', Price: `AED ${total}` };
  const row: Dict = {
    id: crypto.randomUUID(), __typename: 'Enquiry', createdAt: now, updatedAt: now, owner: me.owner,
    ref, kind: 'LICENCE', title: title.slice(0, 200), details: JSON.stringify(details), status: 'RECEIVED',
    customerName: name, phone: txt(d.phone, 30), email: me.email, quotedPrice: total,
    productId: String(pr.id), licenceType: type,
    artistName: String(pr.artist || 'Siva Raja'), ...(pr.artistId ? { artistId: String(pr.artistId), artistCountry: String(pr.artistCountry || 'UAE') } : {}),
    royaltyPct: await licenceRoyaltyOf(pr),
  };
  await ddb.send(new PutItemCommand({ TableName: table, Item: toAttrs(row), ConditionExpression: 'attribute_not_exists(id)' }));
  // Straight to "Price sent": the stream makes the Ziina link and emails it.
  await updateEnquiry(String(row.id), { status: 'PRICE_SENT' });
  console.log(`Licence order ${ref}: ${pr.title} ${type} = AED ${total}`);
  return { ok: true, ref, id: row.id, total };
}
/** Paid licence: nothing to frame or ship, so it is delivered at once (the file is in My enquiries & orders). */
async function licenceDelivered(img: Img) {
  if (str(img, 'kind') !== 'LICENCE') return;
  const now = new Date().toISOString();
  await writeBack(str(img, 'id'), { status: 'DELIVERED', deliveredAt: now });
}
const paidLike = (e: Img) => !!(str(e, 'zohoPaymentId') || str(e, 'ziinaPaidAt') || str(e, 'zohoState') === 'TEST') && !['REFUNDED', 'CANCELLED'].includes(str(e, 'status'))
  || [...PAID_LIKE, 'FRAMING', 'SHIPPED', 'DELIVERED'].includes(str(e, 'status'));
async function licenceFile(e: Img) {
  if (str(e, 'kind') !== 'LICENCE') throw new Error('Not a licence order.');
  if (!paidLike(e)) throw new Error('The file is ready to download once the licence is paid.');
  const PT = process.env.PRODUCT_TABLE, bucket = process.env.UPLOADS_BUCKET;
  if (!PT || !bucket) throw new Error('Not configured');
  const pr = plain(await getRow(PT, { id: { S: str(e, 'productId') } }));
  const key = String(pr?.printKey || '');
  if (!key) throw new Error('The file is being prepared: please contact us.');
  const ext = (key.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg';
  const name = `${String(pr?.title || 'artwork').replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-').slice(0, 50) || 'artwork'}-${str(e, 'ref')}.${ext}`;
  return { url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: `attachment; filename="${name}"` }), { expiresIn: 900 }), type: str(e, 'licenceType'), label: LICENCES[str(e, 'licenceType')]?.label ?? 'Licence', allows: LICENCES[str(e, 'licenceType')]?.allows ?? '' };
}

/** Print files uploaded before licences were sold sit in the public catalogue/ folder: move them to private originals/. */
async function securePrintFiles() {
  const PT = process.env.PRODUCT_TABLE, bucket = process.env.UPLOADS_BUCKET;
  if (!PT || !bucket) return;
  for (const raw of await scanAll(PT)) {
    let pr = plain(raw);
    let key = String(pr?.printKey || '');
    if (!pr || !key) continue;
    if (key.startsWith('catalogue/print/')) {
      const to = key.replace(/^catalogue\/print\//, 'originals/print/');
      await s3.send(new CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`, Key: to }));
      pr = { ...pr, printKey: to, updatedAt: new Date().toISOString() };
      await putRow(PT, pr);
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      console.log(`Print file moved to private: ${to}`);
      key = to;
    }
    // Pixel size of the file, shown on the Licence tab ("Dimensions of the file").
    if (!pr.printW) {
      const d = await imageDims(bucket, key).catch(() => null);
      if (d) await putRow(PT, { ...pr, printW: d.w, printH: d.h, updatedAt: new Date().toISOString() });
    }
  }
}
/** Width × height from the start of a JPEG or PNG (first 256 KB only). */
async function imageDims(bucket: string, key: string): Promise<{ w: number; h: number } | null> {
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: 'bytes=0-262143' }));
  const body = r.Body as { transformToByteArray(): Promise<Uint8Array> } | undefined;
  if (!body) return null;
  const b: Uint8Array = await body.transformToByteArray();
  if (b[0] === 0x89 && b[1] === 0x50) return { w: (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0, h: (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0 };
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1], len = b[i + 2] << 8 | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: b[i + 5] << 8 | b[i + 6], w: b[i + 7] << 8 | b[i + 8] };
    i += 2 + len;
  }
  return null;
}

// ---------- Certificate of authenticity (originals) ----------
// Number COA-<order ref without KA->. The customer downloads it from My enquiries & orders once paid; anyone can check
// a number on the website (#verify), which shows the work and the date, never the buyer.
const coaNumber = (ref: string) => `COA-${ref.replace(/^KA-/, '')}`;
async function certificateOf(e: Img, forOwner: boolean) {
  const kind = str(e, 'kind');
  const det = parseDetails(detStr(e));
  const original = ['PRICE', 'COMMISSION'].includes(kind) || (kind === 'MARKET' && String(det['Maker'] ?? '') === 'Artist');
  if (!original) throw new Error('Certificates are for original artworks.');
  if (!paidLike(e)) throw new Error('The certificate is issued once the order is paid.');
  const no = String(det['Artwork no.'] ?? '').trim();
  const pr = no && process.env.PRODUCT_TABLE ? (await scanAll(process.env.PRODUCT_TABLE)).find((x) => str(x, 'code') === no) : undefined;
  let showName = true;
  if (process.env.SITE_TABLE) { const st = plain(await getRow(process.env.SITE_TABLE, { id: { S: 'site' } })); showName = st?.showArtists !== false; }
  const artist = str(e, 'artistName') || (pr && str(pr, 'artist')) || (kind === 'MARKET' ? str(e, 'sellerName') : 'Siva Raja');
  return {
    valid: true,
    number: coaNumber(str(e, 'ref')),
    title: (pr && str(pr, 'title')) || str(e, 'title').replace(/^(Artwork order|Commission request|Commission): /i, ''),
    artist: showName ? artist : 'Kalai Art House studio artist',
    medium: (pr && str(pr, 'medium')) || String(det['Style'] ?? det['Medium'] ?? ''),
    size: (pr && str(pr, 'size')) || String(det['Size'] ?? ''),
    code: no,
    issued: str(e, 'ziinaPaidAt') || str(e, 'costingAt') || str(e, 'updatedAt'),
    ...(forOwner ? { ref: str(e, 'ref'), owner: str(e, 'customerName') } : {}),
  };
}
async function verifyCertificate(code: string) {
  const m = code.toUpperCase().replace(/\s+/g, '').match(/(\d{6}-[A-Z0-9]{4})/);
  const table = process.env.ENQUIRY_TABLE;
  if (!m || !table) return { valid: false };
  const ref = `KA-${m[1]}`;
  const e = (await scanAll(table)).find((x) => str(x, 'ref') === ref);
  if (!e) return { valid: false };
  try { return await certificateOf(e, false); } catch { return { valid: false }; }
}

/** Update an enquiry as a "desk edit" (no zohoAt), so the stream reacts to it (challan, emails). */
async function updateEnquiry(id: string, set: Dict) {
  const table = process.env.ENQUIRY_TABLE;
  if (!table) throw new Error('Not configured');
  const names: Record<string, string> = {};
  const values: Record<string, AttributeValue> = {};
  const parts: string[] = [];
  const removes: string[] = [];
  Object.entries({ ...set, updatedAt: new Date().toISOString() }).forEach(([k, v], i) => {
    names[`#u${i}`] = k;
    if (v === null || v === undefined) { removes.push(`#u${i}`); return; }
    values[`:u${i}`] = typeof v === 'number' ? { N: String(v) } : { S: String(v) }; parts.push(`#u${i} = :u${i}`);
  });
  await ddb.send(new UpdateItemCommand({ TableName: table, Key: { id: { S: id } }, UpdateExpression: `SET ${parts.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values, ConditionExpression: 'attribute_exists(id)' }));
}

async function changeStock(listingId: string, delta: number) {
  const { L } = mtables();
  const l = plain(await getRow(L, { id: { S: listingId } }));
  if (!l) return;
  const row: Dict = { ...l, stock: Math.max(0, Number(l.stock ?? 0) + delta), updatedAt: new Date().toISOString() };
  await putRow(L, row);
  if (row.status === 'APPROVED') await publishItem(row);
}

let marketAccount: string | null | undefined;
async function sellerVendorId(sellerId: string): Promise<{ id: string; name: string }> {
  const { S } = mtables();
  const p = plain(await getRow(S, { id: { S: sellerId } }));
  if (!p) throw new Error('Seller not found');
  const name = String(p.business || p.contactName || 'Seller').slice(0, 99);
  if (p.zohoVendorId) return { id: String(p.zohoVendorId), name };
  const found = await zoho(`/contacts?contact_name=${encodeURIComponent(name)}&contact_type=vendor`);
  let id = found.ok ? found.body.contacts?.find((c) => c.contact_name === name)?.contact_id : undefined;
  if (!id) {
    const created = await zoho('/contacts', { method: 'POST', body: JSON.stringify({ contact_name: name, contact_type: 'vendor', notes: `Crafts shop seller on art.pranixtechno.com. ${p.email ?? ''} ${p.phone ?? ''} ${p.iban ? `IBAN ${p.iban}` : ''}`.trim() }) });
    if (!created.ok || !created.body.contact) throw new Error(`Zoho vendor create failed (${created.status}): ${created.body.message}`);
    id = created.body.contact.contact_id;
  }
  await putRow(S, { ...p, zohoVendorId: id, updatedAt: new Date().toISOString() });
  return { id, name };
}

async function marketSteps(img: Img) {
  const id = str(img, 'id');
  const ref = str(img, 'ref');
  const testing = str(img, 'zohoState') === 'TEST' && !!str(img, 'zohoInvoiceId');
  if (!str(img, 'zohoPaymentId') && !testing) return;
  const state = str(img, 'purchaseState');
  const qty = num(img, 'qty') ?? 1;
  const amountDue = num(img, 'sellerAmount') ?? 0;
  const seller = str(img, 'sellerName');
  try {
    // Cancelled with a refund before it was dispatched: the maker's order stops and the stock goes back.
    if (str(img, 'refundAction').startsWith('CANCEL')) {
      if (state === 'ORDERED') {
        await changeStock(str(img, 'listingId'), qty);
        await writeBack(id, { purchaseState: 'CANCELLED', purchaseMessage: `Order to ${seller} cancelled (customer refunded); stock put back.` });
        const p = plain(await getRow(mtables().S, { id: { S: str(img, 'sellerId') } }));
        if (p?.email) await sendMail({ to: String(p.email), subject: `Order cancelled: ${str(img, 'title')} (${ref})`, lines: [`Hello ${h(p.contactName)},`, `The customer cancelled order <b>${h(ref)}</b> for <b>${h(str(img, 'title'))}</b> × ${qty}. Please do not send it.`, 'The stock has been added back to your listing.'], button: { label: 'Open the seller portal', url: `${SITE}/seller.html` } }).catch(() => {});
      }
      return;
    }
    if (!state) {
      await changeStock(str(img, 'listingId'), -qty);
      await writeBack(id, { purchaseState: 'ORDERED', purchaseMessage: `Order sent to ${seller}: AED ${amountDue.toLocaleString('en-US')} to pay them after delivery.` });
      const p = plain(await getRow(mtables().S, { id: { S: str(img, 'sellerId') } }));
      const kalai = str(img, 'deliveryBy') === 'KALAI';
      if (p?.email) {
        await sendMail({
          to: String(p.email), subject: `New order: ${str(img, 'title')} × ${qty} (${ref})`,
          lines: [`Hello ${h(p.contactName)},`, `You have a paid order <b>${h(ref)}</b>: <b>${h(str(img, 'title'))}</b> × ${qty}. You receive <b>${aed(amountDue)}</b> after delivery.`,
            kalai ? `Kalai Art House collects it from you${p.address ? ` at ${h(p.address)}` : ''}. Please pack it well and mark it <b>Ready for pickup</b> in the seller portal.`
              : `Please deliver it to <b>${h(str(img, 'deliveryName'))}</b>, ${h(str(img, 'deliveryPhone'))}, ${h(addressText(img))} within 2 working days, then enter the courier and tracking number in the seller portal.`],
          button: { label: 'Open the seller portal', url: `${SITE}/seller.html#orders` },
        }).catch((err) => console.warn('Seller email failed', err));
      }
      return;
    }
    if (str(img, 'status') !== 'DELIVERED' || state === 'CANCELLED') return;
    if (!str(img, 'zohoSellerBillId')) {
      const vendor = await sellerVendorId(str(img, 'sellerId'));
      if (marketAccount === undefined || marketAccount === null) marketAccount = (await optionalParam('/kalai/zoho/market_account_id')) ?? (await artistAccountId());
      const unit = r2(amountDue / qty);
      const r = await zoho('/bills', {
        method: 'POST',
        body: JSON.stringify({
          vendor_id: vendor.id, bill_number: `${ref}-MP`, reference_number: ref, date: dubaiToday(),
          line_items: [{ name: str(img, 'title').slice(0, 100), description: `Crafts shop order ${ref} · ${qty} × AED ${unit} (seller price; Kalai commission ${num(img, 'commissionPct') ?? 0}% kept)`, rate: unit, quantity: qty, ...(marketAccount ? { account_id: marketAccount } : {}) }],
          notes: `Kalai Art House crafts shop payout for ${ref}.`,
        }),
      });
      if (!r.ok || !r.body.bill) throw new Error(`Zoho bill for ${vendor.name} failed (${r.status}): ${r.body.message}`);
      const bill = r.body.bill;
      const draft = testing ? await keepAsDraft(`/bills/${bill.bill_id}`, bill.status) : null;
      await writeBack(id, {
        purchaseState: 'BILLED', zohoSellerBill: bill.bill_number, zohoSellerBillId: bill.bill_id,
        purchaseMessage: testing ? `Test mode: ${draft === 'draft' ? 'draft' : 'void (test)'} payout bill ${bill.bill_number} for ${vendor.name} · AED ${amountDue.toLocaleString('en-US')}. Payment not recorded while testing.`
          : `Payout bill ${bill.bill_number}: ${vendor.name} · AED ${amountDue.toLocaleString('en-US')} to pay. Enter your bank ref when paid.`,
      });
      return;
    }
    if (str(img, 'sellerPaidRef') && !str(img, 'zohoSellerPaymentId')) {
      if (testing) {
        if (!/payment not recorded/i.test(str(img, 'purchaseMessage'))) await writeBack(id, { purchaseMessage: `Test mode: payout bill ${str(img, 'zohoSellerBill')} · payment not recorded while testing (ref ${str(img, 'sellerPaidRef')}).` });
        return;
      }
      const vendor = await sellerVendorId(str(img, 'sellerId'));
      const got = await zoho(`/bills/${str(img, 'zohoSellerBillId')}`);
      const balance = Number(got.body.bill?.balance ?? 0);
      let payId = 'paid';
      if (balance > 0) {
        const r = await zoho('/vendorpayments', { method: 'POST', body: JSON.stringify({ vendor_id: vendor.id, payment_mode: 'banktransfer', amount: balance, date: dubaiToday(), reference_number: str(img, 'sellerPaidRef'), description: `Crafts shop payout to ${vendor.name} for ${ref}`, bills: [{ bill_id: str(img, 'zohoSellerBillId'), amount_applied: balance }] }) });
        if (!r.ok || !r.body.vendorpayment) throw new Error(`Zoho payment to ${vendor.name} failed (${r.status}): ${r.body.message}`);
        payId = r.body.vendorpayment.payment_id;
      }
      await writeBack(id, { purchaseState: 'SELLER_PAID', zohoSellerPaymentId: payId, purchaseMessage: `${vendor.name} paid AED ${(balance || amountDue).toLocaleString('en-US')} (ref ${str(img, 'sellerPaidRef')}) against bill ${str(img, 'zohoSellerBill')}.` });
      const p = plain(await getRow(mtables().S, { id: { S: str(img, 'sellerId') } }));
      if (p?.email) await sendMail({ to: String(p.email), subject: `Payment sent for ${ref}`, lines: [`Hello ${h(p.contactName)},`, `We've paid <b>${aed(balance || amountDue)}</b> for order ${h(ref)} (${h(str(img, 'title'))}). Bank reference: ${h(str(img, 'sellerPaidRef'))}.`], button: { label: 'Open the seller portal', url: `${SITE}/seller.html#orders` } }).catch(() => {});
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Crafts shop step failed for ${ref}:`, err);
    await writeBack(id, { purchaseState: 'ERROR', purchaseMessage: msg.slice(0, 500) });
  }
}

/** Seller portal: my paid orders, and the steps the maker does. */
async function sellerOrders(action: string, d: Dict, sellerId: string, profile: Dict) {
  const table = process.env.ENQUIRY_TABLE;
  if (!table) throw new Error('Not configured');
  const view = (e: Img) => {
    const own = str(e, 'deliveryBy') !== 'KALAI';
    return {
      id: str(e, 'id'), ref: str(e, 'ref'), title: str(e, 'title'), qty: num(e, 'qty') ?? 1, amount: num(e, 'sellerAmount') ?? 0, deliveryBy: str(e, 'deliveryBy'),
      status: str(e, 'status'), purchaseState: str(e, 'purchaseState'), sellerStage: str(e, 'sellerStage'), createdAt: str(e, 'createdAt'),
      readyAt: str(e, 'sellerReadyAt'), dispatchedAt: str(e, 'sellerDispatchedAt'), courier: str(e, 'courierName'), awb: str(e, 'trackingNo'), deliveredAt: str(e, 'deliveredAt'),
      onHold: str(e, 'cancelState') === 'REQUESTED', cancelled: str(e, 'purchaseState') === 'CANCELLED',
      bill: str(e, 'zohoSellerBill'), paidRef: str(e, 'zohoSellerPaymentId') ? str(e, 'sellerPaidRef') : '',
      ...(own ? { to: { name: str(e, 'deliveryName'), phone: str(e, 'deliveryPhone'), address: str(e, 'deliveryAddress'), landmark: str(e, 'deliveryLandmark'), emirate: str(e, 'deliveryEmirate'), country: str(e, 'deliveryCountry') || 'UAE', pin: str(e, 'deliveryPin'), line: addressText(e) } } : {}),
    };
  };
  if (action === 'orders') {
    const mine = (await scanAll(table)).filter((e) => str(e, 'sellerId') === sellerId && str(e, 'kind') === 'MARKET' && str(e, 'purchaseState'));
    return { orders: mine.sort((a, b) => str(b, 'createdAt').localeCompare(str(a, 'createdAt'))).map(view) };
  }
  const got = await ddb.send(new GetItemCommand({ TableName: table, Key: { id: { S: txt(d.id, 60) } } }));
  const e = got.Item as Img | undefined;
  if (!e || str(e, 'sellerId') !== sellerId || !str(e, 'purchaseState')) throw new Error('Order not found');
  if (str(e, 'purchaseState') === 'CANCELLED') throw new Error('This order was cancelled. Please do not send it.');
  if (str(e, 'cancelState') === 'REQUESTED') throw new Error('On hold: the customer asked to cancel. Please wait for our email.');
  const now = new Date().toISOString();
  const kalai = str(e, 'deliveryBy') === 'KALAI';
  if (action === 'orderReady') {
    if (!kalai) throw new Error('You deliver this order yourself: enter the courier and tracking number instead.');
    if (str(e, 'status') !== 'PAID') throw new Error('Already collected.');
    await updateEnquiry(str(e, 'id'), { sellerStage: 'READY', sellerReadyAt: now });
    await sendMail({ to: STUDIO_EMAIL, subject: `Ready for pickup: ${str(e, 'ref')} (${String(profile.business)})`, lines: [`<b>${h(str(e, 'title'))}</b> × ${num(e, 'qty') ?? 1} is packed and ready.`, `Collect from: ${h(String(profile.address ?? ''))} · ${h(String(profile.contactName ?? ''))} ${h(String(profile.phone ?? ''))}`, 'Book the courier, then mark the order Shipped with the AWB.'], button: { label: 'Open the order', url: `${SITE}/admin.html` }, footer: 'Studio notification from art.pranixtechno.com' }).catch(() => {});
  } else if (action === 'orderDispatched') {
    if (kalai) throw new Error('Kalai collects this order: mark it Ready for pickup instead.');
    if (str(e, 'status') !== 'PAID') throw new Error('Already dispatched.');
    const courier = txt(d.courier, 60), awb = txt(d.awb, 60);
    if (!courier) throw new Error('Enter the courier (or "Own delivery").');
    if (!awb && !/own/i.test(courier)) throw new Error('Enter the tracking number.');
    await updateEnquiry(str(e, 'id'), { sellerStage: 'DISPATCHED', sellerDispatchedAt: now, courierName: courier, ...(awb ? { trackingNo: awb } : {}), status: 'SHIPPED' });
  } else if (action === 'orderDelivered') {
    if (kalai) throw new Error('Kalai delivers this order.');
    if (str(e, 'status') !== 'SHIPPED') throw new Error('Mark it dispatched first.');
    await updateEnquiry(str(e, 'id'), { sellerStage: 'DELIVERED', status: 'DELIVERED' });
  } else throw new Error('Unknown action');
  const fresh = await ddb.send(new GetItemCommand({ TableName: table, Key: { id: { S: str(e, 'id') } } }));
  return { order: view(fresh.Item as Img) };
}


// ---------- Ziina (online card payments) ----------
// /kalai/ziina/token (SecureString): API access token from ziina.com/business/connect.
// /kalai/ziina/webhook_secret (SecureString): signs Ziina's notifications to our webhook (Lambda function URL).
// /kalai/ziina/test_mode: "off" for real payments; if missing it follows the Zoho test mode.
// Price sent → payment link (payment intent) on the order and in the email. Ziina tells us when it is paid →
// the order turns Paid (method Ziina, reference = payment id) and the usual Zoho invoice follows.
// A refund approved on the desk with "Refund via Ziina" goes back to the customer's card through Ziina.
// Paid, then the artist's own steps (status follows the artist's desk): all count as paid orders.
const PAID_LIKE = ['PAID', 'ARTIST_WORKING', 'ARTIST_DONE', 'ARTIST_SENT', 'PRINTING', 'PRINTED']; // paid, not yet with the framer
const STATUS_RANK = ['RECEIVED', 'PRICE_SENT', 'PAID', 'ARTIST_WORKING', 'ARTIST_DONE', 'ARTIST_SENT', 'PRINTING', 'PRINTED', 'FRAMING', 'SHIPPED', 'DELIVERED'];
const ZIINA_API = 'https://api-v2.ziina.com/api';
const ZIINA_IPS = ['3.29.184.186', '3.29.190.95', '20.233.47.127', '13.202.161.181'];
const secureCache = new Map<string, { v: string | null; at: number }>();
async function secureParam(name: string): Promise<string | null> {
  const c = secureCache.get(name);
  if (c && c.v && Date.now() - c.at < 600_000) return c.v;
  let v: string | null = null;
  try { v = ((await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter?.Value ?? '').trim() || null; } catch { v = null; }
  secureCache.set(name, { v, at: Date.now() });
  return v;
}
async function ziinaTest(): Promise<boolean> {
  if (TEST_SITE) return true;
  const v = await optionalParam('/kalai/ziina/test_mode');
  return v ? v.toLowerCase() !== 'off' : testMode();
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ziinaCall(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: any }> {
  const token = await secureParam('/kalai/ziina/token');
  if (!token) throw new Error('Ziina is not connected yet (no token saved).');
  // Never echo the token: a bad value (e.g. pasted commands) is reported without its content.
  if (!/^[A-Za-z0-9._~+/=-]{20,4000}$/.test(token)) throw new Error('The saved Ziina token is not valid (it contains spaces or other text). Save it again in CloudShell.');
  let r: Response;
  try {
    r = await fetch(`${ZIINA_API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers ?? {}) } });
  } catch { throw new Error('Could not reach Ziina. Try again in a minute.'); }
  const text = await r.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 200) }; }
  return { ok: r.ok, status: r.status, body };
}
const fils = (aed: number) => Math.round(aed * 100);

async function ziinaPriceLink(rec: StreamRecord, img: Img) {
  if (str(img, 'status') !== 'PRICE_SENT') return;
  const price = num(img, 'quotedPrice') ?? 0;
  const link = str(img, 'paymentLink');
  const mine = !!str(img, 'ziinaIntentId');
  if (!(price >= 2)) {
    // Ziina takes AED 2 or more. Never leave a link for an old price on the order.
    if (mine && link && num(img, 'ziinaAmount') !== price) {
      await writeBack(str(img, 'id'), { paymentLink: null, ziinaIntentId: null, ziinaAmount: null, ziinaMessage: 'No Ziina link: the price is under AED 2 (Ziina minimum). The old link was removed.' });
      if (rec.dynamodb?.NewImage) delete rec.dynamodb.NewImage.paymentLink;
    }
    return;
  }
  if (link && !mine) return; // the studio's own link
  // A basket's shared payment: keep it while this order's price is unchanged.
  if (str(img, 'basketRef') && mine && link && num(img, 'ziinaAmount') === price) return;
  if (mine && num(img, 'ziinaAmount') === price && link) return; // link already matches the price
  if (!(await secureParam('/kalai/ziina/token'))) return;
  const id = str(img, 'id'), ref = str(img, 'ref');
  try {
    const test = await ziinaTest();
    // Ziina rejects some messages as "too long or too short" (limit not documented): send a short one with only
    // plain characters, and if it is still refused, none.
    const plainTitle = str(img, 'title').replace(/^(Artwork order|Price enquiry(?: \(offer\))?|Commission request|Crafts shop order): /i, '').replace(/[^A-Za-z0-9 .,&'-]/g, '').replace(/\s+/g, ' ').trim();
    const msg = `Kalai Art House ${ref}${plainTitle ? ` - ${plainTitle}` : ''}`.slice(0, 60).trim();
    const intent = (message?: string) => ziinaCall('/payment_intent', {
      method: 'POST',
      body: JSON.stringify({
        amount: fils(price), currency_code: 'AED', test,
        ...(message ? { message } : {}),
        success_url: `${SITE}/?paid=${encodeURIComponent(ref)}#my-enquiries`,
        cancel_url: `${SITE}/#my-enquiries`,
        failure_url: `${SITE}/?payfail=${encodeURIComponent(ref)}#my-enquiries`,
      }),
    });
    let r = await intent(msg);
    if (r.status === 400 && /message/i.test(String(r.body?.message ?? ''))) r = await intent(`Kalai Art House ${ref}`);
    if (r.status === 400 && /message/i.test(String(r.body?.message ?? ''))) r = await intent();
    if (!r.ok || !r.body?.redirect_url) throw new Error(`Ziina payment link failed (${r.status}): ${r.body?.message ?? JSON.stringify(r.body).slice(0, 200)}`);
    await writeBack(id, { paymentLink: r.body.redirect_url, ziinaIntentId: r.body.id, ziinaAmount: price, ziinaTest: test ? 'yes' : null, ziinaMessage: `${test ? 'Test ' : ''}Ziina payment link created for AED ${price.toLocaleString('en-US')}.` });
    // The same stream record goes on to the email step: give it the link.
    if (rec.dynamodb?.NewImage) rec.dynamodb.NewImage.paymentLink = { S: r.body.redirect_url };
    console.log(`Ziina link for ${ref}: ${r.body.id}${test ? ' (test)' : ''}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Ziina link failed for ${ref}:`, err);
    await writeBack(id, { ziinaMessage: msg.slice(0, 400) });
  }
}

async function ziinaRefund(img: Img) {
  const action = str(img, 'refundAction');
  const amount = num(img, 'refundAmount') ?? 0;
  if (!action || action === 'DAMAGED_REPLACE' || !(amount > 0)) return;
  if (str(img, 'refundMethod') !== 'ZIINA' || !str(img, 'ziinaIntentId') || str(img, 'paymentMethod') !== 'ZIINA' || str(img, 'ziinaRefundId')) return;
  const id = str(img, 'id'), ref = str(img, 'ref');
  try {
    const rid = crypto.randomUUID();
    const r = await ziinaCall('/refund', { method: 'POST', body: JSON.stringify({ id: rid, payment_intent_id: str(img, 'ziinaIntentId'), amount: fils(amount), currency_code: 'AED', test: str(img, 'ziinaTest') === 'yes' }) });
    if (!r.ok) throw new Error(`Ziina refund failed (${r.status}): ${r.body?.message ?? r.body?.error?.message ?? ''}`);
    await writeBack(id, { ziinaRefundId: r.body.id ?? rid, ziinaRefundState: String(r.body.status ?? 'pending'), ziinaMessage: `${str(img, 'ziinaTest') === 'yes' ? 'Test ' : ''}Ziina refund of AED ${amount.toLocaleString('en-US')} ${r.body.status === 'completed' ? 'completed' : 'sent (pending)'}.`, ...(str(img, 'refundRef') ? {} : { refundRef: `Ziina ${String(r.body.id ?? rid).slice(0, 18)}` }) });
    console.log(`Ziina refund for ${ref}: AED ${amount}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Ziina refund failed for ${ref}:`, err);
    await writeBack(id, { ziinaRefundId: null, ziinaRefundState: 'failed', ziinaMessage: `Refund NOT sent through Ziina: ${msg}`.slice(0, 400) });
  }
}

type UrlEvent = { requestContext: { http: { method: string; sourceIp: string } }; headers?: Record<string, string>; body?: string; isBase64Encoded?: boolean };
/** Ziina's notifications (Lambda function URL, public). Checked by sender IP and HMAC signature, then confirmed with Ziina's API. */
async function ziinaWebhook(ev: UrlEvent) {
  const res = (statusCode: number, body = 'ok') => ({ statusCode, body });
  if (ev.requestContext.http.method !== 'POST') return res(200, 'Kalai Art House webhook');
  const ip = ev.requestContext.http.sourceIp;
  if (!ZIINA_IPS.includes(ip)) { console.warn(`Webhook from unknown IP ${ip}`); return res(403, 'forbidden'); }
  const raw = ev.isBase64Encoded ? Buffer.from(ev.body ?? '', 'base64').toString('utf8') : (ev.body ?? '');
  const secret = await secureParam('/kalai/ziina/webhook_secret');
  const sig = String(Object.entries(ev.headers ?? {}).find(([k]) => k.toLowerCase() === 'x-hmac-signature')?.[1] ?? '');
  if (secret) {
    const want = createHmac('sha256', secret).update(raw).digest('hex');
    if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) { console.warn('Webhook signature mismatch'); return res(401, 'bad signature'); }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let msg: any = {};
  try { msg = JSON.parse(raw); } catch { return res(400, 'bad json'); }
  const data = msg.data ?? {};
  const table = process.env.ENQUIRY_TABLE!;
  if (msg.event === 'payment_intent.status.updated' && data.id) {
    const all = (await scanAll(table)).filter((x) => str(x, 'ziinaIntentId') === String(data.id));
    const e = all[0];
    if (!e) { console.warn(`Ziina payment ${data.id}: no order`); return res(200); }
    // Don't trust the notification alone: read the payment from Ziina.
    const got = await ziinaCall(`/payment_intent/${encodeURIComponent(String(data.id))}`);
    const pi = got.ok ? got.body : data;
    const st = String(pi.status ?? data.status ?? '');
    const now = new Date().toISOString();
    if (st === 'completed') {
      // A basket payment covers all its orders (each keeps its own price).
      const paidOk = Number(pi.amount) === fils(all.reduce((s2, x) => s2 + (num(x, 'quotedPrice') ?? 0), 0));
      const card = pi.card_details ? `${pi.card_details.card_brand ?? 'card'} ••${pi.card_details.card_last_four ?? ''}` : '';
      if (all.length > 1 && paidOk) {
        for (const x of all) if (['RECEIVED', 'PRICE_SENT'].includes(str(x, 'status') || 'RECEIVED')) await updateEnquiry(str(x, 'id'), { status: 'PAID', paymentMethod: 'ZIINA', paymentRef: String(pi.id), ziinaPaidAt: now, adminMessage: null, ...(card ? { ziinaCard: card } : {}) });
        console.log(`Ziina paid basket ${str(e, 'basketRef')}: AED ${Number(pi.amount) / 100}`);
      } else if (all.length > 1) {
        for (const x of all) await writeBack(str(x, 'id'), { ziinaPaidAt: now, ziinaMessage: `Ziina basket payment of AED ${Number(pi.amount) / 100} does not match the basket total: check it and mark the orders Paid yourself.` });
      } else if (['RECEIVED', 'PRICE_SENT'].includes(str(e, 'status') || 'RECEIVED') && paidOk) {
        await updateEnquiry(str(e, 'id'), { status: 'PAID', paymentMethod: 'ZIINA', paymentRef: String(pi.id), ziinaPaidAt: now, adminMessage: null, ...(card ? { ziinaCard: card } : {}) }); // the price message ("pay with the link") is done
        console.log(`Ziina paid ${str(e, 'ref')}: AED ${Number(pi.amount) / 100}`);
      } else {
        await writeBack(str(e, 'id'), { ziinaPaidAt: now, ziinaMessage: paidOk ? `Ziina payment received (order was already ${str(e, 'status')}).` : `Ziina payment of AED ${Number(pi.amount) / 100} does not match the price AED ${num(e, 'quotedPrice')}: check it and mark Paid yourself.` });
      }
    } else if (st === 'failed' || st === 'canceled') {
      await writeBack(str(e, 'id'), { ziinaMessage: `Ziina payment ${st}${pi.latest_error?.message ? `: ${pi.latest_error.message}` : ''}.`.slice(0, 400) });
    }
    return res(200);
  }
  if (msg.event === 'refund.status.updated' && data.id) {
    const e = (await scanAll(table)).find((x) => str(x, 'ziinaRefundId') === String(data.id));
    if (e) await writeBack(str(e, 'id'), { ziinaRefundState: String(data.status ?? ''), ziinaMessage: `Ziina refund ${data.status === 'completed' ? 'completed' : String(data.status ?? '')}.` });
    return res(200);
  }
  return res(200);
}

/** Studio: is Ziina connected, and register our webhook address with Ziina. */
async function ziinaAdmin(ev: ApiEvent) {
  const action = String(ev.arguments.action ?? '');
  const d = parseData(ev.arguments.data);
  const raw = await secureParam('/kalai/ziina/token');
  const token = !!raw && /^[A-Za-z0-9._~+/=-]{20,4000}$/.test(raw);
  const secret = !!(await secureParam('/kalai/ziina/webhook_secret'));
  const test = await ziinaTest();
  if (action === 'status') return { token, secret, test };
  if (action === 'connect') {
    const url = txt(d.url, 300);
    if (!/^https:\/\/[a-z0-9]+\.lambda-url\.[a-z0-9-]+\.on\.aws\/?$/.test(url)) throw new Error('Webhook address missing: redeploy, then try again.');
    if (!token) throw new Error('Save the Ziina token first (CloudShell command).');
    const r = await ziinaCall('/webhook', { method: 'POST', body: JSON.stringify({ url, ...(secret ? { secret: await secureParam('/kalai/ziina/webhook_secret') } : {}) }) });
    if (!r.ok) throw new Error(`Ziina webhook setup failed (${r.status}): ${r.body?.message ?? ''}`);
    return { token, secret, test, connected: true };
  }
  throw new Error('Unknown action');
}

// ---------- Commissions allocated to a portal artist (instead of Siva) ----------
// The studio picks the artist on the order (artistId). The artist sees the brief and the customer's photo (no contact
// details), gives a price (INR if based in India, else AED), then Started → Finished → Sent to the frame shop.
async function artistCommissions(action: string, d: Dict, sub: string, profile: Dict) {
  const table = process.env.ENQUIRY_TABLE;
  if (!table) throw new Error('Not configured');
  if (profile.type !== 'ARTIST') throw new Error('Commissions are for artists.');
  const by = String(profile.business || 'Artist');
  const currency: 'INR' | 'AED' = profile.country === 'India' ? 'INR' : 'AED';
  if (action === 'commissions') {
    const mine = (await scanAll(table)).filter((e) => str(e, 'artistId') === sub && ['PRICE', 'COMMISSION'].includes(str(e, 'kind')));
    await catchUpArtistStatus(mine);
    return { currency, items: await artistRows(mine) };
  }
  const id = txt(d.id, 60);
  const got = await ddb.send(new GetItemCommand({ TableName: table, Key: { id: { S: id } } }));
  if (!got.Item || str(got.Item as Img, 'artistId') !== sub) throw new Error('Commission not found');
  if (action === 'commissionQuote') return artistQuote({ id, priceInr: Number(d.price), readyBy: txt(d.readyBy, 10), note: txt(d.note, 1000) }, by, currency);
  if (action === 'commissionProgress') return artistProgress({ id, step: txt(d.step, 20), courier: txt(d.courier, 60), awb: txt(d.awb, 60) }, by);
  if (action === 'commissionPhoto') return artistPhoto(id);
  // Their documents as PDFs: our purchase order to them, and their invoice as recorded (our bill).
  if (action === 'commissionDocPdf') {
    const e = got.Item as Img;
    if (d.doc === 'po') { if (!str(e, 'zohoPOId')) throw new Error('No order placed with you yet.'); return zohoPdf(`/purchaseorders/${str(e, 'zohoPOId')}`, str(e, 'zohoPO') || `order-${str(e, 'ref')}`); }
    if (!str(e, 'zohoBillId')) throw new Error('Your invoice is not recorded yet.');
    return zohoPdf(`/bills/${str(e, 'zohoBillId')}`, `invoice-${str(e, 'artistInvoiceNo') || str(e, 'ref')}`);
  }
  // The artist's invoice for an order placed with them: its number creates their bill in Zoho (for the fixed price),
  // the same as the studio typing it on the order.
  if (action === 'commissionInvoice') {
    const e = got.Item as Img;
    const no = txt(d.invoiceNo, 40);
    if (!no) throw new Error('Enter your invoice number.');
    if (!str(e, 'zohoPOId') || str(e, 'purchaseState') === 'CANCELLED') throw new Error('No order placed with you for this yet.');
    if (str(e, 'zohoBillId') || str(e, 'artistInvoiceNo')) throw new Error('Your invoice is already recorded. To correct it, contact Kalai Art House.');
    if (!sivaStopped(e) && str(e, 'artistStage') !== 'SHIPPED') throw new Error('Send your invoice once the work is sent to the frame shop.');
    const now = new Date().toISOString();
    await ddb.send(new UpdateItemCommand({ TableName: table, Key: { id: { S: id } }, ConditionExpression: 'attribute_not_exists(artistInvoiceNo)',
      UpdateExpression: 'SET artistInvoiceNo = :n, artistInvoiceAt = :a, updatedAt = :a', ExpressionAttributeValues: { ':n': { S: no }, ':a': { S: now } } }));
    await sendMail({ to: STUDIO_EMAIL, subject: `Invoice from ${by}: ${str(e, 'ref')}`, lines: [`${h(by)} sent invoice <b>${h(no)}</b> for ${h(str(e, 'ref'))} (${h(str(e, 'title'))}).`, 'The bill is created in Zoho for the agreed price. Pay it, then enter your bank reference on the order.'],
      button: { label: 'Open the order', url: `${SITE}/admin.html#order=${id}` }, footer: 'Studio notification from art.pranixtechno.com' }).catch(() => {});
    return { ok: true, invoiceNo: no };
  }
  throw new Error('Unknown action');
}

/** The studio allocated a commission to a portal artist: email them. */
async function artistAssigned(img: Img, old: Img | undefined) {
  const aid = str(img, 'artistId');
  if (!aid || aid === str(old, 'artistId')) return;
  try {
    const p = plain(await getRow(mtables().S, { id: { S: aid } }));
    if (!p?.email || !(await emailsOn())) return;
    await sendMail({ to: String(p.email), subject: `New ${str(img, 'kind') === 'COMMISSION' ? 'commission' : 'artwork request'} for you: ${str(img, 'ref')}`,
      lines: [`Hello ${h(p.contactName)},`, `Kalai Art House has allocated <b>${h(str(img, 'title'))}</b> (${h(str(img, 'ref'))}) to you.`, `Please open <b>Commissions</b> in your portal, look at the brief${str(img, 'kind') === 'COMMISSION' ? ' and the customer\'s photo' : ''}, and give your price${p.country === 'India' ? ' in INR' : ' in AED'} and when it can be ready.`],
      button: { label: 'Open my commissions', url: `${SITE}/seller.html#commissions` } });
  } catch (err) { console.warn('Artist assignment email failed', err); }
}

// ---------- Artist desk: name the catalogue works ----------
async function artistWorks(ev: ApiEvent) {
  const table = process.env.PRODUCT_TABLE;
  if (!table) throw new Error('Not configured');
  const action = String(ev.arguments.action ?? '');
  const d = parseData(ev.arguments.data);
  const ptab = process.env.ARTPRICE_TABLE;
  if (action === 'list') {
    // Siva's own works only: works by portal artists (artistId set) are priced and named in their own portal.
    const items = (await scanAll(table)).filter((x) => str(x, 'status') !== 'HIDDEN' && str(x, 'imageKey') && !str(x, 'artistId'));
    const prices = new Map(ptab ? (await scanAll(ptab)).map((x) => [str(x, 'productId'), x] as const) : []);
    return {
      works: items.map((x) => { const pr = prices.get(str(x, 'id')); return { id: str(x, 'id'), title: str(x, 'title'), kind: str(x, 'kind'), size: str(x, 'size'), description: str(x, 'description'), status: str(x, 'status'), imageKey: str(x, 'imageKey'), named: str(x, 'named'), code: str(x, 'code'), leadDays: num(x, 'leadDays'), leadMax: num(x, 'leadMax'), artistPrice: num(pr, 'artistPrice'), currency: str(pr, 'currency') || 'INR' }; })
        .sort((a, b) => Number(!!a.named) - Number(!!b.named) || a.id.localeCompare(b.id)),
    };
  }
  if (action === 'save') {
    const id = txt(d.id, 80);
    const title = txt(d.title, 80).replace(/\s+/g, ' ');
    const priceOnly = !title && d.price !== '' && d.price != null; // the artist may give his price before the title
    if (!priceOnly && title.length < 2) throw new Error('Give the work a title (2 to 80 letters).');
    const got = await ddb.send(new GetItemCommand({ TableName: table, Key: { id: { S: id } } }));
    if (!got.Item) throw new Error('Work not found');
    if (str(got.Item as Img, 'artistId')) throw new Error("This work belongs to another artist: they name and price it in their own portal.");
    const set: Record<string, string> = priceOnly ? { updatedAt: new Date().toISOString() } : { title, named: `${actor(ev)} ${new Date().toISOString()}`, updatedAt: new Date().toISOString() };
    const size = txt(d.size, 40), description = txt(d.description, 1000);
    // "3", "0" or a range "10-15" (days)
    const lm = String(d.leadDays ?? '').trim().match(/^(\d{1,3})\s*(?:[-–to]+\s*(\d{1,3}))?$/i);
    if (String(d.leadDays ?? '').trim() && !lm) throw new Error('Ready to send in: type days, e.g. 7 or 10-15.');
    const lead = lm ? Number(lm[1]) : null, leadMax = lm?.[2] ? Number(lm[2]) : lead;
    if (lead != null && !(lead <= 120 && (leadMax ?? 0) <= 180 && (leadMax ?? lead) >= lead)) throw new Error('Ready to send in: up to 120 days, e.g. 10-15.');
    if (size) set.size = size;
    if (description) set.description = description;
    // The artist's own price (INR) for this work, kept apart from the public catalogue.
    const price = d.price === '' || d.price == null ? null : Number(d.price);
    if (price != null) {
      if (!Number.isFinite(price) || price < 100 || price > 10_000_000) throw new Error('Enter your price in rupees (at least 100).');
      const before = ptab ? (await ddb.send(new GetItemCommand({ TableName: ptab, Key: { productId: { S: id } } }))).Item : undefined;
      // Only a real change of price counts (saving the title or lead time again must not ask for re-approval).
      if (ptab && num(before as Img | undefined, 'artistPrice') !== Math.round(price)) {
        const now = new Date().toISOString();
        await ddb.send(new UpdateItemCommand({ TableName: ptab, Key: { productId: { S: id } },
          UpdateExpression: 'SET artistPrice = :p, currency = :c, artistPriceAt = :t, updatedAt = :t, createdAt = if_not_exists(createdAt, :t), #tn = :tn',
          ExpressionAttributeNames: { '#tn': '__typename' },
          ExpressionAttributeValues: { ':p': { N: String(Math.round(price)) }, ':c': { S: 'INR' }, ':t': { S: now }, ':tn': { S: 'ArtworkPrice' } } }));
      }
    }
    const names: Record<string, string> = {}; const values: Record<string, AttributeValue> = {};
    const parts = Object.entries(set).map(([k, v], i) => { names[`#w${i}`] = k; values[`:w${i}`] = { S: v }; return `#w${i} = :w${i}`; });
    await ddb.send(new UpdateItemCommand({ TableName: table, Key: { id: { S: id } }, UpdateExpression: `SET ${parts.join(', ')}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
    if (lead != null) await ddb.send(new UpdateItemCommand({ TableName: table, Key: { id: { S: id } }, UpdateExpression: 'SET leadDays = :l, leadMax = :m', ExpressionAttributeValues: { ':l': { N: String(lead) }, ':m': { N: String(leadMax ?? lead) } } }));
    return { ok: true, id, ...set };
  }
  throw new Error('Unknown action');
}

// ---------- Codes, all 10 characters: customers BP-0000001, artworks AT-0000001, offers PR-0000001 ----------
// (Older CUST-0001 / ART-0001 / PRM-0001 codes are converted once, keeping their number.)
// Customer = the signed-in account, else the email, else the mobile number. Codes are given in order of the first
// enquiry and never change. New enquiries get theirs as they arrive; assignCodes fills in anything missing.
const custKey = (e: Img) => {
  const owner = str(e, 'owner').split('::')[0];
  if (owner) return `o:${owner}`;
  const email = str(e, 'email').toLowerCase();
  if (email) return `e:${email}`;
  const phone = str(e, 'phone').replace(/\D/g, '').slice(-9);
  return phone ? `p:${phone}` : `id:${str(e, 'id')}`;
};
const codeNum = (c: string) => Number((c.match(/(\d+)$/) ?? [])[1] ?? 0);
const pad = (n: number) => String(n).padStart(7, '0');
const recode = (prefix: string, c: string) => (c && !c.startsWith(prefix) ? `${prefix}${pad(codeNum(c))}` : c);
// ---------- Customer master ----------
const CLOSED_ORDER = ['DELIVERED', 'REFUNDED', 'CANCELLED'];
const PAID_ORDER = ['PAID', 'ARTIST_WORKING', 'ARTIST_DONE', 'ARTIST_SENT', 'PRINTING', 'PRINTED', 'FRAMING', 'SHIPPED', 'DELIVERED', 'REPLACEMENT'];
/** One row per customer code: contact and last address from their latest order (unless the studio or the customer
 *  edited it), plus order counts and spend. */
async function syncCustomers(byCode: Map<string, Img[]>) {
  const T = process.env.CUSTOMER_TABLE;
  if (!T) return;
  const now = new Date().toISOString();
  for (const [code, list] of byCode) {
    const es = [...list].sort((a, b) => str(a, 'createdAt').localeCompare(str(b, 'createdAt')));
    const last = es[es.length - 1];
    const withAddr = [...es].reverse().find((e) => str(e, 'deliveryAddress'));
    const old = plain(await getRow(T, { code: { S: code } })) || {};
    const edited = !!old.editedAt;
    const paid = es.filter((e) => PAID_ORDER.includes(str(e, 'status')));
    const spent = es.reduce((t, e) => t + (PAID_ORDER.includes(str(e, 'status')) || str(e, 'status') === 'REFUNDED' ? (num(e, 'quotedPrice') ?? 0) - (str(e, 'refundAction') && str(e, 'refundAction') !== 'DAMAGED_REPLACE' ? num(e, 'refundAmount') ?? 0 : 0) : 0), 0);
    const pick = (k: string, v: string) => (edited && old[k] ? old[k] : v || old[k]);
    const row: Dict = {
      ...old, code, __typename: 'Customer', createdAt: old.createdAt ?? str(es[0], 'createdAt') ?? now, updatedAt: now,
      name: pick('name', str(last, 'customerName')), email: pick('email', [...es].reverse().map((e) => str(e, 'email')).find(Boolean) ?? ''),
      phone: pick('phone', str(last, 'phone')), owner: old.owner || [...es].reverse().map((e) => str(e, 'owner')).find(Boolean) || undefined,
      orderCount: es.length, paidCount: paid.length, totalSpent: Math.round(spent * 100) / 100,
      firstOrderAt: str(es[0], 'createdAt'), lastOrderAt: str(last, 'createdAt'),
    };
    if (withAddr && !(edited && old.address)) Object.assign(row, { country: str(withAddr, 'deliveryCountry') || 'UAE', emirate: str(withAddr, 'deliveryEmirate'), pin: str(withAddr, 'deliveryPin'), address: str(withAddr, 'deliveryAddress'), landmark: str(withAddr, 'deliveryLandmark') });
    await putRow(T, row);
  }
}
/** Their open orders take the new contact details; orders not yet shipped also take the new address. */
async function pushToOrders(code: string, c: Dict, address: boolean) {
  const table = process.env.ENQUIRY_TABLE;
  if (!table) return 0;
  let n = 0;
  for (const e of (await scanAll(table)).filter((x) => str(x, 'customerCode') === code && !CLOSED_ORDER.includes(str(x, 'status')))) {
    const set: Record<string, string | null> = {};
    if (c.name) set.customerName = String(c.name);
    if (c.phone) set.phone = String(c.phone);
    if (address && c.address && !['SHIPPED'].includes(str(e, 'status'))) Object.assign(set, { deliveryName: String(c.name || str(e, 'deliveryName')), deliveryPhone: String(c.phone || str(e, 'deliveryPhone')), deliveryCountry: String(c.country || 'UAE'), deliveryEmirate: String(c.emirate || ''), deliveryAddress: String(c.address), deliveryLandmark: String(c.landmark || '') || null, deliveryPin: String(c.pin || '') || null });
    if (Object.keys(set).length) { await writeBack(str(e, 'id'), set); n++; }
  }
  return n;
}
/** Website → My details: the signed-in customer reads or changes their own details. */
async function customerProfile(ev: ApiEvent) {
  const T = process.env.CUSTOMER_TABLE, table = process.env.ENQUIRY_TABLE;
  if (!T || !table) throw new Error('Not configured');
  const mine = (await scanAll(table)).filter((e) => ownsEnquiry(e, ev)).sort((a, b) => str(b, 'createdAt').localeCompare(str(a, 'createdAt')));
  const code = mine.map((e) => str(e, 'customerCode')).find(Boolean);
  const email = String(ev.identity?.claims?.email ?? '');
  const cur = code ? plain(await getRow(T, { code: { S: code } })) : null;
  const view = (c: Dict | null) => ({ code: code ?? '', name: c?.name ?? str(mine[0], 'customerName'), email: c?.email || email, phone: c?.phone ?? str(mine[0], 'phone'),
    country: c?.country ?? 'UAE', emirate: c?.emirate ?? '', pin: c?.pin ?? '', address: c?.address ?? '', landmark: c?.landmark ?? '' });
  if (ev.arguments.action === 'get') return { ...view(cur), loyalty: await loyView(code ?? '', email).catch(() => ({ on: false })), programmes: await progView(code ?? '').catch(() => ({ list: [], mine: [] })) };
  if (ev.arguments.action === 'applyProgramme') return progApply(code ?? '', email, parseData(ev.arguments.data));
  if (ev.arguments.action !== 'save') throw new Error('Unknown action');
  if (!code) throw new Error('Your details are saved with your first order or enquiry. Send one first, then you can change them here.');
  const d = parseData(ev.arguments.data);
  const name = txt(d.name, 80), phone = txt(d.phone, 30);
  if (!name) throw new Error('Add your name.');
  if (phone.replace(/\D/g, '').length < 7) throw new Error('Add a valid mobile number.');
  const hasAddr = !!txt(d.address, 300);
  const a = hasAddr ? checkAddress({ name, phone, country: d.country, emirate: d.emirate, pin: d.pin, address: d.address, landmark: d.landmark } as ApiEvent['arguments']) : null;
  const now = new Date().toISOString();
  const row: Dict = { ...(cur || {}), code, __typename: 'Customer', createdAt: cur?.createdAt ?? now, updatedAt: now, name, phone, email: cur?.email || email,
    ...(a ? { country: a.country, emirate: a.region, pin: a.pin || undefined, address: a.address, landmark: a.landmark || undefined } : {}), editedBy: 'customer', editedAt: now };
  await putRow(T, row);
  const n = await pushToOrders(code, row, !!a);
  return { ok: true, updatedOrders: n, ...view(row) };
}

async function assignCodes() {
  const out = { customers: 0, artworks: 0 };
  const table = process.env.ENQUIRY_TABLE;
  if (table) {
    const all = (await scanAll(table)).sort((a, b) => str(a, 'createdAt').localeCompare(str(b, 'createdAt')));
    // One customer = same account, or same email, or same mobile (a guest order and a signed-in one join up).
    const keysOf = (e: Img) => {
      const k: string[] = [];
      const owner = str(e, 'owner').split('::')[0]; if (owner) k.push(`o:${owner}`);
      const email = str(e, 'email').toLowerCase().trim(); if (email) k.push(`e:${email}`);
      const phone = str(e, 'phone').replace(/\D/g, '').slice(-9); if (phone.length >= 7) k.push(`p:${phone}`);
      return k.length ? k : [custKey(e)];
    };
    const byKey = new Map<string, string>();
    const byCode = new Map<string, Img[]>();
    let max = all.reduce((m, e) => Math.max(m, codeNum(str(e, 'customerCode'))), 0);
    for (const e of all) {
      const ks = keysOf(e);
      const have = str(e, 'customerCode');
      const code = ks.map((k) => byKey.get(k)).find(Boolean) ?? (recode('BP-', have) || `BP-${pad(++max)}`);
      ks.forEach((k) => { if (!byKey.has(k)) byKey.set(k, code); });
      if (code !== have) { await writeBack(str(e, 'id'), { customerCode: code }); out.customers++; }
      (byCode.get(code) ?? byCode.set(code, []).get(code)!).push(e);
    }
    // A guest order (sent without signing in, no email) from a known customer (same mobile): use the email from their
    // other orders, so they get the status emails too.
    for (const list of byCode.values()) {
      const mail = [...list].reverse().map((e) => str(e, 'email').trim()).find((m) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m));
      if (mail) for (const e of list) if (!str(e, 'email').trim()) await writeBack(str(e, 'id'), { email: mail }).catch(() => {});
    }
    await syncCustomers(byCode).catch((err) => console.warn('Customer master not updated', err));
    await catchUpArtistStatus(all);
    // Portal artists' collection orders still without the artist's price: take it from their work (price or listing).
    const openArt = all.filter((e) => str(e, 'kind') === 'PRICE' && str(e, 'artistId') && !str(e, 'zohoPOId') && !['CANCELLED', 'REFUNDED'].includes(str(e, 'status')));
    if (openArt.length) {
      const cost = await costingFor(openArt.map((e) => str(e, 'id')));
      for (const e of openArt) { const c = cost.get(str(e, 'id')); if (num(c, 'artistPriceInr') == null && num(c, 'artistPriceAed') == null) await useCataloguePrice(str(e, 'id'), e).catch(() => {}); }
    }
    // Older paid orders still showing a "please pay" message: clear it.
    for (const e of all) if (PAIDISH.includes(str(e, 'status')) && PAY_MSG.test(str(e, 'adminMessage'))) await writeBack(str(e, 'id'), { adminMessage: null }).catch(() => {});
  }
  // Offer master numbers PR-0000001… (in order of creation).
  const prtable = process.env.PROMO_TABLE;
  if (prtable) {
    const promos = (await scanAll(prtable)).sort((a, b) => str(a, 'createdAt').localeCompare(str(b, 'createdAt')));
    let max = promos.reduce((m, p) => Math.max(m, codeNum(str(p, 'number'))), 0);
    for (const p of promos.filter((x) => str(x, 'number') && !str(x, 'number').startsWith('PR-'))) {
      await ddb.send(new UpdateItemCommand({ TableName: prtable, Key: { id: { S: str(p, 'id') } }, UpdateExpression: 'SET #n = :n', ExpressionAttributeNames: { '#n': 'number' }, ExpressionAttributeValues: { ':n': { S: recode('PR-', str(p, 'number')) } } })).catch(() => {});
    }
    for (const p of promos.filter((x) => !str(x, 'number'))) {
      await ddb.send(new UpdateItemCommand({ TableName: prtable, Key: { id: { S: str(p, 'id') } }, UpdateExpression: 'SET #n = :n', ConditionExpression: 'attribute_not_exists(#n)', ExpressionAttributeNames: { '#n': 'number' }, ExpressionAttributeValues: { ':n': { S: `PR-${pad(++max)}` } } })).catch(() => {});
    }
  }
  // Artists' works approved before they joined the collection: move them across (fixed-price item → priced work).
  try {
    const { S, L, M } = mtables();
    for (const it of (await scanAll(M)).map(plain).filter((x): x is Dict => !!x && x.sellerType === 'ARTIST')) {
      const l = plain(await getRow(L, { id: { S: String(it.listingId) } }));
      const seller = l ? plain(await getRow(S, { id: { S: String(l.sellerId) } })) : null;
      if (l && seller?.type === 'ARTIST' && l.status === 'APPROVED') await upsertArtistProduct(l, seller, false);
      if (l && seller?.type === 'ARTIST') await delRow(M, { listingId: { S: String(it.listingId) } });
    }
  } catch (err) { console.warn('Artist works not moved', err); }
  const ptable = process.env.PRODUCT_TABLE;
  if (ptable) {
    const prods = (await scanAll(ptable)).sort((a, b) => str(a, 'createdAt').localeCompare(str(b, 'createdAt')) || str(a, 'id').localeCompare(str(b, 'id')));
    let max = prods.reduce((m, p) => Math.max(m, codeNum(str(p, 'code'))), 0);
    for (const p of prods.filter((x) => str(x, 'code') && !str(x, 'code').startsWith('AT-'))) {
      await ddb.send(new UpdateItemCommand({ TableName: ptable, Key: { id: { S: str(p, 'id') } }, UpdateExpression: 'SET #c = :c', ExpressionAttributeNames: { '#c': 'code' }, ExpressionAttributeValues: { ':c': { S: recode('AT-', str(p, 'code')) } } })).catch(() => {});
      out.artworks++;
    }
    for (const p of prods.filter((x) => !str(x, 'code'))) {
      await ddb.send(new UpdateItemCommand({ TableName: ptable, Key: { id: { S: str(p, 'id') } }, UpdateExpression: 'SET #c = :c', ConditionExpression: 'attribute_not_exists(#c)', ExpressionAttributeNames: { '#c': 'code' }, ExpressionAttributeValues: { ':c': { S: `AT-${pad(++max)}` } } })).catch(() => {});
      out.artworks++;
    }
  }
  // Keep every approved artist's public portfolio card up to date (photo, featured work, training…).
  try {
    const { S } = mtables();
    for (const p of (await scanAll(S)).map(plain).filter((x): x is Dict => !!x && x.type === 'ARTIST' && x.status === 'APPROVED')) await publishArtist(p);
  } catch (e) { console.log('Artist cards not refreshed', e); }
  return out;
}

// ---------- Discount codes (Offers tab) ----------
// The customer types a code on an order that has a price and isn't paid. The function checks the offer (dates, active,
// minimum order, what it applies to, uses left), lowers quotedPrice and keeps listPrice + discountAmount. The price
// change flows on by itself: new Ziina link, Zoho quote updated, invoice at the discounted price.
const AREA: Record<string, string[]> = { ALL: ['PRICE', 'COMMISSION', 'GIFT', 'MARKET', 'PHOTO', 'LICENCE'], ART: ['PRICE', 'COMMISSION'], CRAFTS: ['MARKET'], GIFT: ['GIFT'] };
async function findPromo(code: string) {
  const table = process.env.PROMO_TABLE;
  if (!table || !code) return null;
  const now = new Date().toISOString();
  // The same code may be re-used by a later offer (Re-use in the Offers tab): take the one running now, if any.
  const same = (await scanAll(table)).filter((x) => str(x, 'code').toUpperCase() === code.toUpperCase());
  const live = (x: Img) => !!x.active?.BOOL && (!str(x, 'startAt') || str(x, 'startAt') <= now) && (!str(x, 'endAt') || str(x, 'endAt') >= now);
  const p = same.find(live) ?? same.sort((a, b) => str(b, 'startAt').localeCompare(str(a, 'startAt')))[0];
  if (!p) return { error: 'This code is not valid.' };
  if (!p.active?.BOOL) return { error: 'This offer has ended.' };
  if (str(p, 'startAt') && str(p, 'startAt') > now) return { error: 'This offer has not started yet.' };
  if (str(p, 'endAt') && str(p, 'endAt') < now) return { error: 'This offer has ended.' };
  const max = num(p, 'maxUses');
  if (max && (num(p, 'usedCount') ?? 0) >= max) return { error: 'This code has been fully used.' };
  return { p };
}
function discountFor(p: Img, kind: string, price: number): { amount: number; error?: string } {
  const area = AREA[str(p, 'appliesTo') || 'ALL'] ?? AREA.ALL;
  if (!area.includes(kind)) return { amount: 0, error: `This code doesn't apply to ${kind === 'MARKET' ? 'Crafts shop items' : kind === 'GIFT' ? 'Little Artists gifts' : 'artworks and commissions'}.` };
  const min = num(p, 'minOrder') ?? 0;
  if (min && price < min) return { amount: 0, error: `This code needs an order of at least AED ${min}.` };
  const v = num(p, 'discountValue') ?? 0;
  const amount = Math.min(price - 2, str(p, 'discountType') === 'AED' ? v : Math.round(price * v) / 100);
  if (!(amount > 0)) return { amount: 0, error: 'This code gives no discount on this order.' };
  return { amount: Math.round(amount * 100) / 100 };
}
async function bumpUses(code: string, delta: number) {
  const table = process.env.PROMO_TABLE;
  if (!table || !code) return;
  const now = new Date().toISOString();
  const same = (await scanAll(table)).filter((x) => str(x, 'code').toUpperCase() === code.toUpperCase());
  const p = same.find((x) => !!x.active?.BOOL && (!str(x, 'startAt') || str(x, 'startAt') <= now) && (!str(x, 'endAt') || str(x, 'endAt') >= now)) ?? same.sort((a, b) => str(b, 'startAt').localeCompare(str(a, 'startAt')))[0];
  if (!p) return;
  await ddb.send(new UpdateItemCommand({ TableName: table, Key: { id: { S: str(p, 'id') } }, UpdateExpression: 'SET usedCount = if_not_exists(usedCount, :z) + :d', ExpressionAttributeValues: { ':z': { N: '0' }, ':d': { N: String(delta) } } }));
}
// ---------- Kalai Circle (loyalty points) ----------
// Points on every paid order once it has been delivered for 48 hours (no refund window left), more back at higher
// levels, spent like a gift card on a later order (up to a share of the price), a referral code per customer, and
// expiry a set time after the last order. Settings → Kalai Circle sets the numbers (SiteSetting.loyalty).
type LoyCfg = { on: boolean; pointValue: number; minRedeem: number; maxPct: number; expiryMonths: number;
  tiers: { name: string; spend: number; orders: number; pct: number }[]; friendAed: number; friendMin: number; referrerAed: number; refMaxYear: number };
const LOY_DEF: LoyCfg = { on: true, pointValue: 3, minRedeem: 500, maxPct: 30, expiryMonths: 12,
  tiers: [{ name: 'Friend', spend: 0, orders: 0, pct: 3 }, { name: 'Collector', spend: 2000, orders: 3, pct: 5 }, { name: 'Patron', spend: 6000, orders: 0, pct: 7 }],
  friendAed: 50, friendMin: 300, referrerAed: 50, refMaxYear: 10 };
async function loyCfg(): Promise<LoyCfg> {
  const t = process.env.SITE_TABLE;
  try { const raw = t ? (await ddb.send(new GetItemCommand({ TableName: t, Key: { id: { S: 'site' } } }))).Item?.loyalty?.S : ''; return { ...LOY_DEF, ...(raw ? JSON.parse(raw) : {}) }; } catch { return LOY_DEF; }
}
/** The level a customer has reached: total paid spend or number of orders (either). */
function tierOf(c: Dict | null, cfg: LoyCfg) {
  const spend = Number(c?.loyaltySpend ?? 0), orders = Number(c?.loyaltyOrders ?? 0);
  const ts = [...cfg.tiers].sort((a, b) => a.spend - b.spend);
  let t = ts[0];
  for (const x of ts) if ((x.spend && spend >= x.spend) || (x.orders && orders >= x.orders) || (!x.spend && !x.orders)) t = x;
  const next = ts[ts.indexOf(t) + 1];
  return { tier: t, next, spend, orders };
}
const ptsWorth = (pts: number, cfg: LoyCfg) => Math.floor(pts * cfg.pointValue) / 100; // AED
const ptsFor = (aed: number, cfg: LoyCfg) => Math.round(aed * 100 / cfg.pointValue);
async function loyCustomer(code: string) { const T = process.env.CUSTOMER_TABLE; return T && code ? plain(await getRow(T, { code: { S: code } })) : null; }
async function loyAdd(code: string, pts: number, why: string, ref: string, cfg: LoyCfg, extra: Dict = {}) {
  const T = process.env.CUSTOMER_TABLE;
  if (!T || !code) return null;
  const c = (await loyCustomer(code)) ?? { code, __typename: 'Customer', createdAt: new Date().toISOString() };
  let log: Dict[] = []; try { log = JSON.parse(String(c.loyaltyLog ?? '[]')); } catch { log = []; }
  const now = new Date();
  log.push({ at: now.toISOString(), pts, why, ref });
  const row: Dict = { ...c, ...extra, loyaltyPoints: Math.max(0, Number(c.loyaltyPoints ?? 0) + pts), loyaltyLog: JSON.stringify(log.slice(-200)), updatedAt: now.toISOString() };
  if (pts > 0 && why !== 'adjust') row.loyaltyExpireAt = new Date(now.getTime() + cfg.expiryMonths * 30.44 * 864e5).toISOString();
  row.loyaltyTier = tierOf(row, cfg).tier.name;
  await putRow(T, row);
  return row;
}
// ---------- Special programmes (seniors, Little Artists, top students, healthy-life rewards …) ----------
// The studio keeps the list (Offers → Special programmes, SiteSetting.programmes). A signed-in customer applies from
// My enquiries & orders; the studio approves or declines. Ongoing → the customer's standard discount (taken off when the
// price is sent); one-time → a code locked to their email (FOC → a gift card up to a cap). Proof is optional and the
// uploaded file is deleted when the studio decides.
type Prog = { id: string; on: boolean; name: string; about: string; type: 'PCT' | 'AED' | 'FOC'; value: number; cap: number; kind: 'ONGOING' | 'ONCE'; months: number; days: number; area: string; proof: string; upload: boolean };
const PROG_DEF: Prog[] = [
  { id: 'senior', on: true, name: 'Senior citizens (60+)', about: 'Every order, always.', type: 'PCT', value: 25, cap: 0, kind: 'ONGOING', months: 0, days: 0, area: 'ALL', proof: 'Your year of birth. Show your Emirates ID or passport on WhatsApp or at delivery; no need to upload it.', upload: false },
  { id: 'little', on: true, name: 'Little Artists (children under 10)', about: 'For orders for a child under 10.', type: 'PCT', value: 25, cap: 0, kind: 'ONGOING', months: 12, days: 0, area: 'ALL', proof: "The child's first name and age (a parent's word is enough).", upload: false },
  { id: 'student', on: true, name: 'Top students', about: 'A free artwork for an outstanding academic result.', type: 'FOC', value: 0, cap: 500, kind: 'ONCE', months: 0, days: 90, area: 'ALL', proof: 'A photo of the report card or certificate (deleted once we decide).', upload: true },
  { id: 'smoke', on: true, name: 'Quit smoking', about: 'Three months smoke-free? Celebrate with art.', type: 'PCT', value: 20, cap: 0, kind: 'ONCE', months: 0, days: 90, area: 'ALL', proof: 'Your own word. No medical papers needed.', upload: false },
  { id: 'drink', on: true, name: 'Alcohol-free', about: 'Three months alcohol-free.', type: 'PCT', value: 20, cap: 0, kind: 'ONCE', months: 0, days: 90, area: 'ALL', proof: 'Your own word. No medical papers needed.', upload: false },
  { id: 'weight', on: true, name: 'Weight-loss goal reached', about: 'For example 5 kg in a month.', type: 'PCT', value: 15, cap: 0, kind: 'ONCE', months: 0, days: 90, area: 'ALL', proof: 'Your own word. No weigh-in photos needed.', upload: false },
  { id: 'pod', on: false, name: 'People of Determination', about: 'Every order.', type: 'PCT', value: 25, cap: 0, kind: 'ONGOING', months: 0, days: 0, area: 'ALL', proof: 'Your Sanad card or People of Determination card number.', upload: false },
  { id: 'health', on: false, name: 'Healthcare workers', about: 'Doctors, nurses and care staff.', type: 'PCT', value: 10, cap: 0, kind: 'ONGOING', months: 12, days: 0, area: 'ALL', proof: 'Your workplace and job title.', upload: false },
  { id: 'teacher', on: false, name: 'Teachers', about: 'School and nursery teachers.', type: 'PCT', value: 10, cap: 0, kind: 'ONGOING', months: 12, days: 0, area: 'ALL', proof: 'Your school and subject.', upload: false },
  { id: 'blood', on: false, name: 'Blood donors', about: 'Thank you for donating.', type: 'PCT', value: 15, cap: 0, kind: 'ONCE', months: 0, days: 90, area: 'ALL', proof: 'The date and place you donated.', upload: false },
  { id: 'volunteer', on: false, name: 'Volunteers', about: 'Volunteering for a charity or community group.', type: 'PCT', value: 10, cap: 0, kind: 'ONCE', months: 0, days: 90, area: 'ALL', proof: 'The organisation you volunteer with.', upload: false },
  { id: 'newhome', on: false, name: 'Newlyweds and new homes', about: 'A gift for a new chapter.', type: 'PCT', value: 15, cap: 0, kind: 'ONCE', months: 0, days: 60, area: 'ALL', proof: 'The month of your wedding or move.', upload: false },
  { id: 'birthday', on: false, name: 'Birthday month', about: 'A treat in your birthday month.', type: 'PCT', value: 10, cap: 0, kind: 'ONCE', months: 0, days: 30, area: 'ALL', proof: 'Your birthday (day and month).', upload: false },
];
async function progList(): Promise<Prog[]> {
  const t = process.env.SITE_TABLE;
  try { const raw = t ? (await ddb.send(new GetItemCommand({ TableName: t, Key: { id: { S: 'site' } } }))).Item?.programmes?.S : ''; const l = raw ? JSON.parse(raw) as Prog[] : []; return l.length ? l : PROG_DEF; } catch { return PROG_DEF; }
}
type ProgApp = { id: string; pid: string; name: string; status: 'PENDING' | 'APPROVED' | 'DECLINED' | 'ENDED'; at: string; who: string; said: string; proofKey?: string; email: string; decidedAt?: string; note?: string; voucher?: string; until?: string; offer?: string };
const progApps = (c: Dict | null): ProgApp[] => { try { return JSON.parse(String(c?.programmes ?? '[]')); } catch { return []; } };
const progOffer = (p: Prog) => p.type === 'FOC' ? `free (up to AED ${p.cap})` : p.type === 'AED' ? `AED ${p.value} off` : `${p.value}% off`;
/** The programmes a customer can see, and their own requests. */
async function progView(code: string) {
  const list = (await progList()).filter((p) => p.on).map((p) => ({ id: p.id, name: p.name, about: p.about, offer: progOffer(p), kind: p.kind, proof: p.proof, upload: p.upload }));
  const c = code ? await loyCustomer(code) : null;
  return { list, mine: progApps(c).slice(-20).reverse().map((a) => ({ id: a.id, pid: a.pid, name: a.name, status: a.status, at: a.at, voucher: a.voucher ?? '', until: a.until ?? '', note: a.note ?? '', offer: a.offer ?? '' })) };
}
async function progApply(code: string, email: string, d: Dict) {
  const T = process.env.CUSTOMER_TABLE;
  if (!T) throw new Error('Not configured');
  if (!code) throw new Error('Programmes open once your first enquiry or order is registered. Send one first, then apply here.');
  const p = (await progList()).find((x) => x.on && x.id === txt(d.pid, 30));
  if (!p) throw new Error('This programme is not open now.');
  if (!d.agree) throw new Error('Please confirm the details are true.');
  const c = await loyCustomer(code);
  const apps = progApps(c);
  if (apps.some((a) => a.pid === p.id && (a.status === 'PENDING' || (a.status === 'APPROVED' && (p.kind === 'ONGOING' || !a.decidedAt || a.decidedAt > new Date(Date.now() - 365 * 864e5).toISOString())))))
    throw new Error('You have already applied for this programme.');
  const key = txt(d.proofKey, 300);
  const app: ProgApp = { id: crypto.randomUUID().slice(0, 8), pid: p.id, name: p.name, status: 'PENDING', at: new Date().toISOString(), who: txt(d.who, 80), said: txt(d.said, 400), email, offer: progOffer(p), ...(key && key.startsWith('uploads/') ? { proofKey: key } : {}) };
  apps.push(app);
  await putRow(T, { ...(c ?? { code, __typename: 'Customer', createdAt: app.at }), programmes: JSON.stringify(apps.slice(-50)), updatedAt: app.at });
  await sendMail({ to: STUDIO_EMAIL, subject: `Programme request: ${p.name} (${code})`, lines: [`<b>${h(String(c?.name ?? code))}</b> (${h(code)}, ${h(email)}) applied for <b>${h(p.name)}</b>: ${h(progOffer(p))}.`, app.who ? `For: ${h(app.who)}` : '', app.said ? `They say: ${h(app.said)}` : '', key ? 'A proof file is attached to the request.' : ''].filter(Boolean), button: { label: 'Open Offers → Special programmes', url: `${SITE}/admin.html#offers` }, footer: 'Studio notification from art.pranixtechno.com' }).catch(() => {});
  return progView(code);
}
/** Studio: approve or decline a request. Returns the proof file key (the page deletes it). */
async function progDecide(d: Dict) {
  const T = process.env.CUSTOMER_TABLE;
  if (!T) throw new Error('Not configured');
  const code = txt(d.code, 20), c = await loyCustomer(code);
  const apps = progApps(c), a = apps.find((x) => x.id === txt(d.appId, 20));
  if (!c || !a) throw new Error('Request not found');
  if (a.status !== 'PENDING' && !(d.decision === 'END' && a.status === 'APPROVED')) throw new Error('This request is already decided.');
  const p = (await progList()).find((x) => x.id === a.pid);
  const now = new Date(), note = txt(d.note, 200), first = String(c.name || '').split(' ')[0] || 'there';
  const proofKey = a.proofKey ?? '';
  delete a.proofKey; a.decidedAt = now.toISOString(); if (note) a.note = note;
  const row: Dict = { ...c, updatedAt: now.toISOString() };
  let lines: string[] = [];
  if (d.decision === 'END') {
    a.status = 'ENDED';
    if (row.discountNote === a.name) { row.discountType = undefined; row.discountValue = undefined; row.discountNote = undefined; row.discountArea = undefined; }
  } else if (d.decision !== 'APPROVE') {
    a.status = 'DECLINED';
    lines = [`Hello ${h(first)},`, `Thank you for applying for <b>${h(a.name)}</b>. We're sorry, we can't approve it this time.`, note ? h(note) : '', 'If you have any questions, just reply to this email.'];
  } else {
    if (!p) throw new Error('This programme is no longer in the list.');
    a.status = 'APPROVED';
    if (p.kind === 'ONGOING') {
      if (p.type === 'FOC') throw new Error('A free (FOC) programme must be one-time.');
      const until = txt(d.until, 10) ? new Date(`${txt(d.until, 10)}T23:59:59+04:00`) : p.months ? new Date(now.getTime() + p.months * 30.44 * 864e5) : null;
      if (until && !isNaN(until.getTime())) a.until = until.toISOString();
      Object.assign(row, { discountType: p.type, discountValue: p.value, discountNote: p.name, discountArea: p.area || 'ALL' });
      lines = [`Hello ${h(first)},`, `Good news: you're now in our <b>${h(p.name)}</b> programme. You get <b>${h(progOffer(p))}</b>${p.area && p.area !== 'ALL' ? ' on matching orders' : ' on your orders'}${a.until ? ` until ${new Date(a.until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}.`, "It's taken off automatically when we send you the price.", note ? h(note) : ''];
    } else {
      const V = process.env.VOUCHER_TABLE;
      if (!V) throw new Error('Vouchers not configured');
      const vc = `PRG-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('').replace(/(.{4})/, '$1-')}`;
      const endAt = new Date(now.getTime() + (p.days || 90) * 864e5).toISOString();
      const gift = p.type === 'FOC';
      await putRow(V, { id: `prg-${code}-${a.id}`, __typename: 'Voucher', createdAt: now.toISOString(), updatedAt: now.toISOString(), code: vc, kind: gift ? 'GIFT' : 'CODE',
        ...(gift ? { value: p.cap, balance: p.cap } : { discountType: p.type, discountValue: p.value, maxUses: 1 }), appliesTo: p.area || 'ALL', active: true, usedCount: 0, uses: '[]',
        forName: String(c.name ?? ''), forEmail: a.email || String(c.email ?? ''), forPhone: String(c.phone ?? ''), endAt, note: `Programme: ${p.name} (${code})` });
      a.voucher = vc; a.until = endAt;
      lines = [`Hello ${h(first)},`, `Congratulations, and thank you for sharing your news. Your <b>${h(p.name)}</b> reward is ready: <b>${h(progOffer(p))}</b>${gift ? ' on one artwork' : ' on one order'}.`, `Your code: <b style="font-size:18px;letter-spacing:1px">${h(vc)}</b>, valid until ${new Date(endAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}. It works with this email address only.`, 'Enter it on your order under My enquiries & orders.', note ? h(note) : ''];
    }
  }
  row.programmes = JSON.stringify(apps);
  await putRow(T, row);
  const to = a.email || String(c.email ?? '');
  if (to && lines.length) await sendMail({ to, subject: a.status === 'APPROVED' ? `Welcome to ${a.name}: Kalai Art House` : `Your ${a.name} request`, lines: lines.filter(Boolean), button: MY }).catch(() => {});
  return { ok: true, status: a.status, voucher: a.voucher ?? '', proofKey, emailed: !!(to && lines.length) };
}
/** Hourly: ongoing programme discounts that have reached their end date. */
async function progExpire() {
  const T = process.env.CUSTOMER_TABLE;
  if (!T) return;
  const now = new Date().toISOString();
  for (const c of (await scanAll(T)).map(plain)) {
    if (!c?.programmes) continue;
    const apps = progApps(c); let changed = false;
    for (const a of apps) if (a.status === 'APPROVED' && !a.voucher && a.until && a.until < now) { a.status = 'ENDED'; changed = true; if (c.discountNote === a.name) { c.discountType = undefined; c.discountValue = undefined; c.discountNote = undefined; c.discountArea = undefined; } }
    if (changed) await putRow(T, { ...c, programmes: JSON.stringify(apps), updatedAt: now });
  }
}
/** Hourly: points for orders delivered 48 h ago, referral rewards, and expiry. */
async function awardLoyalty() {
  const cfg = await loyCfg();
  const table = process.env.ENQUIRY_TABLE, T = process.env.CUSTOMER_TABLE;
  if (!cfg.on || !table || !T) return;
  const cutoff = new Date(Date.now() - 48 * 3600_000).toISOString();
  for (const e of await scanAll(table)) {
    if (str(e, 'status') !== 'DELIVERED' || str(e, 'loyaltyAt') || !str(e, 'customerCode') || str(e, 'cancelState') === 'REQUESTED') continue;
    let at = str(e, 'deliveredAt'); if (!at) { try { const log = JSON.parse(str(e, 'statusLog') || '[]') as { s: string; at: string }[]; at = log.filter((x) => x.s === 'DELIVERED').pop()?.at ?? ''; } catch { at = ''; } }
    if (!at || at > cutoff) continue;
    const paid = num(e, 'quotedPrice') ?? 0;
    const c = await loyCustomer(str(e, 'customerCode'));
    const { tier } = tierOf(c, cfg);
    const pts = paid > 0 ? ptsFor(paid * tier.pct / 100, cfg) : 0;
    const row = await loyAdd(str(e, 'customerCode'), pts, 'order', str(e, 'ref'), cfg, { loyaltySpend: Math.round((Number(c?.loyaltySpend ?? 0) + paid) * 100) / 100, loyaltyOrders: Number(c?.loyaltyOrders ?? 0) + 1 });
    await writeBack(str(e, 'id'), { loyaltyPoints: pts, loyaltyAt: new Date().toISOString() });
    // The friend who referred them: their reward, once per new customer (and up to the yearly limit).
    const by = str(e, 'referralBy');
    if (by && by !== str(e, 'customerCode')) {
      const rc = await loyCustomer(by);
      let log: Dict[] = []; try { log = JSON.parse(String(rc?.loyaltyLog ?? '[]')); } catch { log = []; }
      const year = log.filter((x) => x.why === 'referral' && String(x.at) > new Date(Date.now() - 365 * 864e5).toISOString()).length;
      if (rc && year < cfg.refMaxYear && !log.some((x) => x.why === 'referral' && x.ref === str(e, 'customerCode'))) {
        const rr = await loyAdd(by, ptsFor(cfg.referrerAed, cfg), 'referral', str(e, 'customerCode'), cfg);
        if (rr?.email) await sendMail({ to: String(rr.email), subject: 'Thank you for the introduction: Kalai Circle points added', lines: [`Hello ${h(String(rr.name || '').split(' ')[0] || 'there')},`, `A friend you invited has received their first order from Kalai Art House. We've added <b>${ptsFor(cfg.referrerAed, cfg)} points</b> (worth AED ${cfg.referrerAed}) to your Kalai Circle.`, `Your balance: <b>${rr.loyaltyPoints} points</b> (AED ${ptsWorth(Number(rr.loyaltyPoints), cfg)}).`], button: MY }).catch(() => {});
      }
    }
    if (row?.email && pts > 0 && (await emailsOn()) && !(await mailOff()).includes('LOYALTY')) await sendMail({ to: String(row.email), subject: `You earned ${pts} Kalai Circle points`, lines: [`Hello ${h(String(row.name || '').split(' ')[0] || 'there')},`, `Thank you for your order ${h(str(e, 'ref'))}. You've earned <b>${pts} points</b> (worth AED ${ptsWorth(pts, cfg)}).`, `Your balance: <b>${row.loyaltyPoints} points</b> (AED ${ptsWorth(Number(row.loyaltyPoints), cfg)}) · level <b>${h(String(row.loyaltyTier))}</b>. Spend them on your next order under My enquiries & orders.`], button: MY }).catch(() => {});
  }
  // Expiry: the balance lapses a set time after the last order that earned points.
  const now = new Date().toISOString();
  for (const c of (await scanAll(T)).map(plain)) if (c && Number(c.loyaltyPoints ?? 0) > 0 && c.loyaltyExpireAt && String(c.loyaltyExpireAt) < now) await loyAdd(String(c.code), -Number(c.loyaltyPoints), 'expired', '', cfg);
}
/** The customer's Kalai Circle summary (and their referral code, made on first look). */
async function loyView(code: string, email: string) {
  const cfg = await loyCfg();
  if (!cfg.on || !code) return { on: cfg.on };
  let c = await loyCustomer(code);
  if (c && !c.referralCode && process.env.VOUCHER_TABLE) {
    const ref = `REF-${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('')}`;
    const now = new Date().toISOString();
    await putRow(process.env.VOUCHER_TABLE, { id: `ref-${code}`, __typename: 'Voucher', createdAt: now, updatedAt: now, code: ref, kind: 'REF', discountType: 'AED', discountValue: cfg.friendAed, minOrder: cfg.friendMin, appliesTo: 'ALL', active: true, usedCount: 0, uses: '[]', refOwner: code, forName: String(c.name ?? ''), forEmail: '' });
    c = { ...c, referralCode: ref };
    await putRow(process.env.CUSTOMER_TABLE!, c);
  }
  const { tier, next, spend, orders } = tierOf(c, cfg);
  const pts = Number(c?.loyaltyPoints ?? 0);
  let log: Dict[] = []; try { log = JSON.parse(String(c?.loyaltyLog ?? '[]')); } catch { log = []; }
  return { on: true, points: pts, worth: ptsWorth(pts, cfg), pointValue: cfg.pointValue, minRedeem: cfg.minRedeem, maxPct: cfg.maxPct, tier: tier.name, pct: tier.pct,
    next: next ? { name: next.name, spend: next.spend, orders: next.orders, pct: next.pct, spendLeft: Math.max(0, next.spend - spend), ordersLeft: next.orders ? Math.max(0, next.orders - orders) : null } : null,
    expireAt: pts > 0 ? c?.loyaltyExpireAt ?? '' : '', referralCode: c?.referralCode ?? '', friendAed: cfg.friendAed, friendMin: cfg.friendMin, referrerAed: cfg.referrerAed, tiers: cfg.tiers, history: log.slice(-12).reverse(), email };
}
/** Customer: spend points on an order (or take them off). */
async function redeemPoints(ev: ApiEvent) {
  const cfg = await loyCfg();
  if (!cfg.on) throw new Error('Kalai Circle is paused.');
  const id = String(ev.arguments.id ?? ''), want = Math.max(0, Math.floor(Number((ev.arguments as { points?: number }).points ?? 0)));
  const e = await enquiryRow(id);
  const groups = ev.identity?.groups ?? (ev.identity?.claims?.['cognito:groups'] as string[] | undefined) ?? [];
  if (!e || (!ownsEnquiry(e, ev) && !groups.includes('ADMINS'))) throw new Error('Order not found');
  if (!['RECEIVED', 'PRICE_SENT'].includes(str(e, 'status') || 'RECEIVED') || str(e, 'zohoInvoiceId')) throw new Error('This order is already paid.');
  if (str(e, 'basketRef') && str(e, 'ziinaIntentId')) throw new Error('This order is paid together with the rest of your cart, so points can\'t be added to it alone.');
  const code = str(e, 'customerCode');
  if (!code) throw new Error('Points are available once your first order is registered.');
  const had = num(e, 'loyaltyRedeemed') ?? 0, hadAmt = num(e, 'loyaltyAmount') ?? 0;
  const list = num(e, 'listPrice') ?? num(e, 'quotedPrice') ?? 0;
  if (!(list > 0)) throw new Error('Spend points once we have sent you the price.');
  const base = Math.round((list - (num(e, 'discountAmount') ?? 0)) * 100) / 100; // after an offer code / studio discount
  if (had) await loyAdd(code, had, 'back', str(e, 'ref'), cfg); // give back what was on the order first
  if (!want) {
    await updateEnquiry(id, { loyaltyRedeemed: null, loyaltyAmount: null, quotedPrice: base, listPrice: num(e, 'discountAmount') ? list : null });
    return { ok: true, price: base };
  }
  const c = await loyCustomer(code);
  const bal = Number(c?.loyaltyPoints ?? 0);
  if (want < cfg.minRedeem) throw new Error(`Spend at least ${cfg.minRedeem} points.`);
  if (want > bal) throw new Error(`You have ${bal} points.`);
  const amt = Math.min(ptsWorth(want, cfg), Math.floor(base * cfg.maxPct) / 100);
  const used = Math.min(want, Math.ceil(amt * 100 / cfg.pointValue));
  await loyAdd(code, -used, 'spent', str(e, 'ref'), cfg);
  const price = Math.round((base - amt) * 100) / 100;
  await updateEnquiry(id, { loyaltyRedeemed: used, loyaltyAmount: amt, listPrice: list, quotedPrice: price });
  void hadAmt;
  return { ok: true, used, amount: amt, price };
}
/** An unpaid order cancelled with points on it: the points go back. */
async function loyaltyOnStatus(rec: StreamRecord) {
  const img = rec.dynamodb?.NewImage, old = rec.dynamodb?.OldImage;
  if (rec.eventName !== 'MODIFY' || !img || !old || str(img, 'status') === str(old, 'status')) return;
  if (str(img, 'status') === 'CANCELLED' && (num(img, 'loyaltyRedeemed') ?? 0) > 0) {
    const cfg = await loyCfg();
    await loyAdd(str(img, 'customerCode'), num(img, 'loyaltyRedeemed')!, 'back', str(img, 'ref'), cfg);
    await writeBack(str(img, 'id'), { loyaltyRedeemed: null, loyaltyAmount: null });
  }
}

// ---------- Private codes and gift cards (Voucher) ----------
async function findVoucher(code: string) {
  const T = process.env.VOUCHER_TABLE;
  if (!T || !code) return null;
  return (await scanAll(T)).find((x) => str(x, 'code').toUpperCase() === code.toUpperCase()) ?? null;
}
/** The amount a private code / gift card takes off this order, or the reason it can't be used. */
function voucherAmount(v: Img, e: Img, list: number): { amount: number; error?: string } {
  const now = new Date().toISOString();
  if (!v.active?.BOOL) return { amount: 0, error: 'This code is no longer active.' };
  if (str(v, 'endAt') && str(v, 'endAt') < now) return { amount: 0, error: 'This code has expired.' };
  const lock = str(v, 'forEmail').toLowerCase();
  if (lock && lock !== str(e, 'email').toLowerCase()) return { amount: 0, error: 'This code was given to someone else: sign in with the email it was sent to.' };
  if (str(v, 'kind') === 'GIFT') {
    const bal = num(v, 'balance') ?? 0;
    if (!(bal > 0)) return { amount: 0, error: 'This gift card has been fully used.' };
    return { amount: Math.round(Math.min(bal, list) * 100) / 100 };
  }
  if (str(v, 'kind') === 'REF' && str(v, 'refOwner') === str(e, 'customerCode')) return { amount: 0, error: 'This is your own invite code: share it with friends.' };
  const max = num(v, 'maxUses');
  if (max && (num(v, 'usedCount') ?? 0) >= max) return { amount: 0, error: 'This code has been fully used.' };
  return discountFor(v, str(e, 'kind'), list);
}
async function useVoucher(v: Img, ref: string, amount: number, back = false) {
  const T = process.env.VOUCHER_TABLE;
  if (!T) return;
  let uses: { ref: string; amount: number; at: string; back?: boolean }[] = [];
  try { uses = JSON.parse(str(v, 'uses') || '[]'); } catch { uses = []; }
  uses.push({ ref, amount: back ? -amount : amount, at: new Date().toISOString(), ...(back ? { back: true } : {}) });
  const gift = str(v, 'kind') === 'GIFT';
  await ddb.send(new UpdateItemCommand({ TableName: T, Key: { id: { S: str(v, 'id') } },
    UpdateExpression: `SET usedCount = if_not_exists(usedCount, :z) + :d, uses = :u${gift ? ', balance = if_not_exists(balance, :z) + :b' : ''}`,
    ExpressionAttributeValues: { ':z': { N: '0' }, ':d': { N: back ? '-1' : '1' }, ':u': { S: JSON.stringify(uses.slice(-100)) }, ...(gift ? { ':b': { N: String(back ? amount : -amount) } } : {}) } }));
}
/** A code taken off an order: give back the use (offer) or the amount (gift card). */
async function releaseCode(code: string, ref: string, amount: number) {
  const v = await findVoucher(code);
  if (v) await useVoucher(v, ref, amount, true); else await bumpUses(code, -1);
}

/** Customer: what a code / gift card gives, without using it. */
async function checkCode(ev: ApiEvent) {
  const code = String((ev.arguments as { code?: string }).code ?? '').trim().toUpperCase().slice(0, 30);
  if (!code) throw new Error('Enter the code.');
  const f = await findPromo(code);
  if (f && 'p' in f) { const p = f.p; return { ok: true, code, kind: 'OFFER', text: `${str(p, 'discountType') === 'AED' ? `AED ${num(p, 'discountValue')}` : `${num(p, 'discountValue')}%`} off${num(p, 'minOrder') ? ` orders from AED ${num(p, 'minOrder')}` : ''}` }; }
  const v = await findVoucher(code);
  if (!v) throw new Error(f && 'error' in f ? f.error : 'This code is not valid.');
  const email = String(ev.identity?.claims?.email ?? '').toLowerCase();
  const now = new Date().toISOString();
  if (!v.active?.BOOL) throw new Error('This code is no longer active.');
  if (str(v, 'endAt') && str(v, 'endAt') < now) throw new Error('This code has expired.');
  if (str(v, 'forEmail') && email && str(v, 'forEmail').toLowerCase() !== email) throw new Error('This code was given to someone else: sign in with the email it was sent to.');
  if (str(v, 'kind') === 'GIFT') {
    const bal = num(v, 'balance') ?? 0;
    if (!(bal > 0)) throw new Error('This gift card has been fully used.');
    return { ok: true, code, kind: 'GIFT', balance: bal, text: `Gift card: AED ${bal.toLocaleString('en-US')} to spend${str(v, 'endAt') ? `, until ${new Date(str(v, 'endAt')).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}` };
  }
  const max = num(v, 'maxUses');
  if (max && (num(v, 'usedCount') ?? 0) >= max) throw new Error('This code has been fully used.');
  return { ok: true, code, kind: 'CODE', text: `${str(v, 'discountType') === 'AED' ? `AED ${num(v, 'discountValue')}` : `${num(v, 'discountValue')}%`} off${num(v, 'minOrder') ? ` orders from AED ${num(v, 'minOrder')}` : ''}${str(v, 'endAt') ? `, until ${new Date(str(v, 'endAt')).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}` };
}

async function applyCode(ev: ApiEvent) {
  const table = process.env.ENQUIRY_TABLE;
  if (!table) throw new Error('Not configured');
  const id = String(ev.arguments.id ?? '');
  const code = String((ev.arguments as { code?: string }).code ?? '').trim().toUpperCase().slice(0, 30);
  const got = await ddb.send(new GetItemCommand({ TableName: table, Key: { id: { S: id } } }));
  const e = got.Item as Img | undefined;
  const groups = ev.identity?.groups ?? (ev.identity?.claims?.['cognito:groups'] as string[] | undefined) ?? [];
  if (!e || (!ownsEnquiry(e, ev) && !groups.includes('ADMINS'))) throw new Error('Order not found');
  if (!['RECEIVED', 'PRICE_SENT'].includes(str(e, 'status') || 'RECEIVED') || str(e, 'zohoInvoiceId')) throw new Error('This order is already paid, so a code can no longer be added.');
  if (str(e, 'discountType')) throw new Error('A special discount is already applied to this order, so a code can\'t be added as well.');
  // Studio re-pricing the same code (e.g. delivery abroad added): allowed on a cart order too; the order then gets
  // its own Ziina link for the new amount (the cart's shared link no longer matches its price).
  const studioReprice = groups.includes('ADMINS') && Number((ev.arguments as { price?: number }).price) > 0 && !!code && code === str(e, 'discountCode');
  if (str(e, 'basketRef') && str(e, 'ziinaIntentId') && !studioReprice) throw new Error('This order is paid together with the rest of your cart: codes are added at checkout.');
  const current = str(e, 'discountCode');
  const list = num(e, 'listPrice') ?? num(e, 'quotedPrice') ?? 0;
  if (!(list > 0)) throw new Error('Add the code once we have sent you the price.');
  if (!code) {
    // Remove the code: back to the full price.
    if (!current) return { ok: true, price: list };
    const lp = num(e, 'loyaltyAmount') ?? 0;
    await updateEnquiry(id, { quotedPrice: Math.round((list - lp) * 100) / 100, discountAmount: null, discountCode: null, listPrice: lp ? list : null, referralBy: null });
    await releaseCode(current, str(e, 'ref'), num(e, 'discountAmount') ?? 0);
    return { ok: true, price: list, removed: current };
  }
  // Studio changed the price (e.g. delivery abroad added): the same code is worked out again on the new price.
  const newList = Number((ev.arguments as { price?: number }).price);
  if (code && code === current && newList > 0 && groups.includes('ADMINS')) {
    const prevAmt = num(e, 'discountAmount') ?? 0, loy = num(e, 'loyaltyAmount') ?? 0;
    await releaseCode(current, str(e, 'ref'), prevAmt); // give the use / gift balance back first, then use it again
    const f2 = await findPromo(code);
    const v2 = f2 && 'p' in f2 ? null : await findVoucher(code);
    const d2 = v2 ? voucherAmount(v2, e, newList) : f2 && 'p' in f2 ? discountFor(f2.p as Img, str(e, 'kind'), newList) : { amount: 0, error: f2?.error ?? 'This code is not valid.' };
    if (d2.error) {
      await updateEnquiry(id, { quotedPrice: Math.round((newList - loy) * 100) / 100, discountAmount: null, discountCode: null, listPrice: loy ? newList : null });
      return { ok: true, price: newList, removed: current, why: d2.error };
    }
    const price2 = Math.round((newList - d2.amount - loy) * 100) / 100;
    await updateEnquiry(id, { listPrice: newList, discountAmount: d2.amount, discountCode: code, quotedPrice: price2 });
    if (v2) await useVoucher(v2, str(e, 'ref'), d2.amount); else await bumpUses(code, 1);
    console.log(`Code ${code} re-priced on ${str(e, 'ref')}: AED ${newList} - ${d2.amount} = ${price2}`);
    return { ok: true, code, list: newList, discount: d2.amount, price: price2 };
  }
  if (code === current) throw new Error('This code is already applied.');
  // A public offer code first, else a private code / gift card given by the studio.
  const f = await findPromo(code);
  const v = f && 'p' in f ? null : await findVoucher(code);
  if (!v && (!f || 'error' in f)) throw new Error(f?.error ?? 'This code is not valid.');
  const d = v ? voucherAmount(v, e, list) : discountFor((f as { p: Img }).p, str(e, 'kind'), list);
  if (d.error) throw new Error(d.error);
  // A friend's invite code (Kalai Circle): for a first order only.
  if (v && str(v, 'kind') === 'REF') { const me = await loyCustomer(str(e, 'customerCode')); if (Number(me?.paidCount ?? 0) > 0) throw new Error('Invite codes are for a first order: you can earn your own by inviting friends.'); }
  const price = Math.round((list - d.amount - (num(e, 'loyaltyAmount') ?? 0)) * 100) / 100;
  const prevAmount = num(e, 'discountAmount') ?? 0;
  await updateEnquiry(id, { listPrice: list, discountAmount: d.amount, discountCode: code, quotedPrice: price, referralBy: v && str(v, 'kind') === 'REF' ? str(v, 'refOwner') : null });
  if (v) await useVoucher(v, str(e, 'ref'), d.amount); else await bumpUses(code, 1);
  if (current) await releaseCode(current, str(e, 'ref'), prevAmount);
  console.log(`Code ${code} on ${str(e, 'ref')}: AED ${list} - ${d.amount} = ${price}`);
  return { ok: true, code, list, discount: d.amount, price };
}

// ---------- Thirukkural of the day (flash panel on the website) ----------
// Kural number cycles 1 → 1330 by date. Tamil couplet + short English translation from the open Thirukkural API;
// Arabic by Amazon Translate. Switch off with SSM /kalai/kural/enabled = off. The studio's own message wins on the site.
// Rupees per dirham for prices shown in ₹ on the website: every morning, from the European Central Bank's USD→INR
// rate (Frankfurter, free, no key) and the dirham's fixed peg (3.6725 per dollar). Off when Settings says "keep my rate".
async function refreshInr() {
  const table = process.env.SITE_TABLE;
  if (!table) return;
  const row = await ddb.send(new GetItemCommand({ TableName: table, Key: { id: { S: 'site' } } }));
  if (row.Item && row.Item.inrAuto?.BOOL === false) return;
  const r = await fetch('https://api.frankfurter.app/latest?from=USD&to=INR,GBP,EUR');
  if (!r.ok) throw new Error(`Frankfurter ${r.status}`);
  const rates = ((await r.json()) as { rates?: { INR?: number; GBP?: number; EUR?: number } }).rates ?? {};
  const usdInr = Number(rates.INR), usdGbp = Number(rates.GBP), usdEur = Number(rates.EUR);
  if (!(usdInr > 50 && usdInr < 200)) throw new Error('Odd rate');
  const per = (v: number, dp: number) => Math.round((v / 3.6725) * 10 ** dp) / 10 ** dp;
  const rate = per(usdInr, 2), now = new Date().toISOString();
  const extra = usdGbp > 0.4 && usdGbp < 1.5 && usdEur > 0.5 && usdEur < 1.5; // pounds and euros per dirham too
  await ddb.send(new UpdateItemCommand({ TableName: table, Key: { id: { S: 'site' } },
    UpdateExpression: `SET inrPerAed = :r, inrRateAt = :t, updatedAt = :t, createdAt = if_not_exists(createdAt, :t), #tn = :tn${extra ? ', gbpPerAed = :g, eurPerAed = :e' : ''}`,
    ExpressionAttributeNames: { '#tn': '__typename' }, ExpressionAttributeValues: { ':r': { N: String(rate) }, ':t': { S: now }, ':tn': { S: 'SiteSetting' }, ...(extra ? { ':g': { N: String(per(usdGbp, 4)) }, ':e': { N: String(per(usdEur, 4)) } } : {}) } }));
  console.log(`INR per AED ${rate}${extra ? ` · GBP ${per(usdGbp, 4)} · EUR ${per(usdEur, 4)}` : ''}`);
}

// Amazon Translate codes. Each day's meaning is translated from the plain English meaning, not the poem.
// Every language Amazon Translate offers (besides Tamil, English and Arabic, which are always shown).
const KURAL_MORE = ['af', 'sq', 'am', 'hy', 'az', 'bn', 'bs', 'bg', 'ca', 'zh', 'zh-TW', 'hr', 'cs', 'da', 'fa-AF', 'nl', 'et', 'fa', 'tl', 'fi',
  'fr', 'fr-CA', 'ka', 'de', 'el', 'gu', 'ht', 'ha', 'he', 'hi', 'hu', 'is', 'id', 'ga', 'it', 'ja', 'kn', 'kk', 'ko', 'lv', 'lt', 'mk', 'ms', 'ml',
  'mt', 'mr', 'mn', 'no', 'ps', 'pl', 'pt', 'pt-PT', 'pa', 'ro', 'ru', 'sr', 'si', 'sk', 'sl', 'so', 'es', 'es-MX', 'sw', 'sv', 'te', 'th', 'tr',
  'uk', 'ur', 'uz', 'vi', 'cy'];
async function dailyKural(force: boolean) {
  const table = process.env.ANNOUNCE_TABLE;
  if (!table) throw new Error('Not configured');
  if (!force && (await optionalParam('/kalai/kural/enabled'))?.toLowerCase() === 'off') return { skipped: 'off' };
  const dubai = new Date(Date.now() + 4 * 3600_000);
  const day = dubai.toISOString().slice(0, 10);
  // Only Aram and Porul (kurals 1–1080); Kamattupal (1081–1330, love poetry) is never published.
  const n = (Math.floor(Date.UTC(dubai.getUTCFullYear(), dubai.getUTCMonth(), dubai.getUTCDate()) / 86_400_000) % 1080) + 1;
  const id = `kural-${day}`;
  if (!force) {
    const have = await ddb.send(new GetItemCommand({ TableName: table, Key: { id: { S: id } } }));
    if (have.Item) return { skipped: 'already', id };
  }
  // Kept in the function itself (the free online Thirukkural service the site used has shut down).
  const row = KURALS[n - 1];
  const k: { line1?: string; line2?: string; eng?: string; chap_eng?: string } = { line1: row?.[0], line2: row?.[1], eng: row?.[2] };
  const ta = [k.line1, k.line2].filter(Boolean).join('\n').trim();
  const en = String(k.eng ?? '').trim();
  if (!ta) throw new Error('Thirukkural service returned no text');
  let ar = '';
  try { if (en) ar = (await translator.send(new TranslateTextCommand({ Text: en, SourceLanguageCode: 'en', TargetLanguageCode: 'ar' }))).TranslatedText ?? ''; } catch { ar = ''; }
  // The same meaning in the languages most visitors in the UAE read; the website shows the visitor's own one as a fourth.
  const more: Record<string, string> = {};
  // The heading too ("Thirukkural of the day"), for languages the website has no heading of its own for. 10 at a time.
  const heads: Record<string, string> = {};
  const tr = async (text: string, l: string) => (await translator.send(new TranslateTextCommand({ Text: text, SourceLanguageCode: 'en', TargetLanguageCode: l }))).TranslatedText ?? '';
  if (en) for (let i = 0; i < KURAL_MORE.length; i += 10) await Promise.all(KURAL_MORE.slice(i, i + 10).map(async (l) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const [t, h] = await Promise.all([tr(en, l), tr('Thirukkural of the day', l)]);
        if (t) more[l] = `${t}\n— Thirukkural ${n}`;
        if (h) heads[l] = h;
        return;
      } catch { await new Promise((ok) => setTimeout(ok, 400)); } // busy: once more, else skipped today
    }
  }));
  if (Object.keys(heads).length) more._h = JSON.stringify(heads);
  // Yesterday's kural comes down; the studio's own messages are left alone.
  for (const x of (await scanAll(table)).filter((x) => str(x, 'source') === 'KURAL' && x.active?.BOOL && str(x, 'id') !== id)) {
    await ddb.send(new UpdateItemCommand({ TableName: table, Key: { id: { S: str(x, 'id') } }, UpdateExpression: 'SET active = :f', ExpressionAttributeValues: { ':f': { BOOL: false } } }));
  }
  const from = new Date(`${day}T00:00:00+04:00`).toISOString();
  const until = new Date(new Date(from).getTime() + 86_400_000).toISOString();
  const now = new Date().toISOString();
  await putRow(table, {
    id, __typename: 'Announcement', createdAt: now, updatedAt: now, active: true, showFrom: from, showUntil: until, source: 'KURAL',
    ta: `${ta}\n— திருக்குறள் ${n}`, en: en ? `${en}\n— Thirukkural ${n}` : '', ar: ar ? `${ar}\n— ثيروكورال ${n}` : '', more: JSON.stringify(more),
    ref: `Kural ${n}${k.chap_eng ? ` · ${k.chap_eng}` : ''}`,
  });
  console.log(`Thirukkural ${n} published for ${day}`);
  return { ok: true, id, n };
}

// ---------- Website in other languages ----------
const SITE_LANGS = ['ar', 'af', 'sq', 'am', 'hy', 'az', 'bn', 'bs', 'bg', 'ca', 'zh', 'zh-TW', 'hr', 'cs', 'da', 'fa-AF', 'nl', 'et', 'fa', 'tl', 'fi', 'fr', 'fr-CA', 'ka', 'de', 'el', 'gu', 'ht', 'ha', 'he', 'hi', 'hu', 'is', 'id', 'ga', 'it', 'ja', 'kn', 'kk', 'ko', 'lv', 'lt', 'mk', 'ms', 'ml', 'mt', 'mr', 'mn', 'no', 'ps', 'pl', 'pt', 'pt-PT', 'pa', 'ro', 'ru', 'sr', 'si', 'sk', 'sl', 'so', 'es', 'es-MX', 'sw', 'sv', 'ta', 'te', 'th', 'tr', 'uk', 'ur', 'uz', 'vi', 'cy']; // every Amazon Translate language
const trMemo = new Map<string, string>();
async function siteTranslate(a: { lang?: string; texts?: string }) {
  const lang = String(a.lang ?? '');
  if (!SITE_LANGS.includes(lang)) throw new Error('Language not offered');
  let texts: string[] = [];
  try { texts = JSON.parse(String(a.texts ?? '[]')); } catch { texts = []; }
  texts = (Array.isArray(texts) ? texts : []).slice(0, 80).map((t) => String(t ?? '').slice(0, 600));
  if (texts.reduce((n, t) => n + t.length, 0) > 16000) throw new Error('Too much text at once');
  const T = process.env.TRANSLATION_TABLE;
  const id = (t: string) => `${lang}|${createHash('sha1').update(t).digest('hex')}`;
  const out: string[] = texts.map((t) => trMemo.get(id(t)) ?? '');
  // Saved translations first.
  const want = [...new Set(texts.filter((t, i) => t && !out[i]).map(id))];
  if (T) for (let i = 0; i < want.length; i += 100) {
    const r = await ddb.send(new BatchGetItemCommand({ RequestItems: { [T]: { Keys: want.slice(i, i + 100).map((k) => ({ id: { S: k } })) } } }));
    for (const it of (r.Responses?.[T] ?? []) as Img[]) trMemo.set(str(it, 'id'), it.text?.S ?? '');
  }
  // The rest: Amazon Translate in ONE call (the texts as a small HTML document, tags kept), then kept.
  const todo = texts.map((t, i) => ({ t, i })).filter(({ t, i }) => t && !(out[i] = trMemo.get(id(t)) ?? ''));
  const now = new Date().toISOString();
  const keep = async (t: string, i: number, tr: string) => {
    out[i] = tr; trMemo.set(id(t), tr);
    if (T && tr) await ddb.send(new PutItemCommand({ TableName: T, Item: { id: { S: id(t) }, text: { S: tr }, en: { S: t.slice(0, 600) }, __typename: { S: 'Translation' }, createdAt: { S: now }, updatedAt: { S: now } } })).catch(() => {});
  };
  if (todo.length) {
    const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const unesc = (v: string) => v.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
    try {
      // Prices and codes are kept exactly as they are (translate="no").
      const keepNo = (v: string) => esc(v).replace(/((?:≈\s*)?(?:(?:SAR|QAR|KD|BD|OMR|JD|Dhs|AED|USD|INR|GBP|EUR)\s?[\d.,]+|[$£€₹⃃]\s?[\d.,]+|[\d.,]+\s?(?:Dhs|AED|cm)|AT-\d+|KA-[\w-]+|BP-\d+))/g, '<span translate="no">$1</span>');
      const html = `<html><body>${todo.map(({ t }, k) => `<p id="t${k}">${keepNo(t)}</p>`).join('')}</body></html>`;
      const r = await translator.send(new TranslateDocumentCommand({ Document: { Content: new TextEncoder().encode(html), ContentType: 'text/html' }, SourceLanguageCode: 'en', TargetLanguageCode: lang }));
      const back = new TextDecoder().decode(r.TranslatedDocument?.Content ?? new Uint8Array());
      const got = new Map<number, string>();
      for (const m of back.matchAll(/<p id="t(\d+)"[^>]*>([\s\S]*?)<\/p>/g)) got.set(Number(m[1]), unesc(m[2]));
      await Promise.all(todo.map(({ t, i }, k) => (got.get(k) ? keep(t, i, got.get(k)!) : Promise.resolve())));
    } catch (err) { console.warn('Document translation failed, one by one', err); }
    // Anything the document call missed: one by one (a few at a time).
    const left = todo.filter(({ i }) => !out[i]);
    for (let k = 0; k < left.length; k += 4) {
      await Promise.all(left.slice(k, k + 4).map(async ({ t, i }) => {
        try { await keep(t, i, (await translator.send(new TranslateTextCommand({ Text: t, SourceLanguageCode: 'en', TargetLanguageCode: lang }))).TranslatedText ?? ''); }
        catch (err) { console.warn('Translate failed', err); }
      }));
    }
  }
  texts.forEach((t, i) => { if (!out[i]) out[i] = trMemo.get(id(t)) ?? ''; });
  return out;
}

// ---------- Daily message translation ----------
const translator = new TranslateClient({});
async function translateMessage(a: { text?: string; source?: string | null }) {
  const text = String(a.text ?? '').trim().slice(0, 3000);
  if (!text) throw new Error('Type the message first.');
  const src = ['ta', 'en', 'ar'].includes(String(a.source)) ? String(a.source) : 'ta';
  const out: Record<string, string> = { [src]: text };
  for (const target of ['ta', 'en', 'ar'].filter((l) => l !== src)) {
    const r = await translator.send(new TranslateTextCommand({ Text: text, SourceLanguageCode: src, TargetLanguageCode: target }));
    out[target] = r.TranslatedText ?? '';
  }
  return out;
}

// ---------- Catalogue import from links (ArtStation albums / artworks, or plain image addresses) ----------
// Two steps so each call stays well inside AppSync's 30 s: "expand" turns album links into a list of artworks;
// "import" downloads a few at a time into catalogue/ and creates Draft products.
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', Accept: 'application/json, text/plain, */*' };
type ImportItem = { url: string; title?: string; image?: string };

async function getJson(url: string) {
  const r = await fetch(url, { headers: UA });
  if (r.status === 403 || r.status === 429) throw new Error(`ArtStation blocked the automatic download (${r.status}). Save the images from the page and use “Import photos” instead.`);
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await r.json()) as any;
}

async function expandLinks(links: string[]): Promise<{ items: ImportItem[]; errors: string[] }> {
  const items: ImportItem[] = [];
  const errors: string[] = [];
  for (const link of links) {
    try {
      const u = new URL(link);
      const album = u.pathname.match(/\/albums\/(\d+)/);
      const user = u.hostname.endsWith('.artstation.com') && u.hostname !== 'www.artstation.com' ? u.hostname.split('.')[0] : (u.pathname.match(/^\/([\w-]+)\/albums\//)?.[1] ?? '');
      const art = u.pathname.match(/\/artwork\/([\w-]+)/) || u.pathname.match(/\/projects\/([\w-]+)/);
      if (album && user) {
        for (let page = 1; page <= 20; page++) {
          const j = await getJson(`https://www.artstation.com/users/${user}/projects.json?album_id=${album[1]}&page=${page}`);
          const data = (j.data ?? []) as { hash_id: string; title?: string }[];
          data.forEach((p) => items.push({ url: `https://www.artstation.com/artwork/${p.hash_id}`, title: p.title }));
          if (data.length === 0 || items.length >= (j.total_count ?? Infinity)) break;
        }
      } else if (art) {
        items.push({ url: `https://www.artstation.com/artwork/${art[1]}` });
      } else if (/\.(jpe?g|png|webp)(\?|$)/i.test(u.pathname)) {
        items.push({ url: link, image: link });
      } else {
        errors.push(`Not an ArtStation album, artwork or image link: ${link}`);
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { items, errors };
}

async function importOne(it: ImportItem, existing: Set<string>) {
  const bucket = process.env.UPLOADS_BUCKET, table = process.env.PRODUCT_TABLE;
  if (!bucket || !table) throw new Error('Not configured');
  let title = it.title ?? '', image = it.image ?? '', source = it.image ? `image:${it.image}` : '';
  const hash = it.url.match(/\/artwork\/([\w-]+)/)?.[1];
  if (hash) {
    source = `artstation:${hash}`;
    if (existing.has(source)) return { skipped: true, title };
    const j = await getJson(`https://www.artstation.com/projects/${hash}.json`);
    title = title || j.title || 'Untitled';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const asset = (j.assets ?? []).find((a: any) => a.asset_type === 'image' && a.image_url) ?? (j.assets ?? [])[0];
    image = asset?.image_url ?? j.cover_url ?? '';
  }
  if (existing.has(source)) return { skipped: true, title };
  if (!image) throw new Error(`No picture found for ${title || it.url}`);
  const r = await fetch(image, { headers: { 'User-Agent': UA['User-Agent'] } });
  if (!r.ok) throw new Error(`Picture download failed (${r.status}) for ${title || image}`);
  const type = r.headers.get('content-type') || 'image/jpeg';
  if (!/^image\//.test(type)) throw new Error(`Not a picture: ${image}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 15 * 1024 * 1024) throw new Error(`Picture larger than 15 MB: ${title}`);
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
  const key = `catalogue/${crypto.randomUUID()}.${ext}`;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buf, ContentType: type }));
  if (!title) title = decodeURIComponent(image.split('/').pop() ?? 'Untitled').replace(/\.[a-z0-9]+(\?.*)?$/i, '').replace(/[_-]+/g, ' ');
  const kind = /sketch|pencil|charcoal|graphite|ink|chalk/i.test(title) ? 'sketch' : 'water';
  const now = new Date().toISOString();
  await ddb.send(new PutItemCommand({
    TableName: table,
    Item: {
      id: { S: crypto.randomUUID() }, __typename: { S: 'Product' }, createdAt: { S: now }, updatedAt: { S: now },
      title: { S: title.slice(0, 120) }, kind: { S: kind }, subject: { S: 'land' }, medium: { S: kind === 'sketch' ? 'Graphite on paper' : 'Watercolour on paper' },
      status: { S: 'DRAFT' }, imageKey: { S: key }, source: { S: source.slice(0, 300) },
    },
  }));
  existing.add(source);
  return { skipped: false, title };
}

async function catalogueImport(a: { mode?: string; links?: string }) {
  const lines = String(a.links ?? '').split(/\s+/).map((x) => x.trim()).filter((x) => /^https?:\/\//.test(x)).slice(0, 200);
  if (!lines.length) throw new Error('Paste at least one link.');
  if (a.mode === 'expand') return expandLinks(lines);
  // import: a few per call
  const table = process.env.PRODUCT_TABLE;
  const existing = new Set<string>();
  if (table) (await scanAll(table)).forEach((p) => { const s = str(p, 'source'); if (s) existing.add(s); });
  const done: string[] = [], skipped: string[] = [], errors: string[] = [];
  for (const raw of lines.slice(0, 4)) {
    const [url, title] = raw.split('|');
    try {
      const r = await importOne({ url, title: title ? decodeURIComponent(title) : undefined, image: /\.(jpe?g|png|webp)(\?|$)/i.test(url) ? url : undefined }, existing);
      (r.skipped ? skipped : done).push(r.title || url);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { done, skipped, errors };
}

// ---------- Guest price enquiry (visitor not signed in) ----------
/** Saves a catalogue price enquiry from a visitor without an account. The usual stream then creates the quote and emails. */
async function guestEnquiry(a: ApiEvent['arguments']) {
  const table = process.env.ENQUIRY_TABLE;
  if (!table) throw new Error('Not configured');
  const clip = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
  const ref = clip(a.ref, 30);
  const name = clip(a.customerName, 80);
  const phone = clip(a.phone, 30);
  const email = clip(a.email, 120).toLowerCase();
  if (!/^KA-\d{6}-[A-Z0-9]{3,6}$/.test(ref)) throw new Error('Invalid reference');
  if (!name || phone.replace(/\D/g, '').length < 7) throw new Error('Please add your name and mobile number.');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Please check your email address.');
  let details = clip(a.details, 4000);
  try { JSON.parse(details || '{}'); } catch { details = '{}'; }
  const now = new Date().toISOString();
  const item: Record<string, AttributeValue> = {
    id: { S: crypto.randomUUID() }, __typename: { S: 'Enquiry' }, createdAt: { S: now }, updatedAt: { S: now },
    ref: { S: ref }, kind: { S: 'PRICE' }, title: { S: clip(a.title, 160) || 'Price enquiry' }, details: { S: details || '{}' },
    customerName: { S: name }, phone: { S: phone }, status: { S: 'RECEIVED' },
  };
  if (email) item.email = { S: email };
  await ddb.send(new PutItemCommand({ TableName: table, Item: item, ConditionExpression: 'attribute_not_exists(id)' }));
  console.log(`Guest enquiry ${ref} saved`);
  return { ok: true, ref };
}

// ---------- Delivery address (customer, until it ships) ----------
const EMIRATES = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'];
const IN_STATES = ['Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka',
  'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal'];
/** Checks a delivery address (UAE and India with their own lists; any other country with a typed state/city and an
 *  optional postal code); returns the cleaned fields or throws a message for the customer. */
function checkAddress(a: { name?: unknown; phone?: unknown; country?: unknown; emirate?: unknown; pin?: unknown; address?: unknown; landmark?: unknown }) {
  const clip = (v: unknown, n: number) => String(v ?? '').trim().replace(/\s+\n/g, '\n').slice(0, n);
  const c0 = clip(a.country, 60).replace(/\s+/g, ' ');
  const country = !c0 || c0 === 'UAE' ? 'UAE' : c0;
  if (!/^[\p{L}][\p{L} .'’()&-]{1,59}$/u.test(country)) throw new Error('Choose the country.');
  const name = clip(a.name, 80), phone = clip(a.phone, 30), region = clip(a.emirate, 60), address = clip(a.address, 400), landmark = clip(a.landmark, 120);
  const pin = country === 'India' ? clip(a.pin, 10).replace(/\s/g, '') : clip(a.pin, 12).replace(/\s+/g, ' ').toUpperCase();
  if (!name) throw new Error('Add the name of the person receiving it.');
  if (phone.replace(/\D/g, '').length < 9) throw new Error('Add a mobile number the courier can call.');
  if (country === 'UAE' && !EMIRATES.includes(region)) throw new Error('Choose the emirate.');
  if (country === 'India' && !IN_STATES.includes(region)) throw new Error('Choose the state.');
  if (country === 'India' && !/^[1-9]\d{5}$/.test(pin)) throw new Error('Add the 6-digit PIN code.');
  if (country !== 'UAE' && country !== 'India' && region.length < 2) throw new Error('Add the state, province or city.');
  if (pin && country !== 'India' && !/^[A-Z0-9][A-Z0-9 -]{1,11}$/.test(pin)) throw new Error('Check the postal code.');
  if (address.length < 10) throw new Error('Add the full address: house or flat number, building, street and area.');
  return { name, phone, country, region, pin: country === 'UAE' ? '' : pin, address, landmark };
}
/** "Villa 12, Mirdif, Dubai", "12 MG Road, Chennai, Tamil Nadu 600001, India" or "…, London SW1A 2AA, United Kingdom". */
function addressText(img: Img) {
  const c = str(img, 'deliveryCountry') || 'UAE', away = c !== 'UAE';
  // Parts the typed address already has (state, PIN, country) are not added again (65CF: "…Tamil Nadu, India, Tamil Nadu 629004, India").
  const addr = str(img, 'deliveryAddress'), has = (x: string) => !!x && addr.toLowerCase().includes(x.toLowerCase());
  const region = has(str(img, 'deliveryEmirate')) ? '' : str(img, 'deliveryEmirate'), pin = away && !has(str(img, 'deliveryPin')) ? str(img, 'deliveryPin') : '';
  return [addr, str(img, 'deliveryLandmark') ? `near ${str(img, 'deliveryLandmark')}` : '', [region, pin].filter(Boolean).join(' '), away && !has(c) ? c : ''].filter(Boolean).join(', ');
}
async function customerAddress(ev: ApiEvent) {
  const table = process.env.ENQUIRY_TABLE;
  if (!table) throw new Error('Not configured');
  const a = ev.arguments;
  const id = a.id ?? '';
  const got = await ddb.send(new GetItemCommand({ TableName: table, Key: { id: { S: id } } }));
  const e = got.Item as Img | undefined;
  const groups = ev.identity?.groups ?? (ev.identity?.claims?.['cognito:groups'] as string[] | undefined) ?? [];
  const admin = groups.includes('ADMINS');
  if (!e || (!ownsEnquiry(e, ev) && !admin)) throw new Error('Order not found');
  if (['SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'].includes(str(e, 'status'))) throw new Error('It has already shipped or closed, so the address can no longer be changed here. Please contact us on WhatsApp.');
  const { name, phone, country, region, pin, address, landmark } = checkAddress(a);
  const now = new Date().toISOString();
  const set: Record<string, string> = { deliveryName: name, deliveryPhone: phone, deliveryCountry: country, deliveryEmirate: region, deliveryAddress: address, addressAt: now, addressBy: admin ? 'Kalai Art House' : 'Customer', updatedAt: now };
  if (landmark) set.deliveryLandmark = landmark;
  if (pin) set.deliveryPin = pin;
  const names: Record<string, string> = {};
  const values: Record<string, AttributeValue> = {};
  const parts = Object.entries(set).map(([k, v], i) => { names[`#d${i}`] = k; values[`:d${i}`] = { S: v }; return `#d${i} = :d${i}`; });
  await ddb.send(new UpdateItemCommand({ TableName: table, Key: { id: { S: id } }, UpdateExpression: `SET ${parts.join(', ')}${[landmark ? '' : 'deliveryLandmark', pin ? '' : 'deliveryPin'].filter(Boolean).length ? ` REMOVE ${[landmark ? '' : 'deliveryLandmark', pin ? '' : 'deliveryPin'].filter(Boolean).join(', ')}` : ''}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
  console.log(`Delivery address saved for ${str(e, 'ref')} (${set.addressBy})`);
  // The customer master keeps their latest address.
  const CT = process.env.CUSTOMER_TABLE, cc = str(e, 'customerCode');
  if (CT && cc) {
    try {
      const row = plain(await getRow(CT, { code: { S: cc } })) || {};
      await putRow(CT, { ...row, code: cc, __typename: 'Customer', createdAt: row.createdAt ?? now, updatedAt: now, country, emirate: region, pin: pin || undefined, address, landmark: landmark || undefined, ...(row.editedAt ? { editedAt: now } : {}) });
    } catch (err) { console.warn('Customer address not updated', err); }
  }
  return { ok: true, ...set };
}

// ---------- Customer requests (My enquiries & orders): cancel, or report damage on delivery ----------
// Policy (Terms clause 9): before payment → cancelled at once, nothing to pay. After payment and before
// the work starts → full refund; once the artist (or, for Little Artists, the framer) has started → 50%.
// Shipped → can't be cancelled. Delivered → damage reported with photos within 48 hours: refund or replacement.
const DAMAGE_WINDOW_MS = 48 * 3600_000;
type Terms = { allowed: boolean; type: 'FREE' | 'FULL' | 'HALF' | 'DAMAGE' | 'NONE'; pct: number; due: number; note: string };

function cancelTerms(e: Img, action: string, now = Date.now()): Terms {
  const status = str(e, 'status') || 'RECEIVED';
  const price = num(e, 'quotedPrice') ?? 0;
  const t = (type: Terms['type'], pct: number, note: string, allowed = true): Terms => ({ allowed, type, pct, due: Math.round(price * pct * 100) / 100, note });
  if (str(e, 'cancelState') === 'REQUESTED') return t('NONE', 0, 'A request is already open for this order. We will reply by email.', false);
  if (action === 'CANCEL') {
    if (['RECEIVED', 'PRICE_SENT'].includes(status)) return t('FREE', 0, 'Nothing has been paid, so the enquiry is simply cancelled.');
    if (str(e, 'kind') === 'LICENCE') return t('NONE', 0, 'Image licences are digital: once paid, the file is yours to download and the licence can\'t be cancelled.', false);
    if ([...PAID_LIKE, 'FRAMING'].includes(status)) {
      // Crafts shop: a full refund until it is dispatched (then it is Shipped and can't be cancelled).
      const started = str(e, 'kind') === 'MARKET' ? false : ['GIFT', 'PHOTO'].includes(str(e, 'kind')) ? ['PRINTING', 'PRINTED', 'FRAMING'].includes(status) : !!str(e, 'artistStartedAt') || status === 'FRAMING';
      return started
        ? t('HALF', 0.5, ['GIFT', 'PHOTO'].includes(str(e, 'kind')) ? 'Framing has started, so 50% is refunded.' : 'The artist has started your work, so 50% is refunded to cover the artist\'s time.')
        : t('FULL', 1, 'The work has not started yet, so the full amount is refunded.');
    }
    if (status === 'SHIPPED') return t('NONE', 0, 'It has already shipped, so it can no longer be cancelled. If it arrives damaged, report it here within 48 hours of delivery.', false);
    return t('NONE', 0, 'This order can no longer be cancelled.', false);
  }
  if (action === 'DAMAGED_REFUND' || action === 'DAMAGED_REPLACE') {
    if (status !== 'DELIVERED') return t('NONE', 0, 'Damage can be reported once the order is delivered.', false);
    const at = Date.parse(str(e, 'deliveredAt') || str(e, 'updatedAt'));
    // The studio asked for new photos: 48 hours from that request instead of from delivery.
    const reopen = str(e, 'cancelState') === 'REOPENED' ? Date.parse(str(e, 'cancelReopenAt')) : NaN;
    if (Number.isFinite(reopen) ? now - reopen > DAMAGE_WINDOW_MS : Number.isFinite(at) && now - at > DAMAGE_WINDOW_MS) return t('NONE', 0, Number.isFinite(reopen) ? 'The 48 hours to send new photos have passed. Please contact us.' : 'Damage must be reported within 48 hours of delivery. Please contact us.', false);
    return action === 'DAMAGED_REFUND' ? t('DAMAGE', 1, 'Damaged in transit: full refund once we have checked the photos.') : t('DAMAGE', 0, 'Damaged in transit: we replace or repair it at no cost.');
  }
  return t('NONE', 0, 'Unknown request.', false);
}

function ownsEnquiry(e: Img, ev: ApiEvent) {
  const owner = str(e, 'owner');
  const sub = ev.identity?.sub ?? String(ev.identity?.claims?.sub ?? '');
  const user = ev.identity?.username ?? '';
  if (!owner) return false;
  return [sub, user].filter(Boolean).some((x) => owner === x || owner.startsWith(`${x}::`) || owner.endsWith(`::${x}`));
}

async function customerRequest(ev: ApiEvent) {
  const table = process.env.ENQUIRY_TABLE;
  if (!table) throw new Error('Not configured');
  const a = ev.arguments;
  const id = a.id ?? '';
  const action = String(a.action ?? '').toUpperCase();
  const got = await ddb.send(new GetItemCommand({ TableName: table, Key: { id: { S: id } } }));
  const e = got.Item as Img | undefined;
  // The customer who placed it, or the studio acting for them (an admin signed in on the website sees every order).
  const groups = ev.identity?.groups ?? (ev.identity?.claims?.['cognito:groups'] as string[] | undefined) ?? [];
  if (!e) throw new Error('Order not found');
  if (!ownsEnquiry(e, ev) && !groups.includes('ADMINS')) {
    console.warn(`customerRequest refused for ${str(e, 'ref')}: owner ${str(e, 'owner')} vs caller ${ev.identity?.sub ?? ev.identity?.username ?? '?'}`);
    throw new Error('Order not found');
  }
  // Invoice / delivery note PDF for the customer (My enquiries & orders).
  if (action === 'INVOICE_PDF') {
    if (!str(e, 'zohoInvoiceId')) throw new Error('No invoice yet: it is made when you pay.');
    return zohoPdf(`/invoices/${str(e, 'zohoInvoiceId')}`, str(e, 'zohoInvoice') || `invoice-${str(e, 'ref')}`);
  }
  if (action === 'CHALLAN_PDF') {
    if (!str(e, 'zohoChallanId')) throw new Error('No delivery note yet.');
    return zohoPdf(`/deliverychallans/${str(e, 'zohoChallanId')}`, str(e, 'zohoChallan') || `delivery-${str(e, 'ref')}`);
  }
  // Image licence: a short-lived download link to the full-size file, once paid.
  if (action === 'LICENCE_FILE') return licenceFile(e);
  // Certificate of authenticity for an original (the website draws the PDF).
  if (action === 'COA') return certificateOf(e, true);
  // The customer takes back an open request (e.g. sent the wrong photo): they can then report again while the window is open.
  if (action === 'WITHDRAW') {
    if (str(e, 'cancelState') !== 'REQUESTED') throw new Error('There is no open request to withdraw.');
    const wnow = new Date().toISOString();
    await ddb.send(new UpdateItemCommand({
      TableName: table, Key: { id: { S: id } },
      UpdateExpression: 'SET cancelState = :w, updatedAt = :n REMOVE cancelRefundDue',
      ExpressionAttributeValues: { ':w': { S: 'WITHDRAWN' }, ':n': { S: wnow } },
      ConditionExpression: 'attribute_exists(id)',
    }));
    console.log(`Customer withdrew request ${str(e, 'cancelRequest')} for ${str(e, 'ref')}`);
    return { ok: true, state: 'WITHDRAWN' };
  }
  const terms = cancelTerms(e, action);
  if (!terms.allowed) throw new Error(terms.note);
  const reason = String(a.reason ?? '').trim().slice(0, 1000);
  const photos = String(a.photos ?? '').split('\n').map((x) => x.trim()).filter((x) => x.startsWith('uploads/')).slice(0, 3);
  if (terms.type === 'DAMAGE' && !photos.length) throw new Error('Add at least one photo of the damage.');
  if (terms.type === 'DAMAGE' && reason.length < 5) throw new Error('Describe the damage in a few words.');
  const now = new Date().toISOString();
  const set: Record<string, AttributeValue> = {
    cancelRequest: { S: action },
    cancelRequestedAt: { S: now },
    cancelState: { S: terms.type === 'FREE' ? 'DONE' : 'REQUESTED' },
    updatedAt: { S: now },
  };
  if (reason) set.cancelReason = { S: reason };
  if (photos.length) set.cancelPhotos = { S: photos.join('\n') };
  if (terms.type !== 'FREE') set.cancelRefundDue = { N: String(terms.due) };
  if (terms.type === 'FREE') set.status = { S: 'CANCELLED' }; // the stream then declines the Zoho quote
  const names: Record<string, string> = {};
  const values: Record<string, AttributeValue> = {};
  const parts = Object.entries(set).map(([k, v], i) => { names[`#c${i}`] = k; values[`:c${i}`] = v; return `#c${i} = :c${i}`; });
  await ddb.send(new UpdateItemCommand({
    TableName: table, Key: { id: { S: id } },
    UpdateExpression: `SET ${parts.join(', ')} REMOVE cancelReply`,
    ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    ConditionExpression: 'attribute_exists(id)',
  }));
  console.log(`Customer request ${action} (${terms.type}) for ${str(e, 'ref')}`);
  return { ok: true, type: terms.type, due: terms.due, note: terms.note, state: terms.type === 'FREE' ? 'DONE' : 'REQUESTED', status: terms.type === 'FREE' ? 'CANCELLED' : str(e, 'status'), at: now };
}

// ---------- Emails (Amazon SES) to the customer and the studio ----------
const SITE = 'https://art.pranixtechno.com';
const STUDIO_EMAIL = 'kalaiarthouse@pranixtechno.com';
const FROM = 'Kalai Art House <noreply@pranixtechno.com>';
const EMAIL_PARAM = '/kalai/email/enabled';
const sesClient = new SESv2Client({});
let cachedEmailOn: { on: boolean; at: number } | null = null;
async function emailsOn() {
  if (cachedEmailOn && Date.now() - cachedEmailOn.at < 60_000) return cachedEmailOn.on;
  let on = true;
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: EMAIL_PARAM }));
    on = (r.Parameter?.Value ?? '').trim().toLowerCase() !== 'off';
  } catch { on = true; }
  cachedEmailOn = { on, at: Date.now() };
  return on;
}
const h = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const aed = (n: number | null) => (n == null ? '' : `AED ${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`);
type Mail = { to: string; subject: string; lines: string[]; button?: { label: string; url: string }; footer?: string; key?: string };

function renderMail(m: Mail) {
  const para = (l: string) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#232046">${l}</p>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f7f3ea;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
  <table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:8px;border:1px solid #e6dcc6" cellspacing="0" cellpadding="0">
  <tr><td style="background:#232046;color:#f6f1e4;padding:18px 24px;font-family:Georgia,serif;font-size:20px;letter-spacing:2px;border-radius:8px 8px 0 0">KALAI <span style="color:#d9ad55">ART HOUSE</span></td></tr>
  <tr><td style="padding:24px">${m.lines.map(para).join('')}
  ${m.button ? `<p style="margin:20px 0"><a href="${h(m.button.url)}" style="background:#a3242f;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:bold;display:inline-block">${h(m.button.label)}</a></p>` : ''}
  <p style="margin:18px 0 0;font-size:13px;color:#6b6780">${m.footer ?? `Questions? Just reply to this email or message us on WhatsApp.<br>Kalai Art House · Pranix Technologies FZCO · Dubai · <a href="${SITE}/#terms" style="color:#6b6780">Terms</a>`}</p>
  </td></tr></table></td></tr></table></body></html>`;
  const text = [...m.lines.map((l) => l.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')), m.button ? `${m.button.label}: ${m.button.url}` : '', '', 'Kalai Art House · art.pranixtechno.com'].join('\n\n');
  return { html, text };
}

async function sendMail(m: Mail) {
  if (!m.to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m.to)) return;
  if (TEST_SITE && !m.subject.startsWith('[TEST]')) m = { ...m, subject: `[TEST] ${m.subject}` };
  const { html, text } = renderMail(m);
  await sesClient.send(new SendEmailCommand({
    FromEmailAddress: FROM,
    Destination: { ToAddresses: [m.to] },
    ReplyToAddresses: [STUDIO_EMAIL],
    Content: { Simple: { Subject: { Data: m.subject, Charset: 'UTF-8' }, Body: { Html: { Data: html, Charset: 'UTF-8' }, Text: { Data: text, Charset: 'UTF-8' } } } },
  }));
  console.log(`Email sent: "${m.subject}"`);
}

const MY = { label: 'Open My enquiries & orders', url: `${SITE}/#my-enquiries` };
const DESK = (id: string) => ({ label: 'Open in Order Management', url: `${SITE}/admin.html#order=${id}` });

/** Which emails a change to an enquiry should send (customer + studio). Pure: easy to test. */
function mailsFor(rec: StreamRecord): Mail[] {
  const img = rec.dynamodb?.NewImage;
  const old = rec.dynamodb?.OldImage;
  if (!img) return [];
  const to = str(img, 'email');
  const name = (str(img, 'customerName') || 'there').split(/\s+/)[0];
  const ref = str(img, 'ref');
  const title = str(img, 'title');
  const kind = str(img, 'kind');
  const id = str(img, 'id');
  const price = num(img, 'quotedPrice');
  const msg = str(img, 'adminMessage');
  // Only a new message goes into a status email (a message written for an earlier step, e.g. "pay with the link", is not repeated).
  const msgLine = msg && (rec.eventName !== 'MODIFY' || msg !== str(rec.dynamodb?.OldImage, 'adminMessage')) ? `<b>Message from us:</b> ${h(msg)}` : '';
  const hi = `Hello ${h(name)},`;
  const out: Mail[] = [];
  // key: which customer email this is (each can be switched off in Order Management → Settings → Customer emails).
  let key = '';
  const cust = (subject: string, lines: string[], button = MY) => out.push({ to, subject, lines: [hi, ...lines.filter(Boolean)], button, key });
  const studio = (subject: string, lines: string[]) => out.push({ to: STUDIO_EMAIL, subject, lines: lines.filter(Boolean), button: DESK(id), footer: 'Studio notification from art.pranixtechno.com' });

  if (rec.eventName === 'INSERT') {
    key = 'RECEIVED';
    const det0 = parseDetails(detStr(img));
    const isOrder = ['MARKET', 'LICENCE', 'PHOTO', 'GIFT'].includes(kind) || /^Artwork order/i.test(str(img, 'title')) || /website price/i.test(String(det0['Price'] ?? ''));
    cust(isOrder ? `We've received your order ${ref}` : `We've received your enquiry ${ref}`, [
      kind === 'MARKET' ? `Thank you for your order: <b>${h(title)}</b>${num(img, 'qty') && num(img, 'qty')! > 1 ? ` × ${num(img, 'qty')}` : ''}, total <b>${aed(price)}</b> including delivery in the UAE. We'll send you a secure payment link shortly; your order is confirmed once it is paid.`
        : kind === 'LICENCE' ? `Thank you for your licence order: <b>${h(title)}</b>, <b>${aed(price)}</b>. The secure payment link follows in a moment; once paid you can download the full-size file under My enquiries & orders.`
        : kind === 'PHOTO' ? `Thank you for your order. We'll send you a secure payment link and ask for your delivery address; once paid we print, frame and deliver it.`
        : kind === 'GIFT' ? `Thank you for sending us your child's drawing. We'll frame it with care and confirm the delivery charge and date shortly.`
        : kind === 'COMMISSION' ? `Thank you for your commission request: <b>${h(title)}</b>. We'll come back with the price, size options and delivery date, usually within 24 hours.`
        : det0['Offer'] ? `Thank you for your offer of <b>${h(String(det0['Offer']))}</b> for <b>${h(title)}</b>. We'll check it with the artist and reply, usually within 24 hours.`
        : det0['Price'] ? `Thank you for your order: <b>${h(title)}</b>, ${h(String(det0['Price']).replace(/\s*\(website price\)/i, ''))}. We'll confirm it's ready and send you a secure payment link, usually within 24 hours.`
        : `Thank you for your interest in <b>${h(title)}</b>. We'll reply with the price, framing options and delivery date, usually within 24 hours.`,
      `Your reference is <b>${h(ref)}</b>. You can follow every step under My enquiries & orders on our website.`]);
    studio(`New ${KIND[kind] ? `${KIND[kind]} order` : 'enquiry'}: ${title} (${ref})`, [`<b>${h(title)}</b>`, `${h(str(img, 'customerName'))} · ${h(str(img, 'phone'))} · ${h(to)}`, `Reference ${h(ref)}`,
      kind === 'MARKET' ? `Maker: ${h(str(img, 'sellerName'))} · qty ${num(img, 'qty') ?? 1} · <b>${aed(price)}</b> · ${str(img, 'deliveryBy') === 'KALAI' ? 'Kalai collects and delivers' : 'maker delivers'}${str(img, 'deliveryCountry') === 'India' ? ' · <b>delivery to India: add the shipping to the price</b>' : ''}. Send the payment link (status Price sent); once Paid the maker is told automatically.` : '']);
    return out;
  }
  if (rec.eventName !== 'MODIFY' || !old) return out;
  const own = str(img, 'zohoAt') !== str(old, 'zohoAt');

  // Results our function wrote (refund recorded).
  const rs = str(img, 'refundState'), ors = str(old, 'refundState');
  if (rs !== ors && ['DONE', 'TEST'].includes(rs) && str(img, 'refundAction') !== 'DAMAGED_REPLACE') {
    key = 'REFUND';
    const amt = num(img, 'refundAmount');
    cust(`Refund of ${aed(amt)} for ${ref}`, [`We've refunded <b>${aed(amt)}</b> for <b>${h(title)}</b>${str(img, 'refundRef') ? ` (reference ${h(str(img, 'refundRef'))})` : ''}.`,
      'Depending on your bank it usually shows in your account within 7 working days.', 'We are sorry this one did not work out, and we hope to paint for you again.']);
  }
  if (own) return out;

  const st = str(img, 'status') || 'RECEIVED';
  const ost = str(old, 'status') || 'RECEIVED';
  // A stale page moving a Ziina-paid order back (the server puts it back): no customer email for it.
  const staleBack = !!str(old, 'ziinaPaidAt') && BEFORE_PAYMENT.includes(st) && !BEFORE_PAYMENT.includes(ost);
  const statusChanged = st !== ost && !staleBack;
  if (statusChanged) {
    key = st;
    if (st === 'PRICE_SENT' && kind === 'LICENCE') cust(`Pay for your licence: ${title} (${ref})`, [
      `Your <b>${h(title.replace(/^Image licence:\s*/i, ''))}</b> costs <b>${aed(price)}</b>.`,
      str(img, 'paymentLink') ? 'Pay securely with the button below. As soon as it is paid, the full-size file is ready to download under My enquiries & orders.' : 'We will send the payment link shortly.',
      `What the licence allows: ${h(String(parseDetails(detStr(img))['Allows'] ?? ''))} The artist keeps the copyright; please credit "Artwork © the artist / Kalai Art House".`,
      `By paying you agree to our <a href="${SITE}/#terms">terms</a>. Licences are digital and can't be cancelled once paid.`],
      str(img, 'paymentLink') ? { label: `Pay ${aed(price)} securely`, url: str(img, 'paymentLink') } : MY);
    else if (st === 'PRICE_SENT') cust(`Your price for ${title} (${ref})`, [
      price ? `The price for <b>${h(title)}</b> is <b>${aed(price)}</b>${num(img, 'discountAmount') && num(img, 'listPrice') ? ` (${aed(num(img, 'listPrice'))} less your discount of ${aed(num(img, 'discountAmount'))})` : ''}, including ${kind === 'MARKET' || kind === 'LICENCE' ? '' : 'framing, '}${(str(img, 'deliveryCountry') || 'UAE') === 'UAE' ? 'delivery in the UAE' : `shipping to ${h(str(img, 'deliveryCountry'))}`} and VAT where it applies.` : `We've replied about <b>${h(title)}</b>.`,
      msgLine, str(img, 'paymentLink') ? 'You can pay securely with the button below. The price is held for 7 days.' : 'The price is held for 7 days. Reply to this email or message us on WhatsApp to go ahead.',
      str(img, 'deliveryAddress') ? '' : 'Please also add your <b>delivery address</b> under My enquiries & orders, so we can ship it as soon as it is ready.',
      `By paying you agree to our <a href="${SITE}/#terms">terms</a>, including the cancellation policy.`],
      str(img, 'paymentLink') ? { label: `Pay ${aed(price)} securely`, url: str(img, 'paymentLink') } : MY);
    if (st === 'PAID' && kind === 'LICENCE') cust(`Your licensed file is ready (${ref})`, [`We've received your payment${price ? ` of <b>${aed(price)}</b>` : ''} for <b>${h(title)}</b>.`,
      'Download the full-size file under <b>My enquiries & orders</b> (button below): sign in with this email address. You can download it again any time.',
      str(img, 'zohoInvoice') ? `Invoice ${h(str(img, 'zohoInvoice'))} follows separately.` : '', 'Thank you for supporting the artist.']);
    else if (st === 'PAID' && str(img, 'basketRef')) cust(`Payment received: thank you (${str(img, 'basketRef')})`, [`We've received your payment for your order <b>${h(str(img, 'basketRef'))}</b>. All its items are confirmed.`,
      'Each item is prepared on its own (paintings by the artist, prints and frames in Dubai), so they may arrive separately. You can follow each one under My enquiries & orders, and we email the tracking number as each ships.']);
    else if (st === 'PAID') cust(`Payment received: thank you (${ref})`, [`We've received your payment${price ? ` of <b>${aed(price)}</b>` : ''} for <b>${h(title)}</b>. Your order is confirmed.`,
      str(img, 'zohoInvoice') ? `Invoice ${h(str(img, 'zohoInvoice'))} follows separately.` : '', msgLine,
      str(img, 'deliveryAddress') ? `It will be delivered to: ${h(addressText(img))}. You can change this under My enquiries & orders until it ships.` : '<b>Please add your delivery address</b> under My enquiries & orders.',
      "You can follow every step under My enquiries & orders, and we'll email you the tracking number when it ships.",
      ['PRICE', 'COMMISSION'].includes(kind) ? 'Changed your mind? You can request a cancellation under My enquiries & orders: before the artist starts you get a full refund.' : '']);
    if (st === 'ARTIST_DONE' && ['PRICE', 'COMMISSION'].includes(kind)) cust(`Finished: ${title} (${ref})`, [`The artist has finished <b>${h(title)}</b>. Next it goes to our framer in Dubai.`, msgLine]);
    if (st === 'ARTIST_SENT' && ['PRICE', 'COMMISSION'].includes(kind)) cust(`On its way to our framer: ${title} (${ref})`, [`<b>${h(title)}</b> has left the artist's studio and is on its way to our framer in Dubai.`, msgLine, "We'll let you know when it is framed and ships."]);
    if (st === 'FRAMING') cust(kind === 'PHOTO' ? `We're printing and framing your order (${ref})` : kind === 'GIFT' ? `We're framing your child's drawing (${ref})` : `Being framed: ${title} (${ref})`, [
      kind === 'PHOTO' ? 'Your print is now with our framer in Dubai: printed on fine-art paper, then mounted and framed.' : kind === 'GIFT' ? `Your child's drawing for <b>${h(title.replace(/^Little Artists gift for\s*/i, '') || 'your gift')}</b> is now with our framer in Dubai.` : `<b>${h(title)}</b> is now with our framer in Dubai for framing.`,
      msgLine, "We'll email you the courier and tracking number as soon as it ships."]);
    if (st === 'SHIPPED') cust(`On its way: ${title} (${ref})`, [`<b>${h(title)}</b> has shipped${str(img, 'courierName') ? ` with <b>${h(str(img, 'courierName'))}</b>` : ''}${str(img, 'trackingNo') ? `, tracking number <b>${h(str(img, 'trackingNo'))}</b>` : ''}.`, msgLine, 'Please check the parcel when it arrives. If anything is damaged, report it with photos under My enquiries & orders within 48 hours.']);
    if (st === 'DELIVERED' && kind === 'LICENCE') cust(`Your licensed file: ${title} (${ref})`, [`Your licence for <b>${h(title.replace(/^Image licence:\s*/i, ''))}</b> is active. Download the full-size file under <b>My enquiries & orders</b> (sign in with this email address); you can download it again any time.`, msgLine], MY);
    else if (st === 'DELIVERED') cust(`Delivered: ${title}`, [`<b>${h(title)}</b> has been delivered. We hope you love it.`, msgLine,
      'If anything arrived damaged, report it with photos under My enquiries & orders within 48 hours and choose a replacement or a refund.',
      'We would be grateful for your feedback: you can rate your order under My enquiries & orders.'], { label: 'Rate your order', url: `${SITE}/#my-enquiries` });
    if (st === 'REPLACEMENT') cust(`Your replacement is under way (${ref})`, [`We've started the replacement for <b>${h(title)}</b>.`, msgLine,
      'You can follow each step (collection, the new work, framing and delivery) under My enquiries & orders. There is nothing to pay.']);
    if (st === 'REFUNDED' && rs === ors) cust(`Order closed: ${ref}`, [`Your order for <b>${h(title)}</b> is closed as refunded${num(img, 'refundAmount') ? ` (<b>${aed(num(img, 'refundAmount'))}</b>)` : ''}.`, msgLine,
      'If the refund has not reached your account within 7 working days, just reply to this email.']);
    if (st === 'RECEIVED' && ost !== 'RECEIVED') (key = 'RECEIVED_AGAIN'), cust(`Your enquiry ${ref} is open again`, [`We've reopened your enquiry for <b>${h(title)}</b>.`, msgLine, "We'll be in touch shortly."]);
    if (st === 'CANCELLED') {
      const self = str(img, 'cancelRequest') === 'CANCEL';
      cust(`Cancelled: ${ref}`, [self ? `As you asked, your enquiry for <b>${h(title)}</b> is cancelled. Nothing was paid, so there is nothing more to do.` : `Your enquiry for <b>${h(title)}</b> is now closed.`, msgLine, 'You are welcome back any time.']);
      if (self) studio(`Customer cancelled ${ref} (not paid)`, [`${h(str(img, 'customerName'))} cancelled <b>${h(title)}</b> before paying.`, str(img, 'cancelReason') ? `Reason: ${h(str(img, 'cancelReason'))}` : '', 'The Zoho quote is marked declined automatically.']);
    }
  }

  // The artist has started the work (the 50% cancellation terms apply from now).
  if (str(img, 'artistStartedAt') && !str(old, 'artistStartedAt') && kind !== 'MARKET' && kind !== 'GIFT' && kind !== 'PHOTO') {
    key = 'ARTIST_STARTED';
    cust(`The artist has started: ${title} (${ref})`, [`Good news: the artist has started work on <b>${h(title)}</b>.`,
      kind === 'COMMISSION' ? "We'll keep you posted as it progresses." : "We'll let you know when it moves to the framer.",
      'From now, a cancellation is refunded at 50% under our terms.']);
  }

  // A customer request (cancel / damage) or the studio's answer to it.
  const cs = str(img, 'cancelState'), ocs = str(old, 'cancelState');
  if (cs !== ocs && cs === 'REQUESTED') {
    key = 'REQUEST';
    const req = str(img, 'cancelRequest');
    const due = num(img, 'cancelRefundDue');
    const damage = req.startsWith('DAMAGED');
    cust(damage ? `We've received your damage report (${ref})` : `We've received your cancellation request (${ref})`, [
      damage ? `Thank you for the photos. We're sorry <b>${h(title)}</b> arrived damaged.` : `We've received your request to cancel <b>${h(title)}</b>.`,
      req === 'DAMAGED_REPLACE' ? 'You asked for a replacement or repair at no cost. We will confirm the plan within 2 working days.'
        : `Under our terms the refund is <b>${aed(due)}</b>. We will send it within 7 working days and email you when it is done.`]);
    studio(`${damage ? 'Damage reported' : 'Cancellation request'}: ${ref}`, [
      `${h(str(img, 'customerName'))} · ${h(to)} · ${h(str(img, 'phone'))}`, `<b>${h(title)}</b> · status ${h(st)}`,
      `Request: <b>${h(req === 'CANCEL' ? 'Cancel' : req === 'DAMAGED_REFUND' ? 'Damaged: refund' : 'Damaged: replacement')}</b>${req !== 'DAMAGED_REPLACE' ? ` · refund due under the policy: <b>${aed(due)}</b>` : ''}`,
      str(img, 'cancelReason') ? `Reason: ${h(str(img, 'cancelReason'))}` : '', damage ? 'Photos are attached to the order.' : '',
      req === 'CANCEL' && str(img, 'zohoPOId') ? "Siva's order is on hold until you decide." : '',
      'Pay the refund, then confirm it in the order (the box is filled in for you).']);
  }
  if (cs !== ocs && cs === 'REOPENED') {
    key = 'DECLINED';
    cust(`Please send new photos for ${ref}`, [`We've looked at the damage report for <b>${h(title)}</b>.`, str(img, 'cancelReply') ? h(str(img, 'cancelReply')) : 'The photos did not show the damage clearly.',
      'Please send new photos under <b>My enquiries & orders</b> → this order → <b>Send new damage photos</b>, within 48 hours. Show the whole frame and a close-up of the damage, and the outer box if it was damaged.']);
  }
  if (cs !== ocs && cs === 'WITHDRAWN') {
    studio(`Request withdrawn: ${title} (${ref})`, [`The customer withdrew their request (${h(str(img, 'cancelRequest'))}) for <b>${h(title)}</b>.`, 'If they report again, it comes in as a new request.']);
  }
  if (cs !== ocs && cs === 'DECLINED') {
    key = 'DECLINED';
    cust(`About your request for ${ref}`, [`We've looked at your request for <b>${h(title)}</b>.`, str(img, 'cancelReply') ? h(str(img, 'cancelReply')) : 'We are unable to accept it under our terms. Please reply to this email if you would like to talk it through.']);
  }

  // Return pickup for a replacement.
  if (str(img, 'returnAwb') && str(img, 'returnAwb') !== str(old, 'returnAwb') && str(img, 'returnMode') === 'PICKUP') {
    key = 'PICKUP';
    const d = str(img, 'returnPickupDate');
    cust(`Pickup booked for ${title} (${ref})`, [`We've booked a courier to collect the damaged <b>${h(title)}</b>${d ? ` on <b>${h(new Date(d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }))}</b>` : ''}.`,
      `Courier: <b>${h(str(img, 'returnCourier'))}</b> · return AWB <b>${h(str(img, 'returnAwb'))}</b>. The driver brings the label; please pack it in the original packaging if you still have it.`,
      "We'll email you when it reaches our framing studio."]);
  }
  // Received at the frame shop: shown on the customer's replacement tracker, no email.

  // Delivery address added or changed by the customer.
  if (str(img, 'addressAt') && str(img, 'addressAt') !== str(old, 'addressAt') && str(img, 'addressBy') === 'Customer') {
    studio(`Delivery address ${str(old, 'addressAt') ? 'changed' : 'added'}: ${ref}`, [`${h(str(img, 'deliveryName'))} · ${h(str(img, 'deliveryPhone'))}`,
      `${h(addressText(img))}`, `<b>${h(title)}</b> · status ${h(st)}`]);
  }

  // A new message on the order without a status change.
  if (!statusChanged && msg && msg !== str(old, 'adminMessage')) (key = 'MESSAGE'), cust(`A message about your order ${ref}`, [`About <b>${h(title)}</b>:`, h(msg)]);
  return out;
}

// A message asking the customer to pay is out of date once the order is paid.
const PAY_MSG = /pay (with|securely|now|using)|link below|payment link|to confirm your order/i;
const PAIDISH = ['PAID', 'ARTIST_WORKING', 'ARTIST_DONE', 'ARTIST_SENT', 'PRINTING', 'PRINTED', 'FRAMING', 'SHIPPED', 'DELIVERED', 'REPLACEMENT'];
/** When the status moves on (by anyone: studio, artist, supplier, payment) and the message didn't change with it, the
 *  message belonged to the earlier step: clear it so the customer page, emails and WhatsApp don't repeat it. */
async function clearStaleMessage(rec: StreamRecord) {
  const img = rec.dynamodb?.NewImage, old = rec.dynamodb?.OldImage;
  if (rec.eventName !== 'MODIFY' || !img || !old) return;
  const msg = str(img, 'adminMessage');
  if (!msg || msg !== str(old, 'adminMessage') || str(img, 'status') === str(old, 'status')) return;
  await writeBack(str(img, 'id'), { adminMessage: null });
}

/** The customer's tracker: every status change (by the studio, the artist's steps, suppliers, payments) with its time. */
async function logStatus(rec: StreamRecord) {
  const img = rec.dynamodb?.NewImage, old = rec.dynamodb?.OldImage;
  if (!img) return;
  const st = str(img, 'status') || 'RECEIVED';
  if (rec.eventName === 'MODIFY' && st === (str(old, 'status') || 'RECEIVED')) return;
  let log: { s: string; at: string }[] = [];
  try { log = JSON.parse(str(img, 'statusLog') || '[]'); if (!Array.isArray(log)) log = []; } catch { log = []; }
  const at = rec.eventName === 'INSERT' ? (str(img, 'createdAt') || new Date().toISOString()) : new Date().toISOString();
  if (log.length && log[log.length - 1].s === st) return;
  log.push({ s: st, at });
  await writeBack(str(img, 'id'), { statusLog: JSON.stringify(log.slice(-40)) });
}

// ---------- Emails to the artist doing the order (Siva or a portal artist) ----------
let sivaCache: { at: number; p: Dict | null } | null = null;
async function artistContactOf(e: Img): Promise<Dict | null> {
  const { S } = mtables();
  if (str(e, 'artistId')) return plain(await getRow(S, { id: { S: str(e, 'artistId') } }));
  if (sivaCache && Date.now() - sivaCache.at < 300_000) return sivaCache.p;
  const all = (await scanAll(S)).map(plain).filter((x): x is Dict => !!x);
  const p = all.find((x) => x.type === 'ARTIST' && /s+h?iva/i.test(String(x.business ?? '') + ' ' + String(x.contactName ?? '')) && x.status === 'APPROVED' && x.email) ?? null;
  sivaCache = { at: Date.now(), p };
  return p;
}
function paperLine(e: Img) {
  const d = parseDetails(detStr(e));
  const raw = String(d['Size'] ?? '') || (String(d['Artwork'] ?? '').match(/\d{2,3}(?:\.\d)?\s*[x×]\s*\d{2,3}(?:\.\d)?\s*cm/i) || [''])[0];
  return raw.replace(/\s*\(.*$/, '').trim();
}
async function mailArtist(e: Img, subject: string, lines: string[]) {
  const p = await artistContactOf(e);
  if (!p?.email || !(await emailsOn())) return;
  const portal = !!str(e, 'artistId');
  await sendMail({ to: String(p.email), subject, lines: [`Hello ${h(String(p.contactName || p.business || ''))},`, ...lines.filter(Boolean),
    `Anything unclear? Please ask before you start: WhatsApp Kalai Art House on <a href="https://wa.me/971552996626">+971 55 299 6626</a>.`],
    button: { label: portal ? 'Open my commissions' : 'Open my artist desk', url: portal ? `${SITE}/seller.html#commissions` : `${SITE}/artist.html` } })
    .catch((err) => console.warn('Artist email failed', err));
}
async function artistOrderMail(e: Img) {
  const c = (await costingFor([str(e, 'id')])).get(str(e, 'id'));
  const d = parseDetails(detStr(e));
  const paper = paperLine(e), medium = (String(d['Artwork'] ?? '').match(/\(([^,]+),/) || [])[1] || String(d['Style'] ?? '');
  const ready = str(c, 'artistReadyBy'), note = str(c, 'studioNote');
  await mailArtist(e, `Order placed: ${str(e, 'title')} (${str(e, 'ref')}): please start`, [
    `The customer has paid, and Kalai Art House has placed order <b>${h(str(e, 'ref'))}</b> with you: <b>${h(str(e, 'title'))}</b> (${str(e, 'kind') === 'COMMISSION' ? 'commission' : 'collection work'}). Your price is fixed.`,
    `<b>Paper size:</b> ${paper ? h(paper) : 'not stated, so please ask us before you start'}${medium ? ` · <b>Medium:</b> ${h(medium)}` : ''}${ready ? ` · <b>Ready by:</b> ${h(ready)}` : ''}`,
    note ? `<b>Note from Kalai Art House:</b> ${h(note)}` : '',
    str(e, 'kind') === 'COMMISSION' ? "Work from the customer's brief and reference photo on your page." : 'Make it as shown in the picture on your page: same subject, composition and colours.',
    'Use acid-free art paper, leave about 2 cm clear margin on every side for the mount, and sign at the bottom right inside the picture.',
    'Tap <b>Started</b> on your page when you begin and <b>Finished</b> when it is done (send us a photo). Pack it flat between stiff boards, send it to the frame shop shown on your page, and enter the courier and AWB.',
  ]);
}
/** Order placed with the artist, put on hold, cancelled or resumed: tell the artist by email (page shows it too). */
async function artistNotify(rec: StreamRecord) {
  const img = rec.dynamodb?.NewImage, old = rec.dynamodb?.OldImage;
  if (rec.eventName !== 'MODIFY' || !img || !old || !['PRICE', 'COMMISSION'].includes(str(img, 'kind'))) return;
  const ref = str(img, 'ref'), title = str(img, 'title');
  if (str(img, 'zohoPOId') && !str(old, 'zohoPOId') && str(img, 'refundAction') !== 'DAMAGED_REPLACE') await artistOrderMail(img);
  if (!str(img, 'zohoPOId')) return;
  const cs = str(img, 'cancelState'), ocs = str(old, 'cancelState'), cancel = str(img, 'cancelRequest') === 'CANCEL';
  if (cs !== ocs && cs === 'REQUESTED' && cancel) await mailArtist(img, `On hold: ${title} (${ref})`, [`The customer has asked to cancel order <b>${h(ref)}</b> (<b>${h(title)}</b>). <b>Please pause the work</b> until Kalai Art House confirms.`]);
  if (cs !== ocs && cs === 'DECLINED' && cancel) await mailArtist(img, `Please continue: ${title} (${ref})`, [`The hold on order <b>${h(ref)}</b> (<b>${h(title)}</b>) is lifted: the order goes ahead. Please continue the work.`]);
  const st = str(img, 'status'), ost = str(old, 'status');
  if (st !== ost && ['REFUNDED', 'CANCELLED'].includes(st) && str(img, 'refundAction').startsWith('CANCEL')) {
    const started = !!str(img, 'artistStartedAt');
    await mailArtist(img, `Order cancelled: ${title} (${ref}): please stop`, [`The customer cancelled order <b>${h(ref)}</b> (<b>${h(title)}</b>). <b>Please stop work.</b>`,
      started ? 'You had already started, so you are paid <b>50% of your price</b>: please send your invoice for that amount.' : 'You had not started yet, so there is nothing to invoice.']);
  }
}

const MAIL_OPTIN = ['ARTIST_DONE', 'ARTIST_SENT'];
let mailOffCache: { at: number; list: string[] } | null = null;
async function mailOff(): Promise<string[]> {
  if (mailOffCache && Date.now() - mailOffCache.at < 60_000) return mailOffCache.list;
  let list: string[] = [];
  try {
    const t = process.env.SITE_TABLE;
    if (t) list = String((await ddb.send(new GetItemCommand({ TableName: t, Key: { id: { S: 'site' } } }))).Item?.mailOff?.S ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  } catch { list = []; }
  mailOffCache = { at: Date.now(), list };
  return list;
}
async function notify(rec: StreamRecord) {
  try {
    let mails = mailsFor(rec);
    // A basket: the checkout already emailed the order; the payment email comes once (from the lead order).
    const bi = rec.dynamodb?.NewImage;
    if (bi && str(bi, 'basketRef')) mails = mails.filter((m) => m.to === STUDIO_EMAIL || !(m.key === 'RECEIVED' || (m.key === 'PAID' && !bi.basketLead?.BOOL)));
    if (!mails.length || !(await emailsOn())) return;
    // Customer emails switched off in Settings (studio notifications always go).
    const off = await mailOff();
    // Opt-in emails (artist finished / sent to the framer) go only when ticked (stored as ON:KEY).
    mails = mails.filter((m) => !m.key || (MAIL_OPTIN.includes(m.key) ? off.includes(`ON:${m.key}`) : !off.includes(m.key)));
    for (const m of mails) {
      try { await sendMail(m); } catch (err) { console.warn(`Email "${m.subject}" not sent:`, err); }
    }
  } catch (err) {
    console.warn('Email step failed:', err);
  }
}

export const handler = async (event: StreamEvent | ApiEvent | UrlEvent) => {
  if ('requestContext' in event && event.requestContext?.http) return ziinaWebhook(event);
  // Every morning (EventBridge schedule): the Thirukkural of the day.
  if ((event as { task?: string }).task === 'dailyKural') {
    // Runs every hour: publish once a day, from the hour set in Settings (Dubai time).
    const st = process.env.SITE_TABLE ? (await ddb.send(new GetItemCommand({ TableName: process.env.SITE_TABLE, Key: { id: { S: 'site' } } })).catch(() => null))?.Item : undefined;
    await awardLoyalty().catch((e) => console.log('Kalai Circle points not awarded', e)); // every hour
    await progExpire().catch((e) => console.log('Programme end dates not checked', e));
    const hour = Number(st?.kuralHour?.N ?? 6), dubaiHour = new Date(Date.now() + 4 * 3600_000).getUTCHours();
    if (dubaiHour < hour) return { skipped: 'not yet' };
    await securePrintFiles().catch((e) => console.log('Print files not moved', e));
    const r = await dailyKural(false);
    if (!(r as { skipped?: string }).skipped) await refreshInr().catch((e) => console.log('INR rate not updated', e));
    return r;
  }
  if ('arguments' in event) {
    const a = event.arguments ?? {};
    await ensureEmail(event);
    const field = event.info?.fieldName ?? event.fieldName ?? (a.emirate ? 'customerAddress' : a.action ? 'customerRequest' : a.step ? 'artistProgress' : a.priceInr !== undefined ? 'artistQuote' : a.id ? 'checkZoho' : 'artistList');
    if (field === 'sellerAction') return JSON.stringify(await sellerAction(event));
    if (field === 'marketOrder') return JSON.stringify(await marketOrder(event));
    if (field === 'basketCheckout') return JSON.stringify(await basketCheckout(event));
    if (field === 'licenceOrder') return JSON.stringify(await licenceOrder(event));
    if (field === 'siteTranslate') return JSON.stringify(await siteTranslate(event.arguments as { lang?: string; texts?: string }));
    if (field === 'verifyCertificate') return JSON.stringify(await verifyCertificate(String(event.arguments.code ?? '')));
    if (field === 'ziinaAdmin') return JSON.stringify(await ziinaAdmin(event));
    if (field === 'artistWorks') return JSON.stringify(await artistWorks(event));
    if (field === 'dailyKural') return JSON.stringify(await dailyKural(true));
    if (field === 'applyCode') return JSON.stringify(await applyCode(event));
    if (field === 'checkCode') return JSON.stringify(await checkCode(event));
    if (field === 'redeemPoints') return JSON.stringify(await redeemPoints(event));
    if (field === 'assignCodes') return JSON.stringify(await assignCodes());
    if (field === 'marketAdmin') return JSON.stringify(await marketAdmin(event));
    if (field === 'translateMessage') return JSON.stringify(await translateMessage(event.arguments));
    if (field === 'catalogueImport') return JSON.stringify(await catalogueImport(event.arguments));
    if (field === 'customerAddress') return JSON.stringify(await customerAddress(event));
    if (field === 'customerProfile') return JSON.stringify(await customerProfile(event));
    if (field === 'guestEnquiry') return JSON.stringify(await guestEnquiry(event.arguments));
    if (field === 'artistRework') return JSON.stringify(await artistRework(event.arguments, actor(event)));
    if (field === 'customerRequest') return JSON.stringify(await customerRequest(event));
    if (field === 'artistList') {
      const g = event.identity?.groups ?? (event.identity?.claims?.['cognito:groups'] as string[] | undefined) ?? [];
      return JSON.stringify(await artistList(g.includes('ADMINS')));
    }
    if (field === 'artistQuote') return JSON.stringify(await artistQuote(event.arguments, actor(event)));
    if (field === 'artistPhoto') return JSON.stringify(await artistPhoto(event.arguments.id ?? ''));
    if (field === 'artistProgress') return JSON.stringify(await artistProgress(event.arguments, actor(event)));
    return JSON.stringify(await checkZoho(event.arguments.id ?? ''));
  }

  const failures: { itemIdentifier: string }[] = [];
  for (const rec of (event as StreamEvent).Records) {
    const img = rec.dynamodb?.NewImage;
    try {
      await onStreamRecord(rec);
      await logStatus(rec).catch((err) => console.warn('Status log not written', err));
      await clearStaleMessage(rec).catch((err) => console.warn('Old message not cleared', err));
      await loyaltyOnStatus(rec).catch((err) => console.warn('Points not given back', err));
      await notify(rec);
      await artistNotify(rec).catch((err) => console.warn('Artist email step failed', err));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Zoho sync failed for ${str(img, 'ref')}:`, err);
      if (img) await writeBack(str(img, 'id'), { zohoState: 'ERROR', zohoMessage: msg.slice(0, 500) });
      if (rec.eventID) failures.push({ itemIdentifier: rec.eventID });
    }
  }
  return { batchItemFailures: failures };
};
