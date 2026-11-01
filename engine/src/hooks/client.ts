// Minimal client for the hooks to talk to misMEM: the remote server over JSON-RPC when
// MISMEM_HOOK_URL is set, the local database otherwise. A hook runs every turn, so everything
// has a timeout and nothing throws upwards without the caller deciding what to do.

/** The server frames JSON-RPC as SSE: the payload comes in a `data:` line. */
function parseRpc(body: string): unknown {
  const line = body.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : body);
}

interface RpcResponse {
  result?: unknown;
  error?: { message?: string };
}

function authHeader(): string | undefined {
  // The whole header avoids copying the credential into a new variable: the hook can take it
  // from where it already lives (the client's MCP config) and pass it through as is.
  const direct = process.env.MISMEM_HOOK_AUTH_HEADER;
  if (direct) return direct;
  const basic = process.env.MISMEM_HOOK_AUTH;
  return basic ? `Basic ${Buffer.from(basic).toString("base64")}` : undefined;
}

/** One JSON-RPC call to `/mcp`. The server requests no handshake for `tools/*`. */
async function rpc(
  url: string,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const auth = authHeader();
  if (auth) headers.authorization = auth;

  const res = await fetch(`${url.replace(/\/+$/, "")}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const parsed = parseRpc(await res.text()) as RpcResponse;
  if (parsed.error) throw new Error(parsed.error.message ?? "error del servidor");
  return parsed.result;
}

/** With a stdin nobody closes, a hook would wait forever and hang the turn. */
const STDIN_TIMEOUT_MS = 2000;

/** The hook payload from stdin; empty on a TTY or after the timeout. Never rejects. */
export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve("");
    const done = (): void => {
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(done, STDIN_TIMEOUT_MS);
    timer.unref();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

/** Calls a tool and returns the JSON it put in the text. */
export async function callRemoteTool(
  url: string,
  name: string,
  args: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const result = (await rpc(url, "tools/call", { name, arguments: args }, timeoutMs)) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = result?.content?.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : undefined;
}

/** Which tools the server exposes, so an old version is not asked for more. */
export async function remoteToolNames(url: string, timeoutMs: number): Promise<string[]> {
  const result = (await rpc(url, "tools/list", {}, timeoutMs)) as {
    tools?: Array<{ name?: string }>;
  };
  return (result?.tools ?? []).map((t) => t.name ?? "").filter(Boolean);
}
