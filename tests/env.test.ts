import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/domain/env.js';

const tmp = mkdtempSync(path.join(tmpdir(), 'env-'));

function envFile(body: string): string {
  const p = path.join(tmp, `e-${Math.random().toString(36).slice(2)}`);
  writeFileSync(p, body);
  return p;
}

describe('.env loading', () => {
  it('reads a key, ignores comments and blank lines, and strips quotes', () => {
    delete process.env['VASOOLI_TEST_A'];
    delete process.env['VASOOLI_TEST_B'];
    loadEnv(envFile('# a comment\n\nVASOOLI_TEST_A=plain-value\nVASOOLI_TEST_B="quoted value"\n'));
    expect(process.env['VASOOLI_TEST_A']).toBe('plain-value');
    expect(process.env['VASOOLI_TEST_B']).toBe('quoted value');
  });

  it('never overrides something already in the environment', () => {
    // A stale key in a .env file silently beating the one someone just
    // exported is a very annoying half hour.
    process.env['VASOOLI_TEST_C'] = 'from-the-shell';
    loadEnv(envFile('VASOOLI_TEST_C=from-the-file\n'));
    expect(process.env['VASOOLI_TEST_C']).toBe('from-the-shell');
  });

  it('leaves an empty assignment unset rather than setting an empty key', () => {
    // .env.example ships with `GEMINI_API_KEY=` and copying it verbatim must
    // read as "no key", not as a key that is the empty string - otherwise the
    // error message says the key is set and the API says it is invalid.
    delete process.env['VASOOLI_TEST_D'];
    loadEnv(envFile('VASOOLI_TEST_D=\n'));
    expect(process.env['VASOOLI_TEST_D']).toBeUndefined();
  });
});
