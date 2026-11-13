# pi-surface

A small library (not an extension) that describes views without drawing them.
An extension builds a view model once; [pi-ui](../pi-ui/README.md) draws it in
the terminal, and another renderer, such as a web app over Pi's RPC mode, can
draw the same model. It has no runtime dependencies: it imports neither
`@earendil-works/pi-tui` nor `@earendil-works/pi-coding-agent`, and a test fails
if it does.

```ts
import { actionRegistry, type ExplorerModel } from "#surface";
```

## The rule

A view model is JSON; behaviour is an action reference. A model must survive
`JSON.parse(JSON.stringify(model))` unchanged, so it holds no functions, class
instances, `undefined` array items, `NaN` or `Infinity`. Where a view needs
behaviour (load a detail, clear a marker) it carries an `ActionRef`:

```ts
type ActionRef = { action: string; args?: JsonValue };
```

The renderer resolves the reference through the session's action registry at
the moment it would have called a callback.

## Model types

| Type                                                             | What it is                                                              |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `Tone`, `Span`, `Line`, `Badge`, `Title`                         | Plain, untrusted text with a semantic tone; the renderer picks colours  |
| `Block`, `DetailContent`, `DetailModel`                          | Structured detail: headings, fields, text, bullets, numbered lines      |
| `Hint`                                                           | A footer hint: keys, action, priority                                   |
| `WidgetRow`, `WidgetModel`                                       | A compact heading with rows, right-column fallbacks and overflow groups |
| `ExplorerItem`, `ExplorerTab`, `ExplorerMarker`, `ExplorerModel` | A filterable list that opens into detail content                        |
| `ActionRef`, `JsonValue`, `JsonObject`                           | Behaviour by reference, and the JSON the model is made of               |

Every model type is a type alias, so a model is assignable to `JsonValue`.
`isJsonValue`, `isJsonObject`, `isDetailContent`, `isBlock`, `isLine`, `isSpan`
and `isActionRef` check data that arrives from elsewhere, such as an action's
result.

In an `ExplorerModel`, `loadDetail` and `onOpen` are dispatched with the
reference's `args` (an object) plus `{ id }` of the opened item;
`marker.onClear` gets `{ ids }`. `loadDetail` must resolve to `DetailContent`.
Row budgets and docking are terminal layout and stay in pi-ui's `WidgetView`.

## Action registry

Actions live on the session's event bus (`pi.events`), not on `globalThis`:
every subagent is a session in the same process with its own bus, and each
extension loads its own copy of this library. A definition is a listener on the
`surface:actions` channel; listing and dispatching are requests on that channel,
answered synchronously like `stash:preview`.

```ts
const actions = actionRegistry(pi.events);
pi.on("session_start", () => {
  actions.dispose(); // in case session_start runs again on this factory
  actions.define({
    id: "stash.inspect", // <extension>.<verb>, lowercase, dot separated
    title: "Show a stash entry's details and content preview",
    parse: (args) => {
      if (!isJsonObject(args) || typeof args.id !== "string") throw new Error("expected { id }");
      return { id: args.id };
    },
    handler: async ({ id }) => detailBlocks(id), // JSON, or nothing
  });
});
pi.on("session_shutdown", () => actions.dispose());
```

| Function                         | Result                                                                |
| -------------------------------- | --------------------------------------------------------------------- |
| `defineAction(bus, definition)`  | Defines one action; returns the function that removes it              |
| `listActions(bus)`               | `{ id, title }[]` sorted by id                                        |
| `dispatchAction(bus, id, args?)` | Promise of the handler's JSON result, or `undefined`                  |
| `actionRegistry(bus)`            | `define`, `list`, `dispatch`, and `dispose` for everything it defined |

`defineAction` throws for an id that is not `<extension>.<verb>` (one or more
lowercase dot-separated segments after the extension, such as
`git.worktree.remove`), for an empty title, and for an id already defined on
that bus. `dispatchAction` rejects with `Unknown action "<id>".`, with
`Arguments for action "<id>" are not JSON.`, with
`Invalid arguments for "<id>": <parse error>`, with
`Action "<id>" returned a value that is not JSON.`, and with the handler's own
error.

Define actions on `session_start` and dispose them on `session_shutdown`. Pi
keeps the same bus across `/reload` and runs the extension factory again, so a
definition made in the factory and never removed would answer twice.

## How pi-ui uses it

pi-ui imports these types and re-exports them under the same names, so
extensions keep importing from `#ui`. Its `ExplorerView` is an `ExplorerModel`
whose `loadDetail`, `onOpen` and `marker.onClear` may also be callbacks. Pass
the session's bus to resolve references:

```ts
await showExplorer(ctx, model, { command: "/stash", actions: pi.events });
```

A failed or unknown action, or one that returns something other than
`DetailContent`, shows `Couldn't load: <message>` in place, as a failed loader
does. `onOpen` and `onClear` actions run in the background and their failures
are dropped.
