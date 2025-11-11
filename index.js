// figma-scss-bot/index.js
import fetch from "node-fetch";
import fs from "fs";
import inquirer from "inquirer";
import dotenv from "dotenv";

dotenv.config();

const FIGMA_TOKEN = process.env.FIGMA_TOKEN;

if (!FIGMA_TOKEN) {
  console.error("❌ Environment variable FIGMA_TOKEN не знайдена. Додай її до .env та перезапусти скрипт.");
  process.exit(1);
}

const headers = { "X-Figma-Token": FIGMA_TOKEN };
// Підтримує і старі (/file/) і нові (/design/) посилання Figma
function extractFileId(url) {
  const match = url.match(/(?:file|design)\/([a-zA-Z0-9]+)\//);
  return match ? match[1] : null;
}

function extractNodeId(url) {
  const match = url.match(/[?&]node-id=([^&]+)/);
  if (!match) {
    return null;
  }

  let nodeId = decodeURIComponent(match[1]);
  if (!nodeId.includes(":") && nodeId.includes("-")) {
    nodeId = nodeId.replace(/-/g, ":");
  }

  return nodeId;
}

function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const TECHNICAL_NAME_PARTS = [
  "rectangle",
  "rect",
  "path",
  "frame",
  "group",
  "union",
  "mask",
  "layer",
  "instance",
  "component",
  "subtract",
];

const CATEGORY_NAMES = [
  "color",
  "colors",
  "colour",
  "palette",
  "typography",
  "fonts",
  "font",
  "text",
  "texts",
  "text-styles",
];

const COLOR_SECTION_NAMES = new Set(["colors", "colour", "palette", "color"]);
const TYPOGRAPHY_SECTION_NAMES = new Set(["typography", "fonts", "font", "text", "texts", "text-styles"]);

const FONT_NAME_RULES = [
  { maxSize: 18, weight: 400, name: "body" },
  { minSize: 19, maxSize: 22, weight: [500, 600, 700], name: "button" },
  { minSize: 23, maxSize: 28, weight: [600, 700], name: "h2" },
  { minSize: 29, weight: 700, name: "h1" },
];

function isTechnicalName(name) {
  const lower = name.trim().toLowerCase();
  return TECHNICAL_NAME_PARTS.some((part) => lower.includes(part));
}

function isCategoryName(name) {
  const lower = name.trim().toLowerCase();
  return CATEGORY_NAMES.includes(lower);
}

function isNumericName(name) {
  return /^\d+$/.test(name.trim());
}

function ensureUniqueName(base, usedNames) {
  let name = base;
  let counter = 2;
  while (usedNames.has(name)) {
    name = `${base}-${counter++}`;
  }
  usedNames.add(name);
  return name;
}

function getMeaningfulSegments(path) {
  const segments = [];
  for (const item of path) {
    const trimmed = (item ?? "").trim();
    if (!trimmed) continue;
    if (isTechnicalName(trimmed)) continue;
    if (isNumericName(trimmed)) continue;
    const slug = slugify(trimmed.replace(/\//g, "-"));
    if (!slug) continue;
    if (isCategoryName(slug)) continue;
    segments.push({ original: trimmed, slug });
  }
  return segments;
}

function buildTokenName(path, usedNames, fallback) {
  const segments = getMeaningfulSegments(path);
  let base = "";

  if (segments.length > 0) {
    const last = segments[segments.length - 1].slug;
    const prev = segments.length > 1 ? segments[segments.length - 2].slug : "";

    if (prev && !last.startsWith(prev)) {
      base = `${prev}-${last}`;
    } else {
      base = last;
    }
  }

  if (!base && fallback) {
    base = slugify(fallback);
  }

  if (!base) {
    return "";
  }

  return ensureUniqueName(base, usedNames);
}

function guessFontName(style, path, usedNames, fallbackPrefix) {
  const weight = style.fontWeight ?? 400;
  const size = style.fontSize ?? 0;

  for (const rule of FONT_NAME_RULES) {
    const matchWeight = Array.isArray(rule.weight)
      ? rule.weight.includes(weight)
      : rule.weight === weight;
    if (!matchWeight) {
      continue;
    }

    const minOk = typeof rule.minSize === "number" ? size >= rule.minSize : true;
    const maxOk = typeof rule.maxSize === "number" ? size <= rule.maxSize : true;

    if (minOk && maxOk) {
      return ensureUniqueName(rule.name, usedNames);
    }
  }

  const segments = getMeaningfulSegments(path);
  if (segments.length > 0) {
    return buildTokenName(path, usedNames, `${fallbackPrefix}-${Math.round(size) || "text"}`);
  }

  const fallback = `${fallbackPrefix}-${Math.round(size) || "text"}`;
  return ensureUniqueName(slugify(fallback), usedNames);
}

function formatNumber(value) {
  if (Number.isInteger(value)) {
    return `${value}`;
  }

  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

// === 4. Конвертація RGB → HEX ===
function rgbToHex(r, g, b) {
  const to255 = (v) => Math.round(v * 255);
  const hex = (v) => v.toString(16).padStart(2, "0");
  return `#${hex(to255(r))}${hex(to255(g))}${hex(to255(b))}`;
}

function formatLineHeight(style) {
  if (!style) return "normal";

  if (typeof style.lineHeightPx === "number") {
    return `${formatNumber(style.lineHeightPx)}px`;
  }

  if (typeof style.lineHeightPercentFontSize === "number" && typeof style.fontSize === "number") {
    const px = (style.lineHeightPercentFontSize / 100) * style.fontSize;
    return `${formatNumber(px)}px`;
  }

  if (typeof style.lineHeightPercent === "number" && typeof style.fontSize === "number") {
    const px = (style.lineHeightPercent / 100) * style.fontSize;
    return `${formatNumber(px)}px`;
  }

  return "normal";
}

function formatColor(fill) {
  if (!fill?.color) {
    return null;
  }

  const to255 = (value) => Math.round((value ?? 0) * 255);
  const alpha =
    typeof fill.opacity === "number"
      ? fill.opacity
      : typeof fill.color.a === "number"
      ? fill.color.a
      : 1;

  if (alpha < 1) {
    const r = to255(fill.color.r);
    const g = to255(fill.color.g);
    const b = to255(fill.color.b);
    return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(3))})`;
  }

  return rgbToHex(fill.color.r, fill.color.g, fill.color.b);
}

function resolveTextStyle(node) {
  if (!node) return null;

  if (node.style?.fontFamily) {
    return node.style;
  }

  if (node.styleOverrideTable && Array.isArray(node.characterStyleOverrides)) {
    for (const overrideId of node.characterStyleOverrides) {
      const style = node.styleOverrideTable[overrideId];
      if (style?.fontFamily && style?.fontSize) {
        return style;
      }
    }
  }

  return null;
}

async function fetchNodeTree(fileId, nodeId) {
  const url = `https://api.figma.com/v1/files/${fileId}/nodes?ids=${encodeURIComponent(
    nodeId
  )}`;
  const res = await fetch(url, { headers });
  const data = await res.json();

  if (!res.ok) {
    const message = data?.err || data?.message || `HTTP ${res.status}`;
    throw new Error(`Не вдалося отримати вузол: ${message}`);
  }

  const node = data?.nodes?.[nodeId]?.document;
  if (!node) {
    throw new Error("Figma повернула порожній вузол. Перевір правильність node-id.");
  }

  return node;
}

async function fetchNodesBatch(fileId, ids) {
  if (!ids.length) {
    return new Map();
  }

  const query = ids.map((id) => encodeURIComponent(id)).join(",");
  const url = `https://api.figma.com/v1/files/${fileId}/nodes?ids=${query}`;
  const res = await fetch(url, { headers });
  const data = await res.json();

  if (!res.ok) {
    const message = data?.err || data?.message || `HTTP ${res.status}`;
    throw new Error(`Не вдалося отримати вузли: ${message}`);
  }

  const map = new Map();
  for (const id of ids) {
    const documentNode = data?.nodes?.[id]?.document;
    if (documentNode) {
      map.set(id, documentNode);
    }
  }

  return map;
}

