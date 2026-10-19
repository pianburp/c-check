import type { Ports, RuleContext, Snapshot } from '../engine/types'

const GIT_TIMEOUT_MS = 30_000

export interface FileDiff {
  path: string // project-relative, POSIX
  status: 'A' | 'M' | 'D' | string
  added: string[]
  removed: string[]
}

export interface SessionChanges {
  baseline: Snapshot
  current: Snapshot
  files: FileDiff[]
}

export const git = (ports: Ports, root: string, args: string[], env?: Record<string, string>) =>
  ports.run(['git', '-c', 'core.quotepath=off', ...args], { cwd: root, timeoutMs: GIT_TIMEOUT_MS, ...(env !== undefined && { env }) })

/**
 * Hashes the whole working tree (untracked files too, .gitignore respected) into a git tree object,
 * through a private index so the user's staging area is never touched. Null when root is not a git repo.
 * shortcut: the first snapshot of a session hashes every file; slow on very large repos. Later ones reuse the index's stat cache.
 */
export async function snapshot(ports: Ports, root: string, sessionId: string): Promise<Snapshot | null> {
  const dir = await git(ports, root, ['rev-parse', '--absolute-git-dir'])
  if (dir.exitCode !== 0) return null
  const env = { GIT_INDEX_FILE: `${dir.stdout.trim()}/c-check-index-${sessionId.replace(/[^\w-]/g, '_')}` }
  const add = await git(ports, root, ['add', '-A', '--', '.', ':(exclude).c-check'], env)
  if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr.trim().split('\n')[0]}`)
  const tree = await git(ports, root, ['write-tree'], env)
  if (tree.exitCode !== 0) throw new Error(`git write-tree failed: ${tree.stderr.trim().split('\n')[0]}`)
  return { tree: tree.stdout.trim() }
}

/** Parses `git diff -U0` output into per-file added and removed lines. */
export function parseDiff(names: string, patch: string): FileDiff[] {
  const files = new Map<string, FileDiff>()
  const parts = names.split('\0').filter(Boolean)
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i] as string
    const path = parts[i + 1] as string
    files.set(path, { path, status: status[0] ?? status, added: [], removed: [] })
  }
  let current: FileDiff | undefined
  let oldPath: string | undefined
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = undefined
      oldPath = undefined
    } else if (line.startsWith('--- ')) {
      oldPath = line === '--- /dev/null' ? undefined : line.slice(6)
    } else if (line.startsWith('+++ ')) {
      const path = line === '+++ /dev/null' ? oldPath : line.slice(6)
      current = path !== undefined ? files.get(path) : undefined
    } else if (current !== undefined && line.startsWith('+')) {
      current.added.push(line.slice(1))
    } else if (current !== undefined && line.startsWith('-')) {
      current.removed.push(line.slice(1))
    }
  }
  return [...files.values()]
}

export async function diffTrees(ports: Ports, root: string, a: string, b: string): Promise<FileDiff[]> {
  if (a === b) return []
  const names = await git(ports, root, ['diff', '--no-renames', '--name-status', '-z', a, b])
  const patch = await git(ports, root, ['diff', '--no-renames', '--no-color', '--no-ext-diff', '-U0', a, b])
  return parseDiff(names.stdout, patch.stdout)
}

/** File text at a snapshot, or null when absent there. */
export async function showAt(ports: Ports, root: string, tree: string, path: string): Promise<string | null> {
  const r = await git(ports, root, ['show', `${tree}:${path}`])
  return r.exitCode === 0 ? r.stdout : null
}

/**
 * What changed in the working tree since the session started. Computed once per end event and shared by end rules.
 * Null when the project is not a git repo.
 */
export function sessionChanges(ctx: RuleContext): Promise<SessionChanges | null> {
  const { state, ports } = ctx
  state.endCache ??= (async (): Promise<SessionChanges | null> => {
    const current = await snapshot(ports, state.root, state.id)
    if (current === null) return null
    // No baseline when the mod loaded mid-session: start counting from now.
    if (state.baseline == null) state.baseline = current
    return { baseline: state.baseline, current, files: await diffTrees(ports, state.root, state.baseline.tree, current.tree) }
  })()
  return state.endCache as Promise<SessionChanges | null>
}

const TEST_PATH = /(^|\/)(tests?|__tests__|specs?)\/|(^|\/)[^/]*[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb)$/i

export const isTestPath = (path: string): boolean => TEST_PATH.test(path)
