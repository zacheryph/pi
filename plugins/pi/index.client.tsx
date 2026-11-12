import type { PluginClientContext, PluginButtonRegistration } from "@getpaseo/plugin/client";
import { stateWatch } from "./shared/state.ts";
import { HarnessPanel } from "./client/panel.tsx";

export default function contribute(client: PluginClientContext) {
  const lifetime = new AbortController();
  const registered = new Map<string, { workspaceId: string; remove(): void }>();
  const panel = client.addAgentPanel({
    id: "harness",
    title: "Pi harness",
    icon: "ListTodo",
    locations: ["workspace", "explorer"],
    Component: HarnessPanel,
  });
  const command = client.addCommandCenterItem({
    id: "open-harness",
    title: "Open Pi tasks and subagents",
    icon: "ListTodo",
    context: "agent",
    onSelect(context) {
      context.openPanel("harness");
    },
  });
  const remove = (id: string) => {
    registered.get(id)?.remove();
    registered.delete(id);
  };
  const register = (agent: { id: string; workspaceId?: string | null; provider: string }) => {
    if (lifetime.signal.aborted) return;
    if (agent.provider !== "pi" || !agent.workspaceId) {
      remove(agent.id);
      return;
    }
    if (registered.get(agent.id)?.workspaceId === agent.workspaceId) return;
    remove(agent.id);
    const workspaceId = agent.workspaceId;
    const makePill = (id: string, label: string, icon: string): PluginButtonRegistration =>
      client.addComposerPill({
        id,
        workspaceId,
        agentId: agent.id,
        button: {
          title: label,
          label,
          icon,
          behavior: {
            kind: "action",
            onPress() {
              client.openPanel("harness", { workspaceId, agentId: agent.id });
            },
          },
        },
      });
    const tasks = makePill("tasks", "Pi tasks", "ListTodo");
    const agents = makePill("agents", "Pi agents", "Users");
    const stop = client.subscribe(
      stateWatch,
      { agentId: agent.id },
      (event) => {
        if (event.type !== "state") {
          tasks.update({ label: "Pi tasks · offline" });
          agents.update({ label: "Pi agents · offline" });
          return;
        }
        const { todos, subagents } = event.state;
        const done = todos?.tasks.filter((task) => task.status === "completed").length ?? 0;
        const unread = todos?.tasks.reduce((sum, task) => sum + task.unreviewed, 0) ?? 0;
        tasks.update({
          label: `Pi tasks · ${done}/${todos?.total ?? 0}${unread ? ` · ${unread} new` : ""}`,
        });
        const running = subagents?.agents.filter((agent) => agent.state === "running").length ?? 0;
        const waiting = subagents?.agents.filter((agent) => agent.state === "waiting").length ?? 0;
        agents.update({
          label: `Pi agents · ${running} running${waiting ? ` · ${waiting} waiting` : ""}`,
        });
      },
      { signal: lifetime.signal },
    );
    void stop.ready.catch((error) => {
      if (!lifetime.signal.aborted) console.error("Pi state subscription failed", error);
    });
    registered.set(agent.id, {
      workspaceId,
      remove: () => {
        stop();
        tasks.remove();
        agents.remove();
      },
    });
  };
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const id of registered.keys()) remove(id);
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") remove(update.agentId);
          else register(update.agent);
        },
      });
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("Pi agent observation failed", error);
    });
  return () => {
    lifetime.abort();
    for (const id of registered.keys()) remove(id);
    void panel();
    void command();
  };
}
