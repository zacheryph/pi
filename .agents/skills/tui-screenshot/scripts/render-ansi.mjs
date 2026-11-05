#!/usr/bin/env node
/**
 * Render captured terminal text (with SGR color codes) to an HTML page and a
 * PNG. Every non-ASCII character is placed in a box of its terminal cell width,
 * so wide Unicode, box drawing and Nerd Font icons keep the grid aligned.
 *
 *   node render-ansi.mjs <capture.ansi> <out.png> [--symbols-font <file>] [--scale 2]
 *     [--html <out.html>] [--no-frame]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";

/** Terminal colors 0-15. Pi's built-in themes draw with these indices. */
export const PALETTE = [
  "#1e1e2e",
  "#f38ba8",
  "#a6e3a1",
  "#f9e2af",
  "#89b4fa",
  "#cba6f7",
  "#94e2d5",
  "#bac2de",
  "#585b70",
  "#f38ba8",
  "#a6e3a1",
  "#f9e2af",
  "#89b4fa",
  "#cba6f7",
  "#94e2d5",
  "#a6adc8",
];
export const FOREGROUND = "#cdd6f4";
export const BACKGROUND = "#1e1e2e";

/** xterm 256-color index to CSS. */
export function color256(n, palette = PALETTE) {
  if (n < 16) return palette[n];
  if (n < 232) {
    const steps = [0, 95, 135, 175, 215, 255];
    const i = n - 16;
    return `rgb(${steps[Math.floor(i / 36)]},${steps[Math.floor(i / 6) % 6]},${steps[i % 6]})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

/** Apply one SGR parameter list to a style object (mutated and returned). */
export function applySgr(style, params, palette = PALETTE) {
  const p = params === "" ? [0] : params.split(/[;:]/).map((x) => Number(x || 0));
  for (let i = 0; i < p.length; i++) {
    const x = p[i];
    if (x === 0) for (const key of Object.keys(style)) delete style[key];
    else if (x === 1) style.bold = true;
    else if (x === 2) style.dim = true;
    else if (x === 3) style.italic = true;
    else if (x === 4) style.underline = true;
    else if (x === 7) style.inverse = true;
    else if (x === 9) style.strike = true;
    else if (x === 22) style.bold = style.dim = false;
    else if (x === 23) style.italic = false;
    else if (x === 24) style.underline = false;
    else if (x === 27) style.inverse = false;
    else if (x === 29) style.strike = false;
    else if (x >= 30 && x <= 37) style.fg = palette[x - 30];
    else if (x >= 90 && x <= 97) style.fg = palette[x - 82];
    else if (x === 39) delete style.fg;
    else if (x >= 40 && x <= 47) style.bg = palette[x - 40];
    else if (x >= 100 && x <= 107) style.bg = palette[x - 92];
    else if (x === 49) delete style.bg;
    else if (x === 38 || x === 48) {
      const key = x === 38 ? "fg" : "bg";
      if (p[i + 1] === 5) {
        style[key] = color256(p[i + 2], palette);
        i += 2;
      } else if (p[i + 1] === 2) {
        style[key] = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`;
        i += 4;
      }
    }
  }
  return style;
}

/**
 * Split terminal text into lines of styled runs. SGR sequences set the style;
 * every other escape sequence (cursor moves, OSC titles and links) is dropped.
 */
