const STEPS = [
  { n: "01", title: "Find your question", text: "Pick an event you follow. Check the closing time, result source and rules before taking a position." },
  { n: "02", title: "Buy Yes or No", text: "Shares cost between 1 and 99 cents. The price is the market's chance. Sell any time before it closes." },
  { n: "03", title: "Follow it to the finish", text: "Track your position in Portfolio. After a final result, redeem winning shares for 1 token each. Losing shares pay nothing." },
];

export function HowItWorks() {
  return (
    <section aria-label="How it works" className="mt-6 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-3">
      {STEPS.map((s) => (
        <div key={s.n} className="bg-canvas/90 p-6">
          <div className="num text-xs text-muted">{s.n}</div>
          <h3 className="display mb-2 mt-3 text-[1.75rem] leading-8">{s.title}</h3>
          <p className="m-0 text-sm leading-6 text-muted">{s.text}</p>
        </div>
      ))}
    </section>
  );
}
