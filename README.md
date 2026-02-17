# mcp-server-minimal-read-only-mysql

A minimal, single-file MCP server that gives LLMs read-only access to a MySQL database.

> ⚠️ **Security Notice**: This server only works with read-only MySQL users. Never use users with write privileges.

## What it does

- **`mysql_query` tool** — execute read-only SQL queries and get JSON results
- **Resources** — browse all tables and inspect column schemas

## Setup

```bash
pnpm install          # or npm install
pnpm prepare
cp .env.example .env  # edit with your MySQL credentials
pnpm build
```

**Important**: Create a read-only MySQL user for this server:

```sql
CREATE USER 'readonly'@'localhost' IDENTIFIED BY 'your_password';
GRANT SELECT ON your_database.* TO 'readonly'@'localhost';
FLUSH PRIVILEGES;
```

## Usage

### With Claude Desktop / Cursor / any MCP client

Add to your MCP config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mysql": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-mysql-minimal/dist/server.js"],
      "env": {
        "MYSQL_HOST": "127.0.0.1",
        "MYSQL_PORT": "3306",
        "MYSQL_USER": "readonly",
        "MYSQL_PASSWORD": "your_password",
        "MYSQL_DATABASE": "mydb"
      }
    }
  }
}
```

Or if you have a `.env` file in the project directory, you can omit the `env` block.

### Environment variables

| Variable         | Default     | Description                          |
| ---------------- | ----------- | ------------------------------------ |
| `MYSQL_HOST`     | `127.0.0.1` | MySQL host                           |
| `MYSQL_PORT`     | `3306`      | MySQL port                           |
| `MYSQL_USER`     | `readonly`  | MySQL user (use read-only user only) |
| `MYSQL_PASSWORD` | _(empty)_   | MySQL password                       |
| `MYSQL_DATABASE` | _(none)_    | Default database                     |

## Project structure

```
server.ts        ← the entire server (~130 lines)
package.json
tsconfig.json
prek.toml        ← pre-commit hook config
.env.example
```
