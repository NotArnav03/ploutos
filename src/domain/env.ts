import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './paths.js';

export const ENV_PATH = path.join(REPO_ROOT, '.env');

let loaded = false;

/**
 * Load `.env` into the environment, for CLI entry points only.
 *
 * WHY NOT A DEPENDENCY
 *
 * This is a dozen lines and the file format is two rules. A package for it
 * would be one more thing a reviewer has to trust in a repo whose whole
 * argument is that its claims are checkable.
 *
 * WHY A SHELL VARIABLE WINS
 *
 * Anything already set in the environment is left alone. A stale key sitting in
 * a `.env` file silently overriding the one someone just exported is a very
 * annoying half hour, and the conventional precedence avoids it.
 *
 * Not called from library code or tests - only from the CLIs, so that a test
 * run never depends on what happens to be in a developer's `.env`.
 */
/** Where a variable's value came from, for reporting. */
export type EnvSource = 'shell' | '.env' | 'unset';

const sources = new Map<string, EnvSource>();

/**
 * Which source supplied a variable, and a masked form of its value.
 *
 * Shell precedence is the right default, but it silently ignores a key someone
 * has just written into `.env` - which happened here, for a whole afternoon of
 * paid runs against a key the operator believed was not in use. A rule that
 * quietly picks one of two credentials has to say which one it picked.
 */
export function describeEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.length === 0) return `${key} is not set`;
  const masked =
    value.length <= 10 ? '***' : `${value.slice(0, 4)}...${value.slice(-3)}`;
  return `${key} ${masked} (${sources.get(key) ?? 'shell'})`;
}

export function loadEnv(file: string = ENV_PATH): void {
  // The once-only guard is about not re-reading the default file on every CLI
  // entry point. An explicit path is a caller asking for this file now, which
  // is what makes the precedence rule testable rather than merely asserted.
  if (file === ENV_PATH) {
    if (loaded) return;
    loaded = true;
  }
  if (!existsSync(file)) return;

  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) {
      sources.set(key, 'shell');
      continue;
    }
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length > 0) {
      process.env[key] = value;
      sources.set(key, '.env');
    }
  }
}
