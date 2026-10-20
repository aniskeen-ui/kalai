import { env } from '$amplify/env/zoho-quote-sync';

type Attr = { S?: string; N?: string; NULL?: boolean };
type StreamRecord = {
  eventID?: string;
  eventName?: string;
  dynamodb?: { NewImage?: Record<string, Attr>; OldImage?: Record<string, Attr> };
};
type StreamEvent = { Records: StreamRecord[] };
type ZohoBody = {
  code?: number;
  message?: string;
  contacts?: { contact_id: string; contact_name: string }[];
  contact?: { contact_id: string };
  estimate?: {
    estimate_id: string;
    estimate_number: string;
    customer_id?: string;
    reference_number?: string;
    notes?: string;
    line_items?: { line_item_id: string; name?: string; description?: string; rate?: number; quantity?: number }[];
  };
  estimates?: { estimate_id: string; estimate_number: string; reference_number?: string }[];
  invoice?: { invoice_id: string; invoice_number: string; status?: string; balance?: number; total?: number };
  invoices?: { invoice_id: string; invoice_number: string; reference_number?: string; status?: string; balance?: number }[];
  payment?: { payment_id: string; payment_number?: string };
};

const KIND: Record<string, string> = { PRICE: 'Price enquiry', COMMISSION: 'Commission', GIFT: 'Little Artists gift' };

let cachedToken: { value: string; expires: number } | null = null;
let cachedCustomerId: string | null = null;

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
  const body = (await res.json()) as ZohoBody;
  return { ok: res.ok && body.code === 0, status: res.status, body };
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

const str = (img: Record<string, Attr>, k: string) => (img[k]?.S ?? '').trim();
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

const num = (img: Record<string, Attr> | undefined, k: string) => {
  const v = img?.[k]?.N;
  return v === undefined ? null : Number(v);
};

