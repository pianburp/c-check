import { baseName, resolvePath } from '../engine/paths'
import { filePathOf, isWriteTool, newTextsOf, outputFailed } from '../engine/tools'
import type { Rule } from '../engine/types'

const ID = 'no-secrets-in-files'

export const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/ },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { name: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Stripe key', re: /\b[sr]k_live_[0-9a-zA-Z]{24,}\b/ },
  { name: 'private key', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  {
    name: 'password literal',
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b["']?\s*[:=]\s*["']([^"'\s]{6,})["']/i,
  },
]
const ENV_LINE = /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)\s*=\s*["']?([^\s"'#]{6,})/
// Values that point at a secret instead of being one.
const PLACEHOLDER = /^(?:\$|\{\{|<|%|process\.env|os\.environ|env\(|getenv|your[_-]|xxx|\*{3}|changeme|example|placeholder|dummy|test|fake|redacted)/i

/** Line numbers (1-based) where `text` looks like it holds a secret, with the pattern name. Values are never returned. */
export function findSecrets(text: string, fileName: string): Array<{ line: number; pattern: string }> {
  const isEnvFile = /^\.env/i.test(fileName)
  const hits: Array<{ line: number; pattern: string }> = []
  text.split(/\r?\n/).forEach((line, i) => {
    for (const { name, re } of SECRET_PATTERNS) {
      const m = re.exec(line)
      if (m && !(m[1] !== undefined && PLACEHOLDER.test(m[1]))) {
        hits.push({ line: i + 1, pattern: name })
        return
      }
    }
    const env = isEnvFile ? null : ENV_LINE.exec(line)
    if (env && !PLACEHOLDER.test(env[1] as string)) hits.push({ line: i + 1, pattern: '.env-style line' })
  })
  return hits
}

export const noSecretsInFiles: Rule = {
  id: ID,
  description: 'After a file write or edit, scans the new content for secrets.',
  points: ['after'],
  defaultMode: 'observe',
  async check(event, { ports }) {
    if (!isWriteTool(event.tool) || outputFailed(event.output)) return { kind: 'allow', ruleId: ID }
    const file = filePathOf(event.input)
    if (file === undefined) return { kind: 'allow', ruleId: ID }
    const name = baseName(file)
    // .env files are where secrets belong.
    if (/^\.env(\.|$)/i.test(name) && !/\.(example|sample|template)$/i.test(name)) return { kind: 'allow', ruleId: ID }

    const after = event.tool === 'Write' ? null : await ports.read(resolvePath(event.projectRoot, file)).catch(() => null)
    const lines: number[] = []
    const patterns = new Set<string>()
    for (const text of newTextsOf(event.tool, event.input)) {
      // Line numbers are in the file: find where the new text landed.
      const at = after?.indexOf(text) ?? -1
      const offset = at > 0 ? (after as string).slice(0, at).split('\n').length - 1 : 0
      for (const hit of findSecrets(text, name)) {
        lines.push(hit.line + offset)
        patterns.add(hit.pattern)
      }
    }
    if (lines.length === 0) return { kind: 'allow', ruleId: ID }
    const where = lines.length === 1 ? `line ${lines[0]}` : `lines ${lines.join(', ')}`
    return {
      kind: 'warn',
      ruleId: ID,
      message: `This file may contain a secret at ${where} of ${file}. Move it to an environment variable.`,
      details: { file, lines, patterns: [...patterns] },
    }
  },
}
