import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CACHE_DIR } from '../src/agent/cache.js';
import { PROMPT_VERSION } from '../src/agent/prompt.js';
import path from 'node:path';

describe('committed state reproduces itself', () => {
  it('has recorded decisions for the prompt version in HEAD', () => {
    // The repo's central claim is that a reviewer can clone it and replay the
    // committed numbers without an API key. That breaks silently the moment the
    // prompt is edited without a re-run: PROMPT_VERSION is part of the cache
    // key, so every lookup misses and `npm run eval` quietly becomes thousands
    // of live calls against whatever quota the reviewer happens to have.
    //
    // This is exactly what day 6 shipped for half an hour, so it is now a test.
    const file = path.join(CACHE_DIR, 'decisions.json');
    if (!existsSync(file)) return; // a fresh clone before any run has happened
    const entries = JSON.parse(readFileSync(file, 'utf8')) as {
      prompt_version: string;
      model: string;
    }[];
    const versions = new Set(entries.map((e) => e.prompt_version));
    expect(
      versions.has(PROMPT_VERSION),
      `prompt is at ${PROMPT_VERSION} but the committed cache only has ` +
        `[${[...versions].join(', ')}]. Either re-run to record decisions for ` +
        `${PROMPT_VERSION}, or keep the unmeasured prompt on a branch.`,
    ).toBe(true);
  });

  it('has recorded decisions for the model in HEAD', async () => {
    // The same trap as the prompt version, one field over. The cache key
    // includes the model, so pointing AGENT_MODEL at a cheaper model before
    // that model has recorded a run turns `npm run eval` from a two-second
    // replay into thousands of live calls - silently, and against whatever
    // quota the reviewer happens to have.
    const { AGENT_MODEL } = await import('../src/agent/provider.js');
    const file = path.join(CACHE_DIR, 'decisions.json');
    if (!existsSync(file)) return;
    const entries = JSON.parse(readFileSync(file, 'utf8')) as { model: string }[];
    const models = new Set(entries.map((e) => e.model));
    expect(
      models.has(AGENT_MODEL),
      `AGENT_MODEL is ${AGENT_MODEL} but the committed cache only has ` +
        `[${[...models].join(', ')}]. Record a run on ${AGENT_MODEL} before ` +
        `making it the default, or leave the default on the model the ` +
        `committed checkpoint actually used.`,
    ).toBe(true);
  });
});

describe('the default configuration replays offline', () => {
  it('has recorded decisions for the DEFAULT prompt and model together', async () => {
    // The two separate checks above can both pass while the pair fails: v2 has
    // decisions and gemini-3.7-flash has decisions, but v2 ON gemini-3.7-flash
    // was never finished, so defaulting to that pair would turn a two-second
    // replay into thousands of live calls against a reviewer's own quota.
    //
    // `npm run eval` with no flags is the command the README tells people to
    // run. This asserts that command costs nothing.
    const { AGENT_MODEL } = await import('../src/agent/provider.js');
    const file = path.join(CACHE_DIR, 'decisions.json');
    if (!existsSync(file)) return;
    const entries = JSON.parse(readFileSync(file, 'utf8')) as {
      model: string;
      prompt_version: string;
    }[];
    const pairs = new Set(entries.map((e) => `${e.prompt_version} + ${e.model}`));
    const wanted = `${PROMPT_VERSION} + ${AGENT_MODEL}`;
    expect(
      pairs.has(wanted),
      `the default pair is ${wanted}, which has no recorded decisions. ` +
        `Recorded pairs: [${[...pairs].sort().join(', ')}]. Point the defaults at ` +
        `a pair that replays, or record the missing one.`,
    ).toBe(true);
  });
});

describe('the committed cache cannot be forged by accident', () => {
  it('refuses a stubbed completer that would write to the real cache', async () => {
    const { makeAgent } = await import('../src/agent/agent.js');
    expect(() =>
      makeAgent({
        complete: async () => ({ output: {}, tokens_in: 0, tokens_out: 0 }),
      }),
    ).toThrow(/must be given its own cache/);
  });

  it('every committed decision carries a real token count', async () => {
    // A decision that cost zero tokens did not come from the API. This is the
    // cheap, blunt check that fabricated entries have not crept in.
    const { CACHE_DIR } = await import('../src/agent/cache.js');
    const file = path.join(CACHE_DIR, 'decisions.json');
    if (!existsSync(file)) return;
    const entries = JSON.parse(readFileSync(file, 'utf8')) as { tokens_in: number }[];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter((e) => e.tokens_in === 0)).toEqual([]);
  });
});
