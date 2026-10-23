import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MCP_SERVER_NAME, TOOLS, apiCaller, resolveRuntime, type ApiCall } from './tools.js';

/**
 * LEO-345 Phase 1 — the MCP server process. Launched over stdio by the chat's
 * `claude -p` (see `agent-mode.ts`), it exposes Daily OS's own `/api` writes as
 * tools. Thin SDK glue only; the tool set and the loopback caller live in
 * `tools.js` so the launcher and tests can use them without the SDK.
 */

export function buildMcpServer(call: ApiCall): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '1.0.0' });
  for (const tool of TOOLS) {
    server.tool(tool.name, tool.description, tool.schema, async (args: Record<string, unknown>) => {
      const { method, path, body } = tool.request(args ?? {});
      const result = await call(method, path, body);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    });
  }
  return server;
}

async function main(): Promise<void> {
  const server = buildMcpServer(apiCaller(resolveRuntime()));
  await server.connect(new StdioServerTransport());
}

// Run only when invoked as the entry point (not when imported by tests).
const isEntry = process.argv[1] ? import.meta.url === new URL(`file://${process.argv[1]}`).href : false;
if (isEntry) {
  main().catch((error) => {
    process.stderr.write(`daily-os mcp failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
