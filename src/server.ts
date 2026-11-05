import express, { type NextFunction, type Request, type Response } from "express";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import QRCode from "qrcode";
import { all, get, run, tx } from "./db.js";
import { publish, subscribe } from "./events.js";
import { MOCK, normalisePhone, parseCallback, stkPush, stkQuery, type StkCallbackOutcome } from "./mpesa.js";
import { credsFor, submitOrder, transactionStatus, type PesapalOutcome } from "./pesapal.js";
import { mergeSettings, readSettings, type PayMethod, type VenueSettings } from "./settings.js";
import { seedDemo, token } from "./seed.js";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const SECRET = process.env.APP_SECRET || randomBytes(32).toString("hex");
const CALLBACK_SECRET = process.env.MPESA_CALLBACK_SECRET || "cb";

seedDemo();

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(join(process.cwd(), "public"), { extensions: ["html"] }));

// ---------- helpers ----------
type Restaurant = {
  id: number; slug: string; name: string; branch: string; tagline: string; phone: string; email: string;
  staff_pin: string; admin_pin: string; settings: string | null; pesapal_key: string | null; pesapal_secret: string | null;
};
type Table = { id: number; restaurant_id: number; label: string; code: string; active: number };
type Session = {
  id: number; table_id: number; status: string; receipt_token: string; opened_at: string; closed_at: string | null;
  pay_requested_at: string | null; bill_confirmed_at: string | null; confirmed_total: number | null;
};

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const wrap = (fn: (req: Request, res: Response) => any) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = fn(req, res);
    if (r instanceof Promise) r.catch(next);
  } catch (e) { next(e); }
};

function publicRestaurant(r: Restaurant) {
  const { staff_pin, admin_pin, pesapal_key, pesapal_secret, settings, ...rest } = r;
  return { ...rest, settings: readSettings(settings) };
}

function settingsOf(rid: number): VenueSettings {
  return readSettings(get<{ settings: string | null }>("SELECT settings FROM restaurants WHERE id = ?", rid)?.settings);
}

function tableByCode(codeParam: string | string[]): { table: Table; restaurant: Restaurant } {
  const code = String(codeParam);
  const table = get<Table>("SELECT * FROM dining_tables WHERE code = ? AND active = 1", code);
  if (!table) throw new HttpError(404, "Table not found");
  const restaurant = get<Restaurant>("SELECT * FROM restaurants WHERE id = ?", table.restaurant_id)!;
  return { table, restaurant };
}

function openSession(tableId: number, create: boolean): Session | undefined {
  let s = get<Session>("SELECT * FROM table_sessions WHERE table_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", tableId);
  if (!s && create) {
    const r = run("INSERT INTO table_sessions (table_id, receipt_token) VALUES (?, ?)", tableId, token(12));
    s = get<Session>("SELECT * FROM table_sessions WHERE id = ?", r.lastInsertRowid);
  }
  return s;
}

function menuFor(restaurantId: number) {
  // Sold-out items are included (shown greyed out) so guests know they exist.
  const cats = all("SELECT id, name FROM categories WHERE restaurant_id = ? ORDER BY sort, id", restaurantId);
  const items = all(
    `SELECT id, category_id, name, description, price, tags, available, image_url FROM menu_items
     WHERE restaurant_id = ? AND deleted = 0 ORDER BY sort, id`,
    restaurantId
  );
  return cats.map((c: any) => ({ ...c, items: items.filter((i: any) => i.category_id === c.id) }));
}

function billFor(sessionId: number) {
  const lines = all<{ name: string; unit_price: number; qty: number }>(
    `SELECT oi.name, oi.unit_price, SUM(oi.qty) AS qty FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.session_id = ? AND o.status != 'cancelled'
     GROUP BY oi.name, oi.unit_price ORDER BY MIN(oi.id)`,
    sessionId
  ).map((l) => ({ ...l, total: l.unit_price * l.qty }));
  // Lines staff add when checking against the POS: service charge, discounts, items rung up only in the POS
  const adjustments = all<{ id: number; label: string; amount: number }>(
    "SELECT id, label, amount FROM bill_adjustments WHERE session_id = ? ORDER BY id",
    sessionId
  );
  const itemsTotal = lines.reduce((s, l) => s + l.total, 0);
  const subtotal = Math.max(0, itemsTotal + adjustments.reduce((s, a) => s + a.amount, 0));
  const ses = get<Session>("SELECT * FROM table_sessions WHERE id = ?", sessionId);
  // A confirmation only holds while the total is unchanged: a new order or adjustment re-opens it.
  const confirmed = !!ses?.bill_confirmed_at && ses.confirmed_total === subtotal && subtotal > 0;
  const payments = all(
    `SELECT id, method, amount, tip, payer_label, status, provider_ref, failure_reason, created_at, paid_at,
            CASE WHEN phone IS NULL THEN NULL ELSE substr(phone,1,6) || '***' || substr(phone,-3) END AS phone_masked
     FROM payments WHERE session_id = ? ORDER BY id`,
    sessionId
  );
  const paid = payments.filter((p: any) => p.status === "paid").reduce((s: number, p: any) => s + p.amount, 0);
  const tips = payments.filter((p: any) => p.status === "paid").reduce((s: number, p: any) => s + p.tip, 0);
  const pending = payments.filter((p: any) => p.status === "pending").reduce((s: number, p: any) => s + p.amount, 0);
  const orders = all(
    `SELECT o.id, o.guest_name, o.note, o.status, o.created_at, o.placed_by, o.pos_entered_at,
            json_group_array(json_object('name', oi.name, 'qty', oi.qty, 'unit_price', oi.unit_price)) AS items
     FROM orders o JOIN order_items oi ON oi.order_id = o.id
     WHERE o.session_id = ? GROUP BY o.id ORDER BY o.id`,
    sessionId
  ).map((o: any) => ({ ...o, items: JSON.parse(o.items) }));
  return {
    lines, adjustments, itemsTotal, subtotal, paid, tips, pending, balance: Math.max(0, subtotal - paid), payments, orders,
    confirmed, confirmedAt: confirmed ? ses!.bill_confirmed_at : null, payRequestedAt: ses?.pay_requested_at ?? null,
  };
}

function sessionSummary(sessionId: number) {
  const s = get<Session & { label: string; restaurant_id: number }>(
    `SELECT ts.*, dt.label, dt.restaurant_id, dt.code FROM table_sessions ts
     JOIN dining_tables dt ON dt.id = ts.table_id WHERE ts.id = ?`,
    sessionId
  )!;
  return { session: s, bill: billFor(sessionId) };
}

