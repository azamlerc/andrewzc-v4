// utilities.js — shared pure utility functions for andrewzc-v4 and andrewzc-api.
//
// No database or HTTP dependencies. Safe to import anywhere.

// ── Key / name helpers ────────────────────────────────────────────────────────

/**
 * Convert a name to a URL-safe key.
 */
export function simplify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ /g, "-")
    .replace(/[''\u2018\u2019\u201c\u201d]/g, "")   // straight + curly quotes
    .replace(/[()]/g, "")                            // parentheses: strip
    .replace(/[.,]/g, "")
    .replace(/[*"<>/&\u2013\u2014]/g, "-")           // separators → hyphen
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")                 // strip diacritics
    .replace(/-+/g, "-")                             // collapse hyphens
    .replace(/^-+|-+$/g, "")                         // trim leading/trailing
    .replace(/^the-/, "");
}

/**
 * Compute the entity key from its fields and the page's tags.
 */
export function computeKey({ name, reference, country }, pageTags = []) {
  const referenceKey   = pageTags.includes("reference-key");
  const referenceFirst = pageTags.includes("reference-first");
  const countryKey     = pageTags.includes("country-key");
  const cc = country ? String(country).toUpperCase() : null;
  if (countryKey && cc && !String(name).includes(",")) return simplify(`${name} ${cc}`);
  if (referenceKey && reference) return simplify(referenceFirst ? `${reference} ${name}` : `${name} ${reference}`);
  return simplify(name);
}

// ── Coords helpers ────────────────────────────────────────────────────────────

/**
 * Parse a coords string into { lat, lon } decimal degrees.
 * Accepts decimal, DMS, and mixed formats. Returns null if unparseable.
 */
export function parseCoords(s) {
  if (!s) return null;
  const parts = String(s).split(",");
  if (parts.length < 2) return null;
  const lat = parseOneCoord(parts[0].trim(), "lat");
  const lon = parseOneCoord(parts.slice(1).join(",").trim(), "lon");
  if (lat == null || lon == null) return null;
  return { lat, lon };
}

export function isDmsCoords(s) {
  return s != null && String(s).includes("°");
}

export function formatCoords({ lat, lon }) {
  return `${lat}, ${lon}`;
}

// ── Flag / country helpers ────────────────────────────────────────────────────

export function countryCodeToFlagEmoji(code) {
  const upper = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return null;
  return [...upper].map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join("");
}

export function flagEmojiToCountryCode(emoji) {
  if (!emoji) return null;
  const codePoints = [...emoji].map(c => c.codePointAt(0));
  if (codePoints.length !== 2) return null;
  if (!codePoints.every(cp => cp >= 0x1F1E6 && cp <= 0x1F1FF)) return null;
  return codePoints.map(cp => String.fromCharCode(cp - 0x1F1E6 + 65)).join("");
}

export function countryCodesFromIcons(icons = []) {
  return icons.map(flagEmojiToCountryCode).filter(Boolean);
}

// ── Geo / city lookup ─────────────────────────────────────────────────────────

/**
 * Find the nearest city within radiusKm kilometres of the given location.
 * Requires a MongoDB collection handle.
 * Returns the city name string, or null.
 */
export async function findNearestCity(location, entitiesCollection, radiusKm = 30) {
  const geoPoint = location.type === "Point"
    ? location
    : { type: "Point", coordinates: [location.lon, location.lat] };

  const results = await entitiesCollection
    .find(
      { list: "cities", location: { $nearSphere: { $geometry: geoPoint, $maxDistance: radiusKm * 1000 } } },
      { projection: { name: 1, _id: 0 } }
    )
    .limit(1)
    .toArray();

  return results[0]?.name ?? null;
}

// ── Display helpers ───────────────────────────────────────────────────────────

/**
 * Convert a dashed key like "den-haag" or "new-york-ny" to a display name.
 * If the last token is 2 letters, treats it as a state/province code: "New York, NY".
 */
export function cityKeyToDisplayName(key) {
  const parts = String(key || "").split("-").filter(Boolean);
  if (parts.length === 0) return "";
  const last = parts[parts.length - 1];
  const rest = parts.slice(0, -1);
  if (last.length === 2 && rest.length > 0) {
    return `${rest.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")}, ${last.toUpperCase()}`;
  }
  return parts.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ── Internal coord parser ─────────────────────────────────────────────────────

const isCleanDecimal = (s) => /^-?\d+(?:\.\d+)?$/.test(s);

function parseOneCoord(raw, kind) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;

  s = s.replace(/\u2032/g, "'").replace(/\u2033/g, '"');

  const hemiMatch = s.match(/[NSEW]/i);
  const hemi      = hemiMatch ? hemiMatch[0].toUpperCase() : null;

  s = s.replace(/[NSEW]/gi, "").replace(/\s+/g, "");

  if (s.includes("°")) {
    const m = s.match(/^(-?\d+(?:\.\d+)?)°(?:(\d+(?:\.\d+)?)')?(?:(\d+(?:\.\d+)?)")?$/);
    if (!m) return null;
    const deg = Number(m[1]);
    const min = m[2] != null ? Number(m[2]) : 0;
    const sec = m[3] != null ? Number(m[3]) : 0;
    if (!Number.isFinite(deg) || !Number.isFinite(min) || !Number.isFinite(sec)) return null;
    if (min < 0 || min >= 60 || sec < 0 || sec >= 60) return null;
    let val  = Math.abs(deg) + min / 60 + sec / 3600;
    let sign = deg < 0 ? -1 : 1;
    if (hemi === "S" || hemi === "W") sign = -1;
    if (hemi === "N" || hemi === "E") sign = 1;
    val *= sign;
    const max = kind === "lat" ? 90 : 180;
    if (Math.abs(val) > max) return null;
    return val;
  }

  s = s.replace(/°/g, "");
  if (!isCleanDecimal(s)) return null;
  let val = Number(s);
  if (!Number.isFinite(val)) return null;
  if (hemi) {
    const abs = Math.abs(val);
    val = (hemi === "S" || hemi === "W") ? -abs : abs;
  }
  const max = kind === "lat" ? 90 : 180;
  if (Math.abs(val) > max) return null;
  return val;
}
