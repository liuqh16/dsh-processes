/**
 * dsh-processes: manage background processes from a DeepSeek Harness agent.
 * One plugin mounts the process tool, the /ps command family, the process
 * manager over the subprocess seam, and exit/log-match notifications that
 * wake the owning agent. A port of https://github.com/aliou/pi-processes
 * onto DSH's native extension points.
 * @module dsh-processes
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { registerProcessCommands } from './commands.ts'
import { ProcessManager } from './manager.ts'
import { processesProjectionUnit } from './projection.ts'
import { NotificationService } from './notifications.ts'
import { registerProcessTool } from './tool.ts'
import type { ResolvedProcessConfig } from './types.ts'

export const name = 'processes'
export const inject = ['tools', 'commands', 'subprocess', 'systemPrompt']

/** Deployment configuration for the processes plugin. */
export interface Config {
  /** Shell executable override; a bare name resolves through PATH. */
  shellPath?: string
  /** Shell arguments preceding the command; default ['-c']. */
  shellArgs?: string[]
  /** Per-stream in-memory output cap in bytes; overflow keeps the tail. */
  maxOutputBytes?: number
  /** Per-stream spill-file cap in bytes; larger streams drop the spill. */
  maxSpillBytes?: number
  /** SIGTERM→SIGKILL escalation grace in milliseconds. */
  graceMs?: number
  /** How long stop waits for the tree to exit before reporting a timeout. */
  killTimeoutMs?: number
  /** Notification scan interval in milliseconds. */
  pollIntervalMs?: number
  /** Upper bound on managed processes; overflow starts fail loud. */
  maxProcesses?: number
}

/** Runtime configuration schema for the processes plugin. */
export const Config: z<Config> = z.object({
  shellPath: z.string(),
  shellArgs: z.array(z.string()).default(['-c']),
  maxOutputBytes: z.number().default(64 * 1024),
  maxSpillBytes: z.number().default(64 * 1024 * 1024),
  graceMs: z.number().default(3_000),
  killTimeoutMs: z.number().default(10_000),
  pollIntervalMs: z.number().default(500),
  maxProcesses: z.number().default(50),
})

/**
 * Fill the defaults the Loader would apply for direct apply() callers and
 * validate the numeric bounds the schema cannot express.
 * @param config - raw plugin configuration.
 * @returns the resolved configuration.
 */
export function resolveConfig(config: Config): ResolvedProcessConfig {
  const resolved: ResolvedProcessConfig = {
    shellArgs: config.shellArgs ?? ['-c'],
    maxOutputBytes: config.maxOutputBytes ?? 64 * 1024,
    maxSpillBytes: config.maxSpillBytes ?? 64 * 1024 * 1024,
    graceMs: config.graceMs ?? 3_000,
    killTimeoutMs: config.killTimeoutMs ?? 10_000,
    pollIntervalMs: config.pollIntervalMs ?? 500,
    maxProcesses: config.maxProcesses ?? 50,
  }
  if (config.shellPath !== undefined) resolved.shellPath = config.shellPath
  assertServiceableConfig(resolved)
  return resolved
}

/**
 * Reject a configuration this plugin cannot run with. The schema expresses
 * neither positive-and-finite nor the timer bound graceMs must fit, so a
 * stored value is refused where it is written.
 * @param config - the resolved configuration.
 * @throws Error naming the field that cannot be used.
 */
function assertServiceableConfig(config: ResolvedProcessConfig): void {
  for (const field of ['maxOutputBytes', 'maxSpillBytes', 'graceMs', 'killTimeoutMs', 'pollIntervalMs', 'maxProcesses'] as const) {
    const value = config[field]
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error('processes: ' + field + ' must be a positive finite number')
    }
  }
  if (config.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error('processes: graceMs must be no greater than ' + MAX_TIMER_DELAY_MS)
  }
  if (config.shellPath !== undefined && config.shellPath.length === 0) {
    throw new Error('processes: shellPath must be a non-empty absolute path or bare name')
  }
}

/** Cross-call guidance shown to the model with the other tool sections. */
const PROMPT_SECTION =
  'Long-running commands should run through the process tool: start a dev server, '
  + 'test watcher, or local API in the background and keep working. Read its output '
  + 'with action: output, stop it with action: stop, and expect a notification when '
  + 'it exits or its output matches a watch pattern. Check the process list before '
  + 'assuming a command is still running.'

/**
 * Mount the processes plugin: manager, notifications, tool, commands, and the
 * prompt section. Composition teardown stops the poll loop and terminates
 * every live process tree.
 * @param ctx - the registrant context.
 * @param config - deployment configuration (schemastery defaults pre-applied by the Loader).
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const manager = new ProcessManager(ctx, resolved)
  const notifications = new NotificationService(ctx, manager, resolved)
  notifications.start()
  ctx.systemPrompt.section({
    name: 'tool:processes',
    order: 110,
    text: PROMPT_SECTION,
  })
  registerProcessTool(ctx, manager)
  registerProcessCommands(ctx, manager)
  // The browser dock reads the processes projection; headless assemblies that
  // omit the projection registry are unaffected (optional inject).
  ctx.inject(['sessionProjections'], projectionCtx => {
    projectionCtx.sessionProjections.register<'processes', Parameters<typeof processesProjectionUnit.apply>[0]>(
      processesProjectionUnit,
    )
  })
  ctx.effect(() => () => {
    notifications.stop()
    manager.dispose()
  }, 'processes teardown')
}