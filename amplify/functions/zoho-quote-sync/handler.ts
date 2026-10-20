import { env } from '$amplify/env/zoho-quote-sync';

type Attr = { S?: string; N?: string; NULL?: boolean };
type StreamRecord = { eventID?: string; eventName?: string; dynamodb?: { NewImage?: Record<string, Attr> } };
type StreamEvent = { Records: StreamRecord[] };
type ZohoBody = {
  code?: number;
  message?: string;
  contacts?: { contact_id: string; contact_name: string }[];
  contact?: { contact_id: string };
  estimate?: { estimate_id: string; estimate_number: string };
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

export const handler = async (event: StreamEvent) => {
  const failures: { itemIdentifier: string }[] = [];
  for (const rec of event.Records) {
    if (rec.eventName !== 'INSERT' || !rec.dynamodb?.NewImage) continue;
    const img = rec.dynamodb.NewImage;
    const ref = str(img, 'ref');
    const kind = str(img, 'kind');
    const title = str(img, 'title') || KIND[kind] || 'Website enquiry';
    const details = parseDetails(str(img, 'details'));
    // Price enquiries have no price yet (0). Commissions use the website estimate, gifts the total shown.
    const rate = kind === 'COMMISSION' ? amount(details['Estimate']) : kind === 'GIFT' ? amount(details['Total']) : 0;

    const customerLines = [
      `Website enquiry ${ref} (${KIND[kind] ?? kind})`,
      `Customer: ${str(img, 'customerName')}`,
      `Mobile: ${str(img, 'phone')}`,
      `Email: ${str(img, 'email')}`,
    ];
    const detailLines = Object.entries(details)
      .filter(([k, v]) => v && !['Reference', 'Name', 'Mobile', 'Parent', 'Estimate', 'Total'].includes(k))
      .map(([k, v]) => `${k}: ${v}`);

    try {
      const customerId = await fixedCustomerId();
      const r = await zoho('/estimates', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: customerId,
          reference_number: ref,
          line_items: [{ name: title.slice(0, 100), description: detailLines.join('\n').slice(0, 2000), rate, quantity: 1 }],
          notes: customerLines.join('\n'),
        }),
      });
      if (!r.ok) throw new Error(`Zoho quote create failed (${r.status}): ${r.body.message}`);
      console.log(`Created Zoho quote ${r.body.estimate?.estimate_number} for ${ref}`);
    } catch (err) {
      console.error(`Zoho sync failed for ${ref}:`, err);
      if (rec.eventID) failures.push({ itemIdentifier: rec.eventID });
    }
  }
  return { batchItemFailures: failures };
};
