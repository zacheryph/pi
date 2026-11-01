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

## API

| Module          | Exports                                                                                                      | Responsibility                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `text.ts`       | `sanitizeText`, `sanitizeLine`, `firstPhysicalLine`                                                          | Untrusted plain text normalization; separate trusted-row clipping                   |
| `layout.ts`     | `bodyRow`, `splitColumns`, `labeledRule`, `layoutPanel`, `renderPanel`, `BoundedLines`, `cells`, `titleText` | Width-aware rows, frames, titles, rules, column fallback and explicit row budgets   |
| `icons.ts`      | `ICONS`, `SPINNER`                                                                                           | Shared semantic vocabulary; callers schedule animation                              |
| `navigation.ts` | `navigationDelta`, `navigationHints`                                                                         | Navigation and displayed hints from the same Pi keybindings                         |
| `modal.ts`      | `openModal`, `PassiveOverlay`                                                                                | Capturing dialogs and separately owned noncapturing overlays                        |
| `detail.ts`     | `TextViewport`, `DetailView`, `showDetail`, `viewHeight`                                                     | Scrollable text or caller-rendered content, including live loading/results/errors   |
| `explorer.ts`   | `Explorer`, `showExplorer`, `snapshotExplorer`                                                               | Snapshot filtering, tabs, badges, markers, review actions and lazy detail drilldown |
| `widget.ts`     | `renderWidget`, `Widget`                                                                                     | Pure compact heading/body/overflow rendering                                        |
| `types.ts`      | `UITheme`, `UIColor`, `UIKeys`, `UISurface`, `Title`, `DisposableComponent`                                  | Narrow SDK collaborators and presentation types                                     |

## Explorers

```ts
await showExplorer(ctx, {
  title: { label: "Findings", icon: ICONS.tasks },
  note: "Read-only snapshot",
  items: [
    {
      id: "auth",
      label: "Auth",
      description: "session renewal",
      marker: true,
      badge: { label: "ready", color: "success" },
    },
    { id: "routing", label: "Routing" },
  ],
  tabs: [
    { label: "All", ids: ["auth", "routing"] },
    { label: "Recent", ids: ["auth"] },
  ],
  legend: [{ label: "●", meaning: "unreviewed", color: "accent" }],
  onOpen: (id) => reviewShownItem(id),
  onReview: (ids) => reviewShownItems(ids),
  loadDetail: (id, signal) => loadBoundedPreview(id, signal),
});
```

The callbacks above are supplied by the consuming extension. They own review
state, filesystem access, data limits and domain-specific formatting. `detail`
on an item is an alternative to `loadDetail`; the loader, when supplied, takes
precedence. Nothing is loaded until Enter opens an item. Reopening loads again.
Errors render in place. Back/close/disposal aborts that load, and stale results
are ignored even if a loader does not honor its signal.

IDs are opaque and remain unchanged; use unique IDs. Labels, descriptions,
badges, notes, hints, legends and plain detail strings are normalized before
styling. Arrays, tabs, nested title/badge objects and marker state are copied.
Markers clear locally after opening or reviewing, without mutating input data.
Selection preserves caller ordering, including ordered tab subsets. Filtering
searches label/status/description. With a filter, Esc clears it before closing.

Arrow keys, configured Pi alternate-screen paging/top/bottom bindings and
Home/End navigate. Enter opens details, Esc returns, Ctrl+C closes,
Tab/Shift+Tab switches views, and Ctrl+R reviews marked filtered items when a
callback is present. Wheel navigation is fullscreen-only. Callbacks are
synchronous; adapters should handle domain errors before returning.

`showExplorer` snapshots before the asynchronous renderer probe. For custom
mounting or height limits, construct `Explorer` directly through `openModal`.

## Detail views and async work

For a static text view:

```ts
await showDetail(ctx, { title: "Details", content: "Plain text", closeOnEnter: true });
```

For work that must render loading immediately and cancel on close:

