# pi-campaigns

Local-first, YAML-defined long-horizon infrastructure campaign manager for Pi.
**Status: foundational MVP; not yet an autonomous PR lifecycle manager.**

## Design goals

- One Pi **management session** for campaigns lasting days/weeks.
- Agents do bounded implementation work; **no LLM calls while waiting**.
- Full local state under \`~/.pi/agent/campaigns/<id>/\` (override \`PI_CAMPAIGNS_DIR\`).
- Plans can change as new constraints and external identifiers are discovered.
- User-created scripts verify GitHub, Spacelift, Terraform, Kubernetes, network health,
  or arbitrary systems; adapters are optional, not required.
- Human gates, production safety and merge policies are explicit.
- No webhooks, remote database, or mandatory hosted service.

## Getting started

Install the parent bundle normally. Use \`/campaigns:new\` to run an initial
interview (title, desired state, scope, validation, boundaries/rollback, first
step). It creates a **paused draft** with one discovery step. Continue planning
with the main agent, edit \`campaign.yaml\` or use \`campaign(action:"revise")\`,
and start it only after reviewing the steps and scripts.

\`/campaigns\` shows status and the above-editor summary. The commands:

| Command | Effect |
| --- | --- |
| \`/campaigns\` or \`/campaigns <id>\` | List or inspect progress and blockers |
| \`/campaigns:new\` | Guided initial interview and paused draft |
| \`/campaigns:resume <id>\` | Confirm and enable reconciliation |
| \`/campaigns:enable-commands <id>\` | Confirm and enable command gates; the dialog lists each argv, the workspace, and extra env names |
| \`/campaigns:pause <id>\` | Pause and abort checks active in this Pi session |
| \`/campaigns:reconcile <id>\` | Run eligible deterministic checks once |
| \`/campaigns:approve <id> <step> <gate>\` | Operator-confirmed human gate |
| \`/campaigns:retry <id> <step> <gate>\` | Operator retry of a blocked gate |

The model-facing \`campaign\` tool supports \`list\`, \`create\`, \`status\`,
\`revise\` (optimistic \`expected_revision\`), \`pause\`, \`work_done\`,
\`approve\` (only blocked/waiting), and \`reconcile\`. A model **cannot pass
a human approval gate** through the campaign tool: \`/campaigns:approve\` requires confirmation. The tool also cannot resume a campaign, enable command execution, remove or change a human gate, remove any existing gate, change existing step dependencies or work kind, or change command gates and workspace after commands are enabled. The model can use other Pi file/shell tools if those are available; treat this boundary as an extension API guard, not a sandbox for an untrusted model. Direct edits to \`campaign.yaml\` are operator actions and should be reviewed before resuming.

## Plan format

\`\`\`yaml
id: network-migration
title: Regional route migration
goal: All affected networks migrated with reachability verified
workspace: /home/engineer/repos/infrastructure
settings:
  reconcile_minutes: 15
  allow_commands: false  # explicit opt-in after script review
  # command_env: [GH_TOKEN] # explicitly expose extra environment names to checks
  auto_merge: false       # reserved policy; merges not implemented
  max_review_rounds: 3    # reserved for review-loop implementation
  notifications:
    pi: true
    # slack_webhook_env: MY_SLACK_WEBHOOK   # reserved; no Slack delivery yet
steps:
  - id: create-draft
    title: Open canary draft PR
    work:
      kind: agent
      agent: general-purpose
      instructions: Implement first wave and open a draft PR
    gates:
      - id: pr-reviewed
        kind: human
        title: Reviewer confirms PR quality
  - id: apply-canary
    title: Verify canary stack apply
    depends_on: [create-draft]
    work:
      kind: none
    gates:
      - id: apply-succeeded
        kind: command
        command: [node, .pi/checks/spacelift-apply.mjs]
        every_minutes: 15
        timeout_seconds: 45
  - id: production-review
    title: Approve production migration
    depends_on: [apply-canary]
    work:
      kind: manual
    gates:
      - id: user-approval
        kind: human
\`\`\`

Scripts receive \`PI_CAMPAIGN_ID\`, \`PI_CAMPAIGN_STEP_ID\`,
\`PI_CAMPAIGN_GATE_ID\`, \`PI_CAMPAIGN_FACTS_JSON\`. They also receive only PATH, HOME, TMPDIR, LANG, and the explicitly listed \`settings.command_env\` variables; all other parent environment values are excluded. Facts can be added through
\`campaign(action:"work_done", step:"create-draft", facts:{pr_number:123})\`,
including PR numbers or Spacelift run identifiers gathered by an agent.
For gates already waiting, use `campaign(action:"set_facts", step:"apply-canary",
facts:{spacelift_run_id:"run-123"})`. This updates evidence, not gate status.

### Command check contract

Scripts run with explicit **argv arrays** (never \`sh -c\` implicitly),
inside the campaign workspace. Exit 0 => passed; exit 3 => still waiting;
any other exit => blocked. Optional stdout JSON
\`{"status":"waiting","detail":"waiting for run","evidence":{}}\` can downgrade a
successful exit to waiting/blocked, but **cannot turn a failing exit into success**.
Output is capped at 8 KiB and timeouts are bounded.

A passed result is recorded and not polled again. Changing a gate definition invalidates its prior result, including approval, and requires a fresh check. A blocked result requires an
operator to resolve it, retry via `/campaigns:retry`, or revise the plan (not automatic retry in this MVP).
Spawn errors and timeouts retry on the normal interval and block after three consecutive failures; other nonzero exits block immediately. This is intentionally fail-closed. Checks are independently scheduled when the
Pi process is active; the process never uses idle LLM turns.

## State and interruption

Each campaign has \`campaign.yaml\` and \`state.yaml\`, atomically replaced per
write. A \`revision.yaml\` journal recovers an interrupted plan revision. History is retained in \`state.yaml\`. The manager reconstructs current
eligibility from the plan and persisted evidence when a session starts or the
campaign is read; resume does **not** require preserving a multi-week agent
transcript. A draft starts paused. Pausing stops future scheduling and aborts
active checks; external PRs or applies already in progress are **not** undone.

\`done\` steps are immutable by default. Adding steps through a revision
preserves completed evidence. Deleting completed steps is rejected. When
a completed step's contract needs changing, **create a new remediation step**
(or use a future explicit, audited reopen/invalidating-descendants action).
Don't silently rewrite history.

**Caveats:** A per-campaign process lock prevents duplicate check runs in two Pi windows. The owner refreshes it before each check; a lock whose process has exited, or that has gone untouched for 11 minutes (longer than any gate timeout), is reclaimed automatically. A check result is discarded only if its own step, gate definition, workspace, command settings or pause state changed while it ran. State updates in separate processes are not fully transactional; use one active manager for the same campaign when changing state.
External YAML edits should be followed by \`/campaigns\` or
\`/campaigns:reconcile\`. A command gate's exact execution state is not a durable
process across restart; rerun is safe only if checks are side-effect-free.

## Architecture and ownership

- **Pure code:** graph validation, state transitions, scheduling, running check
  scripts, evidence persistence, gating, UI status.
- **Pi management agent:** interviews, scopes dependencies/waves, creates plan
  revisions, investigates blockers, gathers missing PR/run IDs, drafts next work.
- **pi-subagents + worktrees + LSP:** implementation and review of bounded
  changes. This MVP exposes the plan to the model but does **not** spawn workers
  automatically.
- **GitHub tools:** repository-local PR/CI observation. Extend with generic
  scripts for cross-repo or mixed-platform checks.
- **Jev (optional):** triage/classify a bounded ambiguous item, never authoritative
  production permission, merge approval, or apply proof.

## Planned increment (not implemented in this PR)

1. Structured multi-stage planning interview with explicit plan approval,
   rollback discovery, risk analysis, and wave selection.
2. Auto-dispatch a chosen subagent/worktree for ready \`work.kind: agent\` steps.
3. Draft PR lifecycle: discover PR, review comments up to N rounds, notify
   operator, mark ready on operator signal, wait teammate approval, and merge
   only if \`auto_merge\` policy allows it.
4. Approved script gate templates for GitHub and Spacelift; collect dynamic
   identifiers when unknown. Script success must be tied to exact PR SHA,
   workspace and run ID, not unrelated actions.
5. Notifications: Pi and Slack adapters; deduplicated state transitions only.
6. Better interactive TUI: graph browser, active checks/gates, decisions and
   evidence, campaign pause/retry/remediation controls.
7. Local process recovery improvements, per-campaign audit journal, safe worker leases, and stronger cross-process state transactions.

## Verification

From the repository root:

\`\`\`bash
npm ci --ignore-scripts
npm run test:campaigns
npm run check
npm test
\`\`\`

See [the visual design](docs/design.html) for the complete interaction model
and phased engineering specification.
