import { isInside, resolvePath } from '../engine/paths'
import { filePathOf, isWriteTool } from '../engine/tools'
import type { Ports, Rule } from '../engine/types'

const ID = 'no-outside-edits'

/** Where `p` really lands: the deepest existing ancestor with symlinks followed, plus the parts not yet created. */
export async function landingPath(ports: Ports, p: string): Promise<string> {
  const parts = resolvePath('/', p).split('/')
  const tail: string[] = []
  while (parts.length > 1) {
    const real = await ports.realPath(parts.join('/') || '/')
    if (real !== undefined) return resolvePath(real, tail.reverse().join('/') || '.')
    tail.push(parts.pop() as string)
  }
  return resolvePath('/', p)
}

export const noOutsideEdits: Rule = {
  id: ID,
  description: 'Blocks file edits whose target, after resolving .. and symlinks, is outside the project.',
  points: ['before'],
  kind: 'safety',
  defaultMode: 'enforce',
  async check(event, { ports }) {
    if (!isWriteTool(event.tool)) return { kind: 'allow', ruleId: ID }
    const file = filePathOf(event.input)
    if (file === undefined) return { kind: 'allow', ruleId: ID }

    const root = (await ports.realPath(event.projectRoot)) ?? event.projectRoot
    const target = await landingPath(ports, resolvePath(event.projectRoot, file))
    if (isInside(target, resolvePath(root, '.'))) return { kind: 'allow', ruleId: ID }
    return {
      kind: 'block',
      ruleId: ID,
      message: `This file is outside the project. Edit files inside ${event.projectRoot} only.`,
      details: { target },
    }
  },
}
