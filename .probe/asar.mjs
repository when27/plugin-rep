import fs from 'node:fs'
const p='C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const fd=fs.openSync(p,'r');const b=Buffer.alloc(16);fs.readSync(fd,b,0,16,0)
const n=b.readUInt32LE(12);const hb=Buffer.alloc(n);fs.readSync(fd,hb,0,n,16)
const j=JSON.parse(hb.toString());const base=16+n
const out=[]
function walk(node,prefix){for(const [k,v] of Object.entries(node.files||{})){const path=prefix?prefix+'/'+k:k;if(v.files)walk(v,path);else out.push({path,offset:Number(v.offset),size:v.size})}}
walk(j,'')
const q=(process.argv[2]||'').toLowerCase()
for(const f of out) if(!q||f.path.toLowerCase().includes(q)) console.log(f.size, f.path)
console.error('total files',out.length)
