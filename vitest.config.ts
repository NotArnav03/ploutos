import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Thirty seconds, not vitest's default five.
     *
     * Most tests here are not unit tests. They run real batches through the
     * real harness - hundreds of cases, a full gzipped ledger write apiece -
     * because the properties worth asserting in this project (determinism,
     * chain integrity, the ceiling invariant, harm counts) are properties of
     * whole runs and cannot be observed on a mock.
     *
     * A five-second default made those tests fail by timeout while their
     * assertions never ran, and report it as the assertion failing. The
     * determinism test took 4,997ms alone and tipped over the moment anything
     * else in the file added load, which read as "determinism broke" for
     * several minutes of investigation. A timeout dressed as a correctness
     * failure is worse than a slow suite.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
