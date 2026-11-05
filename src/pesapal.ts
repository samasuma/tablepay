// Pesapal API 3.0 (JSON): hosted checkout for card, M-Pesa and Airtel Money.
// Flow: RequestToken -> RegisterIPN (once per notification URL) -> SubmitOrderRequest (one per guest share)
// -> guest pays on Pesapal's page -> Pesapal calls our IPN URL and redirects the guest back
// -> we confirm with GetTransactionStatus.
//
// Each venue can have its own Pesapal merchant keys (restaurants.pesapal_key/secret), so money settles
// straight to the venue. PESAPAL_CONSUMER_KEY/SECRET in the environment are the fallback (e.g. sandbox).
// With no keys at all, Pesapal runs in MOCK mode: payments complete by themselves after a few seconds.

export type PesapalCreds = { key: string; secret: string };
export type PesapalOutcome = { trackingId: string; success: boolean; reference?: string; method?: string; reason?: string };

const env = process.env;
const BASE = env.PESAPAL_ENV === "live" ? "https://pay.pesapal.com/v3" : "https://cybqa.pesapal.com/pesapalv3";

export function credsFor(venue: { pesapal_key?: string | null; pesapal_secret?: string | null }): PesapalCreds | null {
  if (venue.pesapal_key && venue.pesapal_secret) return { key: venue.pesapal_key, secret: venue.pesapal_secret };
  if (env.PESAPAL_CONSUMER_KEY && env.PESAPAL_CONSUMER_SECRET) return { key: env.PESAPAL_CONSUMER_KEY, secret: env.PESAPAL_CONSUMER_SECRET };
  return null;
}

const tokens = new Map<string, { value: string; expires: number }>();
const ipnIds = new Map<string, string>(); // consumer key + url -> ipn_id

async function call(path: string, init: { method: "GET" | "POST"; token?: string; body?: unknown }) {
  const r = await fetch(BASE + path, {
    method: init.method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok || (j?.error && (j.error.message || j.error.code))) {
    throw new Error(j?.error?.message || j?.message || `Pesapal request failed (${r.status})`);
  }
  return j;
}

async function token(c: PesapalCreds): Promise<string> {
  const hit = tokens.get(c.key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const j = await call("/api/Auth/RequestToken", { method: "POST", body: { consumer_key: c.key, consumer_secret: c.secret } });
  // Tokens last 5 minutes; refresh a little early.
  tokens.set(c.key, { value: j.token, expires: Date.now() + 4 * 60 * 1000 });
  return j.token;
}

async function ipnId(c: PesapalCreds, url: string): Promise<string> {
  const k = c.key + "|" + url;
  const hit = ipnIds.get(k);
  if (hit) return hit;
  const j = await call("/api/URLSetup/RegisterIPN", {
    method: "POST",
    token: await token(c),
    body: { url, ipn_notification_type: "GET" },
  });
  ipnIds.set(k, j.ipn_id);
  return j.ipn_id;
}

export type SubmitResult =
  | { ok: true; trackingId: string; redirectUrl: string | null; mock: boolean }
  | { ok: false; error: string };

export async function submitOrder(opts: {
  creds: PesapalCreds | null;
  merchantRef: string;          // unique per payment, max 50 chars
  amount: number;               // KES, includes tip
  description: string;          // max 100 chars
  callbackUrl: string;          // guest is sent back here after paying
  ipnUrl: string;               // Pesapal notifies us here
  phone?: string | null;        // 2547XXXXXXXX, optional but Pesapal needs a phone or email
  payerName?: string | null;
  onMockComplete: (o: PesapalOutcome) => void;
}): Promise<SubmitResult> {
  if (!opts.creds) {
    const trackingId = `pp_MOCK_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    setTimeout(() => opts.onMockComplete({
      trackingId, success: true, method: "Card (demo)",
      reference: "PPMOCK" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    }), 4000);
    return { ok: true, trackingId, redirectUrl: null, mock: true };
  }
  try {
    const t = await token(opts.creds);
    const notificationId = await ipnId(opts.creds, opts.ipnUrl);
    const j = await call("/api/Transactions/SubmitOrderRequest", {
      method: "POST",
      token: t,
      body: {
        id: opts.merchantRef.slice(0, 50),
        currency: "KES",
        amount: Math.round(opts.amount),
        description: opts.description.slice(0, 100),
        callback_url: opts.callbackUrl,
        notification_id: notificationId,
        billing_address: {
          phone_number: opts.phone || undefined,
          email_address: opts.phone ? undefined : "guest@tablepay.local",
          first_name: (opts.payerName || "Guest").slice(0, 40),
        },
      },
    });
    if (!j.order_tracking_id || !j.redirect_url) return { ok: false, error: "Pesapal did not return a payment page" };
    return { ok: true, trackingId: j.order_tracking_id, redirectUrl: j.redirect_url, mock: false };
  } catch (e: any) {
    return { ok: false, error: e.message || "Could not start the Pesapal payment" };
  }
}

/** Ask Pesapal how a payment ended. Returns null while it is still in progress. */
export async function transactionStatus(creds: PesapalCreds | null, trackingId: string): Promise<PesapalOutcome | null> {
  if (!creds) return null;
  const j = await call(`/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(trackingId)}`, {
    method: "GET",
    token: await token(creds),
  });
  // status_code: 0 invalid, 1 completed, 2 failed, 3 reversed
  const code = Number(j.status_code);
  if (code === 1) return { trackingId, success: true, reference: j.confirmation_code || undefined, method: j.payment_method || undefined };
  if (code === 2 || code === 3) return { trackingId, success: false, reason: j.payment_status_description || j.description || "Payment failed" };
  return null;
}
