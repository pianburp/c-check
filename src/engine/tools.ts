// Facts about Claude Code's built-in tools that several rules share.

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

export const isWriteTool = (tool: string | undefined): boolean => tool !== undefined && WRITE_TOOLS.has(tool)
export const isShellTool = (tool: string | undefined): boolean => tool !== undefined && SHELL_TOOLS.has(tool)

/** The file a write tool targets, as Claude gave it. */
export function filePathOf(input: Record<string, unknown> | undefined): string | undefined {
  const p = input?.file_path ?? input?.notebook_path
  return typeof p === 'string' && p !== '' ? p : undefined
}

/** The new text a write tool puts into the file. */
export function newTextsOf(tool: string | undefined, input: Record<string, unknown> | undefined): string[] {
  if (input === undefined) return []
  if (tool === 'Write' && typeof input.content === 'string') return [input.content]
  if (tool === 'Edit' && typeof input.new_string === 'string') return [input.new_string]
  if (tool === 'NotebookEdit' && typeof input.new_source === 'string') return [input.new_source]
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.flatMap(e => (typeof (e as { new_string?: unknown })?.new_string === 'string' ? [(e as { new_string: string }).new_string] : []))
  }
  return []
}

/** True when the after-event output says the tool was refused or failed. */
export function outputFailed(output: unknown): boolean {
  if (typeof output !== 'object' || output === null) return false
  const o = output as { deny?: unknown; isError?: unknown }
  return o.deny !== undefined || o.isError === true
}
