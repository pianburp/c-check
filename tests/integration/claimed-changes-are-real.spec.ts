import { afterAll, describe, expect, test } from 'vitest'
import { makeRepo, type Repo } from './harness'

const RULE = 'claimed-changes-are-real'
const repos: Repo[] = []
afterAll(() => repos.forEach(r => r.cleanup()))

const FILES = { 'a.txt': 'a\n', 'b.txt': 'b\n', 'src/c.js': 'c\n', '.gitignore': 'build/\n' }

async function session(mode = 'enforce') {
  const r = await makeRepo(FILES, { config: { rules: { 'tests-pass-before-done': { mode: 'off' }, [RULE]: { mode } } } })
  repos.push(r)
  await r.start()
  return r
}
const write = (r: Repo, rel: string, content: string) => r.tool('Write', { file_path: `${r.root}/${rel}`, content })
const edit = (r: Repo, rel: string, from: string, to: string) => r.tool('Edit', { file_path: `${r.root}/${rel}`, old_string: from, new_string: to, replace_all: false })

describe.concurrent('claimed-changes-are-real: bad cases warn', () => {
  const bad: Array<[string, (r: Repo) => Promise<unknown> | void, RegExp]> = [
    ['Write with the same content', r => write(r, 'a.txt', 'a\n'), /edited but no real change: a\.txt/],
    ['Edit that changes nothing', r => edit(r, 'a.txt', 'a', 'a'), /edited but no real change: a\.txt/],
    ['shell change never reported', r => r.write('b.txt', 'changed by shell\n'), /changed without a file edit \(shell or other tool\): b\.txt/],
    ['shell creates a file', r => r.write('new.txt', 'x'), /changed without a file edit.*new\.txt/],
    ['shell deletes a file', r => r.rm('src/c.js'), /changed without a file edit.*src\/c\.js/],
    ['edit then revert', async r => {
      await write(r, 'a.txt', 'z\n')
      await write(r, 'a.txt', 'a\n')
    }, /edited but no real change: a\.txt/],
    ['one real edit and one shell change', async r => {
      await write(r, 'a.txt', 'new\n')
      r.write('b.txt', 'shell\n')
    }, /changed without a file edit.*b\.txt/],
    ['two no-op writes', async r => {
      await write(r, 'a.txt', 'a\n')
      await write(r, 'b.txt', 'b\n')
    }, /edited but no real change: a\.txt, b\.txt/],
    ['new folder by shell', r => r.write('docs/x.md', '# x'), /docs\/x\.md/],
    ['nested source change by shell', r => r.write('src/c.js', 'c2\n'), /src\/c\.js/],
  ]
  for (const [name, change, why] of bad) {
    test(name, async () => {
      const r = await session()
      await change(r)
      const res = await r.stop()
      expect(res.block).toBeUndefined()
      expect((await r.turnComplete()).text).toMatch(why)
      expect(r.lines(RULE).at(-1)).toMatchObject({ point: 'end', verdict: 'warn', applied: 'warn' })
    })
  }
})

describe.concurrent('claimed-changes-are-real: good cases allow', () => {
  const good: Array<[string, (r: Repo) => Promise<unknown> | void]> = [
    ['no changes at all', () => {}],
    ['one real Write', r => write(r, 'a.txt', 'A\n')],
    ['one real Edit', r => edit(r, 'b.txt', 'b', 'B')],
    ['new file with Write', r => write(r, 'src/new.js', 'x\n')],
    ['several real edits', async r => {
      await write(r, 'a.txt', '1\n')
      await edit(r, 'b.txt', 'b', '2')
      await write(r, 'src/c.js', '3\n')
    }],
    ['ignored build output by shell', r => r.write('build/out.js', 'x')],
    ['refused edit is not claimed', r => r.tool('Write', { file_path: `${r.root}/a.txt`, content: 'a\n' }, { result: { deny: 'no' } })],
    ['failed edit is not claimed', r => edit(r, 'a.txt', 'not-there', 'x')],
    ['Write in a new nested folder', r => write(r, 'deep/er/x.txt', 'x')],
    ['Read does not count as an edit', r => r.tool('Read', { file_path: `${r.root}/a.txt` })],
  ]
  for (const [name, change] of good) {
    test(name, async () => {
      const r = await session()
      await change(r)
      await r.stop()
      expect((await r.turnComplete()).text).toBeUndefined()
      expect(r.lines(RULE).at(-1)).toMatchObject({ applied: 'allow' })
    })
  }

  test('not a git repo: allow and log why', async () => {
    const r = await makeRepo(FILES, { git: false, config: { rules: { 'tests-pass-before-done': { mode: 'off' }, [RULE]: { mode: 'enforce' } } } })
    repos.push(r)
    await r.start()
    r.write('a.txt', 'x')
    await r.stop()
    expect(r.lines(RULE).at(-1)).toMatchObject({ applied: 'allow', details: { skipped: 'no git' } })
  })
})
