# pi-stash

A handle-based working-set store for Pi. Large text (search results, file
snapshots, tool output, worker findings) is kept **outside the model context**;
the model gets back a short handle and reads only the slices it needs.

```text
stash:auth-findings@3f9a1c2b7d01
```

Typical uses:

- **Parent → worker:** brief a subagent with a handle instead of pasting 400 lines.
- **Worker → parent:** a worker stashes its large result and returns the handle;
  the parent reads one slice at a time.
- **After compaction:** stashed material can still be read exactly instead of being
  summarised away.

## Tools

All three are ordinary (`direct`) tools with an `outputSchema`, so codemode
scripts receive structured values (`structuredContent`) instead of text.

### `stash_put`

```ts
{ name, description?, content? | path? | toolCallId? }   // exactly one source
```

- `content`: literal text.
- `path`: snapshot a file inside the working directory. Accepts the same spelling as
  `read` (relative, absolute, `~`, leading `@`), but the real path must stay inside
  the real working directory; symlinks out of it, directories and binary files are
  refused.
- `toolCallId`: snapshot the full text of an earlier tool result on the **current
  branch**, so the model never re-types a big output. When Pi's `bash` kept the
  untruncated output in a temp file, that full output is stored. Calls made inside
  a codemode script leave no tool result; stash those with `content`.

Names match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Re-using a name adds a new version;
older versions stay readable by their full handle.

Returns a receipt only: `{ handle, name, hash, bytes, lines, mime, preview }`, where
the preview is about 10 lines or 1 KB. The content is never echoed.

### `stash_get`

```ts
{ ref, lines?: [start, end], grep?: { pattern, context?, ignoreCase? }, jsonPath?, maxBytes? }
```

- `ref`: a full handle, or a bare name resolved through this branch's index.
- At most one of `lines` (1-based, inclusive), `grep` (JavaScript regex, up to 20
  context lines, `n:` marks matches and `n-` context) and `jsonPath` (`$.a[0]`,
  `$["key"]`, negative indexes). With none, returns the head.
- Output is line-numbered and bounded: `maxBytes` defaults to 16 KB and is capped
  at Pi's 50 KB / 2,000-line tool budget. Truncated reads say what to request next,
  e.g. `next range is [313, 624]`.

### `stash_list`

`{ filter? }` lists the current branch's entries (latest version per name, newest
first) with handle, size, line count, description, creator session and age.

## How it works

**Content** is immutable and stored by hash at `<root>/blobs/<aa>/<sha256>`, where
the root is `$PI_STASH_DIR` or `~/.pi/agent/stash/`. Writes are atomic (temp file +
rename), every path must resolve inside the root, and symlinks are refused. Reads
verify the hash.

**The index** is saved in the session as `pi-personal:stash-index` custom entries,
one per change plus a checkpoint after compaction. It is rebuilt from the current
branch on start, resume, reload and `/tree`, so abandoned branches drop out.

**Handles** resolve two ways:

- A bare name goes through the current branch's index.
- A full handle (`stash:<name>@<12+ hex>`) goes straight to the content store, from
  any session on this machine. Each subagent has its own session and index, but the
  content store is shared, so handles cross between parent and children. A prefix
  matching more than one blob fails and lists the candidates.

**Context:** after compaction, resume, reload or `/tree`, each model request gets a
bounded, context-only *index card* (the 20 most recent entries: handle, size,
description). It is never written to the transcript or shown as a message.

## Events

Other extensions can follow the index without parsing journal entries. On
session start, branch changes, and every `stash_put` (codemode calls included),
pi-stash emits `pi-stash:snapshot` on the session's `pi.events` bus
(`src/events.ts`): `{ version: 1, entries }`, the latest version per name, newest
first, in the same shape `stash_list` returns. Metadata only; content never
leaves the store. Each subagent has its own bus. pi-dashboard uses it for its
stash counts.

## Subagents

The bundled `pi-subagents` lets Explore and Plan call `stash_get` and `stash_list`;
Explore can also call `stash_put` to return large findings as a handle. The
orchestrator is told to brief workers with handles and ask for large results as
handles. See [`../pi-subagents/UPSTREAM.md`](../pi-subagents/UPSTREAM.md).

## Commands

- `/stash` opens a modal in the fullscreen TUI: list → Enter shows the name,
  full hash, description, then a numbered content preview (up to 2,000 lines /
  50 KB). The regular TUI displays the same browser inline. Warns when the
  store is over its size cap.
- `/stash:gc` deletes content not read or written for `retentionDays` and reports
  what it freed.

## Retention and limits

Content cannot be traced to every session that references it, so v1 uses an age
policy. On session start, blobs the current branch references are refreshed and
anything not read or written for `retentionDays` is deleted (tracked by file
mtime/atime). A handle older than that in another session may stop resolving.

Configure in `~/.pi/agent/stash.json` (global only, because the store is shared):

```json
{ "retentionDays": 30, "maxEntryBytes": 20971520, "maxStoreBytes": 1073741824 }
```

- `maxEntryBytes` (20 MB): larger entries are rejected.
- `maxStoreBytes` (1 GB): `/stash` warns above it.

## Security

Stashed text is **plaintext on local disk** (`0600` files in a `0700` directory).
It can include secrets from tool output, such as environment dumps or tokens in
logs. There is no redaction in v1. Treat the stash directory like your shell
history, and run `/stash:gc` or delete the directory to remove content.

## Not in v1

- Automatically spilling oversized tool results into the stash.
- Semantic search, embeddings, or memory across projects.
- Dispatching a todo item to a subagent with linked handles (issue #11).

## Development

From the repository root:

```bash
npm install --ignore-scripts
npm run check --workspace=pi-stash
npm test --workspace=pi-stash
```
