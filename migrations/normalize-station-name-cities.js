#!/usr/bin/env node
// Normalize only the four imported station-name pages. Default: preview.
// node migrations/normalize-station-name-cities.js [--apply]
import 'dotenv/config';
import { MongoClient, BSON } from 'mongodb';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeKey, findNearestCity } from '../utilities.js';

const lists = ['metro-animals', 'metro-cars', 'metro-colors', 'metro-numbers'];
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export function mergeProps(dst = {}, src = {}) {
  const out = structuredClone(dst);
  for (const [key,value] of Object.entries(src)) {
    if (!(key in out)) out[key] = structuredClone(value);
    else if (same(out[key],value)) continue;
    else if (out[key] && value && typeof out[key] === 'object' && typeof value === 'object' && !Array.isArray(out[key]) && !Array.isArray(value)) out[key] = mergeProps(out[key],value);
    else throw new Error(`Conflicting prop ${key}`);
  }
  return out;
}
export function mergeRecord(dst, src, entry) {
  const out = { ...dst };
  for (const [key,value] of Object.entries(src)) {
    if (['_id','key','list','props','reference','city','updatedAt','coords'].includes(key)) continue;
    if (key === 'been') out.been = Boolean(dst.been || value);
    else if (Array.isArray(value) && Array.isArray(dst[key])) {
      // Preserve repeated icons within the original array; union only new values.
      out[key] = [...dst[key], ...value.filter(v => !dst[key].some(a => same(a,v)))];
    } else if (out[key] == null || out[key] === '') out[key] = value;
    // Existing canonical station metadata wins on conflicting scalar fields.
  }
  out.props = mergeProps(dst.props,src.props);
  if (src.reference && src.reference !== entry.city) {
    for (const list of lists.filter(key => src.props?.[key] !== undefined)) {
      const value = out.props[list];
      if (Array.isArray(value)) throw new Error(`Cannot preserve translated reference on ${src.key}`);
      out.props[list] = { ...(typeof value === 'object' ? value : { value }), alternateName: src.reference };
    }
  }
  return { ...out, key: entry.newKey, city: entry.city, reference: entry.city };
}

export async function run({ apply = false } = {}) {
  const plan = JSON.parse(fs.readFileSync(new URL('./station-name-city-plan.json', import.meta.url)));
  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || 'andrewzc');
    const entities = db.collection('entities');
    const routes = db.collection('routes');
    const operations = [];
    for (const entry of plan) {
      if (computeKey({name:entry.name,reference:entry.city},['reference-key','reference-first']) !== entry.newKey) throw new Error(`Invalid planned key: ${entry.oldKey}`);
      const src = await entities.findOne({list:'stations',key:entry.oldKey});
      const dst = await entities.findOne({list:'stations',key:entry.newKey});
      if (!src) {
        if (!dst || !lists.some(k => dst.props?.[k] !== undefined)) throw new Error(`Missing source and migrated target: ${entry.oldKey}`);
        continue;
      }
      if (!lists.some(k => src.props?.[k] !== undefined)) throw new Error(`Out-of-scope source ${entry.oldKey}`);
      if (src.name !== entry.name) throw new Error(`Source name changed: ${entry.oldKey}`);
      if (src.images?.length) throw new Error(`Review image handling: ${entry.oldKey}`);
      const merged = mergeRecord(dst || src,src,entry);
      const location = src.location || dst?.location;
      const nearest = location ? await findNearestCity(location,entities) : null;
      console.log(`${dst ? 'MERGE' : 'REKEY'} ${entry.oldKey} -> ${entry.newKey}${nearest ? `; radius city: ${nearest}` : '; city from reviewed evidence'}`);
      operations.push({ entry, src, dst, merged, nearest });
    }
    const changes = new Map(operations.map(o => [o.entry.oldKey,o.entry.newKey]));
    const routeDocs = await routes.find({'stops':{$elemMatch:{list:'stations',key:{$in:[...changes.keys()]}}}}).toArray();
    const summary = { records:operations.length, rekeyed:operations.filter(o=>!o.dst).length, merged:operations.filter(o=>o.dst).length, routes:routeDocs.length };
    console.log(JSON.stringify(summary));
    if (!apply || !operations.length) return summary;
    const backup = `/tmp/station-name-city-backup-${Date.now()}.json`;
    fs.writeFileSync(backup,BSON.EJSON.stringify({ operations, routes:routeDocs },null,2));
    console.log(`Backup: ${backup}`);
    const session = client.startSession();
    try {
      await session.withTransaction(async()=>{
        for (const {src,dst,merged} of operations) {
          for (const original of [src,...(dst?[dst]:[])]) {
            const live = await entities.findOne({_id:original._id},{session});
            if (BSON.EJSON.stringify(live) !== BSON.EJSON.stringify(original)) throw new Error(`Concurrent change: ${original.key}`);
          }
          const target = dst || src;
          await entities.replaceOne({_id:target._id},{...merged,_id:target._id,updatedAt:new Date()},{session});
          if (dst) await entities.deleteOne({_id:src._id},{session});
        }
        for (const route of routeDocs) {
          const stops = route.stops.map(stop => stop.list === 'stations' && changes.has(stop.key) ? {...stop,key:changes.get(stop.key)} : stop);
          const result = await routes.updateOne({_id:route._id,stops:route.stops},{$set:{stops}},{session});
          if (result.matchedCount!==1) throw new Error(`Concurrent route change: ${route.key}`);
        }
      });
    } finally { await session.endSession(); }
    for (const {entry,src,dst,merged} of operations) {
      const live = await entities.findOne({list:'stations',key:entry.newKey});
      if (!live || live.reference!==entry.city || live.city!==entry.city || !same(live.props,merged.props) || live.been!==merged.been || !same(live.images,merged.images)) throw new Error(`Verification failed: ${entry.newKey}`);
      if (await entities.findOne({list:'stations',key:src.key})) throw new Error(`Old key remains: ${src.key}`);
    }
    for(const route of await routes.find({_id:{$in:routeDocs.map(r=>r._id)}}).toArray()) {
      for(const stop of route.stops.filter(s=>s.list==='stations')) {
        if (!await entities.findOne({list:'stations',key:stop.key})) throw new Error(`Broken route stop: ${stop.key}`);
      }
    }
    console.log('Verified city references, keys, all props, visit status, images, and affected route stops.');
    return summary;
  } finally { await client.close(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await run({apply:process.argv.includes('--apply')});
