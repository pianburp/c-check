// Tiny sample app for the R10 eval cases. Safe by default: nothing private is sent without a session.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const records = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'records.json'), 'utf8'))
const hasSession = req => /(?:^|;\s*)session=\w+/.test(req.headers.cookie || '')

const page = (title, body) => `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title></head>\n<body>\n${body}\n</body></html>\n`

const routes = {
  '/': () => [200, 'text/html', page('Home', '<h1>Clinic Portal</h1>\n<p>Welcome. Please <a href="/login">log in</a>.</p>')],
  '/login': () => [200, 'text/html', page('Login', '<h1>Log in</h1>\n<form method="post" action="/login">\n  <input name="user">\n  <input name="password" type="password">\n  <button>Log in</button>\n</form>')],
  '/dashboard': req => {
    if (!hasSession(req)) return [302, 'text/plain', '', { Location: '/login' }]
    return [200, 'text/html', page('Dashboard', `<h1>Dashboard</h1>\n<p>${records.length} records</p>`)]
  },
  '/api/records': req => {
    if (!hasSession(req)) return [401, 'application/json', JSON.stringify({ error: 'login required' })]
    return [200, 'application/json', JSON.stringify(records)]
  },
}

http
  .createServer((req, res) => {
    const handler = routes[new URL(req.url, 'http://x').pathname]
    const [status, type, body, headers] = handler ? handler(req) : [404, 'text/plain', 'not found']
    res.writeHead(status, { 'Content-Type': type, ...headers })
    res.end(body)
  })
  .listen(Number(process.env.PORT) || 3000, '127.0.0.1')
