// index.js v6 — Figma → SCSS + Icons + Fonts + ZIP
// --------------------------------------------------
// ✅ Меню дій (SCSS / Fonts / Icons / All)
// ✅ Оновлює тільки існуючі змінні в SCSS (кольори / текст / тіні)
// ✅ Експорт іконок (SVG only) з прогресом
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

const clamp01 = (n) => Math.max(0, Math.min(1, typeof n === "number" ? n : 0));
const to255 = (x) => Math.round((x ?? 0) * 255);
const hex2 = (v) => v.toString(16).padStart(2, "0");
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
const px = (n) => `${Math.round(n || 0)}px`;

// ---------- FIGMA API ----------
async function figmaGET(url) {
  const res = await fetch(url, { headers: FIGMA_HEADERS });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.err || data?.message || `HTTP ${res.status}`);
  }
  return data;
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
  const aggregated = { variables: [], collections: [], modes: [] };
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

async function fetchFrame(fileId, nodeId) {
  const nodes = await fetchNodesById(fileId, [nodeId]);
  const doc = nodes.get(nodeId);
  if (!doc) throw new Error("Не знайдено документ фрейму.");
  return doc;
}

function extractFileAndNode(url) {
  const fileMatch = url.match(/(?:file|design)\/([a-zA-Z0-9]+)\//);
  const nodeMatch = url.match(/node-id=([0-9:-]+)/);
  return {
    fileId: fileMatch ? fileMatch[1] : null,
    nodeId: nodeMatch ? decodeURIComponent(nodeMatch[1]).replace(/-/g, ":") : null,
  };
}

// ---------- STYLES → SCSS ----------
const STYLE_TO_SCSS = {
  "Greyscale / 900": "--greyscale--900",
  "Greyscale / 800": "--greyscale--800",
  "Greyscale / 700": "--greyscale--700",
  "Greyscale / 600": "--greyscale--600",
  "Greyscale / 500": "--greyscale--500",
  "Greyscale / 400": "--greyscale--400",
  "Greyscale / 300": "--greyscale--300",
  "Greyscale / 200": "--greyscale--200",
  "Greyscale / 100": "--greyscale--100",
  "Mobile / Headline 1": "--mobile---headline-1",
  "Mobile / Headline 2": "--mobile---headline-2",
  "Mobile / Headline 3": "--mobile---headline-3",
  "Mobile / Body": "--mobile---body",
};

function emptyTokenMaps() {
  return {
    colors: new Map(),
    fontSizes: new Map(),
    lineHeights: new Map(),
    shadows: new Map(),
  };
}

function composeAlpha(effectiveOpacity, paintOpacity, colorAlpha) {
  return clamp01(effectiveOpacity * paintOpacity * colorAlpha);
}

function extractColorFromStyleNode(node) {
  if (!node) return null;
  const fills = Array.isArray(node.fills) ? node.fills : [];
  for (const paint of fills) {
    if (!paint || paint.visible === false) continue;
    const paintOpacity = clamp01(typeof paint.opacity === "number" ? paint.opacity : 1);
    if (paint.type === "SOLID" && paint.color) {
      const alpha = composeAlpha(1, paintOpacity, typeof paint.color.a === "number" ? paint.color.a : 1);
      return rgbaOrHex(paint.color, alpha);
    }
    if (paint.type && paint.type.startsWith("GRADIENT") && Array.isArray(paint.gradientStops)) {
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
  }
  return null;
}

function extractTypographyFromStyleNode(node) {
  if (!node?.style) return null;
  const { fontSize, lineHeightPx, lineHeightPercentFontSize } = node.style;
  const result = {};
  if (typeof fontSize === "number" && fontSize > 0) {
    result.fontSize = px(fontSize);
  }
  if (typeof lineHeightPx === "number" && lineHeightPx > 0) {
    result.lineHeight = px(lineHeightPx);
  } else if (
    typeof lineHeightPercentFontSize === "number" &&
    Number.isFinite(lineHeightPercentFontSize)
  ) {
    const ratio = lineHeightPercentFontSize / 100;
    result.lineHeight = `${Number(ratio.toFixed(3)).toString()}`.replace(/\.0+$/, "");
  }
  return Object.keys(result).length ? result : null;
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
    const col = rgbaOrHex(e.color, typeof e.color?.a === "number" ? e.color.a : 1);
    parts.push([offX, offY, blur, col].join(" "));
  }
  return parts.length ? parts.join(", ") : null;
}

async function collectStyleTokens(fileId) {
  const tokens = emptyTokenMaps();
  const styles = await fetchFileStyles(fileId);
  if (!styles.length) return tokens;

  const styleNodes = await fetchNodesById(
    fileId,
    styles.map((s) => s.node_id)
  );

  for (const style of styles) {
    const scssName = STYLE_TO_SCSS[style.name];
    if (!scssName) continue;
    const node = styleNodes.get(style.node_id);
    if (!node) continue;

    if (style.style_type === "FILL") {
      const val = extractColorFromStyleNode(node);
      if (val) tokens.colors.set(scssName, val);
      continue;
    }
    if (style.style_type === "TEXT") {
      const typo = extractTypographyFromStyleNode(node);
      if (typo?.fontSize) tokens.fontSizes.set(scssName, typo.fontSize);
      if (typo?.lineHeight) tokens.lineHeights.set(scssName, typo.lineHeight);
      continue;
    }
    if (style.style_type === "EFFECT") {
      const shadow = extractShadowFromStyleNode(node);
      if (shadow) tokens.shadows.set(scssName, shadow);
    }
  }

  return tokens;
}

function chooseVariableModeId(variable, collections) {
  const values = variable?.valuesByMode;
  if (!values || !Object.keys(values).length) return null;
  const collection = collections.get(variable?.variableCollectionId);
  const preferred = collection?.defaultModeId;
  if (preferred && values[preferred]) return preferred;
  return Object.keys(values)[0];
}

function resolveVariableAlias(variableMap, value, modeId, depth = 0) {
  if (!value || depth > 50) return null;
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

function tokenTypeFromName(scssName) {
  const n = (scssName || "").toLowerCase();
  if (n.includes("line-height") || n.includes("line_height")) return "lineHeights";
  if (n.includes("shadow")) return "shadows";
  if (n.includes("font") || n.includes("text") || n.includes("headline"))
    return "fontSizes";
  return "colors";
}

async function collectVariableTokens(fileId) {
  const tokens = emptyTokenMaps();
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
    const scssName = STYLE_TO_SCSS[variable.name];
    if (!scssName) continue;
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
      if (formatted) tokens.colors.set(scssName, formatted);
      continue;
    }

    if (variable.resolvedType === "FLOAT") {
      const numeric =
        typeof rawValue === "number"
          ? rawValue
          : typeof rawValue?.value === "number"
          ? rawValue.value
          : null;
      if (numeric == null) continue;
      const key = tokenTypeFromName(scssName);
      if (key === "lineHeights") tokens.lineHeights.set(scssName, px(numeric));
      else tokens.fontSizes.set(scssName, px(numeric));
      continue;
    }

    if (variable.resolvedType === "STRING") {
      if (tokenTypeFromName(scssName) === "shadows") {
        const str = typeof rawValue === "string" ? rawValue.trim() : null;
        if (str) tokens.shadows.set(scssName, str);
      }
    }
  }

  return tokens;
}

