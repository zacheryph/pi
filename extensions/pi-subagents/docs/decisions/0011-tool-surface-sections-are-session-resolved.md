---
status: accepted
date: 2026-10-02
---

# 0011 — Pi's tool-surface sections are session-resolved, not identity

## Status

Accepted.
Amends [ADR 0006] and [ADR 0008], which stand: a child still inherits the parent prompt's identity region and nothing after it, and that region still guarantees shared parts rather than shared bytes.
What this record changes is which part of the region counts as identity on a section-shaped prompt.

## Context

From Pi 0.86, `buildSystemPrompt` assembles the prompt from tagged sections joined by a blank line.
Without a custom prompt it renders, in order, the preamble, `<tools>`, `<rules>`, and `<docs>`; then `<addendum>`, `<project_context>`, and `<skills>` when present; then `<cwd>`, then any section an extension adds.
With a custom prompt, the custom text is the preamble and none of `<tools>`, `<rules>`, or `<docs>` is rendered.

`<tools>` lists the session's selected tools and `<rules>` the guidelines those tools contribute.
Both are resolved against one session's tool set, exactly as the catalogue is resolved against its skills.
A child's prompt is a `customPrompt`, so Pi writes neither section for it; an inherited copy is the parent's tool surface presented as the child's ([#901]).

Until now `@gotgenes/pi-permission-system` hid this by stripping the two sections from every node's head and appending each node's own after `<cwd>` (its ADR 0014).
It did so by returning a forced `systemPrompt`, which drops every section a later extension adds, Pi's `<mcp_servers>` among them ([#999]).
The fix for that leaves Pi's `<tools>`/`<rules>` in place, narrowed through the active tool set.
Once it ships, a child would carry the parent's narrowed list in its inherited identity and its own list after `<cwd>`: two lists that disagree.

## Decision

On the section shape, `inheritedIdentity` excises Pi's `<tools>` and `<rules>` sections from the identity it keeps; everything else in the region is kept byte for byte.

1. The excision applies only when the tail was anchored on a `<cwd>` section.
   The ≤0.85 footer shape renders the tool surface as untagged prose and is left as it is.
2. The pair is located positionally, the way every other anchor in `prompts.ts` is.
   A whole-line `<tools>` must close, be followed by one blank line and a whole-line `<rules>`, and that must close, all above the first `<docs>`, `<addendum>`, `<project_context>`, `<skills>`, or `<cwd>` line.
   A pair quoted in an addendum or a context file sits below that bound, and a lone `<tools>` block is not Pi's.
3. The blank line below `</rules>` goes with the pair, so the kept head reads exactly as Pi renders a prompt without them.
   A child of a parent whose head carries the pair therefore receives the same identity as a child of a parent whose head does not.

### Why excision is right here

[ADR 0006] rejected excising the catalogue and footer while keeping the extension tail, because the tail it kept was itself built for the parent and would have moved from cached to prefilled.
Neither reason reaches these two sections.
What follows them (`<docs>`, the addendum, project context) is identity, accurate for the child, and is kept.
The excised span is not dropped from the child's view of its tools: the child's own tool definitions describe them, and `@gotgenes/pi-permission-system`, when installed, states them as the child's own `<tools>`/`<rules>` after `<cwd>`.
Truncating at `<tools>` instead would discard the child's project context for no gain.

### The cost

The shared prefix now ends at the preamble for every parent that renders the pair.
Pi's default preamble is 169 characters, so a parent and child share 172: the preamble, the blank-line join, and the `<` both following sections open with.
That figure is derived from the measured preamble length, not from a live capture.
While pi-permission-system still relocates the pair, a parent's head carries no `<tools>`, the excision finds nothing, and the whole identity stays shared.
The trade was accepted on [#999], and it falls on [#180]'s constituency alone: [ADR 0008] already records that a host whose cache covers the tool definitions ahead of the system text reuses nothing for a child.

## Consequences

- A child never states its parent's tool list or guidelines as its own on a section-shaped prompt.
- **Accepted residual:** without pi-permission-system a child now carries no tool list and no rules in prose, including the generic ones ("Be concise in your responses").
  The request's tool definitions still name exactly its tools.
  This replaces [ADR 0008]'s residual (the parent's list, inherited); a child-stated list stays with [#901].
- A custom prompt that quotes a whole-line `<tools>` block, a blank line, and a `<rules>` block above every later section is cut as if Pi had written it.
- If Pi renames these sections or reorders them, the anchor stops matching and a child keeps its parent's copy: the behavior before this record, not a new failure mode.
  `buildSystemPrompt` is not exported, so the tests pin hand-built fixtures, and the package's upstream-assumptions table watches the order.

[#180]: https://github.com/gotgenes/pi-packages/issues/180
[#901]: https://github.com/gotgenes/pi-packages/issues/901
[#999]: https://github.com/gotgenes/pi-packages/issues/999
[ADR 0006]: 0006-inherited-prompt-is-identity-only.md
[ADR 0008]: 0008-inherited-region-is-shared-parts.md
