import { env } from '$amplify/env/zoho-quote-sync';
import { DynamoDBClient, UpdateItemCommand, GetItemCommand, ScanCommand, BatchGetItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

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
  arguments: { id?: string; priceInr?: number | null; readyBy?: string | null; note?: string | null; step?: string; courier?: string | null; awb?: string | null; action?: string; reason?: string | null; photos?: string | null };
  info?: { fieldName?: string };
  fieldName?: string;
};
type LineItem = { line_item_id?: string; name?: string; description?: string; rate?: number; quantity?: number; tax_id?: string };
type ZohoBody = {
  code?: number;
  message?: string;
  contacts?: { contact_id: string; contact_name: string }[];
  contact?: { contact_id: string };
  estimate?: { estimate_id: string; estimate_number: string; customer_id?: string; status?: string; line_items?: LineItem[] };
  estimates?: { estimate_id: string; estimate_number: string; reference_number?: string; status?: string }[];
  invoice?: { invoice_id: string; invoice_number: string; status?: string; balance?: number; total?: number };
  invoices?: { invoice_id: string; invoice_number: string; reference_number?: string; status?: string; balance?: number }[];
  payment?: { payment_id: string; payment_number?: string };
  payments?: { payment_id: string; payment_number?: string; amount?: number }[];
  purchaseorder?: { purchaseorder_id: string; purchaseorder_number: string; status?: string; line_items?: (LineItem & { account_id?: string })[] };
  bill?: { bill_id: string; bill_number: string; balance?: number; total?: number; status?: string };
  vendorpayment?: { payment_id: string; payment_number?: string };
};

const KIND: Record<string, string> = { PRICE: 'Price enquiry', COMMISSION: 'Commission', GIFT: 'Little Artists gift' };
const INVOICE_PREFIX = 'KAH-INV-';
// Kalai's own credit note series. Like KAH-INV, the next number is worked out from the credit notes that exist,
// so deleting the test drafts before going live makes the live series start again at KAH-CN-0001.
const CREDIT_PREFIX = 'KAH-CN-';
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

