// index.js v5.1 — Figma → SCSS + Icons + Fonts + ZIP
// --------------------------------------------------
// ✅ Меню дій (SCSS / Fonts / Icons / All)
// ✅ Оновлює тільки існуючі змінні в SCSS (кольори / текст / тіні)
// ✅ Експорт іконок (SVG → PNG fallback) з прогресом
// ✅ Завантаження шрифтів через Webfonts Helper API (woff2)
// ✅ Розкладання шрифтів по папках Regular / Bold / Black / …
// ✅ Імена файлів: Rubik-Bold.woff2, Cuprum-Regular.woff2, ...
// ✅ Архів dist/export_Figma.zip після кожної дії
// ✅ Лог-таблиця для іконок, акуратні кольори логів

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import inquirer from "inquirer";
import dotenv from "dotenv";
import chalk from "chalk";
import JSZip from "jszip";

dotenv.config();

// ---------- ENV ----------
const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
if (!FIGMA_TOKEN) {
  console.error(chalk.red("❌ FIGMA_TOKEN не знайдено у .env"));
  process.exit(1);
}
const FIGMA_HEADERS = { "X-Figma-Token": FIGMA_TOKEN };

// ---------- SMALL UTILS ----------
const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function fetchWithRetry(url, options = {}, attempts = 3, delayMs = 300) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await sleep(delayMs * attempt);
        continue;
      }
    }
  }
  throw lastError;
}

const slug = (s = "") =>
  s
    .toString()
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_\-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "node";

const SHADOW_VALUE_RE = /(rgba?|#)[^;]*\d+px[^;]*\d+px/;

const GENERIC_NODE_NAMES = new Set([
  "rectangle",
  "rect",
  "frame",
  "auto layout",
  "group",
  "component",
  "component set",
  "instance",
  "vector",
  "ellipse",
  "line",
  "text",
]);

function normalizePathNames(names = []) {
  return names
    .map((n) => (n || "").trim())
    .filter(Boolean)
    .map((n) => n.replace(/\s+/g, " "));
}

function splitSegmentIntoTokens(segment = "") {
  const trimmed = (segment || "").trim();
  if (!trimmed) return [];
  const normalized = trimmed
    .replace(/[(){}\[\]]/g, " ")
    .replace(/[._]/g, " ")
    .replace(/[\u2010-\u2015]/g, " ")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2");
  const tokens = normalized
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return tokens.length ? tokens : [trimmed];
}

function collectSlugVariants(segments = []) {
  const cleaned = segments
    .map((segment) => (segment || "").trim())
    .filter(Boolean);
  if (!cleaned.length) return [];

  const exploded = cleaned.flatMap((seg) => splitSegmentIntoTokens(seg));
  if (!exploded.length) return [];

  const slugs = new Set();
  const addSlug = (parts) => {
    if (!parts?.length) return;
    const s = slug(parts.filter(Boolean).join(" "));
    if (s) slugs.add(s);
  };

  // contiguous slices (усі підпослідовності, не тільки суфікси)
  for (let start = 0; start < exploded.length; start++) {
    for (let end = start + 1; end <= exploded.length; end++) {
      addSlug(exploded.slice(start, end));
    }
  }

  // pairwise combos (first + last, first + any child, etc.)
  if (exploded.length >= 2) {
    for (let i = 0; i < exploded.length - 1; i++) {
      for (let j = i + 1; j < exploded.length; j++) {
        addSlug([exploded[i], exploded[j]]);
      }
    }
  }

  return Array.from(slugs).sort((a, b) => b.length - a.length);
}

function buildSlugCandidates(names = []) {
  const normalized = normalizePathNames(names);
  if (!normalized.length) return [];
  const meaningful = normalized.filter(
    (name) => !GENERIC_NODE_NAMES.has(name.toLowerCase())
  );
  const segments = meaningful.length ? meaningful : normalized;
  return collectSlugVariants(segments);
}

function buildVarSlugCandidates(varName = "") {
  const clean = (varName || "")
    .replace(/^--/, "")
    .replace(/_/g, "-")
    .replace(/\s+/g, "-");
  const pieces = clean.split(/-+/).filter(Boolean);
  if (!pieces.length) return [];
  return collectSlugVariants(pieces);
}

function assignValueBySlug(map, slugs, value) {
  if (!Array.isArray(slugs) || !slugs.length || value == null) return;
  for (const s of slugs) {
    if (!s) continue;
    map.set(s, value);
  }
}

function pickValueBySlug(map, slugCandidates) {
  if (!map || !slugCandidates?.length) return null;
  for (const s of slugCandidates) {
    if (map.has(s)) return map.get(s);
  }
  return null;
}

const to255 = (x) => Math.round((x ?? 0) * 255);
const hex2 = (v) => v.toString(16).padStart(2, "0");

const clamp01 = (n) => Math.max(0, Math.min(1, typeof n === "number" ? n : 0));

const rgbaOrHex = (color, alphaOverride) => {
  if (!color) return null;
  const a = clamp01(
    typeof alphaOverride === "number"
      ? alphaOverride
      : typeof color.a === "number"
      ? color.a
      : 1
  );
  const r = to255(color.r);
  const g = to255(color.g);
  const b = to255(color.b);
  return a < 1
    ? `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`
    : `#${hex2(r)}${hex2(g)}${hex2(b)}`;
};

const FONT_SIZE_HINT_RE =
  /(font|text|headline|title|display|body|caption|paragraph|button|size|desktop---|mobile---)/;
const LINE_HEIGHT_HINT_RE = /(lineheight|line-height|leading|line|\blh\b)/;
const DESKTOP_HINT_RE = /(desktop|desk|web|lg|xl|xxl|hd|desktop---)/;

function slugMatches(slugs, regex) {
  if (!slugs?.length) return false;
  return slugs.some((s) => regex.test(s));
}

function inferDesktopFromSlugs(slugs) {
  return slugMatches(slugs, DESKTOP_HINT_RE);
}

function coerceNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "object" && value !== null) {
    if (typeof value.value === "number" && Number.isFinite(value.value)) {
      return value.value;
    }
    if (typeof value.v === "number" && Number.isFinite(value.v)) {
      return value.v;
    }
  }
  return null;
}

function formatFontSizeNumber(value, slugs) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const isDesktop = inferDesktopFromSlugs(slugs);
  return wrapRem(px(value), isDesktop);
}

