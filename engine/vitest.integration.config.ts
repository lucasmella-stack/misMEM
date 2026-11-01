import { defineConfig } from "vitest/config";

// Against a real embedding server: `pnpm test:integration`. Defaults to the EmbeddingGemma 2 setup that
// scripts/install.sh writes; any MISMEM_EMBEDDING_* already in the environment wins.
const fromEnv = (name: string, fallback: string) => process.env[name] ?? fallback;

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      MISMEM_EMBEDDINGS: "auto",
      MISMEM_EMBEDDING_PROVIDER: fromEnv("MISMEM_EMBEDDING_PROVIDER", "openai"),
      MISMEM_EMBEDDING_URL: fromEnv("MISMEM_EMBEDDING_URL", "http://127.0.0.1:8080"),
      MISMEM_EMBEDDING_MODEL: fromEnv("MISMEM_EMBEDDING_MODEL", "embeddinggemma-2"),
      MISMEM_EMBEDDING_QUERY_PREFIX: fromEnv("MISMEM_EMBEDDING_QUERY_PREFIX", "task: search result | query: "),
      MISMEM_EMBEDDING_DOC_PREFIX: fromEnv("MISMEM_EMBEDDING_DOC_PREFIX", "title: none | text: "),
      MISMEM_EMBEDDING_MIN_SCORE: fromEnv("MISMEM_EMBEDDING_MIN_SCORE", "0.65"),
      MISMEM_EMBEDDING_TIMEOUT_MS: fromEnv("MISMEM_EMBEDDING_TIMEOUT_MS", "30000"),
    },
  },
});