function mergeTokenMaps(base, extra) {
  const out = emptyTokenMaps();
  for (const [k, v] of base.colors) out.colors.set(k, v);
  for (const [k, v] of base.fontSizes) out.fontSizes.set(k, v);
  for (const [k, v] of base.lineHeights) out.lineHeights.set(k, v);
  for (const [k, v] of base.shadows) out.shadows.set(k, v);
  for (const [k, v] of extra.colors) if (!out.colors.has(k)) out.colors.set(k, v);
  for (const [k, v] of extra.fontSizes)
    if (!out.fontSizes.has(k)) out.fontSizes.set(k, v);
  for (const [k, v] of extra.lineHeights)
    if (!out.lineHeights.has(k)) out.lineHeights.set(k, v);
  for (const [k, v] of extra.shadows) if (!out.shadows.has(k)) out.shadows.set(k, v);
  return out;
}

// ---------- FRAME TRAVERSE (fonts + icons) ----------
const ICON_TYPES = new Set(["VECTOR", "INSTANCE", "COMPONENT"]);

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
    fonts: new Set(),
    iconNodes: [],
  };
}

const isIconNode = (node) =>
  (node.type === "VECTOR" || node.type === "COMPONENT" || node.type === "INSTANCE") &&
  node.width <= 32 &&
  node.height <= 32;

