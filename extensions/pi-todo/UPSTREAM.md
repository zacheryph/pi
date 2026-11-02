# Upstream provenance

- Selected base: [`@99percentpeople/pi-todo` 1.2.8](https://github.com/99percentpeople/pi-extensions/tree/a7ae6b89a211c35b657e886e9ceeafbf51616c22/extensions/todo).
- Repository: `https://github.com/99percentpeople/pi-extensions.git`
- Pinned commit: `a7ae6b89a211c35b657e886e9ceeafbf51616c22`
- Imported 2026-10-08 by sparse cloning into `extensions/pi-todo/.upstream`,
  extracting the todo state engine/license, then removing the temporary checkout.
  This is vendored source, not a submodule or nested Git repository.
- `src/state.ts` was copied byte-for-byte from `extensions/todo/state.ts` at that
  commit. Preserve its pure validation/replay API when updating the fork.
- `LICENSE` retains Zach Yuen's MIT copyright and permission notice.
- Upstream's extension entry, settings, and UI were not imported.

Local changes are recorded in [CHANGELOG.md](CHANGELOG.md). See the
[comparison report](docs/comparison.md) for alternatives and the decision
rationale.

## Sync history

| Date       | Upstream commit   | Notes           |
| ---------- | ----------------- | --------------- |
| 2026-10-08 | `a7ae6b8` (1.2.8) | Initial import. |