function formatLineHeightNumber(value, slugs) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value <= 5) {
    const formatted = formatUnitless(value);
    return formatted || null;
  }
  const isDesktop = inferDesktopFromSlugs(slugs);
  return wrapRem(px(value), isDesktop);
}

const px = (n) => `${Math.round(n || 0)}px`;
const wrapRem = (pxVal, isDesktop) =>
  isDesktop ? `#{remD(${pxVal})}` : `#{rem(${pxVal})}`;

const formatUnitless = (num) => {
  if (typeof num !== "number" || !Number.isFinite(num)) return null;
  const fixed = Number(num.toFixed(3));
  return `${fixed}`.replace(/\.0+$/, "").replace(/(\.\d*?[1-9])0+$/, "$1");
};

function formatLineHeight(style, isDesktop) {
  if (!style) return null;
  if (typeof style.lineHeightPx === "number" && style.lineHeightPx > 0) {
    return wrapRem(px(style.lineHeightPx), isDesktop);
  }
  const percent =
    typeof style.lineHeightPercentFontSize === "number"
      ? style.lineHeightPercentFontSize
      : typeof style.lineHeightPercentFontSize === "string"
      ? parseFloat(style.lineHeightPercentFontSize)
      : null;
  if (percent && Number.isFinite(percent)) {
    const ratio = percent / 100;
    const formatted = formatUnitless(ratio);
    if (formatted) return formatted;
  }
  return null;
}

function extractFileAndNode(url) {
  const fileMatch = url.match(/(?:file|design)\/([a-zA-Z0-9]+)\//);
  const nodeMatch = url.match(/node-id=([0-9:-]+)/);
  return {
    fileId: fileMatch ? fileMatch[1] : null,
    nodeId: nodeMatch
      ? decodeURIComponent(nodeMatch[1]).replace(/-/g, ":")
      : null,
  };
}

// ---------- FIGMA API ----------
async function figmaGET(url) {
  const res = await fetch(url, { headers: FIGMA_HEADERS });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.err || data?.message || `HTTP ${res.status}`);
  }
  return data;
}

async function fetchFrame(fileId, nodeId) {
  const nodes = await fetchNodesById(fileId, [nodeId]);
  const doc = nodes.get(nodeId);
  if (!doc) throw new Error("Не знайдено документ фрейму.");
  return doc;
}

async function fetchNodesById(fileId, nodeIds = []) {
  const uniqueIds = Array.from(new Set(nodeIds.filter(Boolean)));
  const result = new Map();
  if (!uniqueIds.length) return result;
  const chunkSize = 45;
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    const url = `https://api.figma.com/v1/files/${fileId}/nodes?ids=${encodeURIComponent(
      chunk.join(",")
    )}`;
    const data = await figmaGET(url);
    const nodeMap = data?.nodes || {};
    for (const id of chunk) {
      const doc = nodeMap?.[id]?.document;
      if (doc) result.set(id, doc);
    }
  }
  return result;
}

async function fetchFileStyles(fileId) {
  const url = `https://api.figma.com/v1/files/${fileId}/styles`;
  const data = await figmaGET(url);
  return Array.isArray(data?.meta?.styles) ? data.meta.styles : [];
}

async function fetchVariablePayload(fileId, scope) {
  const url = `https://api.figma.com/v1/files/${fileId}/variables/${scope}`;
  try {
    const data = await figmaGET(url);
    return data?.meta || null;
  } catch (err) {
    const msg = (err?.message || "").toLowerCase();
    if (msg.includes("http 404") || msg.includes("http 403")) {
      console.warn(
        chalk.gray(
          `⚠️  Variables ${scope} недоступні для цього файлу (${err.message})`
        )
      );
      return null;
    }
    throw err;
  }
}

async function fetchVariablesForFile(fileId) {
  const scopes = ["local", "published"];
  const aggregated = {
    variables: [],
    collections: [],
    modes: [],
  };
  const seenVariables = new Set();
  const seenCollections = new Set();
  const seenModes = new Set();
  for (const scope of scopes) {
    const meta = await fetchVariablePayload(fileId, scope);
    if (!meta) continue;
    if (Array.isArray(meta.variables)) {
      for (const variable of meta.variables) {
        if (!variable?.id || seenVariables.has(variable.id)) continue;
        seenVariables.add(variable.id);
        aggregated.variables.push(variable);
      }
    }
    if (Array.isArray(meta.variableCollections)) {
      for (const collection of meta.variableCollections) {
        if (!collection?.id || seenCollections.has(collection.id)) continue;
        seenCollections.add(collection.id);
        aggregated.collections.push(collection);
      }
    }
    if (Array.isArray(meta.modes)) {
      for (const mode of meta.modes) {
        if (!mode?.modeId || seenModes.has(mode.modeId)) continue;
        seenModes.add(mode.modeId);
        aggregated.modes.push(mode);
      }
    }
  }
  return aggregated;
}

// ---------- FRAME TRAVERSE ----------
const ICON_NAME_RE =
  /icon|icn|glyph|logo|arrow|chevron|close|burger|menu|play|pause|cart|search|user|heart|plus|minus|star/i;
const ICON_TYPES = new Set([
  "VECTOR",
  "BOOLEAN_OPERATION",
  "STAR",
  "LINE",
  "ELLIPSE",
  "POLYGON",
  "RECTANGLE",
  "REGULAR_POLYGON",
  "INSTANCE",
  "COMPONENT",
  "COMPONENT_SET",
  "FRAME",
  "GROUP",
]);

function guessWeightFromName(name) {
  const n = (name || "").toLowerCase();
  if (/thin/.test(n)) return 100;
  if (/extralight|ultralight/.test(n)) return 200;
  if (/light/.test(n)) return 300;
  if (/regular|book|normal/.test(n)) return 400;
  if (/medium/.test(n)) return 500;
  if (/semibold|demibold/.test(n)) return 600;
  if (/bold/.test(n)) return 700;
  if (/extrabold|ultrabold/.test(n)) return 800;
  if (/black|heavy/.test(n)) return 900;
  return 400;
}

function createTraversalAccumulator() {
  return {
    colorsBySlug: new Map(),
    fontSizeBySlug: new Map(),
    lineHeightBySlug: new Map(),
    shadowsBySlug: new Map(),
    fonts: new Set(),
    iconNodes: [],
  };
}

function emptyStyleTokens() {
  return {
    colorsBySlug: new Map(),
    fontSizeBySlug: new Map(),
    lineHeightBySlug: new Map(),
    shadowsBySlug: new Map(),
  };
}

