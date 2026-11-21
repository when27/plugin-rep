const fs=require('fs'), path=require('path'), zlib=require('zlib');
const dir='C:/Users/Administrator/.dsh/storages/session_projcache/sessions';
const sessionsRoot='C:/Users/Administrator/.dsh/sessions/--C-Users-Administrator-Documents-deepseek-harness-default-workspace--';
for (const f of fs.readdirSync(dir)) {
  try {
    const j=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));
    const s=JSON.stringify(j);
    const p=s.match(/"agentPreset":\{[^}]*"val":"([^"]+)"/);
    const m=s.match(/"modelSelection":\{[^}]*"val":\{"lastUsed":\{"provider":"([^"]+)","model":"([^"]+)"/);
    if (!p || p[1]!=='standard') continue;
    const id=f.replace('.json','');
    const zpath=path.join(sessionsRoot, id, 'session.v4.jsonl.zstd');
    let sub='?', subTools='?', lines=0;
    if (fs.existsSync(zpath)) {
      const txt=zlib.zstdDecompressSync(fs.readFileSync(zpath)).toString('utf8');
      lines=txt.split('\n').length;
      sub=(txt.match(/"subagent"/g)||[]).length;
      subTools=(txt.match(/subagent_fork|tool-subagent/g)||[]).length;
    }
    console.log(id, '| model=', m?m[1]+'/'+m[2]:'-', '| logLines=',lines, '| "subagent" hits=',sub, '| fork/tool hits=',subTools);
  } catch(e) { console.log(f,'ERR',e.message); }
}
