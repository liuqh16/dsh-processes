/**
 * Notification delivery for dsh-processes: process-exit and log-match
 * notifications mapped to agent attention — turn wakes an idle agent via
 * followup, context reaches a working agent via inject, ignore never
 * delivers. Every delivery is preceded by a durable process/notify session
 * event on the owning session, so the model-visible text is reconstructable
 * from the log either way.
 * @module dsh-processes/notifications
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { lineMatches, splitLines, type ManagedProcess, type ProcessManager } from './manager.ts'
import type { NotifyAttention, ResolvedProcessConfig } from './types.ts'

const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'processes' } as const

/** Batched matched lines per notification, to avoid flooding a bursty log. */
const MAX_MATCHED_LINES = 20

/** Markdown fence wrapping the matched lines in the notification text. */
const FENCE = '```'

const ATTENTION_RANK: Record<NotifyAttention, number> = { turn: 2, context: 1, ignore: 0 }

/** Pick the stronger of two attentions (turn beats context beats ignore). */
function preferAttention(a: NotifyAttention, b: NotifyAttention): NotifyAttention {
  return ATTENTION_RANK[b] > ATTENTION_RANK[a] ? b : a
}

/**
 * The notification engine: one poll loop over live processes with matchers
 * plus the exit hook wired into the manager. The poll reads output deltas, so
 * a matcher fires only on output produced since the previous scan.
 */
export class NotificationService {
  private disposer: (() => void) | undefined

  /**
   * Create the service over the registrant context and manager.
   * @param ctx - context owning the poll timer.
   * @param manager - the process manager whose processes are watched.
   * @param config - resolved deployment configuration.
   */
  constructor(
    private readonly ctx: Context,
    private readonly manager: ProcessManager,
    private readonly config: ResolvedProcessConfig,
  ) {}

  /** Wire the exit hook and start the poll loop. */
  start(): void {
    this.manager.onSettled = record => this.notifyExit(record)
    // The base bundle mounts the timer plugin; compositions without it fall
    // back to a global interval cleaned up on context disposal.
    const timer = this.ctx.get('timer')
    if (timer !== undefined) {
      this.disposer = timer.interval(() => this.scan(), this.config.pollIntervalMs)
    } else {
      const handle = setInterval(() => this.scan(), this.config.pollIntervalMs)
      this.ctx.effect(() => () => clearInterval(handle), 'processes: poll timer fallback cleanup')
      this.disposer = () => clearInterval(handle)
    }
  }

  /** Stop the poll loop; called at composition teardown. */
  stop(): void {
    this.disposer?.()
    this.disposer = undefined
  }

  /** Scan every live process with matchers and deliver one batched notification per hit. */
  private scan(): void {
    for (const id of this.manager.liveWithMatchers()) {
      const delta = this.manager.readDelta(id)
      const matchers = this.manager.matchersOf(id)
      const fired = [...this.manager.matcherFiredOf(id)]
      const matchedLines: string[] = []
      let attention: NotifyAttention = 'ignore'
      let firstPattern: string | undefined
      let firstStream: string = 'output'
      for (let index = 0; index < matchers.length; index++) {
        const matcher = matchers[index]
        if (matcher === undefined) continue
        if (!matcher.repeat && fired[index] === true) continue
        const lines = matcher.stream === 'stdout' || matcher.stream === 'both'
          ? splitLines(delta.stdout)
          : []
        const errLines = matcher.stream === 'stderr' || matcher.stream === 'both'
          ? splitLines(delta.stderr)
          : []
        const hit = lines.some(line => lineMatches(line, matcher))
          || errLines.some(line => lineMatches(line, matcher))
        if (!hit) continue
        if (!matcher.repeat) fired[index] = true
        this.manager.setMatcherFired(id, fired)
        attention = preferAttention(attention, matcher.on)
        firstPattern ??= matcher.pattern
        firstStream = matcher.stream
        const seen = new Set(matchedLines)
        for (const line of [...lines, ...errLines]) {
          if (matchedLines.length >= MAX_MATCHED_LINES) break
          if (lineMatches(line, matcher) && !seen.has(line)) {
            seen.add(line)
            matchedLines.push(line)
          }
        }
      }
      if (matchedLines.length === 0 || attention === 'ignore') continue
      const text = 'Process "' + this.manager.nameOf(id) + '" (' + id + ') output matched "'
        + (firstPattern ?? '') + '" in ' + firstStream + ':\n'
        + FENCE + '\n' + matchedLines.join('\n') + '\n' + FENCE
      this.deliver(attention, 'log-match', text, this.manager.recordOf(id))
    }
  }

  /** Deliver one exit notification for a settled process. */
  private notifyExit(record: ManagedProcess): void {
    const attention = record.status === 'finished'
      ? record.notify.onSuccess
      : record.status === 'failed'
        ? record.notify.onFailure
        : record.notify.onKilled
    let text: string
    if (record.status === 'finished') {
      text = 'Process "' + record.name + '" (' + record.id + ') exited with code 0'
    } else if (record.status === 'failed') {
      text = record.spawnError !== undefined
        ? 'Process "' + record.name + '" (' + record.id + ') failed to start: ' + record.spawnError
        : 'Process "' + record.name + '" (' + record.id + ') exited with code ' + String(record.exitCode)
    } else {
      text = 'Process "' + record.name + '" (' + record.id + ') was terminated'
        + (record.exitSignal === null ? '' : ' (' + record.exitSignal + ')')
    }
    this.deliver(attention, 'exit', text, record)
  }

  /** Deliver one notification: durable event first, then agent delivery. */
  private deliver(attention: NotifyAttention, reason: 'exit' | 'log-match', text: string, record: ManagedProcess): void {
    if (attention === 'ignore') return
    try {
      record.owner.session.append('process/notify', {
        id: record.id,
        name: record.name,
        reason,
        text,
        attention,
      })
    } catch {
      // The owning session was disposed while the process outlived it; the
      // live delivery below still reaches the agent when it exists.
    }
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: PLUGIN_SOURCE,
    })
    try {
      if (attention === 'turn') {
        record.owner.followup(message)
      } else {
        record.owner.inject(message)
      }
    } catch {
      // The owning agent was disposed while its process kept running; no
      // further delivery can succeed for this process.
    }
  }
}