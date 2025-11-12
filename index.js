// index.js — Figma → SCSS + Fonts + Icons exporter (v3.4 SafeBatch)
// --------------------------------------------------------------
// ✅ Оновлює SCSS з фрейму (inline стилі, без Local Styles) та робить .bak
// ✅ Збирає кольори / текст-розміри (#{rem/remD}) / (опц.) тіні
// ✅ Експортує шрифти (Google + Fontshare + CDNFonts), агрегує ваги по сім’ї
// ✅ Мапа псевдонімів: MacPaw Fixel Text → Fixel Text (Fontshare)
// ✅ Експортує іконки (SVG → PNG fallback) з фільтром валідних id і без FRAME/GROUP, якщо не “iconish”
// ✅ Батчі images API містять лише валідні id → немає “ID  is not a valid node_id”
// ✅ ZIP: dist/export_Figma.zip

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import inquirer from "inquirer";
import dotenv from "dotenv";
import chalk from "chalk";

dotenv.config();
const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
if (!FIGMA_TOKEN) {
  console.error("❌ FIGMA_TOKEN не знайдено у .env");
  process.exit(1);
}
const FIGMA_HEADERS = { "X-Figma-Token": FIGMA_TOKEN };

// ---------- helpers ----------
const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
const slug = (s = "") =>
  s.toString().trim().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_\-]+/g, "-").replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "").toLowerCase() || "node";
const uniqName = (base, used) => { let n = base, i = 2; while (used.has(n)) n = `${base}-${i++}`; used.add(n); return n; };
const to255 = (x) => Math.round((x ?? 0) * 255);
const hex2 = (v) => v.toString(16).padStart(2, "0");
const rgbaOrHex = (c) =>
  c && c.a < 1 ? `rgba(${to255(c.r)}, ${to255(c.g)}, ${to255(c.b)}, ${Number(c.a.toFixed(3))})`
               : `#${hex2(to255(c.r))}${hex2(to255(c.g))}${hex2(to255(c.b))}`;
