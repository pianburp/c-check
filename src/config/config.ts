import type { Ports, RuleConfig, RuleMode } from '../engine/types'

export interface Config {
  rules: Record<string, RuleConfig>
  maxSendBacks: number
  logDir: string
}

export interface LoadedConfig {
  config: Config
  /** Problems to tell Claude once per session. */
  warnings: string[]
}

export const CONFIG_FILE = 'c-check.config.json'

export const DEFAULTS: Config = {
  rules: {
    'tests-pass-before-done': { mode: 'enforce', timeoutSec: 300 },
    'no-outside-edits': { mode: 'enforce' },
    'no-risky-commands': { mode: 'observe', extraPatterns: [], allowPatterns: [] },
    'no-secrets-in-files': { mode: 'observe' },
    'claimed-changes-are-real': { mode: 'observe' },
    'no-test-weakening': { mode: 'enforce' },
    'no-test-bloat': { mode: 'observe', unitTestDir: 'tests/unit', maxTestToSourceRatio: 2, maxNewTestCases: 5 },
    'tests-still-bite': { mode: 'observe' },
    'judge-special-cases': { mode: 'off', maxDiffLines: 400, timeoutSec: 60, model: 'sonnet' },
    'no-data-before-login': { mode: 'observe' },
  },
  maxSendBacks: 3,
  logDir: '.c-check/logs',
}

const MODES: readonly RuleMode[] = ['off', 'observe', 'enforce']
const TOP_KEYS = new Set(['rules', 'maxSendBacks', 'logDir'])

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Reads c-check.config.json at the project root. Never throws: bad input falls back to defaults with a warning. */
export async function loadConfig(root: string, ports: Ports): Promise<LoadedConfig> {
  const fresh = (): Config => ({ ...DEFAULTS, rules: Object.fromEntries(Object.entries(DEFAULTS.rules).map(([k, v]) => [k, { ...v }])) })
  let text: string | null
  try {
    text = await ports.read(`${root}/${CONFIG_FILE}`)
  } catch {
    text = null
  }
  if (text === null) return { config: fresh(), warnings: [] }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { config: fresh(), warnings: [`c-check: ${CONFIG_FILE} is not valid JSON (${(err as Error).message}). Using default settings.`] }
  }
  if (!isObject(raw)) return { config: fresh(), warnings: [`c-check: ${CONFIG_FILE} must hold a JSON object. Using default settings.`] }

  const config = fresh()
  const unknown: string[] = Object.keys(raw).filter(k => !TOP_KEYS.has(k))
  if (typeof raw.maxSendBacks === 'number' && raw.maxSendBacks >= 0) config.maxSendBacks = Math.floor(raw.maxSendBacks)
  if (typeof raw.logDir === 'string' && raw.logDir !== '') config.logDir = raw.logDir
  if (isObject(raw.rules)) {
    for (const [id, value] of Object.entries(raw.rules)) {
      const base = config.rules[id]
      if (base === undefined) {
        unknown.push(`rules.${id}`)
        continue
      }
      if (!isObject(value)) continue
      const merged: RuleConfig = { ...base, ...value }
      if (!MODES.includes(merged.mode as RuleMode)) merged.mode = base.mode
      config.rules[id] = merged
    }
  }
  const warnings = unknown.length > 0 ? [`c-check: unknown keys in ${CONFIG_FILE} were ignored: ${unknown.join(', ')}.`] : []
  return { config, warnings }
}
