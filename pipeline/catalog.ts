/**
 * Mock catalog: suppliers and SKUs for every candystore category. Generated
 * from a fixed seed so a rebuild reproduces the committed file exactly.
 * Product names are generic product types, never brands.
 */

import { pick, randInt, seededRandom } from "../lib/util/random";
import type { Catalog, Network, Sku, Supplier } from "../lib/twin/types";

export const CATALOG_SEED = 20260913;

const TRADITIONAL_FAMILIES: Array<{ supplier: Supplier; items: string[] }> = [
  {
    supplier: { id: "SUP-CHOC", name: "Domestic chocolate supplier", kind: "domestic", leadDays: 5, leadSdDays: 1, orderDay: 1 },
    items: ["Milk chocolate bar", "Dark chocolate bar", "Peanut butter cups", "Chocolate-covered pretzels", "Caramel chocolate bar", "Crispy rice chocolate bar", "Chocolate-covered raisins", "Mint chocolate patties", "Chocolate truffles", "Toffee chocolate bar", "Malted milk balls", "Chocolate coins"],
  },
  {
    supplier: { id: "SUP-GUMMY", name: "Domestic gummy and chewy supplier", kind: "domestic", leadDays: 6, leadSdDays: 1.5, orderDay: 2 },
    items: ["Gummy bears", "Sour gummy worms", "Fruit chews", "Licorice twists", "Sour belts", "Gummy sharks", "Taffy assortment", "Fruit slices", "Jelly beans", "Sour watermelon gummies", "Cola bottle gummies", "Chewy caramels"],
  },
  {
    supplier: { id: "SUP-HARD", name: "Domestic hard candy and mint supplier", kind: "domestic", leadDays: 7, leadSdDays: 2, orderDay: 3 },
    items: ["Butterscotch discs", "Peppermint starlights", "Cinnamon discs", "Lollipops", "Rock candy sticks", "Lemon drops", "Root beer barrels", "Sugar-free mints", "Candy canes", "Cinnamon jawbreakers", "Sour hard candy", "Spearmint leaves"],
  },
  {
    supplier: { id: "SUP-NOVEL", name: "Domestic novelty and nostalgia supplier", kind: "domestic", leadDays: 8, leadSdDays: 2, orderDay: 4 },
    items: ["Candy necklaces", "Popping candy", "Candy buttons", "Wax bottles", "Candy sticks", "Peanut brittle", "Circus peanuts", "Candy dots", "Saltwater taffy", "Marshmallow chicks", "Chocolate-covered cherries", "Nougat bars"],
  },
];

const SPECIALTY_ITEMS: Record<string, string[]> = {
  latam: ["Tamarind candy sticks", "Chili mango lollipops", "Dulce de leche chews", "Peanut marzipan rounds", "Chili watermelon gummies", "Coconut cocadas", "Guava paste bars", "Cajeta wafers", "Tamarind paste bars", "Mexican chocolate discs", "Chamoy gummy rings", "Obleas", "Alfajores", "Milk fudge squares", "Chili-lime lollipops", "Brigadeiro truffles"],
  caribbean: ["Tamarind balls", "Coconut drops", "Guava cheese", "Peppermint sticks", "Paradise plums", "Sugar cake", "Ginger candy", "Toolum", "Coconut toffee", "Tamarind stew candy", "Peanut drops", "Bustamante backbone", "Pawpaw candy", "Fudge squares", "Mint balls", "Grater cake"],
  eastasia: ["Milk candy chews", "Lychee jelly cups", "Matcha wafers", "Haw flakes", "Soft fruit chews", "Rice candy", "Sesame brittle", "Mochi bites", "Ginger chews", "Honey citron candy", "Red bean wafers", "Yuzu hard candy", "Peach gummies", "Black sugar candy", "Chocolate biscuit sticks", "Dried plum candy"],
  southasia: ["Mango toffee", "Cardamom sweets", "Cumin digestive candy", "Kulfi candy", "Jaggery chikki", "Coconut barfi", "Rose lollipops", "Tamarind pops", "Pan-flavored candy", "Milk peda", "Sesame gajak", "Imli candy", "Elaichi drops", "Soan papdi squares", "Coffee toffee", "Guava toffee"],
  mideast: ["Turkish delight", "Pistachio halva", "Sesame halva", "Pistachio nougat", "Date rolls", "Rosewater lokum", "Sugared almonds", "Mastic gum", "Sesame bars", "Apricot paste rolls", "Barazek cookies", "Qamar al-din sheets", "Tahini fudge", "Maamoul bites", "Honey sesame candy", "Saffron brittle"],
  africa: ["Coconut candy", "Chin chin", "Groundnut brittle", "Kola candy", "Tamarind sweets", "Milk toffee", "Ginger sweets", "Baobab candy", "Kulikuli crunch", "Plantain chips candy", "Honey drops", "Tiger nut sweets", "Sesame snaps", "Bobo candy", "Coconut toffee squares", "Hibiscus sweets"],
  easteurope: ["Cow candy (krowki)", "Chocolate marshmallows", "Honey cake bites", "Sour cherry jellies", "Halva bars", "Wafer bars", "Sesame kozinaki", "Plum chocolate candy", "Fudge toffee", "Poppy seed candy", "Chocolate-covered prunes", "Jelly in chocolate", "Bird's milk souffle", "Hazelnut wafers", "Barberry candy", "Rum-flavored truffles"],
};

