/**
 * Process manager for dsh-processes: spawn, registry, output access, and
 * termination of shell commands through the ctx.subprocess seam. One
 * manager owns the full process set of the running harness; every process
 * records its owning agent for notifications and durable session events.
 * @module dsh-processes/manager
 */

import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  SubprocessHandle,
  SubprocessOutputReader,
  SubprocessOutcome,
} from '@deepseek-ai/dsh-subprocess'
import {
  LIVE_STATUSES,
  LIMITS,
  type LogMatcher,
  type ProcessInfo,
  type ProcessMatchMode,
  type ProcessNotifySettings,
  type ProcessSort,
  type ProcessStatus,
  type ProcessStream,
  type RawLogMatcher,
  type ResolvedProcessConfig,
  type StartNotifyParams,
  type WatchUpdateRequest,
} from './types.ts'

/** A settled process holds one of these final statuses. */
export type SettledStatus = Exclude<ProcessStatus, 'running' | 'terminating' | 'terminate_timeout'>

/** One owned process record; the manager's private registry value. */
export interface ManagedProcess {
  id: string
  name: string
  command: string
  cwd: string
  pid: number
  status: ProcessStatus
  startedAt: number
  exitCode: number | null
  exitSignal: string | null
  stoppedAt: number | null
  handle: SubprocessHandle
  owner: Agent
  notify: ProcessNotifySettings
  matchers: LogMatcher[]
  stdout: SubprocessOutputReader
  stderr: SubprocessOutputReader
  stdoutOffset: number
  stderrOffset: number
  settled: boolean
  /** Per-matcher fired flags for repeat: false. */
  matcherFired: boolean[]
  /** Set on spawn failure; surfaced through the settle path and output reads. */
  spawnError?: string
}

/** Input for starting one managed process. */
export interface StartRequest {
  name: string
  command: string
  /** Working directory; defaults to the owning session's cwd. */
  cwd?: string
  /** Exit and log-match notification settings. */
  notify?: StartNotifyParams
  /** The agent that started the process (owns notifications and events). */
  owner: Agent
}

/** Filter and pagination for the list action. */
export interface ListRequest {
  statuses?: readonly ProcessStatus[]
  sortBy?: ProcessSort
  limit?: number
}

/** Result of the output action for one stream. */
export interface StreamOutput {
  /** Matched lines joined by newlines. */
  text: string
  /** True when lines were dropped to honor tailLines. */
  truncated: boolean
}

/** Result of the output action. */
export interface OutputResult {
  stream: ProcessStream
  tailLines: number
  pattern?: string
  mode: ProcessMatchMode
  stdout?: StreamOutput
  stderr?: StreamOutput
}

/** Settled exit facts for the stop action. */
export interface StopResult {
  process: ProcessInfo
  timedOut: boolean
}

/** write action acknowledgment. */
export interface WriteResult {
  inputLength: number
  end: boolean
}

/** Default notification settings when the caller supplies none. */
const DEFAULT_NOTIFY: ProcessNotifySettings = {
  onSuccess: 'turn',
  onFailure: 'turn',
  onKilled: 'context',
}

/**
 * Split text into lines without a trailing empty line for a terminal newline.
 * @param text - stream text, any length.
 * @returns the lines.
 */
export function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split(/\r?\n/u)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Normalize one raw matcher (schema-optional fields) into a full LogMatcher.
 * @param matcher - the raw matcher payload.
 * @returns the normalized matcher with defaults applied.
 */
export function normalizeMatcher(matcher: RawLogMatcher): LogMatcher {
  return {
    pattern: matcher.pattern,
    mode: matcher.mode ?? 'literal',
    stream: matcher.stream ?? 'both',
    repeat: matcher.repeat ?? false,
    on: matcher.on ?? 'turn',
  }
}

/**
 * Normalize one model-supplied notify object into settings plus matchers.
 * @param notify - the notify argument, or undefined.
 * @returns the exit settings and the matcher list.
 */
