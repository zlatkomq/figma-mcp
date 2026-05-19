import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";

const VERSION = "2.0.0";

const FIGMA_TOKEN = process.env.FIGMA_ACCESS_TOKEN || "";
const PORT = Number(process.env.MCP_PORT || process.env.PORT || 3000);
const HOST = process.env.MCP_BIND || process.env.MCP_HOST || "0.0.0.0";
const MCP_ALLOWED_HOSTS = process.env.MCP_ALLOWED_HOSTS?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MCP_SSE_PATH = process.env.MCP_SSE_PATH || "/mcp";
const MCP_MESSAGES_PATH = process.env.MCP_MESSAGES_PATH || "/messages";
const SSE_KEEPALIVE_MS = Number(process.env.SSE_KEEPALIVE_MS) || 15_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

const FIGMA_TIMEOUT_MS = 30_000;
const FIGMA_MAX_RETRIES = 2;
const FRAME_TYPES = new Set(["FRAME", "COMPONENT", "INSTANCE", "GROUP"]);
const SHAPE_TYPES = new Set([
  "RECTANGLE",
  "ELLIPSE",
  "LINE",
  "STAR",
  "REGULAR_POLYGON",
]);
const MAX_WALK_DEPTH = 12;
const SVG_EXPORT_PREFIX = "svg_ex_";
const ICON_HEURISTIC_MAX_PX = 128;

const FILE_KEY_RE = /^[a-zA-Z0-9_-]+$/;
const NODE_ID_RE = /^[\w:%-]+$/;

const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNABORTED",
  "EPIPE",
  "EAI_AGAIN",
]);
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/* ------------------------------------------------------------------ */
/*  Structured logger                                                  */
/* ------------------------------------------------------------------ */

function log(level, component, msg, extra = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    component,
    msg,
    ...extra,
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/* ------------------------------------------------------------------ */
/*  Session tracker for diagnostics                                    */
/* ------------------------------------------------------------------ */

const sessions = new Map();
const transports = new Map();
let httpServer = null;

/* ------------------------------------------------------------------ */
/*  Color / style helper                                              */
/* ------------------------------------------------------------------ */

function rgbaToHex(c) {
  const r = Math.round((c.r || 0) * 255);
  const g = Math.round((c.g || 0) * 255);
  const b = Math.round((c.b || 0) * 255);
  const a = c.a != null ? c.a : 1;
  const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  if (a < 1) return `${hex} (${Math.round(a * 100)}%)`;
  return hex;
}

function extractSolidColors(fills) {
  if (!Array.isArray(fills)) return [];
  return fills
    .filter((f) => f.visible !== false && f.type === "SOLID" && f.color)
    .map((f) => rgbaToHex(f.color));
}

function describeFills(fills) {
  if (!Array.isArray(fills)) return [];
  const parts = [];
  for (const f of fills) {
    if (f.visible === false) continue;
    if (f.type === "SOLID" && f.color) {
      parts.push(rgbaToHex(f.color));
    } else if (
      f.type?.startsWith("GRADIENT") &&
      Array.isArray(f.gradientStops)
    ) {
      const kind = f.type.replace("GRADIENT_", "").toLowerCase();
      const stops = f.gradientStops
        .map((s) => (s.color ? rgbaToHex(s.color) : "?"))
        .join(" → ");
      parts.push(`${kind}-gradient(${stops})`);
    } else if (f.type === "IMAGE") {
      parts.push("image");
    }
  }
  return parts;
}

function collectPaletteColors(fills, strokes) {
  const colors = [];
  if (Array.isArray(fills)) {
    for (const f of fills) {
      if (f.visible === false) continue;
      if (f.type === "SOLID" && f.color) colors.push(rgbaToHex(f.color));
      if (f.type?.startsWith("GRADIENT") && Array.isArray(f.gradientStops)) {
        for (const s of f.gradientStops) {
          if (s.color) colors.push(rgbaToHex(s.color));
        }
      }
    }
  }
  for (const c of extractSolidColors(strokes)) colors.push(c);
  return colors;
}

function hasImageFill(fills) {
  return (
    Array.isArray(fills) &&
    fills.some((f) => f.visible !== false && f.type === "IMAGE")
  );
}

function formatEffects(effects) {
  if (!Array.isArray(effects)) return [];
  return effects
    .filter((e) => e.visible !== false)
    .map((e) => {
      if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
        const c = e.color ? rgbaToHex(e.color) : "";
        const inset = e.type === "INNER_SHADOW" ? "inset " : "";
        return `${inset}${e.offset?.x ?? 0}px ${e.offset?.y ?? 0}px ${e.radius ?? 0}px ${c}`.trim();
      }
      if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") {
        return `blur(${e.radius ?? 0}px)`;
      }
      return null;
    })
    .filter(Boolean);
}

function formatPadding(t, r, b, l) {
  if (t == null && r == null && b == null && l == null) return null;
  const T = t ?? 0,
    R = r ?? 0,
    B = b ?? 0,
    L = l ?? 0;
  if (T === 0 && R === 0 && B === 0 && L === 0) return null;
  if (T === B && R === L && T === R) return `${T}px`;
  if (T === B && R === L) return `${T}px ${R}px`;
  return `${T}px ${R}px ${B}px ${L}px`;
}

/* ------------------------------------------------------------------ */
/*  Figma API fetch with timeout + retry (429 / 5xx / network)         */
/* ------------------------------------------------------------------ */

