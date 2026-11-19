// Runs the real CLI against a scripted loopback model using only synthetic data.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const entrypoint = process.argv[2] ?? 'codex'
const mode = process.argv[3] ?? 'full'
assert.ok(['full', 'pre-stop', 'untrusted'].includes(mode), 'expected full, pre-stop, or untrusted')
const codex = entrypoint.endsWith('.js') ? process.execPath : entrypoint
const prefix = entrypoint.endsWith('.js') ? [resolve(entrypoint)] : []
const version = execFileSync(codex, [...prefix, '--version'], { encoding: 'utf8' }).trim()
assert.equal(version, 'codex-cli 0.169.0', 'review this probe before changing the pinned CLI')
const temp = resolve(process.env.C_CHECK_PROBE_TMP ?? tmpdir())
const scratch = mkdtempSync(join(temp, 'c-check probe '))
const home = join(scratch, 'codex')
const repo = join(scratch, 'repo')
mkdirSync(join(repo, '.codex'), { recursive: true })
mkdirSync(home)
execFileSync('git', ['init', '--quiet', repo])

const log = join(scratch, 'events.jsonl')
const hook = join(scratch, 'hook.mjs')
writeFileSync(hook, `
import { appendFileSync, readFileSync } from 'node:fs'
const input = JSON.parse(readFileSync(0, 'utf8'))
const event = input.hook_event_name
const command = input.tool_input?.command
const output = input.tool_response
appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  event, tool: input.tool_name, session: input.session_id, turn: input.turn_id,
  toolId: input.tool_use_id, cwdMatches: input.cwd === process.cwd(), source: input.source,
  permissionMode: input.permission_mode,
  inputKeys: Object.keys(input).sort(), toolInputKeys: Object.keys(input.tool_input ?? {}).sort(),
  stopActive: input.stop_hook_active, outputType: typeof output,
}) + '\\n')
let reply = {}
if (event === 'PreToolUse' && command?.includes('denied.txt')) {
  reply = { hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: 'Probe denied the sentinel' } }
} else if (event === 'PostToolUse' && command?.includes('allowed.txt')) {
  reply = { hookSpecificOutput: { hookEventName: event, additionalContext: 'Probe observed the completed edit' } }
} else if (event === 'Stop' && !input.stop_hook_active) {
  reply = { decision: 'block', reason: 'Probe requests one continuation' }
}
process.stdout.write(JSON.stringify(reply))
`)
const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']
const shellQuote = value => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`
const command = `${process.platform === 'win32' ? '& ' : ''}${shellQuote(process.execPath)} ${shellQuote(hook)}`
writeFileSync(join(repo, '.codex', 'hooks.json'), JSON.stringify({ hooks: Object.fromEntries(events.map(event => [event, [
  { hooks: [{ type: 'command', command, timeout: 10 }] },
]])) }))

const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch', ''].join('\n')
const tool = (id, input) => ({ type: 'custom_tool_call', id: `ct_${id}`, call_id: `call_${id}`, name: 'apply_patch', input })
const message = id => ({ type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Probe complete.', annotations: [] }] })
const sequence = mode === 'untrusted' ? [message('first')] : [
  tool('deny', patch('*** Add File: denied.txt', '+denied')),
  ...(mode === 'full' ? [tool('allow', patch('*** Add File: allowed.txt', '+allowed', '*** Add File: second.txt', '+second'))] : []),
  tool('fail', patch('*** Update File: missing.txt', '@@', '-missing', '+updated')),
  message('first'), message('second'),
]
let calls = 0
const modelInputs = []
const server = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  if (request.method !== 'POST' || request.url !== '/v1/responses' || calls >= sequence.length) {
    response.writeHead(400).end('Unexpected probe request')
    return
  }
  modelInputs.push(Buffer.concat(chunks).toString('utf8'))
  const item = sequence[calls++]
  const emit = (type, body) => response.write(`data: ${JSON.stringify({ type, ...body })}\n\n`)
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  emit('response.created', { response: { id: `resp_${calls}` } })
  emit('response.output_item.added', { output_index: 0, item })
  emit('response.output_item.done', { output_index: 0, item })
  emit('response.completed', { response: { id: `resp_${calls}`, status: 'completed', output: [item] } })
  response.end()
})
await new Promise((ready, reject) => server.once('error', reject).listen(0, '127.0.0.1', ready))
try {
  const base = `http://127.0.0.1:${server.address().port}/v1`
  const args = ['exec', '--json', '--ephemeral', '--trust', '--enable', 'hooks',
    ...(mode === 'untrusted' ? [] : ['--dangerously-bypass-hook-trust']),
    ...(process.platform === 'win32' ? ['-c', 'windows.sandbox=unelevated'] : []),
    '--sandbox', 'workspace-write', '-C', repo, '-c', 'model_provider=ccheck_probe', '-c', 'model_providers.ccheck_probe.name=ccheck_probe',
    '-c', `model_providers.ccheck_probe.base_url=${base}`, '-c', 'model_providers.ccheck_probe.wire_api=responses',
    '-c', 'model_providers.ccheck_probe.request_max_retries=0', '-c', 'model_providers.ccheck_probe.stream_max_retries=0',
    'Run the scripted probe.']
  const child = spawn(codex, [...prefix, ...args], {
    cwd: repo, env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 45_000,
  })
  const output = []
  child.stdout.on('data', data => output.push(data))
  child.stderr.on('data', data => output.push(data))
  const exit = await new Promise((done, reject) => child.once('error', reject).once('close', done))
  assert.equal(exit, 0, Buffer.concat(output).toString('utf8'))
  assert.equal(calls, sequence.length)
  if (mode === 'untrusted') {
    assert.equal(existsSync(log), false)
    const reported = /hook.{0,80}(?:trust|review)|(?:trust|review).{0,80}hook/i.test(Buffer.concat(output).toString('utf8'))
    console.log(JSON.stringify({ event: 'untrusted', ran: false, reported }))
  } else {
    assert.ok(existsSync(log), Buffer.concat(output).toString('utf8'))
    const captured = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(existsSync(join(repo, 'denied.txt')), false)
    if (mode === 'full') {
      assert.ok(existsSync(join(repo, 'allowed.txt')), Buffer.concat(output).toString('utf8'))
      assert.equal(readFileSync(join(repo, 'allowed.txt'), 'utf8').trim(), 'allowed')
      assert.equal(readFileSync(join(repo, 'second.txt'), 'utf8').trim(), 'second')
      assert.ok(modelInputs.some(input => input.includes('Probe observed the completed edit')))
      assert.equal(captured.find(event => event.event === 'PostToolUse' && event.toolId === 'call_allow')?.tool, 'apply_patch')
    }
    assert.equal(existsSync(join(repo, 'missing.txt')), false)
    assert.ok(modelInputs.some(input => input.includes('Probe denied the sentinel')))
    assert.ok(modelInputs.some(input => input.includes('Probe requests one continuation')))
    assert.ok(modelInputs.some(input => input.includes('apply_patch verification failed') && input.includes('missing.txt')))
    assert.equal(captured[0]?.event, 'SessionStart')
    assert.equal(captured[0]?.source, 'startup')
    assert.equal(captured.find(event => event.toolId === 'call_fail')?.event, 'PreToolUse')
    assert.deepEqual(captured.filter(event => event.event === 'Stop').map(event => event.stopActive), [false, true])
    assert.equal(captured.filter(event => event.event === 'UserPromptSubmit').length, 1)
    assert.equal(new Set(captured.map(event => event.session)).size, 1)
    assert.equal(new Set(captured.filter(event => event.turn !== undefined).map(event => event.turn)).size, 1)
    assert.ok(captured.every(event => event.cwdMatches))
    for (const event of captured) {
      if (event.session) event.session = 'session'
      if (event.turn) event.turn = 'turn'
      console.log(JSON.stringify(event))
    }
  }
} finally {
  server.closeAllConnections()
  server.close()
  if (dirname(scratch) === temp) rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
}
