import type { Metadata, Viewport } from "next";
import { Chakra_Petch, JetBrains_Mono, Orbitron, Rajdhani } from "next/font/google";
import "./globals.css";

const display = Orbitron({ subsets: ["latin"], weight: ["500", "700", "900"], variable: "--font-display" });
const body = Rajdhani({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-body" });
const numeric = Chakra_Petch({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-numeric" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "600"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Solar",
  description: "Home solar dashboard — live production, panels, history and problems",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#07060f" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${numeric.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
