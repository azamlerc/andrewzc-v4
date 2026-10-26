#!/usr/bin/env node
// Add Mexico City Metro lines to the routes collection.
// Run from andrewzc-v4:
//   node migrations/import-mexico-city-routes.js --dryrun
//   node migrations/import-mexico-city-routes.js
//
// Routes reference the same stations entities that the propertyOf page shows.
// The local Mexico City data provides their order and names; the database
// resolves names to canonical station keys, which may differ from old keys.

import "dotenv/config";
import { MongoClient } from "mongodb";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = JSON.parse(readFileSync(fileURLToPath(new URL("../../andrewzc.net/data/mexico-city.json", import.meta.url)), "utf8"));

const LINES = [
  ["1", "#f04a9b", ["observatorio", "tacubaya", "juanacatlan", "chapultepec", "sevilla", "insurgentes", "cuauhtemoc", "balderas", "salto-del-agua", "isabel-la-catolica", "pino-suarez", "merced", "candelaria", "san-lazaro", "moctezuma", "balbuena", "boulevard-puerto-aereo", "gomez-farias", "zaragoza", "pantitlan"]],
  ["2", "#005ca9", ["cuatro-caminos", "panteones", "tacuba", "cuitlahuac", "popotla", "colegio-militar", "normal", "san-cosme", "revolucion", "hidalgo", "bellas-artes", "allende", "zocalo", "pino-suarez", "san-antonio-abad", "chabacano", "viaducto", "xola", "villa-de-cortes", "nativitas", "portales", "ermita", "general-anaya", "tasquena"]],
  ["3", "#b5b35c", ["indios-verdes", "deportivo-18-de-marzo", "potrero", "la-raza", "tlatelolco", "guerrero", "hidalgo", "juarez", "balderas", "ninos-heroes", "hospital-general", "centro-medico", "etiopia", "eugenia", "division-del-norte", "zapata", "coyoacan", "viveros-derechos-humanos", "miguel-angel-de-quevedo", "copilco", "universidad"]],
  ["4", "#6cc5b3", ["martin-carrera", "talisman", "bondojito", "consulado", "canal-del-norte", "morelos", "candelaria", "fray-servando", "jamaica", "santa-anita"]],
  ["5", "#f7c600", ["pantitlan", "hangares", "terminal-aerea", "oceania", "aragon", "eduardo-molina", "consulado", "valle-gomez", "misterios", "la-raza", "autobuses-del-norte", "instituto-del-petroleo", "politecnico"]],
  ["6", "#e21e26", ["el-rosario", "tezozomoc", "azcapotzalco", "ferreria", "norte-45", "vallejo", "instituto-del-petroleo", "lindavista", "deportivo-18-de-marzo", "la-villa-basilica", "martin-carrera"]],
  ["7", "#f7931e", ["el-rosario", "aquiles-serdan", "camarones", "refineria", "tacuba", "san-joaquin", "polanco", "auditorio", "constituyentes", "tacubaya", "san-pedro-de-los-pinos", "san-antonio", "mixcoac", "barranca-del-muerto"]],
  ["8", "#008c45", ["garibaldi", "bellas-artes", "san-juan-de-letran", "salto-del-agua", "doctores", "obrera", "chabacano", "la-viga", "santa-anita", "coyuya", "iztacalco", "apatlaco", "aculco", "escuadron-201", "atlalilco", "iztapalapa", "cerro-de-la-estrella", "uam-iztapalapa", "constitucion-de-1917"]],
  ["9", "#a66a4c", ["tacubaya", "patriotismo", "chilpancingo", "centro-medico", "lazaro-cardenas", "chabacano", "jamaica", "mixiuhca", "velodromo", "ciudad-deportiva", "puebla", "pantitlan"]],
  ["A", "#8f1d8f", ["pantitlan", "agricola-oriental", "canal-de-san-juan", "tepalcates", "guelatao", "penon-viejo", "acatitla", "santa-marta", "los-reyes", "la-paz"]],
  ["B", "#8e8e8e", ["ciudad-azteca", "plaza-aragon", "olimpica", "ecatepec", "muzquiz", "rio-de-los-remedios", "impulsora", "nezahualcoyotl", "villa-de-aragon", "bosque-de-aragon", "deportivo-oceania", "oceania", "romero-rubio", "ricardo-flores-magon", "san-lazaro", "morelos", "tepito", "lagunilla", "garibaldi", "guerrero", "buenavista"]],
  ["12", "#c3a500", ["tlahuac", "tlaltenco", "zapotitlan", "nopalera", "olivos", "tezonco", "periferico-oriente", "calle-11", "lomas-estrella", "san-andres-tomatlan", "culhuacan", "atlalilco", "mexicaltzingo", "ermita", "eje-central", "parque-de-los-venados", "zapata", "hospital-20-de-noviembre", "insurgentes-sur", "mixcoac"]],
];

function hasCoordinates(entity) {
  const point = entity?.location?.type === "Point" ? entity.location.coordinates : null;
  const pair = Array.isArray(point) ? [point[1], point[0]] : [];
  const [lat, lon] = pair;
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= 19.2 && lat <= 19.6 && lon >= -99.3 && lon <= -98.9;
}

function buildRoutes(entities) {
  const byName = new Map();
  for (const entity of entities) {
    if (byName.has(entity.name)) throw new Error(`Ambiguous Mexico City station name: ${entity.name}`);
    byName.set(entity.name, entity);
  }
  const routes = [];
  for (const [line, color, stationKeys] of LINES) {
    const drawable = stationKeys.map(key => byName.get(source[key]?.name)).filter(hasCoordinates);
    if (drawable.length < 2) throw new Error(`Line ${line} has fewer than two drawable stations`);
    routes.push({
      key: `mexico-city-line-${line.toLowerCase()}`,
      name: `Mexico City Line ${line}`,
      mode: "rail",
      trips: ["mexico-city"],
      style: { lineType: "solid", weight: 6, color },
      stops: drawable.map(entity => ({ list: "stations", key: entity.key })),
      path: { kind: "straight" },
    });
    console.error(`Line ${line}: ${drawable.length}/${stationKeys.length} stations have usable coordinates.`);
  }
  return routes;
}

const dryRun = process.argv.includes("--dryrun") || process.argv.includes("--dry-run");
if (!process.env.MONGODB_URI) throw new Error("Missing MONGODB_URI in environment");
const client = new MongoClient(process.env.MONGODB_URI);
try {
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || "andrewzc");
  const entities = await db.collection("entities").find({ list: "stations", "props.mexico-city": { $exists: true } }).toArray();
  const routes = buildRoutes(entities);
  const collection = db.collection("routes");
  const existing = await collection.find({ key: { $in: routes.map(route => route.key) } }).toArray();
  const pending = routes.filter(route => !existing.some(doc =>
    doc.key === route.key && JSON.stringify(doc.stops) === JSON.stringify(route.stops) &&
    JSON.stringify(doc.style) === JSON.stringify(route.style)));
  console.log(`${routes.length} lines; ${pending.length} to insert or refresh.`);
  if (dryRun) {
    for (const route of pending) console.log(JSON.stringify(route));
    console.log("DRY RUN: no changes written.");
  } else {
    await collection.createIndex({ key: 1 }, { unique: true });
    for (const route of pending) {
      await collection.updateOne({ key: route.key }, { $set: route, $unset: { color: "" } }, { upsert: true });
    }
    await db.collection("pages").updateOne({ key: "mexico-city" }, { $set: { script: "mexico-city.js" } });
    console.log(`Wrote ${pending.length} lines and enabled mexico-city.js on the page.`);
  }
} finally {
  await client.close();
}
