# pi-test-helpers

Test helpers shared by every workspace in this repository: temp directories,
polling, themes, render assertions, a fake `ExtensionAPI`, and real Pi sessions
on an offline faux model. Development only: no extension imports it, and it is
not in the bundle manifest. Import a module by relative path, like the other
packages:

```ts
import { tempDir } from "../../../packages/pi-test-helpers/src/temp.ts";
```

Each module stands alone, so a pure unit test does not load Pi's SDK. Modules
marked _vitest_ import vitest; the rest also work under `node:test` (pi-job).

## Cleanup (`src/cleanup.ts`)

Helpers that create something take a `Defer`: where to register its teardown.
Pass vitest's `onTestFinished` (it works in tests, helpers and `beforeEach`) or a
`node:test` context `t`. Teardowns run when the test ends, newest first, so no
file needs its own `afterEach` list of cleanups.

## Modules

| Module    | Exports                                                                         |
| --------- | ------------------------------------------------------------------------------- |
| `temp.ts` | `tempDir(cleanup, prefix?)`; `writeFiles(root, files)`, objects written as JSON |
