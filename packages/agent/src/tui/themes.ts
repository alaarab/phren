export interface Theme {
  name: string;
  user: { label: string; color: string };
  agent: { label: string; color: string };
  tool: { success: string; error: string };
  thinking: { primary: [number, number, number]; secondary: [number, number, number] };
  separator: string;
  permission: { suggest: string; auto: string; fullAuto: string };
  text: string;
  dim: string;
}

export const DARK_THEME: Theme = {
  name: "dark",
  user: { label: "\u276f", color: "white" },
  agent: { label: "\u25c6", color: "magenta" },
  tool: { success: "green", error: "red" },
  thinking: { primary: [155, 140, 250], secondary: [40, 211, 242] },
  separator: "gray",
  permission: { suggest: "cyan", auto: "green", fullAuto: "yellow" },
  text: "white",
  dim: "gray",
};

export const LIGHT_THEME: Theme = {
  name: "light",
  user: { label: "\u276f", color: "black" },
  agent: { label: "\u25c6", color: "#7C3AED" },
  tool: { success: "#16a34a", error: "#dc2626" },
  thinking: { primary: [120, 58, 237], secondary: [6, 182, 212] },
  separator: "gray",
  permission: { suggest: "#0891b2", auto: "#16a34a", fullAuto: "#ca8a04" },
  text: "black",
  dim: "gray",
};

export function getTheme(name?: string): Theme {
  if (name === "light") return LIGHT_THEME;
  return DARK_THEME;
}
