import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "./studio.css";
import { WalletProvider } from "@/components/WalletProvider";
import { Header } from "@/components/Header";
import { SmoothScroll } from "@/components/SmoothScroll";
import { Footer } from "@/components/Footer";

const plex = IBM_Plex_Sans({ variable: "--font-plex", subsets: ["latin"], weight: ["400", "500", "600"] });
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"], weight: ["400", "500"] });
const instrument = Instrument_Serif({ variable: "--font-instrument", subsets: ["latin"], weight: "400", style: ["normal", "italic"] });

export const metadata: Metadata = {
  title: "The Council | Prediction Markets",
  description: "Prediction markets on NEAR with published rules and public dispute decisions.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0c0a10",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${plex.variable} ${jetbrains.variable} ${instrument.variable}`}>
      <head><script dangerouslySetInnerHTML={{ __html: `(function(){var t='dark';try{t=localStorage.getItem('council-theme')||'dark'}catch(e){}document.documentElement.dataset.theme=t==='light'?'light':'dark'})()` }} /></head>
      <body className="min-h-screen">
        <WalletProvider>
          <SmoothScroll />
          <div className="relative z-[1] flex min-h-screen flex-col">
            <Header />
            <main className="mx-auto w-full max-w-[var(--page-max)] flex-1 px-[var(--gutter)] pb-24">{children}</main>
            <Footer />
          </div>
        </WalletProvider>
      </body>
    </html>
  );
}