async function fetchNodeTreeWithReferences(fileId, nodeId) {
  const rootNode = await fetchNodeTree(fileId, nodeId);
  const referenceNodes = new Map();
  const processed = new Set();
  const pending = new Set();

  function enqueue(id) {
    if (!id) return;
    if (processed.has(id)) return;
    pending.add(id);
  }

  function discoverReferences(node) {
    if (!node) return;

    if (node.type === "INSTANCE" && node.componentId) {
      enqueue(node.componentId);
    }

    if (node.type === "COMPONENT" && node.componentSetId) {
      enqueue(node.componentSetId);
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        discoverReferences(child);
      }
    }
  }

  discoverReferences(rootNode);

  while (pending.size > 0) {
    const batch = Array.from(pending).slice(0, 40);
    for (const id of batch) {
      pending.delete(id);
      processed.add(id);
    }

    const fetched = await fetchNodesBatch(fileId, batch);
    for (const [id, node] of fetched.entries()) {
      referenceNodes.set(id, node);
      discoverReferences(node);
    }
  }

  return { rootNode, referenceNodes };
}

function extractSolidPaints(node) {
  const paints = [];

  if (!node) {
    return paints;
  }

  const pushPaint = (paint, source) => {
    if (!paint) return;
    if (paint.type !== "SOLID") return;
    if (paint.visible === false) return;
    if (!paint.color) return;
    paints.push({ paint, source });
  };

  if (Array.isArray(node.fills)) {
    for (const fill of node.fills) {
      pushPaint(fill, "fill");
    }
  }

  if (Array.isArray(node.strokes)) {
    for (const stroke of node.strokes) {
      pushPaint(stroke, "stroke");
    }
  }

  if (Array.isArray(node.backgrounds)) {
    for (const background of node.backgrounds) {
      pushPaint(background, "background");
    }
  }

  if (node.backgroundColor) {
    paints.push({ paint: { type: "SOLID", color: node.backgroundColor }, source: "background" });
  }

  return paints;
}

