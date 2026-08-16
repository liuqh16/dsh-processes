/**
 * The model-facing process tool: one `process` tool with an `action`
 * discriminator (start, list, stop, output, write, clear, update) over the
 * process manager. Schema enforces shape; value constraints the schema DSL
 * cannot express (non-empty names, bounded tail lines, valid regexes) are
 * checked in `execute` before any manager call.
 * @module dsh-processes/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type InferArgs, type InferValue, type ToolResult, type ToolCallView, type ToolResultView } from '@deepseek-ai/dsh-tools'
import {
  assertValidMatchers,
  compilePattern,
  normalizeMatcher,
  type ProcessManager,
} from './manager.ts'
import {
  renderClear,
  renderList,
  renderOutput,
  renderStart,
  renderStop,
  renderUpdate,
  renderWrite,
} from './render.ts'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { LogMatcher, NotifyAttention, ProcessInfo, ProcessMatchMode, ProcessStream } from './types.ts'
import {
  LIMITS,
  NOTIFY_ATTENTIONS,
  PROCESS_MATCH_MODES,
  PROCESS_SORTS,
  PROCESS_STATUSES,
  PROCESS_STREAMS,
  WATCH_UPDATE_MODES,
} from './types.ts'

const ACTIONS = ['start', 'list', 'stop', 'output', 'write', 'clear', 'update'] as const

/** One log-matcher item, shared by notify.logMatches and watches.items. */
const MATCHER_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pattern: { type: 'string', required: true, description: 'Log pattern to match. Literal by default; regex only when mode is regex.' },
    mode: { type: 'string', enum: [...PROCESS_MATCH_MODES], description: 'Pattern matching mode. Defaults to literal.' },
    stream: { type: 'string', enum: [...PROCESS_STREAMS], description: 'Output stream to inspect. Defaults to both.' },
    repeat: { type: 'boolean', description: 'Whether this matcher can notify more than once. Defaults to false.' },
    on: { type: 'string', enum: [...NOTIFY_ATTENTIONS], description: 'Agent attention for this log match. Defaults to turn.' },
  },
} as const

/** Notification settings for the start action. */
const NOTIFY_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    onSuccess: { type: 'string', enum: [...NOTIFY_ATTENTIONS], description: 'Attention on clean exit. Defaults to turn.' },
    onFailure: { type: 'string', enum: [...NOTIFY_ATTENTIONS], description: 'Attention on failure or crash. Defaults to turn.' },
    onKilled: { type: 'string', enum: [...NOTIFY_ATTENTIONS], description: 'Attention on external kill. Defaults to context.' },
    logMatches: { type: 'array', items: MATCHER_ITEM, description: 'Log match notifications. At most ' + LIMITS.maxMatchers + ' matchers, each pattern limited to ' + LIMITS.patternLength + ' characters.' },
  },
} as const

/** Watch update payload for the update action. */
const WATCH_UPDATE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', required: true, enum: [...WATCH_UPDATE_MODES], description: 'How to update log watches.' },
    items: { type: 'array', items: MATCHER_ITEM, description: 'Watch entries. For append/replace, full matcher definitions; for remove, an index or pattern to identify matchers.' },
  },
} as const

/** Tool parameters: action discriminator plus per-action optional fields. */
const PROCESS_PARAMETERS = {
  action: { type: 'string', required: true, enum: [...ACTIONS], description: 'Action to perform.' },
  name: { type: 'string', description: 'Process name. Required for start.' },
  command: { type: 'string', description: 'Shell command to run. Required for start.' },
  cwd: { type: 'string', description: 'Working directory for start. Defaults to the agent session cwd. Only for start.' },
  notify: NOTIFY_PARAMS,
  id: { type: 'string', description: 'Opaque process id returned by start or list (for example proc_ab12). Required for stop, output, write, and update. Process names are not accepted.' },
  limit: { type: 'integer', description: 'Maximum number of processes to list.' },
  sortBy: { type: 'string', enum: [...PROCESS_SORTS], description: 'Sort order for process list results.' },
  statuses: { type: 'array', items: { type: 'string', enum: [...PROCESS_STATUSES] }, description: 'Process list status filters. finished means exited successfully; failed means exited unsuccessfully or crashed; killed means terminated by signal.' },
  stream: { type: 'string', enum: [...PROCESS_STREAMS], description: 'Output stream to return. Defaults to both. Only for output.' },
  tailLines: { type: 'integer', description: 'Maximum matching lines to return per selected stream. Defaults to ' + LIMITS.defaultTailLines + '. Only for output.' },
  pattern: { type: 'string', description: 'Optional output filter. Literal by default; regex only when mode is regex. Only for output.' },
  mode: { type: 'string', enum: [...PROCESS_MATCH_MODES], description: 'Pattern matching mode for output filter. Defaults to literal. Only for output.' },
  input: { type: 'string', description: 'Text to write to the process stdin. Only for write.' },
  end: { type: 'boolean', description: 'Close stdin after writing. Use to signal end-of-input (EOF). Only for write.' },
  watches: WATCH_UPDATE,
} as const

