import Link from "next/link";
import { ArrowUpRight } from "@/components/icons";

export function CouncilSeal({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 400 400" fill="none" className={className} aria-hidden="true">
      <circle cx="200" cy="200" r="179" stroke="currentColor" strokeOpacity=".25" />
      <circle cx="200" cy="200" r="166" stroke="currentColor" strokeOpacity=".5" strokeDasharray="1 9" />
      <circle cx="200" cy="200" r="137" stroke="currentColor" strokeOpacity=".3" />
      <path d="M200 40 338 280H62L200 40ZM200 360 62 120h276L200 360Z" stroke="currentColor" strokeOpacity=".45" />
      <path d="M93 200s48-55 107-55 107 55 107 55-48 55-107 55S93 200 93 200Z" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="200" cy="200" r="34" stroke="currentColor" />
      <circle cx="200" cy="200" r="11" fill="currentColor" />
      <path d="M200 7v22M200 371v22M7 200h22M371 200h22" stroke="currentColor" />
      {[0, 60, 120, 180, 240, 300].map(a => <path key={a} d="m200 53 4 8-4 8-4-8Z" fill="currentColor" transform={`rotate(${a} 200 200)`} />)}
    </svg>
  );
}

export function Threshold() {
  return <section className="workspace-intro" aria-label="Prediction markets on NEAR">
    <div><p className="ritual-label">Prediction markets on NEAR</p><h2>What happens next?</h2><p>Pick a market. Read the rules. Back your answer.</p></div>
    <details className="market-help"><summary>How does this work?</summary><p>Buy Yes if you think it will happen, No if you don’t. A Yes share at 40¢ means the market is pricing a 40% chance. Winning shares pay 1 token after a final result. Losing shares pay nothing.</p><Link href="/council">How results are decided <ArrowUpRight size={16} /></Link></details>
  </section>;
}
