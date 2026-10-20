import Link from "next/link";

export function Brand({ variant = "header" }: { variant?: "header" | "footer" }) {
  return (
    <Link href="/" className={`site-brand site-brand-${variant}`} aria-label="Dragons Market home">
      <span className="brand-mark" aria-hidden="true" />
      <span className="brand-wordmark">Dragons Market</span>
    </Link>
  );
}
