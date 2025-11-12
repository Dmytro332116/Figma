// index.js v5.0 — Figma → SCSS + Icons + Fonts + ZIP
// --------------------------------------------------
// ✅ Меню дій (SCSS / Fonts / Icons / All)
// ✅ Оновлює тільки існуючі змінні в SCSS (кольори / текст / тіні)
// ✅ Експорт іконок (SVG → PNG fallback) з прогресом
// ✅ Завантаження шрифтів через Google Fonts каталóg (woff2)
// ✅ Розкладання шрифтів по папках Regular / Bold / Black / …
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

const to255 = (x) => Math.round((x ?? 0) * 255);
const hex2 = (v) => v.toString(16).padStart(2, "0");
const rgbaOrHex = (color, alphaOverride) => {
  if (!color) return null;
  const a =
    typeof alphaOverride === "number"
      ? alphaOverride
      : typeof color.a === "number"
      ? color.a
      : 1;
  const r = to255(color.r);
  const g = to255(color.g);
  const b = to255(color.b);
  return a < 1
    ? `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`
    : `#${hex2(r)}${hex2(g)}${hex2(b)}`;
};
const px = (n) => `${Math.round(n || 0)}px`;
const wrapRem = (pxVal, isDesktop) =>
  isDesktop ? `#{remD(${pxVal})}` : `#{rem(${pxVal})}`;

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
  const url = `https://api.figma.com/v1/files/${fileId}/nodes?ids=${encodeURIComponent(
    nodeId
  )}`;
  const data = await figmaGET(url);
  const doc = data?.nodes?.[nodeId]?.document;
  if (!doc) throw new Error("Не знайдено документ фрейму.");
  return doc;
}

// ---------- FRAME TRAVERSE ----------
const TECH_NAMES = new Set([
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
  "arrow",
  "icon",
  "background",
  "bg",
  "vector",
]);

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

// обхід дерева фрейму, збираємо все одразу
function traverseFrame(node, acc, ancestryNames = []) {
  if (!node || node.visible === false) return;
  const currentNames = node.name ? [...ancestryNames, node.name] : ancestryNames;
  const pathHint = currentNames.join("/").toLowerCase();

  // КОЛЬОРИ (fills + strokes)
  if (Array.isArray(node.fills)) {
    for (const f of node.fills) {
      if (!f || f.visible === false) continue;
      if (f.type === "SOLID" && f.color) {
        const val = rgbaOrHex(
          f.color,
          typeof f.opacity === "number" ? f.opacity : f.color.a
        );
        if (val) acc.colors.add(val);
      }
    }
  }
  if (Array.isArray(node.strokes)) {
    for (const s of node.strokes) {
      if (!s || s.visible === false) continue;
      if (s.type === "SOLID" && s.color) {
        const val = rgbaOrHex(
          s.color,
          typeof s.opacity === "number" ? s.opacity : s.color.a
        );
        if (val) acc.colors.add(val);
      }
    }
  }

  // ТЕКСТ (розміри + шрифти)
  if (node.type === "TEXT" && node.style) {
    const { fontSize, fontFamily, fontWeight, italic } = node.style;
    if (fontSize) {
      const sizePx = px(fontSize);
      const isDesktop = pathHint.includes("desktop") || fontSize >= 20;
      acc.textSizes.add(wrapRem(sizePx, isDesktop));
    }
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
      const col = rgbaOrHex(e.color, e.color?.a);
      parts.push([offX, offY, blur, col].join(" "));
    }
    if (parts.length) acc.shadows.add(parts.join(", "));
  }

  // ІКОНКИ (кандидати)
  const isIconCandidate =
    (node.name && ICON_NAME_RE.test(node.name)) || ICON_TYPES.has(node.type);
  if (isIconCandidate) {
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

function classifyVar(name, value) {
  const n = name.toLowerCase();
  const v = (value || "").toLowerCase();
  const looksHex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(v);
  const looksRgba = /^rgba?\(/.test(v);
  const looksRemFn = /#\{remd\(/.test(v) || /#\{rem\(/.test(v);
  const looksShadow =
    /(rgba?\(.+\)).*\d+px/.test(v) || n.includes("shadow") || n.startsWith("--shadow-");
  if (looksRemFn || /desktop---|mobile---|headline|caption|body|button/.test(n))
    return "text";
  if (looksShadow) return "shadow";
  if (
    looksHex ||
    looksRgba ||
    /color|greyscale|primary|secondary|support|special/.test(n)
  )
    return "color";
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

// ---------- GOOGLE FONTS CATALOG ----------
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "text/css,*/*;q=0.1",
};

async function fetchGoogleCatalog() {
  const url = "https://fonts.google.com/metadata/fonts";
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`Google Fonts metadata HTTP ${res.status}`);
  let text = await res.text();
  // перші символи: )]}'
  text = text.replace(/^\)\]\}'/, "");
  const json = JSON.parse(text);
  return json.familyMetadataList || json.fonts || [];
}

