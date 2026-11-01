// A consolidation run started from the UI, in the background. It takes minutes and an HTTP request
// cannot wait, so the server keeps its log and the UI polls. One at a time: two runs over the same
// episodes would distill and pay twice.
import type { Database as DB } from "better-sqlite3";
import { loadLlmConfig, type LlmConfig } from "./llm.js";
import { runConsolidation, type RunOptions, type RunSummary } from "./run.js";

/** What the log keeps: the latest is enough to see where it is. */
const MAX_LOG_LINES = 200;

export interface JobState {
  running: boolean;
  scope: string | null;
  started_at: number | null;
  finished_at: number | null;
  log: string[];
  summary: RunSummary | null;
  error: string | null;
}

export class JobError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "JobError";
  }
}

export class ConsolidationJob {
  private current: JobState = {
    running: false,
    scope: null,
    started_at: null,
    finished_at: null,
    log: [],
    summary: null,
    error: null,
  };
  private done: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: DB,
    private readonly loadConfig: () => LlmConfig = loadLlmConfig,
    private readonly run: typeof runConsolidation = runConsolidation,
  ) {}

  state(): JobState {
    return { ...this.current, log: [...this.current.log] };
  }

  /** For tests and shutdown: waits for the run in progress. */
  finished(): Promise<void> {
    return this.done;
  }

  start(scope?: string, extra: Partial<RunOptions> = {}): JobState {
    if (this.current.running) throw new JobError(409, "ya hay una consolidación en curso");
    let llm: LlmConfig;
    try {
      llm = this.loadConfig();
    } catch (err) {
      // Without a key nothing starts: better to say it now than after a minute of "running".
      throw new JobError(400, err instanceof Error ? err.message : String(err));
    }

    this.current = {
      running: true,
      scope: scope ?? null,
      started_at: Date.now(),
      finished_at: null,
      log: [],
      summary: null,
      error: null,
    };
    const log = (line: string): void => {
      this.current.log.push(line);
      if (this.current.log.length > MAX_LOG_LINES) this.current.log.shift();
    };

    this.done = this.run(this.db, { scopeFilter: scope, llm, log, ...extra }).then(
      (summary) => {
        this.current = { ...this.current, running: false, finished_at: Date.now(), summary };
      },
      (err: unknown) => {
        this.current = {
          ...this.current,
          running: false,
          finished_at: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        };
      },
    );
    return this.state();
  }
}
