"use client";

import { signOut } from "next-auth/react";
import { toast } from "sonner";

export async function revokeAndSignOut(): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/oi-revoke", { method: "POST" });
    if (!response.ok) {
      throw new Error(`Revocation failed with status ${response.status}`);
    }
    await signOut();
    return true;
  } catch {
    toast.error("Couldn't sign out securely. Please try again.");
    return false;
  }
}
