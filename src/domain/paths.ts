import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Repo root, resolved from this module rather than from process.cwd(), so the
 *  CLI behaves the same however it is invoked. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CONFIG_DIR = path.join(REPO_ROOT, 'config');
export const DATA_DIR = path.join(REPO_ROOT, 'data');
export const BATCH_DIR = path.join(DATA_DIR, 'batches');
export const RESULTS_DIR = path.join(REPO_ROOT, 'results');
export const CACHE_DIR = path.join(REPO_ROOT, '.cache', 'llm');

export const TAXONOMY_PATH = path.join(CONFIG_DIR, 'failure_taxonomy.yaml');
export const RULES_PATH = path.join(CONFIG_DIR, 'rules_registry.yaml');
export const MIX_PATH = path.join(CONFIG_DIR, 'failure_mix.yaml');

export const COSTS_PATH = path.join(CONFIG_DIR, 'costs.yaml');
