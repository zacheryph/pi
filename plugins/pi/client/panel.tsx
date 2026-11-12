import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useSubscription, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { stateWatch, type HarnessState } from "../shared/state.ts";

export function HarnessPanel({ params, theme, layout }: PluginAgentPanelProps) {
  const [state, setState] = useState<HarnessState | null>(null);
  const [message, setMessage] = useState("Connecting to Pi…");
  useEffect(() => {
    setState(null);
    setMessage("Connecting to Pi…");
  }, [params.agentId]);
  const subscription = useSubscription(stateWatch, { agentId: params.agentId }, (event) => {
    if (event.type === "state") {
      setState(event.state);
      setMessage("");
    } else {
      setState(null);
      setMessage(event.message);
    }
  });
  const text = { color: theme.colors.foreground };
  const muted = { color: theme.colors.foregroundMuted };
  return (
    <ScrollView contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16 }}>
      <Text style={[text, { fontSize: 20, fontWeight: "600" }]}>Pi harness</Text>
      {subscription.status === "error" ? (
        <Text style={text}>{subscription.error.message}</Text>
      ) : null}
      {message ? <Text style={muted}>{message}</Text> : null}
      {state ? (
        <>
          <Text style={[text, { fontWeight: "600" }]}>
            Tasks · {state.todos?.tasks.filter((t) => t.status === "completed").length ?? 0}/
            {state.todos?.total ?? 0}
          </Text>
          {!state.todos?.tasks.length ? <Text style={muted}>No tasks on this branch.</Text> : null}
          {state.todos?.tasks.map((task) => (
            <View
              key={task.key}
              style={{
                gap: 4,
                borderLeftWidth: 2,
                borderColor: theme.colors.border,
                paddingLeft: 12,
              }}
            >
              <Text style={text}>{task.subject}</Text>
              <Text style={muted}>
                {task.status}
                {task.blocked ? " · blocked" : ""}
                {task.unreviewed ? ` · ${task.unreviewed} new` : ""}
              </Text>
              {task.description ? <Text style={text}>{task.description}</Text> : null}
              {task.dependsOn?.length ? (
                <Text style={muted}>Depends on: {task.dependsOn.join(", ")}</Text>
              ) : null}
              {task.message ? <Text style={text}>{task.message.text}</Text> : null}
            </View>
          ))}
          <Text style={[text, { fontWeight: "600" }]}>
            Subagents · {state.subagents?.agents.length ?? 0}
          </Text>
          {!state.subagents?.agents.length ? (
            <Text style={muted}>No subagents on this branch.</Text>
          ) : null}
          {state.subagents?.agents.map((agent) => (
            <View
              key={agent.id}
              style={{
                gap: 4,
                borderLeftWidth: 2,
                borderColor: theme.colors.border,
                paddingLeft: 12,
              }}
            >
              <Text style={text}>
                {agent.type} · {agent.description}
              </Text>
              <Text style={muted}>
                {agent.state} · {agent.toolUses ?? 0} tools
                {agent.tokens === undefined ? "" : ` · ${agent.tokens} tokens`}
              </Text>
              {agent.note ? <Text style={text}>{agent.note}</Text> : null}
            </View>
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}