export function normalizeNotify(notify: StartNotifyParams | undefined): {
  settings: ProcessNotifySettings
  matchers: LogMatcher[]
} {
  const settings: ProcessNotifySettings = {
    onSuccess: notify?.onSuccess ?? DEFAULT_NOTIFY.onSuccess,
    onFailure: notify?.onFailure ?? DEFAULT_NOTIFY.onFailure,
    onKilled: notify?.onKilled ?? DEFAULT_NOTIFY.onKilled,
  }
  const matchers = (notify?.logMatches ?? []).map(matcher => normalizeMatcher(matcher))
  return { settings, matchers }
}

/**
 * Validate a model-supplied matcher list and fail loud on the value
 * constraints the parameter schema cannot express.
 * @param matchers - candidate matchers, schema-checked for shape.
 * @throws Error naming the first violation.
 */
export function assertValidMatchers(matchers: readonly RawLogMatcher[]): void {
  if (matchers.length > LIMITS.maxMatchers) {
    throw new Error('invalid matchers: at most ' + LIMITS.maxMatchers + ' log matchers per process (got ' + matchers.length + ')')
  }
  for (const matcher of matchers) {
    if (matcher.pattern.length === 0) {
      throw new Error('invalid matcher: pattern must be a non-empty string')
    }
    if (matcher.pattern.length > LIMITS.patternLength) {
      throw new Error('invalid matcher: pattern exceeds ' + LIMITS.patternLength + ' characters')
    }
    if (matcher.mode === 'regex') compilePattern(matcher.pattern)
  }
}

/** Compile a regex pattern, or throw for an invalid one. */
export function compilePattern(pattern: string): RegExp | undefined {
  if (pattern.length === 0) return undefined
  try {
    return new RegExp(pattern, 'u')
  } catch (error) {
    throw new Error('invalid regex pattern ' + JSON.stringify(pattern) + ': ' + String(error))
  }
}

/** Whether one line matches one matcher. */
export function lineMatches(line: string, matcher: LogMatcher): boolean {
  if (matcher.mode === 'regex') {
    const re = compilePattern(matcher.pattern)
    return re === undefined ? false : re.test(line)
  }
  return line.includes(matcher.pattern)
}

/**
 * Filter lines by pattern and cap to the requested tail.
 * @param text - complete stream text.
 * @param pattern - optional literal/regex filter.
 * @param mode - matching mode for the pattern.
 * @param tailLines - maximum matching lines to return.
 * @returns the matching lines and whether any were dropped.
 */
export function filterOutput(
  text: string,
  pattern: string | undefined,
  mode: ProcessMatchMode,
  tailLines: number,
): StreamOutput {
  let lines = splitLines(text)
  if (pattern !== undefined && pattern.length > 0) {
    const re = mode === 'regex' ? compilePattern(pattern) : undefined
    lines = lines.filter(line => re !== undefined ? re.test(line) : line.includes(pattern))
  }
  const truncated = lines.length > tailLines
  return {
    text: (truncated ? lines.slice(-tailLines) : lines).join('\n'),
    truncated,
  }
}

/**
 * The process manager: one registry plus spawn/terminate/output lifecycle
 * over ctx.subprocess. Composition teardown terminates every live tree.
 */
