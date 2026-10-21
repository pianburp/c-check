import { afterAll, describe, expect, test } from 'vitest'
import { makeRepo, type Repo } from './harness'

const RULE = 'no-secrets-in-files'
const repos: Repo[] = []
afterAll(() => repos.forEach(r => r.cleanup()))

async function session(mode = 'enforce') {
  const r = await makeRepo({ 'src/config.js': 'export const a = 1\nexport const b = 2\n' }, { config: { rules: { 'tests-pass-before-done': { mode: 'off' }, [RULE]: { mode } } } })
  repos.push(r)
  await r.start()
  return r
}

// Built from parts so this file itself holds no secret-shaped strings.
const k = (...parts: string[]) => parts.join('')
const AWS = k('AKIA', 'Q3EXAMPLE7KEY2AB')
const GH = k('ghp_', 'a'.repeat(36))
const ANT = k('sk-ant-', 'api03-', 'b'.repeat(40))
const PEM = k('-----BEGIN ', 'RSA PRIVATE KEY-----')
const SLACK = k('xoxb-', '1234567890-abcdefghij')
const GOOGLE = k('AIza', 'c'.repeat(35))
const STRIPE = k('sk_live_', 'd'.repeat(24))

describe.concurrent('no-secrets-in-files: bad cases warn', () => {
  const bad: Array<[string, string, Record<string, unknown>, number]> = [
    ['AWS key in a new file', 'Write', { file_path: 'src/aws.js', content: `const id = "${AWS}"\n` }, 1],
    ['GitHub token on line 3', 'Write', { file_path: 'src/gh.js', content: `// a\n// b\nconst t = "${GH}"\n` }, 3],
    ['Anthropic key', 'Write', { file_path: 'src/ant.py', content: `KEY = "${ANT}"\n` }, 1],
    ['private key header', 'Write', { file_path: 'id_rsa.txt', content: `${PEM}\nMIIE...\n` }, 1],
    ['Slack token', 'Write', { file_path: 'src/slack.js', content: `x\n'${SLACK}'\n` }, 2],
    ['Google API key', 'Write', { file_path: 'src/g.js', content: `const g = '${GOOGLE}'\n` }, 1],
    ['Stripe live key', 'Write', { file_path: 'src/s.js', content: `const s = '${STRIPE}'\n` }, 1],
    ['password literal', 'Write', { file_path: 'src/db.js', content: `const db = { password: "hunter2hunter2" }\n` }, 1],
    ['api_key in JSON', 'Write', { file_path: 'settings.json', content: `{\n  "api_key": "abcd1234efgh"\n}\n` }, 2],
    ['.env-style line in a non-env file', 'Write', { file_path: 'deploy.sh', content: `#!/bin/sh\nexport DB_PASSWORD=s3cr3tvalue\n` }, 2],
    ['Edit adds a key: line number is in the file', 'Edit', { file_path: 'src/config.js', old_string: 'export const b = 2', new_string: `export const b = 2\nexport const key = "${AWS}"`, replace_all: false }, 3],
  ]
  for (const [name, tool, args, line] of bad) {
    test(name, async () => {
      const r = await session()
      const res = await r.tool(tool, { ...args, file_path: `${r.root}/${args.file_path as string}` })
      expect(res.deny).toBeUndefined()
      expect(res.context.join('\n')).toContain(`This file may contain a secret at line ${line} of`)
      expect(res.context.join('\n')).toContain('Move it to an environment variable.')
      const logged = r.lines(RULE).at(-1)
      expect(logged).toMatchObject({ point: 'after', verdict: 'warn', applied: 'warn', details: { lines: [line] } })
      // Never log the secret itself.
      expect(JSON.stringify(r.logs())).not.toContain(String(args.content ?? args.new_string).split('\n').find(l => /["'=]/.test(l))?.slice(-12))
    })
  }
})

describe.concurrent('no-secrets-in-files: good cases allow', () => {
  const good: Array<[string, string, Record<string, unknown>]> = [
    ['plain code', 'Write', { file_path: 'src/x.js', content: 'export const x = 1\n' }],
    ['env var reference', 'Write', { file_path: 'src/x.js', content: 'const key = process.env.API_KEY\n' }],
    ['placeholder password', 'Write', { file_path: 'src/x.js', content: 'const db = { password: "changeme" }\n' }],
    ['test fixture password', 'Write', { file_path: 'src/x.js', content: 'const db = { password: "test1234" }\n' }],
    ['secret in a .env file', 'Write', { file_path: '.env', content: `API_KEY=${AWS}\n` }],
    ['template variable', 'Write', { file_path: 'src/x.yml', content: 'password: "${DB_PASSWORD}"\n' }],
    ['short password value', 'Write', { file_path: 'src/x.js', content: 'const p = { password: "abc" }\n' }],
    ['.env.example with placeholders', 'Write', { file_path: '.env.example', content: 'API_KEY=your-key-here\n' }],
    ['word password in prose', 'Write', { file_path: 'README.md', content: 'Set your password in the settings page.\n' }],
    ['Edit with clean text', 'Edit', { file_path: 'src/config.js', old_string: 'export const a = 1', new_string: 'export const a = 3', replace_all: false }],
    ['Bash is not a file write', 'Bash', { command: `echo ${AWS}` }],
    ['failed edit is not scanned', 'Edit', { file_path: 'src/config.js', old_string: 'not there', new_string: `const k = "${AWS}"`, replace_all: false }],
  ]
  for (const [name, tool, args] of good) {
    test(name, async () => {
      const r = await session()
      const res = await r.tool(tool, args.file_path !== undefined ? { ...args, file_path: `${r.root}/${args.file_path as string}` } : args)
      expect(res.context).toBeUndefined()
      expect(r.lines(RULE).at(-1)).toMatchObject({ point: 'after', applied: 'allow' })
    })
  }

  test('observe mode: Claude sees nothing, the log has the warn', async () => {
    const r = await session('observe')
    const res = await r.tool('Write', { file_path: `${r.root}/a.js`, content: `const id = "${AWS}"\n` })
    expect(res.context).toBeUndefined()
    expect(r.lines(RULE).at(-1)).toMatchObject({ verdict: 'warn', applied: 'allow' })
  })
})