/** True while testing: invoices and POs stay drafts; no payments, bills or vendor payments are posted. */
async function testMode(): Promise<boolean> {
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

const str = (img: Img | undefined, k: string) => (img?.[k]?.S ?? '').trim();
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
  const details = parseDetails(str(img, 'details'));
  const customerLines = [
    `Website enquiry ${ref} (${KIND[kind] ?? kind})`,
    `Customer: ${str(img, 'customerName')}`,
    `Mobile: ${str(img, 'phone')}`,
    `Email: ${str(img, 'email')}`,
  ];
  const detailLines = Object.entries(details)
    .filter(([k, v]) => v && !['Reference', 'Name', 'Mobile', 'Parent', 'Estimate', 'Total'].includes(k))
    .map(([k, v]) => `${k}: ${v}`);
  // Price enquiries start at 0. Commissions use the website estimate, gifts the total shown.
  const startRate = kind === 'COMMISSION' ? amount(details['Estimate']) : kind === 'GIFT' ? amount(details['Total']) : 0;
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

async function createQuote(img: Img, rate?: number) {
  const q = quoteParts(img);
  const customerId = await fixedCustomerId();
  const vat = await vatFields();
  const r = await zoho('/estimates', {
    method: 'POST',
    body: JSON.stringify({
      customer_id: customerId,
      reference_number: q.ref,
      ...vat.header,
      line_items: [{ name: q.name, description: q.description, rate: rate ?? q.startRate, quantity: 1, ...(vat.taxId ? { tax_id: vat.taxId } : {}) }],
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
  const lines: LineItem[] = (est.line_items ?? []).map((li, i) => ({
    line_item_id: li.line_item_id,
    name: li.name,
    description: li.description,
    quantity: li.quantity ?? 1,
    rate: i === 0 ? price : li.rate,
    ...tax,
  }));
  if (!lines.length) lines.push({ name: q.name, description: q.description, quantity: 1, rate: price, ...tax });
  const msg = str(img, 'adminMessage');
  const notes = msg ? `${q.notes}\nStudio message: ${msg}` : q.notes;
  const r = await zoho(`/estimates/${found.id}`, {
    method: 'PUT',
    body: JSON.stringify({ customer_id: est.customer_id, reference_number: q.ref, ...vat.header, line_items: lines, notes }),
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
async function nextInvoiceNumber(): Promise<number> {
  const r = await zoho(`/invoices?invoice_number_startswith=${encodeURIComponent(INVOICE_PREFIX)}&per_page=200&filter_by=Status.All`);
  if (!r.ok) throw new Error(`Zoho invoice numbering failed (${r.status}): ${r.body.message}`);
  let max = 0;
  for (const i of r.body.invoices ?? []) {
    if (!i.invoice_number.startsWith(INVOICE_PREFIX)) continue;
    const n = Number(i.invoice_number.slice(INVOICE_PREFIX.length));
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
    const n = Number(num.slice(prefix.length));
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
  if (v.ok) return 'void';
  throw new Error(`Test mode: ${path.split('/')[1]} was created in Zoho but could not be set to draft or void (${v.body.message ?? d.body.message}). Void or delete it in Zoho by hand. If the message is about permission, add the UPDATE scope for it to the Zoho token.`);
}

async function createInvoice(img: Img, price: number) {
  const q = quoteParts(img);
  const customerId = await fixedCustomerId();
  const vat = await vatFields();
  let n = await nextInvoiceNumber();
  for (let attempt = 0; attempt < 4; attempt++, n++) {
    const number = `${INVOICE_PREFIX}${String(n).padStart(4, '0')}`;
    const r = await zoho('/invoices?ignore_auto_number_generation=true', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: customerId,
        invoice_number: number,
        reference_number: q.ref,
        date: dubaiToday(),
        ...vat.header,
        line_items: [{ name: q.name, description: q.description, rate: price, quantity: 1, ...(vat.taxId ? { tax_id: vat.taxId } : {}) }],
        notes: q.notes,
      }),
    });
    if (r.ok && r.body.invoice) {
      console.log(`Created Zoho invoice ${r.body.invoice.invoice_number} for ${q.ref}`);
      return { id: r.body.invoice.invoice_id, number: r.body.invoice.invoice_number };
    }
    // Number taken (another invoice raced us): try the next one.
    if (!/already|exist|duplicate/i.test(r.body.message ?? '')) {
      throw new Error(`Zoho invoice create failed (${r.status}): ${r.body.message}`);
    }
  }
  throw new Error('Zoho invoice create failed: could not find a free KAH-INV number');
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
  const customerId = await fixedCustomerId();
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
  const artistAed = round2(Number(costs.artistAed ?? 0));
  const courier = round2(Number(costs.indiaCourier ?? 0));
  const inr = Number(costs.artistInr ?? num(cimg ?? undefined, 'artistPriceInr') ?? 0);
  const q = quoteParts(img);
  const lines: LineItem[] = [];
  if (artistAed > 0) {
    lines.push({
      name: q.name,
      description: `Artwork for ${ref}${inr ? ` · artist price INR ${inr.toLocaleString('en-IN')} @ ${costs.fx ?? ''} AED/INR` : ''}`,
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
let cachedAccount: string | null | undefined;
async function artistAccountId(): Promise<string | null> {
  if (cachedAccount !== undefined) return cachedAccount;
  let id: string | null = null;
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: '/kalai/zoho/artist_account_id' }));
    id = (r.Parameter?.Value ?? '').trim() || null;
  } catch {
    id = null;
  }
  if (!id) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (await zoho('/chartofaccounts?filter_by=AccountType.CostOfGoodsSold')).body as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acc = (r.chartofaccounts ?? []).find((a: any) => /cost of goods sold/i.test(a.account_name)) ?? (r.chartofaccounts ?? [])[0];
    id = acc?.account_id ?? null;
  }
  cachedAccount = id;
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
      vendor_id: await vendorId(),
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
      vendor_id: await vendorId(),
      payment_mode: 'banktransfer',
      amount: balance,
      date: dubaiToday(),
      reference_number: payRef,
      description: `Payment to ${VENDOR_NAME} for ${ref}`,
      bills: [{ bill_id: billId, amount_applied: balance }],
    }),
  });
  if (!r.ok || !r.body.vendorpayment) throw new Error(`Zoho vendor payment failed (${r.status}): ${r.body.message}`);
  console.log(`Recorded AED ${balance} payment to ${VENDOR_NAME} for ${ref}`);
  return { id: r.body.vendorpayment.payment_id, amount: balance };
}

/** Run whichever purchase step is due. Never throws: problems go to purchaseMessage. */
async function purchaseSteps(start: Img) {
  let img: Img = { ...start };
  const id = str(img, 'id');
  const testing = str(img, 'zohoState') === 'TEST' && !!str(img, 'zohoInvoiceId');
  if ((!str(img, 'zohoPaymentId') && !testing) || str(img, 'kind') === 'GIFT' || str(img, 'purchaseState') === 'CANCELLED' || str(img, 'refundAction').startsWith('CANCEL')) return;
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
        purchaseMessage: `${po.number}: ${VENDOR_NAME} · AED ${po.total.toLocaleString('en-US')} owed when his invoice arrives (price fixed)`,
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
          purchaseMessage: `Test mode: ${state === 'draft' ? 'draft' : 'void (test)'} bill ${bill.number} from ${VENDOR_NAME} · AED ${bill.total.toLocaleString('en-US')}. Payment to Siva is not recorded while testing.`,
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
        purchaseMessage: `Bill ${bill.number} from ${VENDOR_NAME} · AED ${bill.total.toLocaleString('en-US')} to pay`,
      });
      img = { ...img, zohoBill: { S: bill.number }, zohoBillId: { S: bill.id } };
    }
    if (str(img, 'artistPaidRef') && str(img, 'zohoBillId') && !str(img, 'zohoVendorPaymentId')) {
      const pay = await payVendor(img);
      await writeBack(id, {
        purchaseState: 'ARTIST_PAID',
        zohoVendorPaymentId: pay.id,
        purchaseMessage: `${VENDOR_NAME} paid${pay.amount ? ` AED ${pay.amount.toLocaleString('en-US')}` : ''} (ref ${str(img, 'artistPaidRef')}) against bill ${str(img, 'zohoBill')}`,
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
    `Deliver to: ${str(img, 'customerName')} · ${str(img, 'phone')}`,
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
    customer_id: await fixedCustomerId(),
    reference_number: q.ref,
    date: dubaiToday(),
    challan_type: 'others',
    line_items: [{ name: q.name, description: q.description, rate: price, quantity: 1 }],
    notes,
  };
  let r = await zoho('/deliverychallans', { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok && /challan_type/i.test(r.body.message ?? '')) {
    delete body.challan_type; // not used in every edition
    r = await zoho('/deliverychallans', { method: 'POST', body: JSON.stringify(body) });
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
    customer_id: await fixedCustomerId(),
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
  let n = await nextSeriesNumber(CREDIT_PREFIX, '/creditnotes', 'creditnotes', 'creditnote_number');
  for (let attempt = 0; attempt < 4; attempt++, n++) {
    const b = { ...body, creditnote_number: `${CREDIT_PREFIX}${String(n).padStart(4, '0')}` };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let r = await zoho('/creditnotes?ignore_auto_number_generation=true', { method: 'POST', body: JSON.stringify(b) }) as any;
    // Not allowed against this invoice (e.g. a draft invoice in test mode): create it without the link.
    if (!r.ok && /invoice/i.test(r.body.message ?? '') && (b as Record<string, unknown>).invoice_id) {
      delete (b as Record<string, unknown>).invoice_id;
      r = await zoho('/creditnotes?ignore_auto_number_generation=true', { method: 'POST', body: JSON.stringify(b) });
    }
    if (r.ok && r.body.creditnote) return r.body.creditnote as { creditnote_id: string; creditnote_number: string; status?: string };
    if (!/already|exist|duplicate/i.test(r.body.message ?? '')) throw new Error(`Zoho credit note failed (${r.status}): ${r.body.message}`);
  }
  throw new Error('Zoho credit note failed: could not find a free KAH-CN number');
}

/** Test mode: the credit note only, kept as a draft (no refund, nothing posted). */
async function draftCreditNote(img: Img, amount: number) {
  const q = quoteParts(img);
  const action = str(img, 'refundAction');
  if (str(img, 'zohoCreditNoteId')) return { number: str(img, 'zohoCreditNote'), id: str(img, 'zohoCreditNoteId'), state: 'draft' as const };
  const vat = await vatFields();
  const cn = await postCreditNote({
    customer_id: await fixedCustomerId(), reference_number: q.ref, date: dubaiToday(), invoice_id: str(img, 'zohoInvoiceId'), ...vat.header,
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
  const retryTestNote = str(img, 'refundState') === 'TEST' && !str(img, 'zohoCreditNoteId') && /Credit note not created/.test(str(img, 'refundMessage')) && action !== 'DAMAGED_REPLACE';
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
    const sivaCancelled = action === 'CANCEL_FULL' && str(img, 'kind') !== 'GIFT' && !str(img, 'zohoBillId');
    const sivaNote =
      action === 'CANCEL_FULL'
        ? sivaCancelled ? " Siva's order cancelled (nothing owed)." : " Siva's bill already exists: agree with him what is owed."
        : str(img, 'kind') === 'GIFT' ? '' : ' Siva had started / finished: pay him as agreed.';

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

const PRIVATE_KEY = /name|mobile|phone|whats|email|address|parent|contact|reference|deliver|to$|gift for/i;

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

function artistStage(e: Img, c: Img | undefined) {
  if (str(e, 'purchaseState') === 'CANCELLED') return { stage: 'CLOSED', label: 'Order cancelled by the customer' };
  if (str(e, 'zohoVendorPaymentId')) return { stage: 'PAID', label: `Paid to you${str(e, 'artistPaidRef') ? ` · ref ${str(e, 'artistPaidRef')}` : ''}` };
  if (str(e, 'zohoBillId')) return { stage: 'INVOICED', label: `Your invoice ${str(e, 'artistInvoiceNo')} received · payment pending` };
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
  if (num(c, 'artistPriceInr')) return { stage: 'PRICED', label: status === 'PAID' ? 'Customer paid · order coming' : 'Price given · waiting for customer' };
  return { stage: 'NEEDED', label: 'Price needed' };
}

async function artistList() {
  const table = process.env.ENQUIRY_TABLE;
  if (!table) throw new Error('ENQUIRY_TABLE is not configured');
  const enquiries = (await scanAll(table)).filter((e) => ['PRICE', 'COMMISSION'].includes(str(e, 'kind')));
  const costing = await costingFor(enquiries.map((e) => str(e, 'id')));
  return enquiries
    .map((e) => {
      const c = costing.get(str(e, 'id'));
      const brief = Object.entries(parseDetails(str(e, 'details')))
        .filter(([k, v]) => v && !PRIVATE_KEY.test(k))
        .map(([k, v]) => ({ k, v: String(v).slice(0, 500) }));
      return {
        id: str(e, 'id'),
        ref: str(e, 'ref'),
        kind: str(e, 'kind'),
        title: str(e, 'title'),
        createdAt: str(e, 'createdAt'),
        brief,
        hasPhoto: str(e, 'kind') === 'COMMISSION' && !!str(e, 'fileKey'),
        artistPriceInr: num(c, 'artistPriceInr'),
        artistReadyBy: str(c, 'artistReadyBy'),
        artistNote: str(c, 'artistNote'),
        locked: !!str(e, 'zohoPOId'),
        ordered: !!str(e, 'zohoPOId') && str(e, 'purchaseState') !== 'CANCELLED',
        progress: str(e, 'artistStage'),
        startedAt: str(e, 'artistStartedAt'),
        finishedAt: str(e, 'artistFinishedAt'),
        shippedAt: str(e, 'artistShippedAt'),
        artistCourier: str(e, 'artistCourier'),
        artistAwb: str(e, 'artistAwb'),
        progressBy: str(e, 'artistBy'),
        onHold: str(e, 'cancelState') === 'REQUESTED' && str(e, 'cancelRequest') === 'CANCEL',
        rework: reworkForArtist(e, c),
        priceBy: str(c, 'artistBy'),
        ...artistStage(e, c),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function artistQuote(args: ApiEvent['arguments'], by = 'Siva') {
  const id = args.id ?? '';
  const enquiryTable = process.env.ENQUIRY_TABLE;
  const costingTable = process.env.COSTING_TABLE;
  if (!enquiryTable || !costingTable) throw new Error('Tables are not configured');
  const got = await ddb.send(new GetItemCommand({ TableName: enquiryTable, Key: { id: { S: id } } }));
  const e = got.Item as Img | undefined;
  if (!e || !['PRICE', 'COMMISSION'].includes(str(e, 'kind'))) throw new Error('Enquiry not found');
  if (str(e, 'zohoPOId')) throw new Error('Already ordered: the price can no longer change. Contact Kalai Art House.');
  const price = Number(args.priceInr);
  if (!(price > 0) || price > 10_000_000) throw new Error('Enter your price in INR (a number above 0).');
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
  const sets = ['artistPriceInr = :p', 'artistAt = :a', 'artistBy = :b', 'updatedAt = :a', 'createdAt = if_not_exists(createdAt, :c)', '#tn = if_not_exists(#tn, :t)'];
  const removes: string[] = [];
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
  console.log(`Artist price INR ${price} saved for ${str(e, 'ref')}`);
  return { ok: true, ref: str(e, 'ref'), artistPriceInr: price, artistReadyBy: readyBy, artistNote: note };
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
  if (!PROGRESS.includes(step)) throw new Error('Unknown step');
  const got = await ddb.send(new GetItemCommand({ TableName: table, Key: { id: { S: id } } }));
  const e = got.Item as Img | undefined;
  if (!e || !['PRICE', 'COMMISSION'].includes(str(e, 'kind'))) throw new Error('Order not found');
  if (str(e, 'purchaseState') === 'CANCELLED') throw new Error('This order was cancelled by the customer.');
  if (str(e, 'cancelState') === 'REQUESTED' && str(e, 'cancelRequest') === 'CANCEL') throw new Error('On hold: the customer asked to cancel. Please wait for Kalai Art House before continuing.');
  if (!str(e, 'zohoPOId')) throw new Error('Not ordered yet: wait until the customer has paid and the order is placed.');
  const current = PROGRESS.indexOf(str(e, 'artistStage'));
  const target = PROGRESS.indexOf(step);
  if (target < current) throw new Error(`Already marked ${str(e, 'artistStage').toLowerCase()}.`);
  const courier = String(args.courier ?? '').trim().slice(0, 60);
  const awb = String(args.awb ?? '').trim().slice(0, 60);
  if (step === 'SHIPPED' && (!courier || !awb)) throw new Error('Enter the courier and the AWB / tracking number.');
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
  return { ok: true, ref: str(e, 'ref'), ...set };
}

async function artistPhoto(id: string) {
  const table = process.env.ENQUIRY_TABLE;
  const bucket = process.env.UPLOADS_BUCKET;
  if (!table || !bucket) throw new Error('Not configured');
  const got = await ddb.send(new GetItemCommand({ TableName: table, Key: { id: { S: id } } }));
  const e = got.Item as Img | undefined;
  const key = str(e, 'fileKey');
  if (!e || str(e, 'kind') !== 'COMMISSION' || !key.startsWith('uploads/')) throw new Error('No reference photo for this enquiry');
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 900 });
  return { url };
}

// ---------- "Check Zoho" from the Studio desk ----------

// ---------- all Zoho documents for one order (shown on the Studio desk) ----------

const BOOKS_APP = `https://books.zoho.com/app/${env.ZOHO_ORG_ID}#`;
type Doc = { group: 'SALES' | 'PURCHASE' | 'DELIVERY'; type: string; id: string; number: string; status: string; date?: string; total?: number; balance?: number; url: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function zget(path: string): Promise<any> {
  const r = await zoho(path);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return r.ok ? (r.body as any) : {};
}

async function collectDocs(ref: string, prevChallans: string[] = []): Promise<Doc[]> {
  const q = encodeURIComponent(ref);
  const rw = encodeURIComponent(`${ref}-RW`);
  const [est, inv, bill, rwBill, dcs, cns] = await Promise.all([
    zget(`/estimates?reference_number=${q}`),
    zget(`/invoices?reference_number=${q}&filter_by=Status.All`),
    zget(`/bills?reference_number=${q}`),
    zget(`/bills?reference_number=${rw}`),
    zget(`/deliverychallans?reference_number=${q}&filter_by=Status.All`),
    zget(`/creditnotes?reference_number=${q}`),
  ]);
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
    docs.push({ group: 'PURCHASE', type: b.rework ? 'Bill (rework)' : 'Bill', id: b.bill_id, number: b.bill_number, status: b.status, date: b.date, total: b.total, balance: b.balance, url: `${BOOKS_APP}/bills/${b.bill_id}` });
    if (['draft', 'void'].includes(b.status)) continue;
    const pays = await zget(`/bills/${b.bill_id}/payments`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const p of (pays.payments ?? []) as any[]) {
      docs.push({ group: 'PURCHASE', type: 'Payment made', id: p.payment_id, number: p.payment_number || p.reference_number || '', status: p.payment_mode || 'recorded', date: p.date, total: p.amount, url: `${BOOKS_APP}/paymentsmade/${p.payment_id}` });
    }
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
    const bill = docs.find((d) => d.type === 'Bill' && d.status !== 'void');
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
    const quote = await createQuote(img);
    await writeBack(id, { zohoState: 'QUOTED', zohoQuote: quote.number, zohoMessage: `Quote ${quote.number} created in Zoho` });
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
      if (str(img, 'kind') !== 'GIFT') {
        await purchaseSteps({ ...img, zohoState: { S: 'TEST' }, zohoInvoiceId: { S: r.invoiceId }, zohoInvoice: { S: r.invoice } });
      }
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
    if (str(img, 'kind') !== 'GIFT') await purchaseSteps({ ...img, zohoPaymentId: { S: r.paymentId } });
    return;
  }

  if (price !== null && price > 0 && price !== oldPrice && status !== 'PAID') {
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
    if (['PAID', 'FRAMING'].includes(status)) {
      const started = str(e, 'kind') === 'GIFT' ? status === 'FRAMING' : !!str(e, 'artistStartedAt') || status === 'FRAMING';
      return started
        ? t('HALF', 0.5, str(e, 'kind') === 'GIFT' ? 'Framing has started, so 50% is refunded.' : 'The artist has started your work, so 50% is refunded to cover the artist\'s time.')
        : t('FULL', 1, 'The work has not started yet, so the full amount is refunded.');
    }
    if (status === 'SHIPPED') return t('NONE', 0, 'It has already shipped, so it can no longer be cancelled. If it arrives damaged, report it here within 48 hours of delivery.', false);
    return t('NONE', 0, 'This order can no longer be cancelled.', false);
  }
  if (action === 'DAMAGED_REFUND' || action === 'DAMAGED_REPLACE') {
    if (status !== 'DELIVERED') return t('NONE', 0, 'Damage can be reported once the order is delivered.', false);
    const at = Date.parse(str(e, 'deliveredAt') || str(e, 'updatedAt'));
    if (Number.isFinite(at) && now - at > DAMAGE_WINDOW_MS) return t('NONE', 0, 'Damage must be reported within 48 hours of delivery. Please contact us.', false);
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
type Mail = { to: string; subject: string; lines: string[]; button?: { label: string; url: string }; footer?: string };

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
  const msgLine = msg ? `<b>Message from us:</b> ${h(msg)}` : '';
  const hi = `Hello ${h(name)},`;
  const out: Mail[] = [];
  const cust = (subject: string, lines: string[], button = MY) => out.push({ to, subject, lines: [hi, ...lines.filter(Boolean)], button });
  const studio = (subject: string, lines: string[]) => out.push({ to: STUDIO_EMAIL, subject, lines: lines.filter(Boolean), button: DESK(id), footer: 'Studio notification from art.pranixtechno.com' });

  if (rec.eventName === 'INSERT') {
    cust(`We've received your enquiry ${ref}`, [
      kind === 'GIFT' ? `Thank you for sending us your child's drawing. We'll frame it with care and confirm the delivery charge and date shortly.`
        : kind === 'COMMISSION' ? `Thank you for your commission request: <b>${h(title)}</b>. We'll come back with the price, size options and delivery date, usually within 24 hours.`
        : `Thank you for your interest in <b>${h(title)}</b>. We'll reply with the price, framing options and delivery date, usually within 24 hours.`,
      `Your reference is <b>${h(ref)}</b>. You can follow every step under My enquiries & orders on our website.`]);
    studio(`New ${KIND[kind] ?? 'enquiry'}: ${title} (${ref})`, [`<b>${h(title)}</b>`, `${h(str(img, 'customerName'))} · ${h(str(img, 'phone'))} · ${h(to)}`, `Reference ${h(ref)}`]);
    return out;
  }
  if (rec.eventName !== 'MODIFY' || !old) return out;
  const own = str(img, 'zohoAt') !== str(old, 'zohoAt');

  // Results our function wrote (refund recorded).
  const rs = str(img, 'refundState'), ors = str(old, 'refundState');
  if (rs !== ors && ['DONE', 'TEST'].includes(rs) && str(img, 'refundAction') !== 'DAMAGED_REPLACE') {
    const amt = num(img, 'refundAmount');
    cust(`Refund of ${aed(amt)} for ${ref}`, [`We've refunded <b>${aed(amt)}</b> for <b>${h(title)}</b>${str(img, 'refundRef') ? ` (reference ${h(str(img, 'refundRef'))})` : ''}.`,
      'Depending on your bank it usually shows in your account within 7 working days.', 'We are sorry this one did not work out, and we hope to paint for you again.']);
  }
  if (own) return out;

  const st = str(img, 'status') || 'RECEIVED';
  const ost = str(old, 'status') || 'RECEIVED';
  const statusChanged = st !== ost;
  if (statusChanged) {
    if (st === 'PRICE_SENT') cust(`Your price for ${title} (${ref})`, [
      price ? `The price for <b>${h(title)}</b> is <b>${aed(price)}</b>, including framing, delivery in the UAE and VAT where it applies.` : `We've replied about <b>${h(title)}</b>.`,
      msgLine, str(img, 'paymentLink') ? 'You can pay securely with the button below. The price is held for 7 days.' : 'The price is held for 7 days. Reply to this email or message us on WhatsApp to go ahead.',
      `By paying you agree to our <a href="${SITE}/#terms">terms</a>, including the cancellation policy.`],
      str(img, 'paymentLink') ? { label: `Pay ${aed(price)} securely`, url: str(img, 'paymentLink') } : MY);
    if (st === 'PAID') cust(`Payment received: thank you (${ref})`, [`We've received your payment${price ? ` of <b>${aed(price)}</b>` : ''} for <b>${h(title)}</b>. Your order is confirmed.`,
      str(img, 'zohoInvoice') ? `Invoice ${h(str(img, 'zohoInvoice'))} follows separately.` : '', msgLine,
      "You can follow every step under My enquiries & orders, and we'll email you the tracking number when it ships.",
      'Changed your mind? You can request a cancellation under My enquiries & orders: before the work starts you get a full refund.']);
    // Being framed: shown on My enquiries & orders only (no email).
    if (st === 'SHIPPED') cust(`On its way: ${title} (${ref})`, [`<b>${h(title)}</b> has shipped${str(img, 'courierName') ? ` with <b>${h(str(img, 'courierName'))}</b>` : ''}${str(img, 'trackingNo') ? `, tracking number <b>${h(str(img, 'trackingNo'))}</b>` : ''}.`, msgLine, 'Please check the parcel when it arrives. If anything is damaged, report it with photos under My enquiries & orders within 48 hours.']);
    if (st === 'DELIVERED') cust(`Delivered: ${title}`, [`<b>${h(title)}</b> has been delivered. We hope you love it.`, msgLine,
      'If anything arrived damaged, report it with photos under My enquiries & orders within 48 hours and choose a replacement or a refund.',
      'We would be grateful for your feedback: you can rate your order under My enquiries & orders.'], { label: 'Rate your order', url: `${SITE}/#my-enquiries` });
    // Replacement: the customer already got "We've received your damage report"; progress is on their page.
    if (st === 'CANCELLED') {
      const self = str(img, 'cancelRequest') === 'CANCEL';
      cust(`Cancelled: ${ref}`, [self ? `As you asked, your enquiry for <b>${h(title)}</b> is cancelled. Nothing was paid, so there is nothing more to do.` : `Your enquiry for <b>${h(title)}</b> is now closed.`, msgLine, 'You are welcome back any time.']);
      if (self) studio(`Customer cancelled ${ref} (not paid)`, [`${h(str(img, 'customerName'))} cancelled <b>${h(title)}</b> before paying.`, str(img, 'cancelReason') ? `Reason: ${h(str(img, 'cancelReason'))}` : '', 'The Zoho quote is marked declined automatically.']);
    }
  }

  // Artist started: shown on the customer's page (and in the cancellation terms there), no email.

  // A customer request (cancel / damage) or the studio's answer to it.
  const cs = str(img, 'cancelState'), ocs = str(old, 'cancelState');
  if (cs !== ocs && cs === 'REQUESTED') {
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
  if (cs !== ocs && cs === 'DECLINED') {
    cust(`About your request for ${ref}`, [`We've looked at your request for <b>${h(title)}</b>.`, str(img, 'cancelReply') ? h(str(img, 'cancelReply')) : 'We are unable to accept it under our terms. Please reply to this email if you would like to talk it through.']);
  }

  // Return pickup for a replacement.
  if (str(img, 'returnAwb') && str(img, 'returnAwb') !== str(old, 'returnAwb') && str(img, 'returnMode') === 'PICKUP') {
    const d = str(img, 'returnPickupDate');
    cust(`Pickup booked for ${title} (${ref})`, [`We've booked a courier to collect the damaged <b>${h(title)}</b>${d ? ` on <b>${h(new Date(d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }))}</b>` : ''}.`,
      `Courier: <b>${h(str(img, 'returnCourier'))}</b> · return AWB <b>${h(str(img, 'returnAwb'))}</b>. The driver brings the label; please pack it in the original packaging if you still have it.`,
      "We'll email you when it reaches our framing studio."]);
  }
  // Received at the frame shop: shown on the customer's replacement tracker, no email.

  // A new message on the order without a status change.
  if (!statusChanged && msg && msg !== str(old, 'adminMessage')) cust(`A message about your order ${ref}`, [`About <b>${h(title)}</b>:`, h(msg)]);
  return out;
}

async function notify(rec: StreamRecord) {
  try {
    const mails = mailsFor(rec);
    if (!mails.length || !(await emailsOn())) return;
    for (const m of mails) {
      try { await sendMail(m); } catch (err) { console.warn(`Email "${m.subject}" not sent:`, err); }
    }
  } catch (err) {
    console.warn('Email step failed:', err);
  }
}

export const handler = async (event: StreamEvent | ApiEvent) => {
  if ('arguments' in event) {
    const a = event.arguments ?? {};
    const field = event.info?.fieldName ?? event.fieldName ?? (a.action ? 'customerRequest' : a.step ? 'artistProgress' : a.priceInr !== undefined ? 'artistQuote' : a.id ? 'checkZoho' : 'artistList');
    if (field === 'artistRework') return JSON.stringify(await artistRework(event.arguments, actor(event)));
    if (field === 'customerRequest') return JSON.stringify(await customerRequest(event));
    if (field === 'artistList') return JSON.stringify(await artistList());
    if (field === 'artistQuote') return JSON.stringify(await artistQuote(event.arguments, actor(event)));
    if (field === 'artistPhoto') return JSON.stringify(await artistPhoto(event.arguments.id ?? ''));
    if (field === 'artistProgress') return JSON.stringify(await artistProgress(event.arguments, actor(event)));
    return JSON.stringify(await checkZoho(event.arguments.id ?? ''));
  }

  const failures: { itemIdentifier: string }[] = [];
  for (const rec of event.Records) {
    const img = rec.dynamodb?.NewImage;
    try {
      await onStreamRecord(rec);
      await notify(rec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Zoho sync failed for ${str(img, 'ref')}:`, err);
      if (img) await writeBack(str(img, 'id'), { zohoState: 'ERROR', zohoMessage: msg.slice(0, 500) });
      if (rec.eventID) failures.push({ itemIdentifier: rec.eventID });
    }
  }
  return { batchItemFailures: failures };
};
