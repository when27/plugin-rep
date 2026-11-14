// Build the two halves of the plugin:
//   dist/index.js  - host entry (browser-only plugin: no host behaviour)
//   dist/client.js - web client bundle in the format the DSH client-module
//                    loader expects: a ModuleLoader factory that receives the
//                    external `require` (react, react-dom, ...).
//
// Usage: npm run build

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const sourcePath = join(root, 'src', 'index.tsx')
const outDir = join(root, 'dist')

const [source, manifestText] = await Promise.all([
  readFile(sourcePath, 'utf8'),
  readFile(join(root, 'package.json'), 'utf8'),
])
const manifest = JSON.parse(manifestText)

const compiled = ts.transpileModule(source, {
  fileName: sourcePath,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    jsx: ts.JsxEmit.ReactJSX,
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

const body = compiled.outputText.replace(/\r\n/g, '\n').trimEnd()
const indented = body
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

const hostEntry = `// Host half of ${manifest.name}: browser-only, so the host entry is inert.
export function apply() {}
`

await mkdir(outDir, { recursive: true })
await Promise.all([
  writeFile(join(outDir, 'client.js'), clientBundle, 'utf8'),
  writeFile(join(outDir, 'index.js'), hostEntry, 'utf8'),
])
console.log('built dist/client.js and dist/index.js')
