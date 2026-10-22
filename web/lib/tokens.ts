import tokens from "@/design/tokens.json";

export type Theme = "dark" | "light";
export type ColorRole = keyof typeof tokens.color;
type BrandName = keyof typeof tokens.brand;

/** Resolves a colour role to its hex value, following `{brand.x}` references in design/tokens.json. */
export function color(role: ColorRole, theme: Theme): string {
  const value = tokens.color[role][theme];
  const ref = /^\{brand\.([\w-]+)\}$/.exec(value)?.[1];
  return ref ? tokens.brand[ref as BrandName].value : value;
}

export { tokens };
