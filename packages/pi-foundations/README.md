# pi-foundations

Shared settings and model lookup primitives for this source bundle. This is a
private library, not a Pi extension, and has no runtime dependencies beyond Node.
Import its source by relative path, just like `pi-session-tree`; Git installs do
not link npm workspaces.

- `src/settings.ts`: `readSettingsFile`, `loadLayeredSettings`,
  `writeSettingsFile`, and `patchSettingsFile`. Missing files are absent. Other
  errors throw unless the caller supplies an error callback. Layered settings
  default to a warning and shallow-merge global then project values. Sparse
  patches preserve unknown keys and refuse malformed existing files.
- `src/models.ts`: `findExactModel`, `compareNewestFirst`, `resolveModel`, and
  structural model/registry types. Exact matching is case-insensitive; the full
  resolver additionally supports fuzzy matching and `[provider/]family@latest`.
  Available models take precedence over the full catalog. Model identity and
  extra fields are preserved.

Extensions own validation, defaults, warning presentation, configuration scope,
and model preference/inheritance. Stash and dashboard remain global-only; TLDR
keeps strict validation and exact configured model matching with Haiku/Luna auto
selection. Subagents keeps invocation fallback policy and compatibility exports.

Run `npm run check -w pi-foundations` and `npm test -w pi-foundations`.
