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
const MAX_NODE_IDS_PER_REQUEST = 100;

// Підтримує і старі (/file/) і нові (/design/) посилання Figma
function extractFileId(url) {
  const match = url.match(/(?:file|design)\/([a-zA-Z0-9]+)\//);
  return match ? match[1] : null;
}

function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// === 2. Отримати всі стилі ===
async function fetchStyles(fileId) {
  const res = await fetch(`https://api.figma.com/v1/files/${fileId}/styles`, { headers });
  const data = await res.json();

  if (!res.ok) {
    const message = data?.err || data?.message || `HTTP ${res.status}`;
    throw new Error(`Не вдалося отримати стилі: ${message}`);
  }

  return Array.isArray(data?.meta?.styles) ? data.meta.styles : [];
}

// === 3. Отримати деталі вузлів (кольори, шрифти) ===
async function fetchNodes(fileId, ids) {
  if (ids.length === 0) {
    return {};
  }

  const result = {};
  const chunks = chunkArray(ids, MAX_NODE_IDS_PER_REQUEST);

  for (const chunk of chunks) {
    const url = `https://api.figma.com/v1/files/${fileId}/nodes?ids=${chunk
      .map(encodeURIComponent)
      .join(",")}`;
    const res = await fetch(url, { headers });
    const data = await res.json();

    if (!res.ok) {
      const message = data?.err || data?.message || `HTTP ${res.status}`;
      throw new Error(`Не вдалося отримати вузли стилів: ${message}`);
    }

    Object.assign(result, data.nodes ?? {});
  }

  return result;
}

// === 4. Конвертація RGB → HEX ===
function rgbToHex(r, g, b) {
  const to255 = (v) => Math.round(v * 255);
  const hex = (v) => v.toString(16).padStart(2, "0");
  return `#${hex(to255(r))}${hex(to255(g))}${hex(to255(b))}`;
}

function findSolidPaint(node) {
  if (!node) return null;

  if (Array.isArray(node.fills)) {
    for (const fill of node.fills) {
      if (fill?.type === "SOLID" && fill?.visible !== false && fill?.color) {
        return fill;
      }
    }
  }

  if (node.backgroundColor) {
    return { type: "SOLID", color: node.backgroundColor };
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const paint = findSolidPaint(child);
      if (paint) {
        return paint;
      }
    }
  }

  return null;
}

function extractTextStyle(node) {
  if (!node) return null;

  if (node.style?.fontFamily) {
    return node.style;
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const style = extractTextStyle(child);
      if (style) {
        return style;
      }
    }
  }

  return null;
}

function formatLineHeight(style) {
  if (!style) return "normal";

  if (typeof style.lineHeightPx === "number" && typeof style.fontSize === "number" && style.fontSize !== 0) {
    return `${Math.round((style.lineHeightPx / style.fontSize) * 100)}%`;
  }

  if (typeof style.lineHeightPercentFontSize === "number") {
    return `${Math.round(style.lineHeightPercentFontSize)}%`;
  }

  if (typeof style.lineHeightPercent === "number") {
    return `${Math.round(style.lineHeightPercent)}%`;
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

// === 5. Генерація SCSS ===
async function generateScss(projectName, fileId) {
  const styles = await fetchStyles(fileId);

  if (!Array.isArray(styles) || styles.length === 0) {
    console.warn(
      "⚠️ У файлі не знайдено стилів. Створи Color або Text styles у Figma (Assets → Local styles) та повтори спробу."
    );
    return;
  }

  const colorStyles = styles.filter((s) => s.style_type === "FILL");
  const textStyles = styles.filter((s) => s.style_type === "TEXT");

  if (colorStyles.length === 0 && textStyles.length === 0) {
    console.warn(
      "⚠️ У файлі немає стилів типу FILL або TEXT. Створи Color або Text styles у Figma (Assets → Local styles) та повтори спробу."
    );
    return;
  }

  const allIds = [...colorStyles, ...textStyles].map((s) => s.node_id);
  const nodes = await fetchNodes(fileId, allIds);

  const scssLines = [":root {", "  /* Color styles */"];
  let exportedColors = 0;

  for (const style of colorStyles) {
    const node = nodes?.[style.node_id]?.document;
    const fill = findSolidPaint(node);
    if (!fill?.color) continue;

    const name = slugify(style.name.replace(/\//g, "-"));
    if (!name) continue;

    const formattedColor = formatColor(fill);
    if (!formattedColor) continue;

    scssLines.push(`  --${projectName}-${name}: ${formattedColor};`);
    exportedColors += 1;
  }

  scssLines.push("", "  /* Font styles */");
  let exportedFonts = 0;

  for (const style of textStyles) {
    const node = nodes?.[style.node_id]?.document;
    const textStyle = extractTextStyle(node);
    if (!textStyle?.fontSize || !textStyle.fontFamily) continue;

    const name = slugify(style.name.replace(/\//g, "-"));
    if (!name) continue;
    const fontFamily = textStyle.fontFamily.replace(/'/g, "\\'");
    const fontSize = `${textStyle.fontSize}px`;
    const fontWeight = textStyle.fontWeight ?? 400;
    const lineHeight = formatLineHeight(textStyle);

    scssLines.push(`  --${projectName}-font-${name}-family: '${fontFamily}';`);
    scssLines.push(`  --${projectName}-font-${name}-size: ${fontSize};`);
    scssLines.push(`  --${projectName}-font-${name}-weight: ${fontWeight};`);
    scssLines.push(`  --${projectName}-font-${name}-lineheight: ${lineHeight};`, "");
    exportedFonts += 1;
  }

  scssLines.push("}", "");

  if (exportedColors === 0 && exportedFonts === 0) {
    console.warn(
      "⚠️ Стилі знайдено, але жоден із них не містить підтримуваних даних для кольорів чи тексту. Перевір локальні стилі у Figma."
    );
    return;
  }

  if (!fs.existsSync("dist")) {
    fs.mkdirSync("dist", { recursive: true });
  }

  const outputPath = `dist/roots--${projectName}.scss`;
  fs.writeFileSync(outputPath, scssLines.join("\n"), "utf8");
  console.log(
    `✅ SCSS файл створено: ${outputPath}. Знайдено ${exportedColors} кольорів та ${exportedFonts} текстових стилів.`
  );
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

  console.log(`🔍 Витягнуто file_id: ${fileId}`);
  console.log("⏳ Завантажую стилі з Figma...");

  const projectSlug = slugify(projectName || "");
  if (!projectSlug) {
    console.error("❌ Неможливо сформувати slug проекту. Використай латинські букви та цифри у назві.");
    return;
  }

  try {
    await generateScss(projectSlug, fileId);
  } catch (error) {
    console.error(`❌ Помилка під час генерації SCSS: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
