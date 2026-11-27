# Startup and live activity

A slow-looking launch can be time spent in three different places:

1. **The parent's model turn.** The parent generates the `subagent_start` call,
   including the assignment. A streaming tool card is not evidence that the tool
   has executed yet. Pi validates and executes tools after the assistant response.
2. **Local child startup.** The tool returns an ID immediately; admission to a
   concurrency slot, environment discovery, resource loading, model runtime creation
   and extension binding happen before the child's first prompt.
3. **The child's model turn and its display.** A ready session can still be waiting
   for the provider, thinking, or generating its first tool call. The TUI polls live
   activity every 80 ms (fullscreen) or 250 ms (regular). BB and the dashboard send
   announced view changes in 250 ms batches; browser rendering is additional.

## Measured example

Investigation on 2026-11-27, with the user's installed extensions and Haiku 4.5:

| Boundary                                                         | Observed time                        |
| ---------------------------------------------------------------- | ------------------------------------ |
| Live `subagent_start` execution                                  | 11 ms                                |
| Live child admission to ready session, two launches              | 167–175 ms                           |
| First investigative child model turn, thinking `high`            | 4.4 s, including response generation |
| Minimal live child, thinking `off`, complete launch through `OK` | 1.79 s, including 167 ms startup     |
| Local warm child startup, scripted provider                      | about 150–390 ms                     |
| Local startup after changing directories, scripted provider      | about 540–680 ms                     |

These are individual observations, not latency guarantees or a controlled
thinking-level comparison: the two live assignments differed. The measurements
separate session readiness from a completed model response, **not** provider time
to first token. No browser-paint timing was measured.

The local benchmark used the real resource loader and sessions with the installed
extensions, replacing model streaming with a faux response to exclude network
latency. Its six children included repeated same-directory exploration, a switch
to another directory and back, and a general-purpose child. Directory switches
made resource loading colder. An attempted direct API call from the benchmark
subprocess failed DNS resolution; live-model evidence came from actual
`subagent_start` calls in the running Pi instead.

## Display fix

The investigation found a separate, real responsiveness defect: child tool and
text events updated the in-memory record but did not announce changes to the
published views. The terminal's polling renderer could see activity while BB and
the dashboard retained `thinking…` until another lifecycle event arrived.

Activity now travels through the existing observer chain to view announcements,
without appending lifecycle records or starting parent turns. Text changes are
announced throughout streaming, since the widget shows the text itself, not a
boolean writing indicator. BB and the dashboard's existing batching coalesces
those announcements into deliveries; there is no new polling timer or per-token
socket send.

The SDK regression in `test/views-sdk.test.ts` captures widget models **when
announced**, sees the child's `reading…` activity before completion or a further
parent prompt, and checks that activity did not create persisted lifecycle
records. Reading the live model without observing an announcement would not
reproduce this bug: that model was already fresh before the fix.

## Improving a slow launch

- For quick lookup assignments, explicitly pass `model: "haiku"` and
  `thinking: "off"` or `"low"`. Omitting thinking can pick up an expensive SDK
  settings default; choosing a fast model alone does not disable thinking.
- Prefer a narrow profile and a concise assignment. Avoid inheriting the full
  conversation unless the child needs it; this reduces generation and prefill work.
- Distinguish a queued agent from an admitted one before blaming startup. Every
  new run, including a resume, goes through the concurrency limit.
- If readiness itself is slow, time environment discovery, `loader.reload()`,
  model runtime creation and `bindExtensions()` separately. Extension factories,
  session-start hooks and first-request hooks may perform additional work.
- Warm retained sessions can resume without recreating their resources. Do not
  share mutable extension instances or model runtimes between children as a cache:
  each child must keep its state and provider registrations isolated.

No thinking defaults, concurrency settings or session-isolation behavior were
changed by this investigation. The measured multi-second portion was model work,
not a reproduced multi-second local startup delay.
