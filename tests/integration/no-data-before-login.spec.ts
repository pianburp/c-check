import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { emails, icNumbers, phones, recordArray } from '../../src/rules/no-data-before-login'
import { makeRepo, type Repo } from './harness'

const RULE = 'no-data-before-login'
const SECRET = 'SECRET-REDIRECT-BODY'
const LEAK_APP = join(import.meta.dirname, '../../evals/leak-app/server.js')
const records = JSON.parse(readFileSync(join(dirname(LEAK_APP), 'data', 'records.json'), 'utf8')) as Array<Record<string, string>>
const repos: Repo[] = []
const procs: ChildProcess[] = []
const servers: Server[] = []
afterAll(() => {
  repos.forEach(r => r.cleanup())
  procs.forEach(p => p.kill())
  servers.forEach(s => s.close())
})

const config = (extra: Record<string, unknown>) => ({ rules: { [RULE]: { mode: 'observe', routes: ['/login', '/dashboard'], ...extra }, 'tests-pass-before-done': { mode: 'off' } } })

async function finish(cfg: unknown) {
  const repo = await makeRepo({}, { config: cfg })
  repos.push(repo)
  await repo.start()
  const res = await repo.stop()
  return { repo, res }
}

const logText = (repo: Repo) => {
  const dir = join(repo.root, '.c-check', 'logs')
  return readdirSync(dir).map(f => readFileSync(join(dir, f), 'utf8')).join('\n')
}

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r))
  const port = (probe.address() as AddressInfo).port
  await new Promise(r => probe.close(r))
  return port
}