function normalizeFamily(name) {
  return (name || "")
    .toLowerCase()
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findInCatalog(figmaName, catalog) {
  if (!figmaName) return null;
  const n = normalizeFamily(figmaName);

  // 1) точне співпадіння
  let found = catalog.find(
    (f) => normalizeFamily(f.family) === n || normalizeFamily(f.name) === n
  );
  if (found) return found;

  // 2) без пробілів
  const noSpace = n.replace(/\s+/g, "");
  found = catalog.find(
    (f) =>
      normalizeFamily(f.family).replace(/\s+/g, "") === noSpace ||
      normalizeFamily(f.name || "").replace(/\s+/g, "") === noSpace
  );
  if (found) return found;

  // 3) часткове
  found = catalog.find((f) =>
    normalizeFamily(f.family).includes(n)
  );
  if (found) return found;

  return null;
}

function parseVariantKey(key) {
  const k = (key || "").toLowerCase();
  let italic = k.includes("italic") || /i$/.test(k);
  let weight = 400;

  const num = k.match(/\d+/);
  if (num) {
    weight = parseInt(num[0], 10);
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

// завантажує всі woff2 файли для сімейства з каталогу
async function downloadFamilyFromCatalog(catalogEntry, outFontsDir) {
  const family = catalogEntry.family;
  const files = catalogEntry.files || catalogEntry.variants || {};
  const familySlug = family.replace(/\s+/g, "_");
  let count = 0;

  for (const [variantKey, url] of Object.entries(files)) {
    // в metadata/fonts файли можуть бути різних форматів — беремо тільки woff2
    if (!url || !/\.woff2(\?|$)/.test(url)) continue;
    const { weight, italic } = parseVariantKey(variantKey);
    const wName = weightName(weight);
    const folderName = italic ? `${wName}Italic` : wName;
    const folderPath = path.join(outFontsDir, familySlug, folderName);
    ensureDir(folderPath);

    const fileName = `${familySlug}-${folderName}.woff2`;
    const filePath = path.join(folderPath, fileName);

    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(filePath, buf);
      count++;
    } catch {
      // пропускаємо
    }
  }
  return count;
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
  const acc = {
    colors: new Set(),
    textSizes: new Set(),
    shadows: new Set(),
    fonts: new Set(),
    iconNodes: [],
  };
  traverseFrame(frame, acc);

  const colors = [...acc.colors];
  const texts = [...acc.textSizes];
  const shadows = [...acc.shadows];

  console.log(chalk.green(`🎨 Кольори: ${colors.length}`));
  console.log(chalk.green(`🅰️ Тексти: ${texts.length}`));
  console.log(chalk.green(`🌫️ Тіні: ${shadows.length}`));

  const scssContent = readScss(scssPath);
  const vars = parseScssVars(scssContent);
  const updates = new Map();

  let ci = 0,
    ti = 0,
    si = 0;
  for (const v of vars) {
    const type = classifyVar(v.varName, v.value);
    if (type === "color" && colors.length)
      updates.set(v.varName, colors[ci++ % colors.length]);
    if (type === "text" && texts.length)
      updates.set(v.varName, texts[ti++ % texts.length]);
    if (type === "shadow" && shadows.length)
      updates.set(v.varName, shadows[si++ % shadows.length]);
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

// ---------- ACTION: FONTS ----------
async function actionFonts(fileId, nodeId) {
  console.log(chalk.cyan("\n🔧 Завантаження шрифтів..."));
  const frame = await fetchFrame(fileId, nodeId);

  // 🟢 FIX: повна структура accumulator
  const accFonts = {
    colors: new Set(),
    textSizes: new Set(),
    shadows: new Set(),
    fonts: new Set(),
    iconNodes: [],
  };

  traverseFrame(frame, accFonts);

  const fontKeys = [...accFonts.fonts];
  const familiesMap = new Map();
  for (const key of fontKeys) {
    const [family, weightStr] = key.split("::");
    const w = Number(weightStr) || 400;
    const famNorm = family.trim();
    if (!familiesMap.has(famNorm)) familiesMap.set(famNorm, new Set());
    familiesMap.get(famNorm).add(w);
  }

  const families = [...familiesMap.keys()];
  if (!families.length) {
    console.log(chalk.gray("⚠️ У фреймі не знайдено текстових шарів"));
    return { ok: 0, manual: 0 };
  }

  console.log(chalk.green(`🖋️ Шрифти: ${families.join(", ")}`));

  const catalog = await fetchGoogleCatalog();
  const outFonts = path.join("dist", "assets", "fonts");
  ensureDir(outFonts);

  let downloadedFamilies = 0;
  const manualFamilies = [];
  let processed = 0;
  const total = families.length;

  for (const fam of families) {
    processed++;
    const percent = Math.round((processed / total) * 100);
    process.stdout.write(
      `\r${chalk.cyan("⏳ Шрифти")} ${processed}/${total} (${percent}%)   `
    );

    const entry = findInCatalog(fam, catalog);
    if (!entry) {
      console.log(`\n${chalk.yellow(`⚠️ ${fam}: не знайдено в Google Fonts`)}`);
      manualFamilies.push(fam);
      continue;
    }
    try {
      const count = await downloadFamilyFromCatalog(entry, outFonts);
      if (count > 0) {
        downloadedFamilies++;
        console.log(
          `\n${chalk.green(`📚 ${entry.family}: завантажено ${count} файлів`)}`
        );
      } else {
        console.log(
          `\n${chalk.yellow(
            `⚠️ ${entry.family}: немає доступних woff2 файлів`
          )}`
        );
        manualFamilies.push(fam);
      }
    } catch (e) {
      console.log(
        `\n${chalk.red(`⚠️ ${fam}: помилка завантаження (${e.message})`)}`
      );
      manualFamilies.push(fam);
    }
    await sleep(150);
  }

  process.stdout.write("\n");

  if (manualFamilies.length) {
    const manualDir = path.join(outFonts, "manual");
    ensureDir(manualDir);
    fs.writeFileSync(
      path.join(manualDir, "fonts.txt"),
      `Fonts to install manually:\n\n${manualFamilies
        .map((f) => `- ${f}`)
        .join("\n")}\n`,
      "utf8"
    );
  }

  console.log(
    chalk.green(
      `✅ Завантажено: ${downloadedFamilies}, локальних/ручних: ${manualFamilies.length}`
    )
  );
  return { ok: downloadedFamilies, manual: manualFamilies.length };
}

// ---------- ACTION: ICONS ----------
async function actionIcons(fileId, nodeId) {
  console.log(chalk.cyan("\n🔧 Експорт іконок..."));
  const frame = await fetchFrame(fileId, nodeId);
  const acc = {
    colors: new Set(),
    textSizes: new Set(),
    shadows: new Set(),
    fonts: new Set(),
    iconNodes: [],
  };
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
    texts: 0,
    shadows: 0,
    iconsOk: 0,
    iconsTotal: 0,
    fontsOk: 0,
    fontsManual: 0,
  };

  // SCSS
  if (action === "scss" || action === "all") {
    const { frame, acc } = await actionUpdateScss(scssPath, fileId, nodeId);
    summary.colors = acc.colors.size;
    summary.texts = acc.textSizes.size;
    summary.shadows = acc.shadows.size;
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
  if (summary.colors || summary.texts || summary.shadows) {
    console.log(`🎨 Кольори: ${summary.colors}`);
    console.log(`🅰️ Тексти:  ${summary.texts}`);
    console.log(`🌫️ Тіні:    ${summary.shadows}`);
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
