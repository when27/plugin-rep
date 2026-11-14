const fs = require('fs');

const archive = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar';

function load() {
  const fd = fs.openSync(archive, 'r');
  const b = Buffer.alloc(8);
  fs.readSync(fd, b, 0, 8, 0);
  const size = b.readUInt32LE(4);
  const hb = Buffer.alloc(size);
  fs.readSync(fd, hb, 0, size, 8);
  const payload = hb.subarray(4);
  const jsonLen = payload.readUInt32LE(0);
  const json = payload.subarray(4, 4 + jsonLen).toString('utf8');
  return { fd, header: JSON.parse(json), dataOffset: 8 + size };
}

function nodeAt(header, p) {
  const parts = p.split('/').filter(Boolean);
  let cur = header;
  for (const part of parts) {
    if (!cur.files || !cur.files[part]) return null;
    cur = cur.files[part];
  }
  return cur;
}

const { fd, header, dataOffset } = load();
const target = process.argv[2] || '';
const mode = process.argv[3] || 'list';
const node = nodeAt(header, target);
if (!node) {
  console.error('NOT FOUND: ' + target);
  process.exit(2);
}
if (node.files) {
  const names = Object.keys(node.files).sort();
  console.log(names.map((n) => (node.files[n].files ? n + '/ (dir)' : n + '  ' + node.files[n].size)).join('\n'));
} else if (mode === 'cat') {
  if (node.unpacked) {
    console.error('UNPACKED: read from app.asar.unpacked');
    process.exit(3);
  }
  const size = Number(node.size);
  const off = dataOffset + Number(node.offset);
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, off);
  process.stdout.write(buf.toString('utf8'));
} else {
  console.log(JSON.stringify({ size: node.size, offset: node.offset, unpacked: !!node.unpacked }));
}
