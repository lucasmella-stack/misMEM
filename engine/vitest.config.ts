import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The same alias as tsconfig.json and ui/vite.config.ts: a rendered component imports `@/`.
    alias: { "@": fileURLToPath(new URL("./ui/src", import.meta.url)) },
  },
  test: {
    // .tsx too: a test that renders a component carries JSX.
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: [...configDefaults.exclude, "tests/integration/**"],
    environment: "node",
    // Code that reads the real embedding config (the consolidation backfill, recall without an
    // injected embedFn) would otherwise call the developer's embedding server; a test that wants it stubs fetch.
    env: { MISMEM_EMBEDDINGS: "off" },
  },
});
