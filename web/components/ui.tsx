import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cents } from "@/lib/format";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary: "bg-accent text-on-accent border-transparent hover:opacity-90",
  secondary: "bg-transparent text-fg border-input hover:bg-surface",
  ghost: "bg-transparent text-fg border-transparent underline underline-offset-4 decoration-muted hover:decoration-fg",
  danger: "bg-danger text-on-accent border-transparent hover:opacity-90",
};
const SIZE: Record<Size, string> = { sm: "h-8 px-3 text-sm", md: "h-10 px-4", lg: "h-12 px-4 w-full" };

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex items-center justify-center rounded-md border font-semibold transition-colors duration-[120ms] disabled:cursor-not-allowed disabled:border-border disabled:bg-surface disabled:text-muted disabled:no-underline ${VARIANT[variant]} ${SIZE[size]} ${className}`}
    />
  );
}

type Tone = "info" | "warning" | "danger";
const TONE: Record<Tone, string> = {
  info: "bg-info-soft border-info",
  warning: "bg-warning-soft border-warning",
  danger: "bg-danger-soft border-danger",
};

export function Notice({ tone = "info", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`my-4 rounded-md border-l-[0.1875rem] px-4 py-3 text-sm ${TONE[tone]}`}>
      {children}
    </div>
  );
}

const BADGE_TONE = { neutral: "border-input text-fg", attention: "border-warning text-warning", paused: "border-warning text-warning", council: "border-council text-council" };

export function StateBadge({ status, caseStage }: { status: string; caseStage?: string | null }) {
  let label = "Open";
  let tone: keyof typeof BADGE_TONE = "neutral";
  if (status === "halted") {
    label = "Paused";
    tone = "paused";
  } else if (status === "resolved") {
    label = "Final";
  } else if (status === "closed") {
    label = caseStage === "disputed" ? "Challenged" : caseStage === "proposed" ? "Answer proposed" : "Closed";
    if (caseStage) tone = caseStage === "disputed" ? "council" : "attention";
  }
  return <span className={`inline-block whitespace-nowrap rounded-sm border px-2 text-xs font-medium ${BADGE_TONE[tone]}`}>{label}</span>;
}

// A price in cents, coloured by side. The word always comes from the column header or the text around it.
export function Price({ micro, side, muted = false }: { micro: string; side: "yes" | "no"; muted?: boolean }) {
  const tone = muted ? "text-muted" : side === "yes" ? "text-yes" : "text-no";
  return <span className={`num font-medium ${tone}`}>{cents(micro)}</span>;
}

export function PageLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-sm text-muted underline decoration-transparent underline-offset-4 hover:text-fg hover:decoration-fg">
      {children}
    </Link>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="section-title mb-4 mt-10 border-b border-border pb-4">{children}</h2>;
}

export function LinkButton({ href, variant = "primary", children }: { href: string; variant?: "primary" | "secondary"; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={`inline-flex h-12 items-center justify-center rounded-md border px-6 font-semibold no-underline transition-colors duration-[120ms] ${VARIANT[variant]}`}
    >
      {children}
    </Link>
  );
}

export function Eyebrow({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "council" }) {
  return <p className={`num m-0 text-xs uppercase tracking-[0.18em] ${tone === "council" ? "text-council" : "text-muted"}`}>{children}</p>;
}

export function StatTile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-[0.1em] text-muted">{label}</dt>
      <dd className="display m-0 mt-1 text-[2.25rem] leading-[2.375rem]">{value}</dd>
    </div>
  );
}
