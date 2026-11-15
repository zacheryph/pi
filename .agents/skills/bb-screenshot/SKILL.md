---
name: bb-screenshot
description: Run a private bb with this repository's pi-surface plugin (bb-plugin/) and a Pi that plays a scripted fake model, then screenshot or measure the plugin's slots in headless Chromium. Threads get real Pi sessions with the bundle and pi-bb loaded, so the Todos and Subagents stack cards, the context row, the Pi tab and the sessions page show live data with no API key; a fixture command shows the plugin's canned session instead. `bb-shot.mjs --check` measures the stack cards' and context row's insets in the browser and fails when they are uneven. Use when asked for a screenshot of the bb integration, for docs/bb or README images, to check a bb-plugin layout or spacing change by eye or by numbers, or to try the plugin in bb end to end.
---

# Screenshot and check the bb integration

The screenshots are of real bb (`bb-app` from npm, pinned to the version
`docs/bb/ui-slots.md` was checked against) with the plugin installed from
`bb-plugin/`, and of real Pi sessions running this bundle. Only the model is
fake: bb starts Pi through a wrapper that adds a scenario from
`packages/pi-scripted-model` (see the tui-screenshot skill for writing one).

Nothing touches your own setup:

- One work directory holds bb's data directory, the bb-app install, a throwaway
  Pi agent directory and a demo Git repository: `$TMPDIR/pi-bb-harness`, or
  `--work <dir>` / `PI_BB_HARNESS`. `~/.bb`, `~/.pi` and their sessions are
  never read. bb listens on loopback, port 38990 by default (`--port`), so it
  can run beside a bb on the default 38886.
- Pi runs under `env -i` with only `PATH`, `HOME`, locale and bb's own
  variables (`BB_*`, `PI_BB_*`): no API key reaches it, and the scenario
  registers its model only because the wrapper sets `PI_SCRIPTED_MODEL=1`.
- bb starts with telemetry off, onboarding skipped and in-app updates off. Its
  community marketplace URL is pointed at a dead local address: bb fetches that
  catalog directly, bypassing `HTTPS_PROXY`, and where `getbb.app` is blocked
  (sandboxes, CI) the reset socket crashes bb's server in a loop.

Requirements: `npm install` at the root (Pi), Node 22.19 or later, and
Playwright with Chromium (`require("playwright")` must resolve from the
repository, the skill or the global npm root; Claude Code cloud containers have
it). `up` installs bb-app and the plugin's own dependencies on first use.

## 1. Start bb

```bash
node .agents/skills/bb-screenshot/scripts/bb-harness.mjs up
```

Installs bb-app into the work directory (once), starts bb detached, waits for
the scripted model to appear in `bb provider models pi`, creates the demo
project and installs the plugin from `bb-plugin/`. Running `up` again on a live
harness does nothing. bb's log is `<work>/bb.log`, its own logs are under
`<work>/bb-data/logs/`.

## 2. Make a thread

A live session from a scenario (default
`scenarios/bb-session.ts`: seven tasks, two running subagents, a stash entry):

```bash
node .agents/skills/bb-screenshot/scripts/bb-harness.mjs thread \
  --prompt "Move retries into the queue worker" --title "Retry queue worker"
```

It prints the thread id once the Pi session has connected through pi-bb and the
scripted turn has ended. `--scenario <file.ts>` picks another scenario; it stays
selected for later threads. Subagents a scenario starts keep running, so the
Subagents card stays populated.

The plugin's canned fixture session (`bb-plugin/fixture.ts`, the data in
`docs/bb/ui-slots.md`'s images):

```bash
node .agents/skills/bb-screenshot/scripts/bb-harness.mjs fixture
```

The plugin refuses a fixture for a thread whose Pi session is connected, so this
spawns a quiet thread, stops its Pi, waits for the session to go from live to
saved (15 s) and loads the fixture. Fixtures live in the plugin's memory: `reload` or a bb
restart clears them; run `fixture` again.

