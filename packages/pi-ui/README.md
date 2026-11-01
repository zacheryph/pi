# pi-ui

Private terminal UI library for this Pi source bundle. It is not an extension and
registers no tools, commands, widgets, overlays, or event listeners on import.
This first PR implements the library portion of [#45](https://github.com/zacheryph/pi/issues/45);
existing extensions still use their original implementations. Migrations are separate work.

Use relative source imports. Git-installed bundles do not link workspaces or build
TypeScript, and the package's SDK-loader test verifies this import path:

```ts
import {
  DetailView,
  Explorer,
  ICONS,
  HINT_PRIORITY,
  PassiveOverlay,
  Widget,
  openModal,
  renderWidget,
  sanitizeLine,
  sanitizeText,
  showDetail,
  showExplorer,
} from "../../../packages/pi-ui/src/index.ts";
```

Pi supplies `@earendil-works/pi-tui` at runtime; coding-agent is used for SDK types.
There are no added runtime dependencies or generated declarations. The MIT notice
in `LICENSE` covers browser/sanitizer/rule behavior adapted from this bundle's
vendored code.

**Fullscreen only.** The library targets Pi's fullscreen TUI. It does not probe
the renderer or fall back to Pi's regular renderer: modals always open as centered
overlays, wheel input is always handled, and `PassiveOverlay` always mounts.

## Design rule: extensions describe meaning, the library decides appearance

Extensions never pass pre-styled ANSI to the high-level views. They pass plain,
untrusted text annotated with semantic **tones**, and structured data for the
parts that vary (counts, hints, fallbacks, groups). The library sanitizes once,
maps every tone to a theme color in one place, and owns spacing, selection,
footers, headers, overflow text and truncation. This keeps every browser,
detail view and widget consistent and removes per-extension styling forks.

```ts
type Tone = "default" | "accent" | "muted" | "dim" | "success" | "warning" | "error";
type Span = string | { text: string; tone?: Tone; bold?: boolean };
type Line = Span | readonly Span[]; // e.g. [{ text: handle, tone: "accent" }, { text: " — note", tone: "muted" }]
type Badge = { text: string; tone?: Tone }; // right-hand status, default tone "dim"
```

Shared conventions the library enforces:

- Selected list rows are `accent` across the whole label (badges keep their tone);
  the selection pointer is `→` and markers are always `accent` `●`.
- Clipped text always ends in `…` (rows, columns, rules, `BoundedLines`).
- Frame titles are centered; `detail` renders as a breadcrumb (`Todos / t1`).
- Icons are followed by two spaces (`ICON_GAP`) because Nerd Font glyphs can
  overrun their measured cell.
- Header rows (filter, tabs, notices) are separated from the content by a plain
  border-colored divider, dropped first when the panel is short.
- Footers start with a status divider styled like a widget heading
  (`── 1/5 tasks ─────`), followed by at most two rows of hints. Explorers and
  detail views show no icon; `statusRule`/`footerRows` accept an optional one
  (`── icon  1/5 tasks ─────`) that is dropped before the status clips. Hints wrap
  between entries and the least important are dropped first (`HINT_PRIORITY`:
  actions 0 never drop, view 1, extension 2, navigation 3).
- Keys are formatted once (`formatKey`: `PgUp`, `Ctrl+R`, `Esc`). Navigation is
  advertised as `↑↓ PgUp/PgDn Home/End` from the user's page bindings;
  alternate-screen line/top/bottom bindings still work but are not listed.

## API

| Module          | Exports                                                                                                                                               | Responsibility                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `text.ts`       | `sanitizeText`, `sanitizeLine`, `firstPhysicalLine`                                                                                                   | Untrusted plain text normalization; separate trusted-row clipping               |
| `style.ts`      | `Tone`, `Span`, `Line`, `Badge`, `styleLine`, `styleBadge`, `plainText`, `paint`, `copyLine`, `clip`, `ELLIPSIS`                                      | The single tone → theme mapping and the shared ellipsis                         |
| `layout.ts`     | `bodyRow`, `splitColumns`, `labeledRule`, `divider`, `layoutPanel`, `fitPanelHeight`, `renderPanel`, `BoundedLines`, `cells`, `titleText`, `ICON_GAP` | Low-level width-aware rows, frames, titles, rules and column fallback           |
| `icons.ts`      | `ICONS`, `SPINNER`                                                                                                                                    | Shared semantic vocabulary; callers schedule animation                          |
| `navigation.ts` | `navigationDelta`, `navigationHint`, `formatKey`, `layoutHints`, `hintText`, `Hint`, `HINT_PRIORITY`                                                  | Navigation and prioritized, wrapped footer hints from the same keybindings      |
| `modal.ts`      | `openModal`, `PassiveOverlay`                                                                                                                         | Capturing centered overlays and separately owned noncapturing overlays          |
| `detail.ts`     | `DetailView`, `showDetail`, `Block`, `renderBlocks`, `renderDetail`, `footerRows`, `statusRule`, `TextViewport`, `viewHeight`                         | Structured detail content, live loading/results/errors, scrolling               |
| `explorer.ts`   | `Explorer`, `showExplorer`, `snapshotExplorer`                                                                                                        | Snapshot filtering, tabs, badges, markers, status row and lazy detail drilldown |
| `widget.ts`     | `renderWidget`, `Widget`                                                                                                                              | Pure compact heading/body/overflow rendering                                    |
| `types.ts`      | `UITheme`, `UIColor`, `UIKeys`, `UISurface`, `Title`, `DisposableComponent`                                                                           | Narrow SDK collaborators and presentation types                                 |

## Explorers

```ts
await showExplorer(ctx, {
  title: { label: "Todos", icon: ICONS.tasks },
  noun: ["task", "tasks"],
  notices: [["Read-only snapshot", { text: " · store over size cap", tone: "warning" }]],
  marker: { label: "unreviewed", clearAction: "mark reviewed", onClear: (ids) => review(ids) },
  hints: [{ keys: "/todos:add" }, { keys: "/todos:clear" }],
  items: [
    {
      id: "t1",
      label: [
        { text: "t1", tone: "accent" },
        { text: " — renew sessions", tone: "muted" },
      ],
      search: "auth tokens",
      marked: true,
      badge: { text: "● in progress", tone: "accent" },
    },
    { id: "t2", label: "t2: Write tests", badge: { text: "○ pending" } },
  ],
  tabs: [
    { label: "All", ids: ["t1", "t2"] },
    { label: "Unreviewed", ids: ["t1"], emptyText: "No unreviewed tasks." },
  ],
  emptyText: "No tasks on this branch.",
  loadDetail: (id, signal) => loadBoundedPreview(id, signal),
});
```

The callbacks above are supplied by the consuming extension. They own review
state, filesystem access, data limits and domain-specific formatting. `detail`
on an item is an alternative to `loadDetail`; the loader, when supplied, takes
precedence. Nothing is loaded until Enter opens an item. Reopening loads again.
Loading shows `Loading…`; errors render in place as `Couldn't load: <message>`.
Back/close/disposal aborts that load, and stale results are ignored even if a
loader does not honor its signal.

The status row is library-owned: `2/5 tasks · 8 total · 3 unreviewed` (the total
appears only while a tab or filter narrows the list; the marker count only while
nonzero). With `marker`, every row reserves a marker column. Opening a marked
item, or Ctrl+R on the filtered list, clears marks locally and reports the
cleared ids to `onClear`. Notices are one row each above the list, in list and
detail views, and replace free-form notes and legends. Empty lists show the tab's
`emptyText`, then the view's, then `No <plural>.`; a filter shows
`No matching <plural>.`

Opening an item shows a standard detail header — the label in bold with its badge
right-aligned — followed by its `DetailContent`. IDs are opaque and remain
unchanged; use unique IDs. All other text is normalized before styling. Arrays,
tabs, spans, nested objects and marker state are copied. Filtering searches the
label, badge and `search` text. With a filter, Esc clears it before closing.

Arrow keys, configured Pi alternate-screen paging/top/bottom bindings, Home/End
and the mouse wheel navigate. Enter opens details, Esc returns, Ctrl+C closes,
Tab/Shift+Tab switches views. Callbacks are synchronous; adapters should handle
domain errors before returning. `showExplorer` snapshots synchronously before
opening; for height limits, construct `Explorer` directly through `openModal`.

## Detail content and views

Detail content is structured so headings, fields, bullets and previews look the
same everywhere. A plain string is shorthand for one text block.

```ts
const content: Block[] = [
  {
    fields: [
      ["Status", { text: "in progress", tone: "accent" }],
      ["Assignee", "worker"],
    ],
  },
  { heading: "Findings" }, // a blank row precedes every heading after the first row
  { bullets: ["Tokens expired mid-request", "Added a refresh margin"] },
  { heading: "Contents" },
  { lines: previewLines, numbered: 1 }, // dim right-aligned numbers, hanging wrap
  { text: "Preview stops at 200 lines.", tone: "muted" },
];
await showDetail(ctx, { title: "Details", content, closeOnEnter: true });
```

Fields align their labels (dim) and wrap values under themselves; when labels need
more than half the width they stack above their values. All text is untrusted and
sanitized. `renderBlocks` and `renderDetail` expose the same rendering to custom
views.

For work that must render loading immediately, update its title, and cancel on close:

```ts
await openModal<void>(ctx, (tui, theme, keys, done, signal) => {
  const view = new DetailView({
    tui,
    theme,
    keys,
    title: { label: "TLDR", detail: "session" },
    content: [{ text: "Summarizing…", tone: "muted" }],
    closeOnEnter: true,
    done: () => done(undefined),
  });
  void Promise.resolve()
    .then(() => summarize(signal))
    .then(
      (result) => {
        if (signal.aborted) return;
        view.setTitle({ label: "TLDR", detail: result.title });
        view.setContent(result.blocks);
      },
      (error) => {
        if (!signal.aborted)
          view.setContent([{ text: `Couldn't summarize: ${error}`, tone: "error" }]);
      },
    );
  return view;
});
```

The caller supplies `summarize`; the library performs no model or filesystem
requests. Return the view immediately rather than awaiting the work in its
factory. `setContent` and `setTitle` request a render; `setContent` resets
scrolling unless its second argument is `false`. Disposal prevents later updates.

`TextViewport` provides the scrolling/cache logic without owning a frame or input.
It is the low-level escape hatch for caller-owned passive views: plain strings are
sanitized and wrapped, while a `RowRenderer` `(width) => rows` returns **trusted,
already styled physical rows** (build them with `styleLine`/`renderBlocks` to keep
the shared look). `invalidate()` clears its cache on theme or other external changes.

## Modal and passive overlay lifetimes

`openModal` requires interactive TUI mode and opens an 80% centered overlay. It
notifies and returns `undefined` in print/RPC/headless mode, without invoking the
factory. `done` and disposal are idempotent; the factory's abort signal ends on
completion, disposal or failure. Focus, key-release preferences, cursor markers
and method receivers are retained by the lifecycle wrapper.

Explorers use 80% of terminal rows. A `DetailView` takes only the rows its
content needs, capped at the same 80% (`fitPanelHeight`); the overlay stays
centered on whatever height renders. The footer's `n–m/N lines` position
appears only when content scrolls; otherwise a `DetailView` shows a plain
divider and an explorer's item detail drops the status row entirely. A direct
`DetailView`/`Explorer` constructor accepts `heightFraction` for the height (the
cap, for `DetailView`). If customizing `overlayOptions.maxHeight`, give the view
a matching fraction so its footer fits without renderer cropping.

Use `PassiveOverlay` with the TUI obtained from the host:

```ts
const overlay = new PassiveOverlay(tui);
if (overlay.show(component, { width: "50%", maxHeight: "80%", anchor: "right-center" })) {
  overlay.setHidden(true); // temporary; component remains owned
  overlay.setHidden(false);
}
// On session shutdown or permanent dismissal:
overlay.dispose();
```

It always sets `nonCapturing: true`, never focuses the editor or another overlay,
and removes only its own handle. `hide()` removes/disposes its current component
and allows another `show`; `dispose()` permanently closes the owner. A new width
can remount the same component without disposing it in between. `show` returns
false after disposal; ownership transfers only on success. Callers still own
session subscriptions, visibility policy and settings.

## Widgets

```ts
const view: WidgetView = {
  title: { label: "Subagents", icon: ICONS.agents },
  active: running.length > 0, // accent heading while active, dim while idle
  meta: [`${queued} queued`], // right of the heading rule, ordered fallbacks
  rows: agents.map((agent) => ({
    left: [
      { text: elapsed, tone: "dim" },
      "  ",
      { text: agent.name, bold: true },
      { text: `: ${agent.task}`, tone: "muted" },
    ],
    right: [
      [{ text: `${spinner} ${activity}`, tone: "accent" }],
      [{ text: spinner, tone: "accent" }],
    ],
    keepRight: true, // the narrowest status survives over the left text
    group: agent.running ? "running" : "finished",
  })),
  maxRows: widgetLineBudget(rows),
};
const lines = renderWidget(view, width, theme);
// Or return new Widget(view, theme) from an extension-owned setWidget factory.
```

Status mapping, sorting, linger, queued counts, progress/review/assignee badges and
editor/footer reservations belong to the extension; it expresses them as spans,
fallbacks and groups. `maxRows` counts the heading; `maxVisible` caps body rows;
`Infinity` (or omitting `maxVisible`) means unbounded, e.g. for inline tool
results. Overflow reserves one row and reads `+5 more (3 running, 2 finished)`,
with groups in their order of first appearance. A one-row budget shows only the
heading. The helper never starts animation timers, polls or subscribes to events.
`Widget` snapshots input and offers `setView`; its caller requests rendering.

Rows are clipped to one physical row and inset by a space on both sides. Widths
0–2 cannot fit padded content and produce blank body rows. Header rules may span
the full width. Right-column candidates are fallbacks in preference order; one is
dropped when it would leave the left column empty, unless `keepRight` keeps the
last. Heading metadata is dropped before the title falls back to its label alone.

## Low-level layout

`fitPanelHeight` returns the smallest height (up to a cap) whose layout shows a
given body plus all header, divider and footer rows.
`layoutPanel` reserves one body row, then footer rows, then optional header rows,
then a divider below the header rows (`dividerRows`) when one still fits.
At widths below seven or heights below three it uses padded unframed rows.
`renderPanel` consumes that layout and returns bounded rows, preserving trusted
ANSI and Input cursor commands. These primitives, `splitColumns`, `labeledRule`
and `BoundedLines` accept trusted, already styled strings; produce them with
`styleLine`/`paint` so custom views (such as the subagent watch overlay) share the
tone mapping.

## Sanitization policy

Use `sanitizeText` on untrusted multiline content, and `sanitizeLine` on labels.
Apply consumer-specific size limits **after** normalization. It consumes complete
and incomplete OSC/DCS/APC/PM/SOS commands with their payloads, including C1
forms; strips CSI and other ESC commands; drops unsafe and bidi controls;
normalizes CRLF, lone CR and Unicode line separators to LF; and expands tabs to
four spaces. Single-line normalization replaces LF with spaces. Unicode text,
wide glyphs, combining marks and emoji sequences remain intact.

Pi's `stripTerminalSequences` was evaluated, but its ESC-only early return leaves
C1 string commands intact and does not provide the same incomplete-command
contract. The package therefore keeps one documented sanitizer with a shared
control-sequence test corpus rather than layering overlapping partial strippers.
Do not run it on composed theme ANSI or Input cursor markers. `firstPhysicalLine`
is a different helper: it clips trusted rows at line breaks and preserves styling.

## Validation

```sh
npm run check -w pi-ui
npm test -w pi-ui
npm run check
npm run verify:bundle
```

Tests cover small dimensions, repeated resize, ANSI/wide/combining/emoji text,
all supported command-string forms, snapshots and cursor markers, tone styling,
hint wrapping/dropping, keyboard remapping, filter/paste/tabs/markers, structured
detail blocks, lazy load cancellation/errors, title updates, modal disposal,
passive handle ownership, widget overflow groups and budgets, and Pi's real
source loader. No model
calls, user configuration changes or local network listeners are required.
