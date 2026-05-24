const old = JSON.parse(require('fs').readFileSync('import-progress/urinals-old.json')).map(p => p.uuid);
const fresh = JSON.parse(require('fs').readFileSync('import-progress/urinals.json')).map(p => p.uuid);
const onlyOld = old.filter(u => !fresh.includes(u));
const onlyFresh = fresh.filter(u => !old.includes(u));
console.log('Total old:', old.length, 'Total fresh:', fresh.length);
console.log('Only in old:', onlyOld.length);
console.log('Only in fresh:', onlyFresh.length);