type ProcessToolArgs = InferArgs<typeof PROCESS_PARAMETERS>

/** Canonical process facts shared by the start/list/stop result branches. */
const PROCESS_INFO = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    command: { type: 'string', required: true },
    cwd: { type: 'string', required: true },
    pid: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
    status: { type: 'string', required: true, enum: [...PROCESS_STATUSES] },
    startedAt: { type: 'integer', required: true },
    exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
    exitSignal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    stoppedAt: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
  },
} as const

/** Per-stream matched output of the output action. */
const STREAM_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
  },
} as const

/** A persisted log matcher, as returned by the update action. */
const MATCHER_RESULT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pattern: { type: 'string', required: true },
    mode: { type: 'string', required: true, enum: [...PROCESS_MATCH_MODES] },
    stream: { type: 'string', required: true, enum: [...PROCESS_STREAMS] },
    repeat: { type: 'boolean', required: true },
    on: { type: 'string', required: true, enum: [...NOTIFY_ATTENTIONS] },
  },
} as const

/** Canonical output: one exact branch per action, discriminated by kind. */
const PROCESS_OUTPUT = {
  oneOf: [
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'start' }, process: { required: true, ...PROCESS_INFO } } },
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'list' }, processes: { type: 'array', required: true, items: PROCESS_INFO }, total: { type: 'integer', required: true } } },
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'stop' }, process: { required: true, ...PROCESS_INFO }, timedOut: { type: 'boolean', required: true } } },
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'output' }, id: { type: 'string', required: true }, name: { type: 'string', required: true }, stream: { type: 'string', required: true, enum: [...PROCESS_STREAMS] }, tailLines: { type: 'integer', required: true }, mode: { type: 'string', required: true, enum: [...PROCESS_MATCH_MODES] }, pattern: { type: 'string' }, stdout: STREAM_OUTPUT, stderr: STREAM_OUTPUT } },
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'write' }, id: { type: 'string', required: true }, name: { type: 'string', required: true }, inputLength: { type: 'integer', required: true }, end: { type: 'boolean', required: true } } },
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'clear' }, removed: { type: 'integer', required: true } } },
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'update' }, id: { type: 'string', required: true }, name: { type: 'string', required: true }, matchers: { type: 'array', required: true, items: MATCHER_RESULT } } },
  ],
} as const

type ProcessToolValue = InferValue<typeof PROCESS_OUTPUT>

/**
 * Validate the value constraints the parameter schema cannot express, per
 * action, before any manager call.
 * @param args - schema-checked arguments.
 * @throws Error naming the first violation.
 */
function validateProcessArgs(args: ProcessToolArgs): void {
  const requiredId = (): string => {
    if (args.id === undefined || args.id.trim().length === 0) {
      throw new Error('invalid arguments: id is required for this action')
    }
    return args.id
  }
  switch (args.action) {
    case 'start':
      if (args.name === undefined || args.name.trim().length === 0) {
        throw new Error('invalid start: name is required')
      }
      if (args.command === undefined || args.command.trim().length === 0) {
        throw new Error('invalid start: command is required')
      }
      if (args.cwd !== undefined && args.cwd.length === 0) {
        throw new Error('invalid start: cwd must be a non-empty string')
      }
      if (args.notify?.logMatches !== undefined) assertValidMatchers(args.notify.logMatches)
      return
    case 'list':
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit <= 0)) {
        throw new Error('invalid list: limit must be a positive integer, got ' + JSON.stringify(args.limit))
      }
      if (args.limit !== undefined && args.limit > LIMITS.maxListLimit) {
        throw new Error('invalid list: limit exceeds ' + LIMITS.maxListLimit)
      }
      return
    case 'stop':
      requiredId()
      return
    case 'output': {
      requiredId()
      const tailLines = args.tailLines ?? LIMITS.defaultTailLines
      if (!Number.isInteger(tailLines) || tailLines < 1 || tailLines > LIMITS.maxTailLines) {
        throw new Error('invalid output: tailLines must be an integer between 1 and ' + LIMITS.maxTailLines + ', got ' + JSON.stringify(args.tailLines))
      }
      if (args.pattern !== undefined) {
        if (args.pattern.length > LIMITS.patternLength) {
          throw new Error('invalid output: pattern exceeds ' + LIMITS.patternLength + ' characters')
        }
        if (args.mode === 'regex') compilePattern(args.pattern)
      }
      return
    }
    case 'write':
      requiredId()
      if ((args.input === undefined || args.input.length === 0) && args.end !== true) {
        throw new Error('invalid write: input is required unless end is true')
      }
      return
    case 'clear':
      return
    case 'update':
      requiredId()
      if (args.watches === undefined) {
        throw new Error('invalid update: watches is required')
      }
      assertValidMatchers(args.watches.items ?? [])
      return
  }
}

