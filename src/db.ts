import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH || "data/tablepay.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS restaurants (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  branch TEXT,
  tagline TEXT,
  phone TEXT,
  email TEXT,
  staff_pin TEXT NOT NULL,
  admin_pin TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dining_tables (
  id INTEGER PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  label TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,          -- random token printed in the QR / written to NFC
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL,             -- whole KES
  tags TEXT,                          -- comma separated: veg,spicy,chef
  available INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,  -- soft delete keeps old receipts intact
  sort INTEGER NOT NULL DEFAULT 0
);

-- A "tab": opened when the first guest lands on a table, closed by staff.
CREATE TABLE IF NOT EXISTS table_sessions (
  id INTEGER PRIMARY KEY,
  table_id INTEGER NOT NULL REFERENCES dining_tables(id),
  status TEXT NOT NULL DEFAULT 'open', -- open | closed
  receipt_token TEXT UNIQUE NOT NULL,
  opened_at TEXT DEFAULT (datetime('now')),
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES table_sessions(id),
  guest_name TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'new',  -- new | preparing | served | cancelled
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  menu_item_id INTEGER REFERENCES menu_items(id),
  name TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  qty INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS service_requests (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES table_sessions(id),
  kind TEXT NOT NULL,                  -- waiter | bill | water | other
  status TEXT NOT NULL DEFAULT 'open', -- open | acknowledged | done
  created_at TEXT DEFAULT (datetime('now')),
  acknowledged_at TEXT,
  done_at TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES table_sessions(id),
  method TEXT NOT NULL,                -- mpesa | cash | card
  amount INTEGER NOT NULL,             -- applied to the bill
  tip INTEGER NOT NULL DEFAULT 0,
  phone TEXT,
  payer_label TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed
  checkout_request_id TEXT,
  provider_ref TEXT,                   -- M-Pesa receipt number
  failure_reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  paid_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_table ON table_sessions(table_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(session_id);
CREATE INDEX IF NOT EXISTS idx_payments_checkout ON payments(checkout_request_id);
`);

// Lightweight migrations for databases created by earlier versions
function addColumn(table: string, column: string, definition: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn("menu_items", "image_url", "TEXT");
addColumn("service_requests", "note", "TEXT");
addColumn("orders", "placed_by", "TEXT NOT NULL DEFAULT 'guest'");

// Small typed helpers around node:sqlite
export function all<T = any>(sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function get<T = any>(sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function run(sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params);
}
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
