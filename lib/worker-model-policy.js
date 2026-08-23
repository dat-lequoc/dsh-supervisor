/**
 * Pure worker-model policy helpers shared by the guarded subagent tool and its
 * dependency-free tests.
 */

/** Canonical `provider/model-id` key for one resolved catalog entry. */
export function workerModelKey(entry) {
  return `${entry.provider}/${entry.id}`
}

/** Human-readable route plus native input modalities. */
export function workerModelLabel(entry) {
  return `${workerModelKey(entry)}  [${entry.modalities.join(',')}]`
}

/**
 * Resolve an exact settings-owned route. Bare ids and implicit inheritance are
 * deliberately unsupported: the tool call must visibly carry the route that
 * the user approved.
 */
export function selectWorkerModel(value, allowlist) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      'model is required — choose one provider/model route from Settings -> Plugins -> dsh-supervisor',
    )
  }
  const selected = allowlist.find(entry => value === workerModelKey(entry))
  if (selected === undefined) {
    if (allowlist.length === 0) {
      throw new Error(
        'the user allows no worker models — add one in Settings -> Plugins -> dsh-supervisor before spawning',
      )
    }
    throw new Error(
      `model "${value}" is not on the user's worker allowlist — allowed:\n`
      + allowlist.map(workerModelLabel).join('\n'),
    )
  }
  return {
    key: workerModelKey(selected),
    provider: selected.provider,
    model: selected.id,
    modalities: [...selected.modalities],
  }
}