export function parseAnsi(input, palette = PALETTE) {
  const style = {};
  const lines = [[]];
  // CSI ... final byte, OSC ... BEL/ST, or a lone two-byte escape.
  // oxlint-disable-next-line no-control-regex -- terminal escape sequences are the input
  const re = /\x1b\[([0-9;:?]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
  const push = (text) => {
    const parts = text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines.at(-1).push({ text: part.replace(/\r/g, ""), style: { ...style } });
    });
  };
  let last = 0;
  for (const m of input.matchAll(re)) {
    push(input.slice(last, m.index));
    if (m[2] === "m") applySgr(style, m[1], palette);
    last = m.index + m[0].length;
  }
  push(input.slice(last));
  while (lines.length > 1 && lines.at(-1).length === 0) lines.pop();
  return lines;
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Wrap each non-ASCII grapheme in a box as wide as its terminal cells. */
export function cellText(text) {
  let out = "";
  for (const { segment } of segmenter.segment(text)) {
    if (/^[\x20-\x7e]$/.test(segment)) out += escapeHtml(segment);
    else {
      const width = visibleWidth(segment);
      if (width > 0) out += `<span class="w${width > 1 ? 2 : 1}">${escapeHtml(segment)}</span>`;
    }
  }
  return out;
}

function runHtml({ text, style }) {
  let fg = style.fg ?? FOREGROUND;
  let bg = style.bg;
  if (style.inverse) [fg, bg] = [bg ?? BACKGROUND, fg];
  const css = [`color:${fg}`];
  if (bg) css.push(`background:${bg}`);
  if (style.bold) css.push("font-weight:700");
  if (style.dim) css.push("opacity:.6");
  if (style.italic) css.push("font-style:italic");
  const lines = [style.underline && "underline", style.strike && "line-through"].filter(Boolean);
  if (lines.length) css.push(`text-decoration:${lines.join(" ")}`);
  return `<span style="${css.join(";")}">${cellText(text)}</span>`;
}

export function ansiToHtml(input, palette = PALETTE) {
  return parseAnsi(input, palette)
    .map((runs) => runs.map(runHtml).join(""))
    .join("\n");
}

/** The first installed font whose family names Nerd Font symbols, if any. */
export function findSymbolsFont() {
  try {
    const fonts = execFileSync("fc-list", ["--format", "%{family}\t%{file}\n"], {
      encoding: "utf8",
    })
      .split("\n")
      .map((line) => line.split("\t"))
      .filter(([family, file]) => file && /nerd font/i.test(family));
    const symbols = fonts.find(([family]) => /symbols/i.test(family));
    return (symbols ?? fonts[0])?.[1];
  } catch {
    return undefined;
  }
}

export function renderPage(input, { symbolsFont, frame = true } = {}) {
  const face = symbolsFont
    ? `@font-face{font-family:"TuiSymbols";src:url("${pathToFileURL(resolve(symbolsFont)).href}")}`
    : "";
  const bar = frame
    ? `<div class="bar">${["#f38ba8", "#f9e2af", "#a6e3a1"].map((c) => `<i style="background:${c}"></i>`).join("")}</div>`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
${face}
body{margin:0;background:#11111b;padding:${frame ? 24 : 0}px;display:inline-block}
.win{background:${BACKGROUND};${frame ? "border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.5);" : ""}overflow:hidden}
.bar{height:30px;background:#181825;display:flex;align-items:center;padding:0 12px;gap:8px}
.bar i{width:12px;height:12px;border-radius:50%}
pre{margin:0;padding:14px 16px;font:14px/1.35 "JetBrains Mono","DejaVu Sans Mono",TuiSymbols,monospace;color:${FOREGROUND};white-space:pre}
.w1,.w2{display:inline-block;text-align:center;overflow:visible}
.w1{width:1ch}.w2{width:2ch}
</style></head><body><div class="win">${bar}<pre>${ansiToHtml(input)}</pre></div></body></html>`;
}

/** Load Playwright from the project, NODE_PATH, or the global install. */
export function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require("playwright");
  } catch {
    try {
      const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
      return createRequire(join(root, "noop.js"))("playwright");
    } catch {
      throw new Error(
        "Playwright is not installed. Install it with `npm i -g playwright && npx playwright install chromium`.",
      );
    }
  }
}

/** Write the page and screenshot it at `scale` device pixels per CSS pixel. */
export async function renderPng(input, out, { scale = 2, html, ...pageOptions } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tui-render-"));
  const page = join(dir, "page.html");
  writeFileSync(page, renderPage(input, pageOptions));
  if (html) writeFileSync(html, renderPage(input, pageOptions));
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage({ deviceScaleFactor: scale });
    await tab.goto(pathToFileURL(page).href);
    await tab.evaluate(() => document.fonts.ready);
    await tab.locator("body > .win").screenshot({ path: out });
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "symbols-font": { type: "string" },
      scale: { type: "string", default: "2" },
      html: { type: "string" },
      "no-frame": { type: "boolean", default: false },
    },
  });
  const [input, out] = positionals;
  if (!input || !out) {
    console.error("usage: render-ansi.mjs <capture.ansi> <out.png> [--symbols-font <file>]");
    process.exit(2);
  }
  await renderPng(readFileSync(input, "utf8"), out, {
    scale: Number(values.scale),
    html: values.html,
    frame: !values["no-frame"],
    symbolsFont: values["symbols-font"] ?? findSymbolsFont(),
  });
  console.log(out);
}
