import type { Rule } from '../engine/types'
import { sessionChanges } from './git'

const ID = 'claimed-changes-are-real'

export const claimedChangesAreReal: Rule = {
  id: ID,
  description: 'Compares files Claude edited with file tools against what git says really changed this session.',
  points: ['end'],
  defaultMode: 'observe',
  async check(_event, ctx) {
    const changes = await sessionChanges(ctx)
    if (changes === null) return { kind: 'allow', ruleId: ID, details: { skipped: 'no git' } }

    const real = new Set(changes.files.map(f => f.path))
    const claimed = ctx.state.changedFiles
    // Files under .gitignore never show in git, so they cannot be judged either way.
    const noEffect = [...claimed].filter(f => !real.has(f) && !f.startsWith('.c-check/'))
    const unreported = [...real].filter(f => !claimed.has(f))
    if (noEffect.length === 0 && unreported.length === 0) return { kind: 'allow', ruleId: ID }

    const parts: string[] = []
    if (noEffect.length > 0) parts.push(`edited but no real change: ${noEffect.join(', ')}`)
    if (unreported.length > 0) parts.push(`changed without a file edit (shell or other tool): ${unreported.join(', ')}`)
    return {
      kind: 'warn',
      ruleId: ID,
      message: `Edits and real changes do not match. ${parts.join('. ')}. Check these files and mention any change you did not intend in your final message.`,
      details: { noEffect, unreported },
    }
  },
}
