# Whole-session isolation for Pi

## Launch decision

Add a small launcher workspace under `packages/pi-isolate`. Import a pinned release of `@anthropic-ai/sandbox-runtime` as a dependency. The host process owns one sandbox manager and one Pi child per invocation. Launch the installed Pi CLI inside the sandbox, so module loading, migrations, settings, extensions, providers, tools, jobs, and subagent sessions all start inside the same OS boundary.

This repo ships an extension bundle. The installed `@earendil-works/pi-coding-agent` 1.5.2 owns the `pi` executable. Its CLI imports main, configures HTTP, parses arguments and selects the mode. Main also runs migrations and opens settings before running the session. Registering an extension flag and relaunching from a hook would already have executed host-side Pi and extension code. An SDK caller that constructs a session in its own process also bypasses the CLI. Such a caller needs to start this launcher in RPC mode to get this boundary.

For a repo-only release, ship a distinct executable, e.g. `pi-launch`, and an explicit installation step that places a `pi` shim ahead of upstream Pi on PATH. A shell alias suffices for interactive testing, but GUI/RPC clients need the executable or its configured absolute path. Resolve the real CLI from the installed peer package's bin metadata, using trusted installation paths independent of cwd. Dispatch directly to that entry, never resolving the name `pi` through PATH again. Keep the launcher, dependency tree and shim outside directories granted sandbox write access. For an upstream implementation, put the same dispatch in Pi's bin entry before dynamically importing normal startup. That removes the shim installation step.

Use `pi --isolate [ordinary Pi arguments...]` as the initial syntax. Consume only this leading flag so a prompt or an option value equal to `--isolate` survives. For ordinary invocations, delegate directly to the installed CLI without reading YAML or initializing SRT. Leave stdin, cwd and all mode selection to Pi. A child invoking plain Pi already inherits OS restrictions. No environment marker is evidence of confinement.

## Configuration

Read the host user's `~/.pi/agent/isolation.yaml` before starting Pi. Use a versioned Pi envelope around the pinned library's config shape. Reject missing files, invalid values and unknown keys before launch. Report the config path and offending field on stderr, excluding secret values. Resolve relative sandbox paths against the invocation cwd consistently with SRT. A resumed session may reopen a different project; it gets only the paths the launch policy authorized.

Example for a user who authenticates with an Anthropic API key and wants persistent session history:

```yaml
version: 1
sandbox:
  network:
    allowedDomains: [api.anthropic.com]
    deniedDomains: []
  filesystem:
    denyRead: ["~/.ssh", "~/.aws", "~/.pi/agent/isolation.yaml"]
    allowWrite: [".", "~/.pi/agent/sessions"]
    denyWrite: ["~/.pi/agent/isolation.yaml"]
env:
  pass: [ANTHROPIC_API_KEY, LANG, LC_ALL, TERM, COLORTERM]
  set:
    APP_ENV: development
```

Reads are generally permitted unless denied. Enumerate additional sensitive paths for the actual machine. The example grants session writes only within the agent directory. Verify first-run setup, auth locking/refresh, settings writes and per-extension storage separately. Where these need writes, document the exact paths or use session-private state. Never silently grant the entire agent directory. Protect the policy from replacement via writable ancestors or symlinks, including when launched from home or the config directory. Reject an unsafe effective layout where that protection cannot be established. Plaintext env values in the YAML deserve the same file protection as credentials.

Build the wrapped process environment from a controlled baseline (trusted executable search path, real HOME and a usable temporary directory), then named host values in `pass`, then literal string overrides in `set`. Missing pass entries are omitted. No wildcard inheritance, shell evaluation or expansion of values. Add secrets only through the spawn environment, never shell text, argv or diagnostic output. Reserve the variables needed for the runtime's proxy, credential and sandbox setup; validate conflicts. Keep shell startup hooks and loader injection variables out of the host-side wrapper environment. If supported as payload settings, apply them only after sandbox entry. Verify the final observed child environment with the pinned release, including variables synthesized by SRT. Upstream also documents deny/mask operations for credentials. Those solve a separate need: a passed API key is readable by Pi, its extensions and tools. Credential masking and provider compatibility can be evaluated independently.

## Supervision and mode compatibility

1. Resolve the trusted CLI, validate YAML and platform prerequisites, create a private per-launch directory as needed, and install cancellation handling before setup. Fail before running Pi if the configured boundary cannot be established.
2. Initialize SandboxManager with the effective policy. Its proxies live in the host supervisor. Wrap the absolute Node and Pi entry invocation. For a string-based wrapping API, POSIX-quote each argv element independently, including empty strings. Invoke the returned wrapper through the fixed shell supported by the pinned release with startup hooks disabled. Do not concatenate raw prompts or parse Pi arguments in the supervisor.
3. Spawn attached to the original stdin, stdout and stderr. The supervisor never reads stdin or emits stdout. TUI owns raw mode and its controlling terminal. Print owns piped prompts and EOF. JSON and RPC retain exact stream framing. Do not allocate a second PTY by default. Test terminal foreground ownership, resize, suspend/resume, Ctrl-C and terminal restoration under real PTYs.
4. Preserve exit status and terminating signal after cleanup. With an attached foreground group a keyboard interrupt can already reach both processes. Handle signals sent only to the supervisor as well, avoiding duplicate delivery or accidentally signaling the invoking shell. Verify shutdown for the actual SRT wrapper chain and detached job descendants on each platform. A session-owned job ends with its session under this design.
5. On any failed setup, spawn error, normal exit or handled termination, run idempotent teardown in reverse acquisition order. Stop the sandboxed workload first, reset SRT, then close earlier host helpers and remove their files. Register each disposer immediately when acquiring a resource. Bound graceful shutdown before escalation. An uncatchable supervisor death cannot run finally blocks. Test child fate on supervisor death and require an independent parent-death/lease mechanism for any later host daemon that could otherwise survive indefinitely.

