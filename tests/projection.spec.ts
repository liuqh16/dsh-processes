/**
 * Unit coverage for the processes session projection: the pure fold over
 * process/* events and the schema the wire payload is validated against.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  EMPTY_PROCESSES_PROJECTION,
  applyProcessesProjection,
  processesProjectionSchema,
  processesProjectionUnit,
} from '../src/projection.ts'
import type { ProcessesProjection } from '../src/types.ts'

/** Build one process/start event. */
function startEvent(id: string, name = 'proc', command = 'echo hi'): SessionEvent {
  return {
    type: 'process/start',
    seq: 1,
    time: Date.now(),
    data: { id, name, command, cwd: '/tmp', pid: 100, startedAt: Date.now() },
  } as unknown as SessionEvent
}

/** Build one process/exit event. */
function exitEvent(
  id: string,
  status: 'finished' | 'failed' | 'killed',
  exitCode: number | null = 0,
  exitSignal: string | null = null,
): SessionEvent {
  return {
    type: 'process/exit',
    seq: 2,
    time: Date.now(),
    data: { id, name: 'proc', status, exitCode, exitSignal, stoppedAt: Date.now() },
  } as unknown as SessionEvent
}

/** Build one process/notify event. */
function notifyEvent(id: string, text: string): SessionEvent {
  return {
    type: 'process/notify',
    seq: 3,
    time: Date.now(),
    data: { id, name: 'proc', reason: 'exit', text, attention: 'turn' },
  } as unknown as SessionEvent
}

describe('applyProcessesProjection', () => {
  it('starts empty and appends running processes in start order', () => {
    const state = applyProcessesProjection(
      EMPTY_PROCESSES_PROJECTION,
      startEvent('proc_ab12', 'server', 'npm run dev'),
    )
    expect(state.processes).toHaveLength(1)
    expect(state.processes[0]).toMatchObject({
      id: 'proc_ab12',
      name: 'server',
      command: 'npm run dev',
      status: 'running',
      exitCode: null,
      stoppedAt: null,
      lastNotify: null,
    })
    expect(state.running).toBe(1)

    const second = applyProcessesProjection(state, startEvent('proc_cd34', 'tests', 'pnpm test'))
    expect(second.processes.map(entry => entry.id)).toEqual(['proc_ab12', 'proc_cd34'])
    expect(second.running).toBe(2)
  })

  it('exit settles the entry and decrements the running count', () => {
    const started = applyProcessesProjection(EMPTY_PROCESSES_PROJECTION, startEvent('proc_ab12'))
    const exited = applyProcessesProjection(started, exitEvent('proc_ab12', 'finished', 0))
    expect(exited.processes[0]).toMatchObject({
      status: 'finished',
      exitCode: 0,
      exitSignal: null,
      stoppedAt: expect.any(Number),
    })
    expect(exited.running).toBe(0)
  })

  it('notify records the last delivered text', () => {
    const started = applyProcessesProjection(EMPTY_PROCESSES_PROJECTION, startEvent('proc_ab12'))
    const notified = applyProcessesProjection(started, notifyEvent('proc_ab12', 'exited with code 0'))
    expect(notified.processes[0]?.lastNotify).toBe('exited with code 0')
    expect(notified.running).toBe(1)
  })

  it('returns the same reference for unrelated events', () => {
    const state = applyProcessesProjection(EMPTY_PROCESSES_PROJECTION, startEvent('proc_ab12'))
    const unrelated = {
      type: 'user/message',
      seq: 9,
      time: Date.now(),
      data: { message: { role: 'user', content: [] } },
    } as unknown as SessionEvent
    expect(applyProcessesProjection(state, unrelated)).toBe(state)
  })

  it('ignores exit/notify events for unknown ids', () => {
    const state = applyProcessesProjection(EMPTY_PROCESSES_PROJECTION, startEvent('proc_ab12'))
    expect(applyProcessesProjection(state, exitEvent('proc_ffff', 'finished'))).toBe(state)
    expect(applyProcessesProjection(state, notifyEvent('proc_ffff', 'x'))).toBe(state)
  })

  it('clear removes the settled entry and recomputes the running count', () => {
    const started = applyProcessesProjection(EMPTY_PROCESSES_PROJECTION, startEvent('proc_ab12'))
    const exited = applyProcessesProjection(started, exitEvent('proc_ab12', 'finished'))
    const cleared = applyProcessesProjection(exited, {
      type: 'process/clear',
      seq: 4,
      time: Date.now(),
      data: { id: 'proc_ab12', name: 'proc', clearedAt: Date.now() },
    } as unknown as SessionEvent)
    expect(cleared.processes).toHaveLength(0)
    expect(cleared.running).toBe(0)
  })

  it('clear for an unknown id leaves the projection unchanged', () => {
    const state = applyProcessesProjection(EMPTY_PROCESSES_PROJECTION, startEvent('proc_ab12'))
    const cleared = applyProcessesProjection(state, {
      type: 'process/clear',
      seq: 4,
      time: Date.now(),
      data: { id: 'proc_ffff', name: 'x', clearedAt: Date.now() },
    } as unknown as SessionEvent)
    expect(cleared).toBe(state)
  })

  it('killed exits carry the signal', () => {
    const started = applyProcessesProjection(EMPTY_PROCESSES_PROJECTION, startEvent('proc_ab12'))
    const killed = applyProcessesProjection(started, exitEvent('proc_ab12', 'killed', null, 'SIGTERM'))
    expect(killed.processes[0]).toMatchObject({ status: 'killed', exitCode: null, exitSignal: 'SIGTERM' })
    expect(killed.running).toBe(0)
  })
})

describe('processes projection wire', () => {
  it('the unit declares the expected key and version', () => {
    expect(processesProjectionUnit.key).toBe('processes')
    expect(processesProjectionUnit.stateVersion).toBe(1)
    expect(processesProjectionUnit.init()).toEqual(EMPTY_PROCESSES_PROJECTION)
  })

  it('the schema validates a wire payload', () => {
    const value: ProcessesProjection = {
      processes: [{
        id: 'proc_ab12',
        name: 'server',
        command: 'npm run dev',
        status: 'running',
        exitCode: null,
        exitSignal: null,
        startedAt: Date.now(),
        stoppedAt: null,
        lastNotify: null,
      }],
      running: 1,
    }
    expect(processesProjectionSchema.safeParse(value).success).toBe(true)
    expect(processesProjectionSchema.safeParse({ processes: [] }).success).toBe(false)
    expect(processesProjectionSchema.safeParse({ processes: [{}], running: 1 }).success).toBe(false)
  })
})