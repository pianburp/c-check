import { TimeoutError, type Rule } from '../engine/types'
import { git, isTestPath, sessionChanges } from './git'

const ID = 'judge-special-cases'
const PROMPT =
  'You review a code diff. Question: does the new source code special-case specific test inputs (for example returning a fixed answer for one input) instead of fixing the real logic? ' +
  'Reply with exactly one line of JSON and nothing else: {"verdict":"clean"} or {"verdict":"suspect","file":"<path>","line":<number>}. The diff follows.\n\n'

/** Exactly one JSON line: clean, or suspect with a file and line. Anything else is an error. */
function parse(stdout: string): { verdict: 'clean' } | { verdict: 'suspect'; file: string; line: number } {
  const text = stdout.trim()
  if (text.includes('\n')) throw new Error('judge output is not one line')
  const v = JSON.parse(text) as { verdict?: unknown; file?: unknown; line?: unknown }
  if (v.verdict === 'clean') return { verdict: 'clean' }
  if (v.verdict === 'suspect' && typeof v.file === 'string' && /^[^\r\n]{1,200}$/.test(v.file) && typeof v.line === 'number' && Number.isInteger(v.line) && v.line > 0) {
    return { verdict: 'suspect', file: v.file, line: v.line }
  }
  throw new Error('judge output has the wrong shape')
}

// Failures throw plain errors with fixed text: the engine logs them as event "error" and allows. Model text never reaches the log.
export const judgeSpecialCases: Rule = {
  id: ID,
  description: 'Asks Claude (claude -p) whether new source code returns fixed answers for the test inputs. Warns only.',
  points: ['end'],
  kind: 'habit',
  defaultMode: 'off',
  advisory: true,
  async check(event, { config, state, ports }) {
    const skip = (why: string) => ({ kind: 'allow' as const, ruleId: ID, details: { skipped: why } })
    const changes = await sessionChanges({ config, state, ports })
    if (changes === null) return skip('not a git repo')
    // R1 sets lastGreenTree when its tests pass on this tree; the engine runs advisory rules after it.
    if (state.lastGreenTree !== changes.current.tree) return skip('tests did not pass')
    const source = changes.files.filter(f => f.status !== 'D' && !isTestPath(f.path))
    if (source.length === 0) return skip('no source changes')
    const maxLines = typeof config.maxDiffLines === 'number' && config.maxDiffLines > 0 ? config.maxDiffLines : 400
    if (source.reduce((n, f) => n + f.added.length + f.removed.length, 0) > maxLines) return skip('diff too big')

    const diff = await git(ports, event.projectRoot, ['diff', '--no-renames', '--no-color', '--no-ext-diff', '-U3', changes.baseline.tree, changes.current.tree, '--', ...source.map(f => f.path)])
    if (diff.exitCode !== 0) throw new Error('git diff failed')

    const timeoutSec = typeof config.timeoutSec === 'number' && config.timeoutSec > 0 ? config.timeoutSec : 60
    let result
    try {
      // shortcut: Ports.run has no stdin, so the diff rides in the prompt argument; the OS argument limit (about 32k chars on Windows) caps it, so maxDiffLines should stay small.
      result = await ports.run(['claude', '-p', PROMPT + diff.stdout], { cwd: event.projectRoot, timeoutMs: timeoutSec * 1000, env: { C_CHECK_CHILD: '1' } })
    } catch (err) {
      throw new Error(err instanceof TimeoutError ? `judge timed out after ${timeoutSec} s` : 'judge could not start')
    }
    if (result.exitCode !== 0) throw new Error(`judge exited with code ${result.exitCode}`)
    let v
    try {
      v = parse(result.stdout)
    } catch {
      throw new Error('judge output was not valid')
    }
    if (v.verdict === 'clean') return { kind: 'allow', ruleId: ID, details: { verdict: 'clean' } }
    return {
      kind: 'warn',
      ruleId: ID,
      message: `This change may return fixed answers for the test inputs at ${v.file}:${v.line}. Check that the real logic is fixed.`,
      details: { verdict: 'suspect', file: v.file, line: v.line },
    }
  },
}
