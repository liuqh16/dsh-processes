/**
 * Human-facing slash commands for dsh-processes: /ps lists processes with
 * output previews, /ps-kill stops one, /ps-logs prints recent output, and
 * /ps-clear removes finished entries. Command names follow DSH's
 * [a-z0-9_-] grammar, so pi-processes' colon forms map to hyphens
 * (/ps:kill → /ps-kill).
 * @module dsh-processes/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { ProcessManager } from './manager.ts'
import { renderCommandList, renderExitTail, renderOutput, renderProcessRow } from './render.ts'

/** Preview lines shown per process by /ps. */
const PREVIEW_LINES = 6

/** Command handlers execute directly against the manager, never via the model. */
export function registerProcessCommands(ctx: Context, manager: ProcessManager): void {
  ctx.commands.register({
    name: 'ps',
    description: 'List managed background processes with status and recent output.',
    handler: () => {
      const infos = manager.list({})
      const rows = infos.map(info => {
        const preview = manager.output(info.id, 'both', PREVIEW_LINES, undefined, 'literal')
        const parts = [preview.stdout?.text ?? '', preview.stderr?.text ?? '']
        return { info, preview: parts.filter(part => part.length > 0).join('\n') }
      })
      return { kind: 'success', text: renderCommandList(rows) }
    },
  })

  ctx.commands.register({
    name: 'ps-kill',
    description: 'Stop a running background process by id.',
    input: { hint: '<id>' },
    handler: async ({ rawInput }): Promise<CommandResult> => {
      const id = rawInput.trim()
      if (id.length === 0) {
        return { kind: 'error', text: 'Usage: /ps-kill <id> — see /ps for running ids.' }
      }
      try {
        const result = await manager.stop(id, manager.getConfig().killTimeoutMs)
        return {
          kind: 'success',
          text: 'Stopped ' + renderProcessRow(result.process) + '  [' + renderExitTail(result.process) + ']',
        }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  ctx.commands.register({
    name: 'ps-logs',
    description: 'Show recent output of one process.',
    input: { hint: '<id>' },
    handler: ({ rawInput }): CommandResult => {
      const id = rawInput.trim()
      if (id.length === 0) {
        return { kind: 'error', text: 'Usage: /ps-logs <id> — see /ps for process ids.' }
      }
      try {
        const info = manager.infoOf(id)
        const result = manager.output(id, 'both', 200, undefined, 'literal')
        return { kind: 'success', text: renderOutput(info, result) }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  ctx.commands.register({
    name: 'ps-clear',
    description: 'Remove finished processes and free their retained output.',
    handler: (): CommandResult => {
      const removed = manager.clear()
      return { kind: 'success', text: 'Cleared ' + removed + ' finished process' + (removed === 1 ? '' : 'es') }
    },
  })
}

