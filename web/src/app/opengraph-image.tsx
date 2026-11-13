import { ImageResponse } from "next/og";

export const alt = "Scrip: give agents a budget, not your keys";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Same mark as the site header (components/nextlayer/BrandMark.tsx), flat fills because the image renderer has no gradients here.
export default function Image() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: 88, background: "#050505", color: "#fafafa" }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 26, color: "#8b8a8a", letterSpacing: 1 }}>NEAR testnet</div>
          <div style={{ fontSize: 120, marginTop: 20, lineHeight: 1, fontWeight: 300 }}>Scrip</div>
          <div style={{ fontSize: 46, marginTop: 28, color: "#a7a6a6", fontWeight: 300 }}>Give agents a budget,</div>
          <div style={{ fontSize: 46, color: "#fafafa", fontWeight: 300 }}>not your keys.</div>
        </div>
        <svg width="270" height="420" viewBox="0 0 31.5 48.5">
          <path d="M21.5 0 L21.5 19.5 L31.5 19.5 L31.5 29 L10 48.5 L10 28.5 L0.5 28.5 L0.5 18.5 Z" fill="#a9a9a9" />
          <rect x="0.5" y="18.5" width="9" height="10" fill="#fdfdfd" />
          <rect x="22" y="19.5" width="9.5" height="9.5" fill="#fdfdfd" />
        </svg>
      </div>
    ),
    size,
  );
}
