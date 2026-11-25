// The dashboard page: static HTML; all session data arrives over /events and
// is rendered with DOM APIs (textContent), never interpolated as markup.
//
// Each session is the hub's latest complete snapshot of its views. The script
// has one renderer per view kind: session (cards, header, strip, activity),
// summary (count chips), widget, explorer, detail and form. It knows no
// extension: behaviour is the action a view references, sent back through
// POST /api/sessions/<id>/actions, and Focus is the dashboard's own request.
//
// Count text comes from pi-surface's formatters, whose source the script
// embeds, so a summary count reads here exactly as it does in bb.

import { formatBytes, formatCount, formatSummaryCount } from "#surface";

/** pi-surface's count formatters as source for the script; each is self-contained. */
const FORMATTERS = [formatBytes, formatCount, formatSummaryCount]
  .map((format) => format.toString())
  .join("\n");

const STYLE = `
:root {
  --bg: #f3f5f8; --surface: #ffffff; --ink: #18202c; --muted: #5a6577; --line: #d3d9e2; --wire: #e7ebf1;
  --accent: #1f6a86; --accent-soft: #dcedf3; --warn: #9a6408; --warn-soft: #faefd9;
  --violet: #6a4bb0; --violet-soft: #ebe5f7; --ok: #2c7a4b; --ok-soft: #dff1e6; --bad: #b2392f; --bad-soft: #f8e2df;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) { :root {
  --bg: #11161d; --surface: #182029; --ink: #e4e9f0; --muted: #9aa6b6; --line: #2c3743; --wire: #212b36;
  --accent: #6bb8d4; --accent-soft: #19343f; --warn: #e2b15a; --warn-soft: #3a2c12;
  --violet: #b39cf0; --violet-soft: #2a2242; --ok: #6cc690; --ok-soft: #173325; --bad: #ec8a80; --bad-soft: #3d1d1a;
  color-scheme: dark;
} }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--accent); }
header { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 20px; background: var(--surface); border-bottom: 1px solid var(--line); }
#filter { font: 13px var(--mono); padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); width: 220px; max-width: 100%; min-width: 0; }
button.toggle, button.small { font: 500 12px var(--mono); border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 6px; padding: 3px 8px; cursor: pointer; white-space: nowrap; }
button.toggle[aria-pressed="true"] { color: var(--accent); border-color: var(--accent); }
button.small { font-size: 11px; padding: 1px 7px; color: var(--accent); }
dialog.modal { padding: 0; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); color: var(--ink); width: min(980px, calc(100vw - 32px)); max-height: calc(100vh - 48px); box-shadow: 0 24px 64px rgb(0 0 0 / 0.28); overflow: hidden; }
dialog.modal[open] { display: flex; flex-direction: column; }
dialog.modal::backdrop { background: rgb(12 17 24 / 0.5); }
body:has(dialog.modal[open]) { overflow: hidden; }
.modal-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: start; padding: 14px 18px 12px; border-bottom: 1px solid var(--line); }
.modal-title { display: grid; gap: 3px; min-width: 0; }
.modal-title h2 { margin: 0; font: 600 16px var(--mono); overflow-wrap: anywhere; }
.modal-title p { margin: 4px 0 2px; }
.modal-body { overflow: auto; flex: 1; min-height: 0; background: var(--bg); }
.modal-foot { padding: 8px 18px; border-top: 1px solid var(--line); font: 12px var(--mono); color: var(--muted); }
.pad { margin: 0; padding: 16px 18px; }
button.close { border: 0; background: transparent; color: var(--muted); font: 22px/1 system-ui, sans-serif; padding: 2px 8px 4px; border-radius: 6px; cursor: pointer; }
button.close:hover { background: var(--wire); color: var(--ink); }
section.panel.asks { border-color: var(--warn); box-shadow: inset 3px 0 0 var(--warn); }
.qsummary { display: grid; gap: 4px; min-width: 0; flex: 1; }
.qline { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
.chip { flex: none; font: 600 10px var(--mono); letter-spacing: 0.05em; text-transform: uppercase; color: var(--warn); background: var(--warn-soft); border-radius: 4px; padding: 1px 6px; }
.answer-form { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.qform { display: grid; gap: 20px; padding: 16px 18px; overflow: auto; min-height: 0; flex: 1; }
.qblock { display: grid; gap: 8px; margin: 0; padding: 0; border: 0; min-width: 0; }
.qlegend { display: flex; gap: 8px; align-items: baseline; padding: 0; margin-bottom: 4px; }
.qtext { font-weight: 600; white-space: pre-wrap; overflow-wrap: anywhere; }
.choice { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 2px 8px; align-items: start; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; cursor: pointer; background: var(--surface); }
.choice:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); }
.choice input { margin: 3px 0 0; accent-color: var(--accent); }
.choice span { overflow-wrap: anywhere; }
.choice small { grid-column: 2; color: var(--muted); overflow-wrap: anywhere; }
textarea.answer { width: 100%; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--ink); resize: vertical; }
label.note { display: grid; gap: 4px; }
.modal-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; align-items: center; padding: 10px 18px; border-top: 1px solid var(--line); }
.modal-actions .bad { margin-right: auto; font-size: 13px; }
button.primary, button.secondary { font: 600 13px system-ui, -apple-system, "Segoe UI", sans-serif; border-radius: 6px; padding: 6px 14px; cursor: pointer; }
button.primary { background: var(--accent); color: var(--surface); border: 1px solid var(--accent); }
button.secondary { background: transparent; color: var(--ink); border: 1px solid var(--line); }
button.primary:disabled, button.secondary:disabled { opacity: 0.5; cursor: not-allowed; }
.closed-banner { background: var(--warn-soft); color: var(--warn); padding: 8px 18px; font-size: 13px; }
pre.preview { margin: 0; padding: 12px 18px; font: 12px/1.5 var(--mono); white-space: pre; tab-size: 4; }
pre.preview .ln { color: var(--muted); user-select: none; display: inline-block; min-width: 4ch; text-align: right; margin-right: 1.5ch; }
.timeline { list-style: none; margin: 4px 0 0; padding: 0 0 0 10px; border-left: 2px solid var(--line); display: grid; gap: 6px; }
.timeline li { display: grid; gap: 2px; }
.warn { color: var(--warn); font-size: 12px; }
.bad { color: var(--bad); }
header h1 { margin: 0; font: 600 15px var(--mono); }
header h1 a { color: inherit; text-decoration: none; }
header .count { margin-left: auto; color: var(--muted); font-variant-numeric: tabular-nums; }
.conn { font: 500 12px var(--mono); color: var(--muted); }
.conn.live { color: var(--ok); }
main { max-width: 1280px; margin: 0 auto; padding: 8px 20px 40px; display: grid; gap: 4px; }
h2.group { margin: 16px 0 4px; font: 500 12px var(--mono); letter-spacing: 0.05em; color: var(--muted); overflow-wrap: anywhere; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; align-items: start; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; display: grid; gap: 6px; align-content: start; min-width: 0; cursor: pointer; }
.card:hover { border-color: var(--accent); }
.card.attn { border-color: var(--warn); box-shadow: inset 3px 0 0 var(--warn); }
.card.restarting { opacity: 0.55; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-width: 0; }
.name { margin: 0; font: 600 14px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.name a { color: inherit; text-decoration: none; }
.name.untitled { color: var(--muted); font-weight: 500; }
.muted { color: var(--muted); }
.mono { font-family: var(--mono); font-size: 12px; }
.clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wrap { overflow-wrap: anywhere; white-space: pre-wrap; }
.pill { display: inline-flex; align-items: center; gap: 6px; flex: none; max-width: 60%; font: 600 11px var(--mono); padding: 1px 8px; border-radius: 999px; background: var(--wire); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pill::before { content: ""; flex: none; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.pill.working, .pill.tool, .pill.running { background: var(--accent-soft); color: var(--accent); }
.pill.waiting, .pill.queued { background: var(--warn-soft); color: var(--warn); }
.pill.compacting { background: var(--violet-soft); color: var(--violet); }
.pill.completed { background: var(--ok-soft); color: var(--ok); }
.pill.failed { background: var(--bad-soft); color: var(--bad); }
.ctx { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
.meter { height: 7px; border-radius: 4px; background: var(--wire); overflow: hidden; min-width: 60px; }
.meter i { display: block; height: 100%; background: var(--accent); }
.meter.hot i { background: var(--warn); }
.num { font-variant-numeric: tabular-nums; }
.empty { margin: 48px auto; max-width: 42ch; text-align: center; color: var(--muted); }
button.focus { font: 600 12px var(--mono); border: 1.5px solid var(--accent); color: var(--accent); background: transparent; border-radius: 6px; padding: 3px 10px; cursor: pointer; white-space: nowrap; }
button.focus.solid { background: var(--accent); color: var(--surface); }
button.focus:disabled { opacity: 0.6; cursor: progress; }
.notice { font-size: 12px; color: var(--bad); }
.notice.ok { color: var(--ok); }
.back { font: 500 12px var(--mono); text-decoration: none; }
.detail { display: grid; gap: 16px; padding-top: 12px; }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; min-width: 0; }
.dhead { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; padding: 16px 18px; }
.dhead h2 { margin: 2px 0 4px; font: 600 18px var(--mono); overflow-wrap: anywhere; }
.actions { display: grid; gap: 4px; justify-items: end; align-content: start; }
.strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); border-top: 1px solid var(--line); }
.strip > div { padding: 10px 18px; display: grid; gap: 4px; align-content: start; justify-items: start; border-right: 1px solid var(--line); min-width: 0; }
.strip > div > * { max-width: 100%; }
.strip .ctx { justify-self: stretch; }
.strip > div:last-child { border-right: 0; }
.label { font: 500 11px var(--mono); letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); }
.cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
.col { display: grid; gap: 16px; min-width: 0; }
section.panel { padding: 12px 16px 14px; display: grid; gap: 8px; }
section.panel h3 { margin: 0; display: flex; justify-content: space-between; gap: 8px; font: 600 12px var(--mono); letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); }
section.panel h3 span { text-transform: none; letter-spacing: 0; font-weight: 500; }
.items { list-style: none; margin: 0; padding: 0; display: grid; }
.items > li { border-top: 1px solid var(--line); padding: 7px 0; display: grid; gap: 3px; min-width: 0; }
.items > li:first-child { border-top: 0; }
details > summary { cursor: pointer; list-style: none; display: grid; grid-template-columns: 18px 1fr auto; gap: 6px; align-items: start; }
details > summary::-webkit-details-marker { display: none; }
details > .more { padding: 4px 0 2px 24px; display: grid; gap: 4px; font-size: 13px; }
details.fold { border-top: 1px solid var(--line); }
details.fold > summary { display: flex; gap: 6px; align-items: center; padding: 7px 0; font: 500 12px var(--mono); color: var(--muted); }
details.fold > summary::before { content: "▸"; width: 18px; flex: none; }
details.fold[open] > summary::before { content: "▾"; }
details.fold > summary:hover { color: var(--ink); }
details.fold > .items > li:first-child { border-top: 1px solid var(--line); }
details.fold > .label { padding-top: 6px; }
button.usage { font: 600 14px var(--mono); font-variant-numeric: tabular-nums; color: var(--accent); background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 0 8px; cursor: pointer; }
button.usage:hover { border-color: var(--accent); }
dialog.modal.narrow { width: min(440px, calc(100vw - 32px)); }
.modal-body .kv { padding: 14px 18px; column-gap: 0; }
.modal-body .kv dd { padding-left: 14px; }
.modal-body .kv dt.total, .modal-body .kv dd.total { border-top: 1px solid var(--line); padding-top: 6px; font-weight: 600; color: var(--ink); }
.glyph { font-family: var(--mono); }
.done { color: var(--muted); text-decoration: line-through; }
.new { font: 600 11px var(--mono); color: var(--warn); white-space: nowrap; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 14px; margin: 0; font-size: 13px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
@media (max-width: 760px) { .cols { grid-template-columns: minmax(0, 1fr); } .actions { justify-items: start; } }
.t-accent { color: var(--accent); }
.t-muted, .t-dim { color: var(--muted); }
.t-dim { opacity: 0.75; }
.t-success { color: var(--ok); }
.t-warning { color: var(--warn); }
.t-error { color: var(--bad); }
.b { font-weight: 600; }
.badge { flex: none; max-width: 28ch; font: 600 11px var(--mono); padding: 1px 8px; border-radius: 999px; background: var(--wire); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.badge.t-accent { background: var(--accent-soft); }
.badge.t-success { background: var(--ok-soft); }
.badge.t-warning { background: var(--warn-soft); }
.badge.t-error { background: var(--bad-soft); }
.sums { display: grid; gap: 1px; font-size: 12px; min-width: 0; }
.sums .sum { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sums .sum > * { margin-right: 8px; }
.sum { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; min-width: 0; }
.sumtitle { font: 600 11px var(--mono); letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); }
.chip-count { font: 500 12px var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
.sumstrip > div { justify-items: stretch; }
.sumstrip .sum { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
.sum .active { font-size: 12px; }
.tabs { display: flex; flex-wrap: wrap; gap: 6px; }
.item { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 6px; align-items: start; }
.mark { color: var(--warn); font-size: 10px; line-height: 21px; }
.mark.chev { color: var(--muted); font-size: 12px; }
details > summary .chev::before { content: "▸"; }
details[open] > summary .chev::before { content: "▾"; }
.notice-line { font-size: 12px; color: var(--muted); }
.lead { margin-right: 1ch; }
.right { flex: none; max-width: 45%; }
section.panel.idle h3 { opacity: 0.7; }
section.panel.failed { border-color: var(--bad); }
.content { display: grid; gap: 6px; min-width: 0; }
.content h4 { margin: 6px 0 0; font: 600 11px var(--mono); letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); }
.content h4:first-child { margin-top: 0; }
.content p { margin: 0; }
.content pre.preview { padding: 8px 10px; max-height: 360px; overflow: auto; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; }
.fields { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 12px; margin: 0; font-size: 13px; }
.fields dt { color: var(--muted); }
.fields dd { margin: 0; min-width: 0; }
.bullets { margin: 0; padding-left: 18px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

const SCRIPT = `
const main = document.querySelector("main");
const conn = document.querySelector(".conn");
const count = document.querySelector(".count");
const token = document.querySelector('meta[name="dashboard-token"]').content;
let state = { home: "", sessions: [] };
let connected = false;
let rendered = "";
const expanded = new Set();
const notices = new Map();
const busy = new Set();
/** Explorer details loaded through their view's loadDetail action, by session, view and item. */
const details = new Map();
/** The tab each explorer shows, by session and view. */
const tabs = new Map();
const filterInput = document.getElementById("filter");
const notifyButton = document.getElementById("notify");
const stored = (key) => { try { return localStorage.getItem(key) || ""; } catch { return ""; } };
const store = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
let filter = stored("dashboard:filter");
let notifyOn = stored("dashboard:notify") === "on" && "Notification" in window && Notification.permission === "granted";