## Implementation order

| Change                                                    | What proves it works                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Pin SRT and build a disposable launch probe            | On macOS and Linux, run the installed Pi in a real sandbox. Verify an extension's top-level code and a subprocess both fail to read/write denied fixtures. Verify one allowed provider streaming request and one denied destination. Inspect actual child env, proxy handling, helper binaries and failure behavior on each OS.                                                                                                                                            |
| 2. Ship launcher, YAML and installation                   | Exercise plain Pi and isolated Pi through the installed shim from both shell and RPC client. Verify config validation, secret filtering, cwd, literal arguments, missing OS dependencies, read-only policy, no recursion, and no unconfined fallback.                                                                                                                                                                                                                      |
| 3. Verify modes and lifetime before release               | Compare TUI via PTY, print via stdin and argv, JSON output, and bidirectional RPC (prompt, abort, EOF) against plain Pi. Test session creation/resume, concurrent invocations, forced child exit, external signals, background jobs and partial setup failure. Assert clean stdout, exit status, terminal state and released resources. Exercise the user's enabled extensions with their actual settings, including a permitted subagent/tool operation and a denied one. |
| 4. Add the first host plugin when there is a concrete use | Use the private preparation/disposal lifecycle from v1. A first integration test should allocate a file and host endpoint, expose only the intended access, fail partway through startup, and verify cleanup.                                                                                                                                                                                                                                                              |

Start with macOS and Linux as proposed targets. Confirm stock OS enforcement and dependencies on each before claiming support. The exact npm release and platform behavior still need verification. Source inspection alone does not establish TUI, provider streaming, or process-tree cleanup.

## First implementation handoff

Start with change 1. Check the installed Pi version against the root lockfile, pin a published SRT release, and inspect that release's exported types and wrapper implementation. Record the exact Node, Pi, SRT and OS versions alongside the commands that reproduce each result. Upstream's default branch can describe APIs newer than the published dependency.

Use a temporary agent directory and two fixture directories, one allowed and one denied. Load a fixture Pi extension that attempts access at module scope and repeats the operation in a spawned Node child. Assert that the allowed control succeeds and the existing denied file is inaccessible in both processes. Include an attempted write and check the result from the host. Use a synthetic host-only environment value to check filtering without printing real credentials.

Use a scripted provider fixture for deterministic print, JSON and RPC checks. Exercise real streaming through the proxy separately with an explicitly configured test provider. For each platform, record what passed, what failed and what could not run, including the exact helper or permission missing. Carry those results into the launcher change so another agent can reproduce the boundary and distinguish a Pi mode failure from an OS or provider failure.

## Future host plugins

The initial implementation needs a preparation phase and a disposal stack. Defer public plugin discovery and a versioned API until the first real helper is implemented. A future trusted plugin is explicitly named in user-controlled host configuration and loaded from a host-controlled location. Ordinary project Pi extensions continue loading inside the child.

Preparation receives the invocation cwd, private session directory, cancellation signal, and a way to register cleanup immediately. It can prepare a file or start a service, wait for readiness, and return specific policy additions and child environment values. Compose once, validate the final policy, then initialize SRT. Preserve user denials, reject conflicting env assignments and unsupported capabilities, and report which plugin requested a grant. Treat read exceptions carefully because SRT can re-allow paths inside a denied region. Blindly concatenating policy arrays can widen a user denial.

Keep transport platform-specific. macOS supports allowing a named Unix socket. Linux SRT documents that its seccomp filter cannot allowlist Unix socket paths; enabling all sockets would widen the boundary. Also, loopback inside a Linux network namespace is separate from host loopback. Test a narrowly scoped, authenticated bridge before promising a cross-platform host endpoint. A host helper binding a port and the sandboxed process being allowed to bind its own port are separate capabilities.

## References

- [Sandbox Runtime, library lifecycle and configuration](https://github.com/anthropics/sandbox-runtime#as-a-library)
- [Sandbox Runtime, socket support and filesystem semantics](https://github.com/anthropics/sandbox-runtime#configuration-options)
- Local Pi 1.5.2 entry points inspected: `node_modules/@earendil-works/pi-coding-agent/dist/cli.js`, `dist/cli/setup.js`, `dist/main.js`, and `dist/core/http-dispatcher.js`.
