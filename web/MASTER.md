# Scrip Frontend Design Rules (MASTER)

## 1. Typography
- **Display / Headlines**: Fraunces (`font-serif`) for hero and chapter titles.
- **Body / Prose**: Geist Sans (`font-sans`) for explanations and copy (<80 char lines).
- **Real Data**: Geist Mono (`font-mono`) exclusively for on-chain hashes, numbers, codes, amounts.

## 2. Palette & Semantic Tokens (`globals.css`)
- **Canvas & Surface**: `--bp-canvas` (`#070d1a`), `--bp-surface` (`#0c1527`), `--bp-surface-raised` (`#101c33`).
- **Blueprint Grid Lines**: `--bp-line` (`#1a2742`), `--bp-line-strong` (`#273a60`).
- **Text Ink**: `--bp-ink` (`#e8eef7`), `--bp-muted` (`#95a7c4`).
- **Enforcement Status**: `--bp-pass` (`#2dd4bf` teal/cyan), `--bp-reject` (`#ff6b4a` orange/red).

## 3. Color Usage Rules
- Cyan-teal (`bp-pass`): Permitted, settled, active invariant, clean balance.
- Orange-red (`bp-reject`): Refused attack, over-budget, unauthorized recipient, leak.
- No arbitrary colors: status colors carry strict cryptographic meaning.

## 4. Numbers & Data Integrity
- Zero hardcoded numbers or tx hashes in UI components.
- All metrics parsed from `results/*.json` via pure mappers (`landing-data.ts`, `proof-data.ts`).
- USDC is 6-decimal on-chain; format with `formatUsdcFixed` or `formatUsdc6`.

## 5. Motion & Transitions
- Always respect `prefers-reduced-motion` via `useReducedMotion()`.
- Autoplay animations must provide visible Pause/Play and Step/Reset controls.
- Viewport entrance transitions use safe `IntersectionObserver` with instant fallback.

## 6. Accessibility (WCAG 2.1 AA)
- Focus indicators: visible `focus:ring-1 focus:ring-bp-pass` on all interactive targets.
- Clipboard copy actions must provide instant `aria-live="polite"` feedback for screen readers.
- External links require `target="_blank"`, `rel="noopener noreferrer"`, and descriptive `aria-label`.

## 7. Landing Chapter Map
- **Hero & Schematic**: `src/components/landing/HeroSection.tsx` (`HeroDesktopSvg`, `HeroMobileSvg`)
- **01 / The Rule Machine**: `src/components/landing/RuleMachineSection.tsx`
- **02 / The Race**: `src/components/landing/RaceSection.tsx`
- **03 / The Guardian**: `src/components/landing/GuardianSection.tsx`
- **04 / Testnet Proof**: `src/components/landing/ProofSection.tsx`
- **Closing**: `src/components/landing/ClosingSection.tsx`
- **Footer**: `src/components/landing/Footer.tsx`