function collectTokens(node, path, state, context) {
  if (!node) {
    return;
  }

  const referenceNodes = context.referenceNodes ?? null;
  const referenceStack = context.referenceStack ?? new Set();
  const currentPath = node.name ? [...path, node.name] : [...path];
  const lowerName = (node.name ?? "").trim().toLowerCase();
  const inColorSection = context.inColorSection || COLOR_SECTION_NAMES.has(lowerName);
  const inTypographySection =
    context.inTypographySection || TYPOGRAPHY_SECTION_NAMES.has(lowerName);

  if (node.type !== "TEXT") {
    const paints = extractSolidPaints(node);
    for (const { paint, source } of paints) {
      const colorValue = formatColor(paint);
      if (!colorValue) {
        continue;
      }

      const signature = `${colorValue}|${source}|${currentPath.join("/")}`;
      if (state.colorSignatures.has(signature)) {
        continue;
      }

      const pathForName = source === "fill" ? currentPath : [...currentPath, source];
      const segments = getMeaningfulSegments(pathForName);
      const fallback = segments.length === 0 ? `color-${++state.colorFallbackCount}` : "";
      const tokenName = buildTokenName(pathForName, state.usedColorNames, fallback);

      if (tokenName) {
        state.colorSignatures.add(signature);
        state.colors.push({ name: tokenName, value: colorValue });
      }
    }
  }

  if (node.type === "TEXT") {
    const textStyle = resolveTextStyle(node);
    if (textStyle?.fontFamily && textStyle.fontSize) {
      const lineHeight = formatLineHeight(textStyle);
      const signature = [
        textStyle.fontFamily,
        textStyle.fontSize,
        textStyle.fontWeight ?? 400,
        lineHeight,
      ].join("|");

      if (!state.fontBySignature.has(signature)) {
        const fallbackPrefix = inTypographySection ? "font" : "text";
        const fontName = guessFontName(textStyle, currentPath, state.usedFontNames, fallbackPrefix);

        if (fontName) {
          state.fontBySignature.set(signature, fontName);
          state.fonts.push({
            name: fontName,
            family: textStyle.fontFamily,
            size: textStyle.fontSize,
            weight: textStyle.fontWeight ?? 400,
            lineHeight,
          });
        }
      }
    }
  }

  let hasChildren = false;
  if (Array.isArray(node.children) && node.children.length > 0) {
    hasChildren = true;
    for (const child of node.children) {
      collectTokens(child, currentPath, state, {
        inColorSection,
        inTypographySection,
        referenceNodes,
        referenceStack,
      });
    }
  }

  if (!hasChildren && node.type === "INSTANCE" && node.componentId && referenceNodes) {
    if (!referenceStack.has(node.componentId)) {
      const referenced = referenceNodes.get(node.componentId);
      if (referenced) {
        referenceStack.add(node.componentId);
        collectTokens(referenced, currentPath, state, {
          inColorSection,
          inTypographySection,
          referenceNodes,
          referenceStack,
        });
        referenceStack.delete(node.componentId);
      }
    }
  }
}

