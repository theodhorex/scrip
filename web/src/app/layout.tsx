// Minimal root layout: fonts + metadata only (full-bleed landing at /, dashboard in (app)/layout.tsx)
// Source: https://nextjs.org/docs/app/api-reference/file-conventions/layout#root-layout
// Source: https://nextjs.org/docs/app/getting-started/fonts#google-fonts
import type { Metadata } from "next";
import { Fraunces, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  display: "swap",
});

const DESCRIPTION =
  "Capped spending mandates for AI agents on NEAR testnet: keys can be stolen, losses are capped by the budget you set.";

export const metadata: Metadata = {
  title: "Scrip | Agent spending mandates",
  description: DESCRIPTION,
  openGraph: {
    title: "Scrip | Agent spending mandates",
    description: DESCRIPTION,
    type: "website",
    siteName: "Scrip",
  },
  twitter: {
    card: "summary_large_image",
    title: "Scrip | Agent spending mandates",
    description: DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} h-full antialiased`}
    >
      <body className="min-h-full">{children}</body>
    </html>
  );
}
