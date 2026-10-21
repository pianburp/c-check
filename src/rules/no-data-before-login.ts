import { TimeoutError, type Rule, type RuleConfig, type RuleContext, type Verdict } from '../engine/types'
import { sessionChanges } from './git'

const ID = 'no-data-before-login'
const MAX_BODY = 2 * 1024 * 1024
const MAX_SCRIPTS = 10
const CURL_COULD_NOT_CONNECT = 7

/** What one route answered without a login; the detectors read `bodies`. */
export interface RouteReply {
  route: string
  status: number
  bodies: string[]
}

/** Splits `curl -i` output into status, content-type and body (cut at 2 MB). */
export function parseReply(out: string): { status: number; contentType: string; body: string } {
  const m = /\r?\n\r?\n/.exec(out)
  const head = m ? out.slice(0, m.index) : out
  return {
    status: Number(/^HTTP\/\S+\s+(\d{3})/.exec(head)?.[1] ?? 0),
    contentType: /^content-type:\s*(.*)$/im.exec(head)?.[1]?.trim() ?? '',
    body: (m ? out.slice(m.index + m[0].length) : '').slice(0, MAX_BODY),
  }
}

/** Same-origin `<script src>` paths (with query) of an HTML page, at most 10. */
export function scriptPaths(html: string, route: string, port: number): string[] {
  const base = `http://127.0.0.1:${port}${route}`
  const paths = new Set<string>()
  for (const m of html.matchAll(/<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const u = new URL(m[1] as string, base)
      if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port === String(port)) paths.add(u.pathname + u.search)
    } catch {
      // not a URL: ignored
    }
    if (paths.size >= MAX_SCRIPTS) break
  }
  return [...paths]
}

// Thresholds from the plan: the detectors return raw counts, `leaks` applies these.
export const MIN = { emails: 3, phones: 3, 'ic-numbers': 1, 'record-array': 20 } as const
export type Detector = keyof typeof MIN

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const PHONE = /\+\d{1,3}[\s-]?\(?\d{1,4}\)?(?:[\s-]?\d{2,4}){2,4}|\b01\d[\s-]?\d{3,4}[\s-]?\d{4}\b/g
const IC = /\b\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])-\d{2}-\d{4}\b/g

/** Distinct emails, case-insensitive, without the allowed ones. */
export function emails(text: string, allow: readonly string[] = []): number {
  const skip = new Set(allow.map(a => a.toLowerCase()))
  return new Set([...text.matchAll(EMAIL)].map(m => m[0].toLowerCase()).filter(e => !skip.has(e))).size
}

/** Distinct phone numbers (by digits; +60 and 0 prefixes are one number). */
export function phones(text: string): number {
  const digits = [...text.matchAll(PHONE)].map(m => (m[0].startsWith('+60') ? '0' + m[0].slice(3) : m[0]).replace(/\D/g, ''))
  return new Set(digits.filter(d => d.length >= 9 && d.length <= 16)).size
}

export function icNumbers(text: string): number {
  return new Set(text.match(IC)).size
}

/** Size of the biggest JSON array in the text whose objects share one key set; 0 when none has 20. Never throws. */
export function recordArray(text: string): number {
  let best = 0
  let tries = 0
  for (let i = text.indexOf('['); i >= 0 && tries < 100; i = text.indexOf('[', i + 1)) {
    tries++
    const end = arrayEnd(text, i)
    if (end < 0) continue
    try {
      const arr: unknown = JSON.parse(text.slice(i, end + 1))
      if (!Array.isArray(arr)) continue
      const shapes = new Map<string, number>()
      for (const o of arr) {
        if (o === null || typeof o !== 'object' || Array.isArray(o)) continue
        const k = Object.keys(o).sort().join(',')
        shapes.set(k, (shapes.get(k) ?? 0) + 1)
      }
      best = Math.max(best, ...shapes.values())
      i = end
    } catch {
      // not JSON: next candidate
    }
  }
  return best >= MIN['record-array'] ? best : 0
}

/** Index of the `]` closing the `[` at `from`, string-aware; -1 when unbalanced. */
function arrayEnd(text: string, from: number): number {
  let depth = 0
  let quoted = false
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '\\') i++
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === '[') depth++
    else if (c === ']' && --depth === 0) return i
  }
  return -1
}

