import { randomBytes } from "node:crypto";
import { db, get, run, tx } from "./db.js";

export function token(n = 6) {
  // URL-safe, no ambiguous chars
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(n);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function seedDemo() {
  if (get("SELECT id FROM restaurants LIMIT 1")) return;

  tx(() => {
    const r = run(
      `INSERT INTO restaurants (slug, name, branch, tagline, phone, email, staff_pin, admin_pin)
       VALUES (?,?,?,?,?,?,?,?)`,
      "demo-grill", "Mtaa Grill & Lounge", "Westlands", "Grill, drinks and live football",
      "0700 000 000", "hello@example.co.ke", "1234", "9999"
    );
    const rid = Number(r.lastInsertRowid);

    const tables = ["T1", "T2", "T3", "T4", "T5", "T6", "Bar 1", "Bar 2", "Terrace 1", "Terrace 2"];
    for (const label of tables) {
      run("INSERT INTO dining_tables (restaurant_id, label, code) VALUES (?,?,?)", rid, label, token(8));
    }

    const menu: Record<string, [string, string, number, string?][]> = {
      Starters: [
        ["Beef Samosas (3)", "Crisp pastry, spiced minced beef, tamarind dip", 450],
        ["Chicken Wings", "Choice of BBQ, honey-chilli or lemon pepper", 850, "spicy"],
        ["Masala Chips", "Fries tossed in tangy masala sauce", 450, "veg,spicy"],
        ["Bhajia", "Crispy potato fritters with kachumbari", 400, "veg"],
      ],
      Grill: [
        ["Nyama Choma (500g)", "Charcoal-grilled goat, served with kachumbari", 1400, "chef"],
        ["Half Chicken", "Herb marinated, flame grilled", 1100],
        ["Beef Short Ribs", "Slow cooked, smoky BBQ glaze", 1800],
        ["Tilapia (whole)", "Fried or grilled, with ugali or chips", 1300],
      ],
      Mains: [
        ["Mtaa Burger", "Beef patty, cheddar, caramelised onion, fries", 1050],
        ["Chicken Curry", "Coastal coconut curry with pilau or chapati", 1150, "spicy"],
        ["Veggie Wrap", "Grilled vegetables, avocado, halloumi", 900, "veg"],
        ["Beef Pilau", "Spiced rice with tender beef and kachumbari", 950],
      ],
      Sides: [
        ["Ugali", "", 150, "veg"],
        ["Chapati (2)", "", 150, "veg"],
        ["Fries", "", 250, "veg"],
        ["Sukuma Wiki", "Sautéed kale with onions and tomato", 200, "veg"],
      ],
      Drinks: [
        ["Tusker Lager", "500ml", 350],
        ["Soda", "Coke, Fanta, Sprite, Stoney", 150],
        ["Fresh Passion Juice", "", 300, "veg"],
        ["Dawa", "Honey, lime and ginger", 450],
        ["Kenyan Tea", "Pot for one", 200, "veg"],
        ["Bottled Water 1L", "", 200],
      ],
    };

    let cs = 0;
    for (const [cat, items] of Object.entries(menu)) {
      const c = run("INSERT INTO categories (restaurant_id, name, sort) VALUES (?,?,?)", rid, cat, cs++);
      const cid = Number(c.lastInsertRowid);
      items.forEach(([name, desc, price, tags], i) => {
        run(
          `INSERT INTO menu_items (restaurant_id, category_id, name, description, price, tags, sort)
           VALUES (?,?,?,?,?,?,?)`,
          rid, cid, name, desc, price, tags ?? null, i
        );
      });
    }
  });
  console.log("Seeded demo restaurant 'Mtaa Grill & Lounge' (staff PIN 1234, admin PIN 9999)");
}

// Allow `npm run seed`
if (process.argv[1]?.endsWith("seed.ts")) {
  seedDemo();
  db.close();
}
