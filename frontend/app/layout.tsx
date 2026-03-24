import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import { ZkpArtifactLog } from "@/components/ZkpArtifactLog";
import "./globals.css";

export const metadata: Metadata = {
  title: "Privacy-Preserving KYC",
  description: "Browser-first KYC with zero-knowledge proof verification.",
};

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`h-full ${sans.variable} ${mono.variable}`}>
      <body className="min-h-full bg-slate-950 font-sans text-slate-100 antialiased">
        <ZkpArtifactLog />
        {children}
      </body>
    </html>
  );
}
