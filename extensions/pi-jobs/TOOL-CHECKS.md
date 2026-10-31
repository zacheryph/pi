# Tool checks for `job_watch`

Local addition to the vendored pi-jobs (see [UPSTREAM.md](UPSTREAM.md)). Instead of
a shell `check`, a watch can call **one Pi tool per interval**, such as an MCP tool,
and wake the agent when a condition on its result holds. Like shell watches, no
model is involved while it waits.

```json
{
  "toolCheck": {
    "tool": "mcp__github__get_check_run",
    "args": { "owner": "zacheryph", "repo": "pi", "check_run_id": 123636797148 },
    "match": { "path": "status", "equals": "completed" }
  },
  "intervalSeconds": 60,
  "timeoutSeconds": 3600,
  "label": "CI check 123636797148"
}
```

Exact tool names and arguments come from `/system:tools`. As with shell watches,
watch an **immutable target** (a check run id or a commit SHA), not a PR number.

## Parameters

Give exactly one of `check` or `toolCheck`.

| Field                      | Meaning                                                                          |
| -------------------------- | -------------------------------------------------------------------------------- |
| `toolCheck.tool`           | Exact tool name.                                                                 |
| `toolCheck.args`           | Arguments for the tool.                                                          |
| `toolCheck.match.path`     | Dot path into the result, e.g. `check_runs.0.status`; `""` for the whole result. |
| `toolCheck.match.equals`   | Holds when the value equals this (deep, key order ignored).                      |
| `toolCheck.match.in`       | Holds when the value equals one of these.                                        |
| `toolCheck.match.contains` | Holds when the value, as text, contains this string.                             |

`match` takes at most one of `equals`, `in`, and `contains`. With only `path`, it
holds when the path exists.

The result is the tool's structured content, or its text parsed as JSON, or the
plain text.

## Conditions

- `until: "success"` (default): the call succeeds and `match`, if given, holds.
- `until: "change"`: the check's output differs from the first conclusive check.
  With `match`, the output is just the selected value, so `change` ignores the rest
  of the result (timestamps, counters). Without `match`, it compares the whole
  result as canonical JSON.
- `until: "failure"` is rejected; invert the `match` instead.

## Errors

A failed call, a call blocked by a `tool_call` hook, or a thrown error is
**inconclusive**: it never matches and never sets the `change` baseline. After
3 in a row (`PI_JOBS_MAX_CHECK_ERRORS`) the watch ends as `failed` with the last
error. A successful call resets the count.

## Which tools qualify

A tool can be watched when it is marked read-only (`annotations.readOnlyHint`,
which MCP servers set for their read tools) **or** matches `PI_JOBS_WATCH_TOOLS`, a
comma-separated list of name globs:

```bash
export PI_JOBS_WATCH_TOOLS='mcp__github__*,my_status_tool'
```

`bash`, `edit`, `write`, `codemode`, and the `job_*` tools never qualify; use a
shell `check` for commands. Tools whose exposure is `model-only` or `hidden`
cannot be called by extensions at all.

Calls go through Pi's own tool pipeline (`ctx.executeTool`), so argument
validation, `tool_call` hooks, and permission extensions apply exactly as for
calls the model makes. This is not a sandbox: an allowed tool does whatever it
does, once per interval.

## Lifecycle

- **Reload:** the watch keeps the tool context of the `job_watch` call. After
  `/reload` that context is stale, so a running tool watch ends as `failed` with a
  "start it again" message rather than polling on.
- **`/tree`:** if the current branch has no assistant message, checks are
  inconclusive until it does.
- **Subagents:** a subagent's tool watch uses that subagent's tools and wakes that
  subagent.
- **Limits:** tool watches count towards the 32-watch cap and use the same
  interval, timeout, and per-check timeout limits as shell watches.

## Not supported

**Codemode scripts.** Pi registers its `codemode` tool as `model-only` and does
not export a way to run scripts from an extension, so a watch cannot run one
(see the findings on [#9](https://github.com/zacheryph/pi/issues/9)).
