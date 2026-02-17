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
 *   MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASS, MYSQL_DB
 */
// Load .env file using Node.js 24+ native support
try {
    process.loadEnvFile();
}
catch {
    // .env file is optional
}
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import mysql from "mysql2/promise";
// ---------------------------------------------------------------------------
// 1. MySQL connection pool (lazy-initialised)
// ---------------------------------------------------------------------------
const pool = mysql.createPool({
    host: process.env.MYSQL_HOST ?? "127.0.0.1",
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASS ?? "",
    database: process.env.MYSQL_DB ?? undefined,
    waitForConnections: true,
    connectionLimit: 10,
});
// ---------------------------------------------------------------------------
// 2. Create the MCP server
// ---------------------------------------------------------------------------
const mcpServer = new McpServer({ name: "mysql", version: "1.0.0" }, { capabilities: { resources: {}, tools: {} } });
// Access the underlying Server for low-level request handlers
const server = mcpServer.server;
// ---------------------------------------------------------------------------
// 3. Resources – list tables & read column schemas
// ---------------------------------------------------------------------------
server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const [rows] = await pool.query(`SELECT table_schema AS db, table_name AS name
       FROM information_schema.tables
      WHERE table_schema NOT IN ('information_schema','mysql','performance_schema','sys')
      ORDER BY table_schema, table_name`);
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
    const [columns] = await pool.query(`SELECT column_name, data_type, is_nullable, column_default, column_key
       FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ?
      ORDER BY ordinal_position`, [db, table]);
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
                type: "object",
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
        return {
            content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
            isError: true,
        };
    }
    const sql = req.params.arguments?.sql;
    try {
        const start = performance.now();
        const [rows] = await pool.query(sql);
        const elapsed = (performance.now() - start).toFixed(1);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ rows, elapsed_ms: elapsed }, null, 2),
                },
            ],
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            content: [{ type: "text", text: `SQL Error: ${message}` }],
            isError: true,
        };
    }
});
// ---------------------------------------------------------------------------
// 5. Ensure read-only user
// ---------------------------------------------------------------------------
async function ensureReadOnly() {
    try {
        const [rows] = await pool.query("SHOW GRANTS FOR CURRENT_USER()");
        // Check if user has any write privileges
        const writePrivileges = [
            "INSERT",
            "UPDATE",
            "DELETE",
            "CREATE",
            "DROP",
            "ALTER",
            "INDEX",
            "GRANT",
        ];
        const grantsText = rows
            .map((r) => Object.values(r)[0])
            .join(" ")
            .toUpperCase();
        const hasWritePrivilege = writePrivileges.some((priv) => grantsText.includes(`${priv} ON`) ||
            grantsText.includes("ALL PRIVILEGES"));
        if (hasWritePrivilege) {
            console.error("❌ Error: User has write privileges. Only read-only users are allowed.");
            console.error("Please configure a MySQL user with SELECT-only permissions.");
            console.error("\nCurrent grants:");
            rows.forEach((r) => console.error(`  ${Object.values(r)[0]}`));
            process.exit(1);
        }
        console.error("✅ User is read-only");
    }
    catch (err) {
        if (err instanceof Error) {
            if ("code" in err && err.code === "ECONNREFUSED") {
                console.error("❌ Error: Cannot connect to MySQL database");
                console.error(`Connection details: ${process.env.MYSQL_HOST ?? "127.0.0.1"}:${process.env.MYSQL_PORT ?? 3306}`);
                console.error("Please check that:");
                console.error("  - MySQL server is running");
                console.error("  - MYSQL_HOST and MYSQL_PORT are correct");
                console.error("  - Firewall allows the connection");
                throw err;
            }
            else if ("code" in err &&
                err.code === "ER_ACCESS_DENIED_ERROR") {
                console.error("❌ Error: Access denied to MySQL database");
                console.error(`User: ${process.env.MYSQL_USER ?? "root"}, Database: ${process.env.MYSQL_DB ?? "(none)"}`);
                console.error("Please check that MYSQL_USER, MYSQL_PASS, and MYSQL_DB are correct");
                if (!process.env.MYSQL_DB) {
                    console.error("\n⚠️  MYSQL_DB is not set. Some MySQL users require a database to be specified.");
                    console.error("Set MYSQL_DB in your .env file or Claude Desktop config.");
                }
                throw err;
            }
            else if ("code" in err && err.code === "ER_BAD_DB_ERROR") {
                console.error("❌ Error: Database does not exist");
                console.error(`Database: ${process.env.MYSQL_DB ?? "(none)"}`);
                console.error("Please check that MYSQL_DB is correct");
                throw err;
            }
            else {
                throw err;
            }
        }
        else {
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
    if (err instanceof Error && !("code" in err)) {
        console.error("❌ Fatal error:", err.message);
    }
    // Error details already logged by ensureReadOnly or other handlers
    process.exit(1);
});
