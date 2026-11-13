// pi-surface server: the endpoint pi-bb sessions connect to, the RPC the React
// slots read, the `bb pi-surface` CLI, and the environment every Pi thread gets.
import {
  experimental_PluginRpcRefusal as PluginRpcRefusal,
  type BbPluginApi,
  type JsonValue,
} from "@get-bb/plugin-sdk";
import { rpcContract } from "./contract.ts";
import { fixtureResponder, fixtureSnapshot } from "./fixture.ts";
import { ENV_TOKEN, ENV_URL, SESSION_PATH } from "./protocol.ts";
import { QUESTIONNAIRE_RENDERER, QuestionBridge } from "./questions.ts";
import { SessionError, SessionStore, type SessionConnection } from "./sessions.ts";
import { newSecret, threadToken, verifyThreadToken } from "./token.ts";

export { rpcContract };

const SECRET_KEY = "session-secret";

const USAGE = [
  "Usage:",
  "  bb pi-surface list                    Sessions the plugin knows, live and fixture",
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
      ask: async (threadId, questionnaire, signal) =>
        bb.ui.requestInput(
          {
            threadId,
            rendererId: QUESTIONNAIRE_RENDERER,
            title: questionnaire.questions.length > 1 ? "Pi's questions" : "Pi's question",
            payload: questionnaire as unknown as JsonValue,
            presentation: {
              label: { pending: "Waiting for your answer", completed: "Answered" },
            },
          },
          { signal },
        ),
      answer: (threadId, question, answer) =>
        store.request(threadId, { command: "answer", question, answer }),
      onError: (message) => bb.log.warn(`questionnaire: ${message}`),
    });

    const store = new SessionStore({
      verify: async (threadId, token) => verifyThreadToken(await signingSecret(), threadId, token),
      onChange: (threadId) => {
        bb.rpc.experimental_invalidate([`thread:${threadId}`, "sessions"]);
        // Fixtures never raise forms: they would write into a real thread's timeline.
        questions.sync(threadId, store.live(threadId));
      },
      ...options,
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

    bb.rpc.register(rpcContract, {
      snapshot: ({ threadId }) => store.get(threadId),
      sessions: () => ({ sessions: store.summaries() }),
      request: async ({ threadId, request }) => {
        try {
          const data = (await store.request(threadId, request)) ?? null;
          return { data: data as JsonValue };
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
                    `${session.threadId}  ${session.source}${session.connected ? "" : " (disconnected)"}  ${session.status}  ${session.name ?? session.cwd}`,
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
