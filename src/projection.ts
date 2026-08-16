/**
 * The `processes` session projection: a whole-value snapshot of the session's
 * managed processes, folded from the standard `tool/result` events of the
 * process tool (via its presentationMeta) — no custom session events, so the
 * log stays readable by any harness. The browser dock reads this projection
 * through the framework's `useProjection` hook.
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
export const PROCESSES_PROJECTION_STATE_VERSION = 2

/** The projection for a log with no process activity. */
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

/** One process row carried by the process tool's result meta. */
interface MetaProcess {
  readonly id: string
  readonly name: string
  readonly command: string
  readonly status: ProcessProjectionEntry['status']
  readonly exitCode: number | null
  readonly exitSignal: string | null
  readonly startedAt: number
  readonly stoppedAt: number | null
}

/** The process tool's result meta, as projected by presentationMeta. */
type ProcessToolMeta =
  | { kind: 'start'; process: MetaProcess }
  | { kind: 'stop'; process: MetaProcess }
  | { kind: 'clear'; removed: number }

/**
 * Decode the process tool's presentationMeta from one tool/result event.
 * @param event - the session event.
 * @returns the structured meta, or undefined when the event is not a process result.
 */
function metaOf(event: SessionEvent): ProcessToolMeta | undefined {
  if (event.type !== 'tool/result') return undefined
  const meta = (event.data as { meta?: unknown }).meta
  if (typeof meta !== 'object' || meta === null) return undefined
  const record = meta as { kind?: unknown; process?: unknown; removed?: unknown }
  if (typeof record.kind !== 'string') return undefined
  switch (record.kind) {
    case 'start':
    case 'stop': {
      const process = record.process as MetaProcess | undefined
      if (process === undefined || typeof process.id !== 'string') return undefined
      return { kind: record.kind, process }
    }
    case 'clear':
      return typeof record.removed === 'number' ? { kind: 'clear', removed: record.removed } : undefined
    default:
      return undefined
  }
}

/** Convert a meta process row into a projection entry (notifications are not persisted). */
function toEntry(process: MetaProcess): ProcessProjectionEntry {
  return {
    id: process.id,
    name: process.name,
    command: process.command,
    status: process.status,
    exitCode: process.exitCode,
    exitSignal: process.exitSignal,
    startedAt: process.startedAt,
    stoppedAt: process.stoppedAt,
    lastNotify: null,
  }
}

/** Recompute the live count. */
function runningOf(processes: readonly ProcessProjectionEntry[]): number {
  let running = 0
  for (const entry of processes) {
    if (entry.status === 'running' || entry.status === 'terminating') running++
  }
  return running
}

/** Replace one entry by id; unknown ids leave the list unchanged. */
function upsert(list: readonly ProcessProjectionEntry[], entry: ProcessProjectionEntry): ProcessProjectionEntry[] {
  const index = list.findIndex(item => item.id === entry.id)
  if (index < 0) return [...list, entry]
  const next = [...list]
  next[index] = entry
  return next
}

/**
 * Pure transition: previous projection + one committed event → next.
 * Unrelated events return the same reference (the registry's Object.is gate).
 * @param state - the projection covering all prior events.
 * @param event - the next committed session event.
 * @returns the next projection (same reference when the event is not a process result).
 */
export function applyProcessesProjection(state: ProcessesProjection, event: SessionEvent): ProcessesProjection {
  const meta = metaOf(event)
  if (meta === undefined) return state
  if (meta.kind === 'start' || meta.kind === 'stop') {
    const processes = upsert(state.processes, toEntry(meta.process))
    return { processes, running: runningOf(processes) }
  }
  if (meta.kind === 'clear') {
    const processes = state.processes.filter(entry => entry.status === 'running' || entry.status === 'terminating')
    return { processes, running: runningOf(processes) }
  }
  return state
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

