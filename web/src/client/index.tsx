/**
 * dsh-processes web half, browser side: the process dock in the composer
 * input bar, fed entirely by the `processes` session projection (no RPC, no
 * host-side browser state). The dock shows a running-count badge and, when
 * expanded, the session's process list with status and the latest
 * notification text.
 * @module dsh-processes-web/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// The input-dock slot and its owner share are declared (and typed) by
// ui-conversation; importing its client face activates the SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ProcessDock } from './ProcessDock.tsx'
import { en, NS, zh, type ProcessesKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Process dock copy. */
    'processes': ProcessesKey
  }
}

export type { ProcessDockProps } from './ProcessDock.tsx'

/** Required services for locale registration and the dock slot contribution. */
export const inject = ['slots', 'sessions', 'locale']

/**
 * Client plugin body: register the dictionaries and the dock entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-processes-web: dictionaries')
  ctx.slots.inject(
    'conversation.input.dock',
    () => ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'processes',
      // After the goal strip: process work reads as operational state.
      order: 30,
      locale: NS,
    }, ProcessDock),
  )
}
