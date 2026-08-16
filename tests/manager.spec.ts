/**
 * Unit and integration coverage for the process manager: pure helpers,
 * registry lifecycle, output capture, stdin writes, termination, and
 * notification wiring over the local subprocess runtime.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import {
  ProcessManager,
  assertValidMatchers,
  compilePattern,
  filterOutput,
  lineMatches,
  normalizeMatcher,
  normalizeNotify,
  sortProcesses,
  splitLines,
} from '../src/manager.ts'
import type { ProcessInfo, ResolvedProcessConfig } from '../src/types.ts'

const CONFIG: ResolvedProcessConfig = {
  shellArgs: ['-c'],
  maxOutputBytes: 64 * 1024,
  maxSpillBytes: 64 * 1024 * 1024,
  graceMs: 200,
  killTimeoutMs: 5_000,
  pollIntervalMs: 50,
  maxProcesses: 10,
}

/** A stub agent whose session records the durable events the manager appends. */
function stubAgent(cwd = '/tmp'): Agent {
  const session = {
    header: { cwd },
    events: [] as Array<{ type: string; data: unknown }>,
    append(type: string, data: unknown): void {
      this.events.push({ type, data })
    },
  }
  return { session } as unknown as Agent
}

async function makeManager(config: ResolvedProcessConfig = CONFIG) {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  const manager = new ProcessManager(ctx, config)
  return { ctx, manager }
}

/** Wait until the process reaches a settled status. */
async function pollStatus(manager: ProcessManager, id: string, timeoutMs = 5_000): Promise<ProcessInfo> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const info = manager.infoOf(id)
    if (info.status !== 'running' && info.status !== 'terminating') return info
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('process did not settle within ' + timeoutMs + 'ms')
}

// The local runtime owns real child processes; each test disposes its manager,
// and any stragglers die with the forked vitest worker.

describe('pure helpers', () => {
  it('splitLines handles empty, trailing-newline, and CRLF text', () => {
    expect(splitLines('')).toEqual([])
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\r\nb')).toEqual(['a', 'b'])
    expect(splitLines('a\n\nb')).toEqual(['a', '', 'b'])
  })

  it('normalizeMatcher applies defaults', () => {
    expect(normalizeMatcher({ pattern: 'x' })).toEqual({
      pattern: 'x', mode: 'literal', stream: 'both', repeat: false, on: 'turn',
    })
    expect(normalizeMatcher({ pattern: 'x', mode: 'regex', stream: 'stdout', repeat: true, on: 'ignore' })).toEqual({
      pattern: 'x', mode: 'regex', stream: 'stdout', repeat: true, on: 'ignore',
    })
  })

  it('normalizeNotify supplies default exit settings and empty matchers', () => {
    expect(normalizeNotify(undefined)).toEqual({
      settings: { onSuccess: 'turn', onFailure: 'turn', onKilled: 'context' },
      matchers: [],
    })
    expect(normalizeNotify({ logMatches: [{ pattern: 'ready' }], onSuccess: 'context' })).toEqual({
      settings: { onSuccess: 'context', onFailure: 'turn', onKilled: 'context' },
      matchers: [{ pattern: 'ready', mode: 'literal', stream: 'both', repeat: false, on: 'turn' }],
    })
  })

  it('lineMatches honors literal and regex modes', () => {
    const literal = normalizeMatcher({ pattern: 'ready' })
    expect(lineMatches('server ready now', literal)).toBe(true)
    expect(lineMatches('not yet', literal)).toBe(false)
    const regex = normalizeMatcher({ pattern: '^\\d+ms$', mode: 'regex' })
    expect(lineMatches('120ms', regex)).toBe(true)
    expect(lineMatches('slow', regex)).toBe(false)
  })

  it('compilePattern rejects invalid regexes', () => {
    expect(compilePattern('fine')).toBeInstanceOf(RegExp)
    expect(() => compilePattern('(')).toThrow(/invalid regex pattern/)
  })

  it('assertValidMatchers enforces the limits', () => {
    expect(() => assertValidMatchers([])).not.toThrow()
    expect(() => assertValidMatchers([{ pattern: '' }])).toThrow(/non-empty/)
    expect(() => assertValidMatchers([{ pattern: 'x'.repeat(501) }])).toThrow(/exceeds 500/)
    const many = Array.from({ length: 21 }, () => ({ pattern: 'x' }))
    expect(() => assertValidMatchers(many)).toThrow(/at most 20/)
  })

  it('filterOutput filters, tails, and flags truncation', () => {
    expect(filterOutput('a\nb\nc\n', undefined, 'literal', 10)).toEqual({ text: 'a\nb\nc', truncated: false })
    expect(filterOutput('a\nb\nc\n', 'b', 'literal', 10)).toEqual({ text: 'b', truncated: false })
    expect(filterOutput('1\n2\n3\n', undefined, 'literal', 2)).toEqual({ text: '2\n3', truncated: true })
  })

  it('sortProcesses orders by start desc by default and by name asc on request', () => {
    const base = (id: string, name: string, startedAt: number): ProcessInfo => ({
      id, name, command: '', cwd: '', pid: 1, status: 'running', startedAt,
      exitCode: null, exitSignal: null, stoppedAt: null,
    })
    const a = base('a', 'zeta', 100)
    const b = base('b', 'alpha', 200)
    expect(sortProcesses([a, b], 'startTime_desc').map(p => p.id)).toEqual(['b', 'a'])
    expect(sortProcesses([a, b], 'name_asc').map(p => p.id)).toEqual(['b', 'a'])
    expect(sortProcesses([a, b], 'name_desc').map(p => p.id)).toEqual(['a', 'b'])
  })
})

