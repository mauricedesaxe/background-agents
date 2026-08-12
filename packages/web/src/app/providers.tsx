"use client";

import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import { ThemeProvider } from "next-themes";
import { SWRConfig } from "swr";
import { WebSessionGate } from "@/components/web-session-gate";
import { Toaster } from "@/components/ui/sonner";
import { SyntaxHighlightTheme } from "@/components/syntax-highlight-theme";

async function swrFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.json();
}

export function Providers({
  children,
  session,
}: {
  children: React.ReactNode;
  session: Session | null;
}) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <SWRConfig value={{ fetcher: swrFetcher, revalidateOnFocus: true, dedupingInterval: 2000 }}>
        <SessionProvider session={session} refetchOnWindowFocus={false}>
          <WebSessionGate>{children}</WebSessionGate>
          <SyntaxHighlightTheme />
          <Toaster />
        </SessionProvider>
      </SWRConfig>
    </ThemeProvider>
  );
}
