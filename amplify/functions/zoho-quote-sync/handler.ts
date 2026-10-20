import { env } from '$amplify/env/zoho-quote-sync';
import { DynamoDBClient, UpdateItemCommand, GetItemCommand, ScanCommand, BatchGetItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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
  arguments: { id?: string; priceInr?: number; readyBy?: string | null; note?: string | null };
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

async function writeBack(id: string, set: Record<string, string | number | null>) {
  const table = process.env.ENQUIRY_TABLE;
  if (!table || !id) return;
  const fields = { ...set, zohoAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
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
  try {
    let v: unknown = JSON.parse(str(img ?? undefined, 'costs') || '{}');
    if (typeof v === 'string') v = JSON.parse(v);
    costs = (v ?? {}) as Costs;
  } catch {
    costs = {};
  }
  return { img, costs };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

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
  if (!lines.length) return null; // no artist price yet
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
  return { id: r.body.bill.bill_id, number: r.body.bill.bill_number, total: Number(r.body.bill.total ?? 0) };
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
  if ((!str(img, 'zohoPaymentId') && !testing) || str(img, 'kind') === 'GIFT') return;
  try {
    if (!str(img, 'zohoPOId')) {
      const po = await recordArtistOrder(img);
      if (!po) {
        if (str(img, 'purchaseState') !== 'NEEDS_PRICE') {
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
      if ((str(img, 'artistInvoiceNo') || str(img, 'artistPaidRef')) && !/not posted/.test(str(img, 'purchaseMessage'))) {
        await writeBack(id, {
          purchaseMessage: `Test mode: ${str(img, 'zohoPO')} recorded. Bill and payment to Siva are not posted while testing.`,
        });
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
  if (str(e, 'zohoVendorPaymentId')) return { stage: 'PAID', label: `Paid to you${str(e, 'artistPaidRef') ? ` · ref ${str(e, 'artistPaidRef')}` : ''}` };
  if (str(e, 'zohoBillId')) return { stage: 'INVOICED', label: `Your invoice ${str(e, 'artistInvoiceNo')} received · payment pending` };
  if (str(e, 'zohoPOId')) return { stage: 'ORDERED', label: 'Ordered · price fixed · send your invoice' };
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
        ...artistStage(e, c),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function artistQuote(args: ApiEvent['arguments']) {
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
  const sets = ['artistPriceInr = :p', 'artistAt = :a', 'updatedAt = :a', 'createdAt = if_not_exists(createdAt, :c)', '#tn = if_not_exists(#tn, :t)'];
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
type Doc = { group: 'SALES' | 'PURCHASE'; type: string; id: string; number: string; status: string; date?: string; total?: number; balance?: number; url: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function zget(path: string): Promise<any> {
  const r = await zoho(path);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return r.ok ? (r.body as any) : {};
}

async function collectDocs(ref: string): Promise<Doc[]> {
  const q = encodeURIComponent(ref);
  const [est, inv, bill] = await Promise.all([
    zget(`/estimates?reference_number=${q}`),
    zget(`/invoices?reference_number=${q}&filter_by=Status.All`),
    zget(`/bills?reference_number=${q}`),
  ]);
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
    docs.push({ group: 'PURCHASE', type: 'Bill', id: b.bill_id, number: b.bill_number, status: b.status, date: b.date, total: b.total, balance: b.balance, url: `${BOOKS_APP}/bills/${b.bill_id}` });
    if (['draft', 'void'].includes(b.status)) continue;
    const pays = await zget(`/bills/${b.bill_id}/payments`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const p of (pays.payments ?? []) as any[]) {
      docs.push({ group: 'PURCHASE', type: 'Payment made', id: p.payment_id, number: p.payment_number || p.reference_number || '', status: p.payment_mode || 'recorded', date: p.date, total: p.amount, url: `${BOOKS_APP}/paymentsmade/${p.payment_id}` });
    }
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
    const docs = await collectDocs(str(img, 'ref'));
    await saveDocs(id, docs);
    // Backfill the purchase links if the documents exist in Zoho but the enquiry doesn't know them yet.
    const bill = docs.find((d) => d.type === 'Bill' && d.status !== 'void');
    const fill: Record<string, string | null> = {};
    if (bill && !str(img, 'zohoBillId')) Object.assign(fill, { zohoBill: bill.number, zohoBillId: bill.id });
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
  if (status === 'PAID' && oldStatus === 'PAID' && str(img, 'zohoState') === 'TEST') {
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

export const handler = async (event: StreamEvent | ApiEvent) => {
  if ('arguments' in event) {
    const a = event.arguments ?? {};
    const field = event.info?.fieldName ?? event.fieldName ?? (a.priceInr !== undefined ? 'artistQuote' : a.id ? 'checkZoho' : 'artistList');
    if (field === 'artistList') return JSON.stringify(await artistList());
    if (field === 'artistQuote') return JSON.stringify(await artistQuote(event.arguments));
    if (field === 'artistPhoto') return JSON.stringify(await artistPhoto(event.arguments.id ?? ''));
    return JSON.stringify(await checkZoho(event.arguments.id ?? ''));
  }

  const failures: { itemIdentifier: string }[] = [];
  for (const rec of event.Records) {
    const img = rec.dynamodb?.NewImage;
    try {
      await onStreamRecord(rec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Zoho sync failed for ${str(img, 'ref')}:`, err);
      if (img) await writeBack(str(img, 'id'), { zohoState: 'ERROR', zohoMessage: msg.slice(0, 500) });
      if (rec.eventID) failures.push({ itemIdentifier: rec.eventID });
    }
  }
  return { batchItemFailures: failures };
};
