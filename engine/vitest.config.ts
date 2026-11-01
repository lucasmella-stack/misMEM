import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "tests/integration/**"],
    environment: "node",
    // Code that reads the real embedding config (the consolidation backfill, recall without an
    // injected embedFn) would otherwise call the developer's embedding server; a test that wants it stubs fetch.
    env: { MISMEM_EMBEDDINGS: "off" },
  },
});
