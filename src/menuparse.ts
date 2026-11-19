// Turns a pasted menu (typed from a photo or copied from a PDF) into sections and dishes.
//
//   GRILL                              <- a section: no price, CAPITALS, ends with ":" or starts with "#"
//   Nyama Choma 500g ..... 1,400       <- a dish: the line ends in a price
//   Charcoal-grilled goat (chef)       <- the line after a dish, with no price, is its description
//   Half Chicken | Herb marinated | KSh 1,100   <- or name | description | price on one line
//
// Tags in brackets anywhere on a dish or description line: (v) (veg) (vegan) (spicy) (chef) (new), or a * after the name.

export type ParsedItem = { name: string; description: string; price: number; tags: string[] };
export type ParsedSection = { name: string; items: ParsedItem[] };
export type ParseResult = { sections: ParsedSection[]; skipped: string[] };

const PRICE_AT_END = /(?:^|[\s.\-–—:|=]+)(?:k?sh\.?|kes|ksh)?\s*(\d{1,3}(?:[,\s]\d{3})+|\d{2,6})(?:\.00)?\s*(?:\/-|=\/?|k?sh|kes|bob)?\s*$/i;
const TAG_RE = /\((v|veg|vegetarian|vegan|spicy|hot|chef|chef's pick|new|gf)\)/gi;

function tagsOf(s: string): { text: string; tags: string[] } {
  const tags = new Set<string>();
  let text = s.replace(TAG_RE, (_m, t: string) => {
    const k = t.toLowerCase();
    if (k.startsWith("v")) tags.add("veg");
    else if (k === "spicy" || k === "hot") tags.add("spicy");
    else if (k.startsWith("chef")) tags.add("chef");
    return " ";
  });
  if (/\*\s*$/.test(text) || /\*\s*[|]/.test(text)) { tags.add("chef"); text = text.replace(/\*/g, " "); }
  if (/🌶/u.test(text)) { tags.add("spicy"); text = text.replace(/🌶️?/gu, " "); }
  return { text: clean(text), tags: [...tags] };
}

function clean(s: string) {
  return s.replace(/[.·…_]{2,}/g, " ").replace(/\s{2,}/g, " ").replace(/^[\s\-–—•*:|]+|[\s\-–—•:|,]+$/g, "").trim();
}

function titleCase(s: string) {
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s(&/-])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
}

function isHeading(raw: string, line: string) {
  if (/^#/.test(raw.trim())) return true;
  if (/:\s*$/.test(line)) return true;
  const letters = line.replace(/[^\p{L}]/gu, "");
  return letters.length >= 2 && letters === letters.toUpperCase() && line.length <= 40;
}

export function parseMenu(input: string): ParseResult {
  const sections: ParsedSection[] = [];
  const skipped: string[] = [];
  let current: ParsedSection | null = null;
  let last: ParsedItem | null = null;
  const section = (name: string) => { current = { name: titleCase(clean(name.replace(/^#+/, ""))).slice(0, 40) || "Menu", items: [] }; sections.push(current); last = null; };

  for (const raw of String(input || "").replace(/\r/g, "").split("\n")) {
    const line = raw.replace(/\t/g, " ").trim();
    if (!line) { last = null; continue; }
    const parts = line.split("|").map((p) => p.trim());
    let name = "", desc = "", priceStr = "";
    if (parts.length >= 3) {
      [name, desc] = parts; priceStr = parts[parts.length - 1];
      const m = priceStr.match(PRICE_AT_END); priceStr = m ? m[1] : "";
    } else {
      const m = line.match(PRICE_AT_END);
      if (m && m.index! > 0) {
        name = line.slice(0, m.index); priceStr = m[1];
        if (parts.length === 2) { name = parts[0]; desc = parts[1].replace(PRICE_AT_END, ""); }
      }
    }
    const price = priceStr ? Number(priceStr.replace(/[,\s]/g, "")) : 0;
    if (price > 0 && name.replace(/[^\p{L}]/gu, "").length >= 2) {
      if (!current) section("Menu");
      const n = tagsOf(name), d = tagsOf(desc);
      last = { name: titleCase(n.text).slice(0, 60), description: d.text.slice(0, 160), price, tags: [...new Set([...n.tags, ...d.tags])] };
      current!.items.push(last);
      continue;
    }
    // Phone numbers, opening hours and the like are not dishes or descriptions
    if (/\d{3}[\s-]?\d{3}[\s-]?\d{3}/.test(line) || /\b(tel|call|whatsapp|open(ing)?|hours|www\.|@)\b/i.test(line)) { skipped.push(line); last = null; continue; }
    if (isHeading(raw, line)) { section(line); continue; }
    if (last && !last.description) {
      const d = tagsOf(line);
      last.description = d.text.slice(0, 160);
      last.tags = [...new Set([...last.tags, ...d.tags])];
      continue;
    }
    if (!last && line.length <= 40 && !/\d/.test(line)) { section(line); continue; }
    skipped.push(line);
  }
  return { sections: sections.filter((s) => s.items.length), skipped };
}
