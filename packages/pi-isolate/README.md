# pi-isolate

Experimental whole-session launcher for Pi 1.5.2, using
`@anthropic-ai/sandbox-runtime` **0.0.83**. `pi-launch --isolate` starts the
installed Pi CLI inside SRT before Pi loads settings, extensions, providers or
tools. Subprocesses and in-process subagents inherit that boundary. Ordinary
`pi-launch` invocations delegate directly to Pi without loading YAML or SRT.
There is no unconfined fallback after isolation is requested.

This implements the launcher in [PR 194](https://github.com/zacheryph/pi/pull/194).
It is a standalone executable, with no Pi extension, slash commands or tools.
The sandbox runtime is an external pinned dependency, not vendored source.

## Install and invoke

Requires Node 24+ on macOS or Linux, the pinned Pi peer, and SRT's platform
prerequisites. macOS uses `/usr/bin/sandbox-exec`; Linux needs ripgrep,
bubblewrap, socat, procps (`/bin/ps`) and usable user namespaces. The packaged seccomp helpers are
included in SRT. Missing prerequisites fail before Pi runs. Linux is an
implementation target with runtime verification still outstanding.

Keep this checkout and its dependencies outside projects the sandbox can write.
Install dependencies in that trusted checkout:

```sh
cd /absolute/trusted/pi
npm install --ignore-scripts
node packages/pi-isolate/bin/pi-launch.mjs --version
```

The repository also provides `npm run setup:pi` to install dependencies and
register this bundle in Pi, and `npm run setup:launcher` to link `pi-launch`
into `~/.local/bin` (or `-- --bin-dir PATH`). The helper refuses existing files
or unrelated symlinks and never replaces `pi`. Run
`npm run setup:policy` to copy the example with mode 600 only when no policy
already exists. These commands are explicit; installing dependencies alone
does not change user configuration.

Prepare the policy explicitly; installation never creates or overwrites one:

```sh
mkdir -p "$HOME/.pi/agent"
cp packages/pi-isolate/isolation.example.yaml "$HOME/.pi/agent/isolation.yaml"
chmod 600 "$HOME/.pi/agent/isolation.yaml"
```

Review the example for your provider, sensitive paths and required storage.
Then place a `pi` shim ahead of upstream Pi on PATH, at a new destination:

```sh
mkdir -p "$HOME/.local/bin"
ln -s /absolute/trusted/pi/packages/pi-isolate/bin/pi-launch.mjs "$HOME/.local/bin/pi"
export PATH="$HOME/.local/bin:$PATH"
cd /absolute/path/to/project
pi --isolate
pi --isolate -p "Explain this project"
printf '%s\n' 'Explain this project' | pi --isolate --mode json -p
pi --isolate --mode rpc
```

If `~/.local/bin/pi` already exists, choose another shim directory or review it
before replacing it. GUI/RPC clients should configure that absolute shim path
or `bin/pi-launch.mjs`. An SDK session constructed in the caller's process is
outside this boundary; start the executable in RPC mode instead.

Only a **leading** `--isolate` is consumed. Later occurrences, empty arguments,
newlines and shell metacharacters are passed literally. The real Pi entry is
resolved from its installed package's `bin.pi` metadata relative to the
launcher, independent of project cwd and the executable named `pi` on PATH.
Launching from this trusted checkout with `allowWrite: ["."]` is rejected:
choose a separate project directory.

### Native launcher

From the trusted repository root, with Bun **1.4.4** installed:

```sh
npm run build:launcher
packages/pi-isolate/dist/pi-launch --version
npm run probe:launcher
npm run setup:launcher -- --compiled
```

The build embeds the launcher, supervisor and SRT JavaScript in a native Bun
executable. Bun is not needed at runtime. Pi still runs under the installed
Node executable; it is not bundled into the binary. Absolute paths to Node,
Pi, this checkout and SRT's real Linux seccomp assets are recorded at build
time. Keep those paths installed and trusted. Rebuild after moving them or
updating dependencies. This builds for the current OS and architecture only.

The executable re-execs itself with the filtered environment before evaluating
SRT. Its embedded supervisor is selected through argv[0], leaving Pi arguments
unchanged. Automatic loading of project `.env`, `bunfig.toml`, `tsconfig.json`
and `package.json` is disabled, and build-time environment values are not
inlined. The same policy and installation-write protection apply to both builds.
The binary's own path is also protected from sandbox writes.

`probe:launcher` builds the production executable and a test driver using the
same compiled supervisor invocation and sandbox implementation. It checks plain
Pi delegation with the production executable and runs all 36 OS/mode/lifecycle
checks through the driver with a disposable policy; it never edits your policy.
macOS CI runs both source and compiled probes. Linux runtime remains unverified.

## Policy and environment

The host user's `~/.pi/agent/isolation.yaml` must exist, be user-owned and have
no group/other write permission. HOME comes from the OS account, not an inherited
HOME variable. Missing files, malformed YAML, duplicate keys, aliases, unknown
keys and invalid values stop launch. Errors identify the config and schema
field without printing env values or YAML parser excerpts.

The version 1 envelope accepts exactly:

- `version: 1`.
- `sandbox.network.allowedDomains` and `deniedDomains`, required arrays validated
  with the pinned SRT domain schema. The launcher always enables strict allowlisting.
- `sandbox.filesystem.denyRead`, `allowWrite`, and `denyWrite`, required arrays
  of literal paths. Relative paths resolve against invocation cwd; `~/` resolves
  against the real home. Globs, path objects, read exceptions, external proxies,
  disabled enforcement and weaker sandbox settings are unsupported and rejected.
- Optional `sandbox.allowPty`, a boolean using SRT's macOS PTY permission.
- Optional `env.pass`, an array of named host variables, and `env.set`, a map of
  literal strings. Missing pass entries are omitted; set overrides pass. There
  is no shell expansion or wildcard inheritance.

Reads are generally allowed except where denied. Enumerate your actual sensitive
paths. A passed provider key is readable by Pi, its extensions and tools.
Credential masking, OAuth refresh and host plugin discovery are outside v1.
The example permits project and session writes only; it does not promise
first-run setup, stored-auth locking, settings changes or extension storage.
For those, grant the specific paths your setup needs or use a separate,
session-private agent directory through an explicitly passed
`PI_CODING_AGENT_DIR`. Never grant the whole home or agent directory as a shortcut:
that can also allow policy replacement, and the launcher rejects it.

Before launch, write grants are canonicalized and checked against both the
lexical and real policy, shim, launcher/dependency tree, Pi installation, Node
and trusted executable directories and resolved helper binaries. Grants on their ancestors are rejected even
if a deny names the file: writable parents permit replacement by rename.
Direct symlinked write roots that cannot be proved safe are rejected. The
launcher also adds explicit write denials for protected paths. The host user
and other host processes remain trusted; this is not protection against a
concurrent hostile host editing the installation or policy during startup.

The isolated supervisor is re-executed with a controlled PATH (Node's directory,
Homebrew/system executable directories), real HOME and a temporary directory,
then the named pass entries and literal overrides. Proxy, shell startup, loader,
JVM/Python/Perl/Ruby injection, Git config injection and runtime-owned variables
are reserved. SRT and its host helpers load only after that filtering. Secret
env values are passed through the process environment, never wrapper text.

Each invocation gets a mode-700 private temporary directory, made writable for
that session and removed after teardown. Payload TMPDIR points there. User
denials still win; denying its location makes launch fail. SRT additionally
permits its built-in device/temp paths (`/tmp/claude`, `/private/tmp/claude`) and
convenience log directories (`~/.npm/_logs`, `~/.claude/debug`); these are behavior
of the pinned runtime. Its non-device defaults are included in installation
protection checks. Explicit denials can narrow these default grants.

## Supervision and limits

Pi inherits stdin, stdout, stderr, cwd and the controlling terminal. The
supervisor does not read stdin, write stdout, select a Pi mode or allocate a
PTY. SRT's wrapper runs through fixed `/bin/bash` with startup files disabled;
each payload argument is quoted separately. The original shim and trusted
installation must remain outside sandbox write grants.

Cancellation is installed before sandbox setup. SIGINT, SIGTERM, SIGHUP and
SIGQUIT are forwarded to the workload; teardown stops it before resetting SRT
and deleting temporary files. Child exit status and terminating signal are
preserved. Signal escalation is bounded at two seconds. SRT's eager signal
reset handlers are removed after initialization so they cannot dismantle the
proxies before workload shutdown.

Descendants are sampled every 100ms and identified by PID plus start time.
Observed descendants, including detached jobs, are stopped on normal exit and
handled termination. This is best-effort process accounting on macOS: a process
that detaches and reparents between samples can escape accounting. SIGKILL or a
supervisor crash cannot run cleanup. Linux SRT uses bubblewrap's
`--die-with-parent`, but the full wrapper/proxy tree still needs a Linux probe.
There are no persistent host daemons. An independent parent-death/lease design
is required before adding one. Do not treat this experimental launcher as a
verified guarantee of process-tree cleanup after an uncatchable supervisor death.

Terminal suspend/resume, foreground-group signal duplication, enabled production
extensions, auth refresh and session create/resume require additional platform
coverage before release. See the verification record below.

## Reproduce verification

From the trusted repository root:

```sh
npm run check
npm run test:workspace -- packages/pi-isolate
npm run verify:bundle
npm run probe --workspace=pi-isolate
npm run probe:network --workspace=pi-isolate
```

The regular workspace tests are offline. The opt-in OS probe needs permission
to create local SRT proxy sockets, enforce an OS sandbox and open a real test
PTY; it also needs Python 3 for the terminal driver. It creates disposable
agent, project, allowed, denied and policy directories. A fixture extension
attempts reads and writes at module scope and from a spawned Node process,
checks a synthetic host-only env value and literal env override, and registers
a scripted provider. Print argv, print stdin/JSON, RPC prompt/abort/EOF and TUI
prompt/resize/EOF/terminal restoration are exercised with real Pi. The terminal
probe allocates a PTY as the _test client_; the launcher itself never does.

GitHub Actions keeps the regular workspace tests on Linux and runs `probe` in
a separate `macos-26` job whenever this workspace is selected. That job records
the OS, architecture, Node, Python, Pi and SRT versions. It requires the real
sandbox checks to pass; it does not silently skip enforcement failures. Linux
OS probes remain opt-in until their runner prerequisites are verified.

`probe:network` additionally uses curl through SRT to request
`https://example.com` (allowed) and `https://example.org` (denied). It does not
use provider credentials or make billed model requests. Real provider streaming
must be tested separately with an explicitly configured test provider.

### Verification record — 2026-11-17

Host: macOS 26.6.2 (25G83), Darwin 25.6.0, arm64. Node **26.10.0**,
installed/locked Pi **1.5.2**, SRT **0.0.83**. Commands above were run from this
checkout. OS probes ran outside the surrounding Codex sandbox, which otherwise
blocked SRT's proxy socket with `listen EPERM`. No enforcement fallback was used.

| Check                                                                                                                  | Observed result                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`, workspace tests, `verify:bundle`, root script tests                                                           | Pass; bundle still loads 10 extensions and the existing tools/commands                                                                                          |
| Module-scope and subprocess filesystem checks                                                                          | Allowed controls succeed; denied read/write operations fail; host denied fixture remains intact                                                                 |
| Environment and proxy checks                                                                                           | Synthetic host-only value absent; literal override unchanged; SRT proxy variables present                                                                       |
| Print/JSON                                                                                                             | Scripted response from argv and stdin; stdout retains JSON framing                                                                                              |
| RPC                                                                                                                    | Prompt accepted, abort succeeds, settled event received, stdin EOF exits cleanly                                                                                |
| Real PTY                                                                                                               | Prompt answered, terminal resized, Ctrl-D exits, canonical/echo/signal terminal flags restored; requires `allowPty: true`                                       |
| HTTPS                                                                                                                  | example.com succeeds through proxy; example.org returns proxy denial (curl status 22)                                                                           |
| Lifecycle                                                                                                              | Exit status/signal preserved; observed detached child stopped; missing prerequisites, partial initialization and setup cancellation unwind without launching Pi |
| Linux                                                                                                                  | Not run on this host; no support claim based only on source inspection                                                                                          |
| Real provider streaming, stored auth, production extension settings, create/resume, suspend/resume, supervisor SIGKILL | Not verified; required before a supported release                                                                                                               |

The probe's agent directory is disposable and has its own explicit write grant.
It sets `PI_OFFLINE=1` to prevent Pi's automatic tool downloads during TUI startup.
That is fixture configuration, not an env marker used as evidence of confinement.
