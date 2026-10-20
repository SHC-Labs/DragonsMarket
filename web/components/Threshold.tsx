import { PageHeader } from "./PageHeader";

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
  return <PageHeader title="Prediction markets" />;
}
