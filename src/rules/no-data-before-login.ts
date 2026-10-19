import { TimeoutError, type Rule, type RuleConfig, type RuleContext, type Verdict } from '../engine/types'
import { snapshot } from './git'

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
    const tree = (await snapshot(ctx.ports, event.projectRoot, event.sessionId).catch(() => null))?.tree

    // Never logs body text, headers or URLs: only the route and counts.
    const get = (path: string) => fetchPath(`http://127.0.0.1:${port}${path}`, event.projectRoot, ctx)
    const replies: RouteReply[] = []
    const logged: unknown[] = []
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
      logged.push({ route, status, bodyChars: body.length, scripts: bodies.length - 1 })
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
