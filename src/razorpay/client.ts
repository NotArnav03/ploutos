/**
 * A thin Razorpay REST client, used only by the adapter demo.
 *
 * WHAT THIS IS FOR
 *
 * The evaluation in this repository runs against a simulated world and must
 * keep running offline, with no key and no network. This client exists to show
 * that the actions the agent chooses correspond to real API calls on a real
 * payment gateway — not to put a network call anywhere near a measured number.
 *
 * `tests/boundary.test.ts` fails the build if anything under `src/eval`,
 * `src/policy`, `src/agent` or `src/domain` imports this directory.
 */

const BASE = 'https://api.razorpay.com/v1';

export interface RazorpayCredentials {
  key_id: string;
  key_secret: string;
}

/**
 * Razorpay's structured error envelope.
 *
 * The fields are documented; the full set of `reason` values is not published
 * anywhere machine-readable, so this type carries the reason through as an
 * opaque string rather than an enum we would have had to guess at.
 */
export interface RazorpayError {
  code: string;
  description: string;
  source: string | null;
  step: string | null;
  reason: string | null;
}

export class RazorpayApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: RazorpayError | null,
  ) {
    super(message);
    this.name = 'RazorpayApiError';
  }
}

/** One request and its response, with credentials removed. For the transcript. */
export interface TranscriptEntry {
  method: string;
  path: string;
  request: unknown;
  status: number;
  response: unknown;
}

/**
 * Replace anything credential-shaped with a placeholder.
 *
 * Applied to the whole transcript before it is written, rather than trusting
 * that no response ever echoes a key back. The repository ships this file, so
 * "probably no secrets in there" is not good enough.
 */
export function redact<T>(value: T, creds: RazorpayCredentials): T {
  const asText = JSON.stringify(value);
  if (asText === undefined) return value;
  const cleaned = asText
    .split(creds.key_secret)
    .join('<REDACTED_KEY_SECRET>')
    .replace(/rzp_(test|live)_[A-Za-z0-9]+/g, 'rzp_test_<REDACTED>')
    .replace(/Basic [A-Za-z0-9+/=]{16,}/g, 'Basic <REDACTED>');
  return JSON.parse(cleaned) as T;
}

export function loadCredentials(): RazorpayCredentials {
  const key_id = process.env['RAZORPAY_KEY_ID'];
  const key_secret = process.env['RAZORPAY_KEY_SECRET'];
  if (!key_id || !key_secret) {
    throw new Error(
      'RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not set. This demo is the only ' +
        'thing in the repository that needs them; `npm run eval` does not.',
    );
  }
  if (!key_id.startsWith('rzp_test_')) {
    // A live key here would create real payment links against a real merchant.
    throw new Error(
      `refusing to run against ${key_id.slice(0, 9)}...: this demo is test-mode only`,
    );
  }
  return { key_id, key_secret };
}

export class RazorpayClient {
  readonly transcript: TranscriptEntry[] = [];

  constructor(private readonly creds: RazorpayCredentials) {}

  private auth(): string {
    return (
      'Basic ' +
      Buffer.from(`${this.creds.key_id}:${this.creds.key_secret}`).toString('base64')
    );
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(BASE + path, {
      method,
      headers: { authorization: this.auth(), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }

    this.transcript.push(
      redact({ method, path, request: body ?? null, status: res.status, response: parsed }, this.creds),
    );

    if (!res.ok) {
      // Razorpay returns a structured envelope for most failures and a bare
      // {"error":"Unauthorized"} when a product is not enabled on the account.
      // Both are handled, because the second is the one this account actually
      // hit and it would otherwise crash on a missing field.
      const envelope = (parsed as { error?: unknown }).error;
      const detail =
        envelope !== null && typeof envelope === 'object'
          ? (envelope as RazorpayError)
          : null;
      throw new RazorpayApiError(
        detail
          ? `${detail.code}: ${detail.description}`
          : `HTTP ${res.status}: ${typeof envelope === 'string' ? envelope : text.slice(0, 120)}`,
        res.status,
        detail,
      );
    }
    return parsed as T;
  }
}
