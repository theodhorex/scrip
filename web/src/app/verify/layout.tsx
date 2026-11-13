import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Verify | Scrip",
  description: "Every transaction Scrip cites, read back from NEAR testnet in your browser and compared with the claim.",
};

export default function VerifyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
