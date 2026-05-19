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

- Node.js 22+
- Figma Personal Access Token ([instructions](https://www.figma.com/developers/api#access-tokens))
- Docker (optional)

---

## Installation

```bash
npm install
FIGMA_ACCESS_TOKEN=your_token npm run mcp
```

Server: `http://0.0.0.0:3000/mcp` (SSE) · `http://0.0.0.0:3000/messages` (POST).

`.env` is auto-loaded via `dotenv`.

### Docker

```bash
echo "FIGMA_ACCESS_TOKEN=your_token" > .env
docker compose up -d
```

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

## Cursor configuration

`~/.cursor/mcp.json` or `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "figma-to-code": {
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

Replace `127.0.0.1` with your server IP for remote/VPS use.

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
index.js           # MCP server (Express + SSE transport, v2.0.0)
package.json
Dockerfile
docker-compose.yml
.env               # FIGMA_ACCESS_TOKEN (not committed)
```

---

## Branch

This file lives on the `os-figma-mcp` branch — OS-model optimisations on top of the `segment2` baseline.
