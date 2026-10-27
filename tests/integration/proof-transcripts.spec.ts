import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { findSecrets } from '../../src/rules/no-secrets-in-files'
import { readToolCalls, type ReadStats, type ToolCall } from '../../proof/transcripts'

const FIXTURES = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../proof/fixtures/projects')

async function readAll(): Promise<{ calls: ToolCall[]; stats: ReadStats }> {
  const stats: ReadStats = { files: 0, badLines: 0 }
  const calls: ToolCall[] = []
  for await (const c of readToolCalls(FIXTURES, stats)) calls.push(c)
  return { calls, stats }
}

const short = (c: ToolCall) => [c.sessionId.slice(0, 8), c.agentId ?? '-', c.position, c.tool, c.toolUseId, c.isError]

describe('proof: transcript reader on fake fixtures', () => {
  test('yields every tool call in order, with session, project, position and failure', async () => {
    const { calls } = await readAll()
    // Files in sorted path order: C--dev-c-check, C--work-blog, C--work-shop; a subagent file after its session file.
    expect(calls.map(short)).toEqual([
      ['c5555555', '-', 1, 'Bash', 'toolu_fake_self_1', false],
      ['b3333333', '-', 1, 'Bash', 'toolu_fake_deploy_1', false],
      ['b4444444', '-', 1, 'Read', 'toolu_fake_clean_1', false],
      ['b4444444', '-', 2, 'Edit', 'toolu_fake_clean_2', false],
      ['b4444444', '-', 3, 'Bash', 'toolu_fake_clean_3', false],
      ['a1111111', '-', 1, 'Bash', 'toolu_fake_risky_1', false],
      ['a1111111', '-', 2, 'Bash', 'toolu_fake_risky_2', true],
      ['a1111111', 'f00d01', 1, 'Glob', 'toolu_fake_agent_1', false],
      ['a2222222', '-', 1, 'Write', 'toolu_fake_secret_1', false],
    ])
    expect(new Set(calls.map(c => c.project))).toEqual(new Set(['C:\\work\\shop', 'C:\\work\\blog', 'C:\\dev\\c-check']))
    expect(calls.every(c => typeof c.timestamp === 'string')).toBe(true)
  })

  test('hands over the tool input as Claude wrote it', async () => {
    const { calls } = await readAll()
    const byId = (id: string) => calls.find(c => c.toolUseId === id)?.input
    expect(byId('toolu_fake_risky_2')).toEqual({ command: 'git push --force origin main', description: 'Force push' })
    expect(byId('toolu_fake_deploy_1')?.command).toBe('npm run build && vercel --prod')
    expect(byId('toolu_fake_clean_2')).toMatchObject({ old_string: 'Helo', new_string: 'Hello' })
    // The fake key must look like a secret to the real rule, or Phase 3 would test nothing.
    expect(findSecrets(String(byId('toolu_fake_secret_1')?.content), 'payment.js')).toEqual([{ line: 3, pattern: 'password literal' }])
  })

  test('a broken line is skipped and counted, and reading goes on', async () => {
    const { calls, stats } = await readAll()
    expect(stats).toEqual({ files: 6, badLines: 1 })
    expect(calls.some(c => c.toolUseId === 'toolu_fake_risky_2')).toBe(true)
  })

  // A wrong path must be loud: zero sessions read would look like zero fires.
  test('a missing folder is an error, not an empty result', async () => {
    const calls: ToolCall[] = []
    await expect(
      (async () => {
        for await (const c of readToolCalls(join(FIXTURES, 'no-such-folder'))) calls.push(c)
      })(),
    ).rejects.toThrow()
    expect(calls).toEqual([])
  })
})
