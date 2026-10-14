// Runs under `claude plugin test`: proves the mod loads in Claude Code's own runtime and answers in the shapes it expects.
// That runtime has no real files or processes, so the world is stubbed here; real-repo behavior is covered by tests/integration (Vitest).
import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

const ROOT = 'C:/work/repo'
const BACKSLASH = String.fromCharCode(92)

/** A project with a failing `npm test`, no git, and nothing else on disk. */
function world(on: On, opts: { testsPass: boolean }) {
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'mod-test-session' }))
  on('session.root', async () => ({ value: ROOT }))
  on('clock.now', async () => ({ value: 0 }))
  // The runtime hands paths over in the platform's own spelling.
  on('fs.exists', async ($, e) => ({ value: e.path.replaceAll(BACKSLASH, '/') === `${ROOT}/package.json` }))
  on('fs.read', async () => ({ value: JSON.stringify({ scripts: { test: 'vitest run' } }) }))
  on('fs.write', async () => ({ value: undefined }))
  on('fs.stat', async ($, e) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('process.run', async ($, e) => {
    // Not a git repo; the test command passes or fails on request.
    if (e.argv[0] === 'git') return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository' } }
    return { value: opts.testsPass ? { exitCode: 0, stdout: 'ok', stderr: '' } : { exitCode: 1, stdout: 'FAIL adds', stderr: '' } }
  })
  on('tool.call', async () => ({ result: { type: 'create' }, text: 'done' }))
  on('classic.Stop', async () => ({}))
}

// The runtime raises classic.* events on the test's $, though its Engine type does not list them.
const classicStop = ($: unknown) => ($ as { classic: { Stop(e: unknown): Promise<unknown> } }).classic.Stop(stop)

const stop = { session_id: 'mod-test-session', transcript_path: '', cwd: ROOT, permission_mode: 'default', hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' }

describe('c-check in the mods runtime', () => {
  test('an edit outside the project is denied with a reason', async ($, on) => {
    world(on, { testsPass: true })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
    const result = await $.tool.call({ tool: 'Write', file_path: 'C:/elsewhere/x.txt', content: 'x' } as never)
    expect(result).toEqual({ deny: `[c-check: no-outside-edits] This file is outside the project. Edit files inside ${ROOT} only.` })
  })

  test('an edit inside the project runs', async ($, on) => {
    world(on, { testsPass: true })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
    const result = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/a.txt`, content: 'x' } as never)
    expect(result).toEqual({ result: { type: 'create' }, text: 'done' })
  })

  test('Claude cannot stop while tests fail', async ($, on) => {
    world(on, { testsPass: false })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
    const result = (await classicStop($)) as { block?: string }
    expect(result.block).toContain('[c-check: tests-pass-before-done]')
    expect(result.block).toContain('Fix the failing tests, then finish.')
  })

  test('Claude may stop when tests pass', async ($, on) => {
    world(on, { testsPass: true })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
    expect(await classicStop($)).toEqual({})
  })
})
