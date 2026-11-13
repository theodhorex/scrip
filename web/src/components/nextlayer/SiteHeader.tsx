"use client";

import { useEffect, useRef } from "react";
import { BrandMark } from "./BrandMark";
import { onScroll } from "./scroll-bus";
import "./header.css";

const LINKS = [
  { href: "#how", label: "How it works", watch: ["what", "how"] },
  { href: "#rules", label: "Rules", watch: ["rules", "race", "guardian"] },
  { href: "#proof", label: "Proof", watch: ["proof", "models", "envelope"] },
  { href: "#limits", label: "Limits", watch: ["limits", "closing"] },
] as const;

/** Compact header: reveals when scrolling up past the hero, hides when scrolling down. Scroll-spy with a sliding underline. */
export function SiteHeader() {
  const bar = useRef<HTMLElement>(null);
  const rule = useRef<HTMLSpanElement>(null);
  const nav = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = bar.current;
    const nv = nav.current;
    if (!el || !nv) return;
    let last = window.scrollY;
    let shown = false;
    let current = "";
    const links = Array.from(nv.querySelectorAll<HTMLAnchorElement>("a"));
    const setShown = (v: boolean) => {
      if (v === shown) return;
      shown = v;
      el.dataset.show = v ? "1" : "0";
      el.inert = !v;
    };
    setShown(false);
    return onScroll((y, vh) => {
      const dir = y - last;
      last = y;
      const j = document.querySelector<HTMLElement>("[data-nl-journey]");
      const heroEnd = j ? j.offsetTop + j.offsetHeight - vh * 0.3 : vh * 0.85;
      if (y < heroEnd) setShown(false);
      else if (dir < -4) setShown(true);
      else if (dir > 4) setShown(false);

      // scroll-spy: the last watched section whose top is above 40% of the viewport
      let hit = "";
      for (const l of LINKS) for (const id of l.watch) {
        const s = document.getElementById(id);
        if (s && s.getBoundingClientRect().top < vh * 0.4) hit = l.href;
      }
      if (hit !== current) {
        current = hit;
        links.forEach((a) => (hit && a.getAttribute("href") === hit ? a.setAttribute("aria-current", "location") : a.removeAttribute("aria-current")));
        const a = links.find((x) => x.getAttribute("href") === hit);
        const r = rule.current;
        if (r) {
          if (a) {
            r.style.opacity = "1";
            r.style.transform = `translateX(${a.offsetLeft}px)`;
            r.style.width = `${a.offsetWidth}px`;
          } else r.style.opacity = "0";
        }
      }
    });
  }, []);

  return (
    <header className="nl-sticky" ref={bar} data-show="0">
      <a className="nl-sticky-brand" href="#top" aria-label="Scrip, back to top"><BrandMark /></a>
      <nav className="nl-sticky-nav" aria-label="Sections" ref={nav}>
        {LINKS.map((l) => <a key={l.href} href={l.href}>{l.label}</a>)}
        <span className="nl-sticky-rule" ref={rule} aria-hidden="true" />
      </nav>
      <a className="nl-sticky-cta" href="/overview">Dashboard</a>
    </header>
  );
}
