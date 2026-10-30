// The dashboard page: static HTML; all session data arrives over /events and
// is rendered with DOM APIs (textContent), never interpolated as markup.

const STYLE = `
:root {
  --bg: #f3f5f8; --surface: #ffffff; --ink: #18202c; --muted: #5a6577; --line: #d3d9e2; --wire: #e7ebf1;
  --accent: #1f6a86; --accent-soft: #dcedf3; --warn: #9a6408; --warn-soft: #faefd9;
  --violet: #6a4bb0; --violet-soft: #ebe5f7; --ok: #2c7a4b;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) { :root {
  --bg: #11161d; --surface: #182029; --ink: #e4e9f0; --muted: #9aa6b6; --line: #2c3743; --wire: #212b36;
  --accent: #6bb8d4; --accent-soft: #19343f; --warn: #e2b15a; --warn-soft: #3a2c12;
  --violet: #b39cf0; --violet-soft: #2a2242; --ok: #6cc690; color-scheme: dark;
} }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 12px; padding: 10px 20px; background: var(--surface); border-bottom: 1px solid var(--line); }
header h1 { margin: 0; font: 600 15px var(--mono); }
header .count { margin-left: auto; color: var(--muted); font-variant-numeric: tabular-nums; }
.conn { font: 500 12px var(--mono); color: var(--muted); }
.conn.live { color: var(--ok); }
main { max-width: 1280px; margin: 0 auto; padding: 8px 20px 40px; display: grid; gap: 4px; }
h2 { margin: 16px 0 4px; font: 500 12px var(--mono); letter-spacing: 0.05em; color: var(--muted); overflow-wrap: anywhere; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; display: grid; gap: 6px; align-content: start; min-width: 0; }
.card.attn { border-color: var(--warn); box-shadow: inset 3px 0 0 var(--warn); }
.card.restarting { opacity: 0.55; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-width: 0; }
.name { margin: 0; font: 600 14px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.name.untitled { color: var(--muted); font-weight: 500; }
.muted { color: var(--muted); }
.mono { font-family: var(--mono); font-size: 12px; }
.clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pill { display: inline-flex; align-items: center; gap: 6px; flex: none; max-width: 60%; font: 600 11px var(--mono); padding: 1px 8px; border-radius: 999px; background: var(--wire); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pill::before { content: ""; flex: none; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.pill.working, .pill.tool { background: var(--accent-soft); color: var(--accent); }
.pill.waiting { background: var(--warn-soft); color: var(--warn); }
.pill.compacting { background: var(--violet-soft); color: var(--violet); }
.ctx { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
.meter { height: 7px; border-radius: 4px; background: var(--wire); overflow: hidden; }
.meter i { display: block; height: 100%; background: var(--accent); }
.meter.hot i { background: var(--warn); }
.num { font-variant-numeric: tabular-nums; }
.empty { margin: 48px auto; max-width: 42ch; text-align: center; color: var(--muted); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

const SCRIPT = `
const main = document.querySelector("main");
const conn = document.querySelector(".conn");
const count = document.querySelector(".count");
let state = { home: "", sessions: [] };
let connected = false;

const ORDER = { waiting: 0, tool: 1, working: 1, compacting: 1, idle: 2 };
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const tilde = (path) => state.home && (path === state.home || path.startsWith(state.home + "/")) ? "~" + path.slice(state.home.length) : path;
const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return s + "s";
  const m = Math.round(s / 60);
  return m < 60 ? m + "m" : Math.floor(m / 60) + "h " + (m % 60) + "m";
};
const tokens = (n) => n >= 1e6 ? +(n / 1e6).toFixed(1) + "M" : n >= 1000 ? Math.round(n / 1000) + "k" : String(n);
const statusLabel = (session) => {
  if (session.restarting) return "restarting";
  const status = session.status;
  if (status.kind === "tool") return "tool: " + status.tool;
  return status.kind;
};

function card(session) {
  const waiting = !session.restarting && session.status.kind === "waiting";
  const node = el("article", "card" + (waiting ? " attn" : "") + (session.restarting ? " restarting" : ""));
  node.title = "session " + session.sessionId + " · pid " + session.pid;
  const head = el("div", "row");
  head.append(
    el("h3", "name" + (session.name ? "" : " untitled"), session.name || "untitled …" + session.sessionId.slice(-6)),
    el("span", "pill " + (session.restarting ? "idle" : session.status.kind), statusLabel(session)),
  );
  node.append(head);
  if (waiting && session.status.title) node.append(el("span", "clip", session.status.title));
  if (session.agent) node.append(el("span", "clip", "agent · " + session.agent));
  const model = [session.model ? session.model.id : "no model", session.thinking].filter(Boolean).join(" · ");
  node.append(el("span", "mono muted clip", model));
  const ctx = el("div", "ctx");
  const meter = el("div", "meter");
  const percent = session.context && session.context.percent !== null ? Math.round(session.context.percent) : null;
  if (percent !== null) {
    if (percent >= 80) meter.classList.add("hot");
    const fill = el("i");
    fill.style.width = Math.min(100, percent) + "%";
    meter.append(fill);
  }
  meter.setAttribute("role", "img");
  meter.setAttribute("aria-label", percent === null ? "Context usage unknown" : "Context " + percent + "% used");
  const used = session.context
    ? (session.context.tokens === null ? "?" : tokens(session.context.tokens)) + " / " + tokens(session.context.window) + (percent === null ? "" : " · " + percent + "%")
    : "context unknown";
  ctx.append(meter, el("span", "mono muted num", used));
  node.append(ctx);
  node.append(el("span", "mono muted", "up " + ago(session.startedAt) + " · " + statusLabel(session) + " " + ago(session.status.since)));
  return node;
}

function render() {
  const sessions = state.sessions;
  count.textContent = sessions.length === 1 ? "1 session" : sessions.length + " sessions";
  main.replaceChildren();
  if (!connected && !sessions.length) {
    main.append(el("p", "empty", "Not connected. The dashboard stops when the last Pi session exits; run /dashboard in Pi to start it again."));
    return;
  }
  if (!sessions.length) {
    main.append(el("p", "empty", "No interactive Pi sessions are running."));
    return;
  }
  const groups = new Map();
  for (const session of sessions) {
    if (!groups.has(session.cwd)) groups.set(session.cwd, []);
    groups.get(session.cwd).push(session);
  }
  for (const [cwd, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    main.append(el("h2", "", tilde(cwd)));
    const grid = el("div", "grid");
    const rank = (s) => s.restarting ? 3 : ORDER[s.status.kind] ?? 2;
    list.sort((a, b) => rank(a) - rank(b) || (a.name || "").localeCompare(b.name || "") || a.startedAt - b.startedAt);
    for (const session of list) grid.append(card(session));
    main.append(grid);
  }
}

const events = new EventSource("/events");
events.addEventListener("sessions", (event) => { state = JSON.parse(event.data); render(); });
events.onopen = () => { connected = true; conn.textContent = "● live"; conn.classList.add("live"); };
// Cards from a lost hub would go stale; the full list returns on reconnect.
events.onerror = () => { connected = false; state = { ...state, sessions: [] }; conn.textContent = "reconnecting…"; conn.classList.remove("live"); render(); };
setInterval(render, 30000);
render();
`;

export function renderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi dashboard</title>
<link rel="icon" href="data:,">
<style>${STYLE}</style>
</head>
<body>
<header><h1>pi dashboard</h1><span class="count"></span><span class="conn" aria-live="polite">connecting…</span></header>
<main></main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
