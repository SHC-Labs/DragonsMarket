import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans, JetBrains_Mono, Sora } from "next/font/google";
import "./globals.css";
import "./studio.css";
import "./palette.css";
import { WalletProvider } from "@/components/WalletProvider";
import palette from "@/design/palette.json";
import { Header } from "@/components/Header";
import { SmoothScroll } from "@/components/SmoothScroll";
import { Footer } from "@/components/Footer";

const plex = IBM_Plex_Sans({ variable: "--font-plex", subsets: ["latin"], weight: ["400", "500", "600"] });
const sora = Sora({ variable: "--font-brand", subsets: ["latin"], weight: "600", display: "swap" });
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"], weight: ["400", "500"] });

export const metadata: Metadata = {
  title: "Dragons Market | Prediction Markets",
  icons: { icon: "/brand/dragon-favicon.svg" },
  description: "Prediction markets on NEAR with published rules and public dispute decisions.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${plex.variable} ${jetbrains.variable} ${sora.variable}`}>
      <head><script dangerouslySetInnerHTML={{ __html: `(function(){var t='dark';try{t=localStorage.getItem('council-theme')||'dark'}catch(e){}document.documentElement.dataset.theme=t==='light'?'light':'dark';var c=/^\\/(council|membership)(\\/|$)/.test(location.pathname);var w=/^\\/watchlist(\\/|$)/.test(location.pathname);document.documentElement.dataset.palette=w?'watchlist':c?'council':'venue';var m=document.createElement('meta');m.name='theme-color';m.content=w?(t==='light'?'${palette.sections.watchlist.light.bg}':'${palette.sections.watchlist.dark.bg}'):c?(t==='light'?'${palette.sections.council.light.bg}':'${palette.sections.council.dark.bg}'):(t==='light'?'${palette.themes.light.bg}':'${palette.themes.dark.bg}');document.head.appendChild(m)})()` }} /></head>
      <body className="min-h-screen">
        <a href="#main-content" className="skip-link">Skip to content</a>
        <WalletProvider>
          <SmoothScroll />
          <div className="relative z-[1] flex min-h-screen flex-col">
            <Header />
            <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-[var(--page-max)] flex-1 px-[var(--gutter)] pb-24">{children}</main>
            <Footer />
          </div>
        </WalletProvider>
      </body>
    </html>
  );
}
