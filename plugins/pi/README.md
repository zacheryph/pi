# Pi harness for Paseo

An opt-in native Paseo plugin with live task/subagent composer pills and an agent
panel. Task dependencies and outcome messages, queued/waiting agents and progress
notes come from pi-presentation. This first slice is read-only. Controls, child
transcripts, artifact/Git panels, questions/jobs and inspectors are tracked in
#157–#160; runtime/desktop/mobile acceptance is tracked in #161.

## Install on the daemon machine

Requires POSIX Unix sockets, Node 24+, this Pi bundle and Paseo **0.16.0-beta.2**
(the SDK version pinned in package-lock.json). Keep the checkout at its installed
path. The Pi wrapper uses the `pi` executable on PATH with its normal credentials,
settings and this bundle installed. It adds only the presentation extension.

1. In this repository run `npm ci` for the Pi bundle. Plugin development tools are
   separate: `npm ci --prefix plugins/pi`.
2. Enable plugins in Paseo Settings → Plugins if you want to install this plugin.
3. Install the plugin: `paseo plugin install /absolute/path/to/pi/plugins/pi`.
4. Configure Paseo's Pi provider command override to use
   `/absolute/path/to/pi/integrations/paseo/pi` in place of `pi`. The command
   override is `{ "mode": "replace", "argv": ["/absolute/path/to/pi/integrations/paseo/pi"] }`;
   retain the surrounding provider configuration and other existing settings.
5. Start or reload a Pi agent. Choose **Open Pi tasks and subagents** in Command
   Center, or select **Pi tasks** / **Pi agents** above its composer.

Paseo plugin code runs in the client and on the daemon host. Installation is
local to that host; the phone connects through Paseo's existing transport.

## Connection and lifecycle

The wrapper loads `integrations/paseo/pi-extension.ts` only for RPC sessions.
It starts a read-only Unix socket in a checked, user-owned mode-0700 temporary
directory. The filename hashes Pi's native session ID; cwd and PID are not the
routing identity. Paseo resolves the native ID from the selected agent's runtime
or persisted session handle. No dashboard hub, HTTP port, terminal discovery,
agent spawning or model turn is involved.

A client receives a full bounded snapshot immediately and after producer changes.
Disconnects clear displayed state and reconnect with a new decoder; plugin
subscriptions rebind when Paseo reports a new native session ID. Slow socket
clients disconnect instead of accumulating output. Stale sockets left after a
process crash fail visibly; after verifying no process owns that session, remove
its socket file and reload the Pi agent. Existing terminal sessions keep their
independent dashboard and are not imported by this plugin.

## Verify

`npm run lint --prefix plugins/pi`, `npm run typecheck --prefix plugins/pi`, `npx tsc -p integrations/paseo/tsconfig.json`,
and `npm test --prefix plugins/pi` check the SDK, bridge and framing/lifecycle.

Before rollout, validate in a real daemon/client: two agents in the same cwd show
separate task lists; a background subagent remains live after its start tool
returns; queued/waiting/failed states and outcome messages display; reload and
branch/session replacement clear stale data; disconnect/reconnect refreshes
state; phone layout scrolls without clipping. Confirm the Paseo RPC PID never
appears in the standalone dashboard. These UI checks are still outstanding.

Root lint excludes the separately installed Paseo plugin and bridge. The Paseo CI
job installs their dependencies and runs the same Oxlint configuration against
both directories before typechecking and testing them. Root formatting still
covers the whole repository.
