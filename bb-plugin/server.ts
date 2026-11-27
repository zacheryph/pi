// pi-surface server: the endpoint pi-bb sessions connect to, the RPC the React
// slots read, the `bb pi-surface` CLI, and the environment every Pi thread gets.
import {
  experimental_PluginRpcRefusal as PluginRpcRefusal,
  type BbPluginApi,
  type JsonValue,
} from "@get-bb/plugin-sdk";
import { DismissalQueue, findItem } from "./attention.ts";
import { rpcContract, type ActionRequest } from "./contract.ts";
import { fixtureResponder, fixtureSnapshot } from "./fixture.ts";
import { ENV_TOKEN, ENV_URL, SESSION_PATH } from "./protocol.ts";
import { QUESTIONNAIRE_RENDERER, QuestionBridge } from "./questions.ts";
import { snapshotArchive } from "./archive.ts";
import { SessionError, SessionStore, type SessionConnection } from "./sessions.ts";
import { newSecret, threadToken, verifyThreadToken } from "./token.ts";

export { rpcContract };

const SECRET_KEY = "session-secret";
/** How long a raised form waits for the user: bb's longest. */
const FORM_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

const USAGE = [
  "Usage:",
  "  bb pi-surface list                    Sessions the plugin knows: live, saved and fixture",
  "  bb pi-surface fixture --thread <id>   Show a canned session on a thread (no model run)",
  "  bb pi-surface clear --thread <id>     Remove that thread's fixture",
].join("\n");

export interface PluginOptions {
  graceMs?: number;
  helloTimeoutMs?: number;
  requestTimeoutMs?: number;
}

