import { defineConfig } from "vitest/config";

// Against a real embedding server: `pnpm test:integration`. The code's defaults are the EmbeddingGemma 2
// setup that scripts/install.sh writes; any MISMEM_EMBEDDING_* already in the environment wins.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      MISMEM_EMBEDDINGS: "auto",
      MISMEM_EMBEDDING_TIMEOUT_MS: process.env.MISMEM_EMBEDDING_TIMEOUT_MS ?? "30000",
    },
  },
});