/** Tell everyone who cares that a tab changed. */
function notifySession(sessionId: number, reason: string) {
  const { session, bill } = sessionSummary(sessionId);
  publish(`session:${sessionId}`, "bill", { reason, bill, status: session.status, receipt_token: session.receipt_token });
  publish(`staff:${session.restaurant_id}`, "change", { reason, sessionId, table: session.label });
}

// ---------- staff auth (stateless signed token) ----------
function sign(payload: object) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${mac}`;
}
function verify(tok: string | undefined): { rid: number; role: "staff" | "admin"; exp: number } | null {
  if (!tok) return null;
  const [body, mac] = tok.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", SECRET).update(body).digest("base64url");
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const p = JSON.parse(Buffer.from(body, "base64url").toString());
  return p.exp > Date.now() ? p : null;
}
function requireStaff(role: "staff" | "admin" = "staff") {
  return (req: Request, res: Response, next: NextFunction) => {
    const tok = (req.headers["x-staff-token"] as string) || (req.query.token as string);
    const p = verify(tok);
    if (!p || (role === "admin" && p.role !== "admin")) return res.status(401).json({ error: "Please sign in again" });
    (req as any).rid = p.rid;
    (req as any).role = p.role;
    next();
  };
}
const ridOf = (req: Request) => (req as any).rid as number;

function sessionForStaff(req: Request): Session & { restaurant_id: number } {
  const s = get<Session & { restaurant_id: number }>(
    `SELECT ts.*, dt.restaurant_id FROM table_sessions ts JOIN dining_tables dt ON dt.id = ts.table_id WHERE ts.id = ?`,
    Number(req.params.id)
  );
  if (!s || s.restaurant_id !== ridOf(req)) throw new HttpError(404, "Tab not found");
  return s;
}

// ---------- payments ----------
function applyOutcome(o: StkCallbackOutcome) {
  const p = get<{ id: number; session_id: number; status: string }>(
    "SELECT id, session_id, status FROM payments WHERE checkout_request_id = ?",
    o.checkoutRequestId
  );
  if (!p || p.status !== "pending") return;
  if (o.success) {
    run("UPDATE payments SET status='paid', provider_ref=?, paid_at=datetime('now') WHERE id=?", o.receipt ?? null, p.id);
  } else {
    run("UPDATE payments SET status='failed', failure_reason=? WHERE id=?", o.reason ?? "Failed", p.id);
  }
  notifySession(p.session_id, o.success ? "payment_paid" : "payment_failed");
}

function applyPesapal(o: PesapalOutcome) {
  const p = get<{ id: number; session_id: number; status: string }>(
    "SELECT id, session_id, status FROM payments WHERE provider_tracking_id = ? AND method = 'pesapal'",
    o.trackingId
  );
  if (!p || p.status !== "pending") return;
  if (o.success) {
    run("UPDATE payments SET status='paid', provider_ref=?, paid_at=datetime('now') WHERE id=?",
      [o.reference, o.method].filter(Boolean).join(" · ") || null, p.id);
  } else {
    run("UPDATE payments SET status='failed', failure_reason=? WHERE id=?", o.reason ?? "Failed", p.id);
  }
  notifySession(p.session_id, o.success ? "payment_paid" : "payment_failed");
}

/** Pesapal keys for the venue a payment belongs to. */
function pesapalCredsForPayment(paymentId: number) {
  const r = get<Restaurant>(
    `SELECT r.* FROM payments p JOIN table_sessions ts ON ts.id = p.session_id
     JOIN dining_tables dt ON dt.id = ts.table_id JOIN restaurants r ON r.id = dt.restaurant_id WHERE p.id = ?`,
    paymentId
  );
  return r ? credsFor(r) : null;
}

async function checkPesapal(paymentId: number, trackingId: string) {
  const creds = pesapalCredsForPayment(paymentId);
  if (!creds) return; // mock payments finish by themselves
  const o = await transactionStatus(creds, trackingId);
  if (o) applyPesapal(o);
}

// Privacy safety net: a fully paid tab that has gone quiet closes itself, so the next party at that
// table starts a fresh bill even if staff forget to press "Close table". Empty tabs (someone only
// looked at the menu) are tidied up after a few hours.
const AUTO_CLOSE_MIN = Math.max(1, Number(process.env.AUTO_CLOSE_MINUTES || 15));
setInterval(() => {
  const open = all<{ id: number; idle_min: number; orders: number; paid: number }>(
    `SELECT ts.id,
       (julianday('now') - julianday(MAX(ts.opened_at,
          COALESCE((SELECT MAX(created_at) FROM orders WHERE session_id = ts.id), ts.opened_at),
          COALESCE((SELECT MAX(COALESCE(paid_at, created_at)) FROM payments WHERE session_id = ts.id), ts.opened_at),
          COALESCE((SELECT MAX(created_at) FROM service_requests WHERE session_id = ts.id), ts.opened_at)))) * 1440 AS idle_min,
       (SELECT COUNT(*) FROM orders WHERE session_id = ts.id AND status != 'cancelled') AS orders,
       (SELECT COUNT(*) FROM payments WHERE session_id = ts.id AND status = 'paid') AS paid
     FROM table_sessions ts WHERE ts.status = 'open'`
  );
  for (const s of open) {
    if (!s.orders && !s.paid) { if (s.idle_min > 180) closeSession(s.id); continue; }
    const b = billFor(s.id);
    if (b.subtotal > 0 && b.balance === 0 && b.pending === 0 && s.idle_min >= AUTO_CLOSE_MIN) closeSession(s.id);
  }
}, 60000);

// Callbacks sometimes never arrive. Sweep stale pending payments.
setInterval(async () => {
  const stale = all<{ checkout_request_id: string; age: number }>(
    `SELECT checkout_request_id, (julianday('now') - julianday(created_at)) * 86400 AS age
     FROM payments WHERE status='pending' AND method='mpesa' AND created_at < datetime('now','-45 seconds')`
  );
  for (const s of stale) {
    try {
      const r = await stkQuery(s.checkout_request_id);
      if (r) applyOutcome(r);
      else if (s.age > 180) applyOutcome({ checkoutRequestId: s.checkout_request_id, success: false, reason: "Timed out" });
    } catch {
      if (s.age > 180) applyOutcome({ checkoutRequestId: s.checkout_request_id, success: false, reason: "Timed out" });
    }
  }
  // Pesapal: guests can take a while on the card page, so check for longer before timing out.
  const pp = all<{ id: number; provider_tracking_id: string | null; age: number }>(
    `SELECT id, provider_tracking_id, (julianday('now') - julianday(created_at)) * 86400 AS age
     FROM payments WHERE status='pending' AND method='pesapal' AND created_at < datetime('now','-60 seconds')`
  );
  for (const p of pp) {
    if (!p.provider_tracking_id) {
      if (p.age > 120) run("UPDATE payments SET status='failed', failure_reason='Not started' WHERE id=?", p.id);
      continue;
    }
    try { await checkPesapal(p.id, p.provider_tracking_id); } catch {}
    if (p.age > 1800) applyPesapal({ trackingId: p.provider_tracking_id, success: false, reason: "Timed out" });
  }
}, 20000);

// ================= GUEST API =================
app.get("/api/meta", (_req, res) => res.json({ mockPayments: MOCK }));

// Demo launcher data (only in mock mode, so a live install never lists its table links publicly)
app.get("/api/demo", (_req, res) => {
  if (!MOCK) return res.status(404).json({ error: "Not available" });
  const r = get<Restaurant>("SELECT * FROM restaurants ORDER BY id LIMIT 1")!;
  res.json({
    restaurant: r.name,
    tables: all("SELECT label, code FROM dining_tables WHERE restaurant_id=? AND active=1 ORDER BY id LIMIT 6", r.id),
  });
});

app.get("/api/t/:code", wrap((req, res) => {
  const { table, restaurant } = tableByCode(req.params.code);
  const session = openSession(table.id, true)!;
  res.json({
    restaurant: publicRestaurant(restaurant),
    table: { label: table.label, code: table.code },
    session: { id: session.id, receipt_token: session.receipt_token },
    menu: menuFor(restaurant.id),
    bill: billFor(session.id),
    mockPayments: MOCK,
    pesapalMock: !credsFor(restaurant),
  });
}));

app.get("/api/t/:code/bill", wrap((req, res) => {
  const { table } = tableByCode(req.params.code);
  const session = openSession(table.id, true)!;
  res.json({ session: { id: session.id, receipt_token: session.receipt_token }, bill: billFor(session.id) });
}));

app.get("/api/t/:code/events", wrap((req, res) => {
  const { table } = tableByCode(req.params.code);
  const session = openSession(table.id, true)!;
  subscribe(`session:${session.id}`, res);
}));

function placeOrder(table: Table, restaurant: Restaurant, body: any, placedBy: "guest" | "staff") {
  const settings = readSettings(restaurant.settings);
  if (settings.ordering === "off") throw new HttpError(403, "Ordering is switched off for this venue");
  if (placedBy === "guest" && settings.ordering !== "guest") throw new HttpError(403, "Please order with your waiter");
  const items: { id: number; qty: number }[] = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) throw new HttpError(400, "The order is empty");
  const guestName = String(body?.guestName || "").trim().slice(0, 40) || null;
  const note = String(body?.note || "").trim().slice(0, 200) || null;

  const session = openSession(table.id, true)!;
  const orderId = tx(() => {
    const o = run("INSERT INTO orders (session_id, guest_name, note, placed_by) VALUES (?,?,?,?)", session.id, guestName, note, placedBy);
    const oid = Number(o.lastInsertRowid);
    for (const it of items) {
      const qty = Math.max(1, Math.min(50, Math.floor(Number(it.qty) || 0)));
      const m = get<{ id: number; name: string; price: number; available: number }>(
        "SELECT id, name, price, available FROM menu_items WHERE id = ? AND restaurant_id = ?",
        Number(it.id), restaurant.id
      );
      if (!m) throw new HttpError(400, "An item on your order is no longer on the menu");
      if (!m.available) throw new HttpError(409, `${m.name} is sold out`);
      run("INSERT INTO order_items (order_id, menu_item_id, name, unit_price, qty) VALUES (?,?,?,?,?)", oid, m.id, m.name, m.price, qty);
    }
    return oid;
  });
  notifySession(session.id, "order_placed");
  if (placedBy === "guest") publish(`staff:${restaurant.id}`, "alert", { kind: "order", table: table.label, orderId });
  return orderId;
}

app.post("/api/t/:code/orders", wrap((req, res) => {
  const { table, restaurant } = tableByCode(req.params.code);
  res.json({ ok: true, orderId: placeOrder(table, restaurant, req.body, "guest") });
}));

app.post("/api/t/:code/requests", wrap((req, res) => {
  const { table, restaurant } = tableByCode(req.params.code);
  if (!readSettings(restaurant.settings).waiterCalls) throw new HttpError(403, "Please ask a member of staff");
  const KINDS = ["waiter", "bill", "water", "other"];
  const kind = KINDS.includes(req.body?.kind) ? req.body.kind : "waiter";
  const note = String(req.body?.note || "").trim().slice(0, 140) || null;
  if (kind === "other" && !note) throw new HttpError(400, "Write a short note for the team");
  const session = openSession(table.id, true)!;
  // Don't stack duplicate open requests (notes are always sent)
  const existing = kind === "other"
    ? undefined
    : get("SELECT id FROM service_requests WHERE session_id=? AND kind=? AND status != 'done'", session.id, kind);
  if (!existing) run("INSERT INTO service_requests (session_id, kind, note) VALUES (?,?,?)", session.id, kind, note);
  publish(`staff:${restaurant.id}`, "alert", { kind, table: table.label, note });
  notifySession(session.id, "request");
  res.json({ ok: true, alreadyRequested: !!existing });
}));

app.get("/api/t/:code/requests", wrap((req, res) => {
  const { table } = tableByCode(req.params.code);
  const session = openSession(table.id, true)!;
  res.json(all(
    "SELECT id, kind, status, note, created_at, acknowledged_at FROM service_requests WHERE session_id=? AND status != 'done' ORDER BY id",
    session.id
  ));
}));

// Guest changed their mind
app.post("/api/t/:code/requests/:id/cancel", wrap((req, res) => {
  const { table } = tableByCode(req.params.code);
  const session = openSession(table.id, false);
  if (!session) throw new HttpError(409, "This tab is already closed");
  const r = run(
    "UPDATE service_requests SET status='done', done_at=datetime('now') WHERE id=? AND session_id=? AND status != 'done'",
    Number(req.params.id), session.id
  );
  if (!r.changes) throw new HttpError(404, "Request not found");
  notifySession(session.id, "request_cancelled");
  res.json({ ok: true });
}));

// Guests tell staff they are ready to pay. With "confirm bill" on, staff check the total against
// their POS (adding service charge, discounts or items rung up only in the POS) before anyone can pay.
app.post("/api/t/:code/ready", wrap((req, res) => {
  const { table, restaurant } = tableByCode(req.params.code);
  const settings = readSettings(restaurant.settings);
  if (!settings.payAtTable) throw new HttpError(403, "Please pay with your waiter");
  const session = openSession(table.id, false);
  if (!session) throw new HttpError(409, "This tab is already closed");
  const bill = billFor(session.id);
  if (bill.confirmed || !settings.confirmBill) return res.json({ ok: true, confirmed: true });
  if (bill.subtotal <= 0) throw new HttpError(400, "There is nothing on the bill yet");
  run("UPDATE table_sessions SET pay_requested_at = datetime('now') WHERE id = ?", session.id);
  const open = get("SELECT id FROM service_requests WHERE session_id=? AND kind='pay' AND status != 'done'", session.id);
  if (!open) run("INSERT INTO service_requests (session_id, kind) VALUES (?, 'pay')", session.id);
  publish(`staff:${restaurant.id}`, "alert", { kind: "pay", table: table.label, total: bill.subtotal });
  notifySession(session.id, "pay_requested");
  res.json({ ok: true, confirmed: false, alreadyRequested: !!open });
}));

app.post("/api/t/:code/pay", wrap(async (req, res) => {
  const { table, restaurant } = tableByCode(req.params.code);
  const settings = readSettings(restaurant.settings);
  if (!settings.payAtTable) throw new HttpError(403, "Please pay with your waiter");
  const method = (["mpesa", "pesapal", "card", "cash"].includes(req.body?.method) ? req.body.method : "mpesa") as PayMethod;
  if (!settings.payMethods[method]) throw new HttpError(400, "That way of paying isn't available here");
  const session = openSession(table.id, false);
  if (!session) throw new HttpError(409, "This tab is already closed");
  const amount = Math.floor(Number(req.body?.amount) || 0);
  const tip = Math.max(0, Math.floor(Number(req.body?.tip) || 0));
  const bill = billFor(session.id);
  if (settings.confirmBill && !bill.confirmed) {
    throw new HttpError(409, "Your waiter is checking the bill. You can pay as soon as they confirm it.");
  }
  const available = bill.balance - bill.pending;
  if (amount < 1) throw new HttpError(400, "Enter an amount to pay");
  if (amount > available) {
    throw new HttpError(409, bill.pending > 0
      ? `Another payment of KES ${bill.pending.toLocaleString()} is in progress. You can pay up to KES ${available.toLocaleString()}.`
      : `The balance is KES ${bill.balance.toLocaleString()}`);
  }
  const payerLabel = String(req.body?.payerLabel || "").trim().slice(0, 40) || null;
  const phone = req.body?.phone ? normalisePhone(req.body.phone) : null;

  // Card machine or cash: the guest picks their share here, a waiter brings the machine (or takes the cash)
  // and marks it paid on the board. Works with any bank's card machine, Pesapal's included.
  if (method === "card" || method === "cash") {
    const r = run(
      "INSERT INTO payments (session_id, method, amount, tip, payer_label, requested_by_guest) VALUES (?, ?, ?, ?, ?, 1)",
      session.id, method, amount, tip, payerLabel
    );
    const paymentId = Number(r.lastInsertRowid);
    publish(`staff:${restaurant.id}`, "alert", { kind: method, table: table.label, amount: amount + tip, payer: payerLabel });
    notifySession(session.id, "payment_started");
    return res.json({ ok: true, paymentId, staffAssisted: true });
  }

  if (method === "pesapal") {
    const r = run(
      "INSERT INTO payments (session_id, method, amount, tip, phone, payer_label) VALUES (?, 'pesapal', ?, ?, ?, ?)",
      session.id, amount, tip, phone, payerLabel
    );
    const paymentId = Number(r.lastInsertRowid);
    const out = await submitOrder({
      creds: credsFor(restaurant),
      merchantRef: `TP${paymentId}-${token(6)}`,
      amount: amount + tip,
      description: `${restaurant.name} · ${table.label}`,
      callbackUrl: `${PUBLIC_URL}/t/${table.code}?pesapal=${paymentId}`,
      ipnUrl: `${PUBLIC_URL}/api/pesapal/ipn`,
      phone,
      payerName: payerLabel,
      onMockComplete: applyPesapal,
    });
    if (!out.ok) {
      run("UPDATE payments SET status='failed', failure_reason=? WHERE id=?", out.error, paymentId);
      notifySession(session.id, "payment_failed");
      throw new HttpError(502, out.error);
    }
    run("UPDATE payments SET provider_tracking_id=? WHERE id=?", out.trackingId, paymentId);
    notifySession(session.id, "payment_started");
    return res.json({ ok: true, paymentId, redirectUrl: out.redirectUrl, mock: out.mock });
  }

  if (!phone) throw new HttpError(400, "Enter a valid Safaricom number, e.g. 0712 345 678");
  const r = run(
    "INSERT INTO payments (session_id, method, amount, tip, phone, payer_label) VALUES (?, 'mpesa', ?, ?, ?, ?)",
    session.id, amount, tip, phone, payerLabel
  );
  const paymentId = Number(r.lastInsertRowid);
  const push = await stkPush({
    phone,
    amount: amount + tip,
    accountRef: `${table.label}`.replace(/\s/g, "") + session.id,
    description: restaurant.name,
    onMockComplete: applyOutcome,
  });
  if (!push.ok) {
    run("UPDATE payments SET status='failed', failure_reason=? WHERE id=?", push.error, paymentId);
    notifySession(session.id, "payment_failed");
    throw new HttpError(502, push.error);
  }
  run("UPDATE payments SET checkout_request_id=? WHERE id=?", push.checkoutRequestId, paymentId);
  notifySession(session.id, "payment_started");
  res.json({ ok: true, paymentId, mock: push.mock });
}));

app.get("/api/t/:code/payments/:pid", wrap(async (req, res) => {
  const { table } = tableByCode(req.params.code);
  const q = () => get<any>(
    `SELECT p.id, p.method, p.status, p.amount, p.tip, p.provider_ref, p.failure_reason, p.provider_tracking_id FROM payments p
     JOIN table_sessions ts ON ts.id = p.session_id WHERE p.id = ? AND ts.table_id = ?`,
    Number(req.params.pid), table.id
  );
  let p = q();
  if (!p) throw new HttpError(404, "Payment not found");
  // Guest just came back from Pesapal's page: ask Pesapal straight away instead of waiting for the IPN.
  if (p.method === "pesapal" && p.status === "pending" && p.provider_tracking_id) {
    try { await checkPesapal(p.id, p.provider_tracking_id); p = q(); } catch {}
  }
  const { provider_tracking_id, ...out } = p;
  res.json(out);
}));

// Guest changed their mind about paying by card machine or cash
app.post("/api/t/:code/payments/:pid/cancel", wrap((req, res) => {
  const { table } = tableByCode(req.params.code);
  const p = get<{ id: number; session_id: number }>(
    `SELECT p.id, p.session_id FROM payments p JOIN table_sessions ts ON ts.id = p.session_id
     WHERE p.id = ? AND ts.table_id = ? AND p.status = 'pending' AND p.requested_by_guest = 1`,
    Number(req.params.pid), table.id
  );
  if (!p) throw new HttpError(404, "Nothing to cancel");
  run("UPDATE payments SET status='failed', failure_reason='Cancelled by guest' WHERE id=?", p.id);
  notifySession(p.session_id, "payment_failed");
  res.json({ ok: true });
}));

// Pesapal instant payment notification (registered as GET). Always confirm with GetTransactionStatus.
async function pesapalIpn(req: Request, res: Response) {
  const q: any = req.method === "GET" ? req.query : req.body || {};
  const trackingId = String(q.OrderTrackingId || q.orderTrackingId || "");
  const merchantRef = String(q.OrderMerchantReference || q.orderMerchantReference || "");
  const type = String(q.OrderNotificationType || q.orderNotificationType || "IPNCHANGE");
  let status = 500;
  const p = trackingId ? get<{ id: number }>("SELECT id FROM payments WHERE provider_tracking_id = ? AND method='pesapal'", trackingId) : undefined;
  if (p) {
    try { await checkPesapal(p.id, trackingId); status = 200; } catch { status = 500; }
  }
  res.json({ orderNotificationType: type, orderTrackingId: trackingId, orderMerchantReference: merchantRef, status });
}
app.get("/api/pesapal/ipn", wrap(pesapalIpn));
app.post("/api/pesapal/ipn", wrap(pesapalIpn));

// M-Pesa callback (Safaricom POSTs here). Secret path segment keeps randoms out.
app.post("/api/mpesa/callback/:secret", (req, res) => {
  if (req.params.secret !== CALLBACK_SECRET) return res.status(404).end();
  const outcome = parseCallback(req.body);
  if (outcome) applyOutcome(outcome);
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

// ================= RECEIPT =================
app.get("/api/receipt/:token", wrap((req, res) => {
  const s = get<Session & { label: string; restaurant_id: number }>(
    `SELECT ts.*, dt.label, dt.restaurant_id FROM table_sessions ts JOIN dining_tables dt ON dt.id = ts.table_id
     WHERE ts.receipt_token = ?`,
    req.params.token
  );
  if (!s) throw new HttpError(404, "Receipt not found");
  const restaurant = get<Restaurant>("SELECT * FROM restaurants WHERE id = ?", s.restaurant_id)!;
  const bill = billFor(s.id);
  res.json({
    restaurant: publicRestaurant(restaurant),
    table: s.label,
    number: `R${String(s.id).padStart(5, "0")}`,
    opened_at: s.opened_at,
    closed_at: s.closed_at,
    status: s.status,
    lines: [...bill.lines, ...bill.adjustments.map((a) => ({ name: a.label, qty: 1, unit_price: a.amount, total: a.amount }))],
    subtotal: bill.subtotal,
    paid: bill.paid,
    tips: bill.tips,
    balance: bill.balance,
    payments: bill.payments.filter((p: any) => p.status === "paid"),
  });
}));

// ================= STAFF API =================
app.post("/api/staff/login", wrap((req, res) => {
  const slug = String(req.body?.slug || "");
  const pin = String(req.body?.pin || "");
  const r = slug
    ? get<Restaurant>("SELECT * FROM restaurants WHERE slug = ?", slug)
    : get<Restaurant>("SELECT * FROM restaurants ORDER BY id LIMIT 1");
  if (!r) throw new HttpError(404, "Restaurant not found");
  const role = pin === r.admin_pin ? "admin" : pin === r.staff_pin ? "staff" : null;
  if (!role) throw new HttpError(401, "Wrong PIN");
  const tokenStr = sign({ rid: r.id, role, exp: Date.now() + 16 * 3600 * 1000 });
  res.json({ token: tokenStr, role, restaurant: publicRestaurant(r) });
}));

app.get("/api/staff/events", requireStaff(), (req, res) => subscribe(`staff:${ridOf(req)}`, res));

app.get("/api/staff/board", requireStaff(), wrap((req, res) => {
  const rid = ridOf(req);
  const requests = all(
    `SELECT sr.id, sr.kind, sr.status, sr.note, sr.created_at, dt.label AS table_label, ts.id AS session_id
     FROM service_requests sr JOIN table_sessions ts ON ts.id = sr.session_id
     JOIN dining_tables dt ON dt.id = ts.table_id
     WHERE dt.restaurant_id = ? AND sr.status != 'done' ORDER BY sr.id`,
    rid
  );
  const orders = all(
    `SELECT o.id, o.status, o.guest_name, o.note, o.created_at, o.placed_by, o.pos_entered_at,
            dt.label AS table_label, ts.id AS session_id,
            (julianday('now') - julianday(o.created_at)) * 1440 AS age_min,
            json_group_array(json_object('name', oi.name, 'qty', oi.qty)) AS items
     FROM orders o JOIN order_items oi ON oi.order_id = o.id
     JOIN table_sessions ts ON ts.id = o.session_id JOIN dining_tables dt ON dt.id = ts.table_id
     WHERE dt.restaurant_id = ? AND o.status IN ('new','preparing') AND ts.status = 'open' GROUP BY o.id ORDER BY o.id`,
    rid
  ).map((o: any) => ({ ...o, items: JSON.parse(o.items) }));
  const tabs = all<{ id: number; label: string; opened_at: string }>(
    `SELECT ts.id, dt.label, ts.opened_at FROM table_sessions ts JOIN dining_tables dt ON dt.id = ts.table_id
     WHERE dt.restaurant_id = ? AND ts.status = 'open' ORDER BY dt.id`,
    rid
  ).map((t) => {
    const b = billFor(t.id);
    return {
      ...t, subtotal: b.subtotal, paid: b.paid, balance: b.balance, pending: b.pending, orders: b.orders.length,
      confirmed: b.confirmed, payRequested: !!b.payRequestedAt && !b.confirmed,
    };
  }).filter((t) => t.orders > 0 || t.paid > 0 || t.subtotal > 0); // hide tabs where someone only scanned
  // Guests who chose to pay their share by card machine or cash: a waiter needs to go to the table
  const assists = all(
    `SELECT p.id, p.method, p.amount, p.tip, p.payer_label, p.created_at, dt.label AS table_label, ts.id AS session_id
     FROM payments p JOIN table_sessions ts ON ts.id = p.session_id JOIN dining_tables dt ON dt.id = ts.table_id
     WHERE dt.restaurant_id = ? AND p.status = 'pending' AND p.requested_by_guest = 1 ORDER BY p.id`,
    rid
  );
  const today = get(
    `SELECT COALESCE(SUM(p.amount),0) AS sales, COALESCE(SUM(p.tip),0) AS tips,
            COALESCE(SUM(CASE WHEN p.method='mpesa' THEN p.amount END),0) AS mpesa,
            COALESCE(SUM(CASE WHEN p.method='pesapal' THEN p.amount END),0) AS pesapal,
            COALESCE(SUM(CASE WHEN p.method='card' THEN p.amount END),0) AS card,
            COALESCE(SUM(CASE WHEN p.method='cash' THEN p.amount END),0) AS cash,
            COUNT(*) AS count
     FROM payments p JOIN table_sessions ts ON ts.id = p.session_id JOIN dining_tables dt ON dt.id = ts.table_id
     WHERE dt.restaurant_id = ? AND p.status='paid' AND date(p.paid_at) = date('now')`,
    rid
  );
  // Attach the bill total to "ready to pay" requests so the board can show it
  for (const r of requests as any[]) if (r.kind === "pay") r.total = billFor(r.session_id).subtotal;
  res.json({ requests, orders, tabs, assists, today, settings: settingsOf(rid) });
}));

app.post("/api/staff/requests/:id", requireStaff(), wrap((req, res) => {
  const status = req.body?.status === "acknowledged" ? "acknowledged" : "done";
  const r = get<{ session_id: number; restaurant_id: number }>(
    `SELECT sr.session_id, dt.restaurant_id FROM service_requests sr JOIN table_sessions ts ON ts.id = sr.session_id
     JOIN dining_tables dt ON dt.id = ts.table_id WHERE sr.id = ?`,
    Number(req.params.id)
  );
  if (!r || r.restaurant_id !== ridOf(req)) throw new HttpError(404, "Request not found");
  run(
    `UPDATE service_requests SET status=?, ${status === "done" ? "done_at" : "acknowledged_at"}=datetime('now') WHERE id=?`,
    status, Number(req.params.id)
  );
  notifySession(r.session_id, "request_" + status);
  res.json({ ok: true });
}));

app.post("/api/staff/orders/:id", requireStaff(), wrap((req, res) => {
  const allowed = ["preparing", "served", "cancelled"];
  const status = String(req.body?.status);
  if (!allowed.includes(status)) throw new HttpError(400, "Bad status");
  const o = get<{ session_id: number; restaurant_id: number }>(
    `SELECT o.session_id, dt.restaurant_id FROM orders o JOIN table_sessions ts ON ts.id = o.session_id
     JOIN dining_tables dt ON dt.id = ts.table_id WHERE o.id = ?`,
    Number(req.params.id)
  );
  if (!o || o.restaurant_id !== ridOf(req)) throw new HttpError(404, "Order not found");
  run("UPDATE orders SET status=? WHERE id=?", status, Number(req.params.id));
  notifySession(o.session_id, "order_" + status);
  res.json({ ok: true });
}));

// Staff have keyed this order into the venue's own POS. The guest sees "Accepted".
app.post("/api/staff/orders/:id/entered", requireStaff(), wrap((req, res) => {
  const o = get<{ session_id: number; restaurant_id: number; status: string }>(
    `SELECT o.session_id, o.status, dt.restaurant_id FROM orders o JOIN table_sessions ts ON ts.id = o.session_id
     JOIN dining_tables dt ON dt.id = ts.table_id WHERE o.id = ?`,
    Number(req.params.id)
  );
  if (!o || o.restaurant_id !== ridOf(req)) throw new HttpError(404, "Order not found");
  run(
    `UPDATE orders SET pos_entered_at = COALESCE(pos_entered_at, datetime('now')),
       status = CASE WHEN status = 'new' THEN 'preparing' ELSE status END WHERE id = ?`,
    Number(req.params.id)
  );
  notifySession(o.session_id, "order_accepted");
  res.json({ ok: true });
}));

// Bill check against the POS: add a line (service charge, discount, item rung up only in the POS)
app.post("/api/staff/sessions/:id/adjustments", requireStaff(), wrap((req, res) => {
  const s = sessionForStaff(req);
  if (s.status !== "open") throw new HttpError(409, "This bill is closed");
  const label = String(req.body?.label || "").trim().slice(0, 60);
  const amount = Math.trunc(Number(req.body?.amount) || 0);
  if (!label) throw new HttpError(400, "Say what the line is for, e.g. Service charge");
  if (!amount) throw new HttpError(400, "Enter an amount (use a minus sign for a discount)");
  const bill = billFor(s.id);
  if (bill.subtotal + amount < bill.paid) throw new HttpError(400, "That would make the bill less than what's already paid");
  run("INSERT INTO bill_adjustments (session_id, label, amount) VALUES (?,?,?)", s.id, label, amount);
  notifySession(s.id, "bill_adjusted");
  res.json({ ok: true });
}));

app.delete("/api/staff/sessions/:id/adjustments/:aid", requireStaff(), wrap((req, res) => {
  const s = sessionForStaff(req);
  const a = get<{ amount: number }>("SELECT amount FROM bill_adjustments WHERE id=? AND session_id=?", Number(req.params.aid), s.id);
  if (!a) throw new HttpError(404, "Line not found");
  const bill = billFor(s.id);
  if (bill.subtotal - a.amount < bill.paid) throw new HttpError(400, "That would make the bill less than what's already paid");
  run("DELETE FROM bill_adjustments WHERE id=?", Number(req.params.aid));
  notifySession(s.id, "bill_adjusted");
  res.json({ ok: true });
}));

// Waiter has checked the total against the POS. Guests can now split and pay this exact amount.
app.post("/api/staff/sessions/:id/confirm", requireStaff(), wrap((req, res) => {
  const s = sessionForStaff(req);
  if (s.status !== "open") throw new HttpError(409, "This bill is closed");
  const bill = billFor(s.id);
  if (bill.subtotal <= 0) throw new HttpError(400, "There is nothing on the bill to confirm");
  const expected = req.body?.total !== undefined ? Math.floor(Number(req.body.total)) : bill.subtotal;
  if (expected !== bill.subtotal) throw new HttpError(409, "The bill changed while you were checking it. Please look again.");
  run("UPDATE table_sessions SET bill_confirmed_at = datetime('now'), confirmed_total = ? WHERE id = ?", bill.subtotal, s.id);
  run("UPDATE service_requests SET status='done', done_at=datetime('now') WHERE session_id=? AND kind='pay' AND status!='done'", s.id);
  notifySession(s.id, "bill_confirmed");
  res.json({ ok: true, total: bill.subtotal });
}));

// A guest asked to pay their share by card machine or cash: the waiter marks how it went.
app.post("/api/staff/payments/:pid", requireStaff(), wrap((req, res) => {
  const p = get<{ id: number; session_id: number; restaurant_id: number }>(
    `SELECT p.id, p.session_id, dt.restaurant_id FROM payments p JOIN table_sessions ts ON ts.id = p.session_id
     JOIN dining_tables dt ON dt.id = ts.table_id WHERE p.id = ? AND p.status = 'pending' AND p.requested_by_guest = 1`,
    Number(req.params.pid)
  );
  if (!p || p.restaurant_id !== ridOf(req)) throw new HttpError(404, "Payment not found");
  if (req.body?.result === "paid") {
    const ref = String(req.body?.reference || "").trim().slice(0, 40) || null;
    run("UPDATE payments SET status='paid', provider_ref=?, paid_at=datetime('now') WHERE id=?", ref, p.id);
    notifySession(p.session_id, "payment_paid");
  } else {
    run("UPDATE payments SET status='failed', failure_reason='Not completed at the table' WHERE id=?", p.id);
    notifySession(p.session_id, "payment_failed");
  }
  res.json({ ok: true });
}));

app.get("/api/staff/sessions/:id", requireStaff(), wrap((req, res) => {
  const s = sessionForStaff(req);
  res.json(sessionSummary(s.id));
}));

app.post("/api/staff/sessions/:id/cash", requireStaff(), wrap((req, res) => {
  const s = sessionForStaff(req);
  const method = req.body?.method === "card" ? "card" : "cash";
  const amount = Math.floor(Number(req.body?.amount) || 0);
  const bill = billFor(s.id);
  if (amount < 1 || amount > bill.balance) throw new HttpError(400, `Amount must be between 1 and ${bill.balance}`);
  run(
    "INSERT INTO payments (session_id, method, amount, status, payer_label, paid_at) VALUES (?,?,?,'paid',?,datetime('now'))",
    s.id, method, amount, `Recorded by staff`
  );
  notifySession(s.id, "payment_paid");
  res.json({ ok: true });
}));

function closeSession(id: number, reason = "closed") {
  run("UPDATE table_sessions SET status='closed', closed_at=datetime('now') WHERE id=? AND status='open'", id);
  run("UPDATE service_requests SET status='done', done_at=datetime('now') WHERE session_id=? AND status!='done'", id);
  run("UPDATE payments SET status='failed', failure_reason='Table closed' WHERE session_id=? AND status='pending' AND requested_by_guest=1", id);
  notifySession(id, reason);
}

app.post("/api/staff/sessions/:id/close", requireStaff(), wrap((req, res) => {
  const s = sessionForStaff(req);
  const bill = billFor(s.id);
  if (bill.balance > 0 && !req.body?.force) throw new HttpError(409, `KES ${bill.balance.toLocaleString()} is still unpaid`);
  closeSession(s.id);
  res.json({ ok: true, receipt: `${PUBLIC_URL}/r/${s.receipt_token}` });
}));

// Waiter enters an order for a table (guests without phones, or ordering verbally)
app.get("/api/staff/tables", requireStaff(), wrap((req, res) => {
  const tables = all<Table>("SELECT * FROM dining_tables WHERE restaurant_id=? AND active=1 ORDER BY id", ridOf(req));
  res.json(tables.map((t) => {
    const s = openSession(t.id, false);
    const b = s ? billFor(s.id) : null;
    return { id: t.id, label: t.label, sessionId: s?.id ?? null, subtotal: b?.subtotal ?? 0, balance: b?.balance ?? 0 };
  }));
}));

app.post("/api/staff/tables/:id/orders", requireStaff(), wrap((req, res) => {
  const table = get<Table>("SELECT * FROM dining_tables WHERE id=? AND restaurant_id=? AND active=1", Number(req.params.id), ridOf(req));
  if (!table) throw new HttpError(404, "Table not found");
  const restaurant = get<Restaurant>("SELECT * FROM restaurants WHERE id=?", table.restaurant_id)!;
  const orderId = placeOrder(table, restaurant, req.body, "staff");
  res.json({ ok: true, orderId });
}));

// ================= ADMIN API =================
app.get("/api/admin/menu", requireStaff(), wrap((req, res) => {
  res.json(menuFor(ridOf(req)));
}));

app.get("/api/admin/settings", requireStaff(), wrap((req, res) => {
  const r = get<Restaurant>("SELECT * FROM restaurants WHERE id=?", ridOf(req))!;
  res.json({
    settings: readSettings(r.settings),
    pesapal: {
      ownKeys: !!(r.pesapal_key && r.pesapal_secret),
      keyHint: r.pesapal_key ? r.pesapal_key.slice(0, 4) + "…" + r.pesapal_key.slice(-3) : null,
      live: !!credsFor(r),
      environment: process.env.PESAPAL_ENV === "live" ? "live" : "sandbox",
    },
  });
}));

app.patch("/api/admin/settings", requireStaff("admin"), wrap((req, res) => {
  const rid = ridOf(req);
  const r = get<Restaurant>("SELECT * FROM restaurants WHERE id=?", rid)!;
  let next: VenueSettings;
  try { next = mergeSettings(readSettings(r.settings), req.body?.settings || {}); }
  catch (e: any) { throw new HttpError(400, e.message); }
  run("UPDATE restaurants SET settings=? WHERE id=?", JSON.stringify(next), rid);
  const pk = req.body?.pesapal;
  if (pk && pk.clear) run("UPDATE restaurants SET pesapal_key=NULL, pesapal_secret=NULL WHERE id=?", rid);
  else if (pk && pk.key && pk.secret) {
    run("UPDATE restaurants SET pesapal_key=?, pesapal_secret=? WHERE id=?", String(pk.key).trim(), String(pk.secret).trim(), rid);
  }
  publish(`staff:${rid}`, "menu", {});
  res.json({ ok: true, settings: next });
}));

app.patch("/api/admin/items/:id", requireStaff(), wrap((req, res) => {
  // Staff may toggle availability (sold out); only admin may change anything else.
  const rid = ridOf(req);
  const item = get("SELECT * FROM menu_items WHERE id=? AND restaurant_id=?", Number(req.params.id), rid);
  if (!item) throw new HttpError(404, "Item not found");
  const b = req.body || {};
  const isAdmin = (req as any).role === "admin";
  if (!isAdmin && Object.keys(b).some((k) => k !== "available")) throw new HttpError(403, "Admin PIN required");
  const fields: [string, any][] = [];
  if (b.name !== undefined) fields.push(["name", String(b.name).trim().slice(0, 80)]);
  if (b.description !== undefined) fields.push(["description", String(b.description).trim().slice(0, 200)]);
  if (b.price !== undefined) {
    const p = Math.floor(Number(b.price));
    if (!(p > 0)) throw new HttpError(400, "Price must be above 0");
    fields.push(["price", p]);
  }
  if (b.tags !== undefined) fields.push(["tags", String(b.tags).trim() || null]);
  if (b.image_url !== undefined) {
    const u = String(b.image_url).trim();
    if (u && !/^(https:\/\/\S+|\/img\/[\w\/.-]+)$/i.test(u)) throw new HttpError(400, "Photo link must start with https://");
    fields.push(["image_url", u || null]);
  }
  if (b.available !== undefined) fields.push(["available", b.available ? 1 : 0]);
  if (b.category_id !== undefined) fields.push(["category_id", Number(b.category_id)]);
  if (fields.length) {
    run(`UPDATE menu_items SET ${fields.map(([k]) => `${k}=?`).join(", ")} WHERE id=?`, ...fields.map(([, v]) => v), item.id);
  }
  publish(`staff:${rid}`, "menu", {});
  res.json({ ok: true });
}));

app.post("/api/admin/items", requireStaff("admin"), wrap((req, res) => {
  const rid = ridOf(req);
  const b = req.body || {};
  const cat = get("SELECT id FROM categories WHERE id=? AND restaurant_id=?", Number(b.category_id), rid);
  if (!cat) throw new HttpError(400, "Pick a category");
  const name = String(b.name || "").trim();
  const price = Math.floor(Number(b.price));
  if (!name || !(price > 0)) throw new HttpError(400, "Name and price are required");
  const r = run(
    "INSERT INTO menu_items (restaurant_id, category_id, name, description, price, tags, image_url, sort) VALUES (?,?,?,?,?,?,?,999)",
    rid, cat.id, name.slice(0, 80), String(b.description || "").slice(0, 200), price, String(b.tags || "") || null,
    /^https:\/\/\S+$/i.test(String(b.image_url || "")) ? String(b.image_url) : null
  );
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
}));

app.delete("/api/admin/items/:id", requireStaff("admin"), wrap((req, res) => {
  // Soft-remove: keep the row so old receipts stay intact.
  run("UPDATE menu_items SET available=0, deleted=1 WHERE id=? AND restaurant_id=?", Number(req.params.id), ridOf(req));
  res.json({ ok: true });
}));

app.post("/api/admin/categories", requireStaff("admin"), wrap((req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) throw new HttpError(400, "Name required");
  const r = run("INSERT INTO categories (restaurant_id, name, sort) VALUES (?,?,999)", ridOf(req), name.slice(0, 40));
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
}));

app.get("/api/admin/tables", requireStaff(), wrap(async (req, res) => {
  const tables = all<Table>("SELECT * FROM dining_tables WHERE restaurant_id=? AND active=1 ORDER BY id", ridOf(req));
  const out = await Promise.all(tables.map(async (t) => {
    const url = `${PUBLIC_URL}/t/${t.code}`;
    const svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return { id: t.id, label: t.label, code: t.code, url, svg };
  }));
  res.json({ publicUrl: PUBLIC_URL, tables: out });
}));

app.post("/api/admin/tables", requireStaff("admin"), wrap((req, res) => {
  const label = String(req.body?.label || "").trim().slice(0, 30);
  if (!label) throw new HttpError(400, "Label required");
  run("INSERT INTO dining_tables (restaurant_id, label, code) VALUES (?,?,?)", ridOf(req), label, token(8));
  res.json({ ok: true });
}));

app.post("/api/admin/tables/:id/regenerate", requireStaff("admin"), wrap((req, res) => {
  // New code invalidates the old printed QR / NFC tag (e.g. someone photographed it and orders from home).
  run("UPDATE dining_tables SET code=? WHERE id=? AND restaurant_id=?", token(8), Number(req.params.id), ridOf(req));
  res.json({ ok: true });
}));

app.delete("/api/admin/tables/:id", requireStaff("admin"), wrap((req, res) => {
  run("UPDATE dining_tables SET active=0 WHERE id=? AND restaurant_id=?", Number(req.params.id), ridOf(req));
  res.json({ ok: true });
}));

// ================= PAGES =================
const page = (f: string) => (_req: Request, res: Response) => res.sendFile(join(process.cwd(), "public", f));
app.get("/t/:code", page("table.html"));
app.get("/r/:token", page("receipt.html"));
app.get("/staff", page("staff.html"));
app.get("/admin", page("admin.html"));

// ---------- errors ----------
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? "Something went wrong" : err.message });
});

app.listen(PORT, () => {
  console.log(`TablePay running on ${PUBLIC_URL}  (payments: ${MOCK ? "MOCK" : process.env.MPESA_ENV || "sandbox"})`);
  const t = get<Table>("SELECT * FROM dining_tables ORDER BY id LIMIT 1");
  if (t) console.log(`  Guest demo: ${PUBLIC_URL}/t/${t.code}\n  Staff:      ${PUBLIC_URL}/staff\n  Admin:      ${PUBLIC_URL}/admin`);
});
