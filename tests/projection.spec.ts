/**
 * Unit coverage for the processes session projection: the fold over the
 * process tool's tool/result meta (start/stop/clear) — no custom session
 * events, so logs stay readable by any harness.
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

/** One process row as the tool's result meta carries it. */
function metaProcess(id: string, name = 'proc', command = 'echo hi'): {
  id: string
  name: string
  command: string
  status: 'running' | 'terminating' | 'finished' | 'failed' | 'killed' | 'terminate_timeout'
  exitCode: number | null
  exitSignal: string | null
  startedAt: number
  stoppedAt: number | null
} {
  return {
    id,
    name,
    command,
    status: 'running',
    exitCode: null,
    exitSignal: null,
    startedAt: Date.now(),
    stoppedAt: null,
  }
}

/** Build one tool/result event carrying the process tool's meta. */
function resultEvent(meta: unknown): SessionEvent {
  return {
    type: 'tool/result',
    seq: 1,
    time: Date.now(),
    data: { turn: 1, step: 1, message: { content: [] }, meta },
  } as unknown as SessionEvent
}

describe('applyProcessesProjection', () => {
  it('starts empty and adds running processes from start results', () => {
    const state = applyProcessesProjection(
      EMPTY_PROCESSES_PROJECTION,
      resultEvent({ kind: 'start', process: metaProcess('proc_ab12', 'server', 'npm run dev') }),
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

    const second = applyProcessesProjection(
      state,
      resultEvent({ kind: 'start', process: metaProcess('proc_cd34', 'tests', 'pnpm test') }),
    )
    expect(second.processes.map(entry => entry.id)).toEqual(['proc_ab12', 'proc_cd34'])
    expect(second.running).toBe(2)
  })

  it('stop results settle the entry and decrement the running count', () => {
    const started = applyProcessesProjection(EMPTY_PROCESSES_PROJECTION, resultEvent({ kind: 'start', process: metaProcess('proc_ab12') }))
    const stopped = applyProcessesProjection(started, resultEvent({
      kind: 'stop',
      process: { ...metaProcess('proc_ab12'), status: 'finished', exitCode: 0, stoppedAt: Date.now() },
    }))
    expect(stopped.processes[0]).toMatchObject({
      status: 'finished',
      exitCode: 0,
      stoppedAt: expect.any(Number),
    })
    expect(stopped.running).toBe(0)
  })

  it('clear removes the settled entries and keeps live ones', () => {
    const started = applyProcessesProjection(EMPTY_PROCESSES_PROJECTION, resultEvent({ kind: 'start', process: metaProcess('proc_ab12') }))
    const stopped = applyProcessesProjection(started, resultEvent({
      kind: 'stop',
      process: { ...metaProcess('proc_ab12'), status: 'finished', exitCode: 0, stoppedAt: Date.now() },
    }))
    const live = applyProcessesProjection(stopped, resultEvent({ kind: 'start', process: metaProcess('proc_live') }))
    const cleared = applyProcessesProjection(live, resultEvent({ kind: 'clear', removed: 1 }))
    expect(cleared.processes.map(entry => entry.id)).toEqual(['proc_live'])
    expect(cleared.running).toBe(1)
  })

  it('returns the same reference for unrelated events', () => {
    const state = applyProcessesProjection(EMPTY_PROCESSES_PROJECTION, resultEvent({ kind: 'start', process: metaProcess('proc_ab12') }))
    const unrelated = {
      type: 'user/message',
      seq: 9,
      time: Date.now(),
      data: { message: { role: 'user', content: [] } },
    } as unknown as SessionEvent
    expect(applyProcessesProjection(state, unrelated)).toBe(state)
  })

  it('ignores results without the process meta', () => {
    const state = applyProcessesProjection(EMPTY_PROCESSES_PROJECTION, resultEvent({ kind: 'start', process: metaProcess('proc_ab12') }))
    expect(applyProcessesProjection(state, resultEvent({ kind: 'output', text: 'hello' }))).toBe(state)
    expect(applyProcessesProjection(state, resultEvent({ something: 1 }))).toBe(state)
  })
})

describe('processes projection wire', () => {
  it('the unit declares the expected key and version', () => {
    expect(processesProjectionUnit.key).toBe('processes')
    expect(processesProjectionUnit.stateVersion).toBe(2)
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

