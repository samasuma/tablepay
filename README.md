# TablePay — order, call a waiter and pay from the table

A working MVP for restaurant digitisation in Kenya. Guests scan a QR code (or tap an NFC sticker) on their table and get a web app — no download — where they can browse the menu, order, call a waiter, see the live bill, split it and pay by M-Pesa STK push. Staff see everything live on a board at the bar. Every tab gets a shareable web receipt.

Stack: Node 22 + TypeScript (run with `tsx`), Express, SQLite (`node:sqlite`, built in), plain HTML/JS PWA, Server-Sent Events for live updates. No build step.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
```

Open `http://localhost:3000` for a launcher with demo tables. A demo restaurant is seeded on first run.

| Screen | URL | Who |
|---|---|---|
| Table page (PWA) | `/t/<table-code>` | Guests — this is what the QR / NFC opens |
| Live board | `/staff` | Waiters, bar, cashier. Staff PIN **1234** |
| Menu & tables | `/admin` | Manager PIN **9999** (staff PIN can only mark items sold out) |
| Receipt | `/r/<token>` | Anyone with the link |

**Mock payments:** with no Daraja keys set, M-Pesa payments complete automatically after 4 seconds. A phone number ending in `0000` simulates a cancelled payment.

To try it on a real phone, expose your laptop with a tunnel (e.g. `cloudflared tunnel --url http://localhost:3000` or ngrok), set `PUBLIC_URL` to the tunnel address, restart, and print the QR cards from `/admin`.

## What it does

**Guests**
- Menu by category, tags (veg / spicy / chef's pick), sold-out items greyed out
- Cart → order with name and kitchen notes; order status updates live (new → preparing → served)
- **Call waiter** and **Ask for bill** buttons (no duplicate calls), with "on the way" confirmation
- Live shared bill — everyone at the table sees the same tab
- Pay: whole bill, **split equally** between N people, or a custom share; optional tip (5% / 10% / custom); STK push to their phone
- Concurrent payments are protected: two people can't overpay the same balance
- Web receipt with M-Pesa reference, "Save as PDF" and share

**Staff board**
- Three live columns: Calls, Kitchen & bar, Open bills — with a sound + vibration on every new call/order
- Acknowledge calls ("I'm going"), move orders to preparing/served, cancel
- Open any bill: record cash/card, close the table (warns if unpaid)
- Today's totals: sales, M-Pesa vs cash/card, tips

**Manager**
- Edit names/prices inline, add items and categories, mark sold out, remove items (old receipts stay intact)
- Add/remove tables, print QR table cards (2 per page), regenerate a table's code if one is misused
- The same table link can be written to an NFC sticker (e.g. NTAG213 with the "NFC Tools" app → Write → URL)

## Going live with M-Pesa (Daraja)

1. Create an app on developer.safaricom.co.ke, enable **M-Pesa Express (STK Push)**.
2. Copy `.env.example` to `.env`, fill the sandbox keys and passkey, set `PUBLIC_URL` to a public **https** URL (Safaricom must reach `/api/mpesa/callback/<MPESA_CALLBACK_SECRET>`).
3. Load the env and start: `node --env-file=.env --import tsx src/server.ts` (or use your process manager).
4. For production: apply for Go-Live with the restaurant's paybill or till. For a **till**, set `MPESA_TXN_TYPE=CustomerBuyGoodsOnline`, `MPESA_SHORTCODE` = store number, `MPESA_PARTY_B` = till number.

If a callback never arrives, a background job queries Daraja for the status after 45 s and times the payment out after 3 minutes, so a stuck "pending" never blocks the table.

Money settles straight into the restaurant's own paybill/till — you never hold their funds, which keeps you out of payment-licensing territory.

## Project layout

```
src/server.ts   routes: guest, staff, admin, receipt, M-Pesa callback
src/db.ts       SQLite schema (restaurants, tables, menu, tabs, orders, calls, payments)
src/mpesa.ts    Daraja OAuth, STK push, callback parsing, status query, mock mode
src/events.ts   Server-Sent Events hub (staff board + each table's phones)
src/seed.ts     demo restaurant
public/         table.html, staff.html, admin.html, receipt.html, PWA manifest + service worker
```

## Deliberately left out of the MVP (next steps)

- **KRA eTIMS invoices** — needed before you can replace a restaurant's POS. Until then, position this as working *alongside* their POS.
- **Multi-restaurant onboarding / billing** — the schema is multi-tenant already; add a signup flow and per-restaurant PINs.
- **Kitchen printer / KDS routing** (food vs bar tickets), modifiers (e.g. "well done"), item photos
- **Card payments** (Paystack/Pesapal) alongside M-Pesa
- **Per-waiter sections and accounts** instead of a shared PIN; tip split per waiter
- **Postgres** when you have several busy venues (SQLite is fine for pilots)
- **Abuse guard:** someone ordering from home with a photographed QR. Today: staff cancel the order and press "New code". Later: require the first order on a table to be confirmed by staff.
