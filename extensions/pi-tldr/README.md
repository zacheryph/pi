# pi-tldr

Independent Pi extension: concise on-demand session recaps and short session/terminal-tab names.

- `/tldr`: immediately opens a dismissible modal with a “Summarizing session…” indicator. When ready, it shows the initial premise, major findings/turning points (bullets), current status, and a 2–4-word title. The title changes from `TLDR / session` to `TLDR / <title>` when the result arrives. Errors appear in the same modal as `Couldn't summarize: <message>`. The modal is the shared `packages/pi-ui` detail view: a centered overlay in Pi's fullscreen TUI (the regular renderer is not supported). Esc/Enter closes and cancels a pending request; ↑↓, PgUp/PgDn, Home/End and the mouse wheel scroll. Outside the terminal UI (an app that runs Pi over RPC, say) there is no modal: the same premise, findings and status arrive as one displayed message when the summary is ready, kept out of the model's context.
- After the first user prompt on a _new_ session, generate a short title asynchronously without blocking the main agent. Do not overwrite an existing manual session name or rename an old session upon resume.
- `/tldr` refreshes the title using the **same** response as the summary only if it is unset or still equal to the last name this extension generated; manual names are never replaced. Short names are lowercase hyphen-separated, max 4 words and 48 characters. Pi manages terminal/tab titles normally.
- The summary uses the active branch, includes a preserved first prompt after compaction, and bounds the supplied transcript; it's intentionally not a full transcript export.

## Configuration

Global `~/.pi/agent/tldr.json` with project override `.pi/tldr.json`:

```json
{
  "model": "auto",
  "setSessionName": true
}
```

`model` defaults to `auto`, which selects the most recent available Haiku, then Luna, and otherwise asks you to configure a model rather than silently choosing an expensive fallback. Set a specific `provider/model-id` (or an unambiguous exact model ID) to force that model. A missing or unavailable explicitly configured model surfaces an error rather than falling back silently.

`setSessionName` defaults to **true**. Set it to **false** to disable automatic and `/tldr`-triggered Pi session naming. The extension never writes terminal tab titles directly. `/tldr` still generates/displays its recap. Settings are reloaded on session start and `/reload`.

Both model calls run through Pi's registered, authenticated model provider, without changing the main model or injecting summary prompts into the main agent conversation. Normal model usage charges can apply. The model sees a text-only, bounded session snapshot; tool outputs and sensitive context included in the snapshot may be sent to the selected model.

This extension does not modify `pi-subagent`, `pi-system-insights`, or `pi-todo`.
