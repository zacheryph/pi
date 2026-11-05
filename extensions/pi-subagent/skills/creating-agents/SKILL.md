---
name: creating-agents
description: Create, edit, override, hide or disable a pi-subagent agent type (an agent profile file in .pi/agents/<name>.md or ~/.pi/agent/agents/<name>.md). Covers where files live and which one wins, every frontmatter field, writing a description and guidance the orchestrator can choose by, prompt_mode, tool selection, visibility for skill-only agents, locked fields, fragments, and how to check the result. Use when asked to add a specialist or custom subagent, change or replace a built-in agent (general-purpose, orchestrate, explore, plan, review), make an agent a skill can call without listing it, or when subagent_start keeps picking general-purpose because no specialist fits.
---

# Creating agents

An agent type is one markdown file: YAML frontmatter for settings, and a body
that becomes the agent's instructions. `subagent_start` lists every visible
agent type on one line, and the caller chooses from that line alone, so the
`description` and `guidance` matter as much as the body.

## Decide first

- **An agent type** fits a role that recurs: its own instructions, tools,
  model or limits, chosen by name. Reviewer, migration writer, docs editor.
- **A skill** fits a procedure any agent can follow with the tools it already
  has. If the role needs no different tools, model or prompt, write a skill.
- **A one-off task** needs neither: give `general-purpose` or a matching type a
  detailed prompt.

Check `/subagent:agents` before creating one. An existing type may only need
better `guidance`, or an override.

## Where the file goes

| Location                         | Scope                   | Wins over        |
| -------------------------------- | ----------------------- | ---------------- |
| `.pi/agents/<name>.md`           | this project            | global, built-in |
| `~/.pi/agent/agents/<name>.md`   | every project           | built-in         |
| `extensions/pi-subagent/agents/` | built-in, ships with Pi | —                |

- The file name is the type name. There is no `name` field. Lookups ignore
  case, so `EXPLORE` and `explore` are the same type; keep names lowercase
  with hyphens unless overriding a built-in.
- A file with a built-in's name replaces that built-in entirely. Copy the
  built-in from `extensions/pi-subagent/agents/` and edit it; a file with only
  the fields you want to change loses everything else.
- `PI_CODING_AGENT_DIR` moves the global directory.
- Project files with `fragments`, and project files used as the main profile
  (`pi --agent <name>`), need Pi project trust (`--approve` or `/trust`).

## Frontmatter

Every field is optional. Unknown keys are ignored silently, so check spelling.

| Field             | Values                                                                | Omitted                   |
| ----------------- | --------------------------------------------------------------------- | ------------------------- |
| `description`     | what the agent is, one short phrase                                   | the file name             |
| `guidance`        | when to pick it, one sentence starting `Use …`                        | nothing after description |
| `display_name`    | name for the widget and UI                                            | the file name             |
| `tools`           | `all`, a list, `-name` to remove, `none`                              | `all`                     |
| `delegate`        | `true` to start, read and steer its own agents                        | no delegation tools       |
| `model`           | `provider/modelId`, `haiku`/`sonnet`/…, or `family@latest`            | the caller's model        |
| `thinking`        | `off` `minimal` `low` `medium` `high` `xhigh` `max`                   | the caller's level        |
| `max_turns`       | whole number; `0` is unlimited; a limit must be at least 2            | unlimited                 |
| `prompt_mode`     | `replace` or `append`                                                 | `replace`                 |
| `inherit_context` | `true` copies the caller's conversation into the agent                | `false`                   |
| `locked`          | `true`, or a list of `model` `thinking` `max_turns` `inherit_context` | caller may override all   |
| `visibility`      | `visible`, `hidden`, `disabled`                                       | `visible`                 |
| `fragments`       | list of names from `agents/fragments/<name>.md` beside the file       | none                      |

An invalid `thinking` or `visibility` value is dropped, not rejected: the
agent inherits the caller's thinking level, or stays visible. Lists take
either YAML form: `tools: read, grep` or `tools: [read, grep]`.

There is no foreground setting. Whether an agent runs in the foreground or the
background is always the caller's choice.

## Description and guidance

Together they make the agent's line in the `subagent_start` description:

```text
- auditor (claude-opus-4-6): Security auditor (read-only). Use to review changes that touch authentication, input handling or secrets.
```

The line is name, the model if the file pins one, `description`, a period,
then `guidance`. Write both for a caller choosing between a dozen of these
lines.

- `description` says what the agent is. A noun phrase, under about ten words.
  Mark a read-only agent `(read-only)`. Do not end it with a period.
- `guidance` says when to choose it, as one sentence starting `Use for …`,
  `Use to …` or `Use when …`. Name the situations, not the agent: the name is
  already on the line.
- Do not repeat words between the two. `Software architect (read-only)` with
  `Use for architecture and implementation planning.` reads cleanly;
  `Architect for planning` with `Use for planning.` wastes the line.
