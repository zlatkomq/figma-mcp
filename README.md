# figma-to-code-mcp-os

**v2.0.0** — MCP (Model Context Protocol) server optimised for **open-source models** (Qwen, Gemma, and similar) that translates Figma designs into pixel-accurate, implementation-ready specs. Runs as an Express/SSE server compatible with Cursor, Claude Desktop, and any MCP-capable client.

---

## How it works

Each tool call hits the Figma REST API, post-processes the response into a **structured, deterministic format**, and returns a result the model can use directly to write code — without hallucinating dimensions, colors, or layout rules.

### Tools

| # | Tool | When to call | Output |
|---|------|-------------|--------|
| 1 | `get_figma_file_structure` | **Always first.** Explore a file before touching anything. | Pages + top-level frames/components with `name`, `type`, `id`. |
| 2a | `get_figma_node_spec` | **Preferred for code generation.** One call for everything. | Token constraints header + canonical JSX tree + flat geometry table + code-generation rules footer. |
| 2b | `get_figma_node_jsx` | JSX tree only (lighter). | Canonical JSX with full prop set, `maxDepth` support, code-rules footer. |
| 2c | `get_figma_frame_with_image` | **Multimodal** (Qwen-VL etc.). Visual parity check. | JSX spec + PNG download URL for the same frame at configurable scale. |
| 3 | `get_figma_design_tokens` | Once per target frame (or whole file). | CSS `:root` block with `--color-N` vars, font families, text styles. **Reuse in all generated code — do not invent hex codes.** |
| 4 | `export_figma_assets` | Per icon / image asset. | Direct SVG or PNG download URLs. |

---

## Recommended call order

```
1. get_figma_file_structure   → pick nodeId
2. get_figma_design_tokens    → get the token block (prefer scoped by nodeId)
3. get_figma_node_spec        → full spec with geometry table
   (or get_figma_frame_with_image for visual parity)
4. export_figma_assets        → download SVG/PNG assets by nodeId
```

---

## What's new in v2.0.0

### Enriched JSX tree — canonical prop order (fixed across every node type)

Every node now emits props in this **exact order** so models always see the same pattern:

```
x y  w h  constraint-h constraint-v
layout  sizing-h sizing-v  grow
gap  padding  align-main align-cross
min-w max-w min-h max-h
bg  radius  border  stroke-w  opacity  effects
```

**New vs v1.x:** `x`, `y` (from `relativeTransform`), `constraint-h/v`, `sizing-h/v` (fixed/fill/hug), `grow`, `align-main`, `align-cross`, `min-w/h`, `max-w/h`, `stroke-w`, `opacity`, `effects`, `letter-spacing`, `line-h`, `text-align`, `text-case`, `decoration`.

### Flat geometry table (`get_figma_node_spec`)

Every node in the subtree as a markdown table:

```
| id | name | type | relX | relY | absX | absY | w | h | constraintH | constraintV | layout | sizingH | sizingV | grow | opacity |
```

### Code-generation rules footer

Appended to every structural tool result — maps JSX props to CSS precisely:

- `layout=horizontal` → `display:flex; flex-direction:row`
- `sizing-h=fill` → `flex:1` / `width:100%`
- `sizing-h=hug` → `width:fit-content`
- `constraint=scale` → percentage widths
- `grow > 0` → `flex-grow: N`

### Token constraints header

Prepended to node-level results: allowed fonts and hex colors listed explicitly — models are told not to invent values outside the list.

### `maxDepth` parameter

Controls JSX tree depth (default 12). Reduce for large frames to stay within small-model context limits.

### `get_figma_frame_with_image`

Returns JSX spec + a live PNG download URL. Use the image for visual verification; use the JSX numbers as the source of truth for code.

---

## JSX output example

```jsx
<Frame name="Card" id="12:34"
  x="0px" y="0px" w="320px" h="200px"
  constraint-h="scale" constraint-v="top"
  layout="vertical"
  sizing-h="fixed" sizing-v="hug"
  gap="16px" padding="24px"
  align-main="start" align-cross="stretch"
  bg="#FFFFFF" radius="12px"
  border="#E2E8F0" stroke-w="1px"
  effects="0px 4px 16px #00000014">
  <Text name="Title" id="12:35"
    x="24px" y="24px" w="272px" h="32px"
    font="Inter" size="20px" weight="700"
    line-h="32px" letter-spacing="0px"
    text-align="left" color="#1A1A1A">Welcome Back</Text>
  <Instance name="Avatar" id="12:36"
    x="24px" y="72px" w="40px" h="40px"
    constraint-h="left" constraint-v="top" />
</Frame>
```

---

## Prerequisites

