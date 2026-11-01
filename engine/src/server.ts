#!/usr/bin/env node
// stdio MCP server, the default entry of the `mismem` bin: VS Code and Claude Desktop run it as
// a child process.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDefaultDb } from "./store/db.js";
import { createServer } from "./server-core.js";

const db = openDefaultDb();
const server = createServer(db);
const transport = new StdioServerTransport();
await server.connect(transport);