const px = (n) => `${Math.round(n || 0)}px`;
const wrapRem = (pxVal, isDesktop) => isDesktop ? `#{remD(${pxVal})}` : `#{rem(${pxVal})}`;
const extractFileAndNode = (url) => ({
  fileId: (url.match(/(?:file|design)\/([a-zA-Z0-9]+)\//) || [])[1] || null,
  nodeId: ((url.match(/node-id=([0-9:-]+)/) || [])[1] || "").replace(/-/g, ":")
});

const isValidNodeId = (id) => typeof id === "string" && id.length > 0 && /^[0-9:]+$/.test(id);

// ---------- figma fetch ----------
async function figmaGET(url) {
  const res = await fetch(url, { headers: FIGMA_HEADERS });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.err || data?.message || `HTTP ${res.status}`);
  return data;
}
async function fetchFrame(fileId, nodeId) {
  const data = await figmaGET(`https://api.figma.com/v1/files/${fileId}/nodes?ids=${encodeURIComponent(nodeId)}`);
  const doc = data?.nodes?.[nodeId]?.document;
  if (!doc) throw new Error("Не знайдено документ фрейму.");
  return doc;
}

// ---------- traverse ----------
const ICON_NAME_RX = /icon|icn|glyph|logo|arrow|chevron|close|burger|menu|play|pause|cart|search|user|heart|plus|minus|star|trash|check|cross/i;
const VECTOR_TYPES = new Set(["VECTOR","BOOLEAN_OPERATION","STAR","LINE","ELLIPSE","POLYGON","RECTANGLE","REGULAR_POLYGON","INSTANCE","COMPONENT"]);

function looksIconCandidate(node, pathHint) {
  if (!node?.id || !isValidNodeId(node.id)) return false;
  const name = node.name || "";
  const type = node.type || "";
  // якщо назва "іконна" — беремо
  if (ICON_NAME_RX.test(name)) return true;
  // якщо тип векторний — беремо, але з обмеженням розміру
  if (VECTOR_TYPES.has(type)) {
    const bb = node.absoluteBoundingBox;
    if (bb && bb.width && bb.height) {
      return bb.width <= 128 && bb.height <= 128;
    }
    // якщо bbox відсутній — перестрахуємось: брати тільки якщо назва "іконна"
    return false;
  }
  return false;
}

function traverse(node, acc, ancestry = []) {
  if (!node || node.visible === false) return;
  const current = node.name ? [...ancestry, node.name] : ancestry;
  const pathHint = current.join("/").toLowerCase();

  // colors
  if (Array.isArray(node.fills)) {
    for (const f of node.fills)
      if (f?.visible !== false && f.type === "SOLID" && f.color)
        acc.colors.add(rgbaOrHex(f.color));
  }
  if (Array.isArray(node.strokes)) {
    for (const s of node.strokes)
      if (s?.visible !== false && s.type === "SOLID" && s.color)
        acc.colors.add(rgbaOrHex(s.color));
  }

  // text
  if (node.type === "TEXT" && node.style) {
    const { fontSize, fontFamily, fontWeight } = node.style;
    if (fontSize) {
      const size = px(fontSize);
      const isDesktop = pathHint.includes("desktop") || fontSize >= 20;
      acc.textSizes.add(wrapRem(size, isDesktop));
    }
    if (fontFamily) {
      const w = Number(fontWeight) || 400;
      acc.fonts.add(`${fontFamily}::${w}`);
    }
  }

  // icons (відфільтруємо валідні id та невеликі векторні)
  if (looksIconCandidate(node, pathHint)) {
    acc.iconNodes.push({ id: node.id, name: current[current.length - 1] || "icon" });
  }

  if (Array.isArray(node.children)) node.children.forEach((c) => traverse(c, acc, current));
}

// ---------- SCSS ----------
const readScss = (p) => {
  if (!fs.existsSync(p)) throw new Error(`SCSS не знайдено: ${p}`);
  return fs.readFileSync(p, "utf8");
};
const backupScss = (p) => { const b = `${p}.bak`; fs.copyFileSync(p, b); return b; };
function parseScssVars(content) {
  const re = /(--[A-Za-z0-9_\-]+)\s*:\s*([^;]+);/g;
  const vars = [];
  let m; while ((m = re.exec(content)) !== null) vars.push({ name: m[1], value: m[2].trim() });
  return vars;
}
function classifyVar(name, value) {
  const n = name.toLowerCase(); const v = (value||"").toLowerCase();
  const looksHex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(v);
  const looksRgba = /^rgba?\(/.test(v);
  const looksRemFn = /#\{remd\(/.test(v) || /#\{rem\(/.test(v);
  const looksShadow = /(rgba?\(.+\)).*\d+px/.test(v) || n.includes("shadow");
  if (looksRemFn || /desktop---|mobile---|headline|caption|body|button/.test(n)) return "text";
  if (looksShadow) return "shadow";
  if (looksHex || looksRgba || /color|greyscale|primary|secondary|support|special/.test(n)) return "color";
  return null;
}
function replaceScss(content, updates) {
  if (!updates.size) return { text: content, changed: 0 };
  let changed = 0;
  const out = content.replace(/(--[A-Za-z0-9_\-]+)\s*:\s*([^;]+);/g, (m, n, oldVal) => {
    if (!updates.has(n)) return m;
    const nv = updates.get(n);
    if (String(oldVal).trim() === String(nv).trim()) return m;
    changed++;
    return `${n}: ${nv};`;
  });
  return { text: out, changed };
}

// ---------- fonts (Google + Fontshare + CDNFonts) ----------
const weightMap = {100:"Thin",200:"ExtraLight",300:"Light",400:"Regular",500:"Medium",600:"SemiBold",700:"Bold",800:"ExtraBold",900:"Black"};
const FONT_ALIASES = new Map([
  // Figma family       -> public CDN family
  ["MacPaw Fixel Text", "Fixel Text"],   // Fontshare
  ["Fixel Text", "Fixel Text"]
]);

function normalizeFamilyForQuery(fam) {
  const alias = FONT_ALIASES.get(fam) || fam;
  return alias.trim();
}
function fontshareParam(fam) {
  // Fontshare очікує kebab-case
  return normalizeFamilyForQuery(fam).toLowerCase().replace(/\s+/g, "-");
}
async function tryGoogleFont(family, weightSet, outDir) {
  const fam = normalizeFamilyForQuery(family);
  const weights = [...new Set([...weightSet].map(w => Number(w) || 400))].sort((a,b)=>a-b);
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam)}:wght@${weights.join(";")}&display=swap`;
  try {
    const cssRes = await fetch(cssUrl);
    if (!cssRes.ok) return 0;
    const css = await cssRes.text();
    const m = [...css.matchAll(/url\((https:[^)]+\.woff2)\).*?font-weight:(\d+)/gs)];
    if (!m.length) return 0;
    const famDir = path.join(outDir, fam.replace(/\s+/g, "_")); ensureDir(famDir);
    let c = 0;
    for (const [, url, w] of m) {
      const r = await fetch(url);
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      const wdir = path.join(famDir, `${fam}-${weightMap[w] || w}`); ensureDir(wdir);
      fs.writeFileSync(path.join(wdir, `${fam}-${weightMap[w] || w}.woff2`), buf);
      c++;
    }
    return c;
  } catch { return 0; }
}
async function tryFontshare(family, weightSet, outDir) {
  const fam = normalizeFamilyForQuery(family);
  const cssUrl = `https://api.fontshare.com/v2/css?f[]=${fontshareParam(fam)}&display=swap`;
  try {
    const cssRes = await fetch(cssUrl);
    if (!cssRes.ok) return 0;
    const css = await cssRes.text();
    const m = [...css.matchAll(/url\((https:[^)]+\.woff2)\).*?font-weight:(\d+)/gs)];
    if (!m.length) return 0;
    const famDir = path.join(outDir, fam.replace(/\s+/g, "_")); ensureDir(famDir);
    let c = 0;
    for (const [, url, w] of m) {
      const r = await fetch(url);
      if (!r.ok) continue;
      // якщо користувач просив конкретні ваги — пропускаємо інші
      if (weightSet && weightSet.size && !weightSet.has(Number(w))) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      const wdir = path.join(famDir, `${fam}-${weightMap[w] || w}`); ensureDir(wdir);
      fs.writeFileSync(path.join(wdir, `${fam}-${weightMap[w] || w}.woff2`), buf);
      c++;
    }
    return c;
  } catch { return 0; }
}
async function tryCDNFonts(family, outDir) {
  // best-effort: часто видає ttf/zip — тримаємо як резерв
  const fam = normalizeFamilyForQuery(family);
  const url = `https://www.cdnfonts.com/${fam.replace(/\s+/g,"-").toLowerCase()}.font`;
  try {
    const r = await fetch(url);
    if (!r.ok) return 0;
    const buf = Buffer.from(await r.arrayBuffer());
    const famDir = path.join(outDir, fam.replace(/\s+/g, "_"), `${fam}-Regular`);
    ensureDir(famDir);
    fs.writeFileSync(path.join(famDir, `${fam}-Regular.woff2`), buf);
    return 1;
  } catch { return 0; }
}
async function downloadFamilyAggregated(family, weightSet, outDir) {
  // одна сім’я → одна спроба з усіма вагами
  let got = await tryGoogleFont(family, weightSet, outDir);
  if (!got) got = await tryFontshare(family, weightSet, outDir);
  if (!got) got = await tryCDNFonts(family, outDir);
  return got;
}

