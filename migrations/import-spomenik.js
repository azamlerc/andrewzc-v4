#!/usr/bin/env node
// import-spomenik.js
//
// Imports Spomenik monuments from Donald Niebyl's "Spomenik Monument Database"
// (FUEL, 2018). Coordinates are from the book jacket in DMS format and are
// converted to decimal degrees. Countries are assigned based on the bounding
// boxes of the former Yugoslav republics.
//
// Usage:
//   node migrations/import-spomenik.js [--dryrun]

import "dotenv/config";
import { MongoClient } from "mongodb";

const DRYRUN = process.argv.includes("--dryrun");
const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB || "andrewzc";

if (!URI) throw new Error("Missing MONGODB_URI in environment");

// Convert DMS string like "N42°44'15.1\"" to decimal degrees
function dmsToDecimal(dms) {
  // Normalise: strip direction prefix, handle º vs °, handle ' vs ′
  const dir = dms[0]; // N/S/E/W
  const str = dms.slice(1)
    .replace(/[º°]/g, "°")
    .replace(/[′']/g, "'")
    .replace(/[″"]/g, '"')
    .trim();

  // Match degrees, minutes, optional seconds
  const match = str.match(/(\d+)[°](\d+)['](\d+\.?\d*)?/);
  if (!match) throw new Error(`Cannot parse DMS: "${dms}"`);

  const deg = parseFloat(match[1]);
  const min = parseFloat(match[2]);
  const sec = parseFloat(match[3] || "0");

  let decimal = deg + min / 60 + sec / 3600;
  if (dir === "S" || dir === "W") decimal = -decimal;
  return Math.round(decimal * 100000) / 100000;
}

// Country lookup from scraped Spomenik Database data
// Maps monument name → ISO country code(s)
// Codes: RS=Serbia, ME=Montenegro, SI=Slovenia, MK=North Macedonia,
//        BA=Bosnia, HR=Croatia, XK=Kosovo
const COUNTRY_LOOKUP = {
  "Andrijevica":       ["ME"],
  "Avala":             ["RS"],
  "Barutana":          ["ME"],
  "Bihać":             ["BA"],
  "Botun":             ["MK"],
  "Bratunac":          ["BA"],
  "Bravsko":           ["BA"],
  "Brezovica":         ["XK"],
  "Brzeće":            ["RS"],
  "Čačak":             ["RS"],
  "Čenej":             ["RS"],
  "Črni Kal":          ["SI"],
  "Dotršcina":         ["HR"],
  "Dražgoše":          ["SI"],
  "Drvar":             ["BA"],
  "Gevgelija":         ["MK"],
  "Glamoč":            ["BA"],
  "Gligino Brdo":      ["BA"],
  "Golubovci":         ["ME"],
  "Grmeč":             ["BA"],
  "Ilirska Bistrica":  ["SI"],
  "Jabuka":            ["RS"],
  "Jasenica":          ["BA"],
  "Jasenovac":         ["HR"],
  "Kadinjača":         ["RS"],
  "Kamenska":          ["HR"],
  "Kavadarci":         ["MK"],
  "Knin":              ["HR"],
  "Kolašin":           ["ME"],
  "Korenica":          ["HR"],
  "Kosmaj":            ["RS"],
  "Košute":            ["HR"],
  "Kozara":            ["BA"],
  "Kragujevac":        ["RS"],
  "Kruševo":           ["MK"],
  "Landovice":         ["XK"],
  "Lepoglava":         ["HR"],
  "Leskovac":          ["RS"],
  "Lukovdol":          ["HR"],
  "Majdanpek":         ["RS"],
  "Makarska":          ["HR"],
  "Makljen":           ["BA"],
  "Maribor":           ["SI"],
  "Medeno Polje":      ["BA"],
  "Mitrašinci":        ["MK"],
  "Mitrovica":         ["XK"],
  "Mostar":            ["BA"],
  "Nikšić":            ["ME"],
  "Niš":               ["RS"],
  "Novi Travnik":      ["BA"],
  "Obadov Brijeg":     ["ME"],
  "Ostra":             ["RS"],
  "Petrova Gora":      ["HR"],
  "Pleso":             ["HR"],
  "Plovanija":         ["HR"],
  "Podgarić":          ["HR"],
  "Podgora":           ["HR"],
  "Podhum":            ["HR"],
  "Popina":            ["RS"],
  "Prilep":            ["MK"],
  "Sanski Most":       ["BA"],
  "Sinj":              ["HR"],
  "Sisak":             ["HR"],
  "Slabinja":          ["HR"],
  "Sremska Mitrovica": ["RS"],
  "Struga":            ["MK"],
  "Titel":             ["RS"],
  "Tjentište":         ["BA"],
  "Ulcinj":            ["ME"],
  "Velanija":          ["XK"],
  "Veles":             ["MK"],
  "Vodenica":          ["BA"],
  "Vogošća":           ["BA"],
  "Vranjske Njive":    ["ME"],
  "Vukovar":           ["HR"],
  "Zagreb":            ["HR"],
  "Zaječar":           ["RS"],
  "Zaostrog":          ["HR"],
  "Zenica":            ["BA"],
  "Zrenjanin":         ["RS"],
  "Župa Nikšićka":     ["ME"],
};

function assignCountry(name) {
  return COUNTRY_LOOKUP[name] || ["XX"];
}

// Country to flag emoji
const FLAG = {
  SI: "🇸🇮", HR: "🇭🇷", BA: "🇧🇦", RS: "🇷🇸",
  ME: "🇲🇪", MK: "🇲🇰", XK: "🇽🇰", AL: "🇦🇱", XX: "❓"
};

function flagEmoji(code) {
  if (FLAG[code]) return FLAG[code];
  return code.toUpperCase().split("").map(c =>
    String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)
  ).join("");
}

// Raw data from the book jacket [order, name, latDMS, lonDMS]
const RAW = [
  [12,  "Andrijevica",       "N42°44'15.1\"", "E19°47'13.9\""],
  [14,  "Avala",             "N44°41'19.7\"", "E20°30'50.6\""],
  [16,  "Barutana",          "N42°23'38.3\"", "E19°08'30.3\""],
  [18,  "Bihać",             "N44°49'20.0\"", "E15°50'24.3\""],
  [20,  "Botun",             "N41°16'43.7\"", "E20°47'01.3\""],
  [22,  "Bratunac",          "N44°11'02.8\"", "E19°19'43.5\""],
  [26,  "Bravsko",           "N44°32'56.4\"", "E16°34'54.5\""],
  [28,  "Brezovica",         "N42°13'12.3\"", "E20°59'50.0\""],
  [30,  "Brzeće",            "N43°16'38.8\"", "E20°52'31.1\""],
  [32,  "Čačak",             "N43°52'34.8\"", "E20°20'05.0\""],
  [34,  "Čenej",             "N45°19'23.3\"", "E19°49'44.9\""],
  [36,  "Črni Kal",          "N45°33'12.0\"", "E13°52'21.3\""],
  [38,  "Dotršcina",         "N45°50'34.3\"", "E16°01'40.1\""],
  [40,  "Dražgoše",          "N46°15'08.5\"", "E14°09'59.8\""],
  [42,  "Drvar",             "N44°22'27.3\"", "E16°22'58.9\""],
  [44,  "Gevgelija",         "N41°09'29.6\"", "E22°30'02.1\""],
  [46,  "Glamoč",            "N44°04'20.3\"", "E16°49'14.1\""],
  [48,  "Gligino Brdo",      "N45°08'32.3\"", "E16°29'47.5\""],
  [50,  "Golubovci",         "N42°19'35.6\"", "E19°13'11.8\""],
  [52,  "Grmeč",             "N44°41'14.1\"", "E16°26'15.5\""],
  [54,  "Ilirska Bistrica",  "N45°34'07.7\"", "E14°14'24.7\""],
  [56,  "Jabuka",            "N44°55'43.6\"", "E20°38'01.8\""],
  [58,  "Jasenica",          "N44°48'11.3\"", "E16°15'30.1\""],
  [60,  "Jasenovac",         "N45°16'49.4\"", "E16°55'42.2\""],
  [64,  "Kadinjača",         "N43°54'43.7\"", "E19°44'33.7\""],
  [68,  "Kamenska",          "N45°26'46.4\"", "E17°28'36.4\""],
  [70,  "Kavadarci",         "N41°25'57.8\"", "E22°01'22.5\""],
  [72,  "Knin",              "N44°02'19.6\"", "E16°11'26.3\""],
  [74,  "Kolašin",           "N42°49'27.2\"", "E19°31'07.5\""],
  [78,  "Korenica",          "N44°40'26.5\"", "E15°50'54.8\""],
  [80,  "Kosmaj",            "N44°28'04.3\"", "E20°34'18.3\""],
  [82,  "Košute",            "N43°37'40.1\"", "E16°41'29.9\""],
  [84,  "Kozara",            "N45°00'49.7\"", "E16°54'32.9\""],
  [88,  "Kragujevac",        "N44°00'57.8\"", "E20°53'09.1\""],
  [92,  "Kruševo",           "N41°22'38.7\"", "E21°14'54.2\""],
  [96,  "Landovice",         "N42°15'17.5\"", "E20°40'55.0\""],
  [98,  "Lepoglava",         "N46°13'00.6\"", "E16°01'46.0\""],
  [100, "Leskovac",          "N42°58'59.0\"", "E21°56'34.2\""],
  [102, "Lukovdol",          "N45°25'43.8\"", "E15°07'34.0\""],
  [104, "Majdanpek",         "N44°25'43.3\"", "E21°56'34.4\""],
  [106, "Makarska",          "N43°17'45.7\"", "E17°00'59.1\""],
  [108, "Makljen",           "N43°50'33.9\"", "E17°35'49.8\""],
  [110, "Maribor",           "N46°33'37.8\"", "E15°38'56.7\""],
  [112, "Medeno Polje",      "N44°34'18.7\"", "E16°17'23.1\""],
  [116, "Mitrašinci",        "N41°46'40.3\"", "E22°45'09.7\""],
  [118, "Mitrovica",         "N42°53'45.3\"", "E20°51'36.4\""],
  [122, "Mostar",            "N43°20'28.1\"", "E17°47'46.1\""],
  [124, "Nikšić",            "N42°45'47.2\"", "E18°57'34.6\""],
  [126, "Niš",               "N43°18'18.2\"", "E21°52'21.9\""],
  [130, "Novi Travnik",      "N44°11'47.6\"", "E17°41'28.3\""],
  [132, "Obadov Brijeg",     "N42°34'49.6\"", "E19°03'12.7\""],
  [134, "Ostra",             "N43°54'41.5\"", "E20°30'59.7\""],
  [138, "Petrova Gora",      "N45°18'58.6\"", "E15°48'17.6\""],
  [142, "Pleso",             "N45°43'51.6\"", "E16°03'53.3\""],
  [144, "Plovanija",         "N45°27'02.7\"", "E13°38'07.1\""],
  [146, "Podgarić",          "N45°38'27.0\"", "E16°46'39.6\""],
  [150, "Podgora",           "N43°14'44.6\"", "E17°04'13.9\""],
  [152, "Podhum",            "N45°22'31.9\"", "E14°29'49.6\""],
  [154, "Popina",            "N43°37'48.9\"", "E20°57'29.6\""],
  [156, "Prilep",            "N41°20'03.6\"", "E21°33'16.2\""],
  [158, "Sanski Most",       "N44°45'44.1\"", "E16°41'02.2\""],
  [162, "Sinj",              "N43°41'54.1\"", "E16°37'31.0\""],
  [166, "Sisak",             "N45°30'09.6\"", "E16°27'30.2\""],
  [168, "Slabinja",          "N45°12'36.9\"", "E16°40'09.5\""],
  [170, "Sremska Mitrovica", "N44°58'36.0\"", "E19°36'22.7\""],
  [172, "Struga",            "N41°10'39.6\"", "E20°40'46.2\""],
  [174, "Titel",             "N45°12'18.4\"", "E20°18'42.8\""],
  [176, "Tjentište",         "N43°20'46.0\"", "E18°41'12.6\""],
  [180, "Ulcinj",            "N41°55'25.8\"", "E19°12'20.6\""],
  [182, "Velanija",          "N42°39'31.8\"", "E21°10'31.8\""],
  [184, "Veles",             "N41°43'24.0\"", "E21°47'21.4\""],
  [186, "Vodenica",          "N44°38'04.3\"", "E16°16'28.4\""],
  [188, "Vogošća",           "N43°53'57.9\"", "E18°21'00.0\""],
  [190, "Vranjske Njive",    "N42°29'19.9\"", "E19°13'27.7\""],
  [192, "Vukovar",           "N45°19'49.4\"", "E19°01'02.7\""],
  [194, "Zagreb",            "N45°49'30.9\"", "E16°02'17.0\""],
  [196, "Zaječar",           "N43°53'21.2\"", "E22°15'53.6\""],
  [198, "Zaostrog",          "N43°08'21.9\"", "E17°16'41.9\""],
  [200, "Zenica",            "N44°14'41.1\"", "E17°57'34.8\""],
  [202, "Zrenjanin",         "N45°22'07.3\"", "E20°22'08.5\""],
  [206, "Župa Nikšićka",     "N42°43'56.1\"", "E19°04'59.4\""],
];

function toKey(name) {
  return name
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")  // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const client = new MongoClient(URI);

async function main() {
  await client.connect();
  const db = client.db(DB);
  const entities = db.collection("entities");

  console.log(`Processing ${RAW.length} monuments...`);
  if (DRYRUN) console.log("-- DRY RUN --\n");

  const docs = [];
  for (const [order, name, latDMS, lonDMS] of RAW) {
    const lat = dmsToDecimal(latDMS);
    const lon = dmsToDecimal(lonDMS);
    const countries = assignCountry(name);
    const country = countries.length === 1 ? countries[0] : undefined;
    const key = toKey(name);

    const doc = {
      been: false,
      coords: `${lat}, ${lon}`,
      icons: countries.map(flagEmoji),
      key,
      link: `https://www.spomenikdatabase.org/${key}`,
      list: "spomenik",
      location: { type: "Point", coordinates: [lon, lat] },
      name,
      order,
      ...(country ? { country } : { countries }),
    };

    console.log(`  [${order}] ${name} → ${lat}, ${lon} (${country} ${flagEmoji(country)})`);
    docs.push(doc);
  }

  if (!DRYRUN) {
    const result = await entities.insertMany(docs);
    console.log(`\n✓ Inserted ${result.insertedCount} documents.`);
  } else {
    console.log(`\n-- DRY RUN: would insert ${docs.length} documents.`);
  }

  // Summary by country
  const counts = {};
  for (const d of docs) {
    const cs = d.countries || [d.country];
    for (const c of cs) counts[c] = (counts[c] || 0) + 1;
  }
  console.log("\nCountry breakdown:");
  for (const [c, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${flagEmoji(c)} ${c}: ${n}`);
  }

  await client.close();
}

main().catch(err => { console.error(err); process.exit(1); });
