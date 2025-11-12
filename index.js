// index.js — frame-based extractor that updates only existing SCSS vars
// Works WITHOUT Local Styles: reads inline fills/text/effects from a specific frame (node-id)
// Then updates ONLY existing variables in your SCSS, preserving structure/order/comments.
// Text sizes are formatted as #{remD(...px)} for Desktop-like names and #{rem(...px)} for Mobile-like.
// Shadows stay as CSS box-shadow parts (joined with ", ").

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import inquirer from "inquirer";
import dotenv from "dotenv";
import chalk from "chalk";

dotenv.config();

const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
if (!FIGMA_TOKEN) {
  console.error("❌ FIGMA_TOKEN не знайдено у .env");
  process.exit(1);
}
const headers = { "X-Figma-Token": FIGMA_TOKEN };

// ===== Helpers =====
function extractFileAndNode(url) {
  const fileMatch = url.match(/(?:file|design)\/([a-zA-Z0-9]+)\//);
  const nodeMatch = url.match(/node-id=([0-9:-]+)/);
  return {
    fileId: fileMatch ? fileMatch[1] : null,
    nodeId: nodeMatch ? decodeURIComponent(nodeMatch[1]).replace(/-/g, ":") : null,
  };
}

function to255(x) { return Math.round((x ?? 0) * 255); }
function hex2(v) { return v.toString(16).padStart(2, "0"); }
function rgbaOrHex(color, alphaOverride) {
  if (!color) return null;
  const a = typeof alphaOverride === "number" ? alphaOverride : (typeof color.a === "number" ? color.a : 1);
  const r = to255(color.r); const g = to255(color.g); const b = to255(color.b);
  if (a < 1) return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}
const px = (n) => `${Math.round(n || 0)}px`;
const wrapRem = (pxVal, isDesktop) => isDesktop ? `#{remD(${pxVal})}` : `#{rem(${pxVal})}`;

// ===== Figma API =====
async function fetchFrame(fileId, nodeId) {
  const url = `https://api.figma.com/v1/files/${fileId}/nodes?ids=${encodeURIComponent(nodeId)}`;
  const res = await fetch(url, { headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.err || data?.message || `HTTP ${res.status}`);
  const doc = data?.nodes?.[nodeId]?.document;
  if (!doc) throw new Error("Не знайдено документ фрейму.");
  return doc;
}

// ===== Collect inline tokens from frame =====
const TECH_NAMES = new Set(["rectangle","rect","path","frame","group","union","mask","layer","instance","component","subtract","arrow","icon","background","bg","vector"]);
function isTechName(name="") { return TECH_NAMES.has(name.toLowerCase()); }

function traverse(node, acc, ancestryNames=[]) {
  if (!node || node.visible === false) return;
  const currentNames = node.name ? [...ancestryNames, node.name] : ancestryNames;

  // Colors
  if (node.backgroundColor) {
    const c = rgbaOrHex(node.backgroundColor);
    if (c) acc.colors.add(c);
  }
  if (Array.isArray(node.fills)) {
    for (const f of node.fills) {
      if (!f || f.visible === false) continue;
      if (f.type === "SOLID" && f.color) {
        const val = rgbaOrHex(f.color, typeof f.opacity === "number" ? f.opacity : f.color.a);
        if (val) acc.colors.add(val);
      }
    }
  }
  if (Array.isArray(node.strokes)) {
    for (const s of node.strokes) {
      if (!s || s.visible === false) continue;
      if (s.type === "SOLID" && s.color) {
        const val = rgbaOrHex(s.color, typeof s.opacity === "number" ? s.opacity : s.color.a);
        if (val) acc.colors.add(val);
      }
    }
  }

  // Text sizes
  if (node.type === "TEXT" && node.style?.fontSize) {
    const sizePx = px(node.style.fontSize);
    const isDesktopHint = currentNames.join("/").toLowerCase().includes("desktop") || node.style.fontSize >= 20;
    acc.textSizes.add(wrapRem(sizePx, isDesktopHint));
  }

  // Shadows
  if (Array.isArray(node.effects)) {
    const parts = [];
    for (const e of node.effects) {
      if (!e || e.visible === false) continue;
      if (e.type !== "DROP_SHADOW" && e.type !== "INNER_SHADOW") continue;
      const offX = px(e.offset?.x ?? 0);
      const offY = px(e.offset?.y ?? 0);
      const blur = px(e.radius ?? 0);
      const spread = typeof e.spread === "number" ? px(e.spread) : null; // may be undefined
      const col = rgbaOrHex(e.color, e.color?.a);
      parts.push([offX, offY, blur, spread, col].filter(Boolean).join(" "));
    }
    if (parts.length) acc.shadows.add(parts.join(", "));
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) traverse(child, acc, currentNames);
  }
}

// ===== SCSS handling =====
function readScss(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`SCSS не знайдено: ${filePath}`);
  return fs.readFileSync(filePath, "utf8");
}
function backupScss(filePath) {
  const bak = `${filePath}.bak`;
  fs.writeFileSync(bak, fs.readFileSync(filePath));
  return bak;
}

// Parse variables preserving order and original spacing
function parseScssVars(content) {
  // Matches: --var-name: value;
  const re = /(\-\-[A-Za-z0-9_\-]+)\s*:\s*([^;]+);/g;
  const vars = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    vars.push({ varName: m[1], value: m[2].trim(), start: m.index, end: re.lastIndex });
  }
  return vars;
}

