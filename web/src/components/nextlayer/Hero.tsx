"use client";

import { useEffect, useRef, useState } from "react";
import { BrandMark } from "./BrandMark";
import { HERO_POSTER, HERO_VIDEO_URL } from "./media";
import "./hero.css";

const NAV = [
  { href: "#how", label: "How it works" },
  { href: "#rules", label: "Rules" },
  { href: "#proof", label: "Proof" },
  { href: "#limits", label: "Limits" },
] as const;

/** Four honest evidence markers. Glyphs are drawn here (a budget line runs through each), no third-party logos. */
const STRIP = [
  { label: "NEAR testnet", glyph: <><circle cx="13" cy="13" r="10" fill="none" stroke="currentColor" strokeWidth="2.4" /><path d="M3 13h20" stroke="currentColor" strokeWidth="2.4" /></> },
  { label: "NEP-366 delegates", glyph: <><rect x="2" y="8" width="9" height="10" fill="currentColor" /><path d="M13 13h9m-3-4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="2.4" /></> },
  { label: "NEP-141 test USDC", glyph: <><circle cx="13" cy="13" r="10" fill="none" stroke="currentColor" strokeWidth="2.4" /><path d="M13 7v12" stroke="currentColor" strokeWidth="2.4" /></> },
  { label: "NEP-297 events", glyph: <><path d="M3 6h20M3 13h14M3 20h8" fill="none" stroke="currentColor" strokeWidth="2.4" /></> },
] as const;

export function Hero() {
  const [open, setOpen] = useState(false);
  const plateRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Video: still frame only for reduced motion / data saver; pause when the hero is off-screen.
  useEffect(() => {
    const plate = plateRef.current;
    const video = videoRef.current;
    if (!plate || !video) return;
    const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
    const stillOnly = matchMedia("(prefers-reduced-motion: reduce)").matches || nav.connection?.saveData === true;
    if (stillOnly) {
      plate.dataset.static = "1";
      video.pause();
      return;
    }
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void video.play().catch(() => {});
      else video.pause();
    });
    io.observe(plate);
    return () => io.disconnect();
  }, []);

  // Menu: Escape and "resized to landscape" close it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onResize = () => innerWidth / innerHeight > 1.1 && setOpen(false);
    addEventListener("keydown", onKey);
    addEventListener("resize", onResize);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    <div className={`nl-stage${open ? " is-open" : ""}`} data-nl-stage>
      <div className="nl-plate" ref={plateRef}>
        {/* eslint-disable-next-line @next/next/no-img-element -- LCP still under the third-party video; plain img keeps it simple */}
        <img className="nl-plate-still" src={HERO_POSTER} alt="" width={1664} height={1248} fetchPriority="high" decoding="async" aria-hidden="true" />
        <video
          ref={videoRef}
          className="nl-plate-video"
          autoPlay muted loop playsInline preload="auto" aria-hidden="true" tabIndex={-1}
          poster={HERO_POSTER}
          disablePictureInPicture disableRemotePlayback controlsList="nodownload noremoteplayback"
        >
          <source src={HERO_VIDEO_URL} type="video/mp4" />
        </video>
      </div>

      <header className="nl-topbar">
        <a className="nl-brand" href="#top" aria-label="Scrip home"><BrandMark /></a>
        <nav className="nl-links" aria-label="Primary">
          {NAV.map((n) => <a key={n.href} href={n.href}>{n.label}</a>)}
        </nav>
        <a className="nl-pill nl-pill-nav" href="/overview"><span>Dashboard</span></a>
        <button
          type="button" className="nl-burger" aria-expanded={open} aria-controls="nl-menu"
          aria-label={open ? "Close menu" : "Open menu"} onClick={() => setOpen((v) => !v)}
        ><i /><i /></button>
      </header>

      <nav className="nl-menu" id="nl-menu" aria-label="Menu" aria-hidden={!open} inert={!open}>
        <div className="nl-menu-inner">
          <p className="nl-menu-eyebrow">Menu</p>
          <ul className="nl-menu-list">
            {NAV.map((n) => <li key={n.href}><a href={n.href} onClick={() => setOpen(false)}>{n.label}</a></li>)}
          </ul>
          <div className="nl-menu-foot">
            <a className="nl-pill nl-pill-cta" href="/overview" onClick={() => setOpen(false)}><span>Dashboard</span></a>
            <a className="nl-ghost" href="/attack" onClick={() => setOpen(false)}>See the attacks</a>
          </div>
        </div>
      </nav>

      <a className="nl-door" href="#what" tabIndex={-1} aria-hidden="true"><span>Click to go inside</span></a>
      <div className="nl-flood" aria-hidden="true" />
      <p className="nl-flood-text" aria-hidden="true"><span>Inside, every payment</span> <span>meets the same seven gates.</span></p>
      <p className="nl-hint" aria-hidden="true">Scroll to go through</p>

      <div className="nl-hero">
        <h1 className="nl-headline"><span>Give agents</span> <span>a budget.</span></h1>
        <p className="nl-sub">
          <span>Mandates on NEAR cap what an AI agent can spend:</span>{" "}
          <span>a budget, allowed recipients and a guardian.</span>
        </p>
        <div className="nl-actions">
          <a className="nl-pill nl-pill-cta" href="/attack"><span>See the attacks</span></a>
          <a className="nl-ghost" href="#how">How it works</a>
        </div>
      </div>

      <ul className="nl-logos" aria-label="Built on">
        {STRIP.map((s) => (
          <li className="nl-lg" key={s.label}>
            <svg viewBox="0 0 26 26" aria-hidden="true" focusable="false">{s.glyph}</svg>
            <span>{s.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
