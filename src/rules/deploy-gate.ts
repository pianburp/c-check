import { loadConfig } from '../config/config'
import { isShellTool } from '../engine/tools'
import type { Rule, Verdict } from '../engine/types'
import { snapshot } from './git'
import { leakCheckTarget } from './no-data-before-login'
import { compile, splitCommands } from './no-risky-commands'

const ID = 'deploy-gate'
const LEAK_RULE = 'no-data-before-login'
const MESSAGE = 'c-check has not checked this code for data leaks yet. Finish your task first so c-check can run its end checks, then deploy.'

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep'])

// Names go in the log, never the command.
export const DEPLOY_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'railway up', re: /\brailway\s+up\b/i },
  { name: 'vercel --prod', re: /\bvercel\b.*\s--prod\b/i },
  { name: 'netlify deploy --prod', re: /\bnetlify\s+deploy\b.*\s--prod\b/i },
  { name: 'fly deploy', re: /\bfly\s+deploy\b/i },
  { name: 'firebase deploy', re: /\bfirebase\s+deploy\b/i },
  { name: 'wrangler deploy', re: /\bwrangler\s+deploy\b/i },
]

export const deployGate: Rule = {
  id: ID,
  description: 'Blocks a deploy command until the data-leak check has passed on the exact code being deployed.',
  points: ['before', 'after'],
  kind: 'safety',
  defaultMode: 'observe',
  async check(event, { config, state, ports }) {
    const allow = (details?: unknown): Verdict => ({ kind: 'allow', ruleId: ID, ...(details !== undefined && { details }) })
    if (event.point === 'after') {
      // Bash and MCP tools can change files too, so only known read-only tools keep the cache.
      if (!READ_ONLY_TOOLS.has(event.tool ?? '')) state.treeCache = undefined
      return allow()
    }
    const command = event.input?.command
    if (!isShellTool(event.tool) || typeof command !== 'string') return allow()
    if (compile(config.allowPatterns).some(re => re.test(command))) return allow({ allowedBy: 'allowPatterns' })

    const extra = compile(config.extraPatterns)
    const parts = splitCommands(command)
    const hit = DEPLOY_PATTERNS.find(p => parts.some(s => p.re.test(s)))?.name ?? (parts.some(s => extra.some(re => re.test(s))) ? 'extraPatterns' : undefined)
    if (hit === undefined) return allow()

    // R11 only gets its own config, so read R10's resolved config the way the engine does.
    const leak = (await loadConfig(event.projectRoot, ports)).config.rules[LEAK_RULE]
    if (leak?.mode === 'off' || leakCheckTarget(leak ?? {}).port === undefined) return allow({ pattern: hit, skipped: 'no leak check configured' })

    const tree = (state.treeCache ??= (await snapshot(ports, event.projectRoot, event.sessionId))?.tree)
    if (tree !== undefined && tree === state.leakCheckPassedTree) return allow({ pattern: hit, tree })
    return { kind: 'block', ruleId: ID, message: MESSAGE, details: { pattern: hit } }
  },
}
