/**
 * The `processes` session projection: a whole-value snapshot of the session's
 * managed processes folded from its `process/*` events. The browser dock
 * reads this projection through the framework's `useProjection` hook, so the
 * host needs no extra data channel: the durable events the manager already
 * appends are the single source of truth.
 * @module dsh-processes/projection
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z as zod } from 'zod'
import type {
  ProcessesProjection,
  ProcessProjectionEntry,
} from './types.ts'

/** The projection key this unit owns (merged into SessionProjectionMap). */
export const PROCESSES_PROJECTION_KEY = 'processes'

/** Persisted-cache invalidation version of the fold semantics. */
export const PROCESSES_PROJECTION_STATE_VERSION = 1

/** The projection for a log with no process events. */
export const EMPTY_PROCESSES_PROJECTION: ProcessesProjection = {
  processes: [],
  running: 0,
}

/** Wire schema of one projected process entry. */
const entrySchema = zod.object({
  id: zod.string(),
  name: zod.string(),
  command: zod.string(),
  status: zod.enum(['running', 'terminating', 'finished', 'failed', 'killed', 'terminate_timeout']),
  exitCode: zod.number().nullable(),
  exitSignal: zod.string().nullable(),
  startedAt: zod.number(),
  stoppedAt: zod.number().nullable(),
  lastNotify: zod.string().nullable(),
})

/** Wire schema of the whole projection. */
export const processesProjectionSchema: zod.ZodType<ProcessesProjection> = zod.object({
  processes: zod.array(entrySchema),
  running: zod.number(),
})

/**
 * Pure transition: previous projection + one committed event → next.
 * Unrelated events return the same reference (the registry's Object.is gate).
 * @param state - the projection covering all prior events.
 * @param event - the next committed session event.
 * @returns the next projection (same reference when the event is not a process event).
 */
export function applyProcessesProjection(state: ProcessesProjection, event: SessionEvent): ProcessesProjection {
  switch (event.type) {
    case 'process/start': {
      const data = event.data as unknown as {
        id: string
        name: string
        command: string
        startedAt: number
      }
      const entry: ProcessProjectionEntry = {
        id: data.id,
        name: data.name,
        command: data.command,
        status: 'running',
        exitCode: null,
        exitSignal: null,
        startedAt: data.startedAt,
        stoppedAt: null,
        lastNotify: null,
      }
      return {
        processes: [...state.processes, entry],
        running: state.running + 1,
      }
    }
    case 'process/exit': {
      const data = event.data as unknown as {
        id: string
        status: 'finished' | 'failed' | 'killed'
        exitCode: number | null
        exitSignal: string | null
        stoppedAt: number
      }
      return updateEntry(state, data.id, entry => ({
        ...entry,
        status: data.status,
        exitCode: data.exitCode,
        exitSignal: data.exitSignal,
        stoppedAt: data.stoppedAt,
      }))
    }
    case 'process/clear': {
      const data = event.data as unknown as {
        id: string
      }
      const index = state.processes.findIndex(entry => entry.id === data.id)
      if (index < 0) return state
      const processes = state.processes.filter(entry => entry.id !== data.id)
      return {
        processes,
        running: runningOf(processes),
      }
    }
    case 'process/notify': {
      const data = event.data as unknown as {
        id: string
        text: string
      }
      return updateEntry(state, data.id, entry => ({
        ...entry,
        lastNotify: data.text,
      }))
    }
    default:
      return state
  }
}

/**
 * The projection unit registered under `processes`. Folding drives the
 * persisted cache; the view is the state itself (already wire-JSON).
 */
export const processesProjectionUnit: ProjectionDefinition<'processes', ProcessesProjection> = {
  key: PROCESSES_PROJECTION_KEY,
  schema: processesProjectionSchema,
  init: () => EMPTY_PROCESSES_PROJECTION,
  apply: applyProcessesProjection,
  view: state => state,
  stateVersion: PROCESSES_PROJECTION_STATE_VERSION,
}

/** Recompute the live count after any change. */
function runningOf(processes: readonly ProcessProjectionEntry[]): number {
  let running = 0
  for (const entry of processes) {
    if (entry.status === 'running' || entry.status === 'terminating') running++
  }
  return running
}

/** Replace one entry by id; an unknown id leaves the projection unchanged. */
function updateEntry(
  state: ProcessesProjection,
  id: string,
  patch: (entry: ProcessProjectionEntry) => ProcessProjectionEntry,
): ProcessesProjection {
  const index = state.processes.findIndex(entry => entry.id === id)
  if (index < 0) return state
  const next = [...state.processes]
  const current = next[index]
  if (current === undefined) return state
  next[index] = patch(current)
  return {
    processes: next,
    running: runningOf(next),
  }
}