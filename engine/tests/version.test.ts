import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb } from "../src/store/db.js";
import { createServer } from "../src/server-core.js";

function readJson(relativeToTests: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(relativeToTests, import.meta.url), "utf8"));
}

const pkg = readJson("../package.json");
const manifest = readJson("../../server.json") as {
  version: string;
  packages: Array<{ version: string }>;
};

describe("versión", () => {
  it("createServer anuncia por MCP la versión de engine/package.json", async () => {
    const db = openDb(":memory:");
    const server = createServer(db);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "version-test", version: "0.0.0" });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      expect(client.getServerVersion()?.version).toBe(pkg.version);
    } finally {
      await client.close();
      await server.close();
      db.close();
    }
  });

  it("server.json declara la misma versión en sus dos campos", () => {
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.packages[0]?.version).toBe(pkg.version);
  });
});
