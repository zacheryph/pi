# pi-tldr

Independent Pi extension: concise on-demand session recaps and short session/terminal-tab names.

- `/tldr`: ask a configured model for initial premise, major findings/turning points, current status, and a 2–4-word title; show a dismissible read-only modal. In Pi fullscreen mode the modal is a centered overlay, and in regular mode it opens a custom screen. Esc/Enter closes; Up/Down scroll.
- After the first user prompt on a *new* session, generate a short title asynchronously without blocking the main agent. Do not overwrite an existing manual session name or rename an old session upon resume.
- `/tldr` refreshes the title using the **same** response as the summary, if naming is enabled. Short names are lowercase hyphen-separated, max 4 words and 48 characters.
- The summary uses the active branch, includes a preserved first prompt after compaction, and bounds the supplied transcript; it's intentionally not a full transcript export.

## Configuration

Global `~/.pi/agent/tldr.json` with project override `.pi/tldr.json`:

```json
{
  "model": "auto",
  "setSessionName": true
}
```

`model` defaults to `auto`, which selects the most recent available Haiku, then Luna, then the current Pi model, then another available chat model. Set a specific `provider/model-id` (or an unambiguous exact model ID) to force that model. A missing or unavailable explicitly configured model surfaces an error rather than falling back silently.

`setSessionName` defaults to **true**. Set it to **false** to disable **both** automatic and `/tldr`-triggered Pi session naming **and** terminal tab-title updates. `/tldr` still generates/displays its recap. Settings are reloaded on session start and `/reload`.

Both model calls run through Pi's registered, authenticated model provider, without changing the main model or injecting summary prompts into the main agent conversation. Normal model usage charges can apply. The model sees a text-only, bounded session snapshot; tool outputs and sensitive context included in the snapshot may be sent to the selected model.

This extension does not modify `pi-subagents`, `pi-system-insights`, or `pi-todo`.