// ---------- icons (safe batches) ----------
async function exportIcons(fileId, nodes, outDir) {
  // залишаємо тільки ноди з валідним id
  const clean = nodes.filter(n => isValidNodeId(n.id));
  if (!clean.length) return { rows: [], ok: 0 };
  ensureDir(outDir);

  const used = new Set();
  const rows = [];
  let ok = 0;

  // SVG спроба
  const chunkSize = 80;
  for (let i = 0; i < clean.length; i += chunkSize) {
    const batch = clean.slice(i, i + chunkSize);
    const ids = batch.map(n => n.id).join(",");
    if (!ids) continue;
    const url = `https://api.figma.com/v1/images/${fileId}?ids=${encodeURIComponent(ids)}&format=svg&svg_include_id=true`;
    let map = {};
    try { map = (await figmaGET(url)).images || {}; } catch { map = {}; }
    for (const n of batch) {
      const base = uniqName(slug(n.name || "icon"), used);
      const img = map[n.id];
      if (img) {
        try {
          const r = await fetch(img);
          if (r.ok) {
            const buf = Buffer.from(await r.arrayBuffer());
            fs.writeFileSync(path.join(outDir, `${base}.svg`), buf);
            rows.push({ name: base, fmt: "svg", status: "✅" });
            ok++;
            continue;
          }
        } catch {}
      }
      rows.push({ name: base, fmt: "svg", status: "—" });
    }
  }

  // PNG fallback для “—”
  const pending = rows.filter(r => r.status !== "✅");
  for (let i = 0; i < pending.length; i += chunkSize) {
    const sub = pending.slice(i, i + chunkSize);
    const ids = clean
      .filter(n => sub.some(r => slug(n.name || "icon") === r.name))
      .map(n => n.id).join(",");
    if (!ids) continue;
    const url = `https://api.figma.com/v1/images/${fileId}?ids=${encodeURIComponent(ids)}&format=png&scale=2`;
    let map = {};
    try { map = (await figmaGET(url)).images || {}; } catch { map = {}; }
    for (const r of sub) {
      const node = clean.find(n => slug(n.name || "icon") === r.name);
      const img = node ? map[node.id] : null;
      if (img) {
        try {
          const rr = await fetch(img);
          if (rr.ok) {
            const buf = Buffer.from(await rr.arrayBuffer());
            fs.writeFileSync(path.join(outDir, `${r.name}.png`), buf);
            r.fmt = "png"; r.status = "✅"; ok++;
            continue;
          }
        } catch {}
      }
      r.status = "⚠️";
    }
  }

  return { rows, ok };
}
function printIconTable(rows) {
  if (!rows.length) { console.log(chalk.gray("🖼️ Іконки: 0")); return; }
  console.log(chalk.cyan("\n🖼️ Іконки:"));
  console.log("Назва".padEnd(24), "Формат".padEnd(8), "Статус");
  console.log("-".repeat(24), "-".repeat(8), "-".repeat(8));
  for (const r of rows) console.log(r.name.padEnd(24), r.fmt.padEnd(8), r.status);
  const ok = rows.filter(r => r.status === "✅").length;
  console.log("-".repeat(24), "-".repeat(8), "-".repeat(8));
  console.log(`Разом: ${rows.length} (успішно ${ok})`);
}

