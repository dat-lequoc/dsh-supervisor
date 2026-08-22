/**
 * dsh-supervisor — generic worker spawn tool (`spawn_dev_agent`).
 *
 * A preset-row plugin (mounted from agent-presets/main-agent/agent.cordis.yml
 * as `name: dsh-supervisor/spawn`) that replaces the pinned
 * `@deepseek-ai/dsh-tool-subagent` dev row with a MODEL-GENERIC one: an
 * optional `model` argument selects the worker's model from a USER-owned
 * allowlist, each entry annotated with its native input modalities
 * (`[text]` / `[text,image]`), so the supervisor can see which workers can
 * look at images and choose accordingly — no per-model tool rows.
 *
 * META-CONFIG (live): when the host half's `supervisorSettings` service is
 * present (bundle install), the allowlist and `maxParallelWorkers` come from
 * the user's settings (`~/.dsh/settings.yaml` `dsh-supervisor:` block, or the
 * web UI Settings → Plugins card) and are read at EVERY tool call, so edits
 * apply mid-session with no restart. A live system-prompt section renders the
 * current values into each request. Without the service, the row's own
 * `models:` config is the fallback and no cap is enforced.
 *
 * Everything else mirrors the shipped tool: continuable background children
 * through `ctx.subagents.startContinuable` (the native provider `spawn`),
 * per-row worker persona, foreground fallback via `run_in_background: false`.
 * The child model rides `SubagentRequest.agentOptions` — a per-request field
 * the service always supported; only the shipped tool's config hid it.
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-supervisor-spawn'
export const inject = ['tools', 'subagents', 'llm', 'systemPrompt']

/** Prompt order right after the shipped subagent guidance (116.5). */
const META_SECTION_ORDER = 116.7

export const Config = z.object({
  /** The `ctx.subagents` provider to start children on. */
  provider: z.string().default('spawn'),
  /** Model-facing tool name. */
  toolName: z.string().default('spawn_dev_agent'),
  /** Per-child persona (the invariant worker protocol). */
  persona: z.string(),
  /** Child recursion cap, forwarded per request. */
  maxDepth: z.natural().default(3),
  /**
   * FALLBACK allowlist of worker models (`provider/model-id`), used only when
   * the settings namespace (`dsh-supervisor.workerModels`) is empty or the
   * host half is not installed. Settings win so the UI card stays the single
   * live knob. Empty everywhere means: no `model` accepted, workers always
   * inherit the supervisor's model — the agent never discovers routes the
   * user did not name (models cost money).
   */
  models: z.array(z.string()).default([]),
})

/** Render one catalog row: `zai/glm-5v-turbo  [text,image]`. */
function catalogRow(entry) {
  return `${entry.provider}/${entry.id}  [${entry.modalities.join(',')}]`
}

/**
 * Resolve the user's allowlist against the native catalog: each entry keeps
 * its user-given `provider/model-id` spelling and gains the model's native
 * input modalities (`resolveModelInfo`; absent metadata means text-only).
 * A malformed or unresolvable entry is skipped with a warning — the tool must
 * register even when one route is misspelled or its adapter is down.
 */
