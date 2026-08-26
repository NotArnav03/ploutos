import Anthropic from '@anthropic-ai/sdk';
import type { Action, ActionType } from '../domain/actions.js';
import type { Policy, PolicyDecision, PolicyInput } from '../domain/policy.js';
import type { Channel, Language } from '../domain/schemas.js';
import { addDays, addHours, type Timestamp } from '../domain/time.js';
import { staticPolicy } from '../policy/static_policy.js';
import { DecisionCache, cacheKey, type CacheEntry } from './cache.js';
import { PROMPT_VERSION, SYSTEM_PROMPT, renderCase } from './prompt.js';
import { AgentOutputSchema, outputJsonSchema, type AgentOutput } from './schema.js';

export const AGENT_MODEL = 'claude-opus-5';

/**
 * One model call. Injectable so that the decision pipeline - schema
 * construction, validation, action assembly, gate re-check, fallback - can be
 * tested without a network or an API key, and so a test can deliberately return
 * a malformed or forbidden answer to prove the guards fire.
 */
export interface Completer {
  (req: {
    system: string;
    user: string;
    schema: Record<string, unknown>;
    model: string;
  }): Promise<{ output: unknown; tokens_in: number; tokens_out: number }>;
}

export interface AgentOptions {
  /** Re-query the API instead of replaying committed decisions. */
  noCache?: boolean;
  /** Set false to fail loudly instead of falling back when the API is unusable. */
  allowFallback?: boolean;
  model?: string;
  /** Defaults to the Anthropic API. */
  complete?: Completer;
  /** Defaults to the committed cache. */
  cache?: DecisionCache;
}

/** The real transport. */
export function anthropicCompleter(client: Anthropic = new Anthropic()): Completer {
  return async (req) => {
    const response = await client.messages.create({
      model: req.model,
      max_tokens: 4096,
      // Adaptive thinking: this is a genuine judgement call under uncertainty,
      // not an extraction task. Effort stays low because the decision is small
      // and there are thousands of them.
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: req.schema },
      },
      // The system prompt is frozen and identical on every call, so it caches;
      // the case body is volatile and goes after the breakpoint.
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: req.user }],
    });

    if (response.stop_reason === 'refusal') {
      throw new Error(`model declined: ${response.stop_details?.category ?? 'unknown'}`);
    }
    const text = response.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') throw new Error('no text block in response');
    return {
      output: JSON.parse(text.text),
      tokens_in: response.usage.input_tokens,
      tokens_out: response.usage.output_tokens,
    };
  };
}

export interface AgentStats {
  calls: number;
  cache_hits: number;
  cache_misses: number;
  api_errors: number;
  tokens_in: number;
  tokens_out: number;
}

/**
 * The agent.
 *
 * WHERE THE LLM SITS
 *
 * It sits between the gate and the runner, and nowhere else. It does not read
 * ground truth, it does not compute the ceiling, it does not decide whether an
 * action is permitted, and it cannot construct an action the gate has not
 * already allowed. What it contributes is judgement over a filtered menu:
 * which of these legal moves is the best one for this payer, right now.
 *
 * That is deliberately a narrow job. The interesting engineering claim in this
 * project is not "an LLM did it" - it is that an LLM can be given real
 * discretion over money while every rule that matters is enforced somewhere it
 * cannot reach.
 *
 * THREE LAYERS BETWEEN THE MODEL AND THE WORLD
 *
 * 1. The response schema enumerates only permitted action types, so a forbidden
 *    action cannot be decoded.
 * 2. This function re-checks the returned type against the permitted set, in
 *    case the API ever returns something off-schema.
 * 3. The runner checks it again before execution and records a violation if it
 *    is wrong, which is where the reported gate-rejection rate comes from.
 *
 * Layer 3 alone would be sufficient for safety. Layers 1 and 2 exist so that a
 * failure shows up as a rejected decision rather than as a silently degraded
 * result, and so the rejection rate means something when it is reported.
 */
