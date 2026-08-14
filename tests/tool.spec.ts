/**
 * Tool-level coverage: the process tool definition registers under the right
 * name, validates value constraints the schema cannot express, executes every
 * action against a real manager, and renders model- and UI-facing text.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ProcessManager } from '../src/manager.ts'
import { registerProcessTool } from '../src/tool.ts'
import type { ResolvedProcessConfig } from '../src/types.ts'

const CONFIG: ResolvedProcessConfig = {
  shellArgs: ['-c'],
  maxOutputBytes: 64 * 1024,
  maxSpillBytes: 64 * 1024 * 1024,
  graceMs: 200,
  killTimeoutMs: 5_000,
  pollIntervalMs: 50,
  maxProcesses: 10,
}

function stubAgent(): Agent {
  const session = {
    header: { cwd: '/tmp' },
    events: [] as Array<{ type: string; data: unknown }>,
    append(type: string, data: unknown): void {
      this.events.push({ type, data })
    },
  }
  return { session } as unknown as Agent
}

function fakeExec(): ToolRunContext {
  return { agent: stubAgent(), callId: 'call-1', signal: new AbortController().signal } as unknown as ToolRunContext
}

/** Test-local view of the registered tool; the schema types stay in the plugin. */
interface CapturedTool {
  name: string
  description: string
  // Values come from the canonical output schema, whose exact union lives in
  // the plugin; the test asserts against the rendered/returned shape loosely.
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<any>
  output: {
    render: (args: unknown, value: any) => Array<{ type: string; text: string }>
  }
  presentCall?: (args: Record<string, unknown>) => { card: string; title: string; kind: string } | undefined
  presentResult?: (args: unknown, result: { content: unknown[]; isError: boolean; meta?: unknown }) => unknown
}

async function mount() {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  const manager = new ProcessManager(ctx, CONFIG)
  let definition: CapturedTool | undefined
  registerProcessTool(
    { tools: { register: (def: CapturedTool) => { definition = def } } } as unknown as Context,
    manager,
  )
  if (definition === undefined) throw new Error('tool was not registered')
  return { manager, tool: definition, ctx }
}

/** Wait until a process reaches a settled status. */
async function pollStatus(manager: ProcessManager, id: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const info = manager.infoOf(id)
    if (info.status !== 'running' && info.status !== 'terminating') return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('process did not settle within ' + timeoutMs + 'ms')
}

// Each test disposes its manager; stragglers die with the forked vitest worker.

