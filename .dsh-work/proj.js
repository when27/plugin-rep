const fs=require('fs'), path=require('path');
const dir='C:/Users/Administrator/.dsh/storages/session_projcache/sessions';
for (const f of fs.readdirSync(dir)) {
  try {
    const j=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));
    const s=JSON.stringify(j);
    const m=s.match(/"modelSelection":\s*(\{[^}]*\})/);
    const p=s.match(/"agentPreset":\s*(\{[^}]*\})/);
    if (!m && !p) continue;
    console.log(f.replace('.json',''), '|', m?m[1]:'-', '|', p?p[1]:'-');
  } catch(e) {}
}
