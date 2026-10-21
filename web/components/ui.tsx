import Link from "next/link";
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { cents } from "@/lib/format";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const SIZE: Record<Size, string> = { sm: "btn-sm", md: "", lg: "btn-lg" };

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button type="button" {...rest} className={`btn btn-${variant} ${SIZE[size]} ${className}`} />;
}

type Tone = "info" | "warning" | "danger";

export function Notice({ tone = "info", children }: { tone?: Tone; children: ReactNode }) {
  return <div role={tone === "danger" ? "alert" : "status"} className="notice" data-tone={tone}>{children}</div>;
}

export function StateBadge({ status, caseStage }: { status: string; caseStage?: string | null }) {
  let label = "Open";
  let tone = "open";
  if (status === "halted") {
    label = "Paused";
    tone = "paused";
  } else if (status === "resolved") {
    label = "Final";
    tone = "final";
  } else if (status === "closed") {
    label = caseStage === "disputed" ? "Challenged" : caseStage === "proposed" ? "Answer proposed" : "Closed";
    tone = caseStage === "disputed" ? "council" : caseStage ? "attention" : "neutral";
  }
  return <span className="status-pill" data-tone={tone}>{label}</span>;
}

// A price in cents, coloured by side. The word always comes from the column header or the text around it.
export function Price({ micro, side, muted = false }: { micro: string; side: "yes" | "no"; muted?: boolean }) {
  const tone = muted ? "text-muted" : side === "yes" ? "text-yes" : "text-no";
  return <span className={`num font-medium ${tone}`}>{cents(micro)}</span>;
}

export function PageLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} className="text-link">{children}</Link>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="section-title">{children}</h2>;
}

export function LinkButton({ href, variant = "primary", children }: { href: string; variant?: "primary" | "secondary"; children: ReactNode }) {
  return <Link href={href} className={`btn btn-${variant}`}>{children}</Link>;
}

export function Eyebrow({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "council" }) {
  return <p className={`eyebrow m-0 ${tone === "council" ? "text-council" : ""}`}>{children}</p>;
}

export function StatTile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="display m-0 mt-1 text-[2.25rem] leading-none">{value}</dd>
    </div>
  );
}

// Yes and No as one proportional bar. The labels carry the numbers, so the split never relies on colour.
export function SplitMeter({ yes, labels = false, size = "md" }: { yes: number; labels?: boolean; size?: "sm" | "md" | "lg" }) {
  const y = Math.min(Math.max(Math.round(yes), 0), 100);
  return (
    <div className="split-meter" data-size={size} role="img" aria-label={`Yes ${y} percent, No ${100 - y} percent`} style={{ "--split": `${y}%` } as CSSProperties}>
      <div className="split-meter-track" aria-hidden="true"><span className="split-yes" /><span className="split-no" /></div>
      {labels && <div className="split-meter-labels" aria-hidden="true"><span><i className="outcome-dot outcome-yes" />Yes <b className="num">{y}%</b></span><span>No <b className="num">{100 - y}%</b><i className="outcome-dot outcome-no" /></span></div>}
    </div>
  );
}
