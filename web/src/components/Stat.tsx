import type { ReactNode } from "react";

type StatProps = {
  label: string;
  value: ReactNode;
  hint?: string;
  mono?: boolean;
};

export function Stat({ label, value, hint, mono = false }: StatProps) {
  return (
    <div className="bp-plate bp-app-enter flex flex-col justify-between p-5">
      <dt className="bp-kicker">{label}</dt>
      <dd
        className={`mt-2 text-lg font-semibold text-bp-ink bp-tabular ${mono ? "font-mono" : ""}`}
      >
        {value}
      </dd>
      {hint && <p className="mt-1.5 text-xs leading-relaxed text-bp-muted">{hint}</p>}
    </div>
  );
}
