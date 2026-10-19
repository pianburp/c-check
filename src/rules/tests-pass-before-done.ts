import { isWindowsPath } from '../engine/paths'
import { TimeoutError, type CheckEvent, type Rule, type RuleContext, type Verdict } from '../engine/types'
import { sessionChanges } from './git'

const ID = 'tests-pass-before-done'
const NPM_DEFAULT_TEST = /no test specified/

/** The test command from config, else `npm test` when package.json has a real test script. */
export async function testCommand(config: Record<string, unknown>, root: string, read: (p: string) => Promise<string | null>): Promise<string | undefined> {
  if (typeof config.command === 'string' && config.command.trim() !== '') return config.command
  const pkg = await read(`${root}/package.json`)
  if (pkg === null) return undefined
  try {
    const script = (JSON.parse(pkg) as { scripts?: { test?: unknown } }).scripts?.test
    return typeof script === 'string' && script.trim() !== '' && !NPM_DEFAULT_TEST.test(script) ? 'npm test' : undefined
  } catch {
    return undefined
  }
}

/**
 * argv that runs `command` through the platform shell. On Windows the command goes into a .cmd file:
 * passing it as one argument to cmd.exe breaks its quotes, because cmd does not read backslash escapes.
 */
export async function shellFor(command: string, root: string, write: (p: string, t: string) => Promise<void>): Promise<string[]> {
  if (!isWindowsPath(root)) return ['sh', '-c', command]
  const script = `${root}/.c-check/run-tests.cmd`
  await write(script, `@echo off\r\n${command}\r\nexit /b %errorlevel%\r\n`)
  return ['cmd.exe', '/d', '/c', script.replace(/\//g, '\\')]
}

const lastLines = (text: string, n: number) => text.trimEnd().split(/\r?\n/).slice(-n).join('\n')

export const testsPassBeforeDone: Rule = {
  id: ID,
  description: "Runs the project's test command when Claude tries to finish. Claude cannot finish while it fails.",
  points: ['end'],
  kind: 'habit',
  defaultMode: 'enforce',
  async check(event, ctx) {
    // R8 runs concurrently and waits on this to learn whether the tests passed.
    let done!: (passed: boolean) => void
    ctx.state.r1Passed = new Promise<boolean>(r => (done = r))
    try {
      const verdict = await runTests(event, ctx)
      done(verdict.kind === 'allow')
      return verdict
    } catch (err) {
      done(false)
      throw err
    }
  },
}

async function runTests(event: CheckEvent, { config, state, ports }: RuleContext): Promise<Verdict> {
  const command = await testCommand(config, event.projectRoot, ports.read)
  if (command === undefined) return { kind: 'warn', ruleId: ID, message: 'No test command found.', details: { command: null } }

  // Verify enough, not more: nothing changed since session start or since the last green run, so tests need no rerun.
  const changes = await sessionChanges({ config, state, ports })
  if (changes !== null && (changes.current.tree === changes.baseline.tree || changes.current.tree === state.lastGreenTree)) {
    return { kind: 'allow', ruleId: ID, details: { skipped: 'no changes since last pass' } }
  }

  const timeoutSec = typeof config.timeoutSec === 'number' && config.timeoutSec > 0 ? config.timeoutSec : 300
  const shell = await shellFor(command, event.projectRoot, ports.write)
  let result
  try {
    result = await ports.run(shell, { cwd: event.projectRoot, timeoutMs: timeoutSec * 1000, env: { CI: '1' } })
  } catch (err) {
    if (!(err instanceof TimeoutError)) throw err
    // §11 exception: tests that never finished are not a pass.
    return {
      kind: 'send_back',
      ruleId: ID,
      message: `The test command \`${command}\` did not finish within ${timeoutSec} s. Find out why the tests hang, fix it, then finish.`,
      details: { command, timeoutSec, timedOut: true },
    }
  }
  if (result.exitCode === 0) {
    if (changes !== null) state.lastGreenTree = changes.current.tree
    return { kind: 'allow', ruleId: ID, details: { command, exitCode: 0 } }
  }
  const output = lastLines(`${result.stdout}\n${result.stderr}`, 50)
  return {
    kind: 'send_back',
    ruleId: ID,
    message: `The test command \`${command}\` failed (exit code ${result.exitCode}). Last lines of output:\n\n${output}\n\nFix the failing tests, then finish.`,
    details: { command, exitCode: result.exitCode },
  }
}
