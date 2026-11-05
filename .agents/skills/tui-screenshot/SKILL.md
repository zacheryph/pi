---
name: tui-screenshot
description: Take a PNG screenshot of Pi's TUI with this repository's bundle loaded and a scripted fake model, so widgets, tool rows, overlays and commands can be shown in any state without an API key. A scenario file scripts what the model does (tool calls, subagents, text); a driver runs Pi in a private tmux server with a throwaway agent directory, types prompts, waits for the screen to reach that state, and renders the capture through Chromium. Use when asked for a screenshot or picture of the TUI or of an extension's widget, for README or PR images, or to check a rendering change by eye.
---

# Screenshot the TUI

The screenshot is of the real app: Pi from `node_modules`, every extension in
the root manifest, real tools and widgets. Only the model is fake. Pi's
built-in test provider plays a script you write, in the main session and in
every subagent, because Pi hands registered providers down to child sessions.

Nothing here can reach a production session:

- The scenario is loaded only by the driver, with `-e`. `.agents/` is not in
  the bundle manifest, and `scripts/verify-bundle.mjs` fails if it ever is.
- A scenario registers nothing unless `PI_SCRIPTED_MODEL=1` is set. Only the
  driver and the test harness set it.
- Pi runs under `env -i` with a fresh agent directory and `TMPDIR`, which are
  deleted afterwards. No API keys or tokens get through, so no real provider is
  available, and your settings, sessions and trust list are never read.

Requirements: `npm install` at the root, `tmux`, and Playwright with Chromium
(`require("playwright")` must resolve; Claude Code cloud containers have it).
Nerd Font icons need a Nerd Font v3 symbols font. See step 3.

## 1. Script the scenario

A scenario is a Pi extension built with the scenario library in
`packages/pi-scripted-model/src/scenario.ts`, the same one the in-process test
harness uses (see its [README](../../../packages/pi-scripted-model/README.md)).
Start from `scenarios/todo-subagent.ts`, which opens the Todos and Subagents
widgets. Keep a reusable scenario in `scenarios/`. A one-off scenario can go in
a scratch directory and import the library by absolute path.

```ts
import {
  defineScenario,
  startAgent,
  text,
  thinking,
  tool,
  HOLD,
} from "../../../../packages/pi-scripted-model/src/scenario.ts";

export default defineScenario({
  title: "fix-login-redirect", // session name pi-tldr shows in the footer
  replies: [
    // The reply to the first user turn: one entry per model response.
    [
      [text("Planning first."), tool("todo_upsert", { tasks: [/* … */] })],
      [
        startAgent({
          type: "Explore",
          description: "Find the redirect",
          prompt: "Find …",
          steps: [[tool("read", { path: "README.md" })]],
        }),
      ],
      "Started an agent.", // a string ends the turn
    ],
    // The reply to the second user turn.
    [HOLD], // keep the turn open so Pi shows "Working"
  ],
});
```

- **Steps.** A list of blocks is one assistant message. Pi runs its tool calls
  for real and then asks for the next step. A string ends the turn. A turn with
  no steps left ends quietly.
- **Tool arguments** must match the real tool's schema, or Pi shows the
  validation error instead. Read the tool's parameters in its extension first.
- **User turns** include the follow-ups Pi starts on its own, such as a
  subagent completion notice. Add a reply for them if the screenshot is taken
  afterwards. Context an extension adds mid-turn, such as pi-todo's task list
  after a tool result, does not start a turn.
- **Subagents.** `startAgent` builds a `subagent_start` call. The child is
  matched by its `prompt`, so keep prompts unique. It plays `steps`, then holds
  and stays running, which keeps it in the Subagents widget. A string step
  finishes it. Put extra parameters (`foreground`, `handoff`) in `options`.

## 2. Run the driver

From the repository root:

```bash
node .agents/skills/tui-screenshot/scripts/screenshot.mjs \
  --scenario .agents/skills/tui-screenshot/scenarios/todo-subagent.ts \
  --prompt "Audit the TUI widget padding and add tests" \
  --wait-for "2 running agents" \
  --out /path/to/todo-subagent.png
```

The driver waits until Pi's footer shows `scripted-model`, then runs the
actions in the order given:

| Action            | Effect                                                                   |
| ----------------- | ------------------------------------------------------------------------ |
| `--prompt <text>` | Type the text and press Enter. Slash commands work too: `/todo`.         |
| `--keys <keys>`   | Send tmux key names, space-separated: `C-o`, `Escape`, `Down Down Enter` |
| `--wait-for <re>` | Poll the screen until the regular expression matches.                    |
| `--sleep <ms>`    | Wait.                                                                    |

After the last action it waits `--settle` ms (default 500), captures the pane
and renders it.

| Option                  | Default             | Effect                                                        |
| ----------------------- | ------------------- | ------------------------------------------------------------- |
| `--cols`, `--rows`      | 120, 40             | Terminal size. Try narrow widths too; see `AGENTS.md`.        |
| `--cwd <dir>`           | repository root     | Pi's working directory, pre-trusted.                          |
| `--agent-file <file>`   |                     | Copy a config file (`todo.json`, …) into the agent directory. |
| `--timeout <ms>`        | 30000               | Limit for each wait.                                          |
| `--symbols-font <file>` | first `fc-list` hit | Nerd Font used for icon glyphs.                               |
| `--scale <n>`           | 2                   | Device pixels per CSS pixel.                                  |
| `--ansi`, `--html`      |                     | Also write the raw capture or the rendered page.              |
| `--keep`                |                     | Leave Pi running and print the `tmux attach` command.         |
| `-- <pi args>`          |                     | Pass extra arguments to Pi.                                   |

Wait for text that appears only once the state you want is on screen, such as
a footer count or a widget row. Do not wait on a spinner frame or a timer.

On failure the driver prints the last screen. A timeout on `scripted-model`
means Pi did not start: the screen shows why (a prompt, an extension error).

## 3. Look at the image

Open the PNG with Read before handing it over, and check:

- **Empty boxes** where icons belong mean the symbols font is missing or too
  old. `fc-list | grep -i nerd` shows what is installed. Pass a
  `SymbolsNerdFontMono-Regular.ttf` from Nerd Fonts v3 with `--symbols-font`.
  If none can be downloaded, say which icons are missing.
- **Warnings or errors** in the transcript come from the run, not the widget.
  Fix the scenario rather than cropping them out.
- **Alignment.** Each non-ASCII character is drawn in a box of its terminal
  cell width, so columns should line up. If they do not, check the capture with
  `--ansi` before blaming the renderer.

Colors are a fixed dark palette, not your terminal theme.

## Rendering without Pi

`scripts/render-ansi.mjs` renders any terminal text with SGR color codes, such
as a component's `render()` lines joined with newlines:

```bash
node .agents/skills/tui-screenshot/scripts/render-ansi.mjs capture.ansi out.png [--no-frame]
```

The renderer and the example scenario are tested by
`scripts/tui-screenshot.test.mjs`; the scenario library by
`packages/pi-scripted-model`.