/** Caller-friendly title for one call, for the pending card. */
function presentCallTitle(args: ProcessToolArgs): string {
  switch (args.action) {
    case 'start':
      return args.command ?? 'process start'
    case 'list':
      return 'process list'
    default:
      return 'process ' + args.action + (args.id === undefined ? '' : ' ' + args.id)
  }
}

/** The call card kind for one action. */
function callKind(args: ProcessToolArgs): 'execute' | 'search' | 'other' {
  switch (args.action) {
    case 'start':
    case 'stop':
    case 'write':
    case 'update':
    case 'clear':
      return 'execute'
    case 'list':
    case 'output':
      return 'search'
  }
}

/** One normalized matcher as the canonical update value. */
function matcherToResult(matcher: LogMatcher): {
  pattern: string
  mode: ProcessMatchMode
  stream: ProcessStream
  repeat: boolean
  on: NotifyAttention
} {
  return {
    pattern: matcher.pattern,
    mode: matcher.mode,
    stream: matcher.stream,
    repeat: matcher.repeat,
    on: matcher.on,
  }
}

/** Placeholder process facts for rendering branches that carry only id/name. */
function minimalInfo(id: string, name: string): ProcessInfo {
  return {
    id,
    name,
    command: '',
    cwd: '',
    pid: null,
    status: 'running',
    startedAt: 0,
    exitCode: null,
    exitSignal: null,
    stoppedAt: null,
  }
}

/** The model-facing text for one canonical tool value. */
function renderToolValue(value: ProcessToolValue): string {
  switch (value.kind) {
    case 'start':
      return renderStart(value.process)
    case 'list':
      return renderList(value.processes)
    case 'stop':
      return renderStop({ process: value.process, timedOut: value.timedOut })
    case 'output':
      return renderOutput(minimalInfo(value.id, value.name), {
        stream: value.stream,
        tailLines: value.tailLines,
        mode: value.mode,
        ...(value.pattern !== undefined ? { pattern: value.pattern } : {}),
        ...(value.stdout !== undefined ? { stdout: value.stdout } : {}),
        ...(value.stderr !== undefined ? { stderr: value.stderr } : {}),
      })
    case 'write':
      return renderWrite(minimalInfo(value.id, value.name), value.inputLength, value.end)
    case 'clear':
      return renderClear(value.removed)
    case 'update':
      return renderUpdate(minimalInfo(value.id, value.name), value.matchers)
  }
}

/**
 * Durable presentation payloads: the dock projection folds the process tool's
 * start/stop/clear results (through the standard tool/result event) instead of
 * custom session events, so the structured facts ride the result meta.
 */
function presentationMetaOf(value: ProcessToolValue): JsonValue | null {
  switch (value.kind) {
    case 'output': {
      const parts: string[] = []
      if (value.stdout !== undefined) parts.push(value.stdout.text)
      if (value.stderr !== undefined) parts.push(value.stderr.text)
      return { kind: 'output', text: parts.join('\n') }
    }
    case 'start':
      return { kind: 'start', process: value.process }
    case 'stop':
      return { kind: 'stop', process: value.process }
    case 'clear':
      return { kind: 'clear', removed: value.removed }
    default:
      return null
  }
}

/**
 * Register the process tool on the registrant context.
 * @param ctx - registrant context carrying the tool registry.
 * @param manager - the process manager backing the actions.
 */