const SESSION_VIEW = "system.session";
const ORDER = { waiting: 0, tool: 1, working: 1, compacting: 1, idle: 2 };
const ICONS = { pending: "○", active: "◐", done: "✓", blocked: "⊘", queued: "…", waiting: "◇", failed: "✗", stopped: "■" };
const TONES = ["accent", "muted", "dim", "success", "warning", "error"];
/** Rows a widget or explorer shows before the rest fold away. */
const SHOWN = 12;
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};
const list = (value) => Array.isArray(value) ? value : [];
const tilde = (path) => state.home && (path === state.home || path.startsWith(state.home + "/")) ? "~" + path.slice(state.home.length) : path;
const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return s + "s";
  const m = Math.round(s / 60);
  return m < 60 ? m + "m" : Math.floor(m / 60) + "h " + (m % 60) + "m";
};
const duration = (ms) => ms < 1000 ? "<1s" : ago(Date.now() - ms);
const tokens = (n) => n >= 1e6 ? +(n / 1e6).toFixed(1) + "M" : n >= 1000 ? Math.round(n / 1000) + "k" : String(Math.round(n));
// pi-surface's count formatters: formatSummaryCount(count) is a summary count's display text.
${FORMATTERS}
const money = (n) => "$" + (n >= 100 ? Math.round(n) : n.toFixed(2));
const toneClass = (tone) => TONES.includes(tone) ? " t-" + tone : "";

