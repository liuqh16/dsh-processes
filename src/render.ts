/**
 * Pure render helpers for the process tool and /ps commands: model-facing
 * text built from canonical values only, plus one-line process summaries.
 * @module dsh-processes/render
 */

import type { OutputResult, StopResult } from './manager.ts'
import type { LogMatcher, ProcessInfo } from './types.ts'

/** One-line summary of one process for lists and command output. */
export function renderProcessRow(info: ProcessInfo): string {
  const pid = info.pid === null ? '' : ' pid ' + info.pid
  return info.id + '  ' + info.status.padEnd(16) + '"' + info.name + '"' + pid + '  ' + info.command
}

/** Exit tail for a settled process row. */
export function renderExitTail(info: ProcessInfo): string {
  if (info.status === 'finished') return 'exited ' + String(info.exitCode)
  if (info.status === 'failed') return 'exited ' + String(info.exitCode)
  if (info.status === 'killed') return 'killed' + (info.exitSignal === null ? '' : ' (' + info.exitSignal + ')')
  return info.status
}

/** The `start` action result text. */
export function renderStart(info: ProcessInfo): string {
  const cwd = info.cwd === process.cwd() ? '' : '  cwd: ' + info.cwd
  return 'Started process "' + info.name + '" (' + info.id + '): ' + info.command
    + (info.pid === null ? '' : '  pid ' + info.pid) + cwd
}

/** The `list` action result text. */
export function renderList(infos: ProcessInfo[]): string {
  if (infos.length === 0) return 'No managed processes.'
  return infos.length + ' process' + (infos.length === 1 ? '' : 'es') + ':\n\n'
    + infos.map(info => renderProcessRow(info) + '  [' + renderExitTail(info) + ']').join('\n')
}

/** The `stop` action result text. */
export function renderStop(result: StopResult): string {
  const info = result.process
  if (result.timedOut) {
    return 'Stopped process "' + info.name + '" (' + info.id + '): timed out waiting for exit (still terminating)'
  }
  return 'Stopped process "' + info.name + '" (' + info.id + '): ' + renderExitTail(info)
}

/** The `output` action result text. */
export function renderOutput(info: ProcessInfo, result: OutputResult): string {
  const head = 'Output of "' + info.name + '" (' + info.id + ') [' + result.stream + ', tail ' + result.tailLines + ']'
  const blocks: string[] = [head]
  if (result.stdout !== undefined) {
    blocks.push('stdout:' + (result.stdout.text.length === 0 ? ' (empty)' : '\n' + result.stdout.text + (result.stdout.truncated ? '\n… (truncated)' : '')))
  }
  if (result.stderr !== undefined) {
    blocks.push('stderr:' + (result.stderr.text.length === 0 ? ' (empty)' : '\n' + result.stderr.text + (result.stderr.truncated ? '\n… (truncated)' : '')))
  }
  return blocks.join('\n\n')
}

/** The `write` action result text. */
export function renderWrite(info: ProcessInfo, inputLength: number, end: boolean): string {
  const wrote = inputLength === 0 ? 'Closed stdin of' : 'Wrote ' + inputLength + ' bytes to'
  return wrote + ' process "' + info.name + '" (' + info.id + ')' + (end ? ' and closed stdin' : '')
}

/** The `clear` action result text. */
export function renderClear(removed: number): string {
  return 'Cleared ' + removed + ' finished process' + (removed === 1 ? '' : 'es')
}

/** The `update` action result text. */
export function renderUpdate(info: ProcessInfo, matchers: readonly LogMatcher[]): string {
  return 'Updated watches for "' + info.name + '" (' + info.id + '): ' + matchers.length + ' matcher' + (matchers.length === 1 ? '' : 's') + ' active'
}

/** The /ps command body: rows plus a short output preview per process. */
export function renderCommandList(rows: Array<{ info: ProcessInfo; preview: string }>): string {
  if (rows.length === 0) return 'No managed processes. Start one with the process tool (action: start).'
  const lines = rows.map(({ info, preview }) => {
    const row = renderProcessRow(info) + '  [' + renderExitTail(info) + ']'
    return preview.length === 0 ? row : row + '\n  ' + preview.split('\n').map(line => '  ' + line).join('\n')
  })
  return lines.join('\n\n')
}