```ts
await openModal<void>(ctx, (tui, theme, keys, done, signal) => {
  const view = new DetailView({
    tui,
    theme,
    keys,
    title: "Summary",
    content: "Loading…",
    done: () => done(undefined),
  });
  void Promise.resolve()
    .then(() => loadSummary(signal))
    .then(
      (text) => {
        if (!signal.aborted) view.setContent(text);
      },
      (error) => {
        if (!signal.aborted) view.setContent(`Could not load: ${String(error)}`);
      },
    );
  return view;
});
```

The caller supplies `loadSummary`; the library performs no model or filesystem
requests. Return the view immediately rather than awaiting the work in its
factory. `setContent` requests a render and normally resets scrolling. Pass
`false` as its second argument to retain the scroll position, clamped to the new
content. Disposal prevents subsequent content updates.

`TextViewport` provides the same scrolling/cache logic without owning a frame or
input. Plain strings are sanitized and wrapped. A `DetailContent` renderer
`(width) => rows` instead returns **trusted, already styled physical rows** for
richer results; it owns any wrapping. `invalidate()` clears its cache on theme or
other external changes. Size changes reflow/reclamp automatically.

## Modal and passive overlay lifetimes

`openModal` requires interactive TUI mode, probes the actual renderer, then opens
an 80% centered overlay in fullscreen or a normal custom view in regular mode.
It notifies and returns `undefined` in print/RPC/headless mode, without invoking
the factory. `done` and disposal are idempotent; the factory's abort signal ends
on completion, disposal or failure. Focus, key-release preferences, cursor
markers and method receivers are retained by the lifecycle wrapper.

Views default to 80% of terminal rows. A direct `DetailView`/`Explorer` constructor
accepts `heightFraction`. If customizing `overlayOptions.maxHeight`, give the view
a matching fraction so its footer fits without renderer cropping.

Use `PassiveOverlay` only with a fullscreen TUI obtained from the host:

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
false outside fullscreen or after disposal; ownership transfers only on success.
Callers still own session subscriptions, visibility policy, settings and mode
changes. This utility never opens a capturing dialog to mount a passive overlay.

## Widgets and layout

```ts
const view = {
  title: { label: "Tasks", icon: ICONS.tasks },
  right: ["● 2 new · 3/8", "3/8"],
  rows: [
    {
      left: theme.fg("accent", "auth: renew sessions"),
      right: ["✓ completed", "✓"],
      minLeftWidth: 8,
    },
  ],
  maxRows: 5,
  maxVisible: 4,
};
const lines = renderWidget(view, width, theme);
// Or return new Widget(view, theme) from an extension-owned setWidget factory.
```

Widget input rows/metadata are trusted, already styled strings. Titles and
`emptyText` are plain text. Status mapping, sorting, linger, queued counts,
progress/review/assignee badges and editor/footer reservations belong to the
extension. It supplies a finite `maxRows` and optionally `maxVisible` and an
`omitted` count. Overflow reserves one row; a one-row budget shows only the
heading. The helper never starts animation timers, polls or subscribes to events.
`Widget` snapshots input and offers `setView`; its caller requests rendering.

Rows are clipped to one physical row and inset by a space on both sides.
Widths 0–2 cannot fit padded content and produce blank body rows. Header rules
may span the full width. Right-column candidates are fallbacks in preference
order; a candidate is dropped when it exceeds `maxRightWidth` or would violate
`minLeftWidth`. Pre-truncate a long status using Pi's `truncateToWidth` when that
is the desired policy. The right column is dropped before shortening a left
heading fallback in `labeledRule`.

`layoutPanel` reserves one body row, then footer rows, then optional header rows.
At widths below seven or heights below three it uses padded unframed rows.
`renderPanel` consumes that layout and returns bounded rows, preserving trusted
ANSI and Input cursor commands. Frame titles are normalized. `BoundedLines`
clips trusted inline tool-result rows without wrapping them.

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
all supported command-string forms, snapshots and cursor markers, keyboard
remapping, filter/paste/tabs/review, lazy load cancellation/errors, modal disposal,
passive handle ownership, widget overflow, and Pi's real source loader. No model
calls, user configuration changes or local network listeners are required.
