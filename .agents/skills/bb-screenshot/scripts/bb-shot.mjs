#!/usr/bin/env node
/**
 * Screenshots and measures the pi-surface plugin in a running bb (see
 * bb-harness.mjs). Opens a page in headless Chromium, optionally expands the
 * stack cards, crops to the named slots and writes a PNG. `--measure` prints
 * the insets of the stack cards and the context row; `--check` exits 1 when
 * they are not even.
 *
 *   bb-shot.mjs --thread <id> --expand --target stack --out stack.png
 *   bb-shot.mjs --thread <id> --expand --measure --check
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    work: { type: "string", default: process.env.PI_BB_HARNESS ?? join(tmpdir(), "pi-bb-harness") },
    server: { type: "string" },
    thread: { type: "string" },
    path: { type: "string" },
    target: { type: "string", multiple: true },
    selector: { type: "string", multiple: true },
    expand: { type: "boolean", default: false },
    click: { type: "string", multiple: true },
    "wait-for": { type: "string", multiple: true },
    theme: { type: "string", default: "dark" },
    width: { type: "string", default: "1280" },
    height: { type: "string", default: "900" },
    scale: { type: "string", default: "2" },
    pad: { type: "string", default: "8" },
    settle: { type: "string", default: "600" },
    timeout: { type: "string", default: "30000" },
    out: { type: "string" },
    measure: { type: "boolean", default: false },
    check: { type: "boolean", default: false },
  },
});

/** Named slots; each is one or more selectors whose union is cropped. */
const TARGETS = {
  todos: ['section[aria-label="Todos"]'],
  subagents: ['section[aria-label="Subagents"]'],
  context: ['section[aria-label="Thread context before sending"]'],
  stack: [
    'section[aria-label="Todos"]',
    'section[aria-label="Subagents"]',
    'section[aria-label="Thread context before sending"]',
  ],
  composer: [
    'section[aria-label="Todos"]',
    'section[aria-label="Thread context before sending"]',
    '[data-promptbox-root], form:has([contenteditable="true"])',
  ],
  page: [],
};
const CARDS = ["Todos", "Subagents"];
const CONTEXT = "Thread context before sending";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function serverUrl() {
  if (values.server) return values.server;
  const state = join(resolve(values.work), "state.json");
  if (!existsSync(state)) fail(`No harness state at ${state}; pass --server <url>.`);
  return JSON.parse(readFileSync(state, "utf8")).serverUrl;
}

async function loadPlaywright() {
  for (const base of [process.cwd(), import.meta.dirname]) {
    try {
      return createRequire(join(base, "noop.js"))("playwright");
    } catch {}
  }
  try {
    const { execSync } = await import("node:child_process");
    const global = execSync("npm root -g", { encoding: "utf8" }).trim();
    return createRequire(join(global, "noop.js"))("playwright");
  } catch {
    fail("Playwright is not installed. npm install -g playwright, or run where it resolves.");
  }
}

/** Runs in the page: insets of each stack card and of the context row. */
function measureInPage({ cards, context }) {
  const round = (n) => Math.round(n * 10) / 10;
  const contentBox = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      left: r.left + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft),
      right: r.right - parseFloat(s.borderRightWidth) - parseFloat(s.paddingRight),
      top: r.top + parseFloat(s.borderTopWidth) + parseFloat(s.paddingTop),
    };
  };
  const innerBox = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      left: r.left + parseFloat(s.borderLeftWidth),
      right: r.right - parseFloat(s.borderRightWidth),
      top: r.top + parseFloat(s.borderTopWidth),
    };
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const firstText = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (!(r.width > 0)) continue;
      // Text in a filled pill (a badge, a code chip) starts at the pill's edge.
      const style = getComputedStyle(node.parentElement);
      const filled =
        style.backgroundColor !== "rgba(0, 0, 0, 0)" || parseFloat(style.borderLeftWidth) > 0;
      return filled ? node.parentElement.getBoundingClientRect() : r;
    }
    return null;
  };
  const out = {};
  for (const label of cards) {
    const card = document.querySelector(`section[aria-label="${label}"]`);
    if (!card) continue;
    const inner = innerBox(card);
    const region = card.querySelector('[role="region"]');
    const header = [...card.querySelectorAll("svg")].find(
      (svg) => !region?.contains(svg) && visible(svg),
    );
    const headerButton = header?.closest("button");
    const titleRect = headerButton ? firstText(headerButton) : null;
    const entry = {
      header: {
        iconLeft: header ? round(header.getBoundingClientRect().left - inner.left) : null,
        textLeft: titleRect ? round(titleRect.left - inner.left) : null,
      },
      body: null,
    };
    if (region && region.getAttribute("aria-hidden") !== "true") {
      const regionBox = innerBox(region);
      const collapse = region.querySelector('button[aria-label^="Collapse"]');
      const wrapper = region.firstElementChild;
      const content = [...(wrapper?.children ?? [])].find(
        (child) => !(collapse && child.contains(collapse)),
      );
      if (content) {
        const rows = content.matches("ul, ol")
          ? [...content.children]
          : [...content.querySelectorAll("li")].length
            ? [...content.querySelectorAll("li")]
            : [content];
        const boxes = rows.filter(visible).map(contentBox);
        const firstIcon = rows[0]?.querySelector("svg");
        const firstRowText = rows[0] ? firstText(rows[0]) : null;
        entry.body = {
          left: round(Math.min(...boxes.map((b) => b.left)) - regionBox.left),
          right: round(regionBox.right - Math.max(...boxes.map((b) => b.right))),
          top: round(boxes[0].top - regionBox.top),
          iconLeft: firstIcon
            ? round(firstIcon.getBoundingClientRect().left - regionBox.left)
            : null,
          textLeft: firstRowText ? round(firstRowText.left - regionBox.left) : null,
        };
      }
    }
    out[label] = entry;
  }
  const banner = document.querySelector(`section[aria-label="${context}"]`);
  if (banner) {
    const inner = innerBox(banner);
    const segment = banner.querySelector('[role="group"][aria-label="Pi session"] svg');
    const textRect = segment ? firstText(segment.closest("button") ?? segment.parentElement) : null;
    out.context = {
      iconLeft: segment ? round(segment.getBoundingClientRect().left - inner.left) : null,
      textLeft: textRect ? round(textRect.left - inner.left) : null,
    };
  }
  return out;
}