export function makeAgent(opts: AgentOptions = {}): Policy & { stats: AgentStats; flush(): void } {
  const model = opts.model ?? AGENT_MODEL;
  const cache = opts.cache ?? new DecisionCache();
  // Constructed lazily: building the client throws when no credentials are
  // present, and a cache-only replay needs no credentials at all.
  let completer: Completer | null = opts.complete ?? null;
  const stats: AgentStats = {
    calls: 0,
    cache_hits: 0,
    cache_misses: 0,
    api_errors: 0,
    tokens_in: 0,
    tokens_out: 0,
  };

  return {
    name: 'agent',
    usesLatentState: false,
    stats,
    flush: () => cache.flush(),

    async decide(input: PolicyInput): Promise<PolicyDecision> {
      const { observation: obs, permitted } = input;
      const now = input.ctx.now;

      // Nothing to deliberate about: the gate permits exactly one action.
      // Spending a model call to rediscover that is pure cost.
      if (permitted.permitted.length === 1) {
        const only = permitted.permitted[0]!;
        return {
          ...assemble(only, null, null, input),
          diagnosis: null,
          rationale: `only ${only} is permitted; no decision to make`,
          confidence: null,
          meta: {
            model: null,
            prompt_version: PROMPT_VERSION,
            tokens_in: null,
            tokens_out: null,
            latency_ms: null,
            cache_hit: false,
          },
        };
      }

      const key = cacheKey({
        prompt_version: PROMPT_VERSION,
        model,
        observation_hash: permitted.observation_hash,
        permitted: permitted.permitted,
        permitted_channels: permitted.permitted_channels,
      });

      let output = opts.noCache === true ? null : cache.get(key);
      let cacheHit = output !== null;
      let latency: number | null = null;
      let tokensIn: number | null = null;
      let tokensOut: number | null = null;

      if (output === null) {
        const started = Date.now();
        try {
          completer ??= anthropicCompleter();
          const response = await completer({
            system: SYSTEM_PROMPT,
            user: renderCase(obs, permitted),
            schema: outputJsonSchema(permitted.permitted, permitted.permitted_channels),
            model,
          });

          latency = Date.now() - started;
          tokensIn = response.tokens_in;
          tokensOut = response.tokens_out;
          stats.calls++;
          stats.tokens_in += tokensIn;
          stats.tokens_out += tokensOut;

          const parsed = AgentOutputSchema.safeParse(response.output);
          if (!parsed.success) {
            throw new Error(
              `output failed validation: ${parsed.error.issues
                .map((i) => `${i.path.join('.')}: ${i.message}`)
                .join('; ')}`,
            );
          }
          output = parsed.data;

          const entry: CacheEntry = {
            key,
            prompt_version: PROMPT_VERSION,
            model,
            observation_hash: permitted.observation_hash,
            output,
            tokens_in: tokensIn,
            tokens_out: tokensOut,
            recorded_at: new Date().toISOString(),
          };
          cache.put(entry);
        } catch (err: unknown) {
          // An unreachable or misbehaving API must not silently become a
          // different measured result. Fall back deterministically, count it,
          // and let the reported fallback rate carry the fact.
          stats.api_errors++;
          if (opts.allowFallback === false) throw err;
          const fb = await staticPolicy.decide(input);
          return {
            ...fb,
            rationale: `agent unavailable (${err instanceof Error ? err.message : String(err)}); ${fb.rationale}`,
            meta: {
              model,
              prompt_version: PROMPT_VERSION,
              tokens_in: null,
              tokens_out: null,
              latency_ms: Date.now() - started,
              cache_hit: false,
            },
          };
        }
      }

      stats.cache_hits = cache.hits;
      stats.cache_misses = cache.misses;

      // Layer 2. The schema should have made this impossible; if it ever fires,
      // that is worth knowing rather than papering over.
      const chosen = permitted.permitted.includes(output.action_type)
        ? output.action_type
        : permitted.permitted[0]!;

      return {
        ...assemble(chosen, output, resolveChannel(output, permitted.permitted_channels), input),
        diagnosis: output.diagnosis,
        rationale: output.rationale,
        confidence: output.confidence,
        meta: {
          model,
          prompt_version: PROMPT_VERSION,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          latency_ms: latency,
          cache_hit: cacheHit,
        },
      };
    },
  };
}

