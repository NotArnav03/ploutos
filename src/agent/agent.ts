import { POLICY_JUDGED_UNCOLLECTABLE, type Action, type ActionType } from '../domain/actions.js';
import type { Policy, PolicyDecision, PolicyInput } from '../domain/policy.js';
import type { Channel, Language } from '../domain/schemas.js';
import { addDays, addHours, type Timestamp } from '../domain/time.js';
import { staticPolicy } from '../policy/static_policy.js';
import { CACHE_DIR, DecisionCache, cacheKey, type CacheEntry } from './cache.js';
import { PROMPT_VERSION, SYSTEM_PROMPT, renderCase } from './prompt.js';
import { AgentOutputSchema, outputJsonSchema, type AgentOutput } from './schema.js';
import { AGENT_MODEL, QuotaExhaustedError, geminiCompleter, type Completer } from './provider.js';

export { AGENT_MODEL, type Completer };

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

export interface AgentStats {
  calls: number;
  cache_hits: number;
  cache_misses: number;
  /** Requests the transport retried and eventually got an answer for. */
  retries: number;
  /** Decisions that fell back to static-policy because the API never answered. */
  api_errors: number;
  /**
   * Why the last one failed. A run that spends half an hour failing has to be
   * able to say what went wrong; "2713 error(s)" and nothing else is not a
   * diagnosis, it is a number.
   */
  last_error: string | null;
  tokens_in: number;
  tokens_out: number;
}

/**
 * Consecutive failures before the run is abandoned.
 *
 * Falling back to static-policy for one unlucky decision is resilience.
 * Falling back for every decision in the batch is not - it silently produces a
 * row labelled "agent" whose numbers are static-policy's, which is worse than
 * crashing because it looks like a result. The breaker exists so that a broken
 * run fails loudly instead of publishing a lie.
 */
const CONSECUTIVE_FAILURE_LIMIT = 20;

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

  // An injected completer means a test or a diagnostic, and neither may write
  // to the committed cache.
  //
  // This is not hypothetical. A scratch script pointed a stub at the default
  // cache and wrote 5,500 fabricated decisions into the file the README
  // describes as real recorded model decisions - indistinguishable from the
  // genuine ones by inspection, and caught only because an unrelated count came
  // out wrong. It was never committed. Nothing structural had prevented it, so
  // now something does.
  if (opts.complete !== undefined && opts.cache === undefined) {
    throw new Error(
      'makeAgent: a custom completer must be given its own cache. Passing a stub ' +
        'without one would write fabricated decisions into the committed cache at ' +
        `${CACHE_DIR}.`,
    );
  }
  const cache = opts.cache ?? new DecisionCache();
  // Constructed lazily: building the client throws when no credentials are
  // present, and a cache-only replay needs no credentials at all.
  let completer: Completer | null = opts.complete ?? null;
  let consecutiveFailures = 0;
  const stats: AgentStats = {
    calls: 0,
    cache_hits: 0,
    cache_misses: 0,
    retries: 0,
    api_errors: 0,
    last_error: null,
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

      const cached = opts.noCache === true ? null : cache.get(key);
      let output: AgentOutput | null = cached?.output ?? null;
      const cacheHit = cached !== null;
      let latency: number | null = null;
      // What this decision cost, whether it was paid for now or when it was
      // recorded. Live spend is counted separately, in stats.
      let tokensIn: number | null = cached?.tokens_in ?? null;
      let tokensOut: number | null = cached?.tokens_out ?? null;

      if (output === null) {
        const started = Date.now();
        try {
          completer ??= geminiCompleter({ onRetry: () => stats.retries++ });
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

          consecutiveFailures = 0;

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
          stats.last_error = err instanceof Error ? err.message : String(err);
          consecutiveFailures++;

          // A spent daily quota is not a blip and no amount of falling back
          // makes the resulting run mean anything.
          if (err instanceof QuotaExhaustedError) throw err;
          if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
            throw new Error(
              `agent abandoned after ${consecutiveFailures} consecutive API failures; ` +
                `last error: ${stats.last_error}`,
            );
          }
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
    case 'stop_terminal': {
      // A stop is one of two very different events and the trail has to be able
      // to tell them apart.
      //
      // If a stop rule has already fired, the case is closed because a rule
      // says so, and that rule's id is the honest record. If none has, this is
      // the model choosing to give up while the gate would still have let it
      // act - a judgement, not a fact. Recording that under
      // STOP_ON_ATTEMPTS_EXHAUSTED, as this did, put the id of a rule that
      // never fired into the audit trail, and asserted the invoice was
      // unrecoverable when four of them were recovered by static-policy doing
      // nothing cleverer than asking the payer for a new card.
      const ruled = obs.stopped_reason !== null;
      return {
        action: {
          type: 'stop_terminal',
          rule_id: ruled ? obs.stopped_reason! : POLICY_JUDGED_UNCOLLECTABLE,
          // written_off is a decision the merchant made. closed_unrecoverable
          // is a claim about the world, and only a rule gets to make it.
          disposition: ruled ? 'closed_unrecoverable' : 'written_off',
        },
      };
    }
  }
}
