/** Name-based, source-local prompt composition. Discovery records declarations; execution reads files. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentConfig } from "#src/types";

export interface PromptFragment {
  name: string;
  path: string;
  content: string;
}

export interface AgentInstructions {
  /** The profile's own Markdown body, before composition. */
  body: string;
  /** Ordered, deduplicated source provenance for inspection. */
  fragments: PromptFragment[];
  systemPrompt: string;
}

/** Invalid declarations remain discoverable, but cannot silently run without their instructions. */
export function parseFragments(value: unknown): Pick<AgentConfig, "fragments" | "fragmentError"> {
  if (value === undefined) return {};
  if (!Array.isArray(value)) {
    return { fragmentError: "fragments must be an array of names (e.g. fragments: [aws])" };
  }
  for (const name of value) {
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
      return { fragmentError: `Invalid fragment name ${JSON.stringify(name)}: use letters, digits, '_' or '-' only; no paths or .md suffix` };
    }
  }
  return { fragments: [...new Set(value as string[])] };
}

/**
 * Resolve only against the winning profile's agents/fragments directory, never cwd or another scope.
 * Call at explicit main selection / child spawn, then retain the resulting text as a snapshot.
 */
export function composeAgentInstructions(
  profile: AgentConfig,
  options: { projectTrusted?: boolean; readFile?: (path: string) => string } = {},
): AgentInstructions {
  const declaration = parseFragments(profile.fragments);
  const error = profile.fragmentError ?? declaration.fragmentError;
  if (error) throw new Error(`Agent "${profile.name}": ${error}`);
  const names = declaration.fragments ?? [];
  const body = profile.systemPrompt.trim();
  if (!names.length) return { body, fragments: [], systemPrompt: profile.systemPrompt };
  if (profile.source === "project" && options.projectTrusted !== true) {
    throw new Error(`Agent "${profile.name}" fragments require Pi project trust (--approve or /trust).`);
  }
  if (!profile.sourcePath) throw new Error(`Agent "${profile.name}" fragments require a profile source path.`);
  const fragmentDir = join(dirname(profile.sourcePath), "fragments");
  const readFile = options.readFile ?? (path => readFileSync(path, "utf8"));
  const fragments = names.map(name => {
    const path = join(fragmentDir, `${name}.md`);
    try {
      return { name, path, content: readFile(path).trim() };
    } catch (error) {
      throw new Error(`Agent "${profile.name}" fragment "${name}" (${path}): ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const parts = [...fragments.map(fragment => fragment.content), body].filter(Boolean);
  return { body, fragments, systemPrompt: parts.join("\n\n---\n\n") };
}