/** Build the quote fields (item line + notes) from an enquiry record. */
function quoteParts(img: Record<string, Attr>) {
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

async function createQuote(img: Record<string, Attr>, rate?: number) {
  const q = quoteParts(img);
  const customerId = await fixedCustomerId();
  const r = await zoho('/estimates', {
    method: 'POST',
    body: JSON.stringify({
      customer_id: customerId,
      reference_number: q.ref,
      line_items: [{ name: q.name, description: q.description, rate: rate ?? q.startRate, quantity: 1 }],
      notes: q.notes,
    }),
  });
  if (!r.ok) throw new Error(`Zoho quote create failed (${r.status}): ${r.body.message}`);
  console.log(`Created Zoho quote ${r.body.estimate?.estimate_number} for ${q.ref}`);
}

/** Find the quote created for this website reference (KA-…). */
async function findQuoteId(ref: string): Promise<string | null> {
  const r = await zoho(`/estimates?reference_number=${encodeURIComponent(ref)}`);
  if (!r.ok) throw new Error(`Zoho quote search failed (${r.status}): ${r.body.message}`);
  const match = (r.body.estimates ?? []).find((e) => (e.reference_number ?? '').trim() === ref);
  return match?.estimate_id ?? null;
}

/** Set the price on the quote's first line; add the studio message to the notes. */
async function updateQuotePrice(img: Record<string, Attr>, price: number) {
  const q = quoteParts(img);
  const id = await findQuoteId(q.ref);
  if (!id) {
    // Enquiry from before the sync existed: create its quote now, with the price.
    await createQuote(img, price);
    return;
  }
  const got = await zoho(`/estimates/${id}`);
  if (!got.ok || !got.body.estimate) throw new Error(`Zoho quote read failed (${got.status}): ${got.body.message}`);
  const est = got.body.estimate;
  const lines = (est.line_items ?? []).map((li, i) =>
    i === 0
      ? { line_item_id: li.line_item_id, name: li.name, description: li.description, quantity: li.quantity ?? 1, rate: price }
      : { line_item_id: li.line_item_id, name: li.name, description: li.description, quantity: li.quantity, rate: li.rate },
  );
  if (!lines.length) lines.push({ name: q.name, description: q.description, quantity: 1, rate: price } as never);
  const msg = str(img, 'adminMessage');
  const notes = msg ? `${q.notes}\nStudio message: ${msg}` : q.notes;
  const r = await zoho(`/estimates/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ customer_id: est.customer_id, reference_number: q.ref, line_items: lines, notes }),
  });
  if (!r.ok) throw new Error(`Zoho quote update failed (${r.status}): ${r.body.message}`);
  console.log(`Updated Zoho quote ${est.estimate_number} for ${q.ref} to AED ${price}`);
}

const PAY_MODE: Record<string, string> = {
  ZIINA: 'creditcard',
  CARD: 'creditcard',
  BANK: 'banktransfer',
  CASH: 'cash',
  OTHER: 'others',
};
const PAY_LABEL: Record<string, string> = { ZIINA: 'Ziina', CARD: 'Card', BANK: 'Bank transfer', CASH: 'Cash', OTHER: 'Other' };

const dubaiToday = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);

async function findInvoice(ref: string) {
  const r = await zoho(`/invoices?reference_number=${encodeURIComponent(ref)}`);
  if (!r.ok) throw new Error(`Zoho invoice search failed (${r.status}): ${r.body.message}`);
  return (r.body.invoices ?? []).find((i) => (i.reference_number ?? '').trim() === ref && i.status !== 'void') ?? null;
}

/** Status set to Paid: quote → invoice (once), quote marked accepted, payment recorded (once). */
async function invoiceAndRecordPayment(img: Record<string, Attr>) {
  const q = quoteParts(img);
  const price = num(img, 'quotedPrice') ?? 0;
  if (!(price > 0)) throw new Error(`Cannot invoice ${q.ref}: no price set`);
  const method = str(img, 'paymentMethod') || 'OTHER';
  const payRef = str(img, 'paymentRef');

  let quoteId = await findQuoteId(q.ref);
  if (!quoteId) {
    await createQuote(img, price);
    quoteId = await findQuoteId(q.ref);
  }

  let inv = await findInvoice(q.ref);
  let invoiceId = inv?.invoice_id ?? null;
  let invoiceNumber = inv?.invoice_number ?? '';
  if (!invoiceId) {
    const customerId = await fixedCustomerId();
    const r = await zoho('/invoices', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: customerId,
        reference_number: q.ref,
        date: dubaiToday(),
        line_items: [{ name: q.name, description: q.description, rate: price, quantity: 1 }],
        notes: q.notes,
      }),
    });
    if (!r.ok || !r.body.invoice) throw new Error(`Zoho invoice create failed (${r.status}): ${r.body.message}`);
    invoiceId = r.body.invoice.invoice_id;
    invoiceNumber = r.body.invoice.invoice_number;
    console.log(`Created Zoho invoice ${invoiceNumber} for ${q.ref}`);
    // A draft invoice can't take a payment: mark it as sent (no email is sent to anyone).
    const sent = await zoho(`/invoices/${invoiceId}/status/sent`, { method: 'POST' });
    if (!sent.ok) console.warn(`Could not mark invoice ${invoiceNumber} as sent: ${sent.body.message}`);
    if (quoteId) {
      const acc = await zoho(`/estimates/${quoteId}/status/accepted`, { method: 'POST' });
      if (!acc.ok) console.warn(`Could not mark quote for ${q.ref} accepted: ${acc.body.message}`);
    }
  }

  const fresh = await zoho(`/invoices/${invoiceId}`);
  if (!fresh.ok || !fresh.body.invoice) throw new Error(`Zoho invoice read failed (${fresh.status}): ${fresh.body.message}`);
  const balance = Number(fresh.body.invoice.balance ?? 0);
  if (fresh.body.invoice.status === 'paid' || balance <= 0) {
    console.log(`Invoice ${invoiceNumber} for ${q.ref} already paid; no payment recorded`);
    return;
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
      invoices: [{ invoice_id: invoiceId, amount_applied: balance }],
    }),
  });
  if (!pay.ok) throw new Error(`Zoho payment record failed (${pay.status}): ${pay.body.message}`);
  console.log(`Recorded AED ${balance} payment on ${invoiceNumber} for ${q.ref}`);
}

export const handler = async (event: StreamEvent) => {
  const failures: { itemIdentifier: string }[] = [];
  for (const rec of event.Records) {
    const img = rec.dynamodb?.NewImage;
    if (!img) continue;
    const ref = str(img, 'ref');
    try {
      if (rec.eventName === 'INSERT') {
        await createQuote(img);
      } else if (rec.eventName === 'MODIFY') {
        const old = rec.dynamodb?.OldImage;
        const before = num(old, 'quotedPrice');
        const after = num(img, 'quotedPrice');
        const nowPaid = str(img, 'status') === 'PAID';
        const wasPaid = old ? str(old, 'status') === 'PAID' : false;
        if (nowPaid && !wasPaid) {
          await invoiceAndRecordPayment(img);
        } else if (after !== null && after > 0 && after !== before && !nowPaid) {
          await updateQuotePrice(img, after);
        }
      }
    } catch (err) {
      console.error(`Zoho sync failed for ${ref}:`, err);
      if (rec.eventID) failures.push({ itemIdentifier: rec.eventID });
    }
  }
  return { batchItemFailures: failures };
};
