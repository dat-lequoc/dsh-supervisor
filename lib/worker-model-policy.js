/**
 * Pure worker-model policy helpers shared by the guarded subagent tool and its
 * dependency-free tests.
 */

/** Settings/tool sentinel for explicitly following the calling turn's route. */
export const RUNTIME_MODEL_KEY = 'runtime/current'

/** Canonical `provider/model-id` key for one resolved catalog entry. */
export function workerModelKey(entry) {
  return `${entry.provider}/${entry.id}`
}

/** Human-readable route plus native input modalities. */
export function workerModelLabel(entry) {
  if (entry.runtime === true) {
    return `${RUNTIME_MODEL_KEY}  [current turn: model and capabilities resolved at call time]`
  }
  return `${workerModelKey(entry)}  [${entry.modalities.join(',')}]`
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
  return { provider: config.provider, model: config.model }
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
  }
}
