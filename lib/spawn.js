/**
 * dsh-supervisor — settings-guarded worker `subagent` tool.
 *
 * A preset-row plugin (mounted from agent-presets/main-agent/agent.cordis.yml
 * as `name: dsh-supervisor/spawn`) that replaces the pinned
 * `@deepseek-ai/dsh-tool-subagent` dev row with a MODEL-GENERIC one: a
 * required `model` argument selects the worker's model from the USER-owned
 * settings allowlist. Fixed routes are annotated with native input modalities
 * (`[text]` / `[text,image]`); the explicit `runtime/current` choice resolves
 * the calling turn's captured route and capabilities at execution time.
 *
 * META-CONFIG (live): when the host half's `supervisorSettings` service is
 * present (bundle install), the allowlist and `maxParallelWorkers` come from
 * the user's settings (`~/.dsh/settings.yaml` `dsh-supervisor:` block, or the
 * web UI Settings → Plugins card) and are read at EVERY tool call, so edits
 * apply mid-session with no restart. A live system-prompt section renders the
 * current values into each request. There is deliberately no preset fallback
 * or implicit parent-model inheritance: an empty allowlist exposes no tool.
 *
 * Everything else mirrors the shipped tool: continuable background children
 * through `ctx.subagents.startContinuable` (the native provider `spawn`),
 * per-row worker persona, foreground fallback via `run_in_background: false`.
 * The child model rides `SubagentRequest.agentOptions` — a per-request field
 * the service always supported; only the shipped tool's config hid it.
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installSettlementDiagnostics } from './settlement.js'
import {
  currentRuntimeModel,
  RUNTIME_MODEL_KEY,
  selectWorkerModel,
  workerModelKey,
  workerModelLabel,
} from './worker-model-policy.js'

export const name = 'dsh-supervisor-spawn'
export const inject = ['tools', 'subagents', 'llm', 'systemPrompt']

/** Prompt order near the shipped delegation guidance. */
const META_SECTION_ORDER = 116.7

export const Config = z.object({
  /** The `ctx.subagents` provider to start children on. */
  provider: z.string().default('spawn'),
  /** Model-facing tool name. */
  toolName: z.string().default('subagent'),
  /** Per-child persona (the invariant worker protocol). */
  persona: z.string(),
  /** Child recursion cap, forwarded per request. */
  maxDepth: z.natural().default(3),
})

/**
 * Resolve the user's allowlist against the native catalog. Fixed entries keep
 * their `provider/model-id` spelling and gain native input modalities;
 * `runtime/current` stays synthetic until execution has a calling turn.
 * A malformed or unresolvable entry is skipped with a warning. The tool stays
 * available when at least one route resolves; if none resolve, spawning is
 * disabled rather than falling through to an unapproved route.
 */
async function resolveAllowlist(ctx, models) {
  const entries = []
  const seen = new Set()
  for (const value of models) {
    if (seen.has(value)) continue
    seen.add(value)
    if (value === RUNTIME_MODEL_KEY) {
      entries.push({
        provider: 'runtime',
        id: 'current',
        modalities: [],
        runtime: true,
      })
      continue
    }
    const slash = value.indexOf('/')
    if (slash <= 0 || slash === value.length - 1) {
      ctx.logger.warn(`dsh-supervisor-spawn: models entry "${value}" is not provider/model-id — skipped`)
      continue
    }
    const provider = value.slice(0, slash)
    const id = value.slice(slash + 1)
    try {
      const info = await ctx.llm.resolveModelInfo(provider, id)
      entries.push({ provider, id, modalities: info.inputModalities ?? ['text'] })
    } catch (error) {
      ctx.logger.warn(`dsh-supervisor-spawn: models entry "${value}" did not resolve (${error?.message ?? error}) — skipped`)
    }
  }
  return entries
}