- Draw the boundary with neighbouring types. If a caller could confuse it with
  `general-purpose` or `review`, the guidance should say which work is this
  one's.
- Multi-line YAML values are joined into one line, so keep each to a sentence.

## Prompt mode

Both modes put the caller's own system prompt first, then an
`<active_agent name="…"/>` tag and the environment, then the file's body.

- `replace` (the default): the body goes last with no wrapper, so the
  agent's own role and rules have the final say.
- `append`: the body is wrapped in `<agent_instructions>`. With an empty body
  the agent is a plain copy of its caller, which is what the built-in
  `general-purpose` is.

Leave `prompt_mode` out for any agent with a role of its own. Set `append`
only for a near-copy of the caller with a small addition.

## Tools

- Omit `tools` (or `all`) to give every tool the caller's session has.
- A list is an allowlist: `tools: [read, grep, find, ls, bash]`. Name extension
  tools explicitly too (`stash_get`, `git_pr_status`, `mcp__github__*`).
- `-name` removes from the selection: `tools: [all, -write, -edit]`.
- Read-only agents usually take `read, bash, grep, find, ls, stash_get,
  stash_list`, plus a body that forbids writing; `bash` can still write, so the
  instructions carry the restriction.
- `subagent_start`, `subagent_get` and `subagent_steer` are withheld unless the
  file sets `delegate: true`; listing them in `tools` does not count. With
  `delegate`, all three are added even to an allowlist, and `-subagent_steer`
  style exclusions still win. Only coordinating agents should delegate, and
  their body should say when to stop delegating: there is no depth limit.
- `ask` and `parent_notify` are always added; they reach only the caller.

## Visibility

- `visible`: listed in `subagent_start` and spawnable.
- `hidden`: not listed, but spawnable by name. Use it for an agent that a
  skill or another agent's instructions call explicitly, such as a step in a
  workflow, so it does not crowd the list or get picked for unrelated work. The
  skill names it directly:
  `subagent_start({ subagent_type: "changelog-writer", description: "…", prompt: "…" })`.
- `disabled`: refused everywhere, including as a main profile. Use it to turn
  off a built-in for one project with a two-line file:

  ```markdown
  ---
  visibility: disabled
  ---
  ```

## Locked fields

The caller's `model`, `thinking`, `max_turns` and `inherit_context` win over
the file by default. Lock a field only when the agent is wrong without it, not
as a preference:

- `locked: true` holds every one of those fields the file sets.
- `locked: [model]` holds the named fields, even ones the file leaves unset
  (then the agent inherits instead of taking the caller's override).

The caller is told when a lock discards its value.

## Fragments

To share text between agents, put it in `agents/fragments/<name>.md` beside
the agent file and list it: `fragments: [git-rules, read-only]`. Fragments are
placed in order before the body. Missing fragments fail the spawn with the
path that was tried.

## Writing the body

The caller's prompt (project rules, AGENTS.md, skills) is already the base,
so the body only adds the role:

1. One line saying what the agent is and what it is for.
2. Its boundaries: what it must not do (write files, change git state, fix
   instead of report), stated plainly.
3. How to work: the steps or checks the role always follows.
4. What to return: the exact shape of the final message, and a length cap
   when the caller only needs a verdict.

The built-ins in `extensions/pi-subagent/agents/` are worked examples:
`review.md` for a verifier with a fixed output format, `explore.md` for a
read-only searcher, `orchestrate.md` for a coordinator that delegates.

## Example: `.pi/agents/migration-writer.md`

```markdown
---
description: Database migration author
guidance: Use to write or change a schema migration and its rollback.
tools: [read, grep, find, ls, bash, edit, write]
thinking: high
---

You write database migrations for this project, and nothing else.

Do not edit application code outside migrations/ and the schema snapshot. If a
change needs application code, say what and stop.

1. Read the latest migrations to match naming and style.
2. Write the forward migration and its rollback in one file.
3. Run the migration test command from the project's AGENTS.md.

Reply with the migration path, the test command and its result, and anything
the caller must change in application code.
```

## Check the result

1. Open `/subagent:agents` and select the agent: confirm the source path,
   visibility, tools, model, prompt mode and that the body is the one you wrote.
   An `[invalid]` badge means the frontmatter is not valid YAML; its detail
   shows the parse error. Until it is fixed the agent is unlisted and refused,
   and it still hides any global or built-in agent of the same name.
2. Read the agent's line as a caller would. Could it be confused with another
   line? Sharpen `guidance` until it could not.
3. A new or edited file is used at the next spawn, but the `subagent_start`
   list is built when the extension loads: run `/reload` (or restart) before
   expecting a caller to pick it from the list. A hidden agent needs no reload.
4. Spawn it once on a small real task and read its transcript.
