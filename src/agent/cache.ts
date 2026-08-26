import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../domain/canonical.js';
import { REPO_ROOT } from '../domain/paths.js';
import { AgentOutputSchema, type AgentOutput } from './schema.js';

/**
 * A committed decision cache, keyed on what the model was actually asked.
 *
 * WHY THIS EXISTS
 *
 * Without it, `npm run eval` needs an API key, costs money, and produces a
 * slightly different number every time - which would make every claim in the
 * README unreproducible by anyone reading it. With it, a reviewer clones the
 * repo and replays the exact decisions that produced the committed results.
 *
 * WHY THE KEY IS WHAT IT IS
 *
 * The key covers the prompt version, the model, the observation hash AND the
 * permitted set. The observation alone is not enough: the same case at the same
 * instant can present a different permitted set if a rule changes, and reusing
 * an answer chosen from a different menu would be silently wrong.
 *
 * WHAT THIS IS NOT
 *
 * It is not a way of pretending the agent is deterministic. The model is
 * sampled once per distinct situation and that sample is frozen; the honest
 * description is "these are recorded decisions", and the README says so. The
 * `--no-cache` flag re-queries live for anyone who wants to check that the
 * cached answers are representative rather than cherry-picked.
 */

export const CACHE_DIR = path.join(REPO_ROOT, '.cache', 'llm');

export interface CacheEntry {
  key: string;
  prompt_version: string;
  model: string;
  observation_hash: string;
  output: AgentOutput;
  tokens_in: number;
  tokens_out: number;
  /** When this decision was first obtained from the API. */
  recorded_at: string;
}

export function cacheKey(input: {
  prompt_version: string;
  model: string;
  observation_hash: string;
  permitted: readonly string[];
  permitted_channels: readonly string[];
}): string {
  return createHash('sha256')
    .update(
      canonicalJson([
        input.prompt_version,
        input.model,
        input.observation_hash,
        [...input.permitted].sort(),
        [...input.permitted_channels].sort(),
      ]),
    )
    .digest('hex')
    .slice(0, 32);
}

/**
 * Decisions written since the last flush before one is forced.
 *
 * A full batch is an hour of paid API calls, and the flush at the end of the
 * run is no use at all if the process dies in minute fifty. Checkpointing costs
 * one file write per five hundred decisions and means a crash loses seconds of
 * work instead of everything.
 */
const AUTOFLUSH_EVERY = 500;

export class DecisionCache {
  private readonly entries = new Map<string, CacheEntry>();
  private dirty = false;
  private sinceFlush = 0;
  hits = 0;
  misses = 0;

  constructor(private readonly dir: string = CACHE_DIR) {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const raw = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as unknown;
      for (const e of Array.isArray(raw) ? raw : [raw]) {
        const entry = e as CacheEntry;
        // Validate on load. A cache entry that no longer satisfies the output
        // schema is from an older contract, and quietly feeding it to the
        // runner would produce a decision the current code cannot justify.
        const parsed = AgentOutputSchema.safeParse(entry.output);
        if (parsed.success) this.entries.set(entry.key, { ...entry, output: parsed.data });
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): AgentOutput | null {
    const hit = this.entries.get(key);
    if (hit) {
      this.hits++;
      return hit.output;
    }
    this.misses++;
    return null;
  }

  put(entry: CacheEntry): void {
    this.entries.set(entry.key, entry);
    this.dirty = true;
    if (++this.sinceFlush >= AUTOFLUSH_EVERY) this.flush();
  }

  /**
   * Written as one sorted file rather than a file per entry: thousands of tiny
   * files make a repository unpleasant to read and produce enormous diffs.
   * Sorting by key keeps the diff between two runs meaningful - only genuinely
   * new decisions appear.
   */
  flush(): void {
    if (!this.dirty) return;
    mkdirSync(this.dir, { recursive: true });
    const sorted = [...this.entries.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
    writeFileSync(
      path.join(this.dir, 'decisions.json'),
      JSON.stringify(sorted, null, 1) + '\n',
    );
    this.dirty = false;
    this.sinceFlush = 0;
  }
}
