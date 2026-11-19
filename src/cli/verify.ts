/// <reference types="node" />
import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { CONFIG_FILE, loadConfig } from '../config/config.ts'
import { runEvent } from '../engine/engine.ts'
import { newSessionState } from '../engine/types.ts'
import type { LogLine } from '../log/log.ts'
import { git } from '../rules/git.ts'
import { noTestWeakening } from '../rules/no-test-weakening.ts'
import { testsPassBeforeDone } from '../rules/tests-pass-before-done.ts'
import { nodePorts } from '../runtime/node-ports.ts'

const rules = [testsPassBeforeDone, noTestWeakening]
const usage = 'usage: c-check verify --base <ref> [--project <path>]'

function incomplete(reason: string): 2 {
  console.error(`c-check verify: ${reason}`)
  return 2
}

export async function verify(args: string[]): Promise<number> {
  const options = new Map<string, string>()
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]
    const value = args[i + 1]
    if ((key !== '--base' && key !== '--project') || !value || value.startsWith('--') || options.has(key)) return incomplete(usage)
    options.set(key, value)
  }
  const ref = options.get('--base')
  if (ref === undefined) return incomplete(usage)

  try {
    const cwd = resolve(options.get('--project') ?? '.')
    const top = await git(nodePorts, cwd, ['rev-parse', '--show-toplevel'])
    if (top.exitCode !== 0) return incomplete('project must be inside a Git worktree')
    const root = await nodePorts.realPath(top.stdout.trimEnd())
    if (root === undefined) return incomplete('could not resolve the Git worktree root')
    const base = await git(nodePorts, root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{tree}`])
    const tree = base.stdout.trim()
    if (base.exitCode !== 0 || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(tree)) return incomplete('baseline does not resolve to a Git tree')
    const index = await git(nodePorts, root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
    if (index.exitCode !== 0 || !index.stdout.trimEnd()) return incomplete('could not locate the worktree index')

    // The baseline supplies policy so an edit under review cannot disable the checks.
    const entry = await git(nodePorts, root, ['ls-tree', tree, '--', CONFIG_FILE])
    if (entry.exitCode !== 0) return incomplete('could not inspect the baseline configuration')
    let policy: string | null = null
    if (entry.stdout !== '') {
      if (!/^100(?:644|755) blob /.test(entry.stdout)) return incomplete('baseline configuration must be a regular file')
      const blob = await git(nodePorts, root, ['cat-file', 'blob', `${tree}:${CONFIG_FILE}`])
      if (blob.exitCode !== 0) return incomplete('could not read the baseline configuration')
      policy = blob.stdout
    }
    const loaded = await loadConfig(root, { ...nodePorts, read: async () => policy })
    if (loaded.warnings.length > 0) return incomplete('baseline configuration has invalid or unrecognized settings')
    const explicit = JSON.parse(policy ?? '{}') as { rules?: Record<string, { mode?: unknown } | null> }
    const unsupported = Object.entries(explicit.rules ?? {}).filter(([id, settings]) =>
      settings?.mode === 'enforce' && !rules.some(rule => rule.id === id),
    )
    if (unsupported.length > 0) return incomplete(`required rules unavailable in standalone verification: ${unsupported.map(([id]) => id).join(', ')}`)
    const active = rules.filter(rule => loaded.config.rules[rule.id]?.mode !== 'off')
    if (active.length === 0) return incomplete('no standalone rules enabled in the baseline configuration')

    const temp = resolve(tmpdir())
    const work = await mkdtemp(join(temp, 'c-check-verify-'))
    const state = newSessionState(randomUUID(), root)
    state.baseline = { tree }
    state.explicitBaseline = true
    state.indexPath = join(work, 'index')
    state.testScriptPath = join(work, 'test.cmd')
    const lines: LogLine[] = []
    try {
      const env = { GIT_INDEX_FILE: state.indexPath }
      try {
        // Preserve tracked paths that also match ignore patterns without touching the real index.
        await copyFile(index.stdout.trimEnd(), state.indexPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const seed = await git(nodePorts, root, ['read-tree', tree], env)
        if (seed.exitCode !== 0) return incomplete('could not initialize the private index')
      }
      const exclude = await git(nodePorts, root, ['rm', '--cached', '-rf', '--ignore-unmatch', '--', '.c-check'], env)
      if (exclude.exitCode !== 0) return incomplete('could not exclude c-check state from the private index')
      await runEvent({ point: 'end', projectRoot: root, sessionId: state.id, timestamp: new Date().toISOString() }, {
        rules: active, state, ports: nodePorts, logger: { write: async line => { lines.push(line) } }, loadedConfig: loaded,
      })
    } finally {
      if (dirname(work) === temp) await rm(work, { recursive: true, force: true, maxRetries: 3 })
    }

    let failed = false
    let unfinished = false
    let enforced = 0
    for (const rule of rules) {
      const line = lines.find(row => row.rule === rule.id && row.verdict !== undefined)
      if (line === undefined) {
        console.log(`${rule.id} off`)
        continue
      }
      if (line.mode === 'enforce') enforced += 1
      const details = line.details as { timedOut?: boolean; exitCode?: number } | undefined
      const commandMissing = rule === testsPassBeforeDone && [126, 127, 9009].includes(details?.exitCode ?? 0)
      const missing = line.event !== undefined || details?.timedOut === true || line.verdict === 'warn' || commandMissing
      if (missing && line.mode === 'enforce') unfinished = true
      if (!missing && line.verdict !== 'allow' && line.mode === 'enforce') failed = true
      console.log(`${rule.id} ${line.mode} ${missing ? 'incomplete' : line.verdict === 'allow' ? 'passed' : 'finding'}`)
    }
    console.log('Other c-check rules are unavailable in standalone verification.')
    if (enforced === 0) return incomplete('no enforced standalone rules completed')
    return unfinished ? 2 : failed ? 1 : 0
  } catch {
    return incomplete('could not complete verification')
  }
}
