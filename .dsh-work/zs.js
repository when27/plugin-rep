const fs=require('fs'), zlib=require('zlib');
const p=process.argv[2];
const buf=fs.readFileSync(p);
let out;
try { out = zlib.zstdDecompressSync ? zlib.zstdDecompressSync(buf) : null; } catch(e) { console.error('ERR',e.message); process.exit(1); }
const txt=out.toString('utf8');
const lines=txt.split('\n');
console.log('lines',lines.length);
for (const l of lines.slice(0,40)) {
  if (/preset|model|agent/i.test(l)) console.log(l.slice(0,400));
}
