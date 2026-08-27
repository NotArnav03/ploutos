/**
 * One model call.
 *
 * Injectable so that the decision pipeline - schema construction, validation,
 * action assembly, gate re-check, fallback - can be tested without a network or
 * an API key, and so a test can deliberately return a malformed or forbidden
 * answer to prove the guards fire.
 */
export interface Completer {
  (req: {
    system: string;
    user: string;
    schema: Record<string, unknown>;
    model: string;
  }): Promise<{ output: unknown; tokens_in: number; tokens_out: number }>;
}

/**
 * The transport to the model.
 *
 * WHY THE MODEL NAME IS A CONSTANT AND NOT SNIFFED FROM THE ENVIRONMENT
 *
 * The decision cache is keyed on the model, so the model name is part of what
 * makes a committed result reproducible. If this module picked a provider by
 * looking at which API key happened to be set, a reviewer who clones the repo
 * with a different key in their shell would miss every cache entry and silently
 * re-query thousands of decisions against a model that produced none of the
 * committed numbers.
 *
 * So identity is pinned here and credentials come from the environment. The
 * only way to change the model is to say so explicitly on the command line,
 * which is also the only circumstance in which changing it is meaningful.
 */
export const AGENT_MODEL = 'gemini-3.7-flash';

/**
 * How hard each model is asked to think.
 *
 * Per model, because the levels are not portable: gemini-3.7-flash rejects
 * MINIMAL outright ("Thinking level MINIMAL is not supported for this model"),
 * while gemini-3.1-flash-lite accepts it and returns zero reasoning tokens.
 *
 * This matters to the bill rather than only to the output. Reasoning tokens are
 * billed as output and on 3.7-flash they were 344 of a 477-token response - 72%
 * of the expensive half of every decision.
 */
const THINKING: Record<string, string> = {
  'gemini-3.7-flash': 'low',
  'gemini-3.5-flash': 'low',
  'gemini-3.1-flash-lite': 'minimal',
  'gemini-3.1-flash-lite-preview': 'minimal',
};

/** Falls back to 'low', which every thinking model accepts. */
export function thinkingLevelFor(model: string): string {
  return THINKING[model] ?? 'low';
}

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Status codes worth trying again. Everything else is a real answer. */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  error?: { message?: string; status?: string };
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * The daily request quota is gone. Distinct from ProviderError because nothing
 * about this run can recover from it, and the correct response is to abandon
 * the run rather than to keep asking.
 */
export class QuotaExhaustedError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = 'QuotaExhaustedError';
  }
}

/**
 * A 429 is two different events wearing one status code.
 *
 * Per-minute throttling clears in seconds and retrying is exactly right. A
 * daily quota does not clear for hours, and retrying spends four more requests
 * against a quota that is already gone - which is precisely how one exhausted
 * quota turned 2,713 failed decisions into 13,565 wasted requests. The
 * difference is in the body, not the status: Google returns the wait in a
 * RetryInfo detail, and a wait measured in hours is a wall, not a delay.
 */
const QUOTA_WALL_SECONDS = 300;

