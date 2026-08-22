/**
 * dsh-supervisor — `send_message` + `interrupt_agent`.
 *
 * Replaces the shipped `@deepseek-ai/dsh-tool-subagent-control` row in the
 * main-agent preset. Same parent-authority surface, one difference: a message
 * to a RUNNING direct child is steered at its next step (`Agent.steer()`, the
 * same built-in primitive the web UI's queue-steer action uses), so a
 * correction can redirect work already underway instead of waiting for the
 * whole turn to finish. Every other case — idle, waiting, cold-resume, or any
 * authority mismatch — goes through the native `ctx.subagents.followup()`
 * unchanged. The native service itself is never modified, so the shipped
 * `subagent`/fork tools and report flows keep stock behavior.
 *
 * `list_agents` stays on the shipped plugin.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-supervisor-control'
export const inject = ['tools', 'subagents', 'agents']

/**
 * Register `send_message` and `interrupt_agent`.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'send_message',
    description:
      'Send a message to a background subagent by its subagent id, continuing the same conversation. If '
      + 'it is still working, the message joins its current turn at the next step, so it can redirect work '
      + 'already underway — do not wait for the child to finish, and do not interrupt unless the current '
      + 'turn must stop immediately. If it is idle, the message starts its next turn. This call returns no '
      + 'answer from the subagent — only confirmation that the message was delivered. A failure means the '
      + 'message was NOT delivered.',
    parameters: {
      subagent_id: {
        type: 'string',
        required: true,
        description: 'The subagent id returned when the background subagent was started.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The message to deliver to the subagent.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
        },
      },
      render: (args, _value) => [{
        type: 'text',
        text: `message delivered to subagent ${args.subagent_id}`,
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        throw new Error('send_message requires a calling agent (exec.agent was undefined)')
      }
      const childId = SessionId(args.subagent_id)
      const content = [{ type: 'text', text: args.message }]
      const source = { kind: 'coordinator', form: 'relay', senderSessionId: parent.id }

      // Fast path: the child is live and mid-turn, and this caller is its
      // exact live direct parent — steer into the current turn's next step.
      // The authority predicate mirrors the service's own lineage check
      // (`parentSession === parent.id` + exact live parent); any mismatch or
      // idle/absent child falls through to the native followup, which owns
      // wake, cold resume, and the authoritative rejection.
      const child = ctx.agents.get(childId)
      if (
        child !== undefined
        && child.status === 'running'
        && ctx.agents.get(parent.id) === parent
        && child.session.header.parentSession === parent.id
      ) {
        exec.signal?.throwIfAborted?.()
        const message = createUserMessage({ content, source })
        child.steer(message)
        // If the child left the registry in the same tick (settlement raced
        // the steer, dispose clears the inbox), re-deliver through the native
        // path so the message is not silently lost.
        if (ctx.agents.get(childId) === child) return { messageId: message.id }
      }

      const messageId = await ctx.subagents.followup(parent, childId, content, {
        source,
        signal: exec.signal,
      })
      return { messageId }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'interrupt_agent',
    description:
      'Request cancellation of a background agent\'s current turn by its agent id. The target may be your '
      + 'direct child or a deeper agent created under you. Only the current turn stops: messages already '
      + 'queued for the agent stay parked until a later send_message, agents it started keep running, and '
      + 'the agent itself stays available for follow-ups. This call returns as soon as the stop request is '
      + 'accepted, so the target may keep running briefly; interrupting an agent that already finished is '
      + 'an accepted no-op.',
    parameters: {
      agent_id: {
        type: 'string',
        required: true,
        description: 'The agent id of the running agent to interrupt.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
        },
      },
      render: (args, _value) => [{
        type: 'text',
        text: `interrupt requested for agent ${args.agent_id}`,
      }],
    },
    execute(args, exec) {
      const caller = exec.agent
      if (!caller) {
        throw new Error('interrupt_agent requires a calling agent (exec.agent was undefined)')
      }
      ctx.subagents.interrupt(SessionId(args.agent_id), { kind: 'ancestor', agent: caller })
      return Promise.resolve({ accepted: true })
    },
  }))
}
