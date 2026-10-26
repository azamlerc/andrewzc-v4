// One-off: tighten the Arabic reference values on the mosques list.
//
// The glosses mostly began with مسجد / المسجد / جامع / الجامع — "mosque of…" —
// which on a page titled Mosques spends characters saying nothing, and in RTL
// it lands at the leading edge of the line where the eye hits it first.
//
// This is an explicit reviewed map, not a regex, because several entries need
// judgment rather than stripping: generic values that didn't identify the
// mosque at all (Kilwa, Siwa were both just "المسجد الكبير"), a truncation
// (Washington), a stray leading و (Sultan Hasan), a missing letter
// (Djamaa el Djazaïr), a Latin-script value that had no business being there
// (Hazrat Tawakkal Mastan), and a missing value (Pavlodar).
//
// Deliberately NOT stripped: Masjid al-Haram, Al-Masjid an-Nabawi and
// Taj-ul-Masajid, where the word for mosque is inseparable from the name.
//
// Usage: node migrations/clean-mosque-references.js [--apply]

import "dotenv/config";
import { fetchEntities, bulkSetFields } from "../database.js";

const apply = process.argv.includes("--apply");

const REFERENCES = {
  "abu-al-abbas-al-mursi": "أبو العباس المرسي",
  "abu-dahab": "أبو الدهب",
  "abu-hagag": "أبو الحجاج",
  "abuja": "أبوجا الوطني",
  "agadez": "أغاديز",
  "al-abrar": "أبرار",
  "al-aqsa": "الأقصى",
  "al-askari": "العسكري",
  "al-azhar": "الأزهر",
  "al-fatah": "الفتح",
  "al-fateh": "الفاتح",
  "al-mohammadi": "المحمدي",
  "al-nejashi": "النجاشي",
  "al-omari": "العمري الكبير",
  "al-qiblatayn": "القِبْلَتَيْن",
  "al-rifai": "الرفاعي",
  "al-salam": "السلام",
  "al-saleh": "الصالح",
  "ar-rahma": "الرحمة",
  "astana": "أستانا الكبير",
  "atiq-awjila": "عتیق",
  "bab-al-mardum": "باب المردوم",
  "babri-masjid": "بابري",
  "badjanani": "بادجاناني",
  "bajrakli": "بجراكلي",
  "ben-youssef": "ابن يوسف",
  "blue-mosque": "السلطان أحمد",
  "chinguetti": "شنقيط",
  "cordoba": "قرطبة",
  "cotonou": "كوتونو",
  "cristo-de-la-luz": "باب المردوم",
  "dakar": "داكار الكبير",
  "djamaa-el-djazair": "الجزائر",
  "djenne": "جينيه الكبير",
  "djingareyber": "جينغربر",
  "dubai-grand-mosque": "دبي الكبير",
  "ethem-bey": "أدهم باي",
  "faisal": "فیصل",
  "fakr-ad-din": "فخر الدين",
  "faycal": "كوناكري الكبير",
  "gaddafi": "القذافي",
  "gaza": "العمري الكبير",
  "gazi-husrev": "الغازي خسرو بك",
  "giralda": "إشبيلية",
  "grand-jamia": "گرینڈ جامع",
  "guediawaye": "جيديويه",
  "hadum": "هادوم",
  "haji-piyada": "الحاج بيادا",
  "hassan-ii": "الحسن الثاني",
  "hazrat-tawakkal-mastan-dargah": "حضرت توكل مستان",
  "herat": "هرات",
  "husseini": "الحسيني الكبير",
  "ibrahimi": "الإبراهيمي",
  "istiqlal": "الاستقلال",
  "jamkaran": "جمکران",
  "juma": "الجمعة في شماخى",
  "kairouan": "القيروان الأكبر",
  "kano": "كانو الكبير",
  "kasbah": "القصبة",
  "khamis": "ٱلْخَمِيسِ",
  "kharkiv": "كاتدرائية خاركيف",
  "khartoum": "الخرطوم الكبير",
  "kilwa": "كيلوة الكبير",
  "king-khaled": "الملك خالد",
  "korijib": "كوريجيب",
  "koutoubia": "الكتبية",
  "kufa": "ٱلْكُوفَة ٱلْمُعَظَّم",
  "kul-sharif": "قول شريف",
  "lagos": "لاغوس المركزي",
  "larabanga": "لارابانجا",
  "las-tornerias": "ترنرياس",
  "makhachkala": "محج قلعة",
  "malindi": "ماليندي",
  "massawa": "ٱلصَّحَابَة",
  "mescid-i-aksa": "الأقصى",
  "mohammed-ali": "محمد علي",
  "murad-agha": "مراد آغا",
  "oluwa-lowi": "أولوا لوي",
  "ouagadougou": "واغادوغو الكبير",
  "ouakam": "اللاهوت",
  "ould-el-hamra": "ولد الحمراء",
  "paris": "باريس الكبير",
  "pavlodar": "بافلودار",
  "powers-street": "باورز ستريت",
  "qatar": "دولة قطر",
  "quba": "قُبَاء",
  "riyadha-lamu": "رياض",
  "samarra": "سَامَرَّاء ٱلْكَبِيْر",
  "sanaa": "صنعاء الكبير",
  "sheikh-zayed": "ٱلشَّيْخ زَايِد",
  "siwa-oasis": "سيوة الكبير",
  "sultan-al-muayyad": "السلطان المؤيد",
  "sultan-hasan": "السلطان حسن",
  "sultan-qaboos": "ٱلسُّلْطَان قَابُوْس",
  "sultanovskaya-mechet": "السلطان",
  "touba": "طوبى الكبير",
  "uganda-national-mosque": "أوغندا الوطني",
  "umayyad": "الْأُمَوِي",
  "washington": "المركز الإسلامي بواشنطن",
  "white-mosque": "الأبيض",
};

// Trailing space in the name field.
const NAMES = { "al-fatah": "Al-Fatah" };

const entities = await fetchEntities({ list: "mosques" });
const byKey = new Map(entities.map((e) => [e.key, e]));

const updates = [];
const missing = [];
let unchanged = 0;

for (const [key, reference] of Object.entries(REFERENCES)) {
  const e = byKey.get(key);
  if (!e) { missing.push(key); continue; }
  const fields = {};
  if (e.reference !== reference) fields.reference = reference;
  if (NAMES[key] && e.name !== NAMES[key]) fields.name = NAMES[key];
  if (Object.keys(fields).length === 0) { unchanged++; continue; }
  updates.push({ _id: e._id, fields, key, before: e.reference ?? "(none)" });
}

for (const u of updates) {
  const before = u.before;
  const after = u.fields.reference ?? "(name only)";
  const saved = before === "(none)" ? "" : ` (${before.length} → ${after.length})`;
  console.log(`${u.key.padEnd(32)} ${before}   →   ${after}${saved}`);
}

const totalBefore = updates.reduce((n, u) => n + (u.before === "(none)" ? 0 : u.before.length), 0);
const totalAfter  = updates.reduce((n, u) => n + (u.fields.reference?.length ?? 0), 0);

console.log(`\n${updates.length} to change, ${unchanged} already correct, ${entities.length} on the list.`);
console.log(`Characters: ${totalBefore} → ${totalAfter} (${totalBefore - totalAfter} saved).`);
if (missing.length) console.log(`NOT FOUND: ${missing.join(", ")}`);

if (!apply) {
  console.log("\nDry run. Re-run with --apply to write.");
  process.exit(0);
}

await bulkSetFields(updates.map(({ _id, fields }) => ({ _id, fields })));
console.log(`\nApplied ${updates.length} updates.`);
process.exit(0);