## 3. Screenshot

```bash
node .agents/skills/bb-screenshot/scripts/bb-shot.mjs --thread <id> \
  --expand --target stack --out /path/to/stack.png
```

| Option                | Default  | Effect                                                                     |
| --------------------- | -------- | -------------------------------------------------------------------------- |
| `--thread <id>`       |          | Open `/threads/<id>` and wait for the stack cards                          |
| `--path <path>`       |          | Open another page, e.g. `/plugins/pi-surface/sessions/gallery`             |
| `--target <name>`     | page     | Crop to `todos`, `subagents`, `context`, `stack` (all three) or `composer` |
| `--selector <css>`    |          | Crop to these elements too; the crop is the union of every match           |
| `--expand`            |          | Open the Todos and Subagents cards                                         |
| `--click <css>`       |          | Click, in order, after expanding (open the Pi tab, a menu)                 |
| `--wait-for <css>`    |          | Wait for an element before anything else                                   |
| `--theme`             | dark     | `dark` or `light` (bb follows the system scheme)                           |
| `--width`, `--height` | 1280×900 | Viewport. Try 390 wide for bb's compact layout                             |
| `--scale`             | 2        | Device pixels per CSS pixel                                                |
| `--pad`               | 8        | CSS pixels around the crop                                                 |
| `--server <url>`      | harness  | Use another bb (yours, say) instead of the harness's                       |

The pointer is parked and focus cleared before the capture, so hover styles and
focus rings stay out. Open the PNG with Read before handing it over.

## 4. Check the spacing

```bash
node .agents/skills/bb-screenshot/scripts/bb-shot.mjs --thread <id> --expand --check
```

Prints each card's insets in CSS pixels and exits 1 when they are uneven:

- `header.iconLeft`, `header.textLeft`: bb's own header (12 px, 32 px). This is
  the reference; the plugin cannot change it.
- `body.left`, `body.right`, `body.top`: the plugin's body content inside the
  card, from the divider under the header. All three must equal the header's
  icon inset.
- `body.textLeft`: the first row's text (or pill) column; must equal the
  header's title column.
- `context.iconLeft`: the Pi segment in the context row; must equal the
  header's icon inset.

Collapsed cards are checked by their header only, so pass `--expand`. Use
`--measure` to print without failing. `insetProblems` is unit-tested in
`scripts/bb-screenshot.test.mjs`.

## Changing the plugin

Edit `bb-plugin/`, then rebuild and reload the installed copy (the harness's
sessions stay connected):

```bash
node .agents/skills/bb-screenshot/scripts/bb-harness.mjs reload
```

What bb draws and what the plugin draws, for spacing work: bb owns the card
frame, the header (`px-3 py-1.5`, 14 px icon, 6 px gap) and the collapse row at
the bottom; the plugin owns everything between the divider and the collapse row,
and its context segment's own padding inside the row's 4 px inset. bb's source
(`get-bb/bb`, `apps/app/src/components/promptbox/banner/`) is the reference for
its classes.

## The bb CLI and cleanup

```bash
node .agents/skills/bb-screenshot/scripts/bb-harness.mjs bb pi-surface list
eval "$(node .agents/skills/bb-screenshot/scripts/bb-harness.mjs env)"   # then plain `bb …`
node .agents/skills/bb-screenshot/scripts/bb-harness.mjs down            # stop bb
node .agents/skills/bb-screenshot/scripts/bb-harness.mjs down --clean    # and delete the work directory
```

When something fails: `<work>/bb.log` shows the launcher (a server that keeps
restarting crashed; its stack is in `<work>/bb-data/logs/process-server-*.json`),
and `bb thread log <id>` shows what Pi did. A thread whose Pi died after a bb
restart shows its saved snapshot (`bb pi-surface list` says `saved`) until its
next turn starts Pi again.
