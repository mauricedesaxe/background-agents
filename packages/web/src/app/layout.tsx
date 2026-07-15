import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "./providers";
import { APP_FAVICON_URL, APP_NAME } from "@/lib/site-config";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: APP_NAME,
  description: "Background coding agent for your team",
  icons: { icon: APP_FAVICON_URL },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Define esbuild's `__name` helper before any other script runs. The
            OpenNext/Cloudflare bundle emits `__name(...)` calls (keepNames) but
            doesn't always define the helper, which throws
            "__name is not defined" and breaks chunk loading (notably the tldraw
            board editor). This no-op stand-in just returns the target. */}
        <script
          dangerouslySetInnerHTML={{
            __html: "globalThis.__name||=(t)=>t;globalThis.__defProp||=Object.defineProperty;",
          }}
        />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
