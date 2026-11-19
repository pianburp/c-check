/// <reference types="node" />
import { spawn } from 'node:child_process'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { TimeoutError, type Ports } from '../engine/types.ts'

const windows = process.platform === 'win32'
const MAX_OUTPUT = 32 * 1024 * 1024

export const nodePorts: Ports = {
  run([file, ...args], { cwd, timeoutMs = 30_000, env }) {
    return new Promise((resolve, reject) => {
      if (!file) throw new Error('Missing executable')
      const script = windows && file === 'cmd.exe' && args.length === 3 && args[0] === '/d' && args[1] === '/c' ? args[2] : undefined
      const child = spawn(file, script === undefined ? args : ['/d', '/v:off', '/s', '/c', '""%C_CHECK_TEST_SCRIPT%""'], {
        cwd, env: { ...process.env, ...env, ...(script === undefined ? {} : { C_CHECK_TEST_SCRIPT: script }) },
        windowsVerbatimArguments: script !== undefined, windowsHide: true, detached: !windows,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let bytes = 0
      let failure: Error | undefined
      const stop = (error: Error) => {
        if (failure !== undefined) return
        failure = error
        const pid = child.pid
        if (pid === undefined) return
        if (windows) {
          const kill = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
          kill.on('error', () => child.kill())
          kill.on('exit', code => { if (code !== 0) child.kill() })
        } else {
          try { process.kill(-pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
        }
        // A detached descendant may otherwise hold the parent's pipe open.
        child.stdout.destroy()
        child.stderr.destroy()
      }
      const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes <= MAX_OUTPUT) chunks.push(chunk)
        else stop(new Error('Subprocess output exceeded limit'))
      }
      child.stdout.on('data', collect(stdout))
      child.stderr.on('data', collect(stderr))
      const timer = setTimeout(() => stop(new TimeoutError(timeoutMs)), Math.min(timeoutMs, 2_147_483_647))
      child.on('error', reject)
      child.on('close', exitCode => {
        clearTimeout(timer)
        if (failure !== undefined) reject(failure)
        else if (exitCode === null) reject(new Error('Subprocess terminated by a signal'))
        else resolve({ exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
      })
    })
  },
  async read(path) {
    try { return await readFile(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  },
  async write(path, text) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text, 'utf8')
  },
  async realPath(path) {
    try { return await realpath(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  },
  now: async () => Date.now(),
}
