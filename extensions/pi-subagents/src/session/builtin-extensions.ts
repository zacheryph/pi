/**
 * builtin-extensions.ts — select the Pi built-in extensions a child's tools call for.
 *
 * Pi hands its built-in extensions to the resource loader only from its CLI
 * entry point, so an SDK-built child loader starts with none of them, and the
 * child's tool allowlist then drops `codemode`, `tool_search`, and every MCP
 * tool without an error. Passing a built-in's factory with `builtin: true`
 * makes the loader resolve it as a `builtin:<name>` resource, which honors the
 * operator's `-builtin:<name>` setting exactly as the parent does, and
 * `replaceable: true` lets an extension that registers the same tool, command,
 * or flag take over, as Pi's own entries do.
 *
 * A built-in is selected only when the child's allowlist names a tool it
 * supplies: the MCP extension connects every configured server on
 * `session_start`, whether or not the child can reach any of their tools.
 */

import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type ExtensionFactory,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

/** An extension Pi resolves as a `builtin:<name>` resource. */
export type BuiltinExtension = Exclude<InlineExtension, ExtensionFactory>;

/**
 * The built-ins a child whose allowlist is `toolNames` loads, in Pi's own
 * order, each at most once.
 */
export function builtinExtensionsFor(toolNames: readonly string[]): BuiltinExtension[] {
  return BUILTINS.filter((builtin) => toolNames.some(builtin.supplies)).map(({ name, factory }) => ({
    name,
    factory,
    builtin: true,
    replaceable: true,
  }));
}

/** MCP's resource tools, which MCP registers alongside the server tools. */
const MCP_RESOURCE_TOOLS: ReadonlySet<string> = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);

/**
 * Pi's tool-supplying built-ins, named as Pi names them. Each factory keeps
 * its state inside the call that loads it, so one factory serves every child.
 */
const BUILTINS: readonly {
  name: string;
  factory: ExtensionFactory;
  supplies: (toolName: string) => boolean;
}[] = [
  { name: "codemode", factory: createCodemodeExtension(), supplies: (tool) => tool === "codemode" },
  { name: "tool-search", factory: createToolSearchExtension(), supplies: (tool) => tool === "tool_search" },
  {
    name: "mcp",
    factory: createMcpExtension(),
    supplies: (tool) => tool.startsWith("mcp__") || MCP_RESOURCE_TOOLS.has(tool),
  },
];