function traverseFrame(node, acc, ancestryNames = []) {
  if (!node || node.visible === false) return;
  const currentNames = node.name ? [...ancestryNames, node.name] : ancestryNames;

  if (node.type === "TEXT" && node.style) {
    const { fontSize, fontFamily, fontWeight, italic } = node.style;
    if (fontFamily) {
      const weight = Number(fontWeight) || guessWeightFromName(node.name || "");
      const it = italic ? "i" : "n";
      acc.fonts.add(`${fontFamily}::${weight}::${it}`);
    }
  }

  if (isIconNode(node)) {
    acc.iconNodes.push({ idPath: node.id, namePath: currentNames });
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) traverseFrame(child, acc, currentNames);
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

async function updateScssVariables(scssPath, fileId) {
  const styleTokens = await collectStyleTokens(fileId);
  const variableTokens = await collectVariableTokens(fileId);
  const tokens = mergeTokenMaps(styleTokens, variableTokens);

  const scssContent = readScss(scssPath);
  const vars = parseScssVars(scssContent);
  const updates = new Map();

  for (const v of vars) {
    if (tokens.colors.has(v.varName)) {
      updates.set(v.varName, tokens.colors.get(v.varName));
      continue;
    }
    if (tokens.fontSizes.has(v.varName)) {
      updates.set(v.varName, tokens.fontSizes.get(v.varName));
      continue;
    }
    if (tokens.lineHeights.has(v.varName)) {
      updates.set(v.varName, tokens.lineHeights.get(v.varName));
      continue;
    }
    if (tokens.shadows.has(v.varName)) {
      updates.set(v.varName, tokens.shadows.get(v.varName));
    }
  }

  console.log(chalk.green(`🎨 Кольори: ${tokens.colors.size}`));
  console.log(chalk.green(`🅰️ Font-size: ${tokens.fontSizes.size}`));
  console.log(chalk.green(`📏 Line-height: ${tokens.lineHeights.size}`));
  console.log(chalk.green(`🌫️ Тіні: ${tokens.shadows.size}`));

  const bak = backupScss(scssPath);
  const { text: newScss, changed } = replaceScss(scssContent, updates);
  if (changed > 0) fs.writeFileSync(scssPath, newScss, "utf8");

  console.log(chalk.gray(`💾 Резервна копія: ${bak}`));
  console.log(
    chalk.green(`✅ SCSS ${changed > 0 ? "оновлено" : "без змін"} (${changed} змін)`)
  );

  return { tokens };
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

// ---------- ACTIONS ----------
async function actionUpdateScss(scssPath, fileId) {
  console.log(chalk.cyan("\n🔧 Оновлення SCSS змінних..."));
  const res = await updateScssVariables(scssPath, fileId);
  return res;
}

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

    const result = await downloadFamilyFromWebfontsHelper(
      usage.name,
      usage.variants,
      outFonts
    );

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

async function exportImages(fileId, nodeId) {
  // TODO: Implement export of images >100px, scale 2x + original
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
    console.error(chalk.red("❌ Неможливо отримати file_id або node_id з URL Figma"));
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

  if (action === "scss" || action === "all") {
    const { tokens } = await actionUpdateScss(scssPath, fileId);
    summary.colors = tokens.colors.size;
    summary.fontSizes = tokens.fontSizes.size;
    summary.lineHeights = tokens.lineHeights.size;
    summary.shadows = tokens.shadows.size;
  }

  if (action === "fonts" || action === "all") {
    const fontRes = await actionFonts(fileId, nodeId);
    summary.fontsOk = fontRes.ok;
    summary.fontsManual = fontRes.manual;
  }

  if (action === "icons" || action === "all") {
    const iconRes = await actionIcons(fileId, nodeId);
    summary.iconsOk = iconRes.ok;
    summary.iconsTotal = iconRes.table.length;
  }

  const zipPath = path.join("dist", "export_Figma.zip");
  await createZip(zipPath, [scssPath, path.join("dist", "assets")]);
  console.log(chalk.green(`\n📦 ZIP оновлено: ${zipPath}`));

  console.log(chalk.cyan("\n────────────── РЕЗЮМЕ ──────────────"));
  if (summary.colors || summary.fontSizes || summary.lineHeights || summary.shadows) {
    console.log(`🎨 Кольори: ${summary.colors}`);
    console.log(`🅰️ Font-size:  ${summary.fontSizes}`);
    console.log(`📏 Line-height: ${summary.lineHeights}`);
    console.log(`🌫️ Тіні:       ${summary.shadows}`);
  }
  if (summary.iconsTotal) {
    console.log(`🖼️ Іконки:  ${summary.iconsOk}/${summary.iconsTotal} (успішно)`);
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
