import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // The UI's own alias (ui/vite.config.ts), so a test can render a component that imports `@/...`.
  resolve: { alias: { "@": fileURLToPath(new URL("./ui/src", import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "tests/integration/**"],
    environment: "node",
    // Code that reads the real embedding config (the consolidation backfill, recall without an
    // injected embedFn) would otherwise call the developer's Ollama; a test that wants it stubs fetch.
    env: { MISMEM_EMBEDDINGS: "off" },
  },
});
