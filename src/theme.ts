// Catppuccin Mocha palette + semantic roles. All UI components import `theme`.
// Palette: https://github.com/catppuccin/catppuccin

export const mocha = {
  rosewater: "#f5e0dc",
  flamingo: "#f2cdcd",
  pink: "#f5c2e7",
  mauve: "#cba6f7",
  red: "#f38ba8",
  maroon: "#eba0ac",
  peach: "#fab387",
  yellow: "#f9e2af",
  green: "#a6e3a1",
  teal: "#94e2d5",
  sky: "#89dceb",
  sapphire: "#74c7ec",
  blue: "#89b4fa",
  lavender: "#b4befe",
  text: "#cdd6f4",
  subtext1: "#bac2de",
  subtext0: "#a6adc8",
  overlay2: "#9399b2",
  overlay1: "#7f849c",
  overlay0: "#6c7086",
  surface2: "#585b70",
  surface1: "#45475a",
  surface0: "#313244",
  base: "#1e1e2e",
  mantle: "#181825",
  crust: "#11111b",
} as const;

/** Semantic roles consumed by components — swap palette here to retheme. */
export const theme = {
  bg: mocha.base,
  bgPanel: mocha.mantle,
  bgInput: mocha.surface0,
  fg: mocha.text,
  dim: mocha.overlay1,
  muted: mocha.subtext0,
  border: mocha.surface1,
  borderFocus: mocha.lavender,

  accent: mocha.mauve,
  user: mocha.blue,
  assistant: mocha.text,
  reasoning: mocha.overlay1,

  tool: mocha.sapphire,
  toolRunning: mocha.yellow,
  success: mocha.green,
  error: mocha.red,
  warning: mocha.peach,

  diffAdd: mocha.green,
  diffRemove: mocha.red,
  diffContext: mocha.overlay1,

  cost: mocha.peach,
  tokens: mocha.subtext0,
} as const;

export type Theme = typeof theme;