export function registerProcessTool(ctx: Context, manager: ProcessManager): void {
  ctx.tools.register(defineTool({
    name: 'process',
    description: 'Manage long-running background processes. Start a dev server, test watcher, or local API in the background and keep working; inspect, stop, or write to it later. The agent is notified when a process exits or its output matches a watch pattern.\n\nActions:\n- start: run a shell command in the background. Returns the process id.\n- list: list processes with status.\n- stop: terminate a running process and wait for actual exit.\n- output: read captured output (filtered and tailed).\n- write: send bytes to a running process stdin.\n- update: change the log patterns that trigger notifications.\n- clear: remove finished processes.\n\nPrefer this over shell background tricks like & or nohup: processes started here keep running across the conversation, their output is captured and inspectable, and exit or log-match notifications reach the agent.',
    parameters: PROCESS_PARAMETERS,
    output: {
      schema: PROCESS_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderToolValue(value) }],
      presentationMeta: (_args, value) => presentationMetaOf(value),
    },
    async execute(args, exec): Promise<ProcessToolValue> {
      validateProcessArgs(args)
      switch (args.action) {
        case 'start': {
          if (exec.agent === undefined) {
            throw new Error('process start requires an owning agent session')
          }
          const name = args.name as string
          const command = args.command as string
          const notify = args.notify === undefined ? undefined : {
            ...(args.notify.onSuccess !== undefined ? { onSuccess: args.notify.onSuccess } : {}),
            ...(args.notify.onFailure !== undefined ? { onFailure: args.notify.onFailure } : {}),
            ...(args.notify.onKilled !== undefined ? { onKilled: args.notify.onKilled } : {}),
            ...(args.notify.logMatches !== undefined
              ? { logMatches: args.notify.logMatches.map(matcher => normalizeMatcher(matcher)) }
              : {}),
          }
          const info = await manager.start({
            name,
            command,
            ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
            ...(notify !== undefined ? { notify } : {}),
            owner: exec.agent,
          })
          return { kind: 'start', process: info }
        }
        case 'list': {
          const infos = manager.list({
            ...(args.statuses !== undefined ? { statuses: args.statuses } : {}),
            ...(args.sortBy !== undefined ? { sortBy: args.sortBy } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
          })
          return { kind: 'list', processes: infos, total: infos.length }
        }
        case 'stop': {
          const id = args.id as string
          const result = await manager.stop(id, manager.getConfig().killTimeoutMs)
          return { kind: 'stop', process: result.process, timedOut: result.timedOut }
        }
        case 'output': {
          const id = args.id as string
          const stream = args.stream ?? 'both'
          const tailLines = args.tailLines ?? LIMITS.defaultTailLines
          const mode = args.mode ?? 'literal'
          const result = manager.output(id, stream, tailLines, args.pattern, mode)
          return {
            kind: 'output',
            id,
            name: manager.nameOf(id),
            stream,
            tailLines,
            mode,
            ...(result.pattern !== undefined ? { pattern: result.pattern } : {}),
            ...(result.stdout !== undefined ? { stdout: result.stdout } : {}),
            ...(result.stderr !== undefined ? { stderr: result.stderr } : {}),
          }
        }
        case 'write': {
          const id = args.id as string
          const input = args.input ?? ''
          const end = args.end ?? false
          const result = manager.write(id, input, end)
          return { kind: 'write', id, name: manager.nameOf(id), inputLength: result.inputLength, end: result.end }
        }
        case 'clear': {
          const removed = manager.clear()
          return { kind: 'clear', removed }
        }
        case 'update': {
          const id = args.id as string
          const watches = args.watches
          const items = (watches?.items ?? []).map(matcher => normalizeMatcher(matcher))
          const matchers = manager.update(id, {
            mode: watches?.mode ?? 'replace',
            items,
          })
          return { kind: 'update', id, name: manager.nameOf(id), matchers: matchers.map(matcherToResult) }
        }
      }
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title: presentCallTitle(args),
      kind: callKind(args),
      ...(args.action === 'start' ? { rawInput: args.name } : {}),
    }),
    presentResult: (_args, result: ToolResult): ToolResultView | undefined => {
      const meta = result.meta
      if (typeof meta === 'object' && meta !== null && (meta as { kind?: unknown }).kind === 'output') {
        const text = (meta as { text?: unknown }).text
        if (typeof text === 'string') {
          return { card: 'terminal', output: text }
        }
      }
      return undefined
    },
  }))
}