async function fetchFigmaWithRetry(url, token) {
  const t0 = Date.now();
  log("info", "figma-api", "fetch start", {
    url: url.replace(/\?.*/, "?..."),
  });

  let lastError;

  for (let attempt = 0; attempt <= FIGMA_MAX_RETRIES; attempt++) {
    const attemptStart = Date.now();
    try {
      const resp = await axios.get(url, {
        headers: { "X-Figma-Token": token },
        timeout: FIGMA_TIMEOUT_MS,
      });
      const elapsed = Date.now() - attemptStart;
      const bytes = Number(resp.headers?.["content-length"]) || 0;
      log("info", "figma-api", "fetch ok", {
        attempt,
        elapsed_ms: elapsed,
        status: resp.status,
        bytes,
      });
      return resp;
    } catch (err) {
      lastError = err;
      const elapsed = Date.now() - attemptStart;
      const status = err.response?.status ?? null;
      const code = err.code ?? null;
      log("warn", "figma-api", "fetch fail", {
        attempt,
        elapsed_ms: elapsed,
        status,
        code,
        message: err.message,
      });

      const retryable =
        RETRYABLE_STATUSES.has(status) || RETRYABLE_CODES.has(code);
      if (retryable && attempt < FIGMA_MAX_RETRIES) {
        const retryAfter =
          Number(err.response?.headers?.["retry-after"]) || 0;
        const wait = Math.max(retryAfter * 1000, 2 ** (attempt + 1) * 1000);
        log("info", "figma-api", "backoff", {
          wait_ms: wait,
          attempt: attempt + 1,
          reason: status || code,
        });
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      break;
    }
  }

  log("error", "figma-api", "fetch abandoned", {
    total_ms: Date.now() - t0,
    attempts: FIGMA_MAX_RETRIES + 1,
  });
  throw lastError;
}

/* ------------------------------------------------------------------ */
/*  Figma Data Extractors (Trees, Assets, Tokens, Structure)          */
/* ------------------------------------------------------------------ */

/* ================================================================== */
/*  OS-model optimised helpers (Qwen / Gemma friendly)                */
/* ================================================================== */

function escapeJSXText(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* Extract relative x/y from Figma's relativeTransform matrix [[a,b,tx],[c,d,ty]] */
function relXY(node) {
  const m = node.relativeTransform;
  if (!Array.isArray(m) || m.length < 2) return { x: null, y: null };
  return {
    x: Math.round(m[0][2]),
    y: Math.round(m[1][2]),
  };
}

/* Canonical lower-case form for align tokens */
function fmtAlign(val) {
  if (!val) return null;
  const map = {
    MIN: "start",
    CENTER: "center",
    MAX: "end",
    SPACE_BETWEEN: "space-between",
    BASELINE: "baseline",
    AUTO: "auto",
  };
  return map[val] || val.toLowerCase();
}

/* ------------------------------------------------------------------ */
/*  File structure                                                      */
/* ------------------------------------------------------------------ */

function buildFigmaFileStructure(document) {
  const o = [];
  o.push("# Figma File Structure");
  o.push("");

  if (!document || !document.children) return "No document structure found.";

  for (const page of document.children) {
    if (page.type !== "CANVAS") continue;
    o.push(`## Page: ${page.name} (id: ${page.id})`);

    const topFrames = (page.children || []).filter(
      (c) =>
        FRAME_TYPES.has(c.type) ||
        c.type === "COMPONENT_SET" ||
        c.type === "COMPONENT",
    );
    if (topFrames.length === 0) {
      o.push("  *(No top-level frames/components)*");
    } else {
      for (const f of topFrames) {
        o.push(`- **${f.name}** (type: ${f.type}, id: ${f.id})`);
      }
    }
    o.push("");
  }
  return o.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Canonical JSX tree — enriched for OS models                       */
/*                                                                    */
/*  Prop order is FIXED across every node type:                       */
/*  x y  w h  constraint-h constraint-v  layout sizing-h sizing-v    */
/*  grow gap padding align-main align-cross  min-w max-w min-h max-h  */
/*  bg radius border stroke-w opacity effects                         */
/* ------------------------------------------------------------------ */

/* Types treated as leaves in the JSX tree (children are never recursed).
   INSTANCE = icon/component — internal vectors balloon context without adding layout value.
   Primitives (VECTOR etc.) are already handled by the shape block and have no children. */
const JSX_LEAF_TYPES = new Set(["INSTANCE", "VECTOR", "BOOLEAN_OPERATION", "STAR", "REGULAR_POLYGON", "LINE"]);

const ICON_HEURISTIC_TYPES = new Set(["INSTANCE", "COMPONENT", "FRAME", "GROUP"]);

function looksLikeIcon(node) {
  if (!ICON_HEURISTIC_TYPES.has(node.type)) return false;
  const box = node.absoluteBoundingBox;
  if (!box) return false;
  if (box.width > ICON_HEURISTIC_MAX_PX || box.height > ICON_HEURISTIC_MAX_PX) return false;
  const children = node.children || [];
  if (children.some((ch) => ch.type === "TEXT")) return false;
  return true;
}

function walkFigmaTreeToJSX(node, depth = 0, maxDepth = MAX_WALK_DEPTH, indentSize = 2, assets = null) {
  if (depth > maxDepth || !node || typeof node !== "object") return "";

  const indent = " ".repeat(depth * indentSize);
  const nameAttr = node.name ? ` name="${escapeJSXText(node.name)}"` : "";
  const idAttr = node.id ? ` id="${node.id}"` : "";

  const isSvgExport = node.name && node.name.startsWith(SVG_EXPORT_PREFIX);
  const isIconHeuristic = !isSvgExport && looksLikeIcon(node);
  const isImageAsset = hasImageFill(node.fills);
  const isExportable = isSvgExport || isIconHeuristic || isImageAsset;

  if (isExportable && assets && node.id) {
    const box = node.absoluteBoundingBox;
    assets.push({
      id: node.id,
      name: node.name || "(unnamed)",
      type: node.type || "UNKNOWN",
      w: box ? Math.round(box.width) : null,
      h: box ? Math.round(box.height) : null,
      format: isImageAsset ? "png" : "svg",
      reason: isSvgExport ? "prefix" : isIconHeuristic ? "icon-heuristic" : "image-fill",
    });
  }

  let inner = "";
  if (!JSX_LEAF_TYPES.has(node.type)) {
    for (const ch of node.children || []) {
      const s = walkFigmaTreeToJSX(ch, depth + 1, maxDepth, indentSize, assets);
      if (s) inner += "\n" + s;
    }
  }

  /* ---- TEXT ---- */
  if (node.type === "TEXT") {
    const style = node.style || {};
    const { x, y } = relXY(node);
    const box = node.absoluteBoundingBox;
    const textColors = extractSolidColors(node.fills);
    const props = [];
    if (x != null) props.push(`x="${x}px"`);
    if (y != null) props.push(`y="${y}px"`);
    if (box?.width) props.push(`w="${Math.round(box.width)}px"`);
    if (box?.height) props.push(`h="${Math.round(box.height)}px"`);
    if (style.fontFamily) props.push(`font="${escapeJSXText(style.fontFamily)}"`);
    if (style.fontSize) props.push(`size="${style.fontSize}px"`);
    if (style.fontWeight) props.push(`weight="${style.fontWeight}"`);
    if (style.letterSpacing != null && style.letterSpacing !== 0)
      props.push(`letter-spacing="${style.letterSpacing}px"`);
    if (style.lineHeightPx != null) props.push(`line-h="${Math.round(style.lineHeightPx)}px"`);
    if (style.textAlignHorizontal) props.push(`text-align="${style.textAlignHorizontal.toLowerCase()}"`);
    if (style.textDecoration && style.textDecoration !== "NONE")
      props.push(`decoration="${style.textDecoration.toLowerCase()}"`);
    if (style.textCase && style.textCase !== "ORIGINAL")
      props.push(`text-case="${style.textCase.toLowerCase()}"`);
    if (textColors[0]) props.push(`color="${textColors[0]}"`);
    if (node.opacity != null && node.opacity < 1) props.push(`opacity="${node.opacity}"`);
    const efx = formatEffects(node.effects);
    if (efx.length) props.push(`effects="${efx.join("; ")}"`);
    const propStr = props.length ? " " + props.join(" ") : "";
    const content = escapeJSXText(node.characters || "").replace(/\n/g, "<br/>");
    return `${indent}<Text${nameAttr}${idAttr}${propStr}>${content}</Text>`;
  }

  /* ---- COMPONENT / INSTANCE ---- */
  /* ---- INSTANCE (always a leaf — never recurse into icon internals) ---- */
  if (node.type === "INSTANCE") {
    const { x, y } = relXY(node);
    const box = node.absoluteBoundingBox;
    const props = [];
    if (x != null) props.push(`x="${x}px"`);
    if (y != null) props.push(`y="${y}px"`);
    if (box?.width) props.push(`w="${Math.round(box.width)}px"`);
    if (box?.height) props.push(`h="${Math.round(box.height)}px"`);
    if (node.constraints?.horizontal) props.push(`constraint-h="${node.constraints.horizontal.toLowerCase()}"`);
    if (node.constraints?.vertical) props.push(`constraint-v="${node.constraints.vertical.toLowerCase()}"`);
    if (node.componentProperties) {
      const cp = Object.entries(node.componentProperties)
        .map(([k, v]) => `${escapeJSXText(k)}=${escapeJSXText(String(v.value))}`)
        .join(", ");
      if (cp) props.push(`props="{${cp}}"`);
    }
    if (node.opacity != null && node.opacity < 1) props.push(`opacity="${node.opacity}"`);
    if (isExportable) props.push(`export-as="${isImageAsset ? "png" : "svg"}"`);
    const propStr = props.length ? " " + props.join(" ") : "";
    return `${indent}<Instance${nameAttr}${idAttr}${propStr} />`;
  }

  /* ---- COMPONENT (definition node — recurse into children) ---- */
  if (node.type === "COMPONENT") {
    const { x, y } = relXY(node);
    const box = node.absoluteBoundingBox;
    const props = [];
    if (x != null) props.push(`x="${x}px"`);
    if (y != null) props.push(`y="${y}px"`);
    if (box?.width) props.push(`w="${Math.round(box.width)}px"`);
    if (box?.height) props.push(`h="${Math.round(box.height)}px"`);
    if (node.opacity != null && node.opacity < 1) props.push(`opacity="${node.opacity}"`);
    const propStr = props.length ? " " + props.join(" ") : "";
    if (!inner) return `${indent}<Component${nameAttr}${idAttr}${propStr} />`;
    return `${indent}<Component${nameAttr}${idAttr}${propStr}>\n${inner}\n${indent}</Component>`;
  }

  /* ---- FRAME / GROUP / COMPONENT_SET ---- */
  if (FRAME_TYPES.has(node.type)) {
    const { x, y } = relXY(node);
    const box = node.absoluteBoundingBox;
    const props = [];
    if (x != null) props.push(`x="${x}px"`);
    if (y != null) props.push(`y="${y}px"`);
    if (box?.width) props.push(`w="${Math.round(box.width)}px"`);
    if (box?.height) props.push(`h="${Math.round(box.height)}px"`);
    if (node.constraints?.horizontal) props.push(`constraint-h="${node.constraints.horizontal.toLowerCase()}"`);
    if (node.constraints?.vertical) props.push(`constraint-v="${node.constraints.vertical.toLowerCase()}"`);
    if (node.layoutMode && node.layoutMode !== "NONE") props.push(`layout="${node.layoutMode.toLowerCase()}"`);
    if (node.layoutSizingHorizontal) props.push(`sizing-h="${node.layoutSizingHorizontal.toLowerCase()}"`);
    if (node.layoutSizingVertical) props.push(`sizing-v="${node.layoutSizingVertical.toLowerCase()}"`);
    if (node.layoutGrow != null && node.layoutGrow !== 0) props.push(`grow="${node.layoutGrow}"`);
    if (node.itemSpacing != null && node.itemSpacing !== 0) props.push(`gap="${node.itemSpacing}px"`);
    const pad = formatPadding(node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft);
    if (pad) props.push(`padding="${pad}"`);
    const alignMain = fmtAlign(node.primaryAxisAlignItems);
    if (alignMain && alignMain !== "min") props.push(`align-main="${alignMain}"`);
    const alignCross = fmtAlign(node.counterAxisAlignItems);
    if (alignCross && alignCross !== "min") props.push(`align-cross="${alignCross}"`);
    if (node.minWidth != null) props.push(`min-w="${node.minWidth}px"`);
    if (node.maxWidth != null) props.push(`max-w="${node.maxWidth}px"`);
    if (node.minHeight != null) props.push(`min-h="${node.minHeight}px"`);
    if (node.maxHeight != null) props.push(`max-h="${node.maxHeight}px"`);
    const fills = describeFills(node.fills);
    if (fills.length) props.push(`bg="${fills.join(", ")}"`);
    if (node.cornerRadius) props.push(`radius="${node.cornerRadius}px"`);
    if (node.topLeftRadius || node.topRightRadius || node.bottomRightRadius || node.bottomLeftRadius) {
      props.push(`radius="${node.topLeftRadius ?? 0}px ${node.topRightRadius ?? 0}px ${node.bottomRightRadius ?? 0}px ${node.bottomLeftRadius ?? 0}px"`);
    }
    const strokes = extractSolidColors(node.strokes);
    if (strokes.length) props.push(`border="${strokes.join(", ")}"`);
    if (node.strokeWeight != null && strokes.length) props.push(`stroke-w="${node.strokeWeight}px"`);
    if (node.opacity != null && node.opacity < 1) props.push(`opacity="${node.opacity}"`);
    const efx = formatEffects(node.effects);
    if (efx.length) props.push(`effects="${efx.join("; ")}"`);
    if (isExportable) props.push(`export-as="${isImageAsset ? "png" : "svg"}"`);
    const propStr = props.length ? " " + props.join(" ") : "";
    const tag = node.type === "GROUP" ? "Group" : "Frame";
    if (!inner) return `${indent}<${tag}${nameAttr}${idAttr}${propStr} />`;
    return `${indent}<${tag}${nameAttr}${idAttr}${propStr}>\n${inner}\n${indent}</${tag}>`;
  }

  /* ---- SHAPES & IMAGE FILLS ---- */
  if (SHAPE_TYPES.has(node.type) || hasImageFill(node.fills)) {
    const { x, y } = relXY(node);
    const box = node.absoluteBoundingBox;
    const props = [];
    if (x != null) props.push(`x="${x}px"`);
    if (y != null) props.push(`y="${y}px"`);
    if (box?.width) props.push(`w="${Math.round(box.width)}px"`);
    if (box?.height) props.push(`h="${Math.round(box.height)}px"`);
    if (node.constraints?.horizontal) props.push(`constraint-h="${node.constraints.horizontal.toLowerCase()}"`);
    if (node.constraints?.vertical) props.push(`constraint-v="${node.constraints.vertical.toLowerCase()}"`);
    const fills = describeFills(node.fills);
    if (fills.length) props.push(`fill="${fills.join(", ")}"`);
    const strokes = extractSolidColors(node.strokes);
    if (strokes.length) props.push(`border="${strokes.join(", ")}"`);
    if (node.strokeWeight != null && strokes.length) props.push(`stroke-w="${node.strokeWeight}px"`);
    if (node.cornerRadius) props.push(`radius="${node.cornerRadius}px"`);
    if (node.opacity != null && node.opacity < 1) props.push(`opacity="${node.opacity}"`);
    const efx = formatEffects(node.effects);
    if (efx.length) props.push(`effects="${efx.join("; ")}"`);
    if (isExportable) props.push(`export-as="${isImageAsset ? "png" : "svg"}"`);
    const isImage = hasImageFill(node.fills);
    const tag = isImage
      ? "ImageNode"
      : node.type.charAt(0) + node.type.slice(1).toLowerCase();
    const propStr = props.length ? " " + props.join(" ") : "";
    return `${indent}<${tag}${nameAttr}${idAttr}${propStr} />`;
  }

  /* ---- Default passthrough ---- */
  if (inner) return `${indent}<Node${nameAttr}${idAttr}>\n${inner}\n${indent}</Node>`;
  return "";
}

/* ------------------------------------------------------------------ */
/*  Flat geometry table — one row per layout-relevant node             */
/*                                                                    */
/*  Rules to keep the table token-efficient:                          */
/*  1. Max depth: GEO_MAX_DEPTH (6) — avoids icon internals           */
/*  2. Skip VECTOR / BOOLEAN_OPERATION — sub-shape primitives         */
/*  3. Treat INSTANCE as a leaf — never recurse into its children     */
/*     (icon library components hide thousands of off-canvas vectors) */
/*  4. Skip nodes that are entirely outside the root bounding box     */
/*     (off-canvas library frames with negative coordinates)          */
/*  5. Hard row cap: GEO_MAX_ROWS — truncates with a note             */
/* ------------------------------------------------------------------ */

const GEO_MAX_DEPTH = 6;
const GEO_MAX_ROWS = 300;
const GEO_SKIP_TYPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "REGULAR_POLYGON", "LINE"]);

function buildFlatGeometryTable(rootNode) {
  const rootBox = rootNode?.absoluteBoundingBox;
  const rows = [];
  let truncated = false;

  function walk(node, depth) {
    if (!node || typeof node !== "object") return;
    if (depth > GEO_MAX_DEPTH) return;
    if (rows.length >= GEO_MAX_ROWS) { truncated = true; return; }

    /* Skip pure vector primitives — not useful for layout */
    if (GEO_SKIP_TYPES.has(node.type)) return;

    const box = node.absoluteBoundingBox;

    /* Skip nodes that are entirely outside the root frame's canvas area.
       Off-canvas library components have wildly negative coordinates.
       Allow a 200px margin to catch edge-adjacent nodes. */
    if (rootBox && box) {
      const margin = 200;
      if (
        box.x + box.width < rootBox.x - margin ||
        box.y + box.height < rootBox.y - margin ||
        box.x > rootBox.x + rootBox.width + margin ||
        box.y > rootBox.y + rootBox.height + margin
      ) return;
    }

    const { x: rx, y: ry } = relXY(node);
    rows.push({
      id: node.id || "",
      name: (node.name || "").slice(0, 36),
      type: node.type || "",
      relX: rx != null ? rx : "",
      relY: ry != null ? ry : "",
      absX: box ? Math.round(box.x) : "",
      absY: box ? Math.round(box.y) : "",
      w: box ? Math.round(box.width) : "",
      h: box ? Math.round(box.height) : "",
      constraintH: node.constraints?.horizontal || "",
      constraintV: node.constraints?.vertical || "",
      layout: node.layoutMode && node.layoutMode !== "NONE" ? node.layoutMode.toLowerCase() : "",
      sizingH: node.layoutSizingHorizontal?.toLowerCase() || "",
      sizingV: node.layoutSizingVertical?.toLowerCase() || "",
      grow: node.layoutGrow || "",
      opacity: node.opacity != null ? node.opacity : "",
    });

    /* INSTANCE = leaf for geometry purposes (don't recurse into icon internals) */
    if (node.type === "INSTANCE") return;

    for (const ch of node.children || []) {
      walk(ch, depth + 1);
    }
  }

  walk(rootNode, 0);
  return { rows, truncated };
}

function renderFlatGeometryTable(node) {
  const { rows, truncated } = buildFlatGeometryTable(node);
  if (rows.length === 0) return "*(no layout nodes)*";

  const cols = [
    "id",
    "name",
    "type",
    "relX",
    "relY",
    "absX",
    "absY",
    "w",
    "h",
    "constraintH",
    "constraintV",
    "layout",
    "sizingH",
    "sizingV",
    "grow",
    "opacity",
  ];
  const header = `| ${cols.join(" | ")} |`;
  const divider = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${cols.map((c) => String(r[c])).join(" | ")} |`);

  const note = truncated
    ? `\n> ⚠ Table capped at ${GEO_MAX_ROWS} rows. Use a smaller \`maxDepth\` or target a child node directly.`
    : "";

  return [header, divider, ...body].join("\n") + note;
}

/* ------------------------------------------------------------------ */
/*  Design token extraction                                            */
/* ------------------------------------------------------------------ */

function extractDesignTokens(document) {
  const o = [];
  const fonts = new Set();
  const hexColors = new Set();
  const textStyles = new Set();

  function walkTokens(node) {
    if (!node || typeof node !== "object") return;
    for (const c of collectPaletteColors(node.fills, node.strokes)) {
      hexColors.add(c);
    }
    if (node.type === "TEXT" && node.style) {
      if (node.style.fontFamily) fonts.add(node.style.fontFamily);
      const ws = [];
      if (node.style.fontWeight) ws.push(`weight-${node.style.fontWeight}`);
      if (node.style.fontSize) ws.push(`${Math.round(node.style.fontSize)}px`);
      if (ws.length)
        textStyles.add(`${node.style.fontFamily || "Font"}: ${ws.join(", ")}`);
    }
    for (const ch of node.children || []) walkTokens(ch);
  }

  walkTokens(document);

  o.push("# Figma Design Tokens");
  o.push("");
  o.push("## Typography");
  o.push(`**Families:** ${Array.from(fonts).join(", ") || "None"}`);
  o.push("");
  o.push("### Text Styles");
  for (const style of Array.from(textStyles).slice(0, 30)) {
    o.push(`- ${style}`);
  }
  o.push("");
  o.push("## Colors");
  o.push("```css");
  o.push("/* Auto-generated — use ONLY these values in generated code */");
  o.push(":root {");
  let i = 1;
  for (const c of Array.from(hexColors).sort()) {
    o.push(`  --color-${i++}: ${c};`);
  }
  o.push("}");
  o.push("```");
  return o.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Assets-to-export section                                           */
/* ------------------------------------------------------------------ */

function renderAssetsSection(assets) {
  if (!assets || assets.length === 0) return "";

  const svgAssets = assets.filter((a) => a.format === "svg");
  const pngAssets = assets.filter((a) => a.format === "png");

  const lines = [
    "",
    "## Assets to Export (call `export_figma_assets` with these IDs)",
    "",
    "| Node ID | Name | Format | Size | Detected by |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const a of assets) {
    const size = a.w != null && a.h != null ? `${a.w}×${a.h}` : "—";
    lines.push(`| \`${a.id}\` | ${a.name} | ${a.format.toUpperCase()} | ${size} | ${a.reason} |`);
  }
  lines.push("");
  lines.push("> **Do NOT recreate these assets in code.** Call `export_figma_assets` for each group:");
  if (svgAssets.length) {
    const ids = svgAssets.map((a) => `\`${a.id}\``).join(", ");
    lines.push(`> - **SVG**: nodeIds=[${ids}], format=\`svg\``);
  }
  if (pngAssets.length) {
    const ids = pngAssets.map((a) => `\`${a.id}\``).join(", ");
    lines.push(`> - **PNG**: nodeIds=[${ids}], format=\`png\``);
  }
  lines.push("> Save the downloaded files and reference them via `<img>` or inline SVG. Do NOT hand-draw or hallucinate these assets.");
  lines.push("");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Shared output rules footer                                         */
/*  Appended to every tool result that contains structure or layout.  */
/*  Keeps the downstream model anchored on the numbers in the output. */
/* ------------------------------------------------------------------ */

const CODE_RULES_FOOTER = `
---
## Code Generation Rules (read before writing any code)
1. **Use ONLY the exact px values above** for width, height, gap, padding, border-radius. Do not round or scale them.
2. **Colors and fonts** must come from the design-tokens block (--color-N variables, named font families). Do not invent hex codes.
3. **Layout**: if \`layout="horizontal"\` → CSS \`display:flex; flex-direction:row\`. If \`layout="vertical"\` → \`flex-direction:column\`. No layout attr → use \`position:absolute\` with the x/y values.
4. **sizing-h / sizing-v**: \`fixed\` → explicit px dimension; \`fill\` → \`flex:1\` or \`width:100%\`; \`hug\` → \`width:fit-content\` / \`height:fit-content\`.
5. **Constraints**: \`scale\` → percentage widths; \`stretch\` → \`width:100%\`; \`center\` → margin auto; \`fixed\` → keep exact px.
6. **grow**: if > 0 → \`flex-grow: <value>\`.
7. **Emit exactly**: (a) token imports/variables, (b) one component per Frame, (c) one CSS class per node using the node name.
8. Do not add extra wrappers, comments, or utilities not present in the spec.
9. **\`export-as="svg"\` nodes** are external assets. Do NOT recreate them in code — call \`export_figma_assets\` with their \`id\` to get SVG download URLs, save the files, and reference them via \`<img>\` or inline SVG.
---`;

/* ------------------------------------------------------------------ */
/*  Mini token header — prepended to node-level dumps                 */
/* ------------------------------------------------------------------ */

function buildTokenHeader(document) {
  const fonts = new Set();
  const hexColors = new Set();

  function walk(node) {
    if (!node || typeof node !== "object") return;
    for (const c of collectPaletteColors(node.fills, node.strokes)) hexColors.add(c);
    if (node.type === "TEXT" && node.style?.fontFamily) fonts.add(node.style.fontFamily);
    for (const ch of node.children || []) walk(ch);
  }
  walk(document);

  const lines = ["## Token Constraints (enforce in generated code)"];
  lines.push(`- **Allowed fonts:** ${Array.from(fonts).join(", ") || "none"}`);
  lines.push(`- **Allowed colors (hex):** ${Array.from(hexColors).sort().join(", ") || "none"}`);
  lines.push("");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  MCP Server                                                         */
/* ------------------------------------------------------------------ */

const TOOL_NAMES = [
  "get_figma_file_structure",
  "get_figma_node_jsx",
  "get_figma_design_tokens",
  "export_figma_assets",
  "get_figma_node_spec",
  "get_figma_frame_with_image",
];

function createFigmaMcpServer() {
  const server = new Server(
    { name: "figma-to-code-mcp-os", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      /* ---- Step 1: explore ---- */
      {
        name: "get_figma_file_structure",
        description:
          "Step 1 — Call this first. Returns all pages and top-level frames/components (name, type, id). " +
          "Pick the nodeId you need, then call get_figma_node_spec (recommended) or get_figma_node_jsx.",
        inputSchema: {
          type: "object",
          properties: { fileKey: { type: "string", description: "Figma file key from the URL" } },
          required: ["fileKey"],
        },
      },
      /* ---- Step 2a: full spec (recommended for OS models) ---- */
      {
        name: "get_figma_node_spec",
        description:
          "Step 2 (preferred) — Given a nodeId from get_figma_file_structure, returns: " +
          "(a) token constraints block (allowed colors + fonts), " +
          "(b) canonical JSX tree with ALL layout fields (x, y, w, h, constraints, layout, sizing, grow, gap, padding, align, min/max, bg, radius, border, stroke-w, opacity, effects), " +
          "(c) flat geometry table (one row per node with absolute + relative positions), " +
          "(d) code-generation rules footer. " +
          "Use maxDepth (default 12) to reduce context for large frames.",
        inputSchema: {
          type: "object",
          properties: {
            fileKey: { type: "string" },
            nodeId: { type: "string", description: "Node ID from get_figma_file_structure" },
            maxDepth: { type: "number", description: "Max tree depth (default 12, reduce for large frames)" },
          },
          required: ["fileKey", "nodeId"],
        },
      },
      /* ---- Step 2b: JSX only ---- */
      {
        name: "get_figma_node_jsx",
        description:
          "Step 2 (alternative) — Returns the node as a canonical JSX tree only (no geometry table). " +
          "All props use fixed order: x y w h constraint-h constraint-v layout sizing-h sizing-v grow gap padding align-main align-cross min-w max-w min-h max-h bg radius border stroke-w opacity effects. " +
          "Use maxDepth to limit depth for large trees.",
        inputSchema: {
          type: "object",
          properties: {
            fileKey: { type: "string" },
            nodeId: { type: "string" },
            maxDepth: { type: "number", description: "Max tree depth, default 12" },
          },
          required: ["fileKey", "nodeId"],
        },
      },
      /* ---- Design tokens (whole file) ---- */
      {
        name: "get_figma_design_tokens",
        description:
          "Extracts fonts, text styles, and a CSS :root color block (--color-N variables) " +
          "scoped to a specific node when nodeId is provided (preferred — give the frame nodeId from the Figma URL). " +
          "Falls back to whole-file scan when nodeId is omitted. " +
          "Call once per frame; reuse in all generated code — do not invent hex codes or font names.",
        inputSchema: {
          type: "object",
          properties: {
            fileKey: { type: "string" },
            nodeId: { type: "string", description: "Frame/node ID to scope tokens to (recommended). Omit to scan whole file." },
          },
          required: ["fileKey"],
        },
      },
      /* ---- Multimodal: structure + reference image ---- */
      {
        name: "get_figma_frame_with_image",
        description:
          "Step 2 (multimodal) — Returns BOTH the canonical JSX spec AND a PNG download URL for the same frame. " +
          "Use the PNG as a visual reference to verify pixel accuracy; use the JSX numbers as the source of truth for code. " +
          "scale controls export resolution (1 = 1×, 2 = 2×, default 1).",
        inputSchema: {
          type: "object",
          properties: {
            fileKey: { type: "string" },
            nodeId: { type: "string" },
            maxDepth: { type: "number", description: "Max JSX tree depth, default 12" },
            scale: { type: "number", description: "PNG export scale 1–4, default 1" },
          },
          required: ["fileKey", "nodeId"],
        },
      },
      /* ---- Asset export ---- */
      {
        name: "export_figma_assets",
        description:
          "Returns download URLs for one or more nodes exported as SVG or PNG. " +
          "Use for icon/image assets; do not use for reference screenshots (use get_figma_frame_with_image instead). " +
          "Provide nodeIds array from get_figma_file_structure or the JSX id attributes.",
        inputSchema: {
          type: "object",
          properties: {
            fileKey: { type: "string" },
            nodeIds: { type: "array", items: { type: "string" } },
            format: { type: "string", enum: ["svg", "png"], description: "Export format (default: svg)" },
          },
          required: ["fileKey", "nodeIds"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const callT0 = Date.now();
    log("info", "tool", "call start", { tool: toolName, args: request.params.arguments });

    if (!TOOL_NAMES.includes(toolName)) throw new Error("Unknown tool");
    if (!FIGMA_TOKEN) {
      return { content: [{ type: "text", text: "FIGMA_ACCESS_TOKEN is not set." }], isError: true };
    }

    const args = request.params.arguments;
    const { fileKey, nodeId, nodeIds, format } = args;
    const maxDepth =
      typeof args.maxDepth === "number" && Number.isFinite(args.maxDepth)
        ? Math.min(Math.max(Math.floor(args.maxDepth), 0), MAX_WALK_DEPTH)
        : MAX_WALK_DEPTH;
    const scale =
      typeof args.scale === "number" && Number.isFinite(args.scale)
        ? Math.min(Math.max(args.scale, 1), 4)
        : 1;

    if (!fileKey || !FILE_KEY_RE.test(fileKey)) {
      return { content: [{ type: "text", text: "Invalid fileKey." }], isError: true };
    }

    try {
      /* ---- export_figma_assets ---- */
      if (toolName === "export_figma_assets") {
        if (!nodeIds || !Array.isArray(nodeIds) || nodeIds.length === 0) {
          return { content: [{ type: "text", text: "nodeIds array is required and must not be empty." }], isError: true };
        }
        if (nodeIds.some((id) => typeof id !== "string" || !NODE_ID_RE.test(id))) {
          return { content: [{ type: "text", text: "nodeIds must contain only valid node ID strings." }], isError: true };
        }
        const fmt = format === "png" ? "png" : "svg";
        const idsJoined = nodeIds.map((id) => encodeURIComponent(id)).join(",");
        const url = `https://api.figma.com/v1/images/${fileKey}?ids=${idsJoined}&format=${fmt}`;
        const response = await fetchFigmaWithRetry(url, FIGMA_TOKEN);
        if (response.data.err) throw new Error(response.data.err);
        const o = ["# Figma Assets Download URLs", ""];
        const images = response.data.images || {};
        for (const [id, link] of Object.entries(images)) {
          o.push(`- **Node \`${id}\`**: ${link ? `[Download ${fmt.toUpperCase()}](${link})` : "Export failed/Invalid"}`);
        }
        log("info", "tool", "call done", { tool: toolName, total_ms: Date.now() - callT0 });
        return { content: [{ type: "text", text: o.join("\n") }] };
      }

      /* ---- get_figma_file_structure (no nodeId needed) ---- */
      if (toolName === "get_figma_file_structure") {
        const url = `https://api.figma.com/v1/files/${fileKey}?depth=2`;
        const response = await fetchFigmaWithRetry(url, FIGMA_TOKEN);
        const document = response.data?.document;
        if (!document) return { content: [{ type: "text", text: "No document in Figma response." }], isError: true };
        const resultText = buildFigmaFileStructure(document);
        log("info", "tool", "call done", { tool: toolName, total_ms: Date.now() - callT0 });
        return { content: [{ type: "text", text: resultText }] };
      }

      /* ---- get_figma_design_tokens ---- */
      /* When nodeId is provided: scope to that node's subtree only.
         When omitted: fall back to whole-file scan (legacy behaviour). */
      if (toolName === "get_figma_design_tokens") {
        let tokenDocument;
        if (nodeId != null && (typeof nodeId !== "string" || !NODE_ID_RE.test(nodeId))) {
          return { content: [{ type: "text", text: "Invalid nodeId." }], isError: true };
        }
        if (nodeId) {
          const nodeUrl = `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`;
          const response = await fetchFigmaWithRetry(nodeUrl, FIGMA_TOKEN);
          tokenDocument = response.data?.nodes?.[nodeId]?.document;
          if (!tokenDocument) return { content: [{ type: "text", text: `Node "${nodeId}" not found.` }], isError: true };
        } else {
          const response = await fetchFigmaWithRetry(`https://api.figma.com/v1/files/${fileKey}`, FIGMA_TOKEN);
          tokenDocument = response.data?.document;
          if (!tokenDocument) return { content: [{ type: "text", text: "No document in Figma response." }], isError: true };
        }
        const resultText = extractDesignTokens(tokenDocument);
        log("info", "tool", "call done", { tool: toolName, total_ms: Date.now() - callT0 });
        return { content: [{ type: "text", text: resultText }] };
      }

      /* ---- tools that require nodeId ---- */
      if (!nodeId || !NODE_ID_RE.test(nodeId)) {
        return { content: [{ type: "text", text: "Invalid or missing nodeId." }], isError: true };
      }
      const nodeUrl = `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`;
      const response = await fetchFigmaWithRetry(nodeUrl, FIGMA_TOKEN);
      const document = response.data?.nodes?.[nodeId]?.document;
      if (!document) return { content: [{ type: "text", text: `Node "${nodeId}" not found.` }], isError: true };

      /* ---- get_figma_node_jsx ---- */
      if (toolName === "get_figma_node_jsx") {
        const assets = [];
        const jsx = walkFigmaTreeToJSX(document, 0, maxDepth, 2, assets);
        const resultText =
          `# Figma JSX — Node \`${nodeId}\`\n\n` +
          `\`\`\`jsx\n${jsx}\n\`\`\`` +
          renderAssetsSection(assets) +
          CODE_RULES_FOOTER;
        log("info", "tool", "call done", { tool: toolName, total_ms: Date.now() - callT0, exportable_assets: assets.length });
        return { content: [{ type: "text", text: resultText }] };
      }

      /* ---- get_figma_node_spec ---- */
      if (toolName === "get_figma_node_spec") {
        const tokenHeader = buildTokenHeader(document);
        const assets = [];
        const jsx = walkFigmaTreeToJSX(document, 0, maxDepth, 2, assets);
        const geoTable = renderFlatGeometryTable(document);
        const resultText =
          `# Figma Node Spec — \`${nodeId}\`\n\n` +
          tokenHeader +
          `## Canonical JSX Tree\n\n` +
          `\`\`\`jsx\n${jsx}\n\`\`\`\n\n` +
          `## Flat Geometry Table (all nodes)\n\n` +
          geoTable +
          renderAssetsSection(assets) +
          CODE_RULES_FOOTER;
        log("info", "tool", "call done", { tool: toolName, total_ms: Date.now() - callT0, exportable_assets: assets.length });
        return { content: [{ type: "text", text: resultText }] };
      }

      /* ---- get_figma_frame_with_image ---- */
      if (toolName === "get_figma_frame_with_image") {
        const imgUrl =
          `https://api.figma.com/v1/images/${fileKey}` +
          `?ids=${encodeURIComponent(nodeId)}&format=png&scale=${scale}`;
        const imgResponse = await fetchFigmaWithRetry(imgUrl, FIGMA_TOKEN);
        if (imgResponse.data.err) throw new Error(imgResponse.data.err);
        const pngUrl = imgResponse.data.images?.[nodeId] || null;

        const tokenHeader = buildTokenHeader(document);
        const assets = [];
        const jsx = walkFigmaTreeToJSX(document, 0, maxDepth, 2, assets);
        const resultText =
          `# Figma Frame Spec + Reference Image — \`${nodeId}\`\n\n` +
          (pngUrl
            ? `## Reference PNG (${scale}×)\n> Use this image to verify pixel accuracy. Numbers in JSX are the source of truth.\n\n![frame](${pngUrl})\n\n`
            : "*(PNG export failed — use JSX numbers only)*\n\n") +
          tokenHeader +
          `## Canonical JSX Tree\n\n` +
          `\`\`\`jsx\n${jsx}\n\`\`\`` +
          renderAssetsSection(assets) +
          CODE_RULES_FOOTER;
        log("info", "tool", "call done", { tool: toolName, total_ms: Date.now() - callT0, exportable_assets: assets.length });
        return { content: [{ type: "text", text: resultText }] };
      }

      throw new Error("Unhandled tool");
    } catch (error) {
      const status = error.response?.status;
      const msg = error.response?.data?.err ?? error.message;
      log("error", "tool", "call failed", { tool: toolName, status, msg });
      return {
        content: [{ type: "text", text: `Error: ${status ? `HTTP ${status}: ` : ""}${msg}` }],
        isError: true,
      };
    }
  });

  return server;
}

/* ------------------------------------------------------------------ */
/*  SSE transport (Express)                                            */
/* ------------------------------------------------------------------ */

async function startSseServer() {
  const app = createMcpExpressApp(
    MCP_ALLOWED_HOSTS?.length
      ? { host: HOST, allowedHosts: MCP_ALLOWED_HOSTS }
      : { host: HOST },
  );

  /* ---------- request logger middleware ---------- */
  app.use((req, res, next) => {
    const start = Date.now();
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    log("info", "http", "request", {
      method: req.method,
      path: req.originalUrl,
      ip,
      ua: req.headers["user-agent"]?.slice(0, 80),
    });
    res.on("finish", () => {
      log("info", "http", "response", {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        elapsed_ms: Date.now() - start,
      });
    });
    next();
  });

  /* ---------- health / debug endpoint ---------- */
  app.get("/health", (_req, res) => {
    const activeSessions = [];
    for (const [id, meta] of sessions) {
      activeSessions.push({
        id,
        connectedAt: meta.connectedAt,
        alive_s: Math.round((Date.now() - meta.connectedAtMs) / 1000),
        heartbeats: meta.heartbeats,
        messagesReceived: meta.messagesReceived,
        toolCalls: meta.toolCalls,
      });
    }
    res.json({
      status: "ok",
      version: VERSION,
      uptime_s: Math.round(process.uptime()),
      memMb: Math.round(process.memoryUsage().rss / 1e6),
      activeSessions,
      figmaTokenSet: !!FIGMA_TOKEN,
      sseKeepaliveMs: SSE_KEEPALIVE_MS,
    });
  });

  /* ---------- SSE keepalive heartbeat ---------- */
  function startHeartbeat(res, sessionId) {
    const iv = setInterval(() => {
      try {
        if (res.writableEnded || res.destroyed) {
          clearInterval(iv);
          return;
        }
        res.write(":ping\n\n");
        const meta = sessions.get(sessionId);
        if (meta) meta.heartbeats++;
      } catch (err) {
        log("warn", "heartbeat", "write failed", {
          sessionId,
          error: err.message,
        });
        clearInterval(iv);
      }
    }, SSE_KEEPALIVE_MS);
    return iv;
  }

  /* ---------- SSE endpoint ---------- */
  app.get(MCP_SSE_PATH, async (req, res) => {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    log("info", "sse", "new connection attempt", { ip });

    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true, 30_000);
    req.socket.setTimeout(0);
    res.setTimeout(0);

    try {
      const transport = new SSEServerTransport(MCP_MESSAGES_PATH, res);
      const sessionId = transport.sessionId;
      transports.set(sessionId, transport);

      sessions.set(sessionId, {
        connectedAt: new Date().toISOString(),
        connectedAtMs: Date.now(),
        ip,
        heartbeats: 0,
        messagesReceived: 0,
        toolCalls: 0,
      });

      log("info", "sse", "session created", { sessionId, ip });

      const heartbeatIv = startHeartbeat(res, sessionId);

      transport.onclose = () => {
        clearInterval(heartbeatIv);
        const meta = sessions.get(sessionId);
        const alive_s = meta
          ? Math.round((Date.now() - meta.connectedAtMs) / 1000)
          : "?";
        log("info", "sse", "session closed", {
          sessionId,
          alive_s,
          heartbeats: meta?.heartbeats,
          messagesReceived: meta?.messagesReceived,
          toolCalls: meta?.toolCalls,
        });
        sessions.delete(sessionId);
        transports.delete(sessionId);
      };

      res.on("close", () => {
        log("info", "sse", "response stream closed by client", {
          sessionId,
        });
      });
      res.on("error", (err) => {
        log("error", "sse", "response stream error", {
          sessionId,
          error: err.message,
        });
      });

      const server = createFigmaMcpServer();
      await server.connect(transport);
      log("info", "sse", "MCP server connected to transport", { sessionId });
    } catch (error) {
      log("error", "sse", "connection setup failed", {
        error: error.message,
        stack: error.stack?.split("\n").slice(0, 5).join(" | "),
      });
      if (!res.headersSent) {
        res.status(500).send("Error establishing SSE stream");
      }
    }
  });

  /* ---------- Messages endpoint ---------- */
  app.post(MCP_MESSAGES_PATH, async (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) {
      log("warn", "messages", "missing sessionId");
      res.status(400).send("Missing sessionId parameter");
      return;
    }
    const transport = transports.get(sessionId);
    if (!transport) {
      log("warn", "messages", "session not found", {
        sessionId,
        activeSessions: transports.size,
      });
      res.status(404).send("Session not found");
      return;
    }

    const meta = sessions.get(sessionId);
    if (meta) meta.messagesReceived++;
    if (meta && req.body?.method === "tools/call") {
      meta.toolCalls++;
    }

    log("info", "messages", "incoming", {
      sessionId,
      bodyMethod: req.body?.method,
      bodyId: req.body?.id,
    });

    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      log("error", "messages", "handlePostMessage failed", {
        sessionId,
        error: error.message,
        stack: error.stack?.split("\n").slice(0, 5).join(" | "),
      });
      if (!res.headersSent) {
        res.status(500).send("Error handling request");
      }
    }
  });

  /* ---------- Start server ---------- */
  httpServer = app.listen(PORT, HOST, () => {
    log("info", "server", "started", {
      version: VERSION,
      host: HOST,
      port: PORT,
      ssePath: MCP_SSE_PATH,
      messagesPath: MCP_MESSAGES_PATH,
      sseKeepaliveMs: SSE_KEEPALIVE_MS,
      figmaTokenSet: !!FIGMA_TOKEN,
      figmaTimeoutMs: FIGMA_TIMEOUT_MS,
      nodeVersion: process.version,
    });
    if (HOST === "0.0.0.0" || HOST === "::") {
      log(
        "info",
        "server",
        `External: http://<PUBLIC_IP>:${PORT}${MCP_SSE_PATH}`,
      );
    } else {
      log(
        "info",
        "server",
        `Local: http://${HOST}:${PORT}${MCP_SSE_PATH}`,
      );
    }
  });

  httpServer.keepAliveTimeout = 120_000;
  httpServer.headersTimeout = 125_000;
  httpServer.requestTimeout = 0;
  httpServer.timeout = 0;
}

/* ------------------------------------------------------------------ */
/*  Stdio transport                                                    */
/* ------------------------------------------------------------------ */

async function startStdioServer() {
  const server = createFigmaMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("info", "server", "started in stdio mode", { version: VERSION });
}

/* ------------------------------------------------------------------ */
/*  Graceful shutdown                                                  */
/* ------------------------------------------------------------------ */

async function gracefulShutdown(signal) {
  log("info", "server", `${signal} received, shutting down`);

  const forceTimer = setTimeout(() => {
    log("warn", "server", "forced exit after timeout");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();

  for (const [id, transport] of transports) {
    try {
      await transport.close();
    } catch (e) {
      log("error", "server", `close session ${id} failed`, {
        error: e.message,
      });
    }
  }
  transports.clear();
  sessions.clear();

  if (httpServer) {
    httpServer.close(() => {
      clearTimeout(forceTimer);
      process.exit(0);
    });
  } else {
    clearTimeout(forceTimer);
    process.exit(0);
  }
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
  log("error", "process", "uncaughtException", {
    error: err.message,
    stack: err.stack?.split("\n").slice(0, 8).join(" | "),
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log("error", "process", "unhandledRejection", {
    error: String(reason),
    stack: reason?.stack?.split("\n").slice(0, 8).join(" | "),
  });
  process.exit(1);
});

/* ------------------------------------------------------------------ */
/*  Entry point                                                        */
/* ------------------------------------------------------------------ */

if (process.argv.includes("--stdio")) {
  await startStdioServer();
} else {
  await startSseServer();
}
