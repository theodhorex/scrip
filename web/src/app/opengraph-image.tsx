import { ImageResponse } from "next/og";

export const alt = "Amanat: keys can be stolen, funds can't";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: 80, background: "#070d1a", backgroundImage: "linear-gradient(#1a2742 1px, transparent 1px), linear-gradient(90deg, #1a2742 1px, transparent 1px)", backgroundSize: "48px 48px", color: "#e8eef7" }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 28, color: "#2dd4bf", letterSpacing: 2 }}>NEAR TESTNET</div>
          <div style={{ fontSize: 96, fontFamily: "serif", marginTop: 24, lineHeight: 1.05 }}>Amanat</div>
          <div style={{ fontSize: 44, fontFamily: "serif", marginTop: 24, color: "#95a7c4" }}>Keys can be stolen.</div>
          <div style={{ fontSize: 44, fontFamily: "serif", color: "#e8eef7" }}>Funds can&apos;t.</div>
        </div>
        <svg width="320" height="360" viewBox="-80 -90 160 180">
          <polygon points="0,-80 69.3,-40 0,0 -69.3,-40" fill="#6f94f0" />
          <polygon points="-69.3,-40 0,0 0,80 -69.3,40" fill="#1f4fd8" />
          <polygon points="69.3,-40 0,0 0,80 69.3,40" fill="#173a9e" />
        </svg>
      </div>
    ),
    size,
  );
}
