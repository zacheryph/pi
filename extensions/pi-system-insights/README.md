# pi-system-insights

Read-only inspectors for Pi 1.1.0+ sessions. No model calls, tool activation,
settings changes, external editor, or skill-file loading.

## Commands

- `/system:prompt` — scroll through the current Pi system prompt, with tool/skill
  catalog sections replaced by labeled redaction markers.
- `/system:tools` — list accessible tools. Enter opens description, input schema,
  prompt snippets/guidelines, exposure, namespace, and source metadata.
- `/system:skills` — list discovered skills, including command-only skills.
  Enter shows description, path, source, and loading evidence—not instruction
  contents. Opening this viewer never marks a skill loaded.

Fullscreen uses a focused, centered overlay at 80% terminal width and height.
Views have a centered title, rounded border, one-cell inner/outer padding, and
contextual footer help. On tiny terminals, chrome/padding shrink to fit. Tool and
skill indexes show names/status only; descriptions remain searchable and appear
in details. Fields align their labels and values; skills have right-aligned
`[loaded]` badges and a color legend in both list and detail views.

Regular mode uses a bounded custom screen instead: Pi 1.1.0 overlays can leave
fragments in terminal scrollback. RPC, print, and JSON modes do not open viewers.

Use ↑/↓ to navigate, Enter to inspect, Esc to return to the list, then Esc to
close. Type to filter lists; Esc clears an active filter before closing. Ctrl+C
closes from any view. PageUp/PageDown and Home/End scroll text or navigate lists;
Pi fullscreen paging remaps are honored. Fullscreen mouse wheel scrolls too.
Views are snapshots taken when each command opens; reopen to refresh.

## What the labels mean

**Prompt** means Pi's current effective prompt from `ctx.getSystemPrompt()`.
Request-time transforms and provider-specific instructions may differ; this is
not a claim about exact wire bytes or the last request. Text displays literally,
not as Markdown; terminal control sequences are stripped for safe rendering.
Recognized top-level `<tools>`, `<skills>`, and legacy `<available_skills>` catalog
sections are replaced in place with `--- TOOLS [redacted] ---` or
`--- SKILLS [redacted] ---`. Other instructions, rules, nested project context,
and code examples stay unchanged. Unrecognized opaque prompt overrides are not
heuristically scrubbed. This is display folding, not security-grade redaction:
the real prompt sent to the model is never changed.

**Tools** include active non-hidden tools and registered `codemode`/`deferred`
tools callable through other tools. Inactive direct/model-only tools and hidden
tools are omitted. Direct declarations and indirect/discoverable tools are labeled
separately. Loadout-hidden declarations may remain executable indirectly.

Descriptions and input schemas are tool declarations, not necessarily literal
system-prompt text. Details show one primary description and one full input
schema: latest recorded branch declaration when present, otherwise registered
metadata. Origin is labeled; recorded descriptions capture loadout rewrites but
may lag pending changes. Prompt snippets/rules appear as readable construction
metadata, not duplicate JSON dumps. Source and access fields stay compact.
No final provider payload inspection is attempted.

**Skill loading** is observed evidence on the current branch:
successful `read` calls to a known skill file, successful nested reads (including
codemode), or expanded `/skill:name` instructions. Failed/pending reads and raw
command attempts do not count. Explicit offset/limit reads are labeled partial.
A successful nested read does not prove its caller forwarded the instructions.

A compaction or branch summary after the latest observed load marks that skill
**dirty**: instructions may have been summarized away. A later read/invocation
clears that state. Green `[loaded]` means fresh observed loading after the latest
boundary; grey `[loaded]` means not observed or dirty. Footer explains both colors.
Neither color guarantees the instructions remain in model context.
“Not observed” is not proof a skill was never loaded: shell reads, custom tools,
and old incomplete history may leave no recognizable evidence. Flags describe
history, not whether the model followed instructions.

Direct reads and skill invocations are reconstructed from current branch history.
For observed nested skill reads, a small custom session entry preserves only the
normalized path and partial flag across reload/resume. It stores no instruction
contents and never enters model context. Abandoned branches are not scanned.

## Install

Included in the repository root bundle. Reload Pi after enabling its entry point.

Standalone local package:

```bash
pi install /absolute/path/to/pi-personal/extensions/pi-system-insights
```

Do not load standalone package and root bundle copy together.

## Development

From repository root:

```bash
npm run check
npm test
npm run verify:bundle
```

Package-only:

```bash
npm run check --workspace=pi-system-insights
npm test --workspace=pi-system-insights
```
