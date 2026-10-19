import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, test } from 'vitest'
import { makeRepo, type Repo } from './harness'

const RULE = 'deploy-gate'
const LEAK = 'no-data-before-login'
const MESSAGE = `[c-check: ${RULE}] c-check has not checked this code for data leaks yet. Finish your task first so c-check can run its end checks, then deploy.`
const repos: Repo[] = []
const servers: Server[] = []
afterAll(() => {
  repos.forEach(r => r.cleanup())
  servers.forEach(s => s.close())
})

async function appPort(): Promise<number> {
  const server = createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/plain' }).end('hello'))
  servers.push(server)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return (server.address() as AddressInfo).port
}

async function session(leak: Record<string, unknown> | undefined, gate: Record<string, unknown> = {}) {
  const rules: Record<string, unknown> = { 'tests-pass-before-done': { mode: 'off' }, [RULE]: { mode: 'enforce', ...gate } }
  if (leak !== undefined) rules[LEAK] = { mode: 'observe', ...leak }
  const r = await makeRepo({ 'a.txt': 'a\n' }, { config: { rules } })
  repos.push(r)
  await r.start()
  return r
}

const last = (r: Repo) => r.lines(RULE).filter(l => l.point === 'before').at(-1)
const deploy = (r: Repo, command = 'railway up') => r.tool('Bash', { command, description: 'x' })

describe('deploy-gate', () => {
  test('railway up before any leak check passed: blocked', async () => {
    const r = await session({ port: await appPort(), routes: ['/'] })
    const res = await deploy(r)
    expect(res.deny).toBe(MESSAGE)
    expect(last(r)).toMatchObject({ point: 'before', verdict: 'block', applied: 'block', details: { pattern: 'railway up' } })
  })

  test('railway up after the leak check passed on this tree: allowed', async () => {
    const r = await session({ port: await appPort(), routes: ['/'] })
    await r.stop()
    expect(r.lines(LEAK).at(-1)).toMatchObject({ applied: 'allow' })
    const res = await deploy(r)
    expect(res.deny).toBeUndefined()
    expect(last(r)).toMatchObject({ verdict: 'allow' })
  })

  test('railway up after a file changed since the pass: blocked', async () => {
    const r = await session({ port: await appPort(), routes: ['/'] })
    await r.stop()
    await r.tool('Write', { file_path: 'a.txt', content: 'changed\n' })
    const res = await deploy(r)
    expect(res.deny).toBe(MESSAGE)
  })

  test('a skipped leak check (app not running) does not count as a pass', async () => {
    const probe = createServer()
    await new Promise<void>(res => probe.listen(0, '127.0.0.1', res))
    const port = (probe.address() as AddressInfo).port
    await new Promise(res => probe.close(res))
    const r = await session({ port, routes: ['/'] })
    await r.stop()
    expect((await deploy(r)).deny).toBe(MESSAGE)
  })

  test('npm test && railway up: blocked', async () => {
    const r = await session({ port: await appPort(), routes: ['/'] })
    expect((await deploy(r, 'npm test && railway up')).deny).toBe(MESSAGE)
  })

  test('vercel without --prod: allowed; with --prod: blocked', async () => {
    const r = await session({ port: await appPort(), routes: ['/'] })
    expect((await deploy(r, 'vercel')).deny).toBeUndefined()
    expect((await deploy(r, 'VERCEL deploy --prod')).deny).toBe(MESSAGE)
  })

  test('R10 not configured: allowed, skipped', async () => {
    const r = await session({})
    expect((await deploy(r)).deny).toBeUndefined()
    expect(last(r)).toMatchObject({ verdict: 'allow', details: { skipped: 'no leak check configured' } })
  })

  test('R10 off: allowed, skipped', async () => {
    const r = await session({ mode: 'off', port: await appPort(), routes: ['/'] })
    expect((await deploy(r)).deny).toBeUndefined()
    expect(last(r)).toMatchObject({ details: { skipped: 'no leak check configured' } })
  })

  test('allowPatterns: allowed', async () => {
    const r = await session({ port: await appPort(), routes: ['/'] }, { allowPatterns: ['railway up --service staging'] })
    expect((await deploy(r, 'railway up --service staging')).deny).toBeUndefined()
    expect((await deploy(r)).deny).toBe(MESSAGE)
  })

  test('extraPatterns: blocked', async () => {
    const r = await session({ port: await appPort(), routes: ['/'] }, { extraPatterns: ['\\bscp\\b.*prod'] })
    expect((await deploy(r, 'scp -r dist prod:/srv')).deny).toBe(MESSAGE)
  })

  test('observe mode: raw verdict is block, nothing is stopped; log holds no command text', async () => {
    const r = await session({ port: await appPort(), routes: ['/'] }, { mode: 'observe' })
    const res = await deploy(r, 'railway up --token SECRET-TOKEN')
    expect(res.deny).toBeUndefined()
    expect(last(r)).toMatchObject({ verdict: 'block', applied: 'allow' })
    expect(JSON.stringify(r.logs())).not.toContain('SECRET-TOKEN')
  })

  test('a read-only tool keeps the cached tree; a write drops it and the pass is gone', async () => {
    const r = await session({ port: await appPort(), routes: ['/'] })
    await r.stop()
    await r.tool('Read', { file_path: 'a.txt' })
    expect((await deploy(r)).deny).toBeUndefined()
    await r.tool('Write', { file_path: 'b.txt', content: 'new\n' })
    expect((await deploy(r)).deny).toBe(MESSAGE)
  })

  test('the before-check takes under 200 ms when the tree is cached', async () => {
    const r = await session({ port: await appPort(), routes: ['/'] })
    await r.stop() // R10 passes and primes the cache with its own tree
    const started = performance.now()
    await deploy(r)
    const wall = performance.now() - started
    // ms is the engine's timing around rule.check (config read, cache hit); wall adds the harness, the after phase and the other before rules.
    const hit = last(r)?.ms
    await r.tool('Write', { file_path: 'b.txt', content: 'new\n' })
    await deploy(r)
    const cold = last(r)?.ms
    console.log(`deploy-gate before-check: cached ${hit} ms (tool() wall ${wall.toFixed(0)} ms), cold snapshot ${cold} ms`)
    expect(hit).toBeLessThan(200)
  })
})
