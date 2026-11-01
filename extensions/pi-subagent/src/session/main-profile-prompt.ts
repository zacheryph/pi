/** Shared prompt identity marker; no runtime or UI dependencies. */
export const MAIN_AGENT_SECTION = "main_agent_profile";

/** Remove only the exact captured main-profile section, never guessed tag spans.
 * A profile may quote cwd/skill tags that confuse the legacy inheritance anchors.
 * Removing its known section first preserves existing child inheritance behavior.
 */
export function withoutMainAgentSection(prompt: string, section: string | undefined): string {
  if (section === undefined) return prompt;
  const rendered = `<${MAIN_AGENT_SECTION}>\n${section}\n</${MAIN_AGENT_SECTION}>`;
  return prompt.replaceAll(rendered, "");
}
