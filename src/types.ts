/**
 * Shared vocabulary for the dsh-processes plugin: public process facts, tool
 * argument and result types, notification settings, resolved configuration,
 * and the durable `process/*` session events appended to the owning agent's
 * session.
 * @module dsh-processes/types
 */

/** Statuses a managed process can hold; the first three are live. */
export const PROCESS_STATUSES = [
  'running',
  'terminating',
  'finished',
  'failed',
  'killed',
  'terminate_timeout',
] as const

/** Public lifecycle status of one managed process. */
export type ProcessStatus = (typeof PROCESS_STATUSES)[number]

/** Live statuses: work still owed to the process tree. */
export const LIVE_STATUSES: ReadonlySet<ProcessStatus> = new Set(['running', 'terminating'])

/** Output streams the `output` action and log matchers can select. */
export const PROCESS_STREAMS = ['stdout', 'stderr', 'both'] as const

/** One stream selector for output reads and log matchers. */
export type ProcessStream = (typeof PROCESS_STREAMS)[number]

/** Pattern matching modes for output filters and log matchers. */
export const PROCESS_MATCH_MODES = ['literal', 'regex'] as const

/** Pattern matching mode for one output filter or log matcher. */
export type ProcessMatchMode = (typeof PROCESS_MATCH_MODES)[number]

/** Agent attention levels for one notification. */
export const NOTIFY_ATTENTIONS = ['turn', 'context', 'ignore'] as const

/**
 * Agent attention for one notification: `turn` wakes an idle agent
 * (followup), `context` only reaches an agent still working (inject),
 * `ignore` never notifies.
 */
export type NotifyAttention = (typeof NOTIFY_ATTENTIONS)[number]

/** How an `update` call changes a process's log matchers. */
export const WATCH_UPDATE_MODES = ['append', 'replace', 'remove', 'clear'] as const

/** One watch-update mode for the `process update` action. */
export type WatchUpdateMode = (typeof WATCH_UPDATE_MODES)[number]

/** Sort orders accepted by the `list` action. */
export const PROCESS_SORTS = [
  'startTime_desc',
  'startTime_asc',
  'name_asc',
  'name_desc',
  'status_asc',
] as const

/** One list sort order. */
export type ProcessSort = (typeof PROCESS_SORTS)[number]

/** Bounds shared by the tool schema and runtime validation. */
export const LIMITS = {
  /** Hard cap on one log-match pattern length (chars). */
  patternLength: 500,
  /** Hard cap on log matchers per process. */
  maxMatchers: 20,
  /** Default tail lines for the `output` action. */
  defaultTailLines: 100,
  /** Upper bound on `output` tail lines. */
  maxTailLines: 2000,
  /** Upper bound on `list` results. */
  maxListLimit: 200,
} as const

/** A raw matcher payload as the model supplies it (schema-optional fields). */
export interface RawLogMatcher {
  readonly pattern: string
  readonly mode?: ProcessMatchMode
  readonly stream?: ProcessStream
  readonly repeat?: boolean
  readonly on?: NotifyAttention
}

/** One log pattern a process's output is matched against for notifications. */
export interface LogMatcher {
  /** Literal substring or regular expression source. */
  readonly pattern: string
  /** Literal by default; regex only when `regex`. */
  readonly mode: ProcessMatchMode
  /** Output stream to inspect; defaults to `both`. */
  readonly stream: ProcessStream
  /** Whether this matcher can notify more than once; defaults to false. */
  readonly repeat: boolean
  /** Agent attention for a match; defaults to `turn`. */
  readonly on: NotifyAttention
}

/** Exit-attention settings captured at start; `logMatches` become matchers. */
export interface ProcessNotifySettings {
  /** Attention on clean exit (exit code 0); defaults to `turn`. */
  readonly onSuccess: NotifyAttention
  /** Attention on failure or crash; defaults to `turn`. */
  readonly onFailure: NotifyAttention
  /** Attention on external kill; defaults to `context`. */
  readonly onKilled: NotifyAttention
}

/** Model-supplied `notify` parameter of the `start` action. */
export interface StartNotifyParams {
  onSuccess?: NotifyAttention
  onFailure?: NotifyAttention
  onKilled?: NotifyAttention
  logMatches?: readonly RawLogMatcher[]
}