function mergeSlugMaps(target, source) {
  if (!target || !source) return;
  for (const [slugKey, val] of source) {
    target.set(slugKey, val);
  }
}

function paintToColorString(paint) {
  if (!paint || paint.visible === false) return null;
  const paintOpacity = clamp01(typeof paint.opacity === "number" ? paint.opacity : 1);
  if (paint.type === "SOLID" && paint.color) {
    const alpha = composeAlpha(1, paintOpacity, typeof paint.color.a === "number" ? paint.color.a : 1);
    return rgbaOrHex(paint.color, alpha);
  }
  if (
    paint.type &&
    paint.type.startsWith("GRADIENT") &&
    Array.isArray(paint.gradientStops)
  ) {
    const firstStop = paint.gradientStops[0];
    if (firstStop?.color) {
      const alpha = composeAlpha(
        1,
        paintOpacity,
        typeof firstStop.color.a === "number" ? firstStop.color.a : 1
      );
      return rgbaOrHex(firstStop.color, alpha);
    }
  }
  return null;
}

function extractColorFromStyleNode(node) {
  if (Array.isArray(node?.fills)) {
    for (const paint of node.fills) {
      const val = paintToColorString(paint);
      if (val) return val;
    }
  }
  if (Array.isArray(node?.strokes)) {
    for (const paint of node.strokes) {
      const val = paintToColorString(paint);
      if (val) return val;
    }
  }
  return null;
}

function extractShadowFromStyleNode(node) {
  if (!Array.isArray(node?.effects)) return null;
  const parts = [];
  for (const e of node.effects) {
    if (!e || e.visible === false) continue;
    if (e.type !== "DROP_SHADOW" && e.type !== "INNER_SHADOW") continue;
    const offX = px(e.offset?.x ?? 0);
    const offY = px(e.offset?.y ?? 0);
    const blur = px(e.radius ?? 0);
    const alpha = composeAlpha(1, 1, typeof e.color?.a === "number" ? e.color.a : 1);
    const col = rgbaOrHex(e.color, alpha);
    parts.push([offX, offY, blur, col].join(" "));
  }
  return parts.length ? parts.join(", ") : null;
}

function extractTypographyFromStyleNode(node, slugHints, target) {
  if (!node?.style) return;
  const { fontSize } = node.style;
  const hasFontSize = typeof fontSize === "number" && fontSize > 0;
  const pathHint = (node.name || "").toLowerCase();
  const isDesktop = pathHint.includes("desktop") || (hasFontSize && fontSize >= 20);
  if (hasFontSize) {
    const sizePx = px(fontSize);
    assignValueBySlug(target.fontSizeBySlug, slugHints, wrapRem(sizePx, isDesktop));
  }
  const lineHeight = formatLineHeight(node.style, isDesktop);
  if (lineHeight)
    assignValueBySlug(target.lineHeightBySlug, slugHints, lineHeight);
}

async function collectStyleTokens(fileId) {
  const tokens = emptyStyleTokens();
  const styles = await fetchFileStyles(fileId);
  if (!styles.length) return tokens;
  const interesting = styles.filter((s) =>
    s?.style_type && ["FILL", "TEXT", "EFFECT"].includes(s.style_type)
  );
  if (!interesting.length) return tokens;
  const nodes = await fetchNodesById(
    fileId,
    interesting.map((s) => s.node_id)
  );
  for (const style of interesting) {
    const node = nodes.get(style.node_id);
    if (!node) continue;
    const pathSegments = (style.name || "")
      .split("/")
      .map((p) => p.trim())
      .filter(Boolean);
    const slugHints = buildSlugCandidates(pathSegments);
    if (!slugHints.length) continue;
    if (style.style_type === "FILL") {
      const val = extractColorFromStyleNode(node);
      if (val) assignValueBySlug(tokens.colorsBySlug, slugHints, val);
      continue;
    }
    if (style.style_type === "TEXT") {
      extractTypographyFromStyleNode(node, slugHints, tokens);
      continue;
    }
    if (style.style_type === "EFFECT") {
      const val = extractShadowFromStyleNode(node);
      if (val) assignValueBySlug(tokens.shadowsBySlug, slugHints, val);
    }
  }
  return tokens;
}

function chooseVariableModeId(variable, collectionMap) {
  const values = variable?.valuesByMode;
  if (!values || !Object.keys(values).length) return null;
  const collection = collectionMap.get(variable?.variableCollectionId);
  const preferred = collection?.defaultModeId;
  if (preferred && values[preferred]) return preferred;
  return Object.keys(values)[0];
}

function resolveVariableAlias(variableMap, value, modeId, depth = 0) {
  if (!value) return null;
  if (depth > 50) return null;
  if (value.type === "VARIABLE_ALIAS" && value.id) {
    const target = variableMap.get(value.id);
    if (!target) return null;
    const nextValue = target.valuesByMode?.[modeId];
    return resolveVariableAlias(variableMap, nextValue, modeId, depth + 1);
  }
  return value;
}

