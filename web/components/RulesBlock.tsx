"use client";

import { useState } from "react";
import { Button } from "./ui";
import { ArrowUpRight, Document, Globe, ShieldTick, X } from "./icons";
import { formatDateTime } from "@/lib/format";
import type { MarketView } from "@/lib/market";
import type { AppIcon } from "./icons";

function Row({ label, icon: Icon, children }: { label: string; icon: AppIcon; children: React.ReactNode }) {
  return (
    <div className="rules-row">
      <dt><Icon size={18} variant="Bulk" />{label}</dt>
      <dd>{children}</dd>
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
    <section aria-labelledby="rules-h" className="detail-section">
      <h2 id="rules-h" className="section-title">How this market resolves</h2>
      <dl className="rules-card">
        <Row label="Rule" icon={Document}>
          <p className={`m-0 ${long && !open ? "line-clamp-6" : ""}`}>{market.rule_text}</p>
          {long && (
            <Button variant="ghost" size="sm" onClick={() => setOpen(!open)}>
              {open ? "Show less" : "Show all"}
            </Button>
          )}
        </Row>
        <Row label="Result source" icon={Globe}>
          {isUrl(market.resolution_source) ? (
            <a href={market.resolution_source} target="_blank" rel="noopener noreferrer" className="rules-source">
              {market.resolution_source}<ArrowUpRight size={15} />
            </a>
          ) : (
            market.resolution_source
          )}
        </Row>
        <Row label="Cancelled if" icon={X}>{market.void_policy}</Row>
        <Row label="Locked" icon={ShieldTick}>
          <details className="rules-verify"><summary>View rule verification</summary><span className="rules-verify-body">
            These rules were fixed on-chain before trading opened. Rule fingerprint{" "}
            <span className="mono rules-hash" aria-label="Rule fingerprint" title={hash}>
              {hash.slice(0, 8)}…{hash.slice(-6)}
            </span>{" "}
            <Button variant="secondary" size="sm" onClick={copy} className="rules-copy">
              {copied ? "Copied" : "Copy"}
            </Button>
          </span>
          </details><div className="rules-closes">Trading closes <span className="num">{formatDateTime(market.close_at)}</span></div>
        </Row>
      </dl>
    </section>
  );
}
