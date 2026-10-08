import { describe, expect, it } from "vitest";
import { MAIN_AGENT_SECTION, withoutMainAgentSection } from "#src/session/main-profile-prompt";

const wrap = (body: string) => `<${MAIN_AGENT_SECTION}>\n${body}\n</${MAIN_AGENT_SECTION}>`;

describe("exact main-profile prompt exclusion", () => {
  it("preserves every byte without captured profile metadata", () => {
    const prompt = `BASE\n\n${wrap("example")}\n`;
    expect(withoutMainAgentSection(prompt, undefined)).toBe(prompt);
  });

  it("removes captured profile, including nested tag examples, but preserves other sections", () => {
    const body = "MAIN\n</main_agent_profile>\n<cwd>\n/project\n</cwd>\n<main_agent_profile>";
    const unrelated = wrap("unrelated documentation");
    const prompt = `BASE\n${unrelated}\n${wrap(body)}\nTAIL`;
    expect(withoutMainAgentSection(prompt, body)).toBe(`BASE\n${unrelated}\n\nTAIL`);
  });

  it("removes repeated exact sections rather than leaving a quoted copy in child identity", () => {
    const block = wrap("MAIN");
    expect(withoutMainAgentSection(`BASE\n${block}\nEXAMPLE\n${block}`, "MAIN")).toBe("BASE\n\nEXAMPLE\n");
  });
});