// ---------- zip ----------
async function createZip(outPath, dirs) {
  const zip = new JSZip();
  const add = (p, base = zip) => {
    if (!fs.existsSync(p)) return;
    const s = fs.statSync(p);
    if (s.isDirectory()) {
      const f = base.folder(path.basename(p));
      for (const i of fs.readdirSync(p)) add(path.join(p, i), f);
    } else {
      base.file(path.basename(p), fs.readFileSync(p));
    }
  };
  dirs.forEach(d => add(d));
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionLevel: 6 });
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, buf);
}

// ---------- main ----------
async function main() {
  const { scssPath, figmaUrl } = await inquirer.prompt([
    { name: "scssPath", message: "SCSS шлях:", default: "dist/roots.scss" },
    { name: "figmaUrl", message: "Figma frame URL:" },
  ]);
  const { fileId, nodeId } = extractFileAndNode(figmaUrl);
  if (!fileId || !nodeId || !isValidNodeId(nodeId)) {
    console.error("❌ Неможливо отримати валідний file_id / node_id з URL");
    process.exit(1);
  }

  console.log(chalk.cyan(`\n🔍 file_id: ${fileId}`));
  console.log(chalk.cyan(`🔍 node_id: ${nodeId}`));
  console.log(chalk.gray("⏳ Отримую дані з Figma..."));

  const frame = await fetchFrame(fileId, nodeId);
  const acc = { colors: new Set(), textSizes: new Set(), fonts: new Set(), iconNodes: [] };
  traverse(frame, acc);

  console.log(chalk.green(`🎨 Кольори: ${acc.colors.size}`));
  console.log(chalk.green(`🅰️ Текстові розміри: ${acc.textSizes.size}`));
  console.log(chalk.green(`🖋️ Шрифти: ${acc.fonts.size}`));

  // SCSS update (оновлюємо ТІЛЬКИ існуючі змінні)
  const scss = readScss(scssPath);
  const vars = parseScssVars(scss);
  const colors = [...acc.colors], texts = [...acc.textSizes]; // тіні опційно
  const updates = new Map();
  let ci = 0, ti = 0;
  for (const v of vars) {
    const t = classifyVar(v.name, v.value);
    if (t === "color" && colors.length) updates.set(v.name, colors[ci++ % colors.length]);
    if (t === "text" && texts.length)   updates.set(v.name, texts[ti++ % texts.length]);
    // тіні при потребі: if (t==="shadow") ...
  }
  const bak = backupScss(scssPath);
  const { text: newScss, changed } = replaceScss(scss, updates);
  if (changed > 0) fs.writeFileSync(scssPath, newScss, "utf8");
  console.log(chalk.gray(`💾 Резервна копія: ${bak}`));
  console.log(chalk.green(`✅ ${changed > 0 ? "SCSS оновлено" : "SCSS без змін"}`));

  // Fonts — агрегуємо по сім’ї з вагами
  const fontsDir = path.join("dist", "assets", "fonts");
  ensureDir(fontsDir);
  const famWeights = new Map(); // fam -> Set(weights)
  for (const key of acc.fonts) {
    const [fam, wStr] = key.split("::");
    const famN = (fam || "").trim();
    if (!famN) continue;
    const w = Number(wStr) || 400;
    if (!famWeights.has(famN)) famWeights.set(famN, new Set());
    famWeights.get(famN).add(w);
  }
  let okFamilies = 0, manualFamilies = 0;
  for (const [fam, wset] of famWeights.entries()) {
    const got = await downloadFamilyAggregated(fam, wset, fontsDir);
    if (got) {
      okFamilies++;
      console.log(chalk.green(`📚 ${fam}: завантажено файлів ${got}`));
    } else {
      manualFamilies++;
      console.log(chalk.yellow(`⚠️ ${fam}: не знайдено у публічних каталогах, додай вручну`));
    }
  }
  if (manualFamilies > 0) {
    const missing = [...famWeights.keys()].filter(f => !fs.existsSync(path.join(fontsDir, f.replace(/\s+/g,"_"))));
    if (missing.length) {
      ensureDir(fontsDir);
      fs.writeFileSync(path.join(fontsDir, "fonts.txt"), `Fonts (manual):\n- ${missing.join("\n- ")}\n`);
    }
  }

  // Icons — лише валідні id, safe batches
  const iconsDir = path.join("dist", "assets", "icons");
  const { rows, ok } = await exportIcons(fileId, acc.iconNodes, iconsDir);
  printIconTable(rows);

  // ZIP
  const zipPath = path.join("dist", "export_Figma.zip");
  await createZip(zipPath, [path.join("dist", "assets")]);
  console.log(chalk.green(`\n📦 Архів створено: ${zipPath}`));

  // Summary
  console.log(chalk.cyan("\n────────────── РЕЗЮМЕ ──────────────"));
  console.log(`🎨 Кольори: ${acc.colors.size}`);
  console.log(`🅰️ Тексти: ${acc.textSizes.size}`);
  console.log(`📚 Шрифти (сімей): успішно ${okFamilies}, вручну ${manualFamilies}`);
  console.log(`🖼️ Іконки: ${ok}/${rows.length}`);
  console.log(`💾 ZIP: ${zipPath}`);
  console.log(chalk.cyan("────────────────────────────────────"));
}

main().catch((e) => { console.error(chalk.red(`❌ ${e.message}`)); process.exit(1); });
