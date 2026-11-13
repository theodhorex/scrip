"use client";

import { SectionHead } from "./Section";
import { VaultScene } from "./VaultScene";
import "./base.css";

const COLS = [
  { h: "Understand", links: [{ t: "In plain words", href: "#what" }, { t: "How it works", href: "#how" }, { t: "Rule machine", href: "#rules" }, { t: "Guardian", href: "#guardian" }] },
  { h: "Evidence", links: [{ t: "Recorded run", href: "#race" }, { t: "Proof", href: "#proof" }, { t: "Real models", href: "#models" }, { t: "Attack results", href: "/attack" }, { t: "Verify transactions", href: "/verify" }, { t: "Limits", href: "#limits" }] },
  { h: "Product", links: [{ t: "Dashboard", href: "/overview" }, { t: "Around the contract", href: "#envelope" }] },
  { h: "Source", links: [{ t: "GitHub repository", href: "https://github.com/theodhorex/scrip", ext: true }, { t: "Notes for judges", href: "https://github.com/theodhorex/scrip/blob/main/JUDGES.md", ext: true }] },
] as const;
/** Same facts as the Limits section. No dates beyond the one the verified numbers carry. */
const STATUS = [["Network", "NEAR testnet"], ["Funds", "Test USDC only"], ["Audit", "None by a third party"], ["Figures as of", "12 Nov 2026"]] as const;

export function Closing() {
  return (
    <>
      <section className="nl-sec nl-closing" id="closing" aria-labelledby="closing-title">
        <div className="nl-wrap">
          <SectionHead id="closing" n={9} label="Next" lines={["The agent can be fooled.", "The budget cannot."]} />
          <a className="nl-pill nl-pill-cta" href="/attack" style={{ display: "inline-flex" }}><span>See the attacks</span></a>
        </div>
      </section>
      <footer className="nl-footer" aria-label="Site footer">
        <div className="nl-wrap nl-footer-grid">
          <div className="nl-footer-word" aria-hidden="true">Scrip</div>
          <VaultScene />
        </div>
        <div className="nl-wrap">
          <div className="nl-foot-lead">
            <p>Give agents a budget, not your keys.</p>
            <a className="nl-pill nl-pill-cta" href="#rules" style={{ display: "inline-flex" }}><span>Try the rule machine</span></a>
          </div>
          <nav className="nl-foot-cols" aria-label="Footer">
            {COLS.map((c) => (
              <div key={c.h}>
                <h3>{c.h}</h3>
                <ul>{c.links.map((l) => <li key={l.t}>{"ext" in l ? <a className="nl-foot-link" href={l.href} target="_blank" rel="noopener noreferrer" aria-label={`${l.t} (opens in a new tab)`}>{l.t}</a> : <a className="nl-foot-link" href={l.href}>{l.t}</a>}</li>)}</ul>
              </div>
            ))}
            <div>
              <h3>Status</h3>
              <dl className="nl-foot-status">
                {STATUS.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
              </dl>
            </div>
          </nav>
          <div className="nl-foot-base">
            <p>Built with Claude Code (planning, review, code) and Antigravity CLI with Claude Sonnet 5.5 and Gemini (delegated implementation). Real-model tests ran qwen3, llama3.2 and qwen2.5 through Ollama. Scrip, a NEAR hackathon project. Every number on this page is labelled with its source and date. Nothing here is financial advice.</p>
            <button type="button" className="nl-btn" onClick={() => window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })}>Back to top <span aria-hidden="true">↑</span></button>
          </div>
        </div>
      </footer>
    </>
  );
}
