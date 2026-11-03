"use client";

import { useCallback, useRef, useState } from "react";
import { Notice } from "./ui";
import { agentError } from "@/lib/agents";

interface Step { busy: boolean; message: string | null; error: string | null }

export function useStep() {
  const [state, setState] = useState<Step>({ busy: false, message: null, error: null });
  const running = useRef(false);
  const run = useCallback(async (work: () => Promise<string | void>) => {
    if (running.current) return;
    running.current = true;
    setState({ busy: true, message: null, error: null });
    try {
      setState({ busy: false, message: (await work()) ?? null, error: null });
    } catch (e) {
      setState({ busy: false, message: null, error: agentError(e) });
    } finally {
      running.current = false;
    }
  }, []);
  return { ...state, run };
}

export function StepNotice({ step }: { step: { message: string | null; error: string | null } }) {
  if (step.error) return <Notice tone="danger">{step.error}</Notice>;
  return step.message ? <Notice>{step.message}</Notice> : null;
}
