#!/usr/bin/env node

/**
 * Minimal MCP Server for MySQL
 *
 * A single-file Model Context Protocol server that connects to a local MySQL
 * database and exposes two capabilities:
 *
 *   Resources — browse tables and their column schemas
 *   Tool      — execute arbitrary SQL via `mysql_query`
 *
 * Configure via environment variables (or a .env file):
 *   MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 */

// Load .env file using Node.js 24+ native support
try {
  process.loadEnvFile();
} catch {
  // .env file is optional
}
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import mysql from "mysql2/promise";

// ---------------------------------------------------------------------------
// 1. MySQL connection pool (lazy-initialised)
// ---------------------------------------------------------------------------

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER ?? "root",
  password: process.env.MYSQL_PASSWORD ?? "",
  database: process.env.MYSQL_DATABASE ?? undefined,
  waitForConnections: true,
  connectionLimit: 10,
});

// ---------------------------------------------------------------------------
// 2. Create the MCP server
// ---------------------------------------------------------------------------

const mcpServer = new McpServer(
  { name: "mysql", version: "1.0.0" },
  { capabilities: { resources: {}, tools: {} } },
);

// Access the underlying Server for low-level request handlers
const server = mcpServer.server;

// ---------------------------------------------------------------------------
// 3. Resources – list tables & read column schemas
// ---------------------------------------------------------------------------

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT table_schema AS db, table_name AS name
       FROM information_schema.tables
      WHERE table_schema NOT IN ('information_schema','mysql','performance_schema','sys')
      ORDER BY table_schema, table_name`,
  );

  return {
    resources: [
      ...rows.map((r) => ({
        uri: `mysql://${r.db}/${r.name}`,
        name: `${r.db}.${r.name}`,
        mimeType: "application/json",
      })),
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  // URI format: mysql://<database>/<table>
  const url = new URL(req.params.uri);
  const db = url.hostname;
  const table = url.pathname.replace(/^\//, "");

  const [columns] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT column_name, data_type, is_nullable, column_default, column_key
       FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ?
      ORDER BY ordinal_position`,
    [db, table],
  );

  return {
    contents: [
      {
        uri: req.params.uri,
        mimeType: "application/json",
        text: JSON.stringify(columns, null, 2),
      },
    ],
  };
});

// ---------------------------------------------------------------------------
// 4. Tool – mysql_query
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "mysql_query",
      description: "Run a SQL query against the MySQL database",
      inputSchema: {
        type: "object" as const,
        properties: {
          sql: { type: "string", description: "SQL query to execute" },
        },
        required: ["sql"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "mysql_query") {
    return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
  }

  const sql = req.params.arguments?.sql as string;

  try {
    const start = performance.now();
    const [rows] = await pool.query(sql);
    const elapsed = (performance.now() - start).toFixed(1);

    return {
      content: [{ type: "text", text: JSON.stringify({ rows, elapsed_ms: elapsed }, null, 2) }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `SQL Error: ${message}` }], isError: true };
  }
});

// ---------------------------------------------------------------------------
// 5. Ensure read-only user
// ---------------------------------------------------------------------------

async function ensureReadOnly() {
  try {
    await pool.query('CREATE TEMPORARY TABLE _readonly_check (id INT)');
    console.error('❌ Error: User has write privileges. Only read-only users are allowed.');
    console.error('Please configure a MySQL user with SELECT-only permissions.');
    process.exit(1);
  } catch (err) {
    // Expected to fail for read-only users
    if (err instanceof Error) {
      if (err.message.includes('denied')) {
        console.error('✓ User is read-only');
      } else if ('code' in err && (err as any).code === 'ECONNREFUSED') {
        console.error('❌ Error: Cannot connect to MySQL database');
        console.error(`Connection details: ${process.env.MYSQL_HOST ?? '127.0.0.1'}:${process.env.MYSQL_PORT ?? 3306}`);
        console.error('Please check that:');
        console.error('  - MySQL server is running');
        console.error('  - MYSQL_HOST and MYSQL_PORT are correct');
        console.error('  - Firewall allows the connection');
        throw err;
      } else if ('code' in err && (err as any).code === 'ER_ACCESS_DENIED_ERROR') {
        console.error('❌ Error: Access denied to MySQL database');
        console.error(`User: ${process.env.MYSQL_USER ?? 'root'}, Database: ${process.env.MYSQL_DATABASE ?? '(none)'}`);
        console.error('Please check that MYSQL_USER, MYSQL_PASSWORD, and MYSQL_DATABASE are correct');
        throw err;
      } else if ('code' in err && (err as any).code === 'ER_BAD_DB_ERROR') {
        console.error('❌ Error: Database does not exist');
        console.error(`Database: ${process.env.MYSQL_DATABASE ?? '(none)'}`);
        console.error('Please check that MYSQL_DATABASE is correct');
        throw err;
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Start the server
// ---------------------------------------------------------------------------

async function main() {
  await ensureReadOnly();
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error("MySQL MCP server running on stdio");
}

main().catch((err) => {
  if (err instanceof Error && !('code' in err)) {
    console.error("❌ Fatal error:", err.message);
  }
  // Error details already logged by ensureReadOnly or other handlers
  process.exit(1);
});