// === 5. Генерація SCSS ===
async function generateScss(projectName, fileId, nodeId) {
  const { rootNode, referenceNodes } = await fetchNodeTreeWithReferences(fileId, nodeId);

  const state = {
    colors: [],
    fonts: [],
    usedColorNames: new Set(),
    usedFontNames: new Set(),
    colorFallbackCount: 0,
    colorSignatures: new Set(),
    fontBySignature: new Map(),
  };

  collectTokens(rootNode, [], state, {
    inColorSection: false,
    inTypographySection: false,
    referenceNodes,
    referenceStack: new Set(),
  });

  if (state.colors.length === 0 && state.fonts.length === 0) {
    console.warn(
      "⚠️ У вибраному фреймі не знайдено кольорів або текстових стилів. Переконайся, що node-id вказує на секцію зі стилями."
    );
    return;
  }

  const colors = state.colors.sort((a, b) => a.name.localeCompare(b.name));
  const fonts = state.fonts.sort((a, b) => a.name.localeCompare(b.name));

  const scssLines = [":root {", "  /* Color tokens */"];

  for (const color of colors) {
    scssLines.push(`  --${projectName}-${color.name}: ${color.value};`);
  }

  scssLines.push("", "  /* Font tokens */");

  for (const font of fonts) {
    const family = font.family.replace(/'/g, "\\'");
    const size = formatNumber(font.size);
    scssLines.push(`  --${projectName}-font-${font.name}-family: '${family}';`);
    scssLines.push(`  --${projectName}-font-${font.name}-size: ${size}px;`);
    scssLines.push(`  --${projectName}-font-${font.name}-weight: ${font.weight};`);
    scssLines.push(`  --${projectName}-font-${font.name}-lineheight: ${font.lineHeight};`);
    scssLines.push("");
  }

  if (scssLines[scssLines.length - 1] === "") {
    scssLines.pop();
  }

  scssLines.push("}", "");

  if (!fs.existsSync("dist")) {
    fs.mkdirSync("dist", { recursive: true });
  }

  const outputPath = "dist/roots.scss";
  fs.writeFileSync(outputPath, scssLines.join("\n"), "utf8");

  console.log(`✅ SCSS файл створено: ${outputPath}`);
  console.log(`🎨 Кольорів: ${colors.length}, шрифтів: ${fonts.length}`);
}

// === 6. Основна логіка ===
async function main() {
  const { projectName, figmaUrl } = await inquirer.prompt([
    { name: "projectName", message: "Введи назву проекту:" },
    { name: "figmaUrl", message: "Встав посилання на Figma файл:" },
  ]);

  const fileId = extractFileId(figmaUrl);
  if (!fileId) {
    console.error("❌ Неможливо витягти file_id із посилання. Перевір URL.");
    return;
  }

  const nodeId = extractNodeId(figmaUrl);
  if (!nodeId) {
    console.error("❌ Неможливо витягти node_id із посилання. Перевір, що URL містить параметр node-id.");
    return;
  }

  console.log(`🔍 Витягнуто file_id: ${fileId}`);
  console.log(`🔍 Витягнуто node_id: ${nodeId}`);
  console.log("⏳ Завантажую дані вузла з Figma...");

  const projectSlug = slugify(projectName || "");
  if (!projectSlug) {
    console.error("❌ Неможливо сформувати slug проекту. Використай латинські букви та цифри у назві.");
    return;
  }

  try {
    await generateScss(projectSlug, fileId, nodeId);
  } catch (error) {
    console.error(`❌ Помилка під час генерації SCSS: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
