// 95% Wilson score interval for a rate. No library.
export function wilson(successes: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 1 }
  const p = successes / n
  const d = 1 + z * z / n
  const c = (p + z * z / (2 * n)) / d
  const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) }
}

/** "0/40 (0.0%–8.8%)"; "0/0 (n/a)" when there are no runs. */
export function formatRate(successes: number, n: number): string {
  if (n <= 0) return `${successes}/${n} (n/a)`
  const { lo, hi } = wilson(successes, n)
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  return `${successes}/${n} (${pct(lo)}–${pct(hi)})`
}
