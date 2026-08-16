/**
 * REAL-composition coverage: the plugin mounted on the agent loop with the
 * local subprocess runtime. A scripted mock model drives the process tool
 * through the same paths a live model would (tool/call + tool/result session
 * events, durable process/start and process/exit events, and exit/log-match
 * notifications that wake the idle agent via followup).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as Processes from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

/** Mount the loop, the command/subprocess services, and the processes plugin. */
async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Processes)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function events(agent: Agent): SessionEvent[] {
  return [...agent.session.events]
}

/** Turns that have ended in the agent's session log. */
function endedTurns(agent: Agent): number {
  return agent.session.events.filter(event => event.type === 'turn/end').length
}

/** Poll until a predicate holds; fails after the timeout. */
async function pollUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('condition not met within ' + timeoutMs + 'ms')
}

/**
 * Wait until the agent is idle after at least `expectedEnds` turns completed.
 * Polls the agent's public status instead of the scoped agent/status event,
 * whose carrier is not observable from the root context.
 */
async function waitForIdle(agent: Agent, expectedEnds: number): Promise<void> {
  await pollUntil(() => agent.status === 'idle' && endedTurns(agent) >= expectedEnds)
}

/** Find a session event by type, narrowed; throws when absent. */
function findEvent<T extends SessionEvent['type']>(
  log: SessionEvent[],
  type: T,
  position: 'first' | 'last' = 'first',
): Extract<SessionEvent, { type: T }> {
  const found = position === 'first'
    ? log.find(event => event.type === type)
    : log.findLast(event => event.type === type)
  if (!found) throw new Error('no ' + type + ' event in the session log')
  return found as Extract<SessionEvent, { type: T }>
}

function resultText(event: SessionEvent): string {
  if (event.type !== 'tool/result') return ''
  return event.data.message.content[0].content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

describe('processes plugin through the agent loop', () => {
  it('model starts a background process, the result returns, the process keeps running', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'process', {
        action: 'start',
        name: 'dev-server',
        command: 'sleep 60',
      }, 'Starting it.'),
      textResponse('Started the dev server.'),
      toolCallResponse('call-2', 'process', {
        action: 'list',
      }),
      textResponse('One process is running.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('proc-fg'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start the dev server' }], source: { kind: 'user' } }))
    await waitForIdle(agent, 1)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'list the processes' }], source: { kind: 'user' } }))
    await waitForIdle(agent, 2)

    const log = events(agent)
    const toolCall = findEvent(log, 'tool/call', 'first')
    expect(toolCall.data.name).toBe('process')
    expect(JSON.parse(toolCall.data.arguments as string)).toMatchObject({ action: 'start', name: 'dev-server' })

    const toolResult = findEvent(log, 'tool/result', 'first')
    expect(toolResult.data.message.content[0].isError).toBe(false)
    expect(resultText(toolResult)).toContain('Started process "dev-server"')

    const firstResult = findEvent(log, 'tool/result', 'first')
    const meta = firstResult.data.meta as { kind?: string; process?: { name?: string; command?: string } } | undefined
    expect(meta?.kind).toBe('start')
    expect(meta?.process).toMatchObject({ name: 'dev-server', command: 'sleep 60' })

    const listResult = findEvent(log, 'tool/result', 'last')
    expect(resultText(listResult)).toContain('dev-server')
    expect(resultText(listResult)).toContain('running')
  })

  it('exit notification wakes the idle agent and reaches the model request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-proc-exit-'))
    dirs.push(dir)
    const sentinel = join(dir, 'release')
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'process', {
        action: 'start',
        name: 'watcher',
        command: 'while [ ! -f ' + JSON.stringify(sentinel) + ' ]; do sleep 0.02; done; echo done-exit',
        notify: { onSuccess: 'turn' },
      }, 'Starting it.'),
      textResponse('Started the watcher.'),
      textResponse('The watcher exited.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('proc-exit'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start the watcher' }], source: { kind: 'user' } }))
    await waitForIdle(agent, 1)
    writeFileSync(sentinel, 'go')

    // The exit notification wakes the idle agent: a second turn runs and the
    // notification text lands as a standard user/message.
    await waitForIdle(agent, 2)

    const log = events(agent)
    const notifyMessages = log
      .filter(event => event.type === 'user/message')
      .flatMap(event => [event.data as { content: Array<{ type: string; text?: string }> }])
      .flatMap(message => message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    expect(notifyMessages).toContain('exited with code 0')

    // The followup-delivered message also reached the model request.
    const lastRequest = adapter.requests.at(-1)
    const requestText = (lastRequest?.messages ?? [])
      .flatMap(message => message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    expect(requestText).toContain('exited with code 0')
  })

  it('log-match notification fires once for a repeat: false matcher', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'process', {
        action: 'start',
        name: 'reporter',
        command: 'sleep 0.4; echo ready-now; sleep 60',
        notify: { logMatches: [{ pattern: 'ready-now' }] },
      }, 'Starting it.'),
      textResponse('Started the reporter.'),
      textResponse('Reporter became ready.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('proc-match'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start the reporter' }], source: { kind: 'user' } }))
    await waitForIdle(agent, 1)

    // The log-match notification wakes the agent for a second turn; the text
    // lands as a standard user/message.
    await waitForIdle(agent, 2)

    const log = events(agent)
    const notifyText = log
      .filter(event => event.type === 'user/message')
      .flatMap(event => [event.data as { content: Array<{ type: string; text?: string }> }])
      .flatMap(message => message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    expect(notifyText).toContain('ready-now')
    // One-shot matcher: no second notification while the process stays live.
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(endedTurns(agent)).toBe(2)
  })
})