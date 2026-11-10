import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { WalletProvider } from "@/components/WalletProvider";
import { WatchlistProvider } from "@/components/WatchlistProvider";
import { color } from "@/lib/tokens";
import { Header } from "@/components/Header";
import { SmoothScroll } from "@/components/SmoothScroll";
import { Footer } from "@/components/Footer";

const plex = localFont({
  src: "./fonts/ibm-plex-sans.woff2", variable: "--font-plex", weight: "300 600", display: "swap",
});
const funnel = localFont({
  src: "./fonts/funnel-display.woff2", variable: "--font-funnel", weight: "400 700", display: "swap",
});
const plexMono = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-400.woff2", weight: "400" },
    { path: "./fonts/ibm-plex-mono-500.woff2", weight: "500" },
  ],
  variable: "--font-plex-mono", display: "swap",
});

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
          <WatchlistProvider>
            <SmoothScroll />
            <div className="app-frame">
              <Header />
              <main id="main-content" tabIndex={-1} className="app-main">{children}</main>
              <Footer />
            </div>
          </WatchlistProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