/** Problems with the measured insets, as sentences; empty when even. */
export function insetProblems(measured, tolerance = 0.5) {
  const problems = [];
  const reference = Object.values(measured).find((m) => m.header?.iconLeft != null)?.header;
  if (!reference) return ["No stack card header found to compare against."];
  const near = (a, b) => a != null && b != null && Math.abs(a - b) <= tolerance;
  const expect = (what, value, want) => {
    if (value == null) return;
    if (!near(value, want)) problems.push(`${what} is ${value}px, expected ${want}px`);
  };
  for (const [label, m] of Object.entries(measured)) {
    if (label === "context") {
      expect("context row icon inset", m.iconLeft, reference.iconLeft);
      continue;
    }
    expect(`${label} header icon inset`, m.header.iconLeft, reference.iconLeft);
    if (!m.body) continue;
    expect(`${label} body left inset`, m.body.left, reference.iconLeft);
    expect(`${label} body right inset`, m.body.right, reference.iconLeft);
    expect(`${label} body top inset`, m.body.top, reference.iconLeft);
    expect(`${label} body text column`, m.body.textLeft, m.header.textLeft);
  }
  return problems;
}

async function main() {
  const playwright = await loadPlaywright();
  const url = new URL(
    values.path ?? (values.thread ? `/threads/${values.thread}` : "/"),
    serverUrl(),
  ).toString();
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: Number(values.width), height: Number(values.height) },
      deviceScaleFactor: Number(values.scale),
      colorScheme: values.theme === "light" ? "light" : "dark",
    });
    const timeout = Number(values.timeout);
    await page.goto(url, { waitUntil: "networkidle", timeout });
    const targets = (values.target ?? []).flatMap((name) => {
      if (!(name in TARGETS))
        fail(`Unknown --target ${name}; one of ${Object.keys(TARGETS).join(", ")}`);
      return TARGETS[name];
    });
    const selectors = [...targets, ...(values.selector ?? [])];
    for (const selector of values["wait-for"] ?? []) {
      await page.waitForSelector(selector, { timeout });
    }
    if (values.thread && (values.expand || values.measure || values.target)) {
      await page.waitForSelector('section[aria-label="Todos"], section[aria-label="Subagents"]', {
        timeout,
      });
    }
    if (values.expand) {
      for (const label of CARDS) {
        const toggle = page.locator(`section[aria-label="${label}"] button[aria-label="${label}"]`);
        if ((await toggle.count()) && (await toggle.getAttribute("aria-expanded")) !== "true") {
          await toggle.click();
        }
      }
    }
    for (const selector of values.click ?? []) await page.click(selector, { timeout });
    // Move the pointer off the cards so hover styles and focus rings stay out.
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.waitForTimeout(Number(values.settle));

    if (values.measure || values.check) {
      const measured = await page.evaluate(measureInPage, { cards: CARDS, context: CONTEXT });
      console.log(JSON.stringify(measured, null, 2));
      const problems = insetProblems(measured);
      if (problems.length) {
        console.error(`Uneven insets:\n- ${problems.join("\n- ")}`);
        if (values.check) process.exitCode = 1;
      } else {
        console.error("Insets are even.");
      }
    }

    if (values.out) {
      const pad = Number(values.pad);
      let clip;
      if (selectors.length) {
        const boxes = [];
        for (const selector of selectors) {
          for (const handle of await page.$$(selector)) {
            const box = await handle.boundingBox();
            if (box && box.width && box.height) boxes.push(box);
          }
        }
        if (!boxes.length) fail(`Nothing matched: ${selectors.join(", ")}`);
        const left = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
        const top = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
        const right = Math.max(...boxes.map((b) => b.x + b.width)) + pad;
        const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + pad;
        clip = { x: left, y: top, width: right - left, height: bottom - top };
      }
      await page.screenshot({ path: values.out, ...(clip ? { clip } : {}) });
      console.error(`wrote ${values.out}`);
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) await main();
