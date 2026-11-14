// Build both halves of the plugin:
//   dist/client.js - web client bundle in the DSH client-module loader format
//                    (window.__ModuleLoader__.load factory receiving `require`)
//   dist/index.js  - ESM host entry
//   dist/host/*.js - ESM host modules (store/collector/transport/route)
//
// TypeScript is not a plugin dependency of this checkout; resolve it from the
// known workspace locations explicitly and fail loudly when missing.
//
// Usage: npm run build

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const clientSourcePath = join(root, 'src', 'index.tsx')
const hostSourcePath = join(root, 'src', 'host.ts')
const hostDir = join(root, 'src', 'host')
const outDir = join(root, 'dist')
const hostOutDir = join(outDir, 'host')

async function resolveTypeScript() {
  const candidates = [
    join(root, 'node_modules', 'typescript'),
    join(root, '..', '..', 'usage-popup', 'node_modules', 'typescript'),
  ]
  for (const candidate of candidates) {
    const entry = join(candidate, 'lib', 'typescript.js')
    if (existsSync(entry)) {
      const module = await import(pathToFileURL(entry).href)
      return module.default ?? module
    }
  }
  throw new Error(
    `typescript not found; looked in:\n${candidates.map((candidate) => `  ${candidate}`).join('\n')}`,
  )
}

function transpile(ts, sourcePath, source, moduleKind, jsx) {
  const compiled = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: moduleKind,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      ...(jsx === undefined ? {} : { jsx }),
      esModuleInterop: true,
      sourceMap: false,
      removeComments: false,
      newLine: ts.NewLineKind.LineFeed,
    },
    reportDiagnostics: true,
  })
  const errors = (compiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  if (errors.length > 0) {
    const formatHost = {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    }
    throw new Error(ts.formatDiagnostics(errors, formatHost))
  }
  return compiled.outputText.replace(/\r\n/g, '\n').trimEnd()
}

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const ts = await resolveTypeScript()

const clientSource = await readFile(clientSourcePath, 'utf8').catch(() => {
  throw new Error(`missing client source: ${clientSourcePath}`)
})
if (!existsSync(hostSourcePath)) throw new Error(`missing host source: ${hostSourcePath}`)
const hostSource = await readFile(hostSourcePath, 'utf8')

const clientBody = transpile(ts, clientSourcePath, clientSource, ts.ModuleKind.CommonJS, ts.JsxEmit.ReactJSX)
const indented = clientBody
  .split('\n')
  .map((line) => (line === '' ? line : `    ${line}`))
  .join('\n')
const clientBundle = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(manifest.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${indented}
    return module.exports;
  },
});
`

const hostModules = []
if (existsSync(hostDir)) {
  for (const entry of await readdir(hostDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    const sourcePath = join(hostDir, entry.name)
    hostModules.push({
      output: join(hostOutDir, entry.name.replace(/\.ts$/, '.js')),
      code: transpile(ts, sourcePath, await readFile(sourcePath, 'utf8'), ts.ModuleKind.ESNext),
    })
  }
}
hostModules.sort((a, b) => a.output.localeCompare(b.output))

const hostEntry = transpile(ts, hostSourcePath, hostSource, ts.ModuleKind.ESNext)

// Clean stale host output before writing the fresh set.
await rm(hostOutDir, { recursive: true, force: true })
await mkdir(hostOutDir, { recursive: true })
await writeFile(join(outDir, 'client.js'), clientBundle, 'utf8')
await writeFile(join(outDir, 'index.js'), `${hostEntry}\n`, 'utf8')
for (const module of hostModules) {
  await writeFile(module.output, `${module.code}\n`, 'utf8')
}

console.log(
  `built dist/index.js, dist/client.js and ${hostModules.length} host module(s)`,
)