function threadArg(argv: string[]): string | undefined {
  const index = argv.indexOf("--thread");
  const value =
    index >= 0 ? argv[index + 1] : argv.find((arg) => arg.startsWith("--thread="))?.slice(9);
  return value && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

export function createPlugin(options: PluginOptions = {}) {
  return async function plugin(bb: BbPluginApi): Promise<void> {
    // One signing secret per installation, kept across reloads so tokens bb already
    // handed to running Pi processes stay valid.
    let secret: Promise<string> | undefined;
    const signingSecret = () =>
      (secret ??= (async () => {
        const stored = await bb.storage.kv.get<string>(SECRET_KEY);
        if (typeof stored === "string" && stored.length >= 32) return stored;
        const fresh = newSecret();
        await bb.storage.kv.set(SECRET_KEY, fresh);
        return fresh;
      })());

    const questions = new QuestionBridge({
      live: (threadId) => store.live(threadId),
      ask: async (threadId, questionnaire, signal) =>
        bb.ui.requestInput(
          {
            threadId,
            rendererId: QUESTIONNAIRE_RENDERER,
            title:
              questionnaire.title ||
              (questionnaire.questions.length > 1 ? "Pi's questions" : "Pi's question"),
            payload: questionnaire as unknown as JsonValue,
            // Pi waits for an answer as long as it runs; this is bb's longest.
            timeoutMs: FORM_TIMEOUT_MS,
            presentation: {
              label: { pending: "Waiting for your answer", completed: "Answered" },
            },
          },
          { signal },
        ),
      run: (threadId, connection, request) => store.request(threadId, request, { connection }),
      onError: (message) => bb.log.warn(`questionnaire: ${message}`),
    });

    // Dismissed while no Pi ran for the thread: hidden now, run when its Pi reconnects.
    const dismissals = new DismissalQueue(bb.storage.kv, {
      onChange: () => bb.rpc.experimental_invalidate(["attention", "sessions"]),
      onError: (message) => bb.log.warn(message),
    });

    /** Runs the thread's queued dismissals once its Pi is back; each runs at most once. */
    const replayDismissals = (threadId: string) => {
      const live = store.live(threadId);
      if (!live) return;
      for (const dismissal of dismissals.forThread(threadId)) {
        const found = findItem(live.snapshot, dismissal.viewId, dismissal.itemId);
        // The view may not be there yet, or failed this time: wait for a snapshot that says.
        if (found.view !== "ok") continue;
        dismissals.remove(dismissal);
        const { item } = found;
        // Gone, changed since the user saw it, or no longer dismissible: nothing to do.
        if (!item?.dismiss || item.rev !== dismissal.rev) continue;
        store
          .request(threadId, item.dismiss, { connection: live.connection })
          .catch((error: unknown) =>
            bb.log.warn(`could not dismiss ${dismissal.itemId} on ${threadId}: ${String(error)}`),
          );
      }
    };

    const store = new SessionStore({
      archive: snapshotArchive(bb.storage),
      onError: (message) => bb.log.warn(message),
      verify: async (threadId, token) => verifyThreadToken(await signingSecret(), threadId, token),
      hides: (threadId, row) => dismissals.hides(threadId, row),
      onChange: (threadId) => {
        bb.rpc.experimental_invalidate([`thread:${threadId}`, "sessions", "attention"]);
        // Only a live session's forms are raised: a fixture's or a saved one's would write
        // into the thread's timeline with nobody to answer them.
        questions.sync(threadId);
        replayDismissals(threadId);
      },
      // Pi names its session (pi-tldr does, after the first prompt); the thread follows.
      onRename: (threadId, name) => {
        void Promise.resolve()
          .then(() => bb.sdk.threads.update({ threadId, title: name }))
          .catch((error: unknown) => {
            bb.log.warn(`could not title thread ${threadId}: ${String(error)}`);
          });
      },
      ...options,
    });

    bb.events.on("thread.deleted", ({ thread }) => {
      store.forget(thread.id);
      dismissals.forget(thread.id);
    });
    // Dismissals queued before a reload, for threads whose Pi reconnected while they loaded.
    void dismissals.loaded.then(() => {
      for (const { threadId } of store.summaries()) replayDismissals(threadId);
    });

    bb.http.experimental_websocket(
      SESSION_PATH,
      () => {
        let connection: SessionConnection | undefined;
        return {
          onOpen: (socket) => {
            connection = store.open(socket);
          },
          onMessage: async (_socket, data) => {
            await connection?.message(data);
          },
          onClose: () => connection?.closedBySession(),
          onError: () => connection?.closedBySession(),
        };
      },
      // The session's hello carries a per-thread HMAC token, checked by the store.
      { auth: "none" },
    );

    const refusal = (error: unknown): never => {
      if (error instanceof SessionError)
        throw new PluginRpcRefusal({ code: error.code, message: error.message });
      throw error;
    };

    /** The item the user acted on, as it is now: refused if it went or changed since it was shown. */
    const shownItem = (threadId: string, viewId: string, itemId: string, rev?: string) => {
      const found = findItem(store.get(threadId).snapshot, viewId, itemId);
      const item = found.view === "ok" ? found.item : undefined;
      if (!item)
        throw new PluginRpcRefusal({
          code: "not_found",
          message: "That item is no longer listed.",
        });
      if (item.rev !== rev)
        throw new PluginRpcRefusal({
          code: "conflict",
          message: "That item changed since it was shown; look at it again.",
        });
      return item;
    };

    bb.rpc.register(rpcContract, {
      snapshot: ({ threadId }) => store.get(threadId),
      sessions: () => ({ sessions: store.summaries() }),
      attention: () => store.attention(),
      dismiss: async ({ threadId, viewId, itemId, rev }) => {
        const { source, connected } = store.get(threadId);
        const item = shownItem(threadId, viewId, itemId, rev);
        // A running Pi (or the fixture) dismisses it now; a saved session's item lost its action.
        if ((source === "live" && connected) || source === "fixture") {
          if (!item.dismiss)
            throw new PluginRpcRefusal({
              code: "conflict",
              message: "This item cannot be dismissed here.",
            });
          try {
            await store.request(threadId, item.dismiss);
          } catch (error) {
            return refusal(error);
          }
          return { queued: false };
        }
        await dismissals.add({ threadId, viewId, itemId, ...(rev ? { rev } : {}) });
        return { queued: true };
      },
      reply: async ({ threadId, viewId, itemId, rev, text }) => {
        const item = shownItem(threadId, viewId, itemId, rev);
        // A saved item has no reply (settled); only a running Pi or the fixture can take one.
        if (!item.reply)
          throw new PluginRpcRefusal({
            code: "conflict",
            message: "This item cannot take a reply here.",
          });
        try {
          const args = item.reply.args;
          const base = args && typeof args === "object" && !Array.isArray(args) ? args : {};
          await store.request(threadId, { action: item.reply.action, args: { ...base, text } });
        } catch (error) {
          return refusal(error);
        }
        return {};
      },
      request: async ({ threadId, request }) => {
        try {
          // zod's JSON type is mutable; the arguments are JSON either way.
          const value = (await store.request(threadId, request as ActionRequest)) ?? null;
          return { value: value as JsonValue };
        } catch (error) {
          return refusal(error);
        }
      },
    });

    bb.providers.experimental_contributeEnv("pi", async ({ threadId }) => {
      // Model listing serves no thread.
      if (!threadId) return [];
      return [
        {
          name: ENV_URL,
          value: { serverPath: `/api/v1/plugins/${bb.pluginId}/http${SESSION_PATH}` },
          reason: "pi-surface: where this thread's pi-bb extension reports its session",
        },
        {
          name: ENV_TOKEN,
          value: threadToken(await signingSecret(), threadId),
          reason: "pi-surface: this thread's session credential (valid for this thread only)",
        },
      ];
    });

    // A plugin with no `configure` callback puts every skill in its `skills/` directory
    // into every thread's prompt. Select none: the skill stays installed for `bb skill`,
    // but costs the model nothing.
    bb.agents.configure(() => ({ tools: [], skills: [] }));

    bb.cli.register({
      name: "pi-surface",
      summary: "Inspect Pi sessions shown by the Pi surface plugin, or show a fixture session",
      commands: [
        {
          name: "list",
          summary: "List live and fixture sessions",
          usage: "bb pi-surface list [--json]",
        },
        {
          name: "fixture",
          summary: "Show a canned session on a thread, without a model run",
          usage: "bb pi-surface fixture --thread <id>",
        },
        {
          name: "clear",
          summary: "Remove a thread's fixture session",
          usage: "bb pi-surface clear --thread <id>",
        },
      ],
      run(argv) {
        const [command] = argv;
        switch (command) {
          case undefined:
          case "help":
          case "--help":
          case "-h":
            return { exitCode: 0, stdout: USAGE };
          case "list": {
            const sessions = store.summaries();
            if (argv.includes("--json")) return { exitCode: 0, stdout: JSON.stringify(sessions) };
            if (!sessions.length) return { exitCode: 0, stdout: "No Pi sessions." };
            return {
              exitCode: 0,
              stdout: sessions
                .map(
                  (session) =>
                    `${session.threadId}  ${session.source}${session.source === "live" && !session.connected ? " (reconnecting)" : ""}  ${session.status ?? "unknown"}  ${session.name ?? session.cwd ?? "(no session view)"}`,
                )
                .join("\n"),
            };
          }
          case "fixture":
          case "clear": {
            const threadId = threadArg(argv);
            if (!threadId) return { exitCode: 1, stderr: `--thread <id> is required.\n${USAGE}` };
            if (command === "clear")
              return store.clearFixture(threadId)
                ? { exitCode: 0, stdout: `Removed the fixture session from ${threadId}.` }
                : { exitCode: 1, stderr: `${threadId} has no fixture session.` };
            try {
              const now = Date.now();
              store.setFixture(threadId, fixtureSnapshot(now), fixtureResponder(now));
            } catch (error) {
              return {
                exitCode: 1,
                stderr: error instanceof Error ? error.message : String(error),
              };
            }
            return {
              exitCode: 0,
              stdout: `Showing a fixture session on ${threadId}. Remove it with: bb pi-surface clear --thread ${threadId}`,
            };
          }
        }
        return { exitCode: 1, stderr: USAGE };
      },
    });

    bb.onDispose(() => {
      questions.dispose();
      store.dispose();
    });
  };
}

export default createPlugin();
