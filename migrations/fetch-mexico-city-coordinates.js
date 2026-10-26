#!/usr/bin/env node
// Fetch missing or clearly misplaced Mexico City station coordinates from the
// linked Spanish Wikipedia pages. Prints JSON for review; does not write data.

import { pointLatLon } from "../../andrewzc-api/location.js";

const response = await fetch("https://api.andrewzc.net/pages/mexico-city/entities");
if (!response.ok) throw new Error(`Could not load stations: ${response.status}`);
const source = Object.fromEntries((await response.json()).entities.map(entity => [entity.key, entity]));
const auditAll = process.argv.includes("--audit-all");
const needsFix = Object.entries(source).filter(([key, entity]) => {
  if (key === "--info--") return false;
  if (auditAll) return true;
  const { lat, lon } = pointLatLon(entity.location) || {};
  return !Number.isFinite(lat) || !Number.isFinite(lon) ||
    lat < 19.2 || lat > 19.6 || lon < -99.3 || lon > -98.9;
});

const rows = needsFix.map(([key, entity]) => {
  const url = new URL(entity.link);
  if (url.hostname !== "es.wikipedia.org" || !url.pathname.startsWith("/wiki/")) {
    throw new Error(`No Spanish Wikipedia station link: ${key}`);
  }
  return { key, title: decodeURIComponent(url.pathname.slice(6)).replaceAll("_", " "), location: entity.location };
});

const updates = [];
const unresolved = [];
for (let i = 0; i < rows.length; i += 25) {
  const batch = rows.slice(i, i + 25);
  const url = new URL("https://es.wikipedia.org/w/api.php");
  url.search = new URLSearchParams({
    action: "query", format: "json", prop: "coordinates", colimit: "max",
    redirects: "1", titles: batch.map(row => row.title).join("|"),
  });
  const response = await fetch(url, { headers: { "User-Agent": "andrewzc-map/1.0 (coordinate verification)" } });
  if (!response.ok) throw new Error(`Wikipedia API returned ${response.status}`);
  const data = await response.json();
  const titleAliases = new Map();
  for (const alias of [...(data.query?.normalized || []), ...(data.query?.redirects || [])]) {
    titleAliases.set(alias.from, alias.to);
  }
  const pages = new Map(Object.values(data.query?.pages || {}).map(page => [page.title, page]));
  for (const row of batch) {
    let title = row.title;
    for (let j = 0; j < 3 && titleAliases.has(title); j++) title = titleAliases.get(title);
    const point = pages.get(title)?.coordinates?.[0];
    if (point && Number.isFinite(point.lat) && Number.isFinite(point.lon) &&
        point.lat >= 19.2 && point.lat <= 19.6 && point.lon >= -99.3 && point.lon <= -98.9) {
      const { lat: oldLat, lon: oldLon } = pointLatLon(row.location) || {};
      // Roughly 300 m; small differences between station entrances are fine.
      const distanceKm = Number.isFinite(oldLat) && Number.isFinite(oldLon)
        ? Math.hypot((point.lat - oldLat) * 111, (point.lon - oldLon) * 104)
        : Infinity;
      if (!auditAll || distanceKm > 0.3) updates.push({ key: row.key, title, lat: point.lat, lon: point.lon, previous: row.location || null, distanceKm });
    } else {
      unresolved.push({ key: row.key, title, page: pages.get(title)?.title || null, point: point || null });
    }
  }
}

process.stdout.write(JSON.stringify({ updates, unresolved }) + "\n");
