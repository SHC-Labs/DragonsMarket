import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "./icons";

// The collection's own art, shown where most visitors land: the dragons who sit on dispute juries.
const DRAGONS = [
  ["council-02.jpg", "Dark armored dragon robot with red eyes against a burning city"],
  ["robots-01.jpg", "Grey dragon robot with blue star eyes holding a green blade"],
  ["council-03.jpg", "Blue dragon robot with glowing green eyes and luminous tendrils"],
  ["robots-02.jpg", "Dragon robot with an orange crest and hexagon eyes"],
  ["council-01.jpg", "Yellow dragon robot with a green helmet, goggles and a respirator"],
  ["robots-06.jpg", "Dragon robot with pink horns and red slit eyes"],
  ["council-04.jpg", "Weathered metal dragon robot with red vented eyes against an orange skyline"],
];

export function CouncilCall() {
  return <section className="council-call" aria-labelledby="council-call-title">
    <div className="council-call-copy">
      <h2 id="council-call-title">When an answer is challenged, the dragons decide.</h2>
      <p>Disputed results go to a jury drawn from staked Dragon NFT seats. Every vote and its reason joins the public case record.</p>
      <Link href="/council" className="text-link">Meet the Council <ArrowRight size={16} /></Link>
    </div>
    <ul className="council-call-art">
      {DRAGONS.map(([file, alt], i) => <li key={file} style={{ "--i": i } as React.CSSProperties}><Image src={`/collection/${file}`} alt={alt} width={480} height={480} unoptimized /></li>)}
    </ul>
  </section>;
}
