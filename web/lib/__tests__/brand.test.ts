import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { checkRepo, checkSource } from "../../scripts/check-brand.mjs";

type Problem = { rule: string };
const rules = (file: string, source: string) => (checkSource(file, source) as Problem[]).map(p => p.rule);

describe("brand check", () => {
  it("passes on the repository", () => {
    expect(checkRepo()).toEqual([]);
  });

  it("rejects raw colours but allows black and white light and shadow", () => {
    expect(rules("app/styles/x.css", ".a { color: #ff3d6e; }")).toEqual(["raw-colour"]);
    expect(rules("app/styles/x.css", ".a { background: oklch(0.7 0.1 300); }")).toEqual(["raw-colour"]);
    expect(rules("components/X.tsx", `<rect fill="#d8a24a" />`)).toEqual(["raw-colour"]);
    expect(rules("app/styles/x.css", ".a { box-shadow: 0 1px 0 rgb(255 255 255 / 0.18) inset; mask: linear-gradient(#000 0 0); }")).toEqual([]);
    expect(rules("app/styles/x.css", "/* was #ff3d6e */ .a { color: var(--no); }")).toEqual([]);
  });

  it("rejects fonts, default palette classes, direct icon imports and em dashes", () => {
    expect(rules("app/styles/x.css", ".a { font-family: Inter, sans-serif; }")).toEqual(["raw-font"]);
    expect(rules("app/styles/x.css", ".a { font-family: var(--font-display-stack); }")).toEqual([]);
    expect(rules("components/X.tsx", `<div className="bg-purple-500 text-[#fff]" />`)).toEqual(["tailwind-palette", "tailwind-palette"]);
    expect(rules("components/X.tsx", `import { Gear } from "@phosphor-icons/react";`)).toEqual(["icon-import"]);
    expect(rules("components/X.tsx", `<p>Fast \u2014 and fair</p>`)).toEqual(["em-dash"]);
  });

  it("would have caught the partner colours that lived in showreel.css before the tokens", () => {
    const before = execFileSync("git", ["show", "4004acd:web/app/styles/showreel.css"], { encoding: "utf8" });
    expect(rules("app/styles/showreel.css", before).filter(r => r === "raw-colour").length).toBeGreaterThan(5);
  });
});
