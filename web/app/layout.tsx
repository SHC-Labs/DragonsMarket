import type { Metadata, Viewport } from "next";
import { Funnel_Display, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "@/components/WalletProvider";
import { color } from "@/lib/tokens";
import { Header } from "@/components/Header";
import { SmoothScroll } from "@/components/SmoothScroll";
import { Footer } from "@/components/Footer";

const plex = IBM_Plex_Sans({ variable: "--font-plex", subsets: ["latin"], weight: ["300", "400", "500", "600"] });
const funnel = Funnel_Display({ variable: "--font-funnel", subsets: ["latin"], weight: ["400", "500", "600", "700"], display: "swap" });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500"] });

export const metadata: Metadata = {
  title: "Dragons Market | Prediction markets",
  icons: { icon: "/brand/dragon-favicon.svg" },
  description: "The world moves and every outcome has a market. Dragons Market is building prediction markets on NEAR with published rules and a Council for disputes.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${plex.variable} ${plexMono.variable} ${funnel.variable}`}>
      <head><script dangerouslySetInnerHTML={{ __html: `(function(){var t='dark';try{t=localStorage.getItem('council-theme')||'dark'}catch(e){}document.documentElement.dataset.theme=t==='light'?'light':'dark';document.documentElement.dataset.palette='venue';var m=document.createElement('meta');m.name='theme-color';m.content=t==='light'?'${color("bg", "light")}':'${color("bg", "dark")}';document.head.appendChild(m)})()` }} /></head>
      <body>
        <a href="#main-content" className="skip-link">Skip to content</a>
        <WalletProvider>
          <SmoothScroll />
          <div className="app-frame">
            <Header />
            <main id="main-content" tabIndex={-1} className="app-main">{children}</main>
            <Footer />
          </div>
        </WalletProvider>
      </body>
    </html>
  );
}
