#!/usr/bin/env node
/**
 * stdio MCP server. Default entry para `mismem` CLI bin.
 * Usado por VS Code/Claude Desktop como child process.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDefaultDb } from "./db.js";
import { createServer } from "./server-core.js";

const db = openDefaultDb();
const server = createServer(db);
const transport = new StdioServerTransport();
await server.connect(transport);
