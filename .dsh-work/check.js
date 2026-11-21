const fs = require('fs');
const zlib = require('zlib');

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
  return { fd, header: JSON.parse(payload.subarray(4, 4 + jsonLen).toString('utf8')), dataOffset: 8 + size };
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

function readFile(p) {
  const n = nodeAt(header, p);
  if (!n || n.files) return null;
  const size = Number(n.size);
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, dataOffset + Number(n.offset));
  return buf.toString('utf8');
}

// 1) package names referenced by preset-standard
const standard = readFile('dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml');
const names = [...new Set([...standard.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]))].sort();
console.log('== preset-standard referenced plugins:', names.length);
for (const name of names) {
  if (!name.startsWith('@') && !name.startsWith('dsh-')) { console.log('  special:', name); continue; }
  const pkg = 'dsh/node_modules/' + name.replace(/\/tools$/, '') + '/package.json';
  const n = nodeAt(header, pkg);
  console.log('  ' + (n ? 'OK      ' : 'MISSING ') + name + (n ? '' : '  (' + pkg + ')'));
}

// 2) same for preset-cordis, to diff
const cordis = readFile('dsh/node_modules/@deepseek-ai/dsh-web-app/presets/cordis.patch.yml');
const cnames = [...new Set([...cordis.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]))].sort();
console.log('\n== in cordis but not standard:', cnames.filter((n) => !names.includes(n)).join(', '));
console.log('== in standard but not cordis:', names.filter((n) => !cnames.includes(n)).join(', '));

// 3) does standard config contain a delegation group and subagent rows?
const hasDelegation = /id:\s*delegation/.test(standard) && /dsh-tool-subagent/.test(standard);
console.log('\n== standard has delegation group + dsh-tool-subagent:', hasDelegation);

// 4) parent session header
const sessionsRoot = 'C:/Users/Administrator/.dsh/sessions/--C-Users-Administrator-Documents-deepseek-harness-default-workspace--';
for (const dir of ['session-eadf5f9d-30d9-48b5-8c7f-e07118f241fa', 'dcc34ac0-f887-4032-9dde-b8b8f26ed30b']) {
  const p = sessionsRoot + '/' + dir + '/session.v4.jsonl.zstd';
  try {
    const j = JSON.parse(zlib.zstdDecompressSync(fs.readFileSync(p)).toString('utf8').split('\n')[0]);
    console.log('session', j.id, 'preset=', j.agentPreset, 'origin=', j.origin, 'parent=', j.parentSession);
  } catch (e) { console.log('session', dir, 'ERR', e.message); }
}