async function resolveAllowlist(ctx, models) {
  const entries = []
  for (const value of models) {
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

/**
 * Resolve the tool's `model` argument against the user allowlist.
 * Accepts `provider/model-id` or a bare model id when unambiguous.
 * @returns `{ provider, model }` agent options.
 */
function resolveModelArg(value, allowlist) {
  for (const entry of allowlist) {
    if (value === `${entry.provider}/${entry.id}`) return { provider: entry.provider, model: entry.id }
  }
  const bare = allowlist.filter(entry => entry.id === value)
  if (bare.length === 1) return { provider: bare[0].provider, model: bare[0].id }
  if (bare.length > 1) {
    throw new Error(
      `model "${value}" exists under several providers (${bare.map(entry => entry.provider).join(', ')}) — `
      + 'spell it as provider/model-id',
    )
  }
  if (allowlist.length === 0) {
    throw new Error(`the user allows no alternate worker models — omit \`model\` ("${value}" rejected)`)
  }
  throw new Error(
    `model "${value}" is not on the user's allowlist — allowed:\n${allowlist.map(catalogRow).join('\n')}`,
  )
}

export async function apply(ctx, config) {
  const provider = config.provider ?? 'spawn'
  const toolName = config.toolName ?? 'spawn_dev_agent'
  const fallbackModels = config.models ?? []

  // Live meta-config. `allowlistCache` holds modality-resolved entries for the
  // CURRENT effective model list; it refreshes on every settings change (the
  // resolution is async, while prompt-section text and argument validation are
  // synchronous readers).
  const meta = () => ctx.get('supervisorSettings')?.current()
  const effectiveModels = () => {
    const configured = meta()?.workerModels
    return Array.isArray(configured) && configured.length > 0 ? configured : fallbackModels
  }
  let allowlistCache = []
  let cachedKey = ''
  const refreshAllowlist = async () => {
    const models = effectiveModels()
    const key = models.join('\n')
    if (key === cachedKey) return
    cachedKey = key
    allowlistCache = await resolveAllowlist(ctx, models)
  }
  await refreshAllowlist()
  const unsubscribe = ctx.get('supervisorSettings')?.subscribe(() => { void refreshAllowlist() })
  if (unsubscribe !== undefined) ctx.effect(() => unsubscribe)

  let disposeTool

  // Live meta-config section: re-rendered on every request, so settings edits
  // reach the model's next turn without any re-registration.
  ctx.systemPrompt.section({
    name: `meta:${toolName}`,
    order: META_SECTION_ORDER,
    text: () => {
      if (disposeTool === undefined) return ''
      const current = meta()
      const cap = current?.maxParallelWorkers ?? 0
      const lines = [
        'SUPERVISOR META-CONFIG (user-owned; Settings -> Plugins -> dsh-supervisor, or the dsh-supervisor: block in ~/.dsh/settings.yaml; may change while you run — this section always shows the current values):',
        allowlistCache.length > 0
          ? `- Worker models you may pass to ${toolName} (\`model\` argument; [modalities] are native input support):\n${allowlistCache.map(entry => `    ${catalogRow(entry)}`).join('\n')}`
          : `- No alternate worker models are allowed: never pass \`model\` to ${toolName}; workers inherit your model.`,
        cap > 0
          ? `- Max parallel workers: ${cap} (enforced — a spawn beyond it is refused; wait for a settle or kill a worker).`
          : '- Max parallel workers: unlimited.',
        ...current === undefined ? [] : [
          `- Timing defaults: wakeMinutes=${current.wakeMinutes} (how often you wake to inspect workers; recurring schedule, minutes), questionWaitMinutes=${current.questionWaitMinutes} (how long you wait on a question before recording an assumption and continuing). A workspace's .agi/config.json overrides them when it carries the key.`,
        ],
      ]
      return lines.join('\n')
    },
  })

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

  const mount = () => {
    disposeTool = ctx.tools.register(defineTool({
      name: toolName,
      description:
        'Start a worker agent in a fresh context (it does not see this conversation; the prompt must be '
        + 'a complete standalone task). Runs in the background by default and immediately returns a durable '
        + 'subagent id; when the run settles you receive a notice with its outcome, and `send_message` '
        + 'starts a later turn in the same child. '
        + 'The optional `model` argument selects the worker\'s model from the user-approved list in your '
        + 'SUPERVISOR META-CONFIG section (pick a [text,image] model ONLY when the task requires looking at '
        + 'images; the worker reads them with its read_image tool). Omitted, the worker inherits your own '
        + 'model. The meta-config also carries the enforced parallel-worker cap.',
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
          description: 'Worker model as provider/model-id from the SUPERVISOR META-CONFIG allowlist (bare id accepted when unambiguous). Omit to inherit the supervisor\'s model.',
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
                model: { type: 'string' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'foreground' },
                output: { type: 'array', required: true, items: { type: 'json' } },
              },
            },
          ],
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.kind === 'continuable'
            ? `started subagent ${value.subagentId}${value.model !== undefined ? ` on ${value.model}` : ''}`
            : value.output
                .filter(block => typeof block === 'object' && block !== null && block.type === 'text')
                .map(block => block.text)
                .join(''),
        }],
      },
      // Deliberately NOT concurrency-safe: spawn bodies serialize so the cap
      // check of a second same-step call observes the first call's ledger entry.
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const parent = exec.agent
        if (!parent) throw new Error(`${toolName} requires a calling agent`)

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

        await refreshAllowlist()
        const agentOptions = args.model === undefined || args.model === ''
          ? undefined
          : resolveModelArg(args.model, allowlistCache)
        const request = {
          label: args.description,
          prompt: [{ type: 'text', text: args.prompt }],
          parent,
          maxDepth: config.maxDepth ?? 3,
          ...agentOptions !== undefined ? { agentOptions } : {},
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
            ...agentOptions !== undefined ? { model: `${agentOptions.provider}/${agentOptions.model}` } : {},
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
          return { kind: 'foreground', output: result.output }
        } finally {
          await run.dispose()
        }
      },
    }))
  }

  // Mirror provider lifecycle (sibling load order can register `spawn` later).
  ctx.on('subagent/provider-added', (added) => {
    if (added.name === provider && disposeTool === undefined) mount()
  })
  ctx.on('subagent/provider-removed', (removed) => {
    if (removed !== provider || disposeTool === undefined) return
    disposeTool()
    disposeTool = undefined
  })
  if (ctx.subagents.getProvider(provider) !== undefined) {
    mount()
  } else {
    ctx.logger.info(`dsh-supervisor-spawn: provider "${provider}" not registered yet; "${toolName}" will register when it appears`)
  }
}
