/**
 * Dump all Engram observations to JSONL via the Engram MCP server.
 * Reuses the same supergateway path as VS Code's mcp.json.
 *
 * Usage: node dist/tools/dump-engram.js [maxId] [outFile]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeFileSync, appendFileSync } from "node:fs";

const ENGRAM_URL = process.env.ENGRAM_URL ?? (() => { throw new Error("ENGRAM_URL env var required"); })();
const AUTH = process.env.ENGRAM_AUTH;
if (!AUTH) {
  console.error("Set ENGRAM_AUTH='Basic <base64>' env var.");
  process.exit(1);
}
const MAX_ID = Number(process.argv[2] ?? 200);
const OUT = process.argv[3] ?? "engram-dump.jsonl";

// Allow self-signed if needed (mirrors mcp.json setting)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const transport = new StreamableHTTPClientTransport(new URL(ENGRAM_URL), {
  requestInit: { headers: { Authorization: AUTH } },
});
const client = new Client(
  { name: "mismem-engram-dumper", version: "0.1.0" },
  { capabilities: {} },
);
await client.connect(transport);
console.error(`Connected to ${ENGRAM_URL}`);

writeFileSync(OUT, "");
let saved = 0;
for (let id = 1; id <= MAX_ID; id++) {
  try {
    const res = await client.callTool({
      name: "mem_get_observation",
      arguments: { id },
    });
    const text = (res.content as Array<{ type: string; text?: string }>)
      ?.filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n")
      .trim();
    if (!text || text.startsWith("Observation not found") || text.includes("not found")) {
      continue;
    }
    appendFileSync(OUT, JSON.stringify({ id, text }) + "\n");
    saved++;
    if (id % 10 === 0) console.error(`  fetched ${id}/${MAX_ID} (saved ${saved})`);
  } catch (e) {
    console.error(`id=${id}: ${(e as Error).message}`);
  }
}
console.error(`Done. ${saved} observations written to ${OUT}`);
await client.close();
