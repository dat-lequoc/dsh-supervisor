/**
 * Full-stop transaction for one live supervisor Agent.
 *
 * Kept free of Harness imports so the concurrency and durability ordering can
 * be exercised without booting a web profile.
 */

/** Wait for the whole Agent to become idle, with a bounded caller wait. */
async function waitForIdle(agent, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      agent.whenIdle().then(() => true, () => false),
      new Promise(resolvePromise => {
        timer = setTimeout(() => resolvePromise(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Resolve the preset a Session actually runs; a logged blank-session switch wins over its creation header. */
export function sessionAgentPreset(session) {
  for (let index = session.events.length - 1; index >= 0; index--) {
    const event = session.events[index]
    if (event?.type === 'agent-preset/selected') return event.data.agentPreset
  }
  return session.header.agentPreset
}

/**
 * Cancel one Agent and delete its active reminders inside an exclusive
 * maintenance phase. The first flush establishes the durable fold being
 * mutated; the second makes every appended delete durable before success.
 *
 * `runMaintenance` throws synchronously only when another activity owns the
 * idle phase. Failures after it accepts the task are transaction outcomes and
 * are never retried as if they were lock contention.
 */
export async function fullStopAgent(
  agent,
  flush,
  foldScheduleEvents,
  { idleTimeoutMs = 15000, maintenanceAttempts = 3 } = {},
) {
  agent.cancel({ kind: 'user' })
  if (!await waitForIdle(agent, idleTimeoutMs)) return { kind: 'idle-timeout' }

  for (let attempt = 0; attempt < maintenanceAttempts; attempt++) {
    let maintenance
    try {
      maintenance = agent.runMaintenance(async () => {
        try {
          await flush(agent.session)
        } catch (error) {
          return { kind: 'preflight-failed', error }
        }

        let folded
        try {
          folded = foldScheduleEvents(
            agent.session.events,
            agent.session.header.seedLength ?? 0,
          )
        } catch (error) {
          return { kind: 'fold-failed', error }
        }

        const ids = folded.active.map(record => record.id)
        const appended = []
        try {
          for (const id of ids) {
            agent.session.append('schedule/change', { version: 1, operation: 'delete', id })
            appended.push(id)
          }
        } catch (error) {
          try {
            await flush(agent.session)
          } catch {
            // The response reports the partial in-memory mutation explicitly.
          }
          return { kind: 'append-failed', ids: appended, error }
        }

        try {
          await flush(agent.session)
        } catch (error) {
          return { kind: 'postflight-failed', ids, error }
        }
        return { kind: 'stopped', ids }
      })
    } catch {
      if (!await waitForIdle(agent, idleTimeoutMs)) return { kind: 'idle-timeout' }
      continue
    }

    try {
      return await maintenance
    } catch (error) {
      return { kind: 'maintenance-failed', error }
    }
  }
  return { kind: 'busy' }
}
