/**
 * The process dock: a compact strip in the composer input bar showing the
 * session's live process count, expandable to the process list with status
 * and the latest notification text. Data arrives entirely through the
 * `processes` session projection, so the component holds no state beyond
 * its own expanded/collapsed flag.
 * @module dsh-processes-web/client/ProcessDock
 */

import { useState, type ReactElement } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProcessProjectionEntry, ProcessesProjection } from '../../../src/types.ts'
import type { ProcessesKey } from './locales.ts'

/** Full props of the dock entry: framework standard kit + the locale seat. */
export type ProcessDockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'processes'>

/** Localized status copy for one projected process. */
const STATUS_KEY: Record<ProcessProjectionEntry['status'], ProcessesKey> = {
  running: 'process.status.running',
  terminating: 'process.status.terminating',
  finished: 'process.status.finished',
  failed: 'process.status.failed',
  killed: 'process.status.killed',
  terminate_timeout: 'process.status.terminate_timeout',
}

/** Inline styles: the dock keeps zero CSS-module build dependencies. */
const styles = {
  strip: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    height: 32,
    padding: '0 12px',
    margin: '0 auto',
    maxWidth: 720,
    boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-specific-tip)',
    borderRadius: 10,
    cursor: 'pointer',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: 13,
  },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontWeight: 600,
  },
  caret: {
    marginLeft: 'auto',
    color: 'var(--dsw-alias-label-tertiary)',
  },
  panel: {
    margin: '0 auto',
    maxWidth: 720,
    boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-base)',
    borderRadius: 10,
    marginTop: 4,
    padding: 8,
    fontSize: 13,
    maxHeight: 280,
    overflowY: 'auto',
  },
  row: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
    padding: '5px 8px',
    borderRadius: 6,
  },
  name: {
    fontWeight: 600,
    color: 'var(--dsw-alias-label-primary)',
    whiteSpace: 'nowrap',
  },
  command: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--dsw-alias-label-tertiary)',
  },
  status: {
    flex: 'none',
    color: 'var(--dsw-alias-label-secondary)',
  },
  notify: {
    color: 'var(--dsw-alias-label-caption)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: 260,
  },
  empty: {
    padding: '8px',
    color: 'var(--dsw-alias-label-caption)',
  },
} as const

/** One process row: name, command, localized status, and the latest notification. */
function ProcessRow({ entry, t }: { entry: ProcessProjectionEntry; t: ProcessDockProps['t'] }): ReactElement {
  const status = t(STATUS_KEY[entry.status])
  const exit = entry.status === 'finished' || entry.status === 'failed'
    ? ' ' + (entry.exitCode === null ? '' : 'exit ' + entry.exitCode)
    : entry.exitSignal === null ? '' : ' ' + entry.exitSignal
  const notify = entry.lastNotify === null ? t('process.noNotify') : t('process.notify', { text: entry.lastNotify })
  return (
    <div style={styles.row} title={entry.command}>
      <span style={styles.name}>{entry.name}</span>
      <span style={styles.command}>{entry.command}</span>
      <span style={styles.status}>{status}{exit}</span>
      <span style={styles.notify}>{notify}</span>
    </div>
  )
}

/**
 * Dock adapter: reads the host-computed `processes` projection; renders
 * nothing for sessions with no process activity.
 */
export function ProcessDock({ useProjection, t }: ProcessDockProps): ReactElement | null {
  const projection = useProjection('processes') as ProcessesProjection | undefined
  const [open, setOpen] = useState(false)
  if (projection === undefined || projection.processes.length === 0) return null
  const { processes, running } = projection
  const label = running === 0 ? t('dock.none') : t('dock.running', { count: String(running) })
  return (
    <div role="group" aria-label={t('dock.aria')}>
      <div
        style={styles.strip}
        role="button"
        aria-expanded={open}
        tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(!open) } }}
      >
        <span style={styles.badge}>{label}</span>
        <span style={styles.caret}>{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div style={styles.panel}>
          <div style={{ ...styles.row, fontWeight: 600 }}>{t('panel.title')}</div>
          {processes.map(entry => <ProcessRow key={entry.id} entry={entry} t={t} />)}
          {processes.length === 0 && <div style={styles.empty}>{t('process.empty')}</div>}
        </div>
      )}
    </div>
  )
}