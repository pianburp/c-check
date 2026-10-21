import { loadConfig } from '../config/config'
import { TimeoutError, type Ports, type Rule } from '../engine/types'
import { isTestPath, sessionChanges } from './git'
import { shellFor, testCommand } from './tests-pass-before-done'

const ID = 'tests-still-bite'
const R1 = 'tests-pass-before-done'
const MESSAGE =
  'The original tests fail on your new code. You changed the tests to match the code. Fix the code. If the user asked you to change these tests, say so in your final message and stop.'

// shortcut: word proximity, not intent; "tests" near "update" in an unrelated sentence also downgrades. Tighten if logs show misses.
const NEAR = /\b(?:tests?|specs?|snapshots?)\b.{0,40}\b(?:updat\w*|chang\w*|fix\w*|rewrit\w*|rewrot\w*|remov\w*|delet\w*|edit\w*|modif\w*)|\b(?:updat\w*|chang\w*|fix\w*|rewrit\w*|rewrot\w*|remov\w*|delet\w*|edit\w*|modif\w*)\b.{0,40}\b(?:tests?|specs?|snapshots?)\b/i

const git = (ports: Ports, cwd: string, args: string[], env?: Record<string, string>) =>
  ports.run(['git', '-c', 'core.quotepath=off', ...args], { cwd, timeoutMs: 60_000, ...(env !== undefined && { env }) })

/** Runs a one-liner with the node that runs us; the only way to get tmpdir, links and deletes through ports. */
const node = (ports: Ports, cwd: string, code: string, ...args: string[]) => ports.run([process.execPath, '-e', code, ...args], { cwd, timeoutMs: 30_000 })

const lock = (p: string) => `:(literal)${p}`

export const testsStillBite: Rule = {
  id: ID,
  description: 'Reruns the original test files against the new code. Fails when the tests only pass because Claude changed them.',
  points: ['end'],
  kind: 'habit',
  defaultMode: 'observe',
  async check(event, { config, state, ports }) {
    const changes = await sessionChanges({ config, state, ports })
    if (changes === null) return { kind: 'allow', ruleId: ID }
    const tests = changes.files.filter(f => isTestPath(f.path))
    if (tests.length === 0) return { kind: 'allow', ruleId: ID, details: { skipped: 'no test file changed' } }
    // R1 runs at the same time; it says whether the new tests passed. Absent when R1 is off.
    if (!(await state.r1Passed)) return { kind: 'allow', ruleId: ID, details: { skipped: 'tests-pass-before-done did not pass' } }

    const r1 = (await loadConfig(event.projectRoot, ports)).config.rules[R1] ?? {}
    const root = event.projectRoot
    const command = await testCommand(r1, root, ports.read)
    if (command === undefined) return { kind: 'allow', ruleId: ID, details: { skipped: 'no test command' } }
    const timeoutSec = typeof r1.timeoutSec === 'number' && r1.timeoutSec > 0 ? r1.timeoutSec : 300

    const tmpdir = (await node(ports, root, 'process.stdout.write(require("os").tmpdir())')).stdout.trim()
    const dir = `${tmpdir.replace(/\\/g, '/')}/c-check-r8-${state.id.replace(/[^\w-]/g, '_')}-${await ports.now()}`
    const link = `${dir}/node_modules`
    const author = { GIT_AUTHOR_NAME: 'c-check', GIT_AUTHOR_EMAIL: 'c-check@localhost', GIT_COMMITTER_NAME: 'c-check', GIT_COMMITTER_EMAIL: 'c-check@localhost' }
    let result
    try {
      // A dangling commit of the current tree lets `git worktree` copy it; no ref is made, the copy is removed below.
      const commit = await git(ports, root, ['commit-tree', changes.current.tree, '-m', 'c-check tests-still-bite'], author)
      if (commit.exitCode !== 0) throw new Error('git commit-tree failed')
      const add = await git(ports, root, ['worktree', 'add', '-q', '--detach', dir, commit.stdout.trim()])
      if (add.exitCode !== 0) throw new Error('git worktree add failed')

      // Test files that did not exist at session start are removed; every other changed or deleted one is put back.
      const added = tests.filter(f => f.status === 'A').map(f => lock(f.path))
      const back = tests.filter(f => f.status !== 'A').map(f => lock(f.path))
      if (added.length > 0 && (await git(ports, dir, ['rm', '-q', '-f', '--', ...added])).exitCode !== 0) throw new Error('git rm failed')
      if (back.length > 0 && (await git(ports, dir, ['checkout', changes.baseline.tree, '--', ...back])).exitCode !== 0) throw new Error('git checkout failed')

      // Junction: needs no admin on Windows; a plain symlink does on POSIX too.
      const nm = `${root}/node_modules`
      if ((await ports.realPath(nm)) !== undefined) await node(ports, root, "require('fs').symlinkSync(process.argv[1], process.argv[2], 'junction')", nm, link)

      // No bytecode cache: the second run rewrites test files within the same second, and a same-size file then reuses the old .pyc.
      const runTests = async () => ports.run(await shellFor(command, dir, ports.write), { cwd: dir, timeoutMs: timeoutSec * 1000, env: { CI: '1', PYTHONDONTWRITEBYTECODE: '1' } })
      try {
        result = await runTests()
        // The copy lacks git-ignored files (.env.test, generated code). If the current tests fail there too, the copy is broken, not the tests.
        if (result.exitCode !== 0) {
          if ((await git(ports, dir, ['reset', '-q', '--hard', commit.stdout.trim()])).exitCode !== 0) throw new Error('git reset failed')
          if ((await runTests()).exitCode !== 0) return { kind: 'allow', ruleId: ID, details: { skipped: 'copy broken', command } }
        }
      } catch (err) {
        if (!(err instanceof TimeoutError)) throw err
        return { kind: 'warn', ruleId: ID, message: 'c-check: tests-still-bite check timed out.', details: { command, timeoutSec, timedOut: true } }
      }
    } finally {
      // Unlink the node_modules link first so removing the copy can never follow it into the real one.
      await node(ports, root, "const fs=require('fs');try{fs.unlinkSync(process.argv[1])}catch{try{fs.rmdirSync(process.argv[1])}catch{}}", link)
      await git(ports, root, ['worktree', 'remove', '--force', dir])
      await node(ports, root, "const fs=require('fs');for(let i=0;i<20;i++){try{fs.rmSync(process.argv[1],{recursive:true,force:true});break}catch{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500)}}", dir)
      await git(ports, root, ['worktree', 'prune'])
    }

    if (result.exitCode === 0) return { kind: 'allow', ruleId: ID, details: { command, exitCode: 0 } }
    const details = { command, exitCode: result.exitCode, testFiles: tests.length }
    if (state.prompts.some(p => NEAR.test(p))) {
      return { kind: 'warn', ruleId: ID, message: `c-check: the original tests fail on the new code. The user asked for test changes, so this is only a warning.`, details: { ...details, downgraded: 'prompt' } }
    }
    return { kind: 'send_back', ruleId: ID, message: MESSAGE, details }
  },
}
