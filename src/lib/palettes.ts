// Generated alongside the palette CSS in globals.css; keep the two in step.
export interface Palette {
  id: string;
  name: string;
  description: string;
  /** Swatches for the picker: background, surface, text, accent — dark set. */
  swatches: [string, string, string, string];
}

/** The default palette, carried by bare :root, so it stamps no attribute. */
export const DEFAULT_PALETTE = "vichy";

export const PALETTES: Palette[] = [
  { id: "vichy", name: "Vichy", description: "Plain greys and one teal", swatches: ["#121313", "#222424", "#F5F6F6", "#05AD98"] },
  { id: "tungsten", name: "Tungsten", description: "Warm near-black, orange accent", swatches: ["#0F0E0C", "#1F1D19", "#EEE9E1", "#FF8F45"] },
  { id: "misty-fjord", name: "Misty Fjord", description: "Navy night, clay accent", swatches: ["#0C1529", "#18264A", "#E5E5EF", "#CC9A82"] },
  { id: "gossamer", name: "Gossamer", description: "Cool greys, red-orange accent", swatches: ["#111214", "#202226", "#FAFAFA", "#EC4D25"] },
  { id: "flint", name: "Flint", description: "Graphite and sage, signal red", swatches: ["#1E2022", "#303336", "#E7E8E3", "#F64134"] },
  { id: "arctic", name: "Arctic Reflection", description: "Blue-teal throughout", swatches: ["#14232D", "#243C4C", "#F4FCFB", "#5289AD"] },
  { id: "pasticceria", name: "Pasticceria", description: "Charcoal, soft coral", swatches: ["#25272A", "#35383C", "#F3E6E2", "#EC8880"] },
  { id: "clockwork", name: "Clockwork", description: "Cool greys, orange accent", swatches: ["#131416", "#232528", "#F8F8F8", "#FBA45C"] },
  { id: "alabaster", name: "Alabaster", description: "Ink blue, sky accent", swatches: ["#0B1D30", "#133250", "#EDEDED", "#80B5D7"] },
  { id: "moonstone", name: "Moonstone", description: "No colour, stone accent", swatches: ["#1A1A19", "#2E2E2D", "#ECEDEF", "#CBCDD0"] },
];