describe('process tool', () => {
  it('registers a tool named process with model-facing description', async () => {
    const { tool } = await mount()
    expect(tool.name).toBe('process')
    expect(tool.description).toContain('start')
    expect(tool.description).toContain('stop')
  })

  it('start runs the command and returns process facts', async () => {
    const { manager, tool } = await mount()
    const value = await tool.execute({ action: 'start', name: 'srv', command: 'sleep 30' }, fakeExec())
    expect(value.kind).toBe('start')
    if (value.kind !== 'start') return
    expect(value.process.status).toBe('running')
    expect(value.process.pid).toBeGreaterThan(0)
    await manager.dispose()
  })

  it('rejects start without a name or command', async () => {
    const { tool } = await mount()
    await expect(tool.execute({ action: 'start', command: 'echo hi' }, fakeExec())).rejects.toThrow(/name is required/)
    await expect(tool.execute({ action: 'start', name: 'x' }, fakeExec())).rejects.toThrow(/command is required/)
  })

  it('lists processes with filters and renders rows', async () => {
    const { manager, tool } = await mount()
    const started = await tool.execute({ action: 'start', name: 'done', command: 'true' }, fakeExec())
    if (started.kind !== 'start') throw new Error('unexpected')
    await pollStatus(manager, started.process.id)
    const list = await tool.execute({ action: 'list', statuses: ['finished'] }, fakeExec())
    expect(list.kind).toBe('list')
    if (list.kind !== 'list') return
    expect(list.total).toBe(1)
    expect(list.processes[0]?.id).toBe(started.process.id)
    const blocks = tool.output.render({ action: 'list' }, list)
    expect(blocks[0]?.type).toBe('text')
    if (blocks[0]?.type !== 'text') return
    expect(blocks[0].text).toContain('1 process')
    expect(blocks[0].text).toContain(started.process.id)
    await manager.dispose()
  })

  it('output reads captured stdout after settle', async () => {
    const { manager, tool } = await mount()
    const started = await tool.execute({ action: 'start', name: 'echo', command: 'printf \'hello output\\n\'' }, fakeExec())
    if (started.kind !== 'start') throw new Error('unexpected')
    await pollStatus(manager, started.process.id)
    const out = await tool.execute({ action: 'output', id: started.process.id }, fakeExec())
    expect(out.kind).toBe('output')
    if (out.kind !== 'output') return
    expect(out.stdout?.text).toBe('hello output')
    await manager.dispose()
  })

  it('rejects an invalid regex output filter before spawning reads', async () => {
    const { manager, tool } = await mount()
    const started = await tool.execute({ action: 'start', name: 'e', command: 'sleep 30' }, fakeExec())
    if (started.kind !== 'start') throw new Error('unexpected')
    await expect(tool.execute({ action: 'output', id: started.process.id, pattern: '(', mode: 'regex' }, fakeExec())).rejects.toThrow(/invalid regex/)
    await manager.dispose()
  })

  it('rejects out-of-range tailLines', async () => {
    const { manager, tool } = await mount()
    const started = await tool.execute({ action: 'start', name: 'e', command: 'sleep 30' }, fakeExec())
    if (started.kind !== 'start') throw new Error('unexpected')
    await expect(tool.execute({ action: 'output', id: started.process.id, tailLines: 0 }, fakeExec())).rejects.toThrow(/tailLines/)
    await expect(tool.execute({ action: 'output', id: started.process.id, tailLines: 2001 }, fakeExec())).rejects.toThrow(/tailLines/)
    await manager.dispose()
  })

  it('write sends stdin and acknowledges', async () => {
    const { manager, tool } = await mount()
    const started = await tool.execute({ action: 'start', name: 'cat', command: 'cat' }, fakeExec())
    if (started.kind !== 'start') throw new Error('unexpected')
    const write = await tool.execute({ action: 'write', id: started.process.id, input: 'ping\n', end: true }, fakeExec())
    expect(write.kind).toBe('write')
    if (write.kind !== 'write') return
    expect(write.inputLength).toBe(5)
    expect(write.end).toBe(true)
    await pollStatus(manager, started.process.id)
    await manager.dispose()
  })

  it('stop terminates and reports the settled status', async () => {
    const { manager, tool } = await mount()
    const started = await tool.execute({ action: 'start', name: 'long', command: 'sleep 60' }, fakeExec())
    if (started.kind !== 'start') throw new Error('unexpected')
    const stopped = await tool.execute({ action: 'stop', id: started.process.id }, fakeExec())
    expect(stopped.kind).toBe('stop')
    if (stopped.kind !== 'stop') return
    expect(stopped.timedOut).toBe(false)
    expect(['finished', 'killed']).toContain(stopped.process.status)
    await manager.dispose()
  })

  it('update appends matchers and renders their canonical form', async () => {
    const { manager, tool } = await mount()
    const started = await tool.execute({ action: 'start', name: 'w', command: 'sleep 30' }, fakeExec())
    if (started.kind !== 'start') throw new Error('unexpected')
    const updated = await tool.execute({
      action: 'update',
      id: started.process.id,
      watches: { mode: 'append', items: [{ pattern: 'ready' }] },
    }, fakeExec())
    expect(updated.kind).toBe('update')
    if (updated.kind !== 'update') return
    expect(updated.matchers[0]).toMatchObject({ pattern: 'ready', mode: 'literal', stream: 'both', repeat: false, on: 'turn' })
    await manager.dispose()
  })

  it('clear removes finished processes', async () => {
    const { manager, tool } = await mount()
    const started = await tool.execute({ action: 'start', name: 'done', command: 'true' }, fakeExec())
    if (started.kind !== 'start') throw new Error('unexpected')
    await pollStatus(manager, started.process.id)
    const cleared = await tool.execute({ action: 'clear' }, fakeExec())
    expect(cleared.kind).toBe('clear')
    if (cleared.kind !== 'clear') return
    expect(cleared.removed).toBe(1)
    expect(manager.list({})).toHaveLength(0)
    await manager.dispose()
  })

  it('fails loud on unknown ids', async () => {
    const { tool } = await mount()
    await expect(tool.execute({ action: 'stop', id: 'proc_ffff' }, fakeExec())).rejects.toThrow(/unknown process/)
  })

  it('presentCall offers a generic card carrying the command as title', async () => {
    const { tool } = await mount()
    const view = tool.presentCall?.({ action: 'start', name: 'srv', command: 'npm run dev' })
    expect(view).toMatchObject({ card: 'generic', title: 'npm run dev', kind: 'execute' })
    const listView = tool.presentCall?.({ action: 'list' })
    expect(listView).toMatchObject({ card: 'generic', title: 'process list', kind: 'search' })
  })

  it('presentResult maps the output meta to a terminal card', async () => {
    const { tool } = await mount()
    const view = tool.presentResult?.(
      { action: 'output', id: 'proc_ab12' },
      { content: [], isError: false, meta: { kind: 'output', text: 'hello\nworld' } },
    )
    expect(view).toEqual({ card: 'terminal', output: 'hello\nworld' })
  })
})