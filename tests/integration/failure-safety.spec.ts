import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, test } from 'vitest'
import { makeRepo, type Repo } from './harness'

const repos: Repo[] = []
const servers: Server[] = []
afterAll(() => {
  repos.forEach(r => r.cleanup())
  servers.forEach(s => s.close())
})

async function session(files: Record<string, string>) {
  const r = await makeRepo(files)
  repos.push(r)
  await r.start()
  return r
}

describe.concurrent('failure safety through the full chain', () => {
  test('broken c-check.config.json: defaults load and Claude is warned once', async () => {
    const r = await session({ 'c-check.config.json': '{ "rules": ', 'a.txt': 'a' })
    const first = await r.tool('Write', { file_path: `${r.root}/b.txt`, content: 'b' })
    expect(first.context.join('\n')).toMatch(/c-check\.config\.json is not valid JSON.*Using default settings\./)
    const second = await r.tool('Write', { file_path: `${r.root}/c.txt`, content: 'c' })
    expect(second.context).toBeUndefined()
    // Defaults apply: no-outside-edits is enforced.
    const outside = await r.tool('Write', { file_path: `${r.root}/../x-${Date.now()}.txt`, content: 'x' })
    expect(outside.deny).toMatch(/outside the project/)
    expect(r.logs().filter(l => l.event === 'config')).toHaveLength(1)
  })

  test('unknown config keys: warn once, then ignore', async () => {
    const r = await session({ 'c-check.config.json': JSON.stringify({ colour: 'red', rules: { 'not-a-rule': {} } }) })
    const res = await r.tool('Write', { file_path: `${r.root}/b.txt`, content: 'b' })
    expect(res.context.join('\n')).toContain('unknown keys in c-check.config.json were ignored: colour, rules.not-a-rule')
  })

  test('an event shape the adapter does not know is allowed and logged', async () => {
    const r = await session({})
    const res = await r.tool(undefined as unknown as string, { something: 1 })
    expect(res.deny).toBeUndefined()
    expect(r.logs().some(l => l.event === 'unknown_event')).toBe(true)
  })

  test('the log never holds file contents', async () => {
    const r = await session({})
    await r.tool('Write', { file_path: `${r.root}/b.txt`, content: 'UNIQUE-CONTENT-MARKER' })
    await r.stop()
    expect(JSON.stringify(r.logs())).not.toContain('UNIQUE-CONTENT-MARKER')
  })
})

// End rules run at the same time and share git state. A race there logs allow (or a skip), which looks like a pass, so only a repeat run shows it.
describe('every end rule at once, many stops', () => {
  test('no rule errors, and an unchanged tree is always skipped by the leak check', async () => {
    const s = createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><p>hi</p>'))
    servers.push(s)
    await new Promise<void>(ok => s.listen(0, '127.0.0.1', ok))
    const port = (s.address() as AddressInfo).port
    const config = { rules: { 'tests-pass-before-done': { command: 'node -e ""' }, 'no-data-before-login': { mode: 'observe', port, routes: ['/'] } } }
    const r = await makeRepo({ 'src/a.js': 'export const a = 0\n', 'tests/a.test.js': "test('a', () => {})\n" }, { config })
    repos.push(r)
    await r.start()
    for (let i = 1; i <= 6; i++) {
      r.write('src/a.js', `export const a = ${i}\n`)
      r.write('tests/a.test.js', `test('a', () => {})\ntest('a${i}', () => {})\n`)
      await r.stop()
      await r.stop()
    }
    expect(r.logs().filter(l => l.event === 'error' || l.event === 'timeout')).toEqual([])
    const leak = r.lines('no-data-before-login').map(l => l.details?.skipped ?? 'checked')
    expect(leak).toEqual(Array.from({ length: 6 }, () => ['checked', 'tree unchanged']).flat())
  }, 120_000)
})
