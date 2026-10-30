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
header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 12px; padding: 10px 20px; background: var(--surface); border-bottom: 1px solid var(--line); }
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
const bytes = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " B";
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

async function focusSession(session) {
  busy.add(session.id);
  notices.delete(session.id);
  render(true);
  let notice;
  try {
    const response = await fetch("/api/sessions/" + encodeURIComponent(session.id) + "/focus", {
      method: "POST", headers: { "X-Dashboard-Token": token },
    });
    const body = await response.json().catch(() => ({}));
    notice = body.ok ? { ok: true, text: "Focused in " + session.terminal.label } : { ok: false, text: body.error || "Focus failed (" + response.status + ")." };
  } catch {
    notice = { ok: false, text: "The dashboard is not reachable." };
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
  const waiting = !session.restarting && session.status.kind === "waiting";
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
  if (waiting && session.status.title) node.append(el("span", "clip", session.status.title));
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

function renderIndex() {
  const sessions = state.sessions;
  if (!sessions.length) {
    main.append(el("p", "empty", connected
      ? "No interactive Pi sessions are running."
      : "Not connected. The dashboard stops when the last Pi session exits; run /dashboard in Pi to start it again."));
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
    details.addEventListener("toggle", () => { if (details.open) expanded.add(key); else expanded.delete(key); });
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
    if (task.message) more.append(el("span", "wrap", "“" + task.message.text + "”" + (task.message.at ? " · " + ago(task.message.at) + " ago" : "")));
    if (more.childNodes.length) details.append(more);
    li.append(details);
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

function stashPanel(session) {
  const entries = list(session.stash.entries);
  const node = panel("Stash", entries.length ? session.stash.total + (session.stash.total === 1 ? " entry" : " entries") : "");
  if (!entries.length) { node.append(el("span", "muted", "Nothing stashed on this branch.")); return node; }
  const ul = el("ul", "items");
  for (const entry of entries) {
    const li = el("li");
    const row = el("div", "row");
    row.append(el("span", "mono clip", entry.name), el("span", "mono muted num", bytes(entry.bytes)));
    li.append(row);
    if (entry.description) li.append(el("span", "clip", entry.description));
    const by = entry.createdBy === session.sessionId ? "this session" : "subagent …" + entry.createdBy.slice(-6);
    li.append(el("span", "mono muted clip", entry.lines + " lines · " + entry.source + " · " + by + " · " + ago(entry.createdAt) + " ago" + (entry.versions > 1 ? " · v" + entry.versions : "")));
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
  const cols = el("div", "cols");
  const left = el("div", "col");
  const right = el("div", "col");
  if (session.todos) left.append(todoPanel(session));
  if (session.subagents) left.append(subagentPanel(session));
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
  const key = JSON.stringify([id, connected, view]);
  if (!force && key === rendered) return;
  rendered = key;
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : undefined;
  count.textContent = state.sessions.length === 1 ? "1 session" : state.sessions.length + " sessions";
  main.replaceChildren();
  if (id) renderDetail(id); else { document.title = "pi dashboard"; renderIndex(); }
  if (focused) {
    const again = [...main.querySelectorAll("[data-key]")].find((node) => node.dataset.key === focused);
    if (again) again.focus();
  }
}

const events = new EventSource("/events");
events.addEventListener("sessions", (event) => { state = JSON.parse(event.data); render(); });
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
<header><h1><a href="#">pi dashboard</a></h1><span class="count"></span><span class="conn" aria-live="polite">connecting…</span></header>
<main></main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
