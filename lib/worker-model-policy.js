/**
 * Pure worker-model policy helpers shared by the guarded subagent tool and its
 * dependency-free tests.
 */

/** Settings/tool sentinel for explicitly following the calling turn's route. */
export const RUNTIME_MODEL_KEY = 'runtime/current'

/** Settings sentinel that copies the explicit effort on the calling turn. */
export const WORKER_EFFORT_CURRENT = 'runtime/current'

/** Settings sentinel that omits an effort and lets the adapter/provider decide. */
export const WORKER_EFFORT_PROVIDER_DEFAULT = 'provider/default'

/**
 * Global tools that must never enter a supervisor worker's catalog.
 *
 * A child-local ask_user_question waits inside the worker session and emits no
 * subagent-report wakeup. The native continuable `report` tool is registered
 * in child scope after global restrictions, so it remains the sole upward
 * question and progress channel.
 */
export const WORKER_DENIED_TOOLS = Object.freeze([
  'ask_user_question',
])

/** Return a fresh restriction object for the durable SubagentRequest. */
export function workerToolFilter() {
  return { deny: [...WORKER_DENIED_TOOLS] }
}

/** Canonical `provider/model-id` key for one resolved catalog entry. */
export function workerModelKey(entry) {
  return `${entry.provider}/${entry.id}`
}

/** Human-readable route plus native input modalities. */
export function workerModelLabel(entry) {
  if (entry.runtime === true) {
    return `${RUNTIME_MODEL_KEY}  [current turn: model and capabilities resolved at call time]`
  }
  const efforts = entry.reasoning?.efforts?.map(effort => effort.id) ?? []
  const effortLabel = efforts.length === 0 ? '' : `; effort ${efforts.join('/')}`
  return `${workerModelKey(entry)}  [${entry.modalities.join(',')}${effortLabel}]`
}

/**
 * Read the exact route already captured for the request executing this tool.
 * Deliberately do not fall back to `agent.options`: those are creation-time
 * defaults and can be stale after live model selection changes.
 */
export function currentRuntimeModel(agent) {
  const config = agent?.session?.requestHeader?.()?.config
  if (typeof config?.provider !== 'string' || config.provider.length === 0
    || typeof config?.model !== 'string' || config.model.length === 0) {
    throw new Error(
      'the current runtime model route is unavailable — runtime/current never falls back to the session-creation model',
    )
  }
  return {
    provider: config.provider,
    model: config.model,
    ...typeof config.reasoningEffort === 'string' && config.reasoningEffort.length > 0
      ? { reasoningEffort: config.reasoningEffort }
      : {},
  }
}

/** Detach native reasoning metadata before it enters a tool schema snapshot. */
export function workerReasoningInfo(reasoning) {
  if (!Array.isArray(reasoning?.efforts)) return undefined
  return {
    efforts: reasoning.efforts
      .filter(effort => typeof effort?.id === 'string' && effort.id.length > 0)
      .map(effort => ({
        id: effort.id,
        name: typeof effort.name === 'string' && effort.name.length > 0 ? effort.name : effort.id,
        ...typeof effort.description === 'string' && effort.description.length > 0
          ? { description: effort.description }
          : {},
      })),
    ...typeof reasoning.defaultEffort === 'string' && reasoning.defaultEffort.length > 0
      ? { defaultEffort: reasoning.defaultEffort }
      : {},
  }
}

/** Human-readable label for the live effort policy injected into the prompt. */
export function workerEffortPolicyLabel(policy) {
  if (policy === WORKER_EFFORT_CURRENT) return `${policy} (same as current main turn)`
  if (policy === WORKER_EFFORT_PROVIDER_DEFAULT) return `${policy} (adapter/provider decides)`
  return policy
}

/**
 * Resolve and validate the user-owned effort policy for one selected worker
 * route. A fixed or inherited value must be advertised by that exact model;
 * omission is the only representation of provider default.
 */
export function resolveWorkerEffort(policy, currentRoute, selected) {
  const configured = typeof policy === 'string' && policy.length > 0
    ? policy
    : WORKER_EFFORT_CURRENT
  let effort
  let label
  if (configured === WORKER_EFFORT_PROVIDER_DEFAULT) {
    label = WORKER_EFFORT_PROVIDER_DEFAULT
  } else if (configured === WORKER_EFFORT_CURRENT) {
    effort = currentRoute?.reasoningEffort
    label = effort === undefined
      ? `${WORKER_EFFORT_PROVIDER_DEFAULT} (current turn has no explicit effort)`
      : `${effort} (same as current main turn)`
  } else {
    effort = configured
    label = configured
  }

  if (effort !== undefined) {
    const supported = selected.reasoning?.efforts?.map(entry => entry.id) ?? []
    if (!supported.includes(effort)) {
      throw new Error(
        `worker effort "${effort}" is not supported by ${selected.key} — `
        + (supported.length === 0
          ? 'that model advertises no selectable reasoning efforts; use provider/default'
          : `supported: ${supported.join(', ')}`),
      )
    }
  }

  return {
    policy: configured,
    label,
    ...effort === undefined ? {} : { reasoningEffort: effort },
  }
}

/**
 * Resolve an exact settings-owned route. Bare ids and implicit inheritance are
 * deliberately unsupported: the tool call must visibly carry the route that
 * the user approved.
 */
export function selectWorkerModel(value, allowlist) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      'model is required — choose one entry from Settings -> Plugins -> dsh-supervisor',
    )
  }
  const selected = allowlist.find(entry => value === workerModelKey(entry))
  if (selected === undefined) {
    if (allowlist.length === 0) {
      throw new Error(
        'the user allows no worker models — add runtime/current or a fixed route in Settings -> Plugins -> dsh-supervisor before spawning',
      )
    }
    throw new Error(
      `model "${value}" is not on the user's worker allowlist — allowed:\n`
      + allowlist.map(workerModelLabel).join('\n'),
    )
  }
  if (selected.runtime === true) {
    return { key: RUNTIME_MODEL_KEY, runtime: true }
  }
  return {
    key: workerModelKey(selected),
    provider: selected.provider,
    model: selected.id,
    modalities: [...selected.modalities],
    ...selected.reasoning === undefined ? {} : { reasoning: workerReasoningInfo(selected.reasoning) },
  }
}
