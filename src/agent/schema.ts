import { z } from 'zod';
import { ACTION_TYPES, type ActionType } from '../domain/actions.js';
import { CHANNELS, LANGUAGES, type Channel } from '../domain/schemas.js';

/**
 * The contract between the model and this system.
 *
 * TWO THINGS THE MODEL DOES NOT DO
 *
 * It does not construct an `Action`. The action union has twelve members with
 * different required fields - timestamps, expiry windows, rule ids, disposition
 * codes - and asking a model to fill those in correctly buys nothing except new
 * ways to be wrong. The model chooses a *type* and the handful of parameters
 * that are genuinely judgement calls; deterministic code assembles the action
 * from them. Everything structural stays structural.
 *
 * It does not choose freely from the twelve action types either. The schema
 * handed to the API on each call enumerates exactly the types the gate permits
 * at that moment, so a forbidden action is not something the model is trusted
 * not to pick - it is something the decoder cannot emit. The runtime gate still
 * rejects out-of-set choices afterwards, because a constraint enforced in one
 * place is a constraint that breaks silently when that place changes.
 */

export const AgentOutputSchema = z.object({
  /**
   * Root cause in the model's own words. Free text on purpose: this is the
   * part a human reads when they want to know what the agent thought was going
   * on, and forcing it into an enum would just relabel our own taxonomy back at
   * us. It is recorded, never branched on.
   */
  diagnosis: z.string().min(1).max(400),
  action_type: z.enum(ACTION_TYPES),
  /** Required for contacting actions, null otherwise. */
  channel: z.enum(CHANNELS).nullable(),
  /** Only read when action_type is 'wait'. Hours from now. */
  wait_hours: z.number().min(1).max(720).nullable(),
  language: z.enum(LANGUAGES).nullable(),
  rationale: z.string().min(1).max(400),
  confidence: z.number().min(0).max(1),
});
export type AgentOutput = z.infer<typeof AgentOutputSchema>;

/**
 * The JSON Schema sent with each request.
 *
 * Built per call rather than once, because `action_type` is enumerated from the
 * gate's permitted set for *this* case at *this* moment. That is the point: the
 * model is constrained at decoding time to the actions that are actually legal,
 * so "the LLM cannot authorise a refund" is a property of the request rather
 * than a hope about the prompt.
 */
export function outputJsonSchema(
  permitted: readonly ActionType[],
  channels: readonly Channel[],
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['diagnosis', 'action_type', 'channel', 'wait_hours', 'language', 'rationale', 'confidence'],
    properties: {
      diagnosis: {
        type: 'string',
        maxLength: 400,
        description:
          'The most likely root cause of this failure, in one or two sentences, based only on the evidence shown.',
      },
      action_type: {
        type: 'string',
        // Exactly what the gate permits right now. Nothing else is expressible.
        enum: [...permitted],
        description: 'The single next action to take. Only these are currently permitted.',
      },
      channel: {
        // An empty permitted-channel list leaves null as the only valid value,
        // which is how "you may not contact anyone right now" reaches the model
        // as a constraint rather than as a sentence it might overlook.
        type: channels.length > 0 ? ['string', 'null'] : ['null'],
        ...(channels.length > 0 ? { enum: [...channels, null] } : {}),
        description:
          'Channel for a contacting action. Must be null for actions that send nothing.',
      },
      wait_hours: {
        type: ['number', 'null'],
        minimum: 1,
        maximum: 720,
        description:
          'How many hours to wait before looking at this case again. Only used when action_type is "wait"; null otherwise.',
      },
      language: {
        type: ['string', 'null'],
        enum: [...LANGUAGES, null],
        description:
          "Language for a message to the payer. Use the customer's language_pref unless there is a reason not to. Null when nothing is being sent.",
      },
      rationale: {
        type: 'string',
        maxLength: 400,
        description:
          'Why this action, now, in one or two sentences. This is written into the audit trail and read by humans.',
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'How confident you are that this is the right action.',
      },
    },
  };
}
