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
        thinkingConfig: { thinkingLevel: 'low' },
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
        const detail = (await res.text()).slice(0, 300);
        const retryable = RETRYABLE.has(res.status);
        lastError = new ProviderError(`HTTP ${res.status}: ${detail}`, res.status, retryable);
        if (!retryable || attempt === MAX_ATTEMPTS) throw lastError;
        opts.onRetry?.(res.status);
        await sleep(backoffMs(attempt, res.headers.get('retry-after')));
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
