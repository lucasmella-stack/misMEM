import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { domAnimation, LazyMotion, MotionConfig } from "motion/react";
import "./styles.css";
import { App } from "./App";
import { applyTheme, browserStorage, loadTheme, resolveTheme } from "./lib/theme";

// The server CSP forbids inline scripts, so the theme cannot be set from index.html: it is
// applied here, before the first render, to avoid painting one theme and jumping to another.
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
applyTheme(document.documentElement, resolveTheme(loadTheme(browserStorage()), prefersDark));

// Reads are shared across views; a write invalidates what it touches. No aggressive retries:
// a network failure must surface the notice soon, not hide it.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* `user` honours prefers-reduced-motion: micro-interactions are not imposed. */}
      <MotionConfig reducedMotion="user">
        {/* `strict` forces `m` and keeps the full motion API out of the bundle. */}
        <LazyMotion features={domAnimation} strict>
          <App />
        </LazyMotion>
      </MotionConfig>
    </QueryClientProvider>
  </StrictMode>,
);