// Heuristics to classify var type by name/value
function classifyVar(vName, vValue) {
  const name = vName.toLowerCase();
  const val = (vValue || "").trim().toLowerCase();
  const looksHex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(val);
  const looksRgba = /^rgba\(/.test(val) || /^rgb\(/.test(val);
  const looksRemFn = /#\{remd\(/.test(val) || /#\{rem\(/.test(val);
  const looksPxOnly = /px\)/.test(val) || /px$/.test(val);
  const looksShadow = /(rgba\(|rgb\().*\)/.test(val) && val.includes("px");

  if (looksRemFn || /desktop---|mobile---|headline|caption|body|button/.test(name)) return "text";
  if (looksShadow || name.startsWith("--shadow-") || name.includes("shadow")) return "shadow";
  if (looksHex || looksRgba || name.startsWith("--greyscale--") || name.startsWith("--primary--") || name.startsWith("--secondary--") || name.startsWith("--support---") || name.startsWith("--special---")) return "color";

  // Fallback by section hints in name
  if (/color|greyscale|primary|secondary|support/.test(name)) return "color";
  if (/shadow|effect/.test(name)) return "shadow";
  if (/text|font|headline|caption|body|button|desktop|mobile/.test(name)) return "text";

  // As a last resort, guess by value
  if (looksPxOnly) return "text";
  return null;
}

function replaceScss(content, updatesMap) {
  if (!updatesMap.size) return content;
  return content.replace(/(\-\-[A-Za-z0-9_\-]+)\s*:\s*([^;]+);/g, (m, name, oldVal) => {
    if (!updatesMap.has(name)) return m;
    const newVal = updatesMap.get(name);
    // preserve spacing around ':'
    const before = m.slice(0, m.indexOf(":"));
    return `${before}: ${newVal};`;
  });
}

function printDiff(updates, scssContent) {
  console.log("\n" + chalk.cyan("🧾 Зміни:"));
  if (!updates.size) {
    console.log(chalk.gray("  Нічого не змінено"));
    return;
  }
  const byFind = (vn) => (scssContent.match(new RegExp(`${vn.replace(/[-]/g, "[-]")}\s*:\\s*([^;]+);`))||[])[1];
  let changed = 0;
  for (const [vn, newV] of updates.entries()) {
    const oldV = byFind(vn);
    if (typeof oldV === "string" && oldV.trim() !== newV.trim()) {
      changed++;
      console.log(chalk.gray(`  ${vn} `) + chalk.yellow(oldV.trim()) + chalk.green(` → ${newV.trim()}`));
    }
  }
  if (!changed) console.log(chalk.gray("  Нічого не змінено (значення ті самі)"));
}

// ===== Main flow =====
async function main() {
  const { scssPath, figmaUrl } = await inquirer.prompt([
    { name: "scssPath", message: "Вкажи шлях до SCSS файлу:", default: "dist/roots.scss" },
    { name: "figmaUrl", message: "Встав посилання на Figma фрейм:" },
  ]);

  const { fileId, nodeId } = extractFileAndNode(figmaUrl);
  if (!fileId || !nodeId) {
    console.error("❌ Неможливо отримати file_id або node_id з URL");
    process.exit(1);
  }

  console.log(chalk.cyan(`\n🔍 file_id: ${fileId}`));
  console.log(chalk.cyan(`🔍 node_id: ${nodeId}`));
  console.log(chalk.gray("⏳ Отримую дані фрейму з Figma..."));

  const frame = await fetchFrame(fileId, nodeId);

  const acc = { colors: new Set(), textSizes: new Set(), shadows: new Set() };
  traverse(frame, acc);

  const colorList = Array.from(acc.colors);
  const textList = Array.from(acc.textSizes);
  const shadowList = Array.from(acc.shadows);

  console.log(chalk.green(`🎨 Кольори: ${colorList.length}`));
  console.log(chalk.green(`🅰️ Текстові розміри: ${textList.length}`));
  console.log(chalk.green(`🌫️ Тіні: ${shadowList.length}`));

  const scss = readScss(scssPath);
  const vars = parseScssVars(scss);

  // Build updates by type in order of appearance
  const updates = new Map();
  let iColor = 0, iText = 0, iShadow = 0;

  // Try to infer type from both name and current value
  for (const v of vars) {
    const type = classifyVar(v.varName, v.value);
    if (type === "color" && colorList.length) {
      const val = colorList[iColor % colorList.length];
      if (val) { updates.set(v.varName, val); iColor++; }
    } else if (type === "text" && textList.length) {
      const val = textList[iText % textList.length];
      if (val) { updates.set(v.varName, val); iText++; }
    } else if (type === "shadow" && shadowList.length) {
      const val = shadowList[iShadow % shadowList.length];
      if (val) { updates.set(v.varName, val); iShadow++; }
    }
  }

  // Show diff & confirm
  const backupPath = backupScss(scssPath);
  printDiff(updates, scss);
  const { confirm } = await inquirer.prompt([{ type: "confirm", name: "confirm", message: "Зберегти зміни у SCSS?", default: true }]);
  if (!confirm) {
    console.log(chalk.yellow("❌ Збереження скасовано користувачем."));
    return;
  }

  const newScss = replaceScss(scss, updates);
  fs.writeFileSync(scssPath, newScss, "utf8");

  console.log(chalk.gray(`\n💾 Резервна копія: ${backupPath}`));
  console.log(chalk.green(`✅ Файл ${scssPath} оновлено успішно!`));
}

main().catch((e) => {
  console.error(chalk.red(`❌ Помилка: ${e.message}`));
  process.exit(1);
});

