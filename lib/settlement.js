/**
 * Final continuable-worker failure diagnostics for the supervisor.
 *
 * The native settlement notice is the authoritative wake: it is delivered
 * only after the child Activation is quiescent, including any request retries.
 * This plugin enriches that one claimed message from the child's durable final
 * `turn/end`; it never observes or reports intermediate request failures.
 */

const FAILURE_DETAIL_MAX_CHARS = 2048
const FAILURE_PREFIX = 'Terminal failure ['

/** Find when the native settlement message entered the parent's durable inbox. */
function settlementNoticeTime(events, messageId) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'agent/inbox/spliced') continue
    if (event.data?.inserted?.some(message => message.id === messageId)) return event.time
  }
  return undefined
}

/**
 * Return the final durable failure for the Activation that produced a notice.
 * A later successful turn wins earlier retry attempts, and the last
 * `session/end-seed` prevents a resumed child from inheriting an older error.
 */
export function terminalFailureAt(events, notAfter) {
  let terminal
  for (const event of events) {
    if (event.time > notAfter) continue
    if (event.type === 'session/end-seed') {
      terminal = undefined
      continue
    }
    if (event.type === 'turn/end') terminal = event.data.reason
  }
  return terminal?.kind === 'error' ? terminal.error : undefined
}

/** Render bounded model-facing failure detail from the logged provider facts. */
export function renderTerminalFailure(failure) {
  const status = failure.status === undefined ? '' : `; HTTP ${failure.status}`
  const prefix = `${FAILURE_PREFIX}${failure.code}${status}]: `
  const available = Math.max(0, FAILURE_DETAIL_MAX_CHARS - prefix.length)
  const message = failure.message.length <= available
    ? failure.message
    : `${failure.message.slice(0, Math.max(0, available - 1))}…`
  return `${prefix}${message}`
}

function alreadyEnriched(message) {
  return message.content.some(block => block.type === 'text' && block.text.startsWith(FAILURE_PREFIX))
}

function withDiagnostic(message, text) {
  const diagnostic = Object.freeze({ type: 'text', text })
  const [summary, ...rest] = message.content
  const content = Object.freeze(summary === undefined
    ? [diagnostic]
    : [summary, diagnostic, ...rest])
  return Object.freeze({ ...message, content })
}

/**
 * Enrich accepted settlement messages without changing their identity or wake.
 * Inspection is fail-open: the generic native notice remains useful when its
 * child log is unavailable.
 */
export async function enrichSettlementMessages(persistence, parent, messages, signal, logger) {
  const rewritten = await Promise.all(messages.map(async (message) => {
    const source = message.source
    if (source?.kind !== 'subagent-settled' || alreadyEnriched(message)) return message
    const noticeTime = settlementNoticeTime(parent.session.events, message.id)
    if (noticeTime === undefined) return message
    try {
      const child = await persistence.inspect(source.senderSessionId, signal)
      signal.throwIfAborted()
      const failure = terminalFailureAt(child.events, noticeTime)
      return failure === undefined ? message : withDiagnostic(message, renderTerminalFailure(failure))
    } catch (error) {
      if (signal.aborted) throw error
      logger.warn(
        `dsh-supervisor: could not inspect settled subagent "${source.senderSessionId}"; `
        + `delivering the native notice unchanged: ${error?.message ?? error}`,
      )
      return message
    }
  }))
  return rewritten.every((message, index) => message === messages[index]) ? messages : rewritten
}

/** Register the cooperative pre-step enrichment on this supervisor scope. */
export function installSettlementDiagnostics(ctx) {
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    if (!messages.some(message => message.source?.kind === 'subagent-settled')) return next()
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) return decision
    return {
      ...decision,
      messages: await enrichSettlementMessages(
        persistence,
        agent,
        decision.messages,
        signal,
        ctx.logger,
      ),
    }
  })
}