export async function apply(ctx, config) {
  const provider = config.provider ?? 'spawn'
  const toolName = config.toolName ?? 'subagent'

  installSettlementDiagnostics(ctx)

  // The settings namespace is the sole routing authority. There is no preset
  // fallback or implicit parent-model inheritance. runtime/current is an
  // explicit allowed value; an empty/missing list means no worker may start.
  const meta = () => ctx.get('supervisorSettings')?.current()
  const configuredModels = () => {
    const configured = meta()?.workerModels
    return Array.isArray(configured) ? configured : []
  }

  // Cap ledger: children this fiber started that have not yet been SEEN
  // active. `listChildren` reports `activity: 'inactive'` both before a child's
  // first turn and after its last, so a freshly spawned worker is invisible to
  // a plain active-count — two same-turn spawns would both see zero. The
  // ledger bridges that gap: an entry counts as an open worker until the child
  // has been observed active and gone inactive again (ran and settled), or
  // never activates within a generous window (startup failure).
  const startingLedger = new Map()
  const LEDGER_STALE_MS = 15 * 60 * 1000

  const openWorkerCount = (children) => {
    const byId = new Map(children.filter(entry => entry.kind === 'child').map(entry => [entry.id, entry]))
    const now = Date.now()
    for (const [childId, state] of startingLedger) {
      const entry = byId.get(childId)
      const active = entry?.activity === 'active'
      if (active) state.wasActive = true
      else if (state.wasActive || now - state.startedAt > LEDGER_STALE_MS) startingLedger.delete(childId)
    }
    const activeCount = children.filter(entry => entry.kind === 'child' && entry.activity === 'active').length
    const startingCount = [...startingLedger.keys()]
      .filter(childId => byId.get(childId)?.activity !== 'active').length
    return activeCount + startingCount
  }

  let allowlistCache = []
  let cachedKey
  let disposeTool
  let providerAvailable = ctx.subagents.getProvider(provider) !== undefined

  /** Register one schema snapshot containing only the currently allowed routes. */
  const mount = () => {
    const allowed = allowlistCache.map(entry => ({
      provider: entry.provider,
      id: entry.id,
      modalities: [...entry.modalities],
      ...entry.runtime === true ? { runtime: true } : {},
    }))
    const allowedRows = allowed.map(workerModelLabel).join('\n')
    disposeTool = ctx.tools.register(defineTool({
      name: toolName,
      description:
        'Start a worker agent in a fresh context (it does not see this conversation; the prompt must be '
        + 'a complete standalone task). Runs in the background by default and immediately returns a durable '
        + 'subagent id; when the run settles you receive a notice with its outcome, and `send_message` '
        + 'continues the same child conversation, joining a running turn at the next step. '
        + 'The required `model` argument must be one exact choice from the user-owned worker allowlist; no '
        + 'implicit default or parent model is inherited. `runtime/current`, when enabled, explicitly follows '
        + 'the route captured for this calling turn. Native input modalities are shown beside fixed routes '
        + '(pick a [text,image] model only when the worker must inspect images). '
        + `Allowed worker models:\n${allowedRows}`,
      parameters: {
        description: {
          type: 'string',
          required: true,
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          required: true,
          description: 'The complete standalone task (Role / Objective / Scope / Context pointers / Protocol / Constraints).',
        },
        model: {
          type: 'string',
          required: true,
          enum: allowed.map(workerModelKey),
          description: `Required worker choice. Only settings-approved entries are accepted:\n${allowedRows}`,
        },
        run_in_background: {
          type: 'boolean',
          description: 'Defaults to true (durable background child). Set false to wait for the result when your next action depends on it.',
        },
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'continuable' },
                subagentId: { type: 'string', required: true },
                model: { type: 'string', required: true },
                modalities: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'foreground' },
                output: { type: 'array', required: true, items: { type: 'json' } },
                model: { type: 'string', required: true },
                modalities: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          ],
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.kind === 'continuable'
            ? `started subagent ${value.subagentId} on ${value.model} [${value.modalities.join(',')}]`
            : `subagent completed on ${value.model} [${value.modalities.join(',')}]\n\n${value.output
                .filter(block => typeof block === 'object' && block !== null && block.type === 'text')
                .map(block => block.text)
                .join('')}`,
        }],
      },
      // Deliberately NOT concurrency-safe: spawn bodies serialize so the cap
      // check of a second same-step call observes the first call's ledger entry.
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const parent = exec.agent
        if (!parent) throw new Error(`${toolName} requires a calling agent`)

        // Re-read settings at execution time. A schema captured one step ago
        // cannot authorize a model the user removed before this call executes.
        await refreshAllowlist()
        const policySelection = selectWorkerModel(args.model, allowlistCache)
        let selected = policySelection
        if (policySelection.runtime === true) {
          const route = currentRuntimeModel(parent)
          const info = await ctx.llm.resolveModelInfo(route.provider, route.model, exec.signal)
          selected = {
            key: `${route.provider}/${route.model}`,
            provider: route.provider,
            model: route.model,
            modalities: info.inputModalities ?? ['text'],
          }
        }

        // Enforce the LIVE parallel cap (0 = unlimited): active children plus
        // our own still-starting spawns, read at call time so a settings edit
        // applies to the very next spawn.
        const cap = meta()?.maxParallelWorkers ?? 0
        if (cap > 0) {
          const children = await ctx.subagents.listChildren(parent.id, exec.signal)
          const open = openWorkerCount(children)
          if (open >= cap) {
            throw new Error(
              `parallel-worker cap reached: ${open} worker(s) already open, the user's cap is ${cap} `
              + '(SUPERVISOR META-CONFIG). Wait for a settle notice, or interrupt_agent a worker you no longer need, '
              + 'then spawn again.',
            )
          }
        }

        const request = {
          label: args.description,
          prompt: [{ type: 'text', text: args.prompt }],
          parent,
          maxDepth: config.maxDepth ?? 3,
          agentOptions: { provider: selected.provider, model: selected.model },
          ...config.persona !== undefined ? { persona: config.persona } : {},
        }
        if (args.run_in_background !== false) {
          const started = await ctx.subagents.startContinuable({
            provider,
            label: args.description,
            request,
            signal: exec.signal,
          })
          startingLedger.set(started.childId, { wasActive: false, startedAt: Date.now() })
          return {
            kind: 'continuable',
            subagentId: started.childId,
            model: selected.key,
            modalities: selected.modalities,
          }
        }
        const run = await ctx.subagents.start(provider, { ...request, signal: exec.signal })
        try {
          const result = await run.result
          if (result.stopReason !== 'completed') {
            const partial = result.output
              .filter(block => block.type === 'text')
              .map(block => block.text)
              .join('')
            throw new Error(`subagent run ended abnormally (${String(result.stopReason)})`
              + (partial === '' ? '' : `\nPartial output before the run ended:\n${partial}`))
          }
          return {
            kind: 'foreground',
            output: result.output,
            model: selected.key,
            modalities: selected.modalities,
          }
        } finally {
          await run.dispose()
        }
      },
    }))
  }

  /** Keep registration aligned with both provider and settings availability. */
  const reconcileTool = () => {
    if (disposeTool !== undefined) {
      disposeTool()
      disposeTool = undefined
    }
    if (providerAvailable && allowlistCache.length > 0) mount()
  }

  // Serialize async catalog resolution. A settings edit remounts the tool so
  // the very next request's JSON schema contains the current enum and modality
  // labels, while execute() still performs authoritative current-state checks.
  let refreshChain = Promise.resolve()
  const refreshAllowlist = () => {
    refreshChain = refreshChain.then(async () => {
      const models = configuredModels()
      const key = JSON.stringify(models)
      if (key === cachedKey) return
      const resolved = await resolveAllowlist(ctx, models)
      cachedKey = key
      allowlistCache = resolved
      reconcileTool()
    })
    return refreshChain
  }

  // Live meta-config section: re-rendered on every request. It states the hard
  // policy even when the empty allowlist intentionally leaves no spawn tool.
  ctx.systemPrompt.section({
    name: `meta:${toolName}`,
    order: META_SECTION_ORDER,
    text: () => {
      const current = meta()
      const cap = current?.maxParallelWorkers ?? 0
      const lines = [
        'SUPERVISOR META-CONFIG (user-owned; Settings -> Plugins -> dsh-supervisor, or the dsh-supervisor: block in ~/.dsh/settings.yaml; may change while you run — this section always shows the current values):',
        allowlistCache.length > 0
          ? `- ${toolName} requires one exact \`model\` choice from this complete worker allowlist; there is no implicit default inheritance. \`${RUNTIME_MODEL_KEY}\`, when present, resolves to this calling turn's captured route:\n${allowlistCache.map(entry => `    ${workerModelLabel(entry)}`).join('\n')}`
          : `- Worker spawning is disabled: no models are allowed. The user must add ${RUNTIME_MODEL_KEY} or a fixed route in Settings -> Plugins -> dsh-supervisor; never use another delegation tool to bypass this policy.`,
        ...providerAvailable ? [] : [`- Worker spawning is unavailable because subagent provider "${provider}" is not registered.`],
        cap > 0
          ? `- Max parallel workers: ${cap} (enforced — a spawn beyond it is refused; wait for a settle or kill a worker).`
          : '- Max parallel workers: unlimited.',
        '- `send_message` to a running worker joins its current turn at the next step (it does not wait for the turn to finish). An idle worker starts a later turn. Use `interrupt_agent` first only when the current turn must stop immediately.',
        ...current === undefined ? [] : [
          `- Timing defaults: wakeMinutes=${current.wakeMinutes} (how often you wake to inspect workers; recurring schedule, minutes), questionWaitMinutes=${current.questionWaitMinutes} (how long you wait on a question before recording an assumption and continuing). A workspace's .agi/config.json overrides them when it carries the key.`,
        ],
      ]
      return lines.join('\n')
    },
  })

  // Mirror provider lifecycle (sibling load order can register `spawn` later).
  ctx.on('subagent/provider-added', (added) => {
    if (added.name !== provider) return
    providerAvailable = true
    reconcileTool()
  })
  ctx.on('subagent/provider-removed', (removed) => {
    if (removed !== provider) return
    providerAvailable = false
    reconcileTool()
  })
  if (!providerAvailable) {
    ctx.logger.info(`dsh-supervisor-spawn: provider "${provider}" not registered yet; "${toolName}" will register when it appears`)
  }

  await refreshAllowlist()
  const unsubscribe = ctx.get('supervisorSettings')?.subscribe(() => {
    void refreshAllowlist().catch(error => {
      ctx.logger.warn(`dsh-supervisor-spawn: failed to refresh worker models (${error?.message ?? error})`)
    })
  })
  if (unsubscribe !== undefined) ctx.effect(() => unsubscribe)
}
