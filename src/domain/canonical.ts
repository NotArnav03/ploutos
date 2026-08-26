/**
 * Order-independent serialisation, for anything that gets hashed.
 *
 * `JSON.stringify` preserves key insertion order, which makes any hash built on
 * it sensitive to the order a caller happened to construct an object in. That
 * is a trap rather than a preference, and it caught this project on day 4:
 *
 *   - `block()` built exclusions as { action_type, rule_id, detail, channel }
 *   - the stop path built them as { action_type, rule_id, channel, detail }
 *   - zod rebuilds objects in SCHEMA declaration order when it parses
 *
 * So the ledger hashed the raw object in construction order, then wrote the
 * zod-parsed object in schema order, and 73 of 1,000 records failed to verify
 * against their own content. Nothing was tampered with; the hash was simply
 * asking a question about key order that it never meant to ask.
 *
 * Sorting keys makes the hash a function of content alone, which is the only
 * thing it was ever supposed to attest to.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
