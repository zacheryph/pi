#!/usr/bin/env node
/**
 * Runs a private bb with this repository's pi-surface plugin and a Pi that
 * plays a scripted model, so the plugin's slots can be driven and captured
 * with real data and no API key.
 *
 *   bb-harness.mjs up                          start bb, install the plugin
 *   bb-harness.mjs thread --scenario <ts> --prompt <text> [--title <t>]
 *   bb-harness.mjs fixture [--title <t>]       a thread with the canned fixture
 *   bb-harness.mjs bb <args…>                  run the bb CLI against it
 *   bb-harness.mjs reload                      rebuild and reload the plugin
 *   bb-harness.mjs env                         print the shell exports
 *   bb-harness.mjs down [--clean]              stop bb (and delete the state)
 *
 * Everything lives in one work directory (default $TMPDIR/pi-bb-harness):
 * bb's data directory, the bb-app install, a throwaway Pi agent directory and
 * a demo Git repository. Your own ~/.bb, Pi settings and sessions are never
 * read. Pi runs under `env -i` with only PATH, HOME, locale and bb's own
 * variables, so no API key reaches it, and the scenario is loaded only through
 * the wrapper this script writes (PI_SCRIPTED_MODEL=1).
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const pluginDir = join(root, "bb-plugin");
const BB_VERSION = "0.49.0";
const MODEL = "pi-scripted/scripted-model";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: command === "bb" ? [] : rest,
  allowPositionals: true,
  options: {
    work: { type: "string", default: process.env.PI_BB_HARNESS ?? join(tmpdir(), "pi-bb-harness") },
    port: { type: "string", default: "38990" },
    "bb-version": { type: "string", default: BB_VERSION },
    scenario: { type: "string" },
    prompt: { type: "string" },
    title: { type: "string" },
    timeout: { type: "string", default: "60000" },
    clean: { type: "boolean", default: false },
  },
});

const work = resolve(values.work);
const paths = {
  state: join(work, "state.json"),
  data: join(work, "bb-data"),
  app: join(work, "bb-app"),
  agent: join(work, "pi-agent"),
  piTmp: join(work, "pi-tmp"),
  repo: join(work, "demo-repo"),
  wrapper: join(work, "pi-scripted"),
  scenario: join(work, "scenario"),
  log: join(work, "bb.log"),
};
const bbBin = join(paths.app, "node_modules/.bin/bb");
const bbAppBin = join(paths.app, "node_modules/.bin/bb-app");

function readState() {
  if (!existsSync(paths.state)) fail(`No harness in ${work}. Run: bb-harness.mjs up`);
  return JSON.parse(readFileSync(paths.state, "utf8"));
}

function bbEnv(state) {
  return {
    ...process.env,
    BB_SERVER_URL: state.serverUrl,
    BB_DATA_DIR: paths.data,
    BB_HOST_DAEMON_PORT: String(state.daemonPort),
  };
}

function bb(state, args, { json = false, inherit = false } = {}) {
  const result = spawnSync(bbBin, [...args, ...(json ? ["--json"] : [])], {
    env: bbEnv(state),
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
  });
  if (result.status !== 0 && !inherit) {
    fail(`bb ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  if (inherit) return result.status ?? 1;
  return json ? JSON.parse(result.stdout) : result.stdout;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function waitFor(what, check, timeout = Number(values.timeout)) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) fail(`Timed out waiting for ${what}. bb's log: ${paths.log}`);
    await sleep(500);
  }
}

async function healthy(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

function writePiWrapper() {
  mkdirSync(paths.agent, { recursive: true });
  mkdirSync(paths.piTmp, { recursive: true });
  // The bundle as a personal install would load it, and nothing else.
  writeFileSync(join(paths.agent, "settings.json"), JSON.stringify({ packages: [root] }, null, 2));
  const pi = join(root, "node_modules/.bin/pi");
  if (!existsSync(pi)) fail(`Pi not found at ${pi}. Run npm install in ${root}.`);
  // bb runs this instead of `pi` (BB_PI_BRIDGE_COMMAND) for threads, the model
  // probe and the install check. It keeps bb's variables (BB_THREAD_ID,
  // PI_BB_SURFACE_*) and drops everything else, API keys included.
  writeFileSync(
    paths.wrapper,
    `#!/usr/bin/env bash
keep=()
while IFS= read -r -d '' kv; do
  case "$kv" in BB_*|PI_BB_*|PATH=*|HOME=*|USER=*|LANG=*|LC_ALL=*) keep+=("$kv");; esac
done < <(env -0)
scenario=$(cat ${JSON.stringify(paths.scenario)} 2>/dev/null)
exec env -i "\${keep[@]}" \\
  PI_CODING_AGENT_DIR=${JSON.stringify(paths.agent)} TMPDIR=${JSON.stringify(paths.piTmp)} \\
  PI_SCRIPTED_MODEL=1 PI_OFFLINE=1 \\
  ${JSON.stringify(pi)} \${scenario:+-e "$scenario"} "$@"
`,
  );
  chmodSync(paths.wrapper, 0o755);
}

function setScenario(file) {
  writeFileSync(paths.scenario, resolve(file));
}

async function up() {
  if (existsSync(paths.state)) {
    const state = readState();
    if (await healthy(state.serverUrl)) {
      console.log(`Already running: ${state.serverUrl} (work ${work})`);
      return;
    }
  }
  mkdirSync(work, { recursive: true });
  if (!existsSync(bbAppBin)) {
    console.log(`Installing bb-app@${values["bb-version"]} into ${paths.app}`);
    mkdirSync(paths.app, { recursive: true });
    writeFileSync(join(paths.app, "package.json"), '{ "private": true }\n');
    execFileSync(
      "npm",
      [
        "install",
        "--no-fund",
        "--no-audit",
        // npm 12 blocks install scripts; bb's native add-ons need theirs.
        "--allow-scripts=better-sqlite3,node-pty,@parcel/watcher",
        `bb-app@${values["bb-version"]}`,
      ],
      {
        cwd: paths.app,
        stdio: "inherit",
        env: { ...process.env, npm_config_ignore_scripts: "false" },
      },
    );
  }
  if (!existsSync(join(pluginDir, "node_modules"))) {
    console.log("Installing the plugin's dependencies");
    execFileSync("npm", ["install", "--include=dev", "--no-fund", "--no-audit"], {
      cwd: pluginDir,
      stdio: "inherit",
    });
  }
  writePiWrapper();
  if (!existsSync(paths.scenario)) {
    setScenario(join(root, ".agents/skills/bb-screenshot/scenarios/bb-session.ts"));
  }

  const port = Number(values.port);
  const state = {
    serverUrl: `http://127.0.0.1:${port}`,
    daemonPort: port + 1,
    work,
  };
  console.log(`Starting bb ${values["bb-version"]} on ${state.serverUrl}`);
  const log = openSync(paths.log, "a");
  const child = spawn(
    bbAppBin,
    [
      "--data-dir",
      paths.data,
      "--server-port",
      String(port),
      "--host-daemon-port",
      String(state.daemonPort),
      "--no-in-app-updates",
      "--bundled",
    ],
    {
      detached: true,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        BB_PI_BRIDGE_COMMAND: paths.wrapper,
        BB_SKIP_ONBOARDING: "1",
        BB_TELEMETRY: "false",
        // bb reads the community catalog straight from getbb.app, bypassing
        // HTTPS_PROXY. Where that host is blocked (sandboxes, CI) the reset
        // socket crashes bb's server, so point it somewhere that fails cleanly.
        BB_MARKETPLACE_URL: "https://127.0.0.1:9/marketplace.json",
      },
    },
  );
  child.unref();
  writeFileSync(paths.state, JSON.stringify(state, null, 2));
  await waitFor("bb's server", () => healthy(state.serverUrl));
  await waitFor("the Pi provider", () => {
    const out = spawnSync(bbBin, ["provider", "models", "pi"], {
      env: bbEnv(state),
      encoding: "utf8",
    });
    return out.status === 0 && out.stdout.includes(MODEL);
  });

  if (!existsSync(join(paths.repo, ".git"))) {
    mkdirSync(paths.repo, { recursive: true });
    const git = (...args) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: paths.repo });
    git("init", "-q", "-b", "main");
    writeFileSync(join(paths.repo, "README.md"), "# demo\n");
    git("add", "-A");
    git(
      "-c",
      "user.name=harness",
      "-c",
      "user.email=harness@example.invalid",
      "commit",
      "-qm",
      "init",
    );
  }
  const projects = bb(state, ["project", "list"], { json: true });
  const list = Array.isArray(projects) ? projects : (projects.projects ?? []);
  const repo = realpathSync(paths.repo);
  state.projectId =
    list.find((p) => p.sources?.some((s) => s.path === repo))?.id ??
    bb(state, ["project", "create", "--name", "demo", "--root", repo], { json: true }).id;
  writeFileSync(paths.state, JSON.stringify(state, null, 2));

  console.log("Installing the pi-surface plugin");
  bb(state, ["plugin", "install", pluginDir, "--yes"]);
  console.log(`Ready: ${state.serverUrl} (work ${work})`);
}

const liveSessions = (state) =>
  bb(state, ["pi-surface", "list"])
    .split("\n")
    .filter((line) => line.includes(" live "))
    .map((line) => line.split(/\s+/)[0]);

/** Spawns a Pi thread on the scripted model and waits for its turn to end. */
async function spawnThread(state, prompt, title) {
  const created = bb(
    state,
    [
      "thread",
      "spawn",
      "--project",
      state.projectId,
      "--provider",
      "pi",
      "--model",
      MODEL,
      "--title",
      title ?? prompt.slice(0, 40),
      "--prompt",
      prompt,
    ],
    { json: true },
  );
  const id = created.id ?? created.thread?.id;
  await waitFor("the Pi session to connect", () => liveSessions(state).includes(id));
  // Let the scripted turn play out so the snapshot holds its final state.
  bb(state, ["thread", "wait", id, "--status", "idle", "--timeout", `${values.timeout}ms`]);
  return id;
}