// One session record is the hub's latest complete snapshot of it: an id, host
// metadata (pid, the terminal Focus brings forward) and its views. Nothing
// here knows an extension; each view kind has one renderer below.
const viewsOf = (record) => list(record.views);
const ofKind = (record, kind) => viewsOf(record).filter((entry) => entry.kind === kind);
const sessionEntry = (record) => {
  const entries = ofKind(record, "session");
  return entries.find((entry) => entry.id === SESSION_VIEW) || entries[0];
};
/** The core session model, or null when system insights is missing or failed. */
const core = (record) => { const entry = sessionEntry(record); return entry && entry.model ? entry.model : null; };
const live = (record) => !record.disconnected;
const terminalOf = (record) => live(record) && record.host && record.host.terminal ? record.host.terminal : null;
const pidOf = (record) => record.host && record.host.pid ? record.host.pid : null;
const title = (record) => {
  const session = core(record);
  if (session) return session.name || "untitled …" + session.sessionId.slice(-6);
  return "session " + (pidOf(record) || record.id);
};
const named = (record) => { const session = core(record); return !!(session && session.name); };
const cwdOf = (record) => { const session = core(record); return session ? session.cwd : ""; };
const statusOf = (record) => { const session = core(record); return session ? session.status : null; };
const statusKind = (record) => !live(record) ? "idle" : statusOf(record) ? statusOf(record).kind : "unknown";
const statusLabel = (record) => {
  if (!live(record)) return "restarting";
  const status = statusOf(record);
  if (!status) return "status unknown";
  return status.kind === "tool" ? "tool: " + status.tool : status.kind;
};
const questionnaires = (record) => live(record)
  ? ofKind(record, "form").flatMap((entry) => entry.model ? list(entry.model.questionnaires) : [])
  : [];
/** Profiles summaries carry, such as the main agent's, as display text. */
const profiles = (record) => ofKind(record, "summary").flatMap((entry) => entry.model && entry.model.profile ? [entry.model.profile.label || entry.model.profile.name] : []);
const pill = (kind, text) => el("span", "pill " + kind, text);

/** Elapsed time since a clock started, as mm:ss or h:mm:ss. */
function clock(since) {
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const two = (n) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  return (h ? h + ":" + two(Math.floor(s / 60) % 60) : two(Math.floor(s / 60))) + ":" + two(s % 60);
}

// Text models: spans, lines, titles, badges and detail blocks. Text is
// untrusted and always set through textContent; tones become classes.
function spanText(value) {
  if (typeof value === "string") return value;
  if (value.live && typeof value.since === "number") return clock(value.since);
  return value.text || (value.icon ? ICONS[value.icon] || "" : "");
}
function span(value) {
  if (typeof value === "string") return document.createTextNode(value);
  return el("span", (toneClass(value.tone) + (value.bold ? " b" : "") + (value.icon ? " glyph" : "")).trim(), spanText(value));
}
const spans = (value) => Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
function line(value, className) {
  const node = el("span", className);
  for (const part of spans(value)) node.append(span(part));
  return node;
}
const lineText = (value) => spans(value).map(spanText).join("");
// A title's icon is a terminal glyph (a Nerd Font codepoint), so the page shows its words only.
const titleText = (value) => typeof value === "string" ? value : value.label + (value.detail ? " / " + value.detail : "");
const badge = (value) => el("span", "badge" + toneClass(value.tone), value.text);

function content(value) {
  const wrap = el("div", "content");
  if (typeof value === "string") { if (value) wrap.append(el("p", "wrap", value)); return wrap; }
  for (const block of list(value)) {
    if ("heading" in block) wrap.append(el("h4", "", block.heading));
    else if ("fields" in block) {
      const dl = el("dl", "fields");
      for (const [label, field] of list(block.fields)) {
        const dd = el("dd");
        dd.append(line(field, "wrap"));
        dl.append(el("dt", "", label), dd);
      }
      wrap.append(dl);
    } else if ("text" in block) wrap.append(el("p", "wrap" + toneClass(block.tone), block.text));
    else if ("bullets" in block) {
      const ul = el("ul", "bullets");
      for (const text of list(block.bullets)) ul.append(el("li", "wrap", text));
      wrap.append(ul);
    } else if ("lines" in block) {
      const pre = el("pre", "preview");
      const first = block.numbered === true ? 1 : typeof block.numbered === "number" ? block.numbered : null;
      list(block.lines).forEach((text, index) => {
        if (first !== null) pre.append(el("span", "ln", first + index));
        pre.append(text, "\\n");
      });
      wrap.append(pre);
    }
  }
  return wrap;
}

