/** The `processes` locale namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'processes'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'dock.aria': '后台进程',
  'dock.running': '{count} 个进程运行中',
  'dock.none': '无后台进程',
  'panel.title': '后台进程',
  'process.status.running': '运行中',
  'process.status.terminating': '停止中',
  'process.status.finished': '已结束',
  'process.status.failed': '已失败',
  'process.status.killed': '已终止',
  'process.status.terminate_timeout': '停止超时',
  'process.notify': '最近通知：{text}',
  'process.noNotify': '无通知',
  'process.empty': '尚未启动后台进程。用 process 工具（action: start）启动。',
  'panel.close': '收起',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<ProcessesKey, string> = {
  'dock.aria': 'Background processes',
  'dock.running': '{count} process(es) running',
  'dock.none': 'No background processes',
  'panel.title': 'Background processes',
  'process.status.running': 'running',
  'process.status.terminating': 'stopping',
  'process.status.finished': 'finished',
  'process.status.failed': 'failed',
  'process.status.killed': 'terminated',
  'process.status.terminate_timeout': 'stop timed out',
  'process.notify': 'Latest: {text}',
  'process.noNotify': 'No notifications',
  'process.empty': 'No background processes yet. Start one with the process tool (action: start).',
  'panel.close': 'Collapse',
}

/** Key domain of the `processes` namespace (zh is the source of truth). */
export type ProcessesKey = keyof typeof zh