export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>()

  /** The notifications hook, wired once by the notification service. */
  onSettled?: (process: ManagedProcess) => void

  /**
   * Create a manager over the registrant context.
   * @param ctx - context carrying the subprocess service.
   * @param config - resolved deployment configuration.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedProcessConfig,
  ) {}

  /** @returns the resolved configuration this manager runs under. */
  getConfig(): ResolvedProcessConfig {
    return this.config
  }

  /**
   * Start one shell command as a managed background process.
   * @param request - name, command, cwd, notification settings, and owning agent.
   * @returns the public start facts; the process keeps running after this resolves.
   */
  async start(request: StartRequest): Promise<ProcessInfo> {
    if (this.processes.size >= this.config.maxProcesses) {
      throw new Error('cannot start process: at most ' + this.config.maxProcesses + ' managed processes')
    }
    const id = this.nextId()
    const cwd = request.cwd ?? request.owner.session.header.cwd ?? process.cwd()
    const shell = await this.ctx.subprocess.resolveExecutable(this.config.shellPath ?? 'bash')
    const handle = this.ctx.subprocess.spawn({
      argv: [shell, ...this.config.shellArgs, request.command],
      cwd,
      stdio: {
        stdin: 'pipe',
        stdout: { maxBytes: this.config.maxOutputBytes, spill: { maxBytes: this.config.maxSpillBytes } },
        stderr: { maxBytes: this.config.maxOutputBytes, spill: { maxBytes: this.config.maxSpillBytes } },
      },
      graceMs: this.config.graceMs,
    })
    // A child that exits early turns a later write into EPIPE; that is a
    // normal no-op for the write action, not an error worth surfacing.
    handle.stdin?.on('error', () => {})
    const { stdout, stderr } = assertCollected(handle)
    const { settings, matchers } = normalizeNotify(request.notify)
    const record: ManagedProcess = {
      id,
      name: request.name,
      command: request.command,
      cwd,
      pid: handle.pid,
      status: 'running',
      startedAt: Date.now(),
      exitCode: null,
      exitSignal: null,
      stoppedAt: null,
      handle,
      owner: request.owner,
      notify: settings,
      matchers,
      stdout,
      stderr,
      stdoutOffset: 0,
      stderrOffset: 0,
      settled: false,
      matcherFired: matchers.map(() => false),
    }
    this.processes.set(id, record)
    handle.done.then(
      (outcome) => this.settle(id, outcome),
      (error: unknown) => this.settleSpawnFailure(id, error),
    )
    return this.publicInfo(record)
  }

  /**
   * Stop one live process: begin the tree-scoped termination escalation and
   * wait for actual exit (or the configured timeout).
   * @param id - the process id.
   * @param timeoutMs - how long to wait for the tree to exit.
   * @returns the settled process facts and whether the wait timed out.
   */
  async stop(id: string, timeoutMs: number): Promise<StopResult> {
    const record = this.require(id)
    if (!LIVE_STATUSES.has(record.status)) {
      return { process: this.publicInfo(record), timedOut: false }
    }
    record.status = 'terminating'
    record.handle.terminate()
    const exited = await record.handle.waitForExit(AbortSignal.timeout(timeoutMs))
    if (!exited) {
      record.status = 'terminate_timeout'
      return { process: this.publicInfo(record), timedOut: true }
    }
    // Await the settle wired at start so exit facts are final before we report.
    await record.handle.done.catch(() => undefined)
    return { process: this.publicInfo(record), timedOut: false }
  }

  /**
   * Read the retained output of one process, filtered and capped.
   * @param id - the process id.
   * @param stream - streams to include.
   * @param tailLines - maximum matching lines per stream.
   * @param pattern - optional literal/regex line filter.
   * @param mode - matching mode for the pattern.
   * @returns the per-stream matched output.
   */
  output(
    id: string,
    stream: ProcessStream,
    tailLines: number,
    pattern: string | undefined,
    mode: ProcessMatchMode,
  ): OutputResult {
    const record = this.require(id)
    const result: OutputResult = { stream, tailLines, mode }
    if (stream === 'stdout' || stream === 'both') {
      result.stdout = filterOutput(record.stdout.readFrom(0).text, pattern, mode, tailLines)
    }
    if (stream === 'stderr' || stream === 'both') {
      result.stderr = filterOutput(record.stderr.readFrom(0).text, pattern, mode, tailLines)
    }
    if (pattern !== undefined) result.pattern = pattern
    return result
  }

  /**
   * Write bytes to a running process's stdin, optionally closing it.
   * @param id - the process id.
   * @param input - the bytes to write (empty when only closing).
   * @param end - whether to close stdin after writing (EOF).
   * @returns the acknowledgment.
   */
  write(id: string, input: string, end: boolean): WriteResult {
    const record = this.require(id)
    if (record.settled) {
      throw new Error('process ' + id + ' has already exited')
    }
    const stdin = record.handle.stdin
    if (stdin === undefined) {
      throw new Error('process ' + id + ' has no writable stdin')
    }
    try {
      if (end) {
        stdin.end(input)
      } else if (input.length > 0) {
        stdin.write(input)
      }
    } catch (error) {
      throw new Error('process ' + id + ': failed to write stdin: ' + String(error))
    }
    return { inputLength: input.length, end }
  }

  /**
   * Update the log matchers of one process.
   * @param id - the process id.
   * @param request - the update mode and matcher payload.
   * @returns the resulting matcher list.
   */
  update(id: string, request: WatchUpdateRequest): LogMatcher[] {
    const record = this.require(id)
    switch (request.mode) {
      case 'append':
        if (request.items !== undefined) {
          record.matchers.push(...request.items.map(matcher => normalizeMatcher(matcher)))
        }
        break
      case 'replace':
        record.matchers = request.items === undefined ? [] : request.items.map(matcher => normalizeMatcher(matcher))
        break
      case 'remove':
        removeMatchers(record, request.items)
        break
      case 'clear':
        record.matchers = []
        break
    }
    record.matcherFired = record.matchers.map(() => false)
    return record.matchers
  }

  /**
   * List processes, optionally filtered, sorted, and capped.
   * @param request - status filters, sort order, and limit.
   * @returns the public process list.
   */
  list(request: ListRequest): ProcessInfo[] {
    let list = [...this.processes.values()].map(process => this.publicInfo(process))
    if (request.statuses !== undefined && request.statuses.length > 0) {
      const wanted = new Set(request.statuses)
      list = list.filter(process => wanted.has(process.status))
    }
    list = sortProcesses(list, request.sortBy ?? 'startTime_desc')
    if (request.limit !== undefined && request.limit > 0) {
      list = list.slice(0, request.limit)
    }
    return list
  }

  /**
   * Remove finished processes and free their retained output.
   * @returns how many processes were removed.
   */
  clear(): number {
    let removed = 0
    for (const [id, process] of this.processes) {
      if (!LIVE_STATUSES.has(process.status)) {
        this.processes.delete(id)
        removed++
      }
    }
    return removed
  }

  /** @returns the ids of live processes carrying log matchers. */
  liveWithMatchers(): string[] {
    const ids: string[] = []
    for (const [id, process] of this.processes) {
      if (process.status === 'running' && process.matchers.length > 0) ids.push(id)
    }
    return ids
  }

  /**
   * Consume the output produced since the previous read of one process.
   * @param id - the process id.
   * @returns the deltas, split per stream.
   */
  readDelta(id: string): { stdout: string; stderr: string } {
    const record = this.require(id)
    const out = record.stdout.readFrom(record.stdoutOffset)
    const err = record.stderr.readFrom(record.stderrOffset)
    record.stdoutOffset = out.nextOffset
    record.stderrOffset = err.nextOffset
    return { stdout: out.text, stderr: err.text }
  }

  /** @returns the matcher list of one process (for the notification service). */
  matchersOf(id: string): readonly LogMatcher[] {
    return this.require(id).matchers
  }

  /** @returns the matcher fired flags of one process. */
  matcherFiredOf(id: string): boolean[] {
    return this.require(id).matcherFired
  }

  /** Terminate every live tree; called at composition teardown. */
  dispose(): void {
    for (const process of this.processes.values()) {
      if (LIVE_STATUSES.has(process.status)) process.handle.terminate()
    }
    this.processes.clear()
  }

  /** Resolve the owning agent of one process (for command rendering). */
  ownerOf(id: string): Agent {
    return this.require(id).owner
  }

  /** @returns the display name of one process. */
  nameOf(id: string): string {
    return this.require(id).name
  }

  /** @returns the public facts of one process. */
  infoOf(id: string): ProcessInfo {
    return this.publicInfo(this.require(id))
  }

  /** Persist the matcher-fired flags of one process after a scan. */
  setMatcherFired(id: string, fired: readonly boolean[]): void {
    this.require(id).matcherFired = [...fired]
  }

  /** @returns the internal record of one process (notification delivery). */
  recordOf(id: string): ManagedProcess {
    return this.require(id)
  }

  private require(id: string): ManagedProcess {
    const record = this.processes.get(id)
    if (record === undefined) {
      throw new Error('unknown process ' + id + ' — start or list to see valid ids')
    }
    return record
  }

  private nextId(): string {
    let id: string
    do {
      id = 'proc_' + randomBytes(2).toString('hex')
    } while (this.processes.has(id))
    return id
  }

  /** Settle one process from its close outcome; a disposed record is a no-op. */
  private settle(id: string, outcome: SubprocessOutcome): void {
    const record = this.processes.get(id)
    if (record === undefined || record.settled) return
    record.settled = true
    record.exitCode = outcome.exitCode
    record.exitSignal = outcome.signal
    record.stoppedAt = Date.now()
    record.status = settleStatus(outcome)
    this.finishSettle(record)
  }

  /** Settle one process whose spawn itself failed (done rejected); a disposed record is a no-op. */
  private settleSpawnFailure(id: string, error: unknown): void {
    const record = this.processes.get(id)
    if (record === undefined || record.settled) return
    record.settled = true
    record.exitCode = null
    record.exitSignal = null
    record.stoppedAt = Date.now()
    record.status = 'failed'
    record.spawnError = String(error)
    this.finishSettle(record)
  }

  private finishSettle(record: ManagedProcess): void {
    this.onSettled?.(record)
  }


  private publicInfo(record: ManagedProcess): ProcessInfo {
    return {
      id: record.id,
      name: record.name,
      command: record.command,
      cwd: record.cwd,
      pid: record.pid < 0 ? null : record.pid,
      status: record.status,
      startedAt: record.startedAt,
      exitCode: record.exitCode,
      exitSignal: record.exitSignal,
      stoppedAt: record.stoppedAt,
    }
  }
}

