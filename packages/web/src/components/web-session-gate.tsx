"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSession } from "next-auth/react";
import { REFRESH_REUSE_GRACE_MS } from "@open-inspect/shared";
import { revokeAndSignOut } from "@/lib/sign-out";

/**
 * Check interval for web session token renewal. It stays inside the access
 * token renewal window so rotation completes before expiry.
 */
const WEB_SESSION_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const WEB_SESSION_FAILURE_RETRY_MS = REFRESH_REUSE_GRACE_MS / 4;

/**
 * Confirms that NextAuth and the control-plane token pair form a usable web
 * session before rendering authenticated children, then keeps that pair fresh.
 * Renewal cannot live in the NextAuth jwt callback (getServerSession cannot
 * persist rotated cookies), so this client-side gate drives rotation on
 * mount, focus/visibility, and an interval.
 */
export function WebSessionGate({ children }: { children?: ReactNode }) {
  const { status } = useSession();
  const signingOutRef = useRef(false);
  const [webSessionStatus, setWebSessionStatus] = useState<
    "checking" | "ready" | "temporarily_unavailable"
  >("checking");
  const [retryGeneration, setRetryGeneration] = useState(0);

  useEffect(() => {
    if (status === "authenticated") return;
    setWebSessionStatus("checking");
    signingOutRef.current = false;
  }, [status]);

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    let checkInFlight = false;
    let failureRetry: ReturnType<typeof setTimeout> | undefined;

    const clearFailureRetry = () => {
      if (failureRetry !== undefined) clearTimeout(failureRetry);
      failureRetry = undefined;
    };

    const scheduleFailureRetry = () => {
      if (failureRetry !== undefined) return;
      failureRetry = setTimeout(() => {
        failureRetry = undefined;
        void checkWebSession();
      }, WEB_SESSION_FAILURE_RETRY_MS);
    };

    const checkWebSession = async () => {
      if (checkInFlight) return;
      checkInFlight = true;
      try {
        const response = await fetch("/api/auth/oi-refresh", { method: "POST" });
        if (cancelled) return;
        if (response.status === 401 && !signingOutRef.current) {
          signingOutRef.current = true;
          const signedOut = await revokeAndSignOut();
          if (!signedOut && !cancelled) {
            signingOutRef.current = false;
            setWebSessionStatus("temporarily_unavailable");
          }
          return;
        }
        if (response.ok) {
          clearFailureRetry();
          setWebSessionStatus("ready");
          return;
        }
        setWebSessionStatus("temporarily_unavailable");
        scheduleFailureRetry();
      } catch {
        if (!cancelled) {
          setWebSessionStatus("temporarily_unavailable");
          scheduleFailureRetry();
        }
      } finally {
        checkInFlight = false;
      }
    };

    void checkWebSession();
    const checkInterval = setInterval(() => void checkWebSession(), WEB_SESSION_CHECK_INTERVAL_MS);
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") void checkWebSession();
    };
    window.addEventListener("focus", checkWhenVisible);
    document.addEventListener("visibilitychange", checkWhenVisible);
    return () => {
      cancelled = true;
      clearFailureRetry();
      clearInterval(checkInterval);
      window.removeEventListener("focus", checkWhenVisible);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, [retryGeneration, status]);

  if (status === "unauthenticated") return children ?? null;
  if (status !== "authenticated") return null;
  if (webSessionStatus === "temporarily_unavailable") {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="space-y-3 text-center">
          <p>Authentication temporarily unavailable</p>
          <button
            type="button"
            className="rounded-md border px-3 py-2"
            onClick={() => {
              setWebSessionStatus("checking");
              setRetryGeneration((generation) => generation + 1);
            }}
          >
            Retry
          </button>
        </div>
      </main>
    );
  }
  if (webSessionStatus !== "ready") return null;
  return children ?? null;
}