function parseRetryInfo(body: string): { status: string | null; retryAfterSeconds: number | null } {
  try {
    const j = JSON.parse(body) as {
      error?: { status?: string; details?: { '@type'?: string; retryDelay?: string }[] };
    };
    const detail = j.error?.details?.find((d) => d['@type']?.endsWith('RetryInfo'));
    const raw = detail?.retryDelay;
    const seconds = raw !== undefined ? Number(raw.replace(/s$/, '')) : NaN;
    return {
      status: j.error?.status ?? null,
      retryAfterSeconds: Number.isFinite(seconds) ? seconds : null,
    };
  } catch {
    return { status: null, retryAfterSeconds: null };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A completer backed by the Gemini API.
 *
 * Written against `fetch` rather than a vendor SDK on purpose. The request is
 * four fields and the response is one string, the JSON Schema this project
 * builds per call is passed through untouched rather than translated into a
 * vendor type, and a batch of this size needs its own retry policy anyway. The
 * whole adapter is small enough to read in one sitting, which matters more here
 * than saving thirty lines.
 */
export function geminiCompleter(
  opts: { apiKey?: string; onRetry?: (status: number | null) => void } = {},
): Completer {
  const apiKey = opts.apiKey ?? process.env['GEMINI_API_KEY'];
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not set. Recorded decisions replay from .cache/llm without it; ' +
        'a live run needs it.',
    );
  }

  return async (req) => {
    const body = JSON.stringify({
      // Frozen and identical on every call, so it sits where implicit caching
      // can find it.
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        // The per-call schema, verbatim. `action_type` enumerates exactly what
        // the gate permits, so a forbidden action is undecodable rather than
        // discouraged.
        responseJsonSchema: req.schema,
        // These are small judgement calls and there are thousands of them.
        thinkingConfig: { thinkingLevel: thinkingLevelFor(req.model) },
      },
    });

    let lastError: ProviderError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${ENDPOINT}/${req.model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body,
        });
      } catch (err: unknown) {
        // A socket error is worth retrying; a bad schema is not, and this is
        // the former by construction.
        lastError = new ProviderError(
          `network: ${err instanceof Error ? err.message : String(err)}`,
          null,
          true,
        );
        opts.onRetry?.(null);
        await sleep(backoffMs(attempt, null));
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        const info = parseRetryInfo(body);

        if (
          info.status === 'RESOURCE_EXHAUSTED' &&
          info.retryAfterSeconds !== null &&
          info.retryAfterSeconds > QUOTA_WALL_SECONDS
        ) {
          const hours = (info.retryAfterSeconds / 3600).toFixed(1);
          throw new QuotaExhaustedError(
            `daily quota for ${req.model} is exhausted; it resets in about ${hours}h. ` +
              `Recorded decisions still replay from .cache/llm without it.`,
            info.retryAfterSeconds,
          );
        }

        const retryable = RETRYABLE.has(res.status);
        lastError = new ProviderError(`HTTP ${res.status}: ${body.slice(0, 300)}`, res.status, retryable);
        if (!retryable || attempt === MAX_ATTEMPTS) throw lastError;
        opts.onRetry?.(res.status);
        // The server's own advice beats our guess, and for a short throttle it
        // is in the body rather than in a Retry-After header.
        await sleep(
          info.retryAfterSeconds !== null
            ? Math.min(info.retryAfterSeconds * 1000, 60_000)
            : backoffMs(attempt, res.headers.get('retry-after')),
        );
        continue;
      }

      const json = (await res.json()) as GeminiResponse;
      const candidate = json.candidates?.[0];
      const finish = candidate?.finishReason;

      // STOP is the only finish reason that produced a complete answer. MAX_TOKENS
      // gives truncated JSON, SAFETY and RECITATION give none. Treating any of
      // them as a result would mean parsing a fragment and calling it a decision.
      if (finish !== undefined && finish !== 'STOP') {
        throw new ProviderError(`model stopped early: ${finish}`, null, false);
      }

      // The response part also carries a thought signature, which is not an
      // answer and is deliberately not read.
      const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (text.trim().length === 0) {
        throw new ProviderError('empty response body', null, false);
      }

      const u = json.usageMetadata ?? {};
      return {
        output: JSON.parse(text),
        tokens_in: u.promptTokenCount ?? 0,
        // Thinking is billed as output and is most of the output on a reasoning
        // model. Reporting only the visible answer would understate the run's
        // real cost by several times, which is the kind of number that has to
        // be right in a README.
        tokens_out: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      };
    }

    throw lastError ?? new ProviderError('exhausted retries', null, false);
  };
}

/** Exponential with full jitter, and the server's own advice when it gives any. */
function backoffMs(attempt: number, retryAfter: string | null): number {
  const advised = retryAfter === null ? NaN : Number(retryAfter) * 1000;
  if (Number.isFinite(advised)) return Math.min(advised, 60_000);
  return Math.min(1000 * 2 ** (attempt - 1), 32_000) * (0.5 + Math.random() * 0.5);
}