/** Classify a close outcome into its settled status. */
function settleStatus(outcome: SubprocessOutcome): SettledStatus {
  if (outcome.signal !== null) return 'killed'
  return outcome.exitCode === 0 ? 'finished' : 'failed'
}

/** The collect-mode readers this manager requested are present by construction. */
function assertCollected(handle: SubprocessHandle): {
  stdout: SubprocessOutputReader
  stderr: SubprocessOutputReader
} {
  const { stdout, stderr } = handle.collected
  if (stdout === undefined || stderr === undefined) {
    throw new Error('processes: subprocess implementation dropped a requested collect stream')
  }
  return { stdout, stderr }
}

/** Sort public process facts by one order. */
export function sortProcesses(list: ProcessInfo[], sortBy: ProcessSort): ProcessInfo[] {
  const sorted = [...list]
  const byStart = (asc: boolean) => (a: ProcessInfo, b: ProcessInfo) =>
    asc ? a.startedAt - b.startedAt : b.startedAt - a.startedAt
  const byName = (asc: boolean) => (a: ProcessInfo, b: ProcessInfo) =>
    (asc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)) || byStart(false)(a, b)
  const byStatus = (a: ProcessInfo, b: ProcessInfo) =>
    a.status.localeCompare(b.status) || byStart(false)(a, b)
  switch (sortBy) {
    case 'startTime_asc':
      return sorted.sort(byStart(true))
    case 'name_asc':
      return sorted.sort(byName(true))
    case 'name_desc':
      return sorted.sort(byName(false))
    case 'status_asc':
      return sorted.sort(byStatus)
    default:
      return sorted.sort(byStart(false))
  }
}

/** Remove matchers by index (first) or pattern from one process record. */
function removeMatchers(record: ManagedProcess, items: readonly RawLogMatcher[] | undefined): void {
  if (items === undefined || items.length === 0) {
    record.matchers = []
    return
  }
  const kept: LogMatcher[] = []
  const removed = new Set<LogMatcher>()
  for (const item of items) {
    const byIndex = Number.isInteger(Number(item.pattern)) ? Number(item.pattern) : undefined
    if (byIndex !== undefined && byIndex >= 0 && byIndex < record.matchers.length) {
      removed.add(record.matchers[byIndex] as LogMatcher)
    } else {
      const match = record.matchers.find(matcher => matcher.pattern === item.pattern)
      if (match !== undefined) removed.add(match)
    }
  }
  for (const matcher of record.matchers) {
    if (!removed.has(matcher)) kept.push(matcher)
  }
  record.matchers = kept
}