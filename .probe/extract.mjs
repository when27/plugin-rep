import fs from 'node:fs'
import path from 'node:path'
const p='C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const fd=fs.openSync(p,'r');const b=Buffer.alloc(16);fs.readSync(fd,b,0,16,0)
const n=b.readUInt32LE(12);const hb=Buffer.alloc(n);fs.readSync(fd,hb,0,n,16)
const j=JSON.parse(hb.toString());const base=16+n
const all=[]
function walk(node,prefix){for(const [k,v] of Object.entries(node.files||{})){const p2=prefix?prefix+'/'+k:k;if(v.files)walk(v,p2);else all.push({path:p2,offset:Number(v.offset),size:v.size})}}
walk(j,'')
const prefix=process.argv[2]; if(!prefix){console.error('usage: node extract.mjs <path-prefix> [outdir]');process.exit(1)}
const outdir=process.argv[3]||('.probe-extract/'+prefix.replace(/[^a-z0-9]+/gi,'_').slice(0,60))
let count=0
for(const f of all){if(!f.path.startsWith(prefix))continue
  const dest=path.join(outdir, f.path.slice(prefix.length))
  fs.mkdirSync(path.dirname(dest),{recursive:true})
  const buf=Buffer.alloc(f.size);fs.readSync(fd,buf,0,f.size,base+f.offset)
  fs.writeFileSync(dest,buf);count++
}
console.log('extracted',count,'to',outdir)