- **Node.js 22+** (or Docker)
- **Figma Personal Access Token** — create at [figma.com/settings → Personal access tokens](https://www.figma.com/settings) ([detailed instructions](https://www.figma.com/developers/api#access-tokens)). The token needs **read access** to the files you plan to extract; for personal files that's the default scope. For team/org files, ensure the token's owner has access to the relevant project.
- **Docker + docker compose** (only if you want the containerised deployment)

> **Security note:** the token grants the same Figma read access as its owner. Store it in `.env` (never commit) and rotate periodically. For shared deployments, use a token owned by a dedicated service account rather than an individual designer.

---

## Installation

### Option A — Local (Node)

```bash
git clone https://github.com/zlatkomq/figma-mcp.git
cd figma-mcp
npm install
cp .env.example .env
# Edit .env and set FIGMA_ACCESS_TOKEN=<your_token>
npm run mcp
```

The server listens on `http://0.0.0.0:3000/mcp` (SSE) and `http://0.0.0.0:3000/messages` (POST). `.env` is auto-loaded via `dotenv`.

To stop: `Ctrl+C`.

### Option B — Docker

```bash
git clone https://github.com/zlatkomq/figma-mcp.git
cd figma-mcp
cp .env.example .env
# Edit .env and set FIGMA_ACCESS_TOKEN=<your_token>
docker compose up -d
```

Verify the container is running:

```bash
docker compose ps
docker compose logs -f mcp-figma
```

To stop: `docker compose down`.

### Option C — stdio (single-machine, no network)

For local-only usage with MCP clients that prefer stdio (e.g. Claude Code via `claude mcp add`):

```bash
FIGMA_ACCESS_TOKEN=your_token npm run mcp:stdio
```

In stdio mode the server reads JSON-RPC on stdin and writes responses on stdout. There is no HTTP endpoint — connect via the client's stdio adapter (see [Claude Code configuration](#claude-code-configuration) below).

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FIGMA_ACCESS_TOKEN` | — | **Required.** Figma Personal Access Token |
| `PORT` / `MCP_PORT` | `3000` | Server port |
| `MCP_BIND` / `MCP_HOST` | `0.0.0.0` | Bind address (`127.0.0.1` for local-only) |
| `MCP_ALLOWED_HOSTS` | — | Comma-separated allowed Host headers |
| `MCP_SSE_PATH` | `/mcp` | SSE endpoint |
| `MCP_MESSAGES_PATH` | `/messages` | POST endpoint |
| `SSE_KEEPALIVE_MS` | `15000` | SSE heartbeat interval |

---

## MCP client configuration

Pick the section that matches your editor. Replace `127.0.0.1` with the server's IP (or VPN-reachable hostname) if the MCP runs on a different machine.

> **Windows users:** paths like `~/.cursor/`, `~/.claude.json`, and `~/.config/opencode/` shown below resolve to your home directory. On Windows, replace `~/` with `%USERPROFILE%\` (PowerShell: `$env:USERPROFILE\`) and use backslashes — e.g. `%USERPROFILE%\.cursor\mcp.json`. JSON content is identical across all OSes.

### Cursor configuration

Edit `~/.cursor/mcp.json` (global — works in every project) or `.cursor/mcp.json` (project-local):

```json
{
  "mcpServers": {
    "figma-to-code": {
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

**Restart Cursor** after editing. Cursor will show a *"Trust and run MCP server figma-to-code?"* prompt — click **Trust**. The server then appears in Cursor's MCP server list.

### Claude Code configuration

For an **HTTP/SSE** server (Option A or B above), register it via the CLI:

```bash
claude mcp add --transport sse figma-to-code http://127.0.0.1:3000/mcp
```

Or add it manually to `~/.claude.json` (or `.mcp.json` at your project root for project-scoped config):

```json
{
  "mcpServers": {
    "figma-to-code": {
      "type": "sse",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

For **stdio** (Option C above), use:

```bash
claude mcp add figma-to-code -- node /absolute/path/to/figma-mcp/index.js --stdio
```

Set the `FIGMA_ACCESS_TOKEN` environment variable in the same shell, or use `claude mcp add ... -e FIGMA_ACCESS_TOKEN=<token>`.

Restart Claude Code or run `/mcp` inside a session to verify the server is connected.

### OpenCode configuration

Edit `~/.config/opencode/opencode.json` (create if missing):

```json
{
  "mcp": {
    "figma-to-code": {
      "type": "remote",
      "url": "http://127.0.0.1:3000/mcp",
      "enabled": true
    }
  }
}
```

Restart OpenCode after editing.

---

## Verification

After configuring your editor, verify the server is reachable and the tools are attached:

### 1. Server is running

```bash
curl -i http://127.0.0.1:3000/mcp
```

You should see an SSE response (`Content-Type: text/event-stream`) and the connection stay open. Press `Ctrl+C` to close.

### 2. MCP attached in your editor

| Editor | How to check |
|---|---|
| **Cursor** | Settings → MCP → `figma-to-code` shows status **Connected** and lists 6 tools |
| **Claude Code** | Run `/mcp` inside a session — `figma-to-code` should appear with status `connected` |
| **OpenCode** | Run `/mcp` (or check OpenCode's MCP panel) — `figma-to-code` should appear |

### 3. First tool call

Ask the agent in chat:

> *"Using the figma-to-code MCP, call `get_figma_file_structure` for fileKey `<your-figma-file-key>` and show me the pages."*

The fileKey is the string between `/file/` (or `/design/`) and the next `/` in a Figma URL. The response should list the file's pages and top-level frames with `id` values. If you see the structure, the install is complete.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `curl http://127.0.0.1:3000/mcp` connection refused | Server not running | Check `npm run mcp` output or `docker compose ps`; look for port conflicts (`lsof -i :3000`) |
| Cursor / Claude Code shows the MCP but **no tools** | Server is running but `FIGMA_ACCESS_TOKEN` is missing or invalid | Check `.env`, restart the server, restart the editor |
| All tool calls return `401 Unauthorized` | Token expired or revoked | Generate a new token at [figma.com/settings](https://www.figma.com/settings), update `.env`, restart server |
| Tool calls return `403 Forbidden` for a specific file | Token's owner doesn't have access to that Figma file | Share the file with the token owner's Figma account, or use a token owned by an account with access |
| Tool calls return `404 Not Found` for the `fileKey` | Wrong fileKey | Open the Figma file in browser; copy the segment between `/file/` (or `/design/`) and the next `/` |
| Cursor "Trust and run" dialog was dismissed | Cursor refuses to start the MCP | Settings → MCP → toggle `figma-to-code` off then on; re-accept the trust prompt |
| Editor doesn't see the MCP at all | Config file in wrong location or invalid JSON | Validate JSON (`jq . ~/.cursor/mcp.json`); confirm the path matches your editor's docs; **restart the editor** |
| `EADDRINUSE: address already in use 0.0.0.0:3000` | Another process is on port 3000 | Stop it, or set `PORT=3001` in `.env` and update the client config URL |
| Remote server, can't reach from laptop | Firewall / VPN / wrong IP | Verify with `curl http://<server-ip>:3000/mcp` from the laptop; check `MCP_BIND` is `0.0.0.0` (not `127.0.0.1`) on the server; confirm VPN is connected if applicable |

---

## Tool reference

### `get_figma_file_structure`

| Param | Type | Required |
|-------|------|----------|
| `fileKey` | string | yes |

### `get_figma_node_spec` ★ recommended

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `fileKey` | string | yes | |
| `nodeId` | string | yes | From `get_figma_file_structure` |
| `maxDepth` | number | no | Default 12; reduce for large frames |

### `get_figma_node_jsx`

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `fileKey` | string | yes | |
| `nodeId` | string | yes | |
| `maxDepth` | number | no | Default 12 |

### `get_figma_frame_with_image`

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `fileKey` | string | yes | |
| `nodeId` | string | yes | |
| `maxDepth` | number | no | Default 12 |
| `scale` | number | no | PNG export scale 1–4×, default 1 |

### `get_figma_design_tokens`

| Param | Type | Required |
|-------|------|----------|
| `fileKey` | string | yes |
| `nodeId` | string | no |

### `export_figma_assets`

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `fileKey` | string | yes | |
| `nodeIds` | string[] | yes | Node IDs from file structure or JSX `id` attrs |
| `format` | string | no | `"svg"` (default) or `"png"` |

---

## Resilience

- **30 s timeout** on all Figma API calls.
- **Automatic retry** (up to 2 retries) on HTTP 429 / 5xx, respecting `Retry-After` with exponential backoff fallback.

---

## Project structure

```
index.js           # MCP server (Express + SSE + stdio transport, v2.0.0)
package.json
Dockerfile
docker-compose.yml
.env               # FIGMA_ACCESS_TOKEN (not committed)
.env.example       # template — copy to .env and fill in
```

---

## Uninstall

| Mode | How to remove |
|---|---|
| Local Node | Stop the process (`Ctrl+C`); delete the cloned directory |
| Docker | `docker compose down --volumes --remove-orphans`; delete the cloned directory |
| Cursor MCP entry | Remove the `figma-to-code` block from `~/.cursor/mcp.json` and restart Cursor |
| Claude Code MCP entry | `claude mcp remove figma-to-code` |
| OpenCode MCP entry | Remove the `figma-to-code` block from `~/.config/opencode/opencode.json` and restart OpenCode |

---

## Use with the Spec-First Framework

This MCP server is the design-context provider for the [Spec-First Framework](https://github.com/zlatkomq/spec-first-framework) v1.2.0+ — specifically the **UIX step (step 2b)** in the `/flow` workflow. Once installed, agents using `/uix` will automatically fetch design tokens, per-node layout, and assets through this server and cache them under each spec's `figma/` directory.

If you're working with designers, share the [Spec-First Designer Guide](https://github.com/zlatkomq/spec-first-framework/blob/main/docs/FIGMA-DESIGNER-GUIDE.md) — it documents the naming, layout, and asset conventions that make extraction deterministic.

---

## License

[MIT](LICENSE).