async function startLeakApp(): Promise<number> {
  const port = await freePort()
  procs.push(spawn(process.execPath, [LEAK_APP], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' }))
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) return port
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('leak-app did not start')
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const s = createServer(handler)
  servers.push(s)
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
  return (s.address() as AddressInfo).port
}

/** A server that answers every route with one body. */
const serve = (type: string, body: string, status = 200) => listen((_req, res) => res.writeHead(status, { 'Content-Type': type }).end(body))

const html = (body: string) => `<!doctype html><body>${body}</body>`
const mails = (n: number) => Array.from({ length: n }, (_, i) => `person${i}@leak.test`).join(' ')

describe('no-data-before-login', () => {
  test('reads a 302 body through curl without following the redirect', async () => {
    const port = await listen((req, res) => {
      if (req.url === '/dashboard') res.writeHead(302, { Location: '/login' }).end(SECRET)
      else if (req.url === '/login') res.writeHead(200, { 'Content-Type': 'text/html' }).end('<script src="/app.js"></script>')
      else if (req.url === '/app.js') res.writeHead(200, { 'Content-Type': 'text/javascript' }).end('var x = 1')
      else res.writeHead(404).end()
    })
    const { repo, res } = await finish(config({ port }))
    expect(res.block).toBeUndefined()
    const line = repo.lines(RULE).at(-1)
    expect(line).toMatchObject({ applied: 'allow' })
    const routes = line?.details.routes
    expect(routes.find((r: any) => r.route === '/dashboard')).toMatchObject({ status: 302 })
    expect(routes.find((r: any) => r.route === '/dashboard').bodyChars).toBeGreaterThan(0)
    expect(routes.find((r: any) => r.route === '/login')).toMatchObject({ status: 200, scripts: 1 })
    expect(logText(repo)).not.toContain(SECRET)
  })

  test('nothing listening: skipped app not running', async () => {
    const { repo, res } = await finish(config({ port: await freePort() }))
    expect(res.block).toBeUndefined()
    expect(repo.lines(RULE).at(-1)).toMatchObject({ applied: 'allow', details: { skipped: 'app not running' } })
  })

  test('no config: skipped not configured', async () => {
    const { repo } = await finish({ rules: { [RULE]: { mode: 'observe' }, 'tests-pass-before-done': { mode: 'off' } } })
    expect(repo.lines(RULE).at(-1)).toMatchObject({ details: { skipped: 'not configured' } })
  })

  test('curl not found: skipped', async () => {
    const port = await serve('text/plain', 'hi')
    const repo = await makeRepo({}, { config: config({ port, routes: ['/login'] }) })
    repos.push(repo)
    await repo.start()
    const path = process.env.PATH
    process.env.PATH = ''
    try {
      await repo.stop()
    } finally {
      process.env.PATH = path
    }
    expect(repo.lines(RULE).at(-1)).toMatchObject({ applied: 'allow', details: { skipped: 'curl not found' } })
  })

  test.each([
    ['emails', 'text/html', html(mails(3)), 200],
    ['phones', 'text/html', html('+60 12-345 6789, 013-555 1234, +44 20 7946 0958'), 200],
    ['ic-numbers', 'text/html', html('IC 700101-01-5000'), 200],
    ['record-array', 'text/html', html(`<script>var d = ${JSON.stringify(records)}</script>`), 200],
    ['record-array', 'application/json', JSON.stringify({ data: records }), 200],
    ['emails', 'text/html', html(mails(4)), 403],
  ])('%s fires', async (name, type, body, status) => {
    const port = await serve(type, body, status)
    const { repo, res } = await finish(config({ port, mode: 'enforce', routes: ['/login'] }))
    expect(res.block).toContain('This page sends personal data to users who are not logged in: /login (')
    expect(res.block).toContain(`${name}: `)
    expect(res.block).toContain('Do not hide it with CSS or client code')
    const line = repo.lines(RULE).at(-1)
    expect(line).toMatchObject({ verdict: 'send_back', details: { routes: [{ route: '/login', status }] } })
    expect(line?.details.routes[0].detectors[name]).toBeGreaterThan(0)
  })

  test('data in a linked script file fires, a 302 body too', async () => {
    const port = await listen((req, res) => {
      if (req.url === '/app.js') res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(`var d = ${JSON.stringify(records)}`)
      else if (req.url === '/dashboard') res.writeHead(302, { Location: '/login' }).end(mails(3))
      else res.writeHead(200, { 'Content-Type': 'text/html' }).end('<script src="/app.js"></script>')
    })
    const { res } = await finish(config({ port, mode: 'enforce' }))
    expect(res.block).toContain('record-array: 25')
    expect(res.block).toContain('/dashboard (emails: 3)')
  })

  test('below the thresholds: allowed emails (any case), 2 phones, malformed JSON, impossible IC date', async () => {
    const body = html(`${mails(2)} Support@Example.com a@x.test ${' [{"a":1}, {"a" 700141-01-5000 [{{ '}${'[1,'.repeat(300)} 012-555 1000 013-555 1000`)
    const port = await serve('text/html', body)
    const { repo, res } = await finish(config({ port, routes: ['/login'], allowEmails: ['support@example.com', 'a@x.test'] }))
    expect(res.block).toBeUndefined()
    expect(repo.lines(RULE).at(-1)).toMatchObject({ verdict: 'allow', details: { routes: [{ detectors: { emails: 2, phones: 2, 'ic-numbers': 0, 'record-array': 0 } }] } })
  })

  test('detectors on their own', () => {
    expect(emails('A@b.co a@B.CO c@d.org', ['C@D.org'])).toBe(1)
    expect(phones('+60123456789 and 0123456789')).toBe(1)
    expect(icNumbers('991331-01-1234 990231-01-1234 000000-01-1234')).toBe(1)
    expect(recordArray(JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ id: i, n: 'x' }))))).toBe(20)
    expect(recordArray(JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ [`k${i}`]: i }))))).toBe(0)
    expect(recordArray('[[[{"a":')).toBe(0)
  })

  test('leak-app logged out: clean run passes, the same tree is skipped, a change is checked again', async () => {
    const port = await startLeakApp()
    const repo = await makeRepo({}, { config: config({ port, routes: ['/', '/login', '/dashboard', '/api/records'] }) })
    repos.push(repo)
    await repo.start()
    expect((await repo.stop()).block).toBeUndefined()
    const first = repo.lines(RULE).at(-1)
    expect(first).toMatchObject({ verdict: 'allow', details: { routes: [{ route: '/' }, { route: '/login' }, { route: '/dashboard', status: 302 }, { route: '/api/records', status: 401 }] } })
    await repo.stop()
    expect(repo.lines(RULE).at(-1)).toMatchObject({ details: { skipped: 'tree unchanged' } })
    repo.write('a.txt', 'changed\n')
    await repo.stop()
    expect(repo.lines(RULE).at(-1)?.details.routes).toHaveLength(4)
  })

  test('a leak does not count as a pass: it is checked again on the same tree', async () => {
    const port = await serve('text/html', html('IC 700101-01-5000'))
    const repo = await makeRepo({}, { config: config({ port, routes: ['/login'] }) })
    repos.push(repo)
    await repo.start()
    await repo.stop()
    await repo.stop()
    expect(repo.lines(RULE).map(l => l.verdict)).toEqual(['send_back', 'send_back'])
  })

  test('logs hold counts only: no email, phone, IC or name from the fixtures', async () => {
    const port = await serve('text/html', html(`${mails(3)} ${JSON.stringify(records)}`))
    const { repo } = await finish(config({ port, mode: 'enforce', routes: ['/login'] }))
    const text = logText(repo)
    expect(repo.lines(RULE)).toHaveLength(1)
    for (const r of records) for (const v of [r.email, r.phone, r.ic, r.name]) expect(text).not.toContain(v as string)
    expect(text).not.toContain('person0@leak.test')
  })
})
