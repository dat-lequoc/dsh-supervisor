/**
 * dsh-supervisor — generic worker spawn tool (`spawn_dev_agent`).
 *
 * A preset-row plugin (mounted from agent-presets/main-agent/agent.cordis.yml
 * as `name: dsh-supervisor/spawn`) that replaces the pinned
 * `@deepseek-ai/dsh-tool-subagent` dev row with a MODEL-GENERIC one: the tool
 * gains an optional `model` argument, and its description embeds the live
 * model catalog annotated with each model's native input modalities
 * (`[text]` / `[text,image]`), so the supervisor can see which workers can
 * look at images and choose accordingly — no per-model tool rows.
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
export const inject = ['tools', 'subagents', 'llm']

export const Config = z.object({
  /** The `ctx.subagents` provider to start children on. */
  provider: z.string().default('spawn'),
  /** Model-facing tool name. */
  toolName: z.string().default('spawn_dev_agent'),
  /** Per-child persona (the invariant worker protocol). */
  persona: z.string(),
  /** Child recursion cap, forwarded per request. */
  maxDepth: z.natural().default(3),
})

/** Render one catalog row: `zai/glm-5v-turbo  [text,image]`. */
function catalogRow(model) {
  const modalities = model.inputModalities ?? ['text']
  return `${model.provider}/${model.id}  [${modalities.join(',')}]`
}

/**
 * The live model catalog: every registered provider's advertised models with
 * their native input modalities. Failures per provider degrade to omission —
 * the tool must register even when one adapter cannot list.
 */
async function loadCatalog(ctx) {
  const entries = []
  for (const provider of ctx.llm.listProviders()) {
    try {
      for (const model of await ctx.llm.listModels(provider.id)) entries.push(model)
    } catch {
      // Provider cannot enumerate: its exact ids still work when spelled out.
    }
  }
  return entries
}

/**
 * Resolve the tool's `model` argument against the catalog.
 * Accepts `provider/model-id` (model ids may themselves contain slashes) or a
 * bare model id when it is unambiguous across providers.
 * @returns `{ provider, model }` agent options.
 */
function resolveModelArg(value, catalog) {
  for (const entry of catalog) {
    if (value === `${entry.provider}/${entry.id}`) return { provider: entry.provider, model: entry.id }
  }
  const bare = catalog.filter(entry => entry.id === value)
  if (bare.length === 1) return { provider: bare[0].provider, model: bare[0].id }
  if (bare.length > 1) {
    throw new Error(
      `model "${value}" exists under several providers (${bare.map(entry => entry.provider).join(', ')}) — `
      + 'spell it as provider/model-id',
    )
  }
  throw new Error(
    `unknown model "${value}" — pick one of:\n${catalog.map(catalogRow).join('\n')}`,
  )
}

export async function apply(ctx, config) {
  const provider = config.provider ?? 'spawn'
  const toolName = config.toolName ?? 'spawn_dev_agent'
  const catalog = await loadCatalog(ctx)
  const catalogText = catalog.length === 0
    ? '(model catalog unavailable — omit `model` to inherit yours)'
    : catalog.map(catalogRow).join('\n')

  let disposeTool
  const mount = () => {
    disposeTool = ctx.tools.register(defineTool({
      name: toolName,
      description:
        'Start a worker agent in a fresh context (it does not see this conversation; the prompt must be '
        + 'a complete standalone task). Runs in the background by default and immediately returns a durable '
        + 'subagent id; when the run settles you receive a notice with its outcome, and `send_message` '
        + 'starts a later turn in the same child. '
        + 'The optional `model` argument selects the worker\'s model; each catalog row shows the model\'s '
        + 'native input modalities — pick a `[text,image]` model ONLY when the task requires looking at '
        + 'images (screenshots, figures, scans; the worker reads them with its read_image tool). '
        + 'Omitted, the worker inherits your own model.\n'
        + 'Model catalog:\n' + catalogText,
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
          description: 'Worker model as provider/model-id from the catalog in this tool\'s description (bare id accepted when unambiguous). Omit to inherit the supervisor\'s model.',
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
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const parent = exec.agent
        if (!parent) throw new Error(`${toolName} requires a calling agent`)
        const agentOptions = args.model === undefined || args.model === ''
          ? undefined
          : resolveModelArg(args.model, catalog)
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
