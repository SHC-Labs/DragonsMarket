"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { GUIDE_STEPS, HowItWorks } from "./HowItWorks";
import { X, ArrowUpRight } from "./icons";
import { Button } from "./ui";

export function HowItWorksDialog() {
  const [step, setStep] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const previousOverflow = useRef<string | null>(null);

  useEffect(() => () => {
    if (previousOverflow.current !== null) document.body.style.overflow = previousOverflow.current;
  }, []);

  const open = () => {
    if (!dialog.current || dialog.current.open) return;
    setStep(0);
    previousOverflow.current = document.body.style.overflow;
    dialog.current.showModal();
    document.body.style.overflow = "hidden";
  };
  const restore = () => {
    if (previousOverflow.current === null) return;
    document.body.style.overflow = previousOverflow.current;
    previousOverflow.current = null;
    trigger.current?.focus({ preventScroll: true });
  };
  const close = () => {
    dialog.current?.close();
    restore();
  };

  const goToStep = (next: number) => {
    setStep(next);
    requestAnimationFrame(() => {
      dialog.current?.querySelector<HTMLElement>("[data-guide-heading]")?.focus({ preventScroll: true });
    });
  };

  return <>
    <button ref={trigger} type="button" className="how-it-works-trigger" aria-haspopup="dialog" aria-controls="how-it-works-dialog" onClick={open}>How it works</button>
    <dialog ref={dialog} id="how-it-works-dialog" className="guide-dialog" aria-labelledby="how-it-works-title" data-native-scroll onClose={restore} onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => {
      if (event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]'));
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    }}>
      <div className="guide-heading"><span className="brand-mark" aria-hidden="true" /><h2 id="how-it-works-title">How it works</h2><button type="button" className="guide-close" onClick={close} aria-label="Close guide"><X size={22} /></button></div>
      <div className="guide-progress"><span className="num">Step {step + 1} of {GUIDE_STEPS.length}</span><div className="guide-progress-bars" aria-hidden="true">{GUIDE_STEPS.map((item, index) => <span key={item.title} data-complete={index <= step} />)}</div></div>
      <HowItWorks step={step} />
      <div className="guide-actions"><Link href="/council" onClick={close}>How results are decided <ArrowUpRight size={16} /></Link><div className="guide-navigation"><Button variant="secondary" disabled={step === 0} onClick={() => goToStep(step - 1)}>Back</Button>{step < GUIDE_STEPS.length - 1 ? <Button onClick={() => goToStep(step + 1)}>Next</Button> : <Button onClick={close}>Finish</Button>}</div></div>
    </dialog>
  </>;
}
