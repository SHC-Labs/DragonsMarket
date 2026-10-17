"use client";

import { useState } from "react";
import { Button } from "./ui";
import { formatDateTime } from "@/lib/format";
import type { MarketView } from "@/lib/market";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 border-b border-border py-3 sm:grid-cols-[8.75rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </div>
  );
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);

export function RulesBlock({ market }: { market: MarketView }) {
  const [copied, setCopied] = useState(false);
  const hash = market.rule_hash;
  const long = market.rule_text.length > 360;
  const [open, setOpen] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
    } catch {
      // clipboard blocked; the hash is still on screen to select
    }
  };

  return (
    <section aria-labelledby="rules-h">
      <h2 id="rules-h" className="mb-3 mt-8 border-b border-border pb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted">
        How this market resolves
      </h2>
      <dl className="m-0 border-t border-border">
        <Row label="Rule">
          <p className={`m-0 ${long && !open ? "line-clamp-6" : ""}`}>{market.rule_text}</p>
          {long && (
            <Button variant="ghost" size="sm" onClick={() => setOpen(!open)}>
              {open ? "Show less" : "Show all"}
            </Button>
          )}
        </Row>
        <Row label="Result source">
          {isUrl(market.resolution_source) ? (
            <a href={market.resolution_source} target="_blank" rel="noopener noreferrer">
              {market.resolution_source}
            </a>
          ) : (
            market.resolution_source
          )}
        </Row>
        <Row label="Cancelled if">{market.void_policy}</Row>
        <Row label="Locked">
          <details><summary className="cursor-pointer text-sm text-muted">View rule verification</summary><span className="text-sm">
            Rules fixed on-chain before trading. Fingerprint{" "}
            <span className="num text-sm" aria-label="Rule fingerprint" title={hash}>
              {hash.slice(0, 8)}…{hash.slice(-6)}
            </span>{" "}
            <Button variant="ghost" size="sm" onClick={copy} className="h-6 px-2">
              {copied ? "Copied" : "Copy"}
            </Button>
          </span>
          </details><div className="text-sm text-muted">Trading closes {formatDateTime(market.close_at)}</div>
        </Row>
      </dl>
    </section>
  );
}
