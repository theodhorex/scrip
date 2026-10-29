"use client";

// Fixed scroll-progress hairline plus a chapter rail (desktop only).
import { useEffect, useRef, useState } from "react";

const CHAPTERS = [
  { id: "top", label: "Story" },
  { id: "rules", label: "Rules" },
  { id: "the-race", label: "Race" },
  { id: "the-guardian", label: "Guardian" },
  { id: "testnet-proof", label: "Proof" },
] as const;

export function ChapterRail() {
  const [active, setActive] = useState<string>("top");
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      if (barRef.current) barRef.current.style.transform = `scaleX(${p.toFixed(4)})`;
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
      },
      { rootMargin: "-45% 0px -50% 0px" },
    );
    for (const c of CHAPTERS) {
      const el = document.getElementById(c.id);
      if (el) io.observe(el);
    }
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, []);

  return (
    <>
      <div className="bp-progress" aria-hidden="true">
        <div ref={barRef} className="bp-progress-bar" />
      </div>
      <nav className="bp-rail" aria-label="Chapters">
        {CHAPTERS.map((c) => (
          <a
            key={c.id}
            href={`#${c.id}`}
            aria-current={active === c.id ? "true" : undefined}
            className="bp-rail-item"
          >
            <span className="bp-rail-label">{c.label}</span>
            <span className="bp-rail-dot" />
          </a>
        ))}
      </nav>
    </>
  );
}
