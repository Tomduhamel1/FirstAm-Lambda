// Builds DynamoDB batch-write files for the ZipCodes placeholder cleanup.
// Input:  fix.tsv (zip \t city \t county \t state, from GeoNames), delete.tsv (zip \t state)
// Output: batches/bNNNN.json (25 requests each), fix_clean.tsv, delete_clean.txt, summary
const fs = require('fs');
const path = require('path');
const dir = __dirname;

const fixRows = fs.readFileSync(path.join(dir, 'fix.tsv'), 'utf8').trim().split('\n').map(l => l.split('\t'));
const delRows = fs.readFileSync(path.join(dir, 'delete.tsv'), 'utf8').trim().split('\n').map(l => l.split('\t')[0]);

// Rows GeoNames leaves blank are military APO/FPO zips: not serviceable, treat as removals.
const usable = fixRows.filter(r => r[1] && r[2] && r[3]);
const blank = fixRows.filter(r => !(r[1] && r[2] && r[3])).map(r => r[0]);

// Table convention is "St. Johns"; the FirstAm request builder converts to "Saint" itself.
const fixes = usable.map(([zip, city, county, state]) => ({
    zip, city, county: county.replace(/^Saint /, 'St. '), state,
}));
const removals = Array.from(new Set([...delRows, ...blank])).sort();

fs.writeFileSync(path.join(dir, 'fix_clean.tsv'), fixes.map(f => [f.zip, f.city, f.county, f.state].join('\t')).join('\n') + '\n');
fs.writeFileSync(path.join(dir, 'delete_clean.txt'), removals.join('\n') + '\n');

const putReq = f => ({ PutRequest: { Item: { zip: { S: f.zip }, city: { S: f.city }, county_name: { S: f.county }, state_id: { S: f.state } } } });
const delReq = zip => ({ DeleteRequest: { Key: { zip: { S: zip } } } });
const all = [...fixes.map(putReq), ...removals.map(delReq)];

const outDir = path.join(dir, 'batches');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir);
let n = 0;
for (let i = 0; i < all.length; i += 25) {
    n++;
    fs.writeFileSync(path.join(outDir, 'b' + String(n).padStart(4, '0') + '.json'), JSON.stringify({ ZipCodes: all.slice(i, i + 25) }));
}
console.log(`updates=${fixes.length} removals=${removals.length} batches=${n}`);
console.log('St. conversions:', fixes.filter(f => f.county.startsWith('St. ')).map(f => f.zip + ' ' + f.county).join(', '));