/** Counts of every detector on one route's bodies; the rule compares them with `MIN`. */
export function scan(text: string, allowEmails: readonly string[] = []): Record<Detector, number> {
  return { emails: emails(text, allowEmails), phones: phones(text), 'ic-numbers': icNumbers(text), 'record-array': recordArray(text) }
}

export const noDataBeforeLogin: Rule = {
  id: ID,
  description: 'Asks the dev server you already run for the configured pages without a login, and looks for private data in the answers.',
  points: ['end'],
  kind: 'safety',
  defaultMode: 'observe',
  async check(event, ctx) {
    const skip = (why: string): Verdict => ({ kind: 'allow', ruleId: ID, details: { skipped: why } })
    const { port, routes } = leakCheckTarget(ctx.config)
    if (port === undefined) return skip('not configured')
    // Taken before the requests, so the recorded tree is never newer than what the server answered.
    // The shared end snapshot: a second snapshot at the same time fights the other end rules over the same git index lock.
    const tree = (await sessionChanges(ctx).catch(() => null))?.current.tree
    if (tree !== undefined && tree === ctx.state.leakCheckPassedTree) return skip('tree unchanged')
    const allowEmails = Array.isArray(ctx.config.allowEmails) ? ctx.config.allowEmails.filter((e): e is string => typeof e === 'string') : []

    // Never logs body text, headers or URLs: only the route and counts.
    const get = (path: string) => fetchPath(`http://127.0.0.1:${port}${path}`, event.projectRoot, ctx)
    const replies: RouteReply[] = []
    const logged: unknown[] = []
    const leaks: string[] = []
    for (const [i, route] of routes.entries()) {
      const first = await get(route)
      if (first === 'no curl') return skip('curl not found')
      if (first === 'no app') {
        if (i === 0) return skip('app not running')
        continue
      }
      if (first === null) continue
      const { status, contentType, body } = parseReply(first)
      const bodies = [body]
      if (/html/i.test(contentType)) {
        for (const path of scriptPaths(body, route, port)) {
          const js = await get(path)
          if (typeof js === 'string') bodies.push(parseReply(js).body)
        }
      }
      replies.push({ route, status, bodies })
      const detectors = scan(bodies.join('\n'), allowEmails)
      logged.push({ route, status, detectors, bodyChars: body.length, scripts: bodies.length - 1 })
      const hits = (Object.keys(MIN) as Detector[]).filter(d => detectors[d] >= MIN[d])
      if (hits.length > 0) leaks.push(`${route} (${hits.map(d => `${d}: ${detectors[d]}`).join(', ')})`)
    }
    if (leaks.length > 0) {
      const message = `This page sends personal data to users who are not logged in: ${leaks.join('; ')}. Check for a valid session on the server before you load the data. Do not hide it with CSS or client code: the browser already has it.`
      return { kind: 'send_back', ruleId: ID, message, details: { routes: logged } }
    }
    // A route that failed was not checked, so it cannot count as a pass.
    if (replies.length === routes.length && tree !== undefined) ctx.state.leakCheckPassedTree = ctx.state.treeCache = tree
    return { kind: 'allow', ruleId: ID, details: { routes: logged } }
  },
}

/** The port and routes R10 checks; port is undefined when R10 is not configured. R11 uses the same test. */
export function leakCheckTarget(config: RuleConfig): { port: number | undefined; routes: string[] } {
  const { port } = config
  const routes = Array.isArray(config.routes) ? config.routes.filter((r): r is string => typeof r === 'string' && r.startsWith('/')) : []
  const ok = typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535 && routes.length > 0
  return { port: ok ? port : undefined, routes }
}

/** curl -i output; null when this request failed (fail open); 'no app' when nothing listens; 'no curl' when curl cannot run. No -L: a redirect is data. */
async function fetchPath(url: string, cwd: string, { ports }: RuleContext): Promise<string | null | 'no app' | 'no curl'> {
  try {
    const r = await ports.run(['curl', '-s', '-i', '--max-time', '10', url], { cwd, timeoutMs: 15_000 })
    if (r.exitCode === CURL_COULD_NOT_CONNECT) return 'no app'
    return r.exitCode === 0 ? r.stdout : null
  } catch (err) {
    return err instanceof TimeoutError ? null : 'no curl'
  }
}