describe('ProcessManager lifecycle', () => {
  it('starts a process, records the durable event, and reports running', async () => {
    const { manager } = await makeManager()
    const agent = stubAgent('/tmp')
    const info = await manager.start({ name: 'server', command: 'sleep 30', owner: agent })
    expect(info.id).toMatch(/^proc_[0-9a-f]{4}$/u)
    expect(info.status).toBe('running')
    expect(info.pid).toBeGreaterThan(0)
    expect(info.cwd).toBe('/tmp')
    const session = (agent as unknown as { session: { events: Array<{ type: string; data: unknown }> } }).session
    const started = session.events.find(event => event.type === 'process/start')
    expect(started?.data).toMatchObject({ name: 'server', command: 'sleep 30' })
    await manager.dispose()
  })

  it('captures stdout and reports it through output', async () => {
    const { manager } = await makeManager()
    const agent = stubAgent()
    const info = await manager.start({ name: 'echo', command: 'printf \'one\\ntwo\\nthree\\n\'', owner: agent })
    await pollStatus(manager, info.id)
    const result = manager.output(info.id, 'both', 10, undefined, 'literal')
    expect(result.stdout?.text).toBe('one\ntwo\nthree')
    expect(result.stderr?.text).toBe('')
    expect(manager.infoOf(info.id).status).toBe('finished')
    await manager.dispose()
  })

  it('supports pattern-filtered and tailed output', async () => {
    const { manager } = await makeManager()
    const agent = stubAgent()
    const info = await manager.start({ name: 'filter', command: 'seq 1 10', owner: agent })
    await pollStatus(manager, info.id)
    expect(manager.output(info.id, 'both', 3, undefined, 'literal').stdout?.text).toBe('8\n9\n10')
    expect(manager.output(info.id, 'both', 10, '5', 'literal').stdout?.text).toBe('5')
    await manager.dispose()
  })

  it('writes to stdin and closes it on end', async () => {
    const { manager } = await makeManager()
    const agent = stubAgent()
    const info = await manager.start({ name: 'cat', command: 'cat', owner: agent })
    const write = manager.write(info.id, 'hello\n', true)
    expect(write).toEqual({ inputLength: 6, end: true })
    const settled = await pollStatus(manager, info.id)
    expect(settled.status).toBe('finished')
    expect(manager.output(info.id, 'both', 10, undefined, 'literal').stdout?.text).toBe('hello')
    await manager.dispose()
  })

  it('stop terminates a live process and reports the settled status', async () => {
    const { manager } = await makeManager()
    const agent = stubAgent()
    const info = await manager.start({ name: 'long', command: 'sleep 60', owner: agent })
    const result = await manager.stop(info.id, 5_000)
    expect(result.timedOut).toBe(false)
    expect(['finished', 'killed']).toContain(result.process.status)
    expect(manager.infoOf(info.id).status).toBe(result.process.status)
    await manager.dispose()
  })

  it('stop on an already-settled process returns its facts without terminating', async () => {
    const { manager } = await makeManager()
    const agent = stubAgent()
    const info = await manager.start({ name: 'done', command: 'true', owner: agent })
    await pollStatus(manager, info.id)
    const result = await manager.stop(info.id, 1_000)
    expect(result.timedOut).toBe(false)
    expect(result.process.status).toBe('finished')
    await manager.dispose()
  })

  it('list filters by status and sort order and caps the result', async () => {
    const { manager } = await makeManager()
    const agent = stubAgent()
    const running = await manager.start({ name: 'runner', command: 'sleep 30', owner: agent })
    const done = await manager.start({ name: 'aaa', command: 'true', owner: agent })
    await pollStatus(manager, done.id)
    const runningOnly = manager.list({ statuses: ['running'] })
    expect(runningOnly.map(p => p.id)).toEqual([running.id])
    const finishedOnly = manager.list({ statuses: ['finished'] })
    expect(finishedOnly.map(p => p.id)).toEqual([done.id])
    expect(manager.list({ sortBy: 'name_asc' }).map(p => p.id)).toEqual([done.id, running.id])
    expect(manager.list({ limit: 1 })).toHaveLength(1)
    await manager.dispose()
  })

  it('clear removes finished processes and keeps live ones', async () => {
    const { manager } = await makeManager()
    const agent = stubAgent()
    const live = await manager.start({ name: 'live', command: 'sleep 30', owner: agent })
    const done = await manager.start({ name: 'done', command: 'true', owner: agent })
    await pollStatus(manager, done.id)
    expect(manager.clear()).toBe(1)
    expect(manager.list({})).toHaveLength(1)
    expect(manager.list({})[0]?.id).toBe(live.id)
    await manager.dispose()
  })

  it('update appends, replaces, removes, and clears matchers', async () => {
    const { manager } = await makeManager()
    const agent = stubAgent()
    const info = await manager.start({ name: 'watch', command: 'sleep 30', owner: agent })
    let matchers = manager.update(info.id, { mode: 'append', items: [normalizeMatcher({ pattern: 'ready' })] })
    expect(matchers).toHaveLength(1)
    matchers = manager.update(info.id, { mode: 'append', items: [normalizeMatcher({ pattern: 'error' })] })
    expect(matchers.map(m => m.pattern)).toEqual(['ready', 'error'])
    matchers = manager.update(info.id, { mode: 'remove', items: [{ pattern: '0' }] })
    expect(matchers.map(m => m.pattern)).toEqual(['error'])
    matchers = manager.update(info.id, { mode: 'replace', items: [normalizeMatcher({ pattern: 'x' })] })
    expect(matchers.map(m => m.pattern)).toEqual(['x'])
    matchers = manager.update(info.id, { mode: 'clear' })
    expect(matchers).toEqual([])
    await manager.dispose()
  })

  it('clear records a process/clear event per removed process on its owner session', async () => {
    const { manager } = await makeManager()
    const agent = stubAgent()
    const done = await manager.start({ name: 'done', command: 'true', owner: agent })
    await pollStatus(manager, done.id)
    expect(manager.clear()).toBe(1)
    const session = (agent as unknown as { session: { events: Array<{ type: string; data: unknown }> } }).session
    const cleared = session.events.filter(event => event.type === 'process/clear')
    expect(cleared).toHaveLength(1)
    expect(cleared[0]?.data).toMatchObject({ id: done.id, name: 'done' })
    await manager.dispose()
  })

  it('readDelta returns only the output produced since the previous read', async () => {
    const { manager } = await makeManager()
    const agent = stubAgent()
    const info = await manager.start({ name: 'delta', command: 'printf first; sleep 0.1; printf second', owner: agent })
    await pollStatus(manager, info.id)
    const first = manager.readDelta(info.id)
    const second = manager.readDelta(info.id)
    expect(first.stdout).toBe('firstsecond')
    expect(second.stdout).toBe('')
    await manager.dispose()
  })

  it('enforces maxProcesses with a loud error', async () => {
    const { manager } = await makeManager({ ...CONFIG, maxProcesses: 1 })
    const agent = stubAgent()
    await manager.start({ name: 'one', command: 'sleep 30', owner: agent })
    await expect(manager.start({ name: 'two', command: 'sleep 30', owner: agent })).rejects.toThrow(/at most 1 managed processes/)
    await manager.dispose()
  })

  it('unknown ids fail loud across accessors', async () => {
    const { manager } = await makeManager()
    expect(() => manager.output('proc_ffff', 'both', 10, undefined, 'literal')).toThrow(/unknown process/)
    expect(() => manager.write('proc_ffff', 'x', false)).toThrow(/unknown process/)
    await expect(manager.stop('proc_ffff', 100)).rejects.toThrow(/unknown process/)
    expect(() => manager.update('proc_ffff', { mode: 'clear' })).toThrow(/unknown process/)
    expect(() => manager.nameOf('proc_ffff')).toThrow(/unknown process/)
    await manager.dispose()
  })

  it('dispose terminates every live tree', async () => {
    const { manager } = await makeManager()
    const agent = stubAgent()
    const info = await manager.start({ name: 'live', command: 'sleep 60', owner: agent })
    manager.dispose()
    expect(() => manager.infoOf(info.id)).toThrow(/unknown process/)
  })
})