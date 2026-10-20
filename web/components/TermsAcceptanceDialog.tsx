"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LEGAL_DOCUMENTS } from "@/lib/legal";
import { shortAccount } from "@/lib/format";
import { Button } from "./ui";

export function TermsAcceptanceDialog({ account, onAccept, onDismiss }: {
  account: string;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [termsAgreed, setTermsAgreed] = useState(false);
  const [privacyAcknowledged, setPrivacyAcknowledged] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      element.close();
      document.body.style.overflow = previousOverflow;
      const target = previousFocus?.isConnected ? previousFocus : document.querySelector<HTMLElement>(".site-header-actions button:last-child");
      target?.focus({ preventScroll: true });
    };
  }, []);

  return <dialog ref={dialog} className="terms-dialog" aria-labelledby="terms-dialog-title" aria-describedby="terms-dialog-description" data-native-scroll onCancel={event => { event.preventDefault(); onDismiss(); }} onKeyDown={event => {
    if (event.key !== "Tab") return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('a[href], input:not([disabled]), button:not([disabled])'));
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <h2 id="terms-dialog-title">Before you continue</h2>
    <p id="terms-dialog-description">Review the policies for Dragons Market before using your wallet here.</p>
    <p className="terms-dialog-account num">{shortAccount(account, 28)}</p>
    <form onSubmit={event => {
      event.preventDefault();
      if (!termsAgreed || !privacyAcknowledged) return;
      try { onAccept(); }
      catch { setError("We couldn’t save your choice. Allow site storage in your browser and try again, or choose Not now to keep browsing."); }
    }}>
      <div className="terms-review-row">
        <Link href={LEGAL_DOCUMENTS.terms.href} target="_blank" rel="noopener noreferrer" aria-label="Read Terms of Use (opens in a new tab)">Read Terms of Use ↗</Link>
        <span>Version {LEGAL_DOCUMENTS.terms.version}</span>
      </div>
      <label className="terms-agreement"><input type="checkbox" required checked={termsAgreed} onChange={event => setTermsAgreed(event.target.checked)} /><span>I agree to the Terms of Use.</span></label>
      <div className="terms-review-row">
        <Link href={LEGAL_DOCUMENTS.privacy.href} target="_blank" rel="noopener noreferrer" aria-label="Read Privacy Policy (opens in a new tab)">Read Privacy Policy ↗</Link>
        <span>Version {LEGAL_DOCUMENTS.privacy.version}</span>
      </div>
      <label className="terms-agreement"><input type="checkbox" required checked={privacyAcknowledged} onChange={event => setPrivacyAcknowledged(event.target.checked)} /><span>I acknowledge the Privacy Policy.</span></label>
      <p className="terms-dialog-note">This choice is remembered for this wallet in this browser. A policy update may require you to review it again.</p>
      {error && <p className="terms-dialog-error" role="alert">{error}</p>}
      <div className="terms-dialog-actions"><Button variant="secondary" onClick={onDismiss}>Not now</Button><Button type="submit" disabled={!termsAgreed || !privacyAcknowledged}>Accept and continue</Button></div>
    </form>
  </dialog>;
}