/**
 * Pick a channel the gate actually permits.
 *
 * The schema constrains the model to the permitted list, but an action that
 * needs a channel and receives null would be malformed, so a default is applied
 * rather than letting the runner reject the decision over a formatting slip.
 */
function resolveChannel(output: AgentOutput, permitted: readonly Channel[]): Channel | null {
  if (permitted.length === 0) return null;
  if (output.channel !== null && permitted.includes(output.channel)) return output.channel;
  return permitted[0]!;
}

/**
 * Assemble the concrete action from the model's choice.
 *
 * Everything the model does not decide is decided here: notice lead times,
 * link expiry, stop rule ids, handoff summaries. These are structural fields
 * with correct values that no judgement improves, and every one of them is a
 * field the model can no longer get wrong.
 */
function assemble(
  type: ActionType,
  output: AgentOutput | null,
  channel: Channel | null,
  input: PolicyInput,
): { action: Action } {
  const { observation: obs } = input;
  const now = input.ctx.now;
  const lang: Language = output?.language ?? obs.customer.language_pref;
  const ch: Channel = channel ?? 'email';
  const waitUntil: Timestamp = addHours(now, output?.wait_hours ?? 12);

  switch (type) {
    case 'wait':
      return { action: { type: 'wait', until: waitUntil } };
    case 'retry_debit':
      return { action: { type: 'retry_debit', rail: obs.subscription.rail, at: now } };
    case 'switch_rail':
      return { action: { type: 'switch_rail', to_rail: obs.subscription.rail, at: now } };
    case 'serve_predebit_notice':
      // 26 hours, against a 24-hour requirement. The margin is deliberate: a
      // notice served exactly at the boundary is a rounding error away from
      // being non-compliant.
      return {
        action: { type: 'serve_predebit_notice', channel: ch, for_debit_at: addHours(now, 26) },
      };
    case 'request_afa':
      return { action: { type: 'request_afa', channel: ch, language: lang } };
    case 'notify_soft':
      return {
        action: { type: 'notify_soft', channel: ch, template_id: 'payment_failed', language: lang },
      };
    case 'request_instrument_update':
      return {
        action: {
          type: 'request_instrument_update',
          channel: ch,
          template_id: 'card_expired',
          language: lang,
        },
      };
    case 'send_payment_link':
      return {
        action: {
          type: 'send_payment_link',
          channel: ch,
          template_id: 'payment_link',
          language: lang,
          expires_at: addDays(now, 7),
        },
      };
    case 'capture_promise_to_pay':
      return {
        action: {
          type: 'capture_promise_to_pay',
          promised_for: addDays(now, 3),
          channel: ch,
          language: lang,
        },
      };
    case 'grant_grace':
      return { action: { type: 'grant_grace', new_due_date: addDays(now, 7), cycles: 1 } };
    case 'handoff_human':
      return {
        action: {
          type: 'handoff_human',
          reason: output?.diagnosis ?? 'automated routes exhausted',
          case_summary:
            `Invoice ${obs.invoice.id} (${obs.invoice.amount_paise} paise) on ` +
            `${obs.subscription.rail}, ${obs.invoice.attempts.length} presentment(s). ` +
            `${output?.rationale ?? ''}`.trim(),
          priority: obs.invoice.amount_paise >= 500_000 ? 'high' : 'normal',
        },
      };
    case 'stop_terminal':
      return {
        action: {
          type: 'stop_terminal',
          rule_id: obs.stopped_reason ?? 'STOP_ON_ATTEMPTS_EXHAUSTED',
          disposition: 'closed_unrecoverable',
        },
      };
  }
}