function meter(context) {
  const wrap = el("div", "ctx");
  const bar = el("div", "meter");
  const percent = context && context.percent !== null ? Math.round(context.percent) : null;
  if (percent !== null) {
    if (percent >= 80) bar.classList.add("hot");
    const fill = el("i");
    fill.style.width = Math.min(100, percent) + "%";
    bar.append(fill);
  }
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", percent === null ? "Context usage unknown" : "Context " + percent + "% used");
  const used = context
    ? (context.tokens === null ? "?" : tokens(context.tokens)) + " / " + tokens(context.window) + (percent === null ? "" : " · " + percent + "%")
    : "context unknown";
  wrap.append(bar, el("span", "mono muted num", used));
  return wrap;
}

/** A request to one session, answered to this page only. */
async function ask(record, path, payload) {
  let response;
  const headers = { "X-Dashboard-Token": token };
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  try {
    response = await fetch("/api/sessions/" + encodeURIComponent(record.id) + "/" + path, {
      method: "POST", headers, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  } catch {
    throw new Error("The dashboard is not reachable.");
  }
  const body = await response.json().catch(() => ({}));
  if (!body.ok) throw new Error(body.error || "Request failed (" + response.status + ").");
  return body.data;
}

/** Runs an action a view references, with the reference's arguments plus the call's own. */
function act(record, ref, extra) {
  if (!live(record)) return Promise.reject(new Error("That session is restarting; try again in a moment."));
  const args = { ...(ref.args || {}), ...(extra || {}) };
  return ask(record, "actions", { action: ref.action, ...(Object.keys(args).length ? { args } : {}) });
}

function flash(id, notice) {
  notices.set(id, notice);
  setTimeout(() => { if (notices.get(id) === notice) { notices.delete(id); render(true); } }, notice.ok ? 3000 : 8000);
}

async function focusSession(record) {
  const terminal = terminalOf(record);
  busy.add(record.id);
  notices.delete(record.id);
  render(true);
  let notice;
  try {
    await ask(record, "focus");
    notice = { ok: true, text: "Focused in " + terminal.label };
  } catch (error) {
    notice = { ok: false, text: error.message };
  }
  busy.delete(record.id);
  flash(record.id, notice);
  render(true);
}

function focusButton(record, solid) {
  const terminal = terminalOf(record);
  if (!terminal) return null;
  const button = el("button", "focus" + (solid ? " solid" : ""), busy.has(record.id) ? "Focusing…" : "Focus");
  button.type = "button";
  button.disabled = busy.has(record.id);
  button.title = "Bring this session's " + terminal.label + " pane to the front";
  button.dataset.key = "focus:" + record.id + (solid ? ":detail" : "");
  button.addEventListener("click", (event) => { event.stopPropagation(); focusSession(record); });
  return button;
}

function noticeFor(record) {
  const notice = notices.get(record.id);
  if (!notice) return null;
  const node = el("span", "notice" + (notice.ok ? " ok" : ""), notice.text);
  node.setAttribute("role", "status");
  return node;
}

// summary: counts as toned chips, the active item and the producer's profile.
function summaryCounts(model, compact) {
  return list(model.counts).filter((item) => item.value > 0 && (!compact || (item.tone !== "muted" && item.tone !== "dim")));
}
function summaryView(entry, compact) {
  const node = el("span", "sum");
  node.append(el("span", "sumtitle", entry.title));
  if (!entry.model) { node.append(el("span", "bad", compact ? "unavailable" : entry.error)); return node; }
  const counts = summaryCounts(entry.model, compact);
  for (const item of counts) node.append(el("span", "chip-count" + toneClass(item.tone), formatSummaryCount(item)));
  if (!counts.length && !compact) node.append(el("span", "muted", "nothing yet"));
  if (!compact && entry.model.active) node.append(el("span", "active wrap", "▸ " + entry.model.active.label));
  if (!compact && entry.model.profile) {
    const profile = entry.model.profile;
    node.append(el("span", "muted wrap", "profile " + (profile.label || profile.name) + (profile.description ? " · " + profile.description : "")));
  }
  return node;
}

// session (index card): the core session view, or what is known without it.
function card(record) {
  const asks = questionnaires(record);
  const status = statusOf(record);
  const waiting = live(record) && ((status && status.kind === "waiting") || asks.length > 0);
  const node = el("article", "card" + (waiting ? " attn" : "") + (live(record) ? "" : " restarting"));
  const session = core(record);
  node.title = [session ? "session " + session.sessionId : null, pidOf(record) ? "pid " + pidOf(record) : null].filter(Boolean).join(" · ");
  node.addEventListener("click", () => { location.hash = encodeURIComponent(record.id); });
  const head = el("div", "row");
  const name = el("h3", "name" + (named(record) ? "" : " untitled"));
  const link = el("a", "", title(record));
  link.href = "#" + encodeURIComponent(record.id);
  link.dataset.key = "open:" + record.id;
  name.append(link);
  head.append(name, pill(statusKind(record), statusLabel(record)));
  node.append(head);
  if (asks.length) {
    const row = el("div", "row");
    row.append(el("span", "clip", "Asks: " + asks[0].questions[0].question), answerButton(record, asks[0], false));
    node.append(row);
  } else if (waiting && status.title) node.append(el("span", "clip", status.title));
  for (const profile of profiles(record)) node.append(el("span", "clip", "agent · " + profile));
  if (session) {
    node.append(el("span", "mono muted clip", [session.model ? session.model.id : "no model", session.thinking].filter(Boolean).join(" · ")));
    node.append(meter(session.context));
  } else {
    const entry = sessionEntry(record);
    node.append(el("span", "muted clip", entry && entry.error ? "Session information failed: " + entry.error : "No session information; is pi-system-insights loaded?"));
  }
  const sums = el("div", "sums");
  for (const entry of ofKind(record, "summary")) {
    if (entry.model && !summaryCounts(entry.model, true).length) continue;
    sums.append(summaryView(entry, true));
  }
  if (sums.childElementCount) node.append(sums);
  const foot = el("div", "row");
  foot.append(el("span", "mono muted clip", [session ? "up " + ago(session.startedAt) : null, statusLabel(record) + (live(record) && status ? " " + ago(status.since) : "")].filter(Boolean).join(" · ")));
  const button = focusButton(record, false);
  if (button) foot.append(button);
  node.append(foot);
  const notice = noticeFor(record);
  if (notice) node.append(notice);
  return node;
}

/** Every whitespace-separated term must appear in the name, directory, profile, model or status. */
function matches(record) {
  const terms = filter.toLowerCase().split(/\\s+/).filter(Boolean);
  if (!terms.length) return true;
  const session = core(record);
  const text = [title(record), tilde(cwdOf(record)), ...profiles(record), session && session.model && session.model.id, statusLabel(record)].filter(Boolean).join(" ").toLowerCase();
  return terms.every((term) => text.includes(term));
}

function renderIndex() {
  if (!state.sessions.length) {
    main.append(el("p", "empty", connected
      ? "No interactive Pi sessions are running."
      : "Not connected. The dashboard stops when the last Pi session exits; run /dashboard in Pi to start it again."));
    return;
  }
  const records = state.sessions.filter(matches);
  if (!records.length) {
    main.append(el("p", "empty", "No sessions match “" + filter.trim() + "”."));
    return;
  }
  const groups = new Map();
  for (const record of records) {
    const cwd = cwdOf(record);
    if (!groups.has(cwd)) groups.set(cwd, []);
    groups.get(cwd).push(record);
  }
  for (const [cwd, items] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    main.append(el("h2", "group", cwd ? tilde(cwd) : "directory unknown"));
    const grid = el("div", "grid");
    const rank = (record) => live(record) ? ORDER[statusKind(record)] ?? 2 : 3;
    const started = (record) => core(record) ? core(record).startedAt : 0;
    items.sort((a, b) => rank(a) - rank(b) || (named(a) ? title(a) : "").localeCompare(named(b) ? title(b) : "") || started(a) - started(b));
    for (const record of items) grid.append(card(record));
    main.append(grid);
  }
}

function panel(name, summary, className) {
  const node = el("section", "panel" + (className ? " " + className : ""));
  const head = el("h3", "", name);
  if (summary) head.append(el("span", "", summary));
  node.append(head);
  return node;
}

function kv(rows) {
  const dl = el("dl", "kv");
  for (const [key, value] of rows) dl.append(el("dt", "", key), el("dd", "", value));
  return dl;
}

/**
 * Rows past the first few behind one expandable line, so a long list shows
 * what comes first; whether it is open survives live re-renders.
 */
function fold(node, key, label, ...children) {
  const details = el("details", "fold");
  details.open = expanded.has(key);
  details.addEventListener("toggle", () => { if (details.open) expanded.add(key); else expanded.delete(key); });
  const summary = el("summary", "", label);
  summary.dataset.key = key;
  details.append(summary, ...children);
  node.append(details);
}

/** Appends \`items\` as rows: the first few in a list, the rest folded. */
function rows(node, key, items, row, noun) {
  const ul = el("ul", "items");
  for (const item of items.slice(0, SHOWN)) ul.append(row(item));
  node.append(ul);
  const rest = items.slice(SHOWN);
  if (!rest.length) return;
  const more = el("ul", "items");
  for (const item of rest) more.append(row(item));
  fold(node, key, rest.length + " more " + (noun || "rows"), more);
}

/** A failed view: its title and why it is missing. */
function failedPanel(entry) {
  const node = panel(entry.title, "unavailable", "failed");
  node.append(el("span", "bad wrap", entry.error));
  return node;
}

// widget: a heading with rows, as the terminal draws it above the editor.
function widgetPanel(record, entry) {
  const model = entry.model;
  const meta = list(model.meta);
  const node = panel(titleText(model.title), meta.length ? lineText(meta[0]) : "", model.active === false ? "idle" : "");
  const items = list(model.rows);
  if (!items.length) { node.append(el("span", "muted", model.emptyText || "Nothing to show.")); return node; }
  rows(node, "fold:" + record.id + ":" + entry.id, items, (item) => {
    const li = el("li");
    const row = el("div", "row");
    const left = el("span", "clip");
    if (item.lead !== undefined) left.append(line(item.lead, "mono lead"));
    left.append(line(item.left));
    row.append(left);
    const right = list(item.right);
    if (right.length) row.append(line(right[0], "mono muted clip right"));
    li.append(row);
    return li;
  }, "");
  return node;
}

// explorer: a list of items that open into detail, with tabs and marks.
function explorerPanel(record, entry) {
  const model = entry.model;
  const items = list(model.items);
  const byId = new Map(items.map((item) => [item.id, item]));
  const viewKey = record.id + ":" + entry.id;
  const noun = list(model.noun).length === 2 ? model.noun : ["item", "items"];
  const marker = model.marker;
  const marked = marker ? items.filter((item) => item.marked) : [];
  const status = [items.length + " " + (items.length === 1 ? noun[0] : noun[1]), marked.length ? marked.length + " " + marker.label : ""].filter(Boolean).join(" · ");
  const node = panel(titleText(model.title), status);
  for (const notice of list(model.notices)) node.append(line(notice, "notice-line wrap"));
  const tabList = list(model.tabs);
  let shown = items;
  let empty = model.emptyText || "No " + noun[1] + ".";
  if (tabList.length) {
    let index = tabs.has(viewKey) ? tabs.get(viewKey) : model.initialTab || 0;
    if (!tabList[index]) index = 0;
    const tab = tabList[index];
    shown = list(tab.ids).flatMap((id) => byId.has(id) ? [byId.get(id)] : []);
    if (tab.emptyText) empty = tab.emptyText;
    if (tabList.length > 1) {
      const bar = el("div", "tabs");
      tabList.forEach((candidate, at) => {
        const button = el("button", "toggle", candidate.label);
        button.type = "button";
        button.setAttribute("aria-pressed", String(at === index));
        button.dataset.key = "tab:" + viewKey + ":" + at;
        button.addEventListener("click", () => { tabs.set(viewKey, at); render(true); });
        bar.append(button);
      });
      node.append(bar);
    }
  }
  if (marker && marker.onClear && marked.length && live(record)) {
    const clear = el("button", "small", marker.clearAction || "clear marks");
    clear.type = "button";
    clear.dataset.key = "clear:" + viewKey;
    clear.addEventListener("click", () => {
      act(record, marker.onClear, { ids: marked.map((item) => item.id) }).catch((error) => { flash(record.id, { ok: false, text: error.message }); render(true); });
    });
    const row = el("div", "row");
    row.append(el("span", "muted", marked.length + " " + marker.label), clear);
    node.append(row);
  }
  if (!shown.length) { node.append(el("span", "muted", empty)); return node; }
  rows(node, "fold:" + viewKey, shown, (item) => explorerItem(record, entry, item), noun[1]);
  return node;
}

function explorerItem(record, entry, item) {
  const model = entry.model;
  const li = el("li");
  const key = record.id + ":" + entry.id + ":" + item.id;
  const loads = !!model.loadDetail && live(record);
  const opens = loads || item.detail !== undefined;
  const head = (container) => {
    const marked = model.marker && item.marked;
    container.append(el("span", marked ? "mark" : opens ? "mark chev" : "mark", marked ? "●" : ""), line(item.label, "ilabel wrap"), item.badge ? badge(item.badge) : el("span"));
  };
  if (!opens) {
    const row = el("div", "item");
    head(row);
    li.append(row);
    return li;
  }
  const box = el("details");
  box.open = expanded.has(key);
  box.addEventListener("toggle", () => {
    // Restoring an open item on a re-render fires toggle too; only a change by the user acts.
    if (box.open === expanded.has(key)) return;
    if (!box.open) { expanded.delete(key); return; }
    expanded.add(key);
    openItem(record, entry, item, key);
  });
  const summary = el("summary", "item");
  summary.dataset.key = "item:" + key;
  head(summary);
  box.append(summary);
  const more = el("div", "more");
  const loaded = details.get(key);
  if (loads && loaded && loaded.content !== undefined) more.append(content(loaded.content));
  else if (loads && loaded && loaded.error) more.append(el("span", "bad wrap", "Couldn't load: " + loaded.error));
  else if (item.detail !== undefined && (!loads || !loaded || !loaded.loading)) more.append(content(item.detail));
  if (loaded && loaded.loading) more.append(el("span", "muted", "Loading…"));
  box.append(more);
  li.append(box);
  return li;
}

/** Opening an item runs what the terminal's explorer runs: onOpen, clearing its mark, and loadDetail. */
async function openItem(record, entry, item, key) {
  const model = entry.model;
  if (!live(record)) return;
  const quiet = (promise) => promise.catch(() => {});
  if (model.onOpen) quiet(act(record, model.onOpen, { id: item.id }));
  if (model.marker && model.marker.onClear && item.marked) quiet(act(record, model.marker.onClear, { ids: [item.id] }));
  if (!model.loadDetail) return;
  const previous = details.get(key);
  details.set(key, { ...(previous || {}), loading: true });
  render(true);
  let next;
  try { next = { content: await act(record, model.loadDetail, { id: item.id }) }; } catch (error) { next = { error: error.message }; }
  details.set(key, next);
  render(true);
}

// detail: a standalone detail view.
function detailPanel(entry) {
  const node = panel(titleText(entry.model.title), "");
  node.append(content(entry.model.content));
  return node;
}

// session (detail page): recent tool calls.
function activityPanel(session) {
  const items = list(session.activity);
  const node = panel("Recent activity", items.length ? items.length + " calls" : "");
  if (!items.length) { node.append(el("span", "muted", "No tool calls yet.")); return node; }
  const ul = el("ul", "items");
  for (const item of items) {
    const li = el("li");
    const row = el("div", "row");
    const what = el("span", "clip");
    what.append(el("span", "mono", item.tool), el("span", "mono muted", item.summary ? "  " + item.summary : ""));
    const outcome = item.live ? "running" : item.error ? "failed" : item.durationMs !== undefined ? duration(item.durationMs) : "";
    row.append(what, el("span", "mono num " + (item.error ? "bad" : "muted"), [outcome, ago(item.at) + " ago"].filter(Boolean).join(" · ")));
    li.append(row);
    ul.append(li);
  }
  node.append(ul);
  return node;
}

// form: open questionnaires, answered in a dialog outside <main>, so live
// re-renders leave it alone. Each questionnaire's form is kept: a draft
// survives closing and reopening it.
const answerModal = document.getElementById("answer");
const answerForms = new Map();
let answering;

function answerButton(record, questionnaire, solid) {
  const button = el("button", "focus" + (solid ? " solid" : ""), "Answer");
  button.type = "button";
  button.dataset.key = "answer:" + record.id + ":" + questionnaire.id + (solid ? ":detail" : "");
  button.addEventListener("click", (event) => { event.stopPropagation(); openAnswer(record, questionnaire, button.dataset.key); });
  return button;
}

function formPanel(record, items) {
  const node = panel("Waiting on you", items.length === 1 ? "1 questionnaire" : items.length + " questionnaires", "asks");
  const ul = el("ul", "items");
  for (const questionnaire of items) {
    const li = el("li");
    const row = el("div", "row");
    const what = el("div", "qsummary");
    if (questionnaire.title) what.append(el("span", "b wrap", questionnaire.title));
    for (const question of list(questionnaire.questions)) {
      const qline = el("div", "qline");
      if (question.header) qline.append(el("span", "chip", question.header));
      qline.append(el("span", "wrap", question.question));
      what.append(qline);
    }
    row.append(what, answerButton(record, questionnaire, true));
    li.append(row, el("span", "mono muted", (questionnaire.openedAt ? "asked " + ago(questionnaire.openedAt) + " ago · " : "") + "the terminal can answer too; the first answer wins"));
    ul.append(li);
  }
  node.append(ul);
  return node;
}

function buildAnswerForm(record, questionnaire, key) {
  const form = el("form", "answer-form");
  form.noValidate = true;
  const head = el("div", "modal-head");
  const heading = el("div", "modal-title");
  const total = questionnaire.questions.length;
  const name = el("h2", "", questionnaire.title || (total === 1 ? "Question from " : total + " questions from ") + title(record));
  name.id = "answer-title";
  heading.append(name, el("span", "mono muted wrap", [cwdOf(record) ? tilde(cwdOf(record)) : null, questionnaire.openedAt ? "asked " + ago(questionnaire.openedAt) + " ago" : null].filter(Boolean).join(" · ")));
  const close = el("button", "close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", () => answerModal.close());
  head.append(heading, close);
  const banner = el("div", "closed-banner", "This questionnaire was answered or closed in the terminal.");
  banner.hidden = true;
  const body = el("div", "qform");
  const fields = questionnaire.questions.map((question, questionIndex) => {
    const block = el("fieldset", "qblock");
    const legend = el("legend", "qlegend");
    if (question.header) legend.append(el("span", "chip", question.header));
    legend.append(el("span", "qtext", question.question));
    block.append(legend);
    if (question.multiSelect) block.append(el("span", "mono muted", "Pick any that apply."));
    const group = "q" + questionIndex;
    const inputs = list(question.options).map((option, optionIndex) => {
      const label = el("label", "choice");
      const input = el("input");
      input.type = question.multiSelect ? "checkbox" : "radio";
      input.name = group;
      input.value = String(optionIndex);
      label.append(input, el("span", "", option.label));
      if (option.description) label.append(el("small", "", option.description));
      block.append(label);
      return input;
    });
    let other;
    if (!question.multiSelect && inputs.length) {
      const label = el("label", "choice");
      other = el("input");
      other.type = "radio";
      other.name = group;
      other.value = "text";
      label.append(other, el("span", "", "Type something"));
      block.append(label);
    }
    const text = el("textarea", "answer");
    text.rows = 2;
    text.placeholder = question.multiSelect ? "Anything else, in your own words (optional)" : "Your own answer";
    text.setAttribute("aria-label", "Your own answer: " + question.question);
    if (other) text.addEventListener("input", () => { if (text.value.trim()) other.checked = true; });
    block.append(text);
    body.append(block);
    return { question, inputs, other, text };
  });
  const noteLabel = el("label", "note");
  noteLabel.append(el("span", "label", "Note (optional)"));
  const note = el("textarea", "answer");
  note.rows = 2;
  note.placeholder = "Context for the whole answer";
  noteLabel.append(note);
  body.append(noteLabel);
  const actions = el("div", "modal-actions");
  const error = el("span", "bad");
  error.setAttribute("role", "alert");
  const decline = el("button", "secondary", "Decline");
  decline.type = "button";
  decline.title = "Tell the agent you declined, as Esc does in the terminal";
  const send = el("button", "primary", "Send answer");
  send.type = "submit";
  actions.append(error, decline, send);
  form.append(head, banner, body, actions);

  // Mirrors what the terminal dialog accepts: one option or typed text per
  // single-select question; options and/or text for multi-select.
  const collect = () => {
    const answers = [];
    fields.forEach((field, questionIndex) => {
      const text = field.text.value.trim();
      const picked = field.inputs.filter((input) => input.checked).map((input) => Number(input.value));
      const label = total === 1 ? "the question" : "question " + (questionIndex + 1);
      if (field.question.multiSelect) {
        if (!picked.length && !text) throw new Error("Answer " + label + ": pick at least one option or type an answer.");
        answers.push({ questionIndex, ...(picked.length ? { optionIndexes: picked } : {}), ...(text ? { text } : {}) });
      } else if ((field.other && field.other.checked) || (!picked.length && text)) {
        if (!text) throw new Error("Type your answer to " + label + ", or pick an option.");
        answers.push({ questionIndex, text });
      } else if (picked.length) {
        answers.push({ questionIndex, optionIndexes: picked });
      } else {
        throw new Error("Answer " + label + ".");
      }
    });
    const globalNote = note.value.trim();
    return { answers, ...(globalNote ? { globalNote } : {}) };
  };
  /** Runs the questionnaire's own submit or cancel action, as its form references it. */
  const submit = async (ref, extra, done) => {
    error.textContent = "";
    send.disabled = decline.disabled = true;
    try {
      await act(record, ref, extra);
      answerForms.delete(key);
      flash(record.id, { ok: true, text: done });
      answerModal.close();
      render(true);
    } catch (failure) {
      error.textContent = failure.message;
      send.disabled = decline.disabled = form.dataset.closed === "true";
    }
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    let payload;
    try { payload = collect(); } catch (failure) { error.textContent = failure.message; return; }
    submit(questionnaire.submit, payload, "Answer sent");
  });
  decline.addEventListener("click", () => submit(questionnaire.cancel, {}, "Declined the question"));
  form.markClosed = () => {
    form.dataset.closed = "true";
    banner.hidden = false;
    send.disabled = decline.disabled = true;
  };
  return form;
}

function openAnswer(record, questionnaire, returnKey) {
  const key = record.id + ":" + questionnaire.id;
  let form = answerForms.get(key);
  if (!form) {
    form = buildAnswerForm(record, questionnaire, key);
    answerForms.set(key, form);
  }
  answering = { id: questionnaire.id, key, returnKey };
  answerModal.replaceChildren(form);
  if (!answerModal.open) answerModal.showModal();
  checkAnswerStillOpen();
  const first = form.querySelector("input:not(:disabled), textarea");
  if (first) first.focus();
}

/** Marks the open form closed once its questionnaire leaves the live list, and drops drafts for finished ones. */
function checkAnswerStillOpen() {
  const open = new Set();
  for (const record of state.sessions)
    for (const questionnaire of questionnaires(record)) open.add(record.id + ":" + questionnaire.id);
  for (const key of answerForms.keys()) if (!open.has(key) && (!answering || answering.key !== key)) answerForms.delete(key);
  if (answering && !open.has(answering.key)) {
    const form = answerForms.get(answering.key);
    if (form && form.markClosed) form.markClosed();
  }
}

answerModal.addEventListener("click", (event) => { if (event.target === answerModal) answerModal.close(); });
answerModal.addEventListener("close", () => {
  const back = answering && [...main.querySelectorAll("[data-key]")].find((node) => node.dataset.key === answering.returnKey);
  answering = undefined;
  answerModal.replaceChildren();
  if (back) back.focus();
});

// Usage opens from the strip in its own dialog outside <main>; its body is
// refilled on each update while open, so the numbers stay live.
const usageModal = document.getElementById("usage");
let usageFor = "";
let usageBody;

function usageButton(record, usage) {
  const button = el("button", "usage", money(usage.cost));
  button.type = "button";
  button.title = "Token usage and cost for this session";
  button.setAttribute("aria-haspopup", "dialog");
  button.dataset.key = "usage:" + record.id;
  button.addEventListener("click", () => openUsage(record));
  return button;
}

function openUsage(record) {
  usageFor = record.id;
  const head = el("div", "modal-head");
  const heading = el("div", "modal-title");
  const name = el("h2", "", "Usage");
  name.id = "usage-title";
  heading.append(name, el("span", "mono muted wrap", title(record) + " · the whole session file, as /session counts it"));
  const close = el("button", "close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close usage");
  close.addEventListener("click", () => usageModal.close());
  head.append(heading, close);
  usageBody = el("div", "modal-body");
  usageModal.replaceChildren(head, usageBody);
  fillUsage();
  if (!usageModal.open) usageModal.showModal();
}

function fillUsage() {
  if (!usageBody) return;
  const record = state.sessions.find((candidate) => candidate.id === usageFor);
  const session = record && core(record);
  const usage = session && session.usage;
  if (!usage) { usageBody.replaceChildren(el("p", "muted pad", record ? "Usage is not known for this session." : "This session is no longer running.")); return; }
  const exact = (n) => Math.round(n).toLocaleString() + " tok";
  const dl = kv([
    ["Input", exact(usage.input)], ["Output", exact(usage.output)],
    ["Cache read", exact(usage.cacheRead)], ["Cache write", exact(usage.cacheWrite)],
  ]);
  dl.append(el("dt", "total", "Total"), el("dd", "total", exact(usage.input + usage.output + usage.cacheRead + usage.cacheWrite)));
  dl.append(el("dt", "", "Cost"), el("dd", "", money(usage.cost)));
  usageBody.replaceChildren(dl);
}

usageModal.addEventListener("click", (event) => { if (event.target === usageModal) usageModal.close(); });
usageModal.addEventListener("close", () => {
  const back = [...main.querySelectorAll("[data-key]")].find((node) => node.dataset.key === "usage:" + usageFor);
  usageFor = "";
  usageBody = undefined;
  usageModal.replaceChildren();
  if (back) back.focus();
});

/** The header: who the session is, the core session strip, and every summary. */
function headPanel(record) {
  const session = core(record);
  const head = el("div", "panel");
  const top = el("div", "dhead");
  const who = el("div");
  who.append(el("h2", named(record) ? "" : "muted", title(record)));
  const meta = [session ? tilde(session.cwd) : null, ...profiles(record).map((profile) => "agent " + profile),
    session ? "session …" + session.sessionId.slice(-8) : null, pidOf(record) ? "pid " + pidOf(record) : null,
    session ? "up " + ago(session.startedAt) : null, session && session.piVersion ? "pi " + session.piVersion : null];
  who.append(el("span", "mono muted wrap", meta.filter(Boolean).join(" · ")));
  if (!live(record)) who.append(el("span", "warn", "Restarting: shown as it last was; nothing here runs until the session is back."));
  const actions = el("div", "actions");
  const button = focusButton(record, true);
  if (button) actions.append(button);
  const notice = noticeFor(record);
  if (notice) actions.append(notice);
  top.append(who, actions);
  head.append(top);
  const strip = el("div", "strip");
  const cell = (label, ...children) => { const div = el("div"); div.append(el("span", "label", label), ...children); return div; };
  if (session) {
    strip.append(
      session.model
        ? cell("Model", el("span", "mono clip", session.model.id), el("span", "mono muted clip", session.model.provider))
        : cell("Model", el("span", "muted", "none")),
      cell("Thinking", el("span", "", session.thinking || "off")),
      cell("Status", pill(statusKind(record), statusLabel(record)), el("span", "mono muted", live(record) ? "for " + ago(session.status.since) : "")),
      cell("Context", meter(session.context)),
      session.usage
        ? cell("Usage", usageButton(record, session.usage), el("span", "mono muted", tokens(session.usage.input + session.usage.output + session.usage.cacheRead + session.usage.cacheWrite) + " tok"))
        : cell("Usage", el("span", "muted", "–")),
    );
    if (live(record) && session.status.kind === "waiting" && session.status.title) strip.append(cell("Waiting on", el("span", "wrap", session.status.title)));
  } else {
    const entry = sessionEntry(record);
    strip.append(cell("Session", el("span", entry && entry.error ? "bad wrap" : "muted wrap",
      entry && entry.error ? "Session information failed: " + entry.error : "No session information; is pi-system-insights loaded?")));
  }
  head.append(strip);
  const summaries = ofKind(record, "summary");
  if (summaries.length) {
    const sums = el("div", "strip sumstrip");
    for (const entry of summaries) { const div = el("div"); div.append(summaryView(entry, false)); sums.append(div); }
    head.append(sums);
  }
  return head;
}

function renderDetail(id) {
  const back = el("a", "back", "← All sessions");
  back.href = "#";
  back.dataset.key = "back";
  const record = state.sessions.find((candidate) => candidate.id === id);
  const wrap = el("div", "detail");
  wrap.append(back);
  if (!record) {
    wrap.append(el("p", "empty", connected ? "This session is no longer running." : "Not connected."));
    main.append(wrap);
    document.title = "pi dashboard";
    return;
  }
  document.title = title(record) + " · pi dashboard";
  wrap.append(headPanel(record));
  const asks = questionnaires(record);
  if (asks.length) wrap.append(formPanel(record, asks));
  for (const entry of ofKind(record, "form")) if (!entry.model) wrap.append(failedPanel(entry));
  const cols = el("div", "cols");
  const left = el("div", "col");
  const right = el("div", "col");
  // Two even columns: what the session is doing now (widgets, recent tool
  // calls), and the records it keeps (explorers and details), each by view id.
  for (const entry of viewsOf(record)) {
    if (entry.kind === "widget") left.append(entry.model ? widgetPanel(record, entry) : failedPanel(entry));
    else if (entry.kind === "explorer") right.append(entry.model ? explorerPanel(record, entry) : failedPanel(entry));
    else if (entry.kind === "detail") right.append(entry.model ? detailPanel(entry) : failedPanel(entry));
  }
  const session = core(record);
  if (session) left.append(activityPanel(session));
  // Without one side's views, split the other side rather than leave half the page empty.
  if (!right.childElementCount && left.childElementCount > 1) right.append(left.lastElementChild);
  if (!left.childElementCount && right.childElementCount > 1) left.append(right.firstElementChild);
  cols.append(left, right);
  wrap.append(cols);
  main.append(wrap);
}

function selected() {
  try { return decodeURIComponent(location.hash.slice(1)); } catch { return ""; }
}

/** Re-renders only when what is on screen changed, keeping keyboard focus across updates. */
function render(force) {
  const id = selected();
  const view = id ? state.sessions.find((record) => record.id === id) || null : state.sessions;
  const key = JSON.stringify([id, connected, filter, view]);
  if (!force && key === rendered) return;
  rendered = key;
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : undefined;
  const total = state.sessions.length;
  const shown = id ? total : state.sessions.filter(matches).length;
  count.textContent = (shown !== total ? shown + " of " : "") + total + (total === 1 ? " session" : " sessions");
  filterInput.hidden = !!id;
  main.replaceChildren();
  if (id) renderDetail(id); else { document.title = "pi dashboard"; renderIndex(); }
  if (focused) {
    const again = [...main.querySelectorAll("[data-key]")].find((node) => node.dataset.key === focused);
    if (again) again.focus();
  }
}

/** Notifies when a session starts waiting on a dialog, or finishes its work, while this page is in the background. */
function announce(before, after) {
  if (!notifyOn || document.hasFocus()) return;
  const previous = new Map(before.map((record) => [record.id, record]));
  for (const record of after) {
    const old = previous.get(record.id);
    if (!old || !live(old) || !live(record)) continue;
    const was = statusOf(old);
    const now = statusOf(record);
    let body;
    if (was && now && now.kind === "waiting" && was.kind !== "waiting") body = "Waiting on you" + (now.title ? ": " + now.title : "");
    else if (was && now && now.kind === "idle" && was.kind !== "idle" && was.kind !== "waiting") body = "Finished; ready for your next prompt";
    // A new questionnaire says what it asks; it replaces the generic waiting note (same tag).
    const seen = new Set(questionnaires(old).map((questionnaire) => questionnaire.id));
    const fresh = questionnaires(record).find((questionnaire) => !seen.has(questionnaire.id));
    if (fresh) body = "Asks: " + fresh.questions[0].question;
    if (!body) continue;
    const note = new Notification(title(record) + (cwdOf(record) ? " · " + tilde(cwdOf(record)) : ""), { body, tag: "dashboard:" + record.id });
    note.onclick = () => { window.focus(); location.hash = encodeURIComponent(record.id); note.close(); };
  }
}

function showNotify() {
  notifyButton.textContent = notifyOn ? "Notifications on" : "Notifications off";
  notifyButton.setAttribute("aria-pressed", String(notifyOn));
}

notifyButton.addEventListener("click", async () => {
  if (!("Notification" in window)) { notifyButton.textContent = "Notifications unavailable"; return; }
  if (notifyOn) { notifyOn = false; store("dashboard:notify", "off"); showNotify(); return; }
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  notifyOn = permission === "granted";
  notifyButton.title = permission === "denied" ? "Notifications are blocked for this page in your browser's settings." : "";
  store("dashboard:notify", notifyOn ? "on" : "off");
  showNotify();
});
showNotify();

filterInput.value = filter;
filterInput.addEventListener("input", () => { filter = filterInput.value; store("dashboard:filter", filter); render(true); });

const events = new EventSource("/events");
events.addEventListener("sessions", (event) => {
  const next = JSON.parse(event.data);
  announce(state.sessions, list(next.sessions));
  state = next;
  render();
  checkAnswerStillOpen();
  fillUsage();
});
events.onopen = () => { connected = true; conn.textContent = "● live"; conn.classList.add("live"); render(); };
// Cards from a lost hub would go stale; the full list returns on reconnect.
events.onerror = () => { connected = false; state = { ...state, sessions: [] }; conn.textContent = "reconnecting…"; conn.classList.remove("live"); render(); };
window.addEventListener("hashchange", () => { render(true); window.scrollTo(0, 0); });
setInterval(() => render(true), 30000);
render(true);
`;

export function renderPage(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="dashboard-token" content="${token.replace(/[^A-Za-z0-9_-]/g, "")}">
<title>pi dashboard</title>
<link rel="icon" href="data:,">
<style>${STYLE}</style>
</head>
<body>
<header><h1><a href="#">pi dashboard</a></h1><input id="filter" type="search" placeholder="Filter sessions" aria-label="Filter sessions" autocomplete="off" spellcheck="false"><span class="count"></span><button id="notify" class="toggle" type="button" aria-pressed="false">Notifications off</button><span class="conn" aria-live="polite">connecting…</span></header>
<main></main>
<dialog id="answer" class="modal" aria-labelledby="answer-title"></dialog>
<dialog id="usage" class="modal narrow" aria-labelledby="usage-title"></dialog>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
