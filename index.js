// figma-scss-bot/index.js
import fetch from "node-fetch";
import fs from "fs";
import inquirer from "inquirer";
import dotenv from "dotenv";

dotenv.config();

const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
const headers = { "X-Figma-Token": FIGMA_TOKEN };

// Підтримує і старі (/file/) і нові (/design/) посилання Figma
function extractFileId(url) {
  const match = url.match(/(?:file|design)\/([a-zA-Z0-9]+)\//);
  return match ? match[1] : null;
}

// === 2. Отримати всі стилі ===
async function fetchStyles(fileId) {
  const res = await fetch(`https://api.figma.com/v1/files/${fileId}/styles`, { headers });
  const data = await res.json();
  return data.meta.styles;
}

// === 3. Отримати деталі вузлів (кольори, шрифти) ===
async function fetchNodes(fileId, ids) {
  const url = `https://api.figma.com/v1/files/${fileId}/nodes?ids=${ids.join(",")}`;
  const res = await fetch(url, { headers });
  const data = await res.json();
  return data.nodes;
}

// === 4. Конвертація RGB → HEX ===
function rgbToHex(r, g, b) {
  const to255 = (v) => Math.round(v * 255);
  const hex = (v) => v.toString(16).padStart(2, "0");
  return `#${hex(to255(r))}${hex(to255(g))}${hex(to255(b))}`;
}

// === 5. Генерація SCSS ===
async function generateScss(projectName, fileId) {
  const styles = await fetchStyles(fileId);

  const colorStyles = styles.filter((s) => s.style_type === "FILL");
  const textStyles = styles.filter((s) => s.style_type === "TEXT");

  const allIds = [...colorStyles, ...textStyles].map((s) => s.node_id);
  const nodes = await fetchNodes(fileId, allIds);

  let scss = `:root {\n`;

  // --- Кольори ---
  scss += `  /* Color styles */\n`;
  for (const s of colorStyles) {
    const node = nodes[s.node_id]?.document;
    if (!node?.fills?.length) continue;
    const fill = node.fills[0];
    if (fill.type !== "SOLID") continue;

    const c = fill.color;
    const hex = rgbToHex(c.r, c.g, c.b);
    const name = s.name.toLowerCase().replace(/\s+/g, "-").replace(/\//g, "-");

    scss += `  --${projectName}-${name}: ${hex};\n`;
  }

  scss += `\n  /* Font styles */\n`;

  // --- Типографіка ---
  for (const s of textStyles) {
    const node = nodes[s.node_id]?.document;
    if (!node?.style) continue;

    const { fontFamily, fontWeight, fontSize, lineHeightPx } = node.style;
    const lineHeight = lineHeightPx ? `${Math.round((lineHeightPx / fontSize) * 100)}%` : "normal";
    const name = s.name.toLowerCase().replace(/\s+/g, "-").replace(/\//g, "-");

    scss += `  --${projectName}-font-${name}-family: '${fontFamily}';\n`;
    scss += `  --${projectName}-font-${name}-size: ${fontSize}px;\n`;
    scss += `  --${projectName}-font-${name}-weight: ${fontWeight};\n`;
    scss += `  --${projectName}-font-${name}-lineheight: ${lineHeight};\n\n`;
  }

  scss += `}\n`;

  const outputPath = `dist/roots--${projectName}.scss`;
  fs.writeFileSync(outputPath, scss, "utf8");
  console.log(`✅ SCSS файл створено: ${outputPath}`);
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

  await generateScss(projectName.toLowerCase(), fileId);
}

main();
