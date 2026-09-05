import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    env: {
      // The workspace graph persists itself to the user's cache directory between
      // processes. A test run creates and destroys dozens of throwaway workspaces, so it
      // would litter that directory and — worse — let one test's disk state reach
      // another's. The persistence tests switch it back on for themselves, pointed at a
      // temporary directory of their own.
      CODE_INTEL_GRAPH_CACHE: 'off'
    }
  }
});