const PACKS = ["12ct", "18ct", "24ct", "36ct"];

/** SKU id codes per segment. Spelled out: the first three letters of eastasia and easteurope collide. */
const SEGMENT_CODES: Record<string, string> = {
  latam: "LAT",
  caribbean: "CAR",
  eastasia: "EAS",
  southasia: "SAS",
  mideast: "MEA",
  africa: "AFR",
  easteurope: "EEU",
};

function zipfShares(n: number, s: number, order: number[]): number[] {
  const raw = order.map((rank) => 1 / Math.pow(rank + 1, s));
  const total = raw.reduce((a, b) => a + b, 0);
  return raw.map((r) => r / total);
}

function shuffled(rng: () => number, n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeSku(rng: () => number, id: string, name: string, category: string, supplier: string, retailRange: [number, number]): Omit<Sku, "velocityShare"> {
  const innersPerCase = pick(rng, [6, 8, 12]);
  const innerCubeFt = Math.round((0.12 + rng() * 0.33) * 100) / 100;
  const casesPerPallet = Math.max(20, Math.min(120, Math.floor(55 / (innersPerCase * innerCubeFt))));
  const innerRetail = Math.round((retailRange[0] + rng() * (retailRange[1] - retailRange[0])) * 4) / 4;
  return { id, name: `${name}, ${pick(rng, PACKS)} display box`, category, supplier, innerRetail, innersPerCase, casesPerPallet, innerCubeFt };
}

export function buildCatalog(network: Network): Catalog {
  const rng = seededRandom(CATALOG_SEED);
  const suppliers: Supplier[] = [];
  const skus: Sku[] = [];

  // Traditional: four families of twelve product types in a few pack sizes each.
  const trad: Array<Omit<Sku, "velocityShare">> = [];
  for (const fam of TRADITIONAL_FAMILIES) {
    suppliers.push(fam.supplier);
    for (const item of fam.items) {
      const variants = randInt(rng, 3, 4);
      for (let v = 0; v < variants; v++) {
        trad.push(makeSku(rng, `T-${String(trad.length + 1).padStart(4, "0")}`, item, "traditional", fam.supplier.id, [14, 36]));
      }
    }
  }
  const tradShares = zipfShares(trad.length, 1.0, shuffled(rng, trad.length));
  trad.forEach((s, i) => skus.push({ ...s, velocityShare: tradShares[i] }));

  // Specialty: one importer per segment, sixteen products each, long lead times.
  network.segments.forEach((seg, i) => {
    const items = SPECIALTY_ITEMS[seg.id];
    if (!items) return;
    const supplier: Supplier = {
      id: `SUP-IMP-${seg.id.toUpperCase()}`,
      name: `${seg.label} candy importer`,
      kind: "importer",
      leadDays: 24 + randInt(rng, 0, 10),
      leadSdDays: 5,
      orderDay: (i % 5) + 1,
    };
    suppliers.push(supplier);
    const cat = `specialty:${seg.id}`;
    const code = SEGMENT_CODES[seg.id] ?? seg.id.toUpperCase();
    const made = items.map((item, k) => makeSku(rng, `S-${code}-${String(k + 1).padStart(2, "0")}`, item, cat, supplier.id, [10, 28]));
    const shares = zipfShares(made.length, 0.8, shuffled(rng, made.length));
    made.forEach((s, k) => skus.push({ ...s, velocityShare: shares[k] }));
  });

  const ids = new Set(skus.map((s) => s.id));
  if (ids.size !== skus.length) throw new Error(`Duplicate SKU ids in the generated catalog (${skus.length - ids.size}).`);
  return { generatedAt: new Date().toISOString(), seed: CATALOG_SEED, suppliers, skus };
}
