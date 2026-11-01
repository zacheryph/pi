// The dashboard page: static HTML; all session data arrives over /events and
// is rendered with DOM APIs (textContent), never interpolated as markup.

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
.cols { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 16px; align-items: start; }
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
.glyph { font-family: var(--mono); }
.done { color: var(--muted); text-decoration: line-through; }
.new { font: 600 11px var(--mono); color: var(--warn); white-space: nowrap; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 14px; margin: 0; font-size: 13px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
@media (max-width: 760px) { .cols { grid-template-columns: minmax(0, 1fr); } .actions { justify-items: start; } }
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
/** Task histories fetched on request, keyed so a newer task version refetches. */
const histories = new Map();
const filterInput = document.getElementById("filter");
const notifyButton = document.getElementById("notify");
const stored = (key) => { try { return localStorage.getItem(key) || ""; } catch { return ""; } };
const store = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
let filter = stored("pi-dashboard:filter");
let notifyOn = stored("pi-dashboard:notify") === "on" && "Notification" in window && Notification.permission === "granted";

const ORDER = { waiting: 0, tool: 1, working: 1, compacting: 1, idle: 2 };
const TODO_GLYPH = { completed: "✓", in_progress: "◐", pending: "○" };
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
const bytes = (n) => n >= 1073741824 ? +(n / 1073741824).toFixed(2) + " GB" : n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " B";
const money = (n) => "$" + (n >= 100 ? Math.round(n) : n.toFixed(2));
const title = (session) => session.name || "untitled …" + session.sessionId.slice(-6);
const statusLabel = (session) => {
  if (session.restarting) return "restarting";
  const status = session.status;
  return status.kind === "tool" ? "tool: " + status.tool : status.kind;
};
const pill = (kind, text) => el("span", "pill " + kind, text);

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
async function ask(session, path, payload) {
  let response;
  const headers = { "X-Dashboard-Token": token };
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  try {
    response = await fetch("/api/sessions/" + encodeURIComponent(session.id) + "/" + path, {
      method: "POST", headers, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  } catch {
    throw new Error("The dashboard is not reachable.");
  }
  const body = await response.json().catch(() => ({}));
  if (!body.ok) throw new Error(body.error || "Request failed (" + response.status + ").");
  return body.data;
}

/** Runs a request into one of the content maps, re-rendering as it starts and ends. */
async function fetchInto(map, key, session, path) {
  map.set(key, { loading: true });
  render(true);
  try { map.set(key, { data: await ask(session, path) }); } catch (error) { map.set(key, { error: error.message }); }
  render(true);
}

async function focusSession(session) {
  busy.add(session.id);
  notices.delete(session.id);
  render(true);
  let notice;
  try {
    await ask(session, "focus");
    notice = { ok: true, text: "Focused in " + session.terminal.label };
  } catch (error) {
    notice = { ok: false, text: error.message };
  }
  busy.delete(session.id);
  notices.set(session.id, notice);
  setTimeout(() => { if (notices.get(session.id) === notice) { notices.delete(session.id); render(true); } }, notice.ok ? 3000 : 8000);
  render(true);
}

function focusButton(session, solid) {
  if (!session.terminal || session.restarting) return null;
  const button = el("button", "focus" + (solid ? " solid" : ""), busy.has(session.id) ? "Focusing…" : "Focus");
  button.type = "button";
  button.disabled = busy.has(session.id);
  button.title = "Bring this session's " + session.terminal.label + " pane to the front";
  button.dataset.key = "focus:" + session.id + (solid ? ":detail" : "");
  button.addEventListener("click", (event) => { event.stopPropagation(); focusSession(session); });
  return button;
}

function noticeFor(session) {
  const notice = notices.get(session.id);
  if (!notice) return null;
  const node = el("span", "notice" + (notice.ok ? " ok" : ""), notice.text);
  node.setAttribute("role", "status");
  return node;
}

function card(session) {
  const questions = session.restarting ? [] : list(session.questions);
  const waiting = !session.restarting && (session.status.kind === "waiting" || questions.length > 0);
  const node = el("article", "card" + (waiting ? " attn" : "") + (session.restarting ? " restarting" : ""));
  node.title = "session " + session.sessionId + " · pid " + session.pid;
  node.addEventListener("click", () => { location.hash = encodeURIComponent(session.id); });
  const head = el("div", "row");
  const name = el("h3", "name" + (session.name ? "" : " untitled"));
  const link = el("a", "", title(session));
  link.href = "#" + encodeURIComponent(session.id);
  link.dataset.key = "open:" + session.id;
  name.append(link);
  head.append(name, pill(session.restarting ? "idle" : session.status.kind, statusLabel(session)));
  node.append(head);
  if (questions.length) {
    const row = el("div", "row");
    row.append(el("span", "clip", "Asks: " + questions[0].questions[0].question), answerButton(session, questions[0], false));
    node.append(row);
  } else if (waiting && session.status.title) node.append(el("span", "clip", session.status.title));
  if (session.agent) node.append(el("span", "clip", "agent · " + session.agent));
  node.append(el("span", "mono muted clip", [session.model ? session.model.id : "no model", session.thinking].filter(Boolean).join(" · ")));
  node.append(meter(session.context));
  const work = [];
  const tasks = session.todos ? list(session.todos.tasks) : [];
  if (tasks.length) {
    const done = tasks.filter((task) => task.status === "completed").length;
    const fresh = tasks.reduce((sum, task) => sum + (Number(task.unreviewed) || 0), 0);
    work.push("todos " + done + "/" + (Number(session.todos.total) || tasks.length) + (fresh ? " · " + fresh + " new" : ""));
  }
  const running = session.subagents ? list(session.subagents.agents).filter((agent) => agent.state === "running").length : 0;
  if (running) work.push(running + (running === 1 ? " subagent" : " subagents"));
  const stashed = session.stash ? Number(session.stash.total) || 0 : 0;
  if (stashed) work.push("stash " + stashed);
  if (work.length) node.append(el("span", "clip", work.join(" · ")));
  const foot = el("div", "row");
  foot.append(el("span", "mono muted clip", "up " + ago(session.startedAt) + " · " + statusLabel(session) + " " + ago(session.status.since)));
  const button = focusButton(session, false);
  if (button) foot.append(button);
  node.append(foot);
  const notice = noticeFor(session);
  if (notice) node.append(notice);
  return node;
}

/** Every whitespace-separated term must appear in the name, directory, agent, model or status. */
function matches(session) {
  const terms = filter.toLowerCase().split(/\\s+/).filter(Boolean);
  if (!terms.length) return true;
  const text = [title(session), tilde(session.cwd), session.agent, session.model && session.model.id, statusLabel(session)].filter(Boolean).join(" ").toLowerCase();
  return terms.every((term) => text.includes(term));
}

function renderIndex() {
  if (!state.sessions.length) {
    main.append(el("p", "empty", connected
      ? "No interactive Pi sessions are running."
      : "Not connected. The dashboard stops when the last Pi session exits; run /dashboard in Pi to start it again."));
    return;
  }
  const sessions = state.sessions.filter(matches);
  if (!sessions.length) {
    main.append(el("p", "empty", "No sessions match “" + filter.trim() + "”."));
    return;
  }
  const groups = new Map();
  for (const session of sessions) {
    if (!groups.has(session.cwd)) groups.set(session.cwd, []);
    groups.get(session.cwd).push(session);
  }
  for (const [cwd, items] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    main.append(el("h2", "group", tilde(cwd)));
    const grid = el("div", "grid");
    const rank = (s) => s.restarting ? 3 : ORDER[s.status.kind] ?? 2;
    items.sort((a, b) => rank(a) - rank(b) || (a.name || "").localeCompare(b.name || "") || a.startedAt - b.startedAt);
    for (const session of items) grid.append(card(session));
    main.append(grid);
  }
}

function panel(name, summary) {
  const node = el("section", "panel");
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

function todoPanel(session) {
  const tasks = list(session.todos.tasks);
  const done = tasks.filter((task) => task.status === "completed").length;
  const fresh = tasks.reduce((sum, task) => sum + (Number(task.unreviewed) || 0), 0);
  const node = panel("Todos", tasks.length ? done + "/" + session.todos.total + " done" + (fresh ? " · " + fresh + " new" : "") : "");
  if (!tasks.length) { node.append(el("span", "muted", "No tasks on this branch.")); return node; }
  const ul = el("ul", "items");
  for (const task of tasks) {
    const li = el("li");
    const key = session.id + ":" + task.key;
    const details = el("details");
    details.open = expanded.has(key);
    const historyKey = key + ":" + (task.updatedAt || 0);
    details.addEventListener("toggle", () => {
      if (details.open) expanded.add(key); else expanded.delete(key);
      if (details.open && !histories.has(historyKey)) fetchInto(histories, historyKey, session, "todos/" + encodeURIComponent(task.key) + "/history");
    });
    const summary = el("summary");
    summary.dataset.key = "todo:" + key;
    const glyph = task.blocked ? "⊘" : TODO_GLYPH[task.status] || "○";
    summary.append(
      el("span", "glyph" + (task.blocked ? " muted" : ""), glyph),
      el("span", task.status === "completed" ? "done" : task.blocked ? "muted" : "", task.subject),
      task.unreviewed ? el("span", "new", task.unreviewed + " new") : el("span"),
    );
    details.append(summary);
    const more = el("div", "more");
    more.append(el("span", "mono muted", task.key + " · " + task.status.replace("_", " ") + (task.blocked ? " · blocked" : "") + (task.updatedAt ? " · " + ago(task.updatedAt) + " ago" : "")));
    if (task.description) more.append(el("span", "wrap", task.description));
    if (list(task.dependsOn).length) more.append(el("span", "muted", "after: " + task.dependsOn.join(", ")));
    const history = histories.get(historyKey);
    if (history && history.data) more.append(timeline(history.data));
    else if (history && history.error) more.append(el("span", "bad", history.error));
    else if (task.message) more.append(el("span", "wrap", "“" + task.message.text + "”" + (task.message.at ? " · " + ago(task.message.at) + " ago" : "")));
    if (history && history.loading) more.append(el("span", "muted", "Loading history…"));
    details.append(more);
    li.append(details);
    ul.append(li);
  }
  node.append(ul);
  return node;
}

const STATUS_WORDS = { pending: "pending", in_progress: "in progress", completed: "completed" };

/** A task's status and message history, newest first. */
function timeline(history) {
  const updates = list(history.updates).slice().reverse();
  const ol = el("ol", "timeline");
  for (const update of updates) {
    const li = el("li");
    const change = update.from && update.from !== update.status ? STATUS_WORDS[update.from] + " → " + STATUS_WORDS[update.status] : STATUS_WORDS[update.status];
    li.append(el("span", "mono muted", ago(update.at) + " ago · " + change + (update.byUser ? " · you" : "")));
    if (update.message) li.append(el("span", "wrap", update.message));
    ol.append(li);
  }
  if (history.createdAt) {
    const li = el("li");
    li.append(el("span", "mono muted", ago(history.createdAt) + " ago · created"));
    ol.append(li);
  }
  if (!ol.childNodes.length) return el("span", "muted", "No history recorded.");
  return ol;
}

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
    const outcome = item.running ? "running" : item.error ? "failed" : item.durationMs !== undefined ? duration(item.durationMs) : "";
    row.append(what, el("span", "mono num " + (item.error ? "bad" : "muted"), [outcome, ago(item.at) + " ago"].filter(Boolean).join(" · ")));
    li.append(row);
    ul.append(li);
  }
  node.append(ul);
  return node;
}

function subagentPanel(session) {
  const agents = list(session.subagents.agents);
  const running = agents.filter((agent) => agent.state === "running").length;
  const node = panel("Subagents", running ? running + " running" : agents.length + " recent");
  const ul = el("ul", "items");
  for (const agent of agents) {
    const li = el("li");
    const row = el("div", "row");
    row.append(el("span", "clip", agent.type + ": " + (agent.description || agent.id)), pill(agent.state, agent.state));
    li.append(row);
    const facts = [agent.state === "running" || agent.state === "queued" ? ago(agent.since) : agent.durationMs !== undefined ? duration(agent.durationMs) : null,
      agent.toolUses ? agent.toolUses + " tools" : null, agent.tokens ? tokens(agent.tokens) + " tok" : null].filter(Boolean);
    if (facts.length) li.append(el("span", "mono muted", facts.join(" · ")));
    if (agent.note) li.append(el("span", "muted wrap", agent.note));
    ul.append(li);
  }
  node.append(ul);
  return node;
}

function memoryPanel(session) {
  const memory = session.memory;
  const bh = memory.blackhole;
  const node = panel(bh ? "Blackhole" : "Compaction");
  const rows = [];
  if (bh) {
    rows.push(["Observations kept", bh.kept + " of " + bh.observations + " · " + tokens(bh.keptTokens) + " tok"]);
    rows.push(["Dropped", String(bh.dropped)]);
    rows.push(["Reflections", String(bh.reflections)]);
  }
  rows.push(["Compactions", String(memory.compactions)]);
  if (memory.lastCompactionAt) rows.push(["Last compaction", ago(memory.lastCompactionAt) + " ago"]);
  if (session.context && session.context.tokens !== null) rows.push(["Context now", tokens(session.context.tokens) + " tok"]);
  node.append(kv(rows));
  if (!bh) node.append(el("span", "muted", "No pi-blackhole memory entries on this branch."));
  return node;
}

// Answering rpiv ask-user questionnaires. The form lives in its own dialog
// outside <main>, so live re-renders leave it alone, and each questionnaire's
// form is kept: a draft survives closing and reopening it.
const answerModal = document.getElementById("answer");
const answerForms = new Map();
let answering;

function flash(sessionId, notice) {
  notices.set(sessionId, notice);
  setTimeout(() => { if (notices.get(sessionId) === notice) { notices.delete(sessionId); render(true); } }, notice.ok ? 3000 : 8000);
}

function answerButton(session, questionnaire, solid) {
  const button = el("button", "focus" + (solid ? " solid" : ""), "Answer");
  button.type = "button";
  button.dataset.key = "answer:" + session.id + ":" + questionnaire.id + (solid ? ":detail" : "");
  button.addEventListener("click", (event) => { event.stopPropagation(); openAnswer(session, questionnaire, button.dataset.key); });
  return button;
}

function questionsPanel(session) {
  const items = list(session.questions);
  const node = panel("Waiting on you", items.length === 1 ? "1 questionnaire" : items.length + " questionnaires");
  node.classList.add("asks");
  const ul = el("ul", "items");
  for (const questionnaire of items) {
    const li = el("li");
    const row = el("div", "row");
    const what = el("div", "qsummary");
    for (const question of questionnaire.questions) {
      const line = el("div", "qline");
      if (question.header) line.append(el("span", "chip", question.header));
      line.append(el("span", "wrap", question.question));
      what.append(line);
    }
    row.append(what, answerButton(session, questionnaire, true));
    li.append(row, el("span", "mono muted", "asked " + ago(questionnaire.since) + " ago · the terminal can answer too; the first answer wins"));
    ul.append(li);
  }
  node.append(ul);
  return node;
}

function buildAnswerForm(session, questionnaire, key) {
  const form = el("form", "answer-form");
  form.noValidate = true;
  const head = el("div", "modal-head");
  const heading = el("div", "modal-title");
  const count = questionnaire.questions.length;
  const name = el("h2", "", (count === 1 ? "Question from " : count + " questions from ") + title(session));
  name.id = "answer-title";
  heading.append(name, el("span", "mono muted wrap", tilde(session.cwd) + " · asked " + ago(questionnaire.since) + " ago"));
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
    const inputs = question.options.map((option, optionIndex) => {
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
    if (!question.multiSelect) {
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
      const label = count === 1 ? "the question" : "question " + (questionIndex + 1);
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
  const submit = async (payload) => {
    error.textContent = "";
    send.disabled = decline.disabled = true;
    try {
      await ask(session, "questions/" + encodeURIComponent(questionnaire.id) + "/answer", payload);
      answerForms.delete(key);
      flash(session.id, { ok: true, text: payload.cancel ? "Declined the question" : "Answer sent" });
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
    submit(payload);
  });
  decline.addEventListener("click", () => submit({ cancel: true }));
  form.markClosed = () => {
    form.dataset.closed = "true";
    banner.hidden = false;
    send.disabled = decline.disabled = true;
  };
  return form;
}

function openAnswer(session, questionnaire, returnKey) {
  const key = session.id + ":" + questionnaire.id;
  let form = answerForms.get(key);
  if (!form) {
    form = buildAnswerForm(session, questionnaire, key);
    answerForms.set(key, form);
  }
  answering = { sessionId: session.id, id: questionnaire.id, key, returnKey };
  answerModal.replaceChildren(form);
  if (!answerModal.open) answerModal.showModal();
  checkAnswerStillOpen();
  const first = form.querySelector("input:not(:disabled), textarea");
  if (first) first.focus();
}

/** Marks the open form closed once its questionnaire leaves the live list, and drops drafts for finished ones. */
function checkAnswerStillOpen() {
  const live = new Set();
  for (const session of state.sessions) {
    if (session.restarting) continue;
    for (const questionnaire of list(session.questions)) live.add(session.id + ":" + questionnaire.id);
  }
  for (const key of answerForms.keys()) if (!live.has(key) && (!answering || answering.key !== key)) answerForms.delete(key);
  if (answering && !live.has(answering.key)) {
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

const stashFacts = (session, entry) => [entry.lines + " lines", entry.source,
  entry.createdBy === session.sessionId ? "this session" : "subagent …" + entry.createdBy.slice(-6),
  ago(entry.createdAt) + " ago", entry.versions > 1 ? "v" + entry.versions : null].filter(Boolean).join(" · ");

// The stash preview is a modal dialog outside <main>, so live re-renders leave
// it alone. Esc (native) and a click on the backdrop close it.
const modal = document.getElementById("preview");
let modalRequest = 0;
let modalReturn = "";

function previewHeader(session, entry) {
  const head = el("div", "modal-head");
  const heading = el("div", "modal-title");
  const name = el("h2", "", entry.name);
  name.id = "preview-title";
  heading.append(name, el("span", "mono muted wrap", entry.handle));
  if (entry.description) heading.append(el("p", "wrap", entry.description));
  heading.append(el("span", "mono muted wrap", bytes(entry.bytes) + " · " + stashFacts(session, entry)));
  const close = el("button", "close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close preview");
  close.addEventListener("click", () => modal.close());
  head.append(heading, close);
  return head;
}

/** Fills the body and footer; the header (and the focused close button) stays put. */
function showPreview(body, foot, view) {
  if (view.error) { body.replaceChildren(el("p", "bad pad", view.error)); return; }
  const pre = el("pre", "preview");
  view.data.lines.forEach((line, index) => { pre.append(el("span", "ln", index + 1), line, "\\n"); });
  body.replaceChildren(pre);
  foot.textContent = view.data.complete
    ? "All " + view.data.lines.length + (view.data.lines.length === 1 ? " line." : " lines.")
    : "First " + view.data.lines.length + " of " + view.data.total + " lines. Read the rest in Pi with stash_get.";
  foot.hidden = false;
}

async function openPreview(session, entry, returnKey) {
  const request = ++modalRequest;
  modalReturn = returnKey;
  const body = el("div", "modal-body");
  body.append(el("p", "muted pad", "Loading preview…"));
  const foot = el("div", "modal-foot");
  foot.hidden = true;
  modal.replaceChildren(previewHeader(session, entry), body, foot);
  if (!modal.open) modal.showModal();
  let view;
  try { view = { data: await ask(session, "stash/" + encodeURIComponent(entry.name) + "/preview") }; } catch (error) { view = { error: error.message }; }
  // Ignore an answer for a preview that was closed or replaced meanwhile.
  if (request === modalRequest && modal.open) showPreview(body, foot, view);
}

modal.addEventListener("click", (event) => { if (event.target === modal) modal.close(); });
modal.addEventListener("close", () => {
  modalRequest += 1;
  modal.replaceChildren();
  // The opening button may have been re-rendered; return focus to its successor.
  const back = [...main.querySelectorAll("[data-key]")].find((node) => node.dataset.key === modalReturn);
  if (back) back.focus();
});

function stashPanel(session) {
  const entries = list(session.stash.entries);
  const size = session.stash.store;
  const summary = [entries.length ? session.stash.total + (session.stash.total === 1 ? " entry" : " entries") : "", size ? "store " + bytes(size.bytes) + " / " + bytes(size.maxBytes) : ""].filter(Boolean).join(" · ");
  const node = panel("Stash", summary);
  if (size && size.bytes > size.maxBytes) node.append(el("span", "warn", "The stash store is over its " + bytes(size.maxBytes) + " cap. Run /stash:gc or lower retentionDays."));
  if (!entries.length) { node.append(el("span", "muted", "Nothing stashed on this branch.")); return node; }
  const ul = el("ul", "items");
  for (const entry of entries) {
    const li = el("li");
    const row = el("div", "row");
    const open = el("button", "small", "Preview");
    open.type = "button";
    open.dataset.key = "preview:" + session.id + ":" + entry.handle;
    open.addEventListener("click", () => openPreview(session, entry, open.dataset.key));
    const right = el("span", "row");
    right.append(el("span", "mono muted num", bytes(entry.bytes)), open);
    row.append(el("span", "mono clip", entry.name), right);
    li.append(row);
    if (entry.description) li.append(el("span", "clip", entry.description));
    li.append(el("span", "mono muted clip", stashFacts(session, entry)));
    li.append(el("span", "mono muted clip", entry.handle));
    ul.append(li);
  }
  node.append(ul);
  return node;
}

function usagePanel(session) {
  const usage = session.usage;
  const node = panel("Usage", money(usage.cost));
  node.append(kv([
    ["Input", tokens(usage.input) + " tok"], ["Output", tokens(usage.output) + " tok"],
    ["Cache read", tokens(usage.cacheRead) + " tok"], ["Cache write", tokens(usage.cacheWrite) + " tok"],
  ]));
  return node;
}

function renderDetail(id) {
  const back = el("a", "back", "← All sessions");
  back.href = "#";
  back.dataset.key = "back";
  const session = state.sessions.find((candidate) => candidate.id === id);
  const wrap = el("div", "detail");
  wrap.append(back);
  if (!session) {
    wrap.append(el("p", "empty", connected ? "This session is no longer running." : "Not connected."));
    main.append(wrap);
    document.title = "pi dashboard";
    return;
  }
  document.title = title(session) + " · pi dashboard";
  const head = el("div", "panel");
  const top = el("div", "dhead");
  const who = el("div");
  who.append(el("h2", session.name ? "" : "muted", title(session)));
  const meta = [tilde(session.cwd), session.agent ? "agent " + session.agent : null, "session …" + session.sessionId.slice(-8), "pid " + session.pid, "up " + ago(session.startedAt)];
  who.append(el("span", "mono muted wrap", meta.filter(Boolean).join(" · ")));
  const actions = el("div", "actions");
  const button = focusButton(session, true);
  if (button) actions.append(button);
  const notice = noticeFor(session);
  if (notice) actions.append(notice);
  top.append(who, actions);
  head.append(top);
  const strip = el("div", "strip");
  const cell = (label, ...children) => { const div = el("div"); div.append(el("span", "label", label), ...children); return div; };
  strip.append(
    session.model
      ? cell("Model", el("span", "mono clip", session.model.id), el("span", "mono muted clip", session.model.provider))
      : cell("Model", el("span", "muted", "none")),
    cell("Thinking", el("span", "", session.thinking || "off")),
    cell("Status", pill(session.restarting ? "idle" : session.status.kind, statusLabel(session)), el("span", "mono muted", "for " + ago(session.status.since))),
    cell("Context", meter(session.context)),
    cell("Cost", el("span", "num", session.usage ? money(session.usage.cost) : "–")),
  );
  if (session.status.kind === "waiting" && session.status.title) strip.append(cell("Waiting on", el("span", "wrap", session.status.title)));
  head.append(strip);
  wrap.append(head);
  if (!session.restarting && list(session.questions).length) wrap.append(questionsPanel(session));
  const cols = el("div", "cols");
  const left = el("div", "col");
  const right = el("div", "col");
  if (session.todos) left.append(todoPanel(session));
  if (session.subagents) left.append(subagentPanel(session));
  if (session.activity) left.append(activityPanel(session));
  if (session.memory) right.append(memoryPanel(session));
  if (session.stash) right.append(stashPanel(session));
  if (session.usage) right.append(usagePanel(session));
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
  const view = id ? state.sessions.find((session) => session.id === id) || null : state.sessions;
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
  const previous = new Map(before.map((session) => [session.id, session]));
  for (const session of after) {
    const old = previous.get(session.id);
    if (!old || old.restarting || session.restarting) continue;
    const was = old.status.kind;
    const now = session.status.kind;
    let body;
    if (now === "waiting" && was !== "waiting") body = "Waiting on you" + (session.status.title ? ": " + session.status.title : "");
    else if (now === "idle" && was !== "idle" && was !== "waiting") body = "Finished; ready for your next prompt";
    // A new questionnaire says what it asks; it replaces the generic waiting note (same tag).
    const seen = new Set(list(old.questions).map((questionnaire) => questionnaire.id));
    const fresh = list(session.questions).find((questionnaire) => !seen.has(questionnaire.id));
    if (fresh) body = "Asks: " + fresh.questions[0].question;
    if (!body) continue;
    const note = new Notification(title(session) + " · " + tilde(session.cwd), { body, tag: "pi-dashboard:" + session.id });
    note.onclick = () => { window.focus(); location.hash = encodeURIComponent(session.id); note.close(); };
  }
}

function showNotify() {
  notifyButton.textContent = notifyOn ? "Notifications on" : "Notifications off";
  notifyButton.setAttribute("aria-pressed", String(notifyOn));
}

notifyButton.addEventListener("click", async () => {
  if (!("Notification" in window)) { notifyButton.textContent = "Notifications unavailable"; return; }
  if (notifyOn) { notifyOn = false; store("pi-dashboard:notify", "off"); showNotify(); return; }
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  notifyOn = permission === "granted";
  notifyButton.title = permission === "denied" ? "Notifications are blocked for this page in your browser's settings." : "";
  store("pi-dashboard:notify", notifyOn ? "on" : "off");
  showNotify();
});
showNotify();

filterInput.value = filter;
filterInput.addEventListener("input", () => { filter = filterInput.value; store("pi-dashboard:filter", filter); render(true); });

const events = new EventSource("/events");
events.addEventListener("sessions", (event) => {
  const next = JSON.parse(event.data);
  announce(state.sessions, list(next.sessions));
  state = next;
  render();
  checkAnswerStillOpen();
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
<dialog id="preview" class="modal" aria-labelledby="preview-title"></dialog>
<dialog id="answer" class="modal" aria-labelledby="answer-title"></dialog>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
