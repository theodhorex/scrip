import type { ReactNode } from "react";

/** Section head: mono index on a hairline, a two-line masked title, an optional lede. Server component. */
export function SectionHead({ id, n, label, lines, lede, plain, todo }: { id: string; n: number; label: string; lines: string[]; lede?: ReactNode; plain?: ReactNode; todo?: ReactNode }) {
  return (
    <header className="nl-head">
      <div className="nl-idx"><span data-count={n} data-pad="2">{String(n).padStart(2, "0")}</span><span>{label}</span></div>
      <h2 className="nl-title" id={`${id}-title`} data-reveal="title">
        {lines.map((l, i) => (
          <span className="nl-line" key={l} style={{ "--i": i } as React.CSSProperties}><span>{l}</span></span>
        ))}
      </h2>
      {lede ? <p className="nl-lede" data-reveal="rise">{lede}</p> : null}
      {plain ? <p className="nl-plain" data-reveal="rise"><span>In plain words</span>{plain}</p> : null}
      {todo ? <p className="nl-todo" data-reveal="rise"><span>Do this</span>{todo}</p> : null}
    </header>
  );
}