function normalizeVariableColorValue(entry) {
  if (!entry) return null;
  if (
    typeof entry.r === "number" &&
    typeof entry.g === "number" &&
    typeof entry.b === "number"
  ) {
    return {
      r: clamp01(entry.r),
      g: clamp01(entry.g),
      b: clamp01(entry.b),
      a: typeof entry.a === "number" ? clamp01(entry.a) : 1,
    };
  }
  if (typeof entry === "string" && /^#/.test(entry)) {
    const hex = entry.replace(/^#/, "");
    if (hex.length === 3 || hex.length === 6) {
      const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
      const num = parseInt(full, 16);
      if (!Number.isNaN(num)) {
        return {
          r: ((num >> 16) & 255) / 255,
          g: ((num >> 8) & 255) / 255,
          b: (num & 255) / 255,
          a: 1,
        };
      }
    }
  }
  return null;
}

async function collectVariableTokens(fileId) {
  const tokens = emptyStyleTokens();
  const meta = await fetchVariablesForFile(fileId);
  if (!meta?.variables?.length) return tokens;

  const collectionMap = new Map();
  for (const col of meta.collections || []) {
    if (col?.id) collectionMap.set(col.id, col);
  }

  const variableMap = new Map();
  for (const variable of meta.variables) {
    if (variable?.id) variableMap.set(variable.id, variable);
  }

  for (const variable of meta.variables) {
    if (!variable) continue;
    const segments = (variable.name || "")
      .split("/")
      .map((p) => p.trim())
      .filter(Boolean);
    const slugHints = buildSlugCandidates(segments);
    if (!slugHints.length) continue;
    const modeId = chooseVariableModeId(variable, collectionMap);
    if (!modeId) continue;
    const rawValue = resolveVariableAlias(
      variableMap,
      variable.valuesByMode?.[modeId],
      modeId
    );

    if (variable.resolvedType === "COLOR") {
      const colorValue = normalizeVariableColorValue(rawValue);
      if (!colorValue) continue;
      const formatted = rgbaOrHex(colorValue, colorValue.a);
      if (formatted) assignValueBySlug(tokens.colorsBySlug, slugHints, formatted);
      continue;
    }

    if (variable.resolvedType === "FLOAT") {
      const numeric = coerceNumber(rawValue);
      if (numeric == null) continue;
      const wantsLineHeight = slugMatches(slugHints, LINE_HEIGHT_HINT_RE);
      const wantsFontSize = slugMatches(slugHints, FONT_SIZE_HINT_RE);
      if (wantsFontSize) {
        const formatted = formatFontSizeNumber(numeric, slugHints);
        if (formatted) assignValueBySlug(tokens.fontSizeBySlug, slugHints, formatted);
        continue;
      }
      if (wantsLineHeight) {
        const formatted = formatLineHeightNumber(numeric, slugHints);
        if (formatted)
          assignValueBySlug(tokens.lineHeightBySlug, slugHints, formatted);
      }
      continue;
    }

    if (variable.resolvedType === "STRING") {
      const str = typeof rawValue === "string" ? rawValue.trim() : null;
      if (str && SHADOW_VALUE_RE.test(str)) {
        assignValueBySlug(tokens.shadowsBySlug, slugHints, str);
      }
    }
  }

  return tokens;
}

// обхід дерева фрейму, збираємо все одразу
function effectiveNodeOpacity(node) {
  return clamp01(typeof node?.opacity === "number" ? node.opacity : 1);
}

function composeAlpha(effectiveOpacity, paintOpacity, colorAlpha) {
  return clamp01(effectiveOpacity * paintOpacity * colorAlpha);
}

function traverseFrame(node, acc, ancestryNames = [], inheritedOpacity = 1) {
  if (!node || node.visible === false) return;
  const currentNames = node.name ? [...ancestryNames, node.name] : ancestryNames;
  const pathHint = currentNames.join("/").toLowerCase();
  const nodeOpacity = effectiveNodeOpacity(node);
  const cumulativeOpacity = clamp01(inheritedOpacity * nodeOpacity);
  const slugHints = buildSlugCandidates(currentNames);

  // КОЛЬОРИ (fills + strokes)
  if (Array.isArray(node.fills)) {
    for (const f of node.fills) {
      if (!f || f.visible === false) continue;
      const paintOpacity = clamp01(
        typeof f.opacity === "number" ? f.opacity : 1
      );
      if (f.type === "SOLID" && f.color) {
        const alpha = composeAlpha(
          cumulativeOpacity,
          paintOpacity,
          typeof f.color.a === "number" ? f.color.a : 1
        );
        const val = rgbaOrHex(f.color, alpha);
        if (val) assignValueBySlug(acc.colorsBySlug, slugHints, val);
      }
      if (
        f.type &&
        f.type.startsWith("GRADIENT") &&
        Array.isArray(f.gradientStops)
      ) {
        for (const stop of f.gradientStops) {
          if (!stop?.color) continue;
          const alpha = composeAlpha(
            cumulativeOpacity,
            paintOpacity,
            typeof stop.color.a === "number" ? stop.color.a : 1
          );
          const val = rgbaOrHex(stop.color, alpha);
          if (val) assignValueBySlug(acc.colorsBySlug, slugHints, val);
        }
      }
    }
  }
  if (Array.isArray(node.strokes)) {
    for (const s of node.strokes) {
      if (!s || s.visible === false) continue;
      const paintOpacity = clamp01(
        typeof s.opacity === "number" ? s.opacity : 1
      );
      if (s.type === "SOLID" && s.color) {
        const alpha = composeAlpha(
          cumulativeOpacity,
          paintOpacity,
          typeof s.color.a === "number" ? s.color.a : 1
        );
        const val = rgbaOrHex(s.color, alpha);
        if (val) assignValueBySlug(acc.colorsBySlug, slugHints, val);
      }
      if (
        s.type &&
        s.type.startsWith("GRADIENT") &&
        Array.isArray(s.gradientStops)
      ) {
        for (const stop of s.gradientStops) {
          if (!stop?.color) continue;
          const alpha = composeAlpha(
            cumulativeOpacity,
            paintOpacity,
            typeof stop.color.a === "number" ? stop.color.a : 1
          );
          const val = rgbaOrHex(stop.color, alpha);
          if (val) assignValueBySlug(acc.colorsBySlug, slugHints, val);
        }
      }
    }
  }

  // ТЕКСТ (розміри + шрифти)
  if (node.type === "TEXT" && node.style) {
    const { fontSize, fontFamily, fontWeight, italic } = node.style;
    const hasFontSize = typeof fontSize === "number" && fontSize > 0;
    const isDesktop = pathHint.includes("desktop") || (hasFontSize && fontSize >= 20);
    if (hasFontSize) {
      const sizePx = px(fontSize);
      assignValueBySlug(
        acc.fontSizeBySlug,
        slugHints,
        wrapRem(sizePx, isDesktop)
      );
    }
    const lineHeight = formatLineHeight(node.style, isDesktop);
    if (lineHeight) assignValueBySlug(acc.lineHeightBySlug, slugHints, lineHeight);
    if (fontFamily) {
      const weight = Number(fontWeight) || guessWeightFromName(node.name || "");
      const it = italic ? "i" : "n";
      acc.fonts.add(`${fontFamily}::${weight}::${it}`);
    }
  }

  // ТІНІ
  if (Array.isArray(node.effects)) {
    const parts = [];
    for (const e of node.effects) {
      if (!e || e.visible === false) continue;
      if (e.type !== "DROP_SHADOW" && e.type !== "INNER_SHADOW") continue;
      const offX = px(e.offset?.x ?? 0);
      const offY = px(e.offset?.y ?? 0);
      const blur = px(e.radius ?? 0);
      const effectAlpha = composeAlpha(
        cumulativeOpacity,
        1,
        typeof e.color?.a === "number" ? e.color.a : 1
      );
      const col = rgbaOrHex(e.color, effectAlpha);
      parts.push([offX, offY, blur, col].join(" "));
    }
    if (parts.length) assignValueBySlug(acc.shadowsBySlug, slugHints, parts.join(", "));
  }

  // ІКОНКИ (кандидати)
  const isIconCandidate =
    (node.name && ICON_NAME_RE.test(node.name)) || ICON_TYPES.has(node.type);
  if (isIconCandidate) {
    acc.iconNodes.push({ idPath: node.id, namePath: currentNames });
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children)
      traverseFrame(child, acc, currentNames, cumulativeOpacity);
  }
}