/** Model-supplied `watches` parameter of the `update` action. */
export interface WatchUpdateRequest {
  mode: WatchUpdateMode
  items?: readonly RawLogMatcher[]
}

/** Public facts about one managed process (the `list`/`start`/`stop` value). */
export interface ProcessInfo {
  /** Opaque process id (for example `proc_ab12`). */
  readonly id: string
  /** Human display name chosen by the caller. */
  readonly name: string
  /** The shell command that was started. */
  readonly command: string
  /** Working directory the process was started in. */
  readonly cwd: string
  /** Process id (tree root); null when the spawn itself failed. */
  readonly pid: number | null
  /** Current lifecycle status. */
  readonly status: ProcessStatus
  /** Epoch milliseconds when the process started. */
  readonly startedAt: number
  /** Exit code once settled; null while running or after a signal kill. */
  readonly exitCode: number | null
  /** Terminating signal name once settled; null on normal exit. */
  readonly exitSignal: string | null
  /** Epoch milliseconds when the process settled; null while live. */
  readonly stoppedAt: number | null
}

/** Resolved deployment configuration (schemastery defaults already applied). */
export interface ResolvedProcessConfig {
  /** Shell executable override; a bare name resolves through PATH. */
  shellPath?: string
  /** Shell arguments preceding the command; default `['-c']`. */
  shellArgs: readonly string[]
  /** Per-stream in-memory output cap in bytes; overflow keeps the tail. */
  maxOutputBytes: number
  /** Per-stream spill-file cap in bytes; larger streams drop the spill. */
  maxSpillBytes: number
  /** SIGTERM→SIGKILL escalation grace in milliseconds. */
  graceMs: number
  /** How long `stop` waits for the tree to exit before reporting a timeout. */
  killTimeoutMs: number
  /** Notification scan interval in milliseconds. */
  pollIntervalMs: number
  /** Upper bound on managed processes; overflow starts fail loud. */
  maxProcesses: number
}

/** Opens one durable process record. */
export interface ProcessStartData {
  readonly id: string
  readonly name: string
  readonly command: string
  readonly cwd: string
  readonly pid: number
  readonly startedAt: number
}

/** Settles one previously started process record. */
export interface ProcessExitData {
  readonly id: string
  readonly name: string
  readonly status: Exclude<ProcessStatus, 'running' | 'terminating' | 'terminate_timeout'>
  readonly exitCode: number | null
  readonly exitSignal: string | null
  readonly stoppedAt: number
}

/** One managed process in the browser projection (whole-value snapshot fields). */
export interface ProcessProjectionEntry {
  /** Opaque process id (for example `proc_ab12`). */
  readonly id: string
  /** Human display name chosen by the caller. */
  readonly name: string
  /** The shell command that was started. */
  readonly command: string
  /** Current lifecycle status. */
  readonly status: ProcessStatus
  /** Exit code once settled; null while running or after a signal kill. */
  readonly exitCode: number | null
  /** Terminating signal name once settled; null on normal exit. */
  readonly exitSignal: string | null
  /** Epoch milliseconds when the process started. */
  readonly startedAt: number
  /** Epoch milliseconds when the process settled; null while live. */
  readonly stoppedAt: number | null
  /** The most recent delivered notification text; null when none was delivered. */
  readonly lastNotify: string | null
}

/** The `processes` session projection: a whole-value snapshot of managed processes. */
export interface ProcessesProjection {
  /** Every process the session started, in start order. */
  readonly processes: readonly ProcessProjectionEntry[]
  /** Live process count, for the dock badge. */
  readonly running: number
}

/** Records one delivered notification before it reaches the agent. */
export interface ProcessNotifyData {
  readonly id: string
  readonly name: string
  readonly reason: 'exit' | 'log-match'
  /** Exact text delivered to the agent (also logged as `user/message`). */
  readonly text: string
  readonly attention: NotifyAttention
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A managed process started.
     * @param data - stable process identity and start facts.
     */
    'process/start': ProcessStartData
    /**
     * A managed process settled (finished, failed, or killed).
     * @param data - stable process identity and exit facts.
     */
    'process/exit': ProcessExitData
    /**
     * A notification was delivered for a process (exit or log match).
     * @param data - process identity, reason, delivered text, and attention.
     */
    'process/notify': ProcessNotifyData
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The session's managed processes, folded from the process/* events for
     * the browser dock.
     */
    processes: ProcessesProjection
  }
}