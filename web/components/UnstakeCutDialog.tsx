"use client";

import { useEffect, useRef } from "react";
import { Button } from "./ui";

export function UnstakeCutDialog({ token, atRisk, quarterEnds, onConfirm, onCancel }: {
  token: string;
  atRisk: string;
  quarterEnds: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

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
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  return <dialog ref={dialog} className="terms-dialog" aria-labelledby="unstake-cut-title" aria-describedby="unstake-cut-text" data-native-scroll onCancel={event => { event.preventDefault(); onCancel(); }}>
    <h2 id="unstake-cut-title">Leaving costs half of this quarter</h2>
    <p id="unstake-cut-text">
      If you ask to unstake Dragon {token} before this quarter ends on {quarterEnds}, half of what the seat earned this quarter is cut and shared with the seats that stay. Right now that is {atRisk}. Earnings from quarters that already ended are paid in full, and the seat stops earning when you ask.
    </p>
    <p className="terms-dialog-note">You can keep your seat instead. Asking again later shows this message again.</p>
    <div className="terms-dialog-actions">
      <Button onClick={onCancel}>Keep my seat</Button>
      <Button variant="secondary" onClick={onConfirm}>Request unstake</Button>
    </div>
  </dialog>;
}
