/** Shared semantic vocabulary. Heading icons require a Nerd Font Mono variant. */
export const ICONS = {
  agents: "",
  tasks: "",
  success: "✓",
  failure: "✗",
  stopped: "■",
  queued: "◦",
  active: "●",
  idle: "○",
  marker: "●",
  selected: "→",
  tool: "▸",
  turns: "↻",
  compactions: "⇊",
  subLine: "⎿",
  streaming: "◍",
} as const;

/** Animation scheduling belongs to the caller, including mode-specific cadence. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
