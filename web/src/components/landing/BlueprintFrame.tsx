import type { ReactNode } from "react";

type BlueprintFrameProps = {
  children: ReactNode;
  tone?: "default" | "pass" | "reject";
  className?: string;
};

const CORNER_POSITIONS = [
  "-top-[5px] -left-[5px]",
  "-top-[5px] -right-[5px]",
  "-bottom-[5px] -left-[5px]",
  "-bottom-[5px] -right-[5px]",
] as const;

export function BlueprintFrame({
  children,
  tone = "default",
  className = "",
}: BlueprintFrameProps) {
  const toneClass =
    tone === "pass"
      ? "bp-plate-pass"
      : tone === "reject"
        ? "bp-plate-reject"
        : "";

  const crossColor =
    tone === "pass"
      ? "text-bp-pass/80"
      : tone === "reject"
        ? "text-bp-reject/80"
        : "text-bp-line-strong";

  return (
    <div className={`bp-plate ${toneClass} ${className}`.trim()}>
      {CORNER_POSITIONS.map((pos) => (
        <svg
          key={pos}
          aria-hidden="true"
          viewBox="0 0 9 9"
          className={`pointer-events-none absolute ${pos} h-[9px] w-[9px] ${crossColor}`}
        >
          <path
            d="M4.5 0V9M0 4.5H9"
            stroke="currentColor"
            strokeWidth="1.2"
          />
        </svg>
      ))}
      {children}
    </div>
  );
}
