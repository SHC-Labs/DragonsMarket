import { CouncilSeal } from "./Threshold";
import { Sigil } from "./Sigil";
import { Eyebrow } from "./ui";
import { shortAccount } from "@/lib/format";
import { seedHex } from "@/lib/sigil";

const STEPS = [
  "Someone proposes an answer and puts up a bond.",
  "Anyone can challenge it with an equal bond.",
  "A jury votes. The majority decides, in public.",
];

export function CouncilBand({ panel }: { panel: string[] }) {
  return (
    <section id="council" className="council-sanctum relative isolate mt-8 overflow-hidden rounded-xl border border-council/40 bg-council-soft p-7 sm:p-12">
      <div className="absolute -right-24 -top-24 -z-10 h-[22.5rem] w-[22.5rem] rounded-full bg-council/20 blur-[6.875rem]" aria-hidden="true" />
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:items-center">
        <div>
          <Eyebrow tone="council">The inner circle · Public accountability</Eyebrow>
          <h2 className="display mt-4 text-[2.625rem] leading-[2.75rem] sm:text-[3.5rem] sm:leading-[3.5rem]">When an answer is disputed, the Council decides.</h2>
          <p className="mt-5 max-w-[32.5rem] text-muted">
            The planned Council brings NFT members into the work of reviewing evidence and resolving disputes. Bonded jurors would be drawn for each case, with conflict checks and public votes. Every verdict must answer to the evidence.
          </p>
          <ol className="m-0 mt-6 list-none space-y-3 p-0">
            {STEPS.map((text, i) => (
              <li key={text} className="flex items-start gap-3 text-sm">
                <span className="num flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-council text-xs text-council">{i + 1}</span>
                <span className="pt-0.5">{text}</span>
              </li>
            ))}
          </ol>
        </div>
        <div>
          <CouncilSeal className="mx-auto mb-6 h-28 w-28 text-council" />
          <ul className="m-0 grid list-none grid-cols-3 gap-3 p-0">
            {(panel.length ? panel : [1, 2, 3].map((n) => `seat-${n}`)).map((acct, i) => (
              <li key={acct} className="rounded-lg border border-border bg-canvas/60 p-3">
                <Sigil hash={seedHex(acct)} className="aspect-square w-full rounded-md" />
                <div className="num mt-2 text-xs text-council">#{String(i + 1).padStart(3, "0")}</div>
                <div className="num truncate text-xs text-muted" title={acct}>{panel.length ? shortAccount(acct, 14) : "open seat"}</div>
              </li>
            ))}
          </ul>
          <p className="mb-0 mt-4 text-xs text-muted">Every verdict belongs in the public record.</p>
        </div>
      </div>

    </section>
  );
}