// ---------- SCSS PARSE / UPDATE ----------
function readScss(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`SCSS не знайдено: ${filePath}`);
  return fs.readFileSync(filePath, "utf8");
}

function backupScss(filePath) {
  const bak = `${filePath}.bak`;
  fs.writeFileSync(bak, fs.readFileSync(filePath));
  return bak;
}

function parseScssVars(content) {
  const re = /(\-\-[A-Za-z0-9_\-]+)\s*:\s*([^;]+);/g;
  const vars = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    vars.push({ varName: m[1], value: m[2].trim() });
  }
  return vars;
}

// Спочатку аналізуємо значення (hex/rgba/rem/тіні), а потім назву, щоб
// --body-color не став текстовим розміром, а --text-size-mobile не підхоплював
// палітру. Таким чином класифікація покриває більше кейсів без ручних винятків.
function classifyVar(name, value) {
  const n = (name || "").toLowerCase();
  const v = (value || "").trim().toLowerCase();
  const looksHex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(v);
  const looksRgba = /^rgba?\(/.test(v);
  const looksRemFn = /#\{remd?\(/.test(v) || /rem\(/.test(v);
  const looksShadowValue = SHADOW_VALUE_RE.test(v);
  const looksPxNumber = /\d+px/.test(v);
  const looksUnitlessNumber = /^-?\d+(?:\.\d+)?$/.test(v);
  const mentionsLineHeight = /line[-_ ]?height|leading|lineheight|\blh\b/.test(n);
  const looksNormalLine = v === "normal";

  if (looksHex || looksRgba) return "color";
  if (looksShadowValue) return "shadow";
  if (mentionsLineHeight || looksNormalLine) return "lineHeight";
  if (looksUnitlessNumber && mentionsLineHeight) return "lineHeight";
  if (looksRemFn || (/font|text|headline|caption|body|button|size/.test(n) && looksPxNumber))
    return "fontSize";
  if (looksUnitlessNumber && /leading|line/.test(n)) return "lineHeight";

  if (/shadow|elevation|drop/.test(n)) return "shadow";
  if (/color|greyscale|primary|secondary|support|special|accent|fill|bg|background/.test(n))
    return "color";
  if (/line[-_ ]?height|leading|lineheight|\blh\b/.test(n)) return "lineHeight";
  if (/font|text|headline|caption|body|button|size|desktop---|mobile---/.test(n))
    return "fontSize";
  return null;
}

function replaceScss(content, updatesMap) {
  if (!updatesMap.size) return { text: content, changed: 0 };
  let changed = 0;
  const out = content.replace(
    /(\-\-[A-Za-z0-9_\-]+)\s*:\s*([^;]+);/g,
    (m, name, oldVal) => {
      if (!updatesMap.has(name)) return m;
      const newVal = updatesMap.get(name);
      if (String(oldVal).trim() === String(newVal).trim()) return m;
      changed++;
      return `${name}: ${newVal};`;
    }
  );
  return { text: out, changed };
}

// ---------- ICON EXPORT ----------
function uniqName(base, used) {
  let name = base;
  let i = 2;
  while (used.has(name)) {
    name = `${base}-${i++}`;
  }
  used.add(name);
  return name;
}

async function exportIcons(fileId, iconNodes, outIconsDir) {
  if (!iconNodes.length) {
    return { table: [], ok: 0 };
  }
  ensureDir(outIconsDir);
  const usedNames = new Set();

  const rows = [];
  let okCount = 0;

  const chunkSize = 80;
  let processed = 0;
  const total = iconNodes.length;

  // SVG спроба
  for (let i = 0; i < iconNodes.length; i += chunkSize) {
    const chunk = iconNodes.slice(i, i + chunkSize);
    const idsParam = chunk.map((n) => n.idPath).join(",");
    const url = `https://api.figma.com/v1/images/${fileId}?ids=${encodeURIComponent(
      idsParam
    )}&format=svg&svg_include_id=true`;

    const data = await figmaGET(url);
    const map = data?.images || {};

    for (const node of chunk) {
      const rawName = node.namePath[node.namePath.length - 1] || "icon";
      const base = uniqName(slug(rawName), usedNames);
      const imgUrl = map[node.idPath];

      if (imgUrl) {
        try {
          const res = await fetch(imgUrl);
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            const filePath = path.join(outIconsDir, `${base}.svg`);
            fs.writeFileSync(filePath, buf);
            rows.push({ name: base, fmt: "svg", status: "✅" });
            okCount++;
          } else {
            rows.push({ name: base, fmt: "svg", status: "⚠️" });
          }
        } catch {
          rows.push({ name: base, fmt: "svg", status: "⚠️" });
        }
      } else {
        rows.push({ name: base, fmt: "svg", status: "—" });
      }
      processed++;
      const percent = Math.round((processed / total) * 100);
      process.stdout.write(
        `\r${chalk.cyan("⏳ Експорт іконок")}: ${processed}/${total} (${percent}%)   `
      );
    }
  }

  // PNG fallback для тих, що не ОК
  const needPng = rows.filter((r) => r.status !== "✅");
  if (needPng.length) {
    for (let i = 0; i < needPng.length; i += chunkSize) {
      const sub = needPng.slice(i, i + chunkSize);
      const ids = iconNodes
        .filter((n) =>
          sub.some(
            (r) =>
              slug(n.namePath[n.namePath.length - 1] || "icon") === r.name
          )
        )
        .map((n) => n.idPath)
        .join(",");

      if (!ids) continue;

      const url = `https://api.figma.com/v1/images/${fileId}?ids=${encodeURIComponent(
        ids
      )}&format=png&scale=2`;
      const data = await figmaGET(url);
      const map = data?.images || {};

      for (const row of sub) {
        const node = iconNodes.find(
          (n) =>
            slug(n.namePath[n.namePath.length - 1] || "icon") === row.name
        );
        if (!node) continue;
        const imgUrl = map[node.idPath];
        if (imgUrl) {
          try {
            const res = await fetch(imgUrl);
            if (res.ok) {
              const buf = Buffer.from(await res.arrayBuffer());
              const filePath = path.join(outIconsDir, `${row.name}.png`);
              fs.writeFileSync(filePath, buf);
              row.fmt = "png";
              row.status = "✅";
              okCount++;
            } else {
              row.fmt = "png";
              row.status = "⚠️";
            }
          } catch {
            row.fmt = "png";
            row.status = "⚠️";
          }
        }
      }
    }
  }

  process.stdout.write("\n");
  return { table: rows, ok: okCount };
}

