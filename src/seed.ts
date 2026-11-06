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
      "demo-grill", "Kaya Kitchen & Bar", "Westlands", "Grill, cocktails and good company",
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
        ["Beef Short Ribs", "Slow cooked, smoky BBQ glaze", 1800, "chef"],
        ["Tilapia (whole)", "Fried or grilled, with ugali or chips", 1300],
      ],
      Mains: [
        ["Kaya Burger", "Beef patty, cheddar, caramelised onion, fries", 1050, "chef"],
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
  console.log("Seeded demo restaurant 'Kaya Kitchen & Bar' (staff PIN 1234, admin PIN 9999)");
}

// Demo databases made before the rename keep working, with the new name
export function renameOldDemo() {
  const old = get<{ id: number }>("SELECT id FROM restaurants WHERE slug = 'demo-grill' AND name = 'Mtaa Grill & Lounge'");
  if (!old) return;
  run("UPDATE restaurants SET name = ?, tagline = ? WHERE id = ?", "Kaya Kitchen & Bar", "Grill, cocktails and good company", old.id);
  run("UPDATE menu_items SET name = 'Kaya Burger' WHERE restaurant_id = ? AND name = 'Mtaa Burger'", old.id);
  console.log("Renamed demo restaurant to 'Kaya Kitchen & Bar'");
}

// A second demo venue on TablePay Menu Premium, with one table at /t/premium
export const PREMIUM_DEMO_CODE = "premium";
export function seedPremiumDemo() {
  if (get("SELECT id FROM restaurants WHERE slug = 'demo-premium'")) return;
  tx(() => {
    const r = run(
      `INSERT INTO restaurants (slug, name, branch, tagline, phone, email, staff_pin, admin_pin,
         brand_color, menu_only, template, display_font, paper, story)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      "demo-premium", "Ember & Salt", "Karen, Nairobi", "Since 2019", "0700 000 000", "hello@example.co.ke",
      token(6), token(6), "#7A2E2A", 1, "custom", "Cormorant Garamond", "#F3ECE1",
      "Everything on our menu is cooked over a wood fire, with produce from farms around Limuru and Naivasha."
    );
    const rid = Number(r.lastInsertRowid);
    run("INSERT INTO dining_tables (restaurant_id, label, code) VALUES (?,?,?)", rid, "Table 7", PREMIUM_DEMO_CODE);
    const menu: Record<string, [string, string, number, string?][]> = {
      "Small plates": [
        ["Charred corn", "Smoked chilli butter, aged cheese, lime", 650, "veg"],
        ["Beef tartare", "Hand-cut sirloin, egg yolk, toasted sourdough", 1100],
        ["Grilled octopus", "Coconut, tamarind and coriander", 1350, "chef"],
        ["Burrata", "Roast tomatoes, basil oil, flatbread", 1200, "veg"],
      ],
      "From the fire": [
        ["Ember lamb shoulder", "Twelve-hour Naivasha lamb, smoked aubergine, pomegranate", 2400, "chef"],
        ["Whole tilapia", "Lake Victoria fish, charred lime, coconut and coriander", 1900],
        ["Dry-aged ribeye (300g)", "Bone marrow butter, fire-roasted shallots", 3200],
        ["Fire-roasted squash", "Brown butter, toasted seeds, Limuru greens", 1300, "veg"],
      ],
      Sides: [
        ["Hand-cut chips", "Rosemary salt", 350, "veg"],
        ["Ember greens", "Sukuma, garlic, chilli", 350, "veg"],
        ["Coal-roasted potatoes", "Crème fraîche, chives", 400, "veg"],
      ],
      Desserts: [
        ["Dark chocolate tart", "Kenyan cocoa, sea salt, cream", 750, "veg"],
        ["Grilled pineapple", "Rum caramel, coconut ice cream", 650, "veg"],
      ],
      "Wine & cocktails": [
        ["Smoked old fashioned", "Bourbon, honey, orange, wood smoke", 1100],
        ["Passion spritz", "Passion fruit, prosecco, soda", 950],
        ["House red, glass", "Western Cape blend", 900],
        ["Dawa, our way", "Vodka, lime, Kenyan honey, ginger", 850],
      ],
    };
    let cs = 0;
    for (const [cat, items] of Object.entries(menu)) {
      const c = run("INSERT INTO categories (restaurant_id, name, sort) VALUES (?,?,?)", rid, cat, cs++);
      const cid = Number(c.lastInsertRowid);
      items.forEach(([name, desc, price, tags], i) => {
        run(`INSERT INTO menu_items (restaurant_id, category_id, name, description, price, tags, sort) VALUES (?,?,?,?,?,?,?)`,
          rid, cid, name, desc, price, tags ?? null, i);
      });
    }
  });
  console.log(`Seeded premium demo 'Ember & Salt' at /t/${PREMIUM_DEMO_CODE}`);
}

// Allow `npm run seed`
if (process.argv[1]?.endsWith("seed.ts")) {
  seedDemo();
  renameOldDemo();
  seedPremiumDemo();
  db.close();
}
