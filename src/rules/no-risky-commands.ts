import { isInside, resolvePath } from '../engine/paths'
import { isShellTool } from '../engine/tools'
import type { Rule } from '../engine/types'

const ID = 'no-risky-commands'

// Each pattern names the damage it guards against, so the log says which one fired.
export const DENY_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'git push --force', re: /\bgit\b[^;&|\n]*\bpush\b[^;&|\n]*(?:\s--force\b|\s-[a-zA-Z]*f[a-zA-Z]*\b|\s\+\S)/ },
  { name: 'git reset --hard', re: /\bgit\b[^;&|\n]*\breset\b[^;&|\n]*\s--hard\b/ },
  { name: 'DROP TABLE/DATABASE', re: /\bdrop\s+(?:table|database|schema)\b/i },
  { name: 'pipe download to shell', re: /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^;&\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|python3?|iex|Invoke-Expression)\b/i },
]

/** Splits a command into simple commands on ; && || | and newlines, then into words. Quotes are stripped, not parsed. */
const simpleCommands = (command: string): string[][] =>
  command
    .split(/;|&&|\|\||\||\n/)
    .map(s => s.trim().split(/\s+/).map(w => w.replace(/^["']|["']$/g, '')).filter(Boolean))
    .filter(ws => ws.length > 0)

/** `rm` with both recursive and force flags, aimed at /, ~, or a path outside the project. */
function dangerousRm(command: string, root: string): string | undefined {
  for (const words of simpleCommands(command)) {
    const i = words.findIndex(w => w === 'rm' || w.endsWith('/rm'))
    if (i < 0) continue
    const args = words.slice(i + 1)
    const flags = args.filter(a => a.startsWith('-')).join(' ')
    const recursive = /(^|\s)-[a-zA-Z]*[rR]|--recursive/.test(flags)
    const force = /(^|\s)-[a-zA-Z]*f|--force/.test(flags)
    if (!recursive || !force) continue
    for (const target of args.filter(a => !a.startsWith('-'))) {
      if (/^(\/\*?|~.*)$/.test(target)) return target
      if (target.includes('$') || target.includes('`')) return target // cannot know where a variable points
      if (!isInside(resolvePath(root, target), resolvePath(root, '.'))) return target
    }
  }
  return undefined
}

function compile(patterns: unknown): RegExp[] {
  if (!Array.isArray(patterns)) return []
  return patterns.flatMap(p => {
    try {
      return typeof p === 'string' ? [new RegExp(p, 'i')] : []
    } catch {
      return [] // a bad user pattern is skipped, never a crash
    }
  })
}

export const noRiskyCommands: Rule = {
  id: ID,
  description: 'Blocks shell commands that can cause damage that is hard to undo.',
  points: ['before'],
  defaultMode: 'observe',
  async check(event, { config }) {
    const command = event.input?.command
    if (!isShellTool(event.tool) || typeof command !== 'string') return { kind: 'allow', ruleId: ID }
    if (compile(config.allowPatterns).some(re => re.test(command))) return { kind: 'allow', ruleId: ID, details: { allowedBy: 'allowPatterns' } }

    const hit =
      DENY_PATTERNS.find(p => p.re.test(command))?.name ??
      (dangerousRm(command, event.projectRoot) !== undefined ? 'rm -rf outside project' : undefined) ??
      (compile(config.extraPatterns).find(re => re.test(command)) !== undefined ? 'extraPatterns' : undefined)
    if (hit === undefined) return { kind: 'allow', ruleId: ID }
    return {
      kind: 'block',
      ruleId: ID,
      message: 'This command can cause damage that is hard to undo. Ask the user first, or use a safer command.',
      details: { pattern: hit },
    }
  },
}
