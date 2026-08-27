import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/domain/paths.js';

/**
 * The latent/observable boundary, enforced by the build.
 *
 * `src/world` holds ground truth the agent must not see. If the decision path
 * could import it, every recovery number this project reports would be an
 * artifact of the agent reading the answer key. A comment asking people not to
 * do that is worth nothing on day 9 at midnight, so this test fails the build
 * instead.
 */

const FORBIDDEN: ReadonlyArray<{ dir: string; mustNotImport: string; why: string }> = [
  {
    dir: 'src/agent',
    mustNotImport: 'world',
    why: 'the agent would be reading ground truth it is supposed to infer',
  },
  {
    dir: 'src/policy',
    mustNotImport: 'world',
    why: 'policy decisions must be reproducible from the observable record alone',
  },
  {
    dir: 'src/domain',
    mustNotImport: 'world',
    why: 'the observable domain must not depend on the simulator',
  },
  // The second boundary: the evaluation must never reach a live gateway.
  //
  // src/razorpay talks to api.razorpay.com. If the decision path or the harness
  // could import it, a measured number could come to depend on a network call,
  // a test key, or a merchant account being up - and the claim that
  // `npm run eval` runs offline from committed decisions would quietly stop
  // being true.
  {
    dir: 'src/eval',
    mustNotImport: 'razorpay',
    why: 'a measured run must never depend on a live gateway being reachable',
  },
  {
    dir: 'src/policy',
    mustNotImport: 'razorpay',
    why: 'policy decisions must not depend on a network call',
  },
  {
    dir: 'src/agent',
    mustNotImport: 'razorpay',
    why: 'the agent decides from the observation, not from a gateway lookup',
  },
  {
    dir: 'src/domain',
    mustNotImport: 'razorpay',
    why: 'the domain model must not depend on one gateway vendor',
  },
];

function tsFilesIn(dir: string): string[] {
  const abs = path.join(REPO_ROOT, dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return []; // directory not created yet; nothing to check
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(abs, e);
    if (statSync(full).isDirectory()) out.push(...tsFilesIn(path.join(dir, e)));
    else if (e.endsWith('.ts')) out.push(full);
  }
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]{0,200}?from\s+['"]([^'"]+)['"]/g;

function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const specs: string[] = [];
  for (const m of src.matchAll(IMPORT_RE)) if (m[1]) specs.push(m[1]);
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) if (m[1]) specs.push(m[1]);
  return specs;
}

describe('module boundary', () => {
  for (const { dir, mustNotImport, why } of FORBIDDEN) {
    it(`${dir} never imports ${mustNotImport} (${why})`, () => {
      const offenders: string[] = [];
      for (const file of tsFilesIn(dir)) {
        for (const spec of importsOf(file)) {
          const resolved = spec.startsWith('.')
            ? path.relative(REPO_ROOT, path.resolve(path.dirname(file), spec))
            : spec;
          const normalised = resolved.split(path.sep).join('/');
          if (normalised.startsWith(`src/${mustNotImport}`) || normalised === mustNotImport) {
            offenders.push(`${path.relative(REPO_ROOT, file)} -> ${spec}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it('keeps the latent state out of the observable schema module', () => {
    const schemas = readFileSync(path.join(REPO_ROOT, 'src/domain/schemas.ts'), 'utf8');
    for (const leak of ['balance_refill_day', 'true_mandate_status', 'intent', 'recoverable']) {
      expect(schemas.includes(leak), `schemas.ts mentions latent field ${leak}`).toBe(false);
    }
  });
});