function printIconTable(rows) {
  if (!rows.length) {
    console.log(chalk.gray("🖼️ Іконки: 0"));
    return;
  }
  const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
  console.log(chalk.cyan("\n🖼️ Іконки:"));
  console.log("Назва".padEnd(24), "Формат".padEnd(8), "Статус");
  console.log("-".repeat(24), "-".repeat(8), "-".repeat(8));
  for (const r of rows.slice(0, 30)) {
    console.log(pad(r.name, 24), pad(r.fmt, 8), r.status);
  }
  if (rows.length > 30) {
    console.log(chalk.gray(`  ... +${rows.length - 30} ще`));
  }
  const ok = rows.filter((r) => r.status === "✅").length;
  console.log("-".repeat(24), "-".repeat(8), "-".repeat(8));
  console.log(`Разом: ${rows.length} (успішно ${ok})`);
}

// ---------- WEBFONTS HELPER (FONTS) ----------
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "text/css,*/*;q=0.1",
};

function buildWebfontsSlug(name) {
  return (name || "")
    .toString()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseVariantKey(key) {
  const k = (key || "").toLowerCase();
  let italic = k.includes("italic") || /-italic$/.test(k);
  let weight = 400;

  const num = k.match(/\b([1-9]00)\b/);
  if (num) {
    weight = parseInt(num[1], 10);
  } else if (k.includes("thin")) weight = 100;
  else if (k.includes("extralight") || k.includes("ultralight")) weight = 200;
  else if (k.includes("light")) weight = 300;
  else if (k.includes("regular")) weight = 400;
  else if (k.includes("medium")) weight = 500;
  else if (k.includes("semibold") || k.includes("demibold")) weight = 600;
  else if (k.includes("bold")) weight = 700;
  else if (k.includes("extrabold") || k.includes("ultrabold")) weight = 800;
  else if (k.includes("black") || k.includes("heavy")) weight = 900;

  return { weight, italic };
}

function weightName(weight) {
  if (weight <= 150) return "Thin";
  if (weight <= 250) return "ExtraLight";
  if (weight <= 350) return "Light";
  if (weight <= 450) return "Regular";
  if (weight <= 550) return "Medium";
  if (weight <= 650) return "SemiBold";
  if (weight <= 750) return "Bold";
  if (weight <= 850) return "ExtraBold";
  return "Black";
}

function variantFolderName(weight, italic) {
  const base = weightName(weight);
  return italic ? `${base}Italic` : base;
}

function sanitizePathComponent(name, replaceSpaces = false) {
  const cleaned = (name || "")
    .toString()
    .replace(/[\\/:*?"<>|]/g, "")
    .trim();
  if (!cleaned) return "Font";
  return replaceSpaces ? cleaned.replace(/\s+/g, "-") : cleaned;
}

function renderFontProgress(name, percent, done = false) {
  const pct = Math.max(0, Math.min(100, percent | 0));
  const label = `⏳ ${name} ${pct}%`;
  const padded = label.padEnd(48, " ");
  process.stdout.write(`\r${padded}`);
  if (done) process.stdout.write("\n");
}

function writeManualList(outFontsDir, manualList) {
  const manualDir = path.join(outFontsDir, "manual");
  const manualFile = path.join(manualDir, "fonts.txt");
  if (manualList.length) {
    ensureDir(manualDir);
    const content = `These fonts require manual installation:\n${manualList
      .map((name) => `- ${name}`)
      .join("\n")}\n`;
    fs.writeFileSync(manualFile, content, "utf8");
  } else if (fs.existsSync(manualFile)) {
    fs.unlinkSync(manualFile);
    try {
      if (!fs.readdirSync(manualDir).length) {
        fs.rmdirSync(manualDir);
      }
    } catch {
      // ignore cleanup errors
    }
  }
}

async function downloadFamilyFromWebfontsHelper(familyName, variantsMap, outFontsDir) {
  const slugFamily = buildWebfontsSlug(familyName);
  if (!slugFamily) {
    return {
      count: 0,
      labels: [],
      manual: true,
      message: "empty-family-name",
    };
  }

  const url = `https://gwfh.mranftl.com/api/fonts/${encodeURIComponent(
    slugFamily
  )}?download=zip&subsets=latin&formats=woff2`;

  let res;
  try {
    res = await fetchWithRetry(url, { headers: BROWSER_HEADERS }, 3, 300);
  } catch (e) {
    return {
      count: 0,
      labels: [],
      manual: true,
      message: e.message || "request-failed",
    };
  }

  if (!res.ok) {
    return {
      count: 0,
      labels: [],
      manual: true,
      message: `HTTP ${res.status}`,
    };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const zip = await JSZip.loadAsync(buf);

  const variantMap = new Map();

  const hasRequestedVariants = variantsMap && variantsMap.size > 0;

  const files = [];
  zip.forEach((relPath, file) => {
    if (file.dir) return;
    if (!/\.woff2$/i.test(relPath)) return;
    files.push({ relPath, file });
  });

  for (const { relPath, file } of files) {
    const baseName = path.basename(relPath).toLowerCase().replace(/\.woff2$/i, "");
    const { weight, italic } = parseVariantKey(baseName);

    if (hasRequestedVariants) {
      const flags = variantsMap.get(weight);
      if (!flags) continue;
      if (italic && !flags.italic) continue;
      if (!italic && !flags.normal) continue;
    }

    const key = `${weight}-${italic ? "i" : "n"}`;
    if (!variantMap.has(key)) {
      variantMap.set(key, { file, weight, italic });
    }
  }

  const variants = [...variantMap.values()];
  if (!variants.length) {
    renderFontProgress(familyName, 100, true);
    return {
      count: 0,
      labels: [],
      manual: true,
      message: "no-matching-variants",
    };
  }

  const familyDirName = sanitizePathComponent(familyName);
  const familyForFile = sanitizePathComponent(familyName, false).replace(/\s+/g, "");
  const labels = [];

  let processed = 0;
  const total = variants.length;

  for (const v of variants) {
    const folderName = variantFolderName(v.weight, v.italic);
    const folderPath = path.join(outFontsDir, familyDirName, folderName);
    ensureDir(folderPath);

    const fileVariant = folderName; // e.g. Bold, RegularItalic
    const fileName = `${familyForFile}-${fileVariant}.woff2`;
    const filePath = path.join(folderPath, fileName);

    const content = await v.file.async("nodebuffer");
    fs.writeFileSync(filePath, content);
    labels.push(`${weightName(v.weight)}${v.italic ? " Italic" : ""}`);

    processed++;
    const percent = Math.round((processed / total) * 100);
    renderFontProgress(familyName, percent, processed === total);
  }

  return {
    count: variants.length,
    labels,
    manual: false,
    message: null,
  };
}

// ---------- ZIP ----------
async function createZip(outputPath, includePaths) {
  const zip = new JSZip();

  const addEntry = (fsPath, baseFolder = zip) => {
    if (!fs.existsSync(fsPath)) return;
    const stat = fs.statSync(fsPath);
    if (stat.isDirectory()) {
      const folder = baseFolder.folder(path.basename(fsPath));
      for (const item of fs.readdirSync(fsPath)) {
        addEntry(path.join(fsPath, item), folder);
      }
    } else {
      baseFolder.file(path.basename(fsPath), fs.readFileSync(fsPath));
    }
  };

  for (const p of includePaths) addEntry(p);

  const buf = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionLevel: 6,
  });
  ensureDir(path.dirname(outputPath));
  fs.writeFileSync(outputPath, buf);
}

// ---------- ACTION: UPDATE SCSS ----------
async function actionUpdateScss(scssPath, fileId, nodeId) {
  console.log(chalk.cyan("\n🔧 Оновлення SCSS змінних..."));
  const frame = await fetchFrame(fileId, nodeId);
  const acc = createTraversalAccumulator();
  traverseFrame(frame, acc);
  const styleTokens = await collectStyleTokens(fileId);
  const variableTokens = await collectVariableTokens(fileId);
  mergeSlugMaps(acc.colorsBySlug, styleTokens.colorsBySlug);
  mergeSlugMaps(acc.fontSizeBySlug, styleTokens.fontSizeBySlug);
  mergeSlugMaps(acc.lineHeightBySlug, styleTokens.lineHeightBySlug);
  mergeSlugMaps(acc.shadowsBySlug, styleTokens.shadowsBySlug);
  mergeSlugMaps(acc.colorsBySlug, variableTokens.colorsBySlug);
  mergeSlugMaps(acc.fontSizeBySlug, variableTokens.fontSizeBySlug);
  mergeSlugMaps(acc.lineHeightBySlug, variableTokens.lineHeightBySlug);
  mergeSlugMaps(acc.shadowsBySlug, variableTokens.shadowsBySlug);

  console.log(chalk.green(`🎨 Кольори: ${acc.colorsBySlug.size}`));
  console.log(chalk.green(`🅰️ Font-size: ${acc.fontSizeBySlug.size}`));
  console.log(chalk.green(`📏 Line-height: ${acc.lineHeightBySlug.size}`));
  console.log(chalk.green(`🌫️ Тіні: ${acc.shadowsBySlug.size}`));

  const scssContent = readScss(scssPath);
  const vars = parseScssVars(scssContent);
  const updates = new Map();

  for (const v of vars) {
    const type = classifyVar(v.varName, v.value);
    const slugCandidates = buildVarSlugCandidates(v.varName);
    if (!slugCandidates.length) continue;
    if (type === "color") {
      const val = pickValueBySlug(acc.colorsBySlug, slugCandidates);
      if (val) updates.set(v.varName, val);
    } else if (type === "fontSize") {
      const val = pickValueBySlug(acc.fontSizeBySlug, slugCandidates);
      if (val) updates.set(v.varName, val);
    } else if (type === "lineHeight") {
      const val = pickValueBySlug(acc.lineHeightBySlug, slugCandidates);
      if (val) updates.set(v.varName, val);
    } else if (type === "shadow") {
      const val = pickValueBySlug(acc.shadowsBySlug, slugCandidates);
      if (val) updates.set(v.varName, val);
    }
  }

  const bak = backupScss(scssPath);
  const { text: newScss, changed } = replaceScss(scssContent, updates);
  if (changed > 0) fs.writeFileSync(scssPath, newScss, "utf8");

  console.log(chalk.gray(`💾 Резервна копія: ${bak}`));
  console.log(
    chalk.green(
      `✅ SCSS ${changed > 0 ? "оновлено" : "без змін"} (${changed} змін)`
    )
  );

  return { frame, acc };
}

// ---------- ACTION: FONTS (Webfonts Helper) ----------
async function actionFonts(fileId, nodeId) {
  console.log(chalk.cyan("\n🔧 Завантаження шрифтів..."));
  const frame = await fetchFrame(fileId, nodeId);

  const accFonts = createTraversalAccumulator();
  traverseFrame(frame, accFonts);

  const fontKeys = [...accFonts.fonts];

  const usageMap = new Map();
  for (const key of fontKeys) {
    const [familyRaw = "", weightStr = "", italicFlag = "n"] = key.split("::");
    const fam = familyRaw.trim();
    if (!fam) continue;

    if (!usageMap.has(fam)) {
      usageMap.set(fam, {
        name: fam,
        variants: new Map(), // weight -> { normal, italic }
      });
    }
    const usage = usageMap.get(fam);
    const weight = Number(weightStr) || 400;
    const italic = italicFlag === "i";

    if (!usage.variants.has(weight)) {
      usage.variants.set(weight, { normal: false, italic: false });
    }
    usage.variants.get(weight)[italic ? "italic" : "normal"] = true;
  }

  const usages = [...usageMap.values()];
  if (!usages.length) {
    console.log(chalk.gray("⚠️ У фреймі не знайдено текстових шарів"));
    return { ok: 0, manual: 0 };
  }

  const fontsList = usages.map((u) => u.name).join(", ");
  console.log(chalk.green(`🖋️ Шрифти: ${fontsList}`));

  const outFonts = path.join("dist", "assets", "fonts");
  ensureDir(outFonts);

  const manualSet = new Set();
  let downloadedFamilies = 0;
  let processed = 0;
  const total = usages.length;

  for (const usage of usages) {
    processed++;
    const percent = Math.round((processed / total) * 100);
    process.stdout.write(
      `\r${chalk.cyan("⏳ Шрифти")} ${processed}/${total} (${percent}%)   `
    );

    process.stdout.write("\n");

    let result;
    try {
      result = await downloadFamilyFromWebfontsHelper(
        usage.name,
        usage.variants,
        outFonts
      );
    } catch (e) {
      result = {
        count: 0,
        labels: [],
        manual: true,
        message: e.message || "unknown-error",
      };
    }

    if (result.count > 0) {
      downloadedFamilies++;
      const fileWord =
        result.count === 1 ? "файл" : result.count >= 5 ? "файлів" : "файли";
      const details =
        result.labels && result.labels.length
          ? ` (${result.labels.join(", ")})`
          : "";
      console.log(
        chalk.green(
          `📚 ${usage.name}: ${result.count} ${fileWord}${details}`
        )
      );
    } else {
      if (result.message === "HTTP 404") {
        console.log(
          chalk.yellow(
            `⚠️ ${usage.name}: не знайдено у Webfonts Helper (ймовірно, не Google Fonts)`
          )
        );
      } else if (result.message === "no-matching-variants") {
        console.log(
          chalk.yellow(
            `⚠️ ${usage.name}: не знайдено потрібних варіантів (вага/italic)`
          )
        );
      } else {
        console.log(
          chalk.yellow(
            `⚠️ ${usage.name}: немає доступних woff2 файлів${
              result.message ? ` (${result.message})` : ""
            }`
          )
        );
      }
      manualSet.add(usage.name);
    }

    await sleep(120);
  }

  process.stdout.write("\n");

  const manualList = [...manualSet]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  writeManualList(outFonts, manualList);

  console.log(
    chalk.green(
      `✅ Завантажено: ${downloadedFamilies}, локальних/ручних: ${manualList.length}`
    )
  );
  return { ok: downloadedFamilies, manual: manualList.length };
}

// ---------- ACTION: ICONS ----------
async function actionIcons(fileId, nodeId) {
  console.log(chalk.cyan("\n🔧 Експорт іконок..."));
  const frame = await fetchFrame(fileId, nodeId);
  const acc = createTraversalAccumulator();
  traverseFrame(frame, acc);
  const iconsOut = path.join("dist", "assets", "icons");
  const res = await exportIcons(fileId, acc.iconNodes, iconsOut);
  printIconTable(res.table);
  return res;
}

// ---------- MAIN ----------
async function main() {
  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: "Обери дію:",
      choices: [
        { name: "1️⃣ Оновити SCSS змінні", value: "scss" },
        { name: "2️⃣ Завантажити шрифти", value: "fonts" },
        { name: "3️⃣ Експортувати іконки", value: "icons" },
        { name: "4️⃣ Все разом (SCSS + Fonts + Icons)", value: "all" },
        { name: "0️⃣ Вихід", value: "exit" },
      ],
    },
  ]);

  if (action === "exit") {
    console.log(chalk.gray("👋 Вихід"));
    return;
  }

  const { scssPath, figmaUrl } = await inquirer.prompt([
    {
      name: "scssPath",
      message: "SCSS шлях:",
      default: "dist/roots.scss",
    },
    {
      name: "figmaUrl",
      message: "Figma frame URL:",
    },
  ]);

  const { fileId, nodeId } = extractFileAndNode(figmaUrl);
  if (!fileId || !nodeId) {
    console.error(
      chalk.red("❌ Неможливо отримати file_id або node_id з URL Figma")
    );
    process.exit(1);
  }

  console.log(chalk.cyan(`\n🔍 file_id: ${fileId}`));
  console.log(chalk.cyan(`🔍 node_id: ${nodeId}`));

  let summary = {
    colors: 0,
    fontSizes: 0,
    lineHeights: 0,
    shadows: 0,
    iconsOk: 0,
    iconsTotal: 0,
    fontsOk: 0,
    fontsManual: 0,
  };

  // SCSS
  if (action === "scss" || action === "all") {
    const { acc } = await actionUpdateScss(scssPath, fileId, nodeId);
    summary.colors = acc.colorsBySlug.size;
    summary.fontSizes = acc.fontSizeBySlug.size;
    summary.lineHeights = acc.lineHeightBySlug.size;
    summary.shadows = acc.shadowsBySlug.size;
  }

  // Fonts
  if (action === "fonts" || action === "all") {
    const fontRes = await actionFonts(fileId, nodeId);
    summary.fontsOk = fontRes.ok;
    summary.fontsManual = fontRes.manual;
  }

  // Icons
  if (action === "icons" || action === "all") {
    const iconRes = await actionIcons(fileId, nodeId);
    summary.iconsOk = iconRes.ok;
    summary.iconsTotal = iconRes.table.length;
  }

  // ZIP
  const zipPath = path.join("dist", "export_Figma.zip");
  await createZip(zipPath, [scssPath, path.join("dist", "assets")]);
  console.log(chalk.green(`\n📦 ZIP оновлено: ${zipPath}`));

  console.log(chalk.cyan("\n────────────── РЕЗЮМЕ ──────────────"));
  if (
    summary.colors ||
    summary.fontSizes ||
    summary.lineHeights ||
    summary.shadows
  ) {
    console.log(`🎨 Кольори: ${summary.colors}`);
    console.log(`🅰️ Font-size:  ${summary.fontSizes}`);
    console.log(`📏 Line-height: ${summary.lineHeights}`);
    console.log(`🌫️ Тіні:       ${summary.shadows}`);
  }
  if (summary.iconsTotal) {
    console.log(
      `🖼️ Іконки:  ${summary.iconsOk}/${summary.iconsTotal} (успішно)`
    );
  }
  if (summary.fontsOk || summary.fontsManual) {
    console.log(
      `📚 Шрифти: завантажено ${summary.fontsOk}, локальних/ручних ${summary.fontsManual}`
    );
  }
  console.log("────────────────────────────────────");
  console.log(chalk.green("✅ Успішне завершення!"));
}

main().catch((e) => {
  console.error(chalk.red(`❌ Помилка: ${e.message}`));
  process.exit(1);
});

