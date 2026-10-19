import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { makeRepo, type Repo } from './harness'

const RULE = 'no-data-before-login'
const SECRET = 'SECRET-REDIRECT-BODY'
const repos: Repo[] = []
afterAll(() => repos.forEach(r => r.cleanup()))

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

describe('no-data-before-login', () => {
  test('reads a 302 body through curl without following the redirect', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/dashboard') res.writeHead(302, { Location: '/login' }).end(SECRET)
      else if (req.url === '/login') res.writeHead(200, { 'Content-Type': 'text/html' }).end('<script src="/app.js"></script>')
      else if (req.url === '/app.js') res.writeHead(200, { 'Content-Type': 'text/javascript' }).end('var x = 1')
      else res.writeHead(404).end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    try {
      const { repo, res } = await finish(config({ port: (server.address() as AddressInfo).port }))
      expect(res.block).toBeUndefined()
      const line = repo.lines(RULE).at(-1)
      expect(line).toMatchObject({ applied: 'allow' })
      const routes = line?.details.routes
      expect(routes.find((r: any) => r.route === '/dashboard')).toMatchObject({ status: 302 })
      expect(routes.find((r: any) => r.route === '/dashboard').bodyChars).toBeGreaterThan(0)
      expect(routes.find((r: any) => r.route === '/login')).toMatchObject({ status: 200, scripts: 1 })
      expect(logText(repo)).not.toContain(SECRET)
    } finally {
      server.close()
    }
  })

  test('nothing listening: skipped app not running', async () => {
    const probe = createServer()
    await new Promise<void>(r => probe.listen(0, '127.0.0.1', r))
    const port = (probe.address() as AddressInfo).port
    await new Promise(r => probe.close(r))
    const { repo, res } = await finish(config({ port }))
    expect(res.block).toBeUndefined()
    expect(repo.lines(RULE).at(-1)).toMatchObject({ applied: 'allow', details: { skipped: 'app not running' } })
  })

  test('no config: skipped not configured', async () => {
    const { repo } = await finish({ rules: { [RULE]: { mode: 'observe' }, 'tests-pass-before-done': { mode: 'off' } } })
    expect(repo.lines(RULE).at(-1)).toMatchObject({ details: { skipped: 'not configured' } })
  })
})
