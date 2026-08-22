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
  /**
   * USER-owned allowlist of models the supervisor may pick for workers, each
   * spelled `provider/model-id`. Absent or empty, the tool has NO `model`
   * argument and every worker inherits the supervisor's model — the agent
   * never discovers routes the user did not name (models cost money).
   * Modalities are still resolved from the native catalog for display.
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
  throw new Error(
    `model "${value}" is not on the user's allowlist — allowed:\n${allowlist.map(catalogRow).join('\n')}`,
  )
}

export async function apply(ctx, config) {
  const provider = config.provider ?? 'spawn'
  const toolName = config.toolName ?? 'spawn_dev_agent'
  const allowlist = await resolveAllowlist(ctx, config.models ?? [])
  const modelChoice = allowlist.length > 0

  let disposeTool
  const mount = () => {
    disposeTool = ctx.tools.register(defineTool({
      name: toolName,
      description:
        'Start a worker agent in a fresh context (it does not see this conversation; the prompt must be '
        + 'a complete standalone task). Runs in the background by default and immediately returns a durable '
        + 'subagent id; when the run settles you receive a notice with its outcome, and `send_message` '
        + 'starts a later turn in the same child.'
        + (modelChoice
          ? ' The optional `model` argument selects the worker\'s model from the USER-approved list below '
            + '(each row shows the model\'s native input modalities — pick a `[text,image]` model ONLY when '
            + 'the task requires looking at images: screenshots, figures, scans; the worker reads them with '
            + 'its read_image tool). Omitted, the worker inherits your own model.\n'
            + 'Allowed models:\n' + allowlist.map(catalogRow).join('\n')
          : ' Workers run on your own model (the user has not allowed any alternates).'),
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
        ...modelChoice ? {
          model: {
            type: 'string',
            description: 'Worker model as provider/model-id from the allowed list in this tool\'s description (bare id accepted when unambiguous). Omit to inherit the supervisor\'s model.',
          },
        } : {},
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
        const agentOptions = !modelChoice || args.model === undefined || args.model === ''
          ? undefined
          : resolveModelArg(args.model, allowlist)
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
