// Path helpers that work on POSIX and Windows paths without Node's path module (mods cannot import Node built-ins).

export const isWindowsPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')

const isAbsolute = (p: string): boolean => p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:([\\/]|$)/.test(p)

/** Joins `p` onto `base` when relative, then folds `.` and `..`. Uses `/` separators; keeps a drive letter. */
export function resolvePath(base: string, p: string): string {
  const full = isAbsolute(p) ? p : `${base}/${p}`
  const s = full.replace(/\\/g, '/')
  const drive = /^[A-Za-z]:/.exec(s)?.[0] ?? ''
  const rest = s.slice(drive.length)
  const out: string[] = []
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `${drive.toUpperCase()}/${out.join('/')}`
}

/** True when `child` is `root` or inside it. Both should be resolved. Case-insensitive for Windows paths. */
export function isInside(child: string, root: string): boolean {
  const fold = isWindowsPath(root) || isWindowsPath(child)
  const c = fold ? child.toLowerCase() : child
  const r = (fold ? root.toLowerCase() : root).replace(/\/+$/, '')
  return c === r || c.startsWith(`${r}/`) || r === '' // r === '' only when root is "/"
}

/** Project-relative POSIX path, or null when outside the root. */
export function relativeTo(root: string, p: string): string | null {
  const r = resolvePath(root, '.')
  const a = resolvePath(root, p)
  if (!isInside(a, r)) return null
  return a.slice(r.replace(/\/+$/, '').length + 1)
}

export const baseName = (p: string): string => p.replace(/\\/g, '/').split('/').pop() ?? p
