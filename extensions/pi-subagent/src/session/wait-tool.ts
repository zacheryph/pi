import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ActivationRoute } from "../../../../packages/pi-session-tree/src/activation.ts";

export function waitTool(route: ActivationRoute) {
  return defineTool({
    name: "subagent_wait",
    label: "Wait for input",
    description:
      "Keep this assignment open while waiting for parent guidance. Call this, then end your turn. Outstanding jobs/watches already imply waiting automatically. The parent can wake you with subagent_steer or subagent_start with resume.",
    parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 2000 }) }),
    execute: async (_id, { reason }) => {
      route.wait(reason);
      return {
        content: [
          {
            type: "text" as const,
            text: "Waiting requested. End your turn to park until new input arrives.",
          },
        ],
        details: undefined,
      };
    },
  });
}
