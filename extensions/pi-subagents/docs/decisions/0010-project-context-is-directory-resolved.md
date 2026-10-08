---
status: accepted
date: 2026-09-15
---

# 0010 — Project context is a directory-resolved layer

## Status

Accepted.
Amends [ADR 0006], which stands: a child still inherits the parent prompt's identity region and nothing after it.
What this record changes is which layers count as resolved per session, for a child whose directory is not its parent's.

## Context

Pi's `buildSystemPrompt` renders the session's context files as

```text
<project_context>

Project-specific instructions and guidelines:

<project_instructions path="/absolute/path/AGENTS.md">
…
</project_instructions>

</project_context>
```

and writes that block **before** the skills catalogue and the `Current working directory:` footer.
[ADR 0006]'s own region table therefore lists it under Identity, and `inheritedIdentity` keeps it.

[#918] found that it does not belong there for every child.
The block names each context file by absolute path, so a child a `WorkspaceProvider` relocated adopts an early, machine-structured claim that its project files live in the parent's checkout — contradicted only by the `Working directory:` line far below it.
The reporter ran five background children in `pi-subagents-worktrees` worktrees on real multi-step tickets; four of five, all on mid-tier models, resolved the conflict in favour of the inherited path, prefixed their shell calls with `cd <parent checkout> &&`, and committed into the shared parent checkout.
Nothing surfaced an error, and each child's assigned workspace sat unused.

This is [#640]'s defect (the inherited cwd footer) and [#801]'s (the inherited skills catalogue) in the third per-session layer, which those two changes left in place because it sits *inside* the shared prefix rather than after it.

### The cost is the same for every treatment

Measured by rendering the pinned SDK's `buildSystemPrompt` over this repo's own `AGENTS.md`, with four built-in tools and no skills:

| Span                                  | Chars  |
| ------------------------------------- | ------ |
| Inherited identity (to the footer)    | 58,529 |
| Preamble before `<project_context>`   | 2,083  |
| The block                             | 56,446 |
| Offset of the first `path=` attribute | 2,151  |

Stripping the attribute, remapping it onto the child's directory, and cutting the block all diverge the child's bytes at the same offset.
A relocated child's shared prefix goes 58,529 → 2,083 either way, so the choice among them is not a cost question — only whether the false claim is removed or annotated.

## Decision

`<project_context>` is a **directory-resolved** layer.
A child whose directory is not the one its adopted identity describes drops the inherited block and resolves its own.

1. `inheritedIdentity` cuts one layer earlier — at `<project_context>` — when the child's cwd differs from the parent's.
   A child at the parent's directory is untouched, byte for byte, and keeps the whole shared prefix [ADR 0008] scopes to prefix-reusing hosts.
2. The child's own block is rendered into the assembled override, between the identity and the per-call header, from Pi's own `loadProjectContextFiles` pointed at the child's directory.
3. [ADR 0009]'s `portable` identity no longer carries the parent's block at all; such a child resolves its own wherever it runs, since operator-authored parts describe no directory.
4. A directory that resolves no context file contributes none.

### Why the equal-cwd condition is legitimate here

[ADR 0006] withdrew [#640]'s equal-cwd exception, on the ground that the footer sits *after* the catalogue cut and the exception therefore preserved nothing.
That reasoning does not reach this layer, which sits *before* the cut: the condition preserves 58,529 shared characters for every child that is not relocated, which is the common case.

### Why the block is not left to Pi

Setting the child's loader to `noContextFiles: false` would produce the same content for free.
Pi appends context files **after** `systemPromptOverride`, though, which would move a relocated `prompt_mode: replace` child's body off the end of its prompt — the final say that mode promises.

Rendering it ourselves also keeps the treatment conditional, and the condition is what makes a byte-replica of Pi's block safe.
`buildSystemPrompt` is not exported from `@earendil-works/pi-coding-agent`, so no test can pin our replica against the real one.
Doing this unconditionally would make every non-relocated child's shared prefix depend on that unpinnable replica, and would buy a relocated child nothing — its block cannot match its parent's whatever we render.

### Why the cut is truncation, not excision

[ADR 0006] rejected excising an interior span because it leaves the tail in the child, displaced past the divergence point — cached bytes turned into prefilled ones.
Nothing survives past this cut: the catalogue and footer are already gone, so the block is the new end of the adopted identity.

## Consequences

- A relocated child's prompt names its own directory in every claim it makes, including the machine-structured one.
- A relocated child's shared prefix with its parent is the preamble alone.
  Its project instructions move from cached to prefilled, which is the price of the claim being true.
- A child whose workspace sits inside the parent's tree resolves the parent's own `AGENTS.md` at its real path, because Pi's loader walks ancestors.
- **Accepted residual:** a relocated child whose workspace, every ancestor of it, and the global agent directory all carry no context file now receives **no** project instructions, where it previously inherited the parent's — wrong in path, accurate in content.
  This follows [ADR 0006]'s own reading of the same trade for the extension tail: inheriting a block built for another directory is wrong rather than merely absent.
  `pi-subagents-worktrees` does not reach this case — `git worktree add` checks out tracked files — so it is a gitignored context file, or a provider handing a child a bare sandbox.
  The remediation needs no new mechanism: put the file in the workspace, in an ancestor of it, or in `~/.pi/agent/`.
  The absence is otherwise silent, so it is reported under `PI_SUBAGENTS_DEBUG=1`.
  No opt-in escape hatch is offered; [ADR 0002]'s no-vacant-hooks rule would decline a `Workspace` seam field with no named consumer.
- A portable child whose parent has run no turn now receives its own project instructions alongside `genericBase`, where it previously received `genericBase` alone.
  [ADR 0009]'s fail-safe exists to keep Pi's base preamble out of a re-homing harness, and a project-context block is no part of that.
- The block is located positionally, like the catalogue: its closing tag must be the last non-blank line above the anchored tail, and its opening must carry Pi's lead-in sentence two lines below it.
  A context file quoting either tag is therefore not mistaken for Pi's own markup.
  If Pi changes that markup the anchor stops matching and a relocated child keeps the inherited block — the status quo before this record, not a new failure mode.

[#640]: https://github.com/gotgenes/pi-packages/issues/640
[#801]: https://github.com/gotgenes/pi-packages/issues/801
[#918]: https://github.com/gotgenes/pi-packages/issues/918
[ADR 0002]: 0002-extensions-on-a-minimal-core.md
[ADR 0006]: 0006-inherited-prompt-is-identity-only.md
[ADR 0008]: 0008-inherited-region-is-shared-parts.md
[ADR 0009]: 0009-portable-inheritance-is-provider-scoped.md
