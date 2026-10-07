// M-Pesa Daraja STK Push (Lipa Na M-Pesa Online).
// If MPESA_CONSUMER_KEY is not set, runs in MOCK mode: payments auto-complete
// after a few seconds so you can demo the full flow without Safaricom keys.

export type StkResult =
  | { ok: true; checkoutRequestId: string; mock: boolean }
  | { ok: false; error: string };

export type StkCallbackOutcome = {
  checkoutRequestId: string;
  success: boolean;
  receipt?: string;
  reason?: string;
};

const env = process.env;
export const MOCK = !env.MPESA_CONSUMER_KEY;
const BASE =
  env.MPESA_ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";

let cachedToken: { value: string; expires: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now()) return cachedToken.value;
  const auth = Buffer.from(`${env.MPESA_CONSUMER_KEY}:${env.MPESA_CONSUMER_SECRET}`).toString("base64");
  const r = await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!r.ok) throw new Error(`Daraja auth failed: ${r.status}`);
  const j = (await r.json()) as { access_token: string; expires_in: string };
  cachedToken = { value: j.access_token, expires: Date.now() + (Number(j.expires_in) - 60) * 1000 };
  return j.access_token;
}

function timestamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function password(ts: string) {
  return Buffer.from(`${env.MPESA_SHORTCODE}${env.MPESA_PASSKEY}${ts}`).toString("base64");
}

/** Normalise 07xx / 01xx / +2547xx / 2547xx to 2547xxxxxxxx. Returns null if invalid. */
export function normalisePhone(input: string): string | null {
  const digits = String(input || "").replace(/\D/g, "");
  let p = digits;
  if (p.startsWith("0") && p.length === 10) p = "254" + p.slice(1);
  else if ((p.startsWith("7") || p.startsWith("1")) && p.length === 9) p = "254" + p;
  return /^254[17]\d{8}$/.test(p) ? p : null;
}

export async function stkPush(opts: {
  phone: string;
  amount: number;
  accountRef: string;
  description: string;
  onMockComplete: (o: StkCallbackOutcome) => void;
}): Promise<StkResult> {
  if (MOCK) {
    const checkoutRequestId = `ws_MOCK_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    // Test hook: numbers ending in 0000 simulate a cancelled payment.
    const fail = opts.phone.endsWith("0000");
    setTimeout(() => {
      opts.onMockComplete(
        fail
          ? { checkoutRequestId, success: false, reason: "Request cancelled by user" }
          : { checkoutRequestId, success: true, receipt: "MOCK" + Math.random().toString(36).slice(2, 10).toUpperCase() }
      );
    }, 4000);
    return { ok: true, checkoutRequestId, mock: true };
  }

  try {
    const ts = timestamp();
    const body = {
      BusinessShortCode: env.MPESA_SHORTCODE,
      Password: password(ts),
      Timestamp: ts,
      // Paybill: CustomerPayBillOnline. Till (Buy Goods): CustomerBuyGoodsOnline + MPESA_PARTY_B = till number
      TransactionType: env.MPESA_TXN_TYPE || "CustomerPayBillOnline",
      Amount: Math.round(opts.amount),
      PartyA: opts.phone,
      PartyB: env.MPESA_PARTY_B || env.MPESA_SHORTCODE,
      PhoneNumber: opts.phone,
      CallBackURL: `${env.PUBLIC_URL}/api/mpesa/callback/${env.MPESA_CALLBACK_SECRET || "cb"}`,
      AccountReference: opts.accountRef.slice(0, 12),
      TransactionDesc: opts.description.slice(0, 13),
    };
    const r = await fetch(`${BASE}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await r.json()) as any;
    if (j.ResponseCode === "0") return { ok: true, checkoutRequestId: j.CheckoutRequestID, mock: false };
    return { ok: false, error: j.errorMessage || j.ResponseDescription || `STK push failed (${r.status})` };
  } catch (e: any) {
    return { ok: false, error: e.message || "STK push failed" };
  }
}

/** Parse the JSON Safaricom POSTs to the callback URL. */
export function parseCallback(body: any): StkCallbackOutcome | null {
  const cb = body?.Body?.stkCallback;
  if (!cb?.CheckoutRequestID) return null;
  if (Number(cb.ResultCode) !== 0) {
    return { checkoutRequestId: cb.CheckoutRequestID, success: false, reason: cb.ResultDesc };
  }
  const items: { Name: string; Value?: any }[] = cb.CallbackMetadata?.Item || [];
  const receipt = items.find((i) => i.Name === "MpesaReceiptNumber")?.Value;
  return { checkoutRequestId: cb.CheckoutRequestID, success: true, receipt: receipt ? String(receipt) : undefined };
}

/** Fallback when a callback never arrives (it happens): ask Daraja for the status. */
export async function stkQuery(checkoutRequestId: string): Promise<StkCallbackOutcome | null> {
  if (MOCK) return null;
  const ts = timestamp();
  const r = await fetch(`${BASE}/mpesa/stkpushquery/v1/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      BusinessShortCode: env.MPESA_SHORTCODE,
      Password: password(ts),
      Timestamp: ts,
      CheckoutRequestID: checkoutRequestId,
    }),
  });
  const j = (await r.json()) as any;
  if (j.ResultCode === undefined) return null; // still processing
  if (String(j.ResultCode) === "0") return { checkoutRequestId, success: true };
  return { checkoutRequestId, success: false, reason: j.ResultDesc };
}