async function thread() {
  const state = readState();
  if (!values.prompt) fail("thread needs --prompt <text>");
  if (values.scenario) setScenario(values.scenario);
  console.log(await spawnThread(state, values.prompt, values.title));
}

/**
 * A thread showing the plugin's canned fixture session (the docs' data). The
 * plugin refuses a fixture for a thread whose Pi session is connected, so the
 * thread's Pi is stopped first and its session left to expire (15 s).
 */
async function fixture() {
  const state = readState();
  const previous = readFileSync(paths.scenario, "utf8");
  setScenario(join(root, ".agents/skills/bb-screenshot/scenarios/quiet.ts"));
  let id;
  try {
    id = await spawnThread(state, "Show the fixture session", values.title ?? "Fixture");
  } finally {
    setScenario(previous);
  }
  bb(state, ["thread", "stop", id]);
  await waitFor("the Pi session to expire", () => !liveSessions(state).includes(id), 60_000);
  bb(state, ["pi-surface", "fixture", "--thread", id]);
  console.log(id);
}

async function reload() {
  const state = readState();
  bb(state, ["plugin", "build", pluginDir]);
  bb(state, ["plugin", "reload", "pi-surface"]);
  console.log("Reloaded pi-surface");
}

async function down() {
  if (existsSync(paths.state)) {
    spawnSync(bbAppBin, ["stop", "--data-dir", paths.data], { stdio: "inherit" });
  }
  if (values.clean) rmSync(work, { recursive: true, force: true });
}

switch (command) {
  case "up":
    await up();
    break;
  case "thread":
    await thread();
    break;
  case "fixture":
    await fixture();
    break;
  case "bb":
    process.exit(bb(readState(), rest, { inherit: true }));
    break;
  case "reload":
    await reload();
    break;
  case "env": {
    const state = readState();
    console.log(
      [
        `export BB_SERVER_URL=${state.serverUrl}`,
        `export BB_DATA_DIR=${paths.data}`,
        `export BB_HOST_DAEMON_PORT=${state.daemonPort}`,
        `alias bb=${bbBin}`,
      ].join("\n"),
    );
    break;
  }
  case "down":
    await down();
    break;
  default:
    console.error(
      "usage: bb-harness.mjs up | thread --prompt <text> [--scenario <ts>] | fixture | bb <args…> | reload | env | down [--clean]",
    );
    process.exit(2);
}
void positionals;
