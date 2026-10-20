import { config } from "@/lib/config";
import { Search, ArrowUpDown, Trophy } from "./icons";

export const GUIDE_STEPS = [
  { title: "Choose a market", text: "Find a question you follow. Read its rules, closing time and result source before taking a position." },
  { title: "Buy Yes or No", text: "Buy Yes if you think it will happen, No if you don’t. A Yes share at 40¢ reflects a 40% chance." },
  { title: "Follow the result", text: `After the result is final, winning shares pay 1 ${config.tokenSymbol} each. Losing shares pay nothing. Each market’s rules explain what happens if it is cancelled.` },
];
const STEP_ICONS = [Search, ArrowUpDown, Trophy];

export function HowItWorks({ step }: { step: number }) {
  const content = GUIDE_STEPS[step];
  const Icon = STEP_ICONS[step];
  return <div key={step} className="guide-stage">
    <span className="guide-stage-icon" aria-hidden="true"><Icon size={40} variant="Bulk" /></span>
    <div className="guide-stage-copy"><h3 data-guide-heading tabIndex={-1}>{content.title}</h3><p>{content.text}</p>{step === 1 && <div className="guide-outcomes" aria-hidden="true"><span>Yes</span><span>No</span></div>}</div>
  </div>;
}
