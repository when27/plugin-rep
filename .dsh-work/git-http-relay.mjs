// Minimal loopback smart-HTTP relay for git: git's schannel TLS backend cannot
// acquire credentials in this sandbox, while Node's OpenSSL TLS works. Git talks
// plain HTTP to this loopback server, which forwards the exact smart-HTTP
// request to github.com over TLS with the stored credential attached.
//
// Env: DSH_CRED_FILE (git-credential-manager "get" output), DSH_PORT_FILE.
// Only /when27/plugin-rep.git/* is served, and only on 127.0.0.1.
import http from 'node:http'
import https from 'node:https'
import { readFileSync, writeFileSync } from 'node:fs'

const credText = readFileSync(process.env.DSH_CRED_FILE, 'utf8')
const cred = Object.fromEntries(
  credText
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf('=')
      return [line.slice(0, at), line.slice(at + 1)]
    }),
)
const auth = `Basic ${Buffer.from(`${cred.username}:${cred.password}`).toString('base64')}`
const agent = new https.Agent({ keepAlive: false })

const server = http.createServer((req, res) => {
  if (!req.url?.startsWith('/when27/plugin-rep.git/')) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
    return
  }
  const headers = { ...req.headers, host: 'github.com', authorization: auth }
  delete headers.connection
  const upstream = https.request(
    { hostname: 'github.com', port: 443, path: req.url, method: req.method, headers, agent },
    (upstreamRes) => {
      const outHeaders = { ...upstreamRes.headers }
      delete outHeaders.connection
      res.writeHead(upstreamRes.statusCode ?? 502, outHeaders)
      upstreamRes.pipe(res)
    },
  )
  upstream.on('error', (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`upstream error: ${error.message}`)
    } else {
      res.destroy(error)
    }
  })
  req.on('aborted', () => upstream.destroy())
  req.pipe(upstream)
})

server.listen(0, '127.0.0.1', () => {
  writeFileSync(process.env.DSH_PORT_FILE, String(server.address().port))
  console.log(`relay listening on 127.0.0.1:${server.address().port}`)
})
