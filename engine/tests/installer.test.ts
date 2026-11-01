// Runs scripts/install.sh for real in a sandboxed HOME: nothing else exercises its decisions,
// and a wrong port or a missing package manager only shows up on a stranger's machine.

import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const REPO = new URL("../../", import.meta.url).pathname;
const INSTALLER = join(REPO, "scripts/install.sh");

interface Sandbox {
  root: string;
  bin: string;
  home: string;
  env: NodeJS.ProcessEnv;
  envFile: string;
}

/** Every sandbox made, so afterEach can remove them: 228 of them had piled up in /tmp. */
const roots: string[] = [];

/** A HOME of its own, plus stubs so no real llama-server or systemd service is touched. */
function sandbox(stubLlama = true): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "mismem-install-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (stubLlama) {
    writeFileSync(join(bin, "llama-server"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "llama-server"), 0o755);
  }
  // Without a user systemd the installer only prints the command, so no unit is written or started.
  writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "systemctl"), 0o755);
  const gguf = join(root, "model.gguf");
  writeFileSync(gguf, "");
  roots.push(root);
  return {
    root,
    bin,
    home,
    envFile: join(home, ".config/mismem/env"),
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      MISMEM_INSTALL_DB: join(home, "mem.db"),
      MISMEM_INSTALL_GEMMA_GGUF: gguf,
    },
  };
}

/** pnpm resolves its store under HOME, and the sandbox moves HOME: without this it reinstalls from zero. */
let storeDir: string | undefined;
async function pnpmStore(): Promise<string> {
  storeDir ??= await run("pnpm", ["store", "path"]).then(
    (r) => r.stdout.trim(),
    () => "",
  );
  return storeDir;
}

async function install(box: Sandbox, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...box.env,
    PNPM_HOME: process.env.PNPM_HOME,
    npm_config_store_dir: await pnpmStore(),
    ...extra,
  };
  try {
    return await run("bash", [INSTALLER, "--yes", "--clients", "none", "--no-timer", ...args], { env });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    // execFile's message drops the output, and without it a CI failure says nothing.
    throw Object.assign(new Error(`${failure.stdout ?? ""}\n${failure.stderr ?? ""}`.trim()), failure);
  }
}

const written = (box: Sandbox, name: string): string | undefined =>
  readFileSync(box.envFile, "utf8")
    .split("\n")
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1);

/** The same PATH without the entries that provide pnpm; node has to survive or the setup is wrong. */
async function withoutPnpm(path: string): Promise<string> {
  const entries = path.split(":").filter(Boolean);
  const kept: string[] = [];
  for (const dir of entries) {
    const hasPnpm = await run("test", ["-x", join(dir, "pnpm")]).then(
      () => true,
      () => false,
    );
    if (!hasPnpm) kept.push(dir);
  }
  const out = kept.join(":");
  await run("env", [`PATH=${out}`, "node", "-e", ""]);
  return out;
}

const servers: Server[] = [];

/** Something already holding the port: `health` says whether it looks like an embedding server. */
function occupy(port: number, health: boolean): Promise<void> {
  const server = createServer((req, res) => {
    res.writeHead(health && req.url === "/health" ? 200 : 404).end();
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("install.sh", () => {
  it(
    "mueve el puerto de los embeddings cuando lo ocupa algo que no los sirve",
    async () => {
      const box = sandbox();
      await occupy(18180, false);
      const { stdout } = await install(box, ["--embeddings", "gemma"], {
        MISMEM_INSTALL_GEMMA_PORT: "18180",
      });
      expect(written(box, "MISMEM_EMBEDDING_URL")).toBe("http://127.0.0.1:18181");
      expect(stdout).toContain("--port 18181");
    },
    60_000,
  );

  it(
    "se queda en el puerto pedido cuando está libre",
    async () => {
      const box = sandbox();
      const { stdout } = await install(box, ["--embeddings", "gemma"], {
        MISMEM_INSTALL_GEMMA_PORT: "18190",
      });
      expect(written(box, "MISMEM_EMBEDDING_URL")).toBe("http://127.0.0.1:18190");
      expect(stdout).toContain("--port 18190");
    },
    60_000,
  );

  it(
    "usa el servidor de embeddings que ya responde en el puerto en vez de mudarse",
    async () => {
      const box = sandbox();
      await occupy(18200, true);
      await install(box, ["--embeddings", "gemma"], { MISMEM_INSTALL_GEMMA_PORT: "18200" });
      expect(written(box, "MISMEM_EMBEDDING_URL")).toBe("http://127.0.0.1:18200");
    },
    60_000,
  );

  it(
    "respeta el puerto que escribió una instalación anterior",
    async () => {
      const box = sandbox();
      mkdirSync(join(box.home, ".config/mismem"), { recursive: true });
      writeFileSync(
        box.envFile,
        "MISMEM_EMBEDDING_URL=http://127.0.0.1:18210\nMISMEM_EMBEDDING_MODEL=embeddinggemma-2\n",
      );
      await install(box, ["--embeddings", "gemma"]);
      expect(written(box, "MISMEM_EMBEDDING_URL")).toBe("http://127.0.0.1:18210");
    },
    60_000,
  );

  it(
    "cuando pnpm falla, su error se ve en vez de desaparecer",
    async () => {
      const box = sandbox();
      // pnpm writes its errors to stdout, so `>/dev/null` discarded exactly the line that says
      // why the install aborted: the script failed with no output at all.
      writeFileSync(join(box.bin, "pnpm"), '#!/bin/sh\necho "ERR_PNPM_DE_PEGA: el lockfile no cuadra"\nexit 1\n');
      chmodSync(join(box.bin, "pnpm"), 0o755);

      await expect(install(box, [])).rejects.toMatchObject({
        stdout: expect.stringContaining("ERR_PNPM_DE_PEGA"),
      });
    },
    60_000,
  );

  it(
    "desde el repo sin pnpm explica qué falta en vez de volcar un error de npm",
    async () => {
      const box = sandbox();
      // The repo ships only pnpm-lock.yaml, so `npm ci` could never have worked.
      const path = await withoutPnpm(box.env.PATH ?? "");
      await expect(install({ ...box, env: { ...box.env, PATH: path } }, [])).rejects.toMatchObject({
        stdout: expect.stringContaining("pnpm"),
      });
    },
    60_000,
  );
});
