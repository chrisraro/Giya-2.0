"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

export default function PendingApprovalPage() {
  const router = useRouter();
  const [checking, setChecking] = React.useState(false);
  const [statusMessage, setStatusMessage] = React.useState("");

  async function checkStatus() {
    setChecking(true);
    setStatusMessage("");
    try {
      const supabase = createClient();
      await supabase.auth.refreshSession();
      const { data: { user } } = await supabase.auth.getUser();

      if (!user) {
        router.push("/login");
        return;
      }

      const { data: staff } = await supabase
        .from("business_staff")
        .select("business_id, businesses(status)")
        .eq("user_id", user.id)
        .maybeSingle();

      const status = (staff as any)?.businesses?.status;

      if (status === "active") {
        router.push("/business/dashboard");
      } else {
        setStatusMessage("Your business status is still pending admin approval. Please check back shortly.");
      }
    } catch {
      setStatusMessage("Could not check status right now. Try again in a moment.");
    } finally {
      setChecking(false);
    }
  }

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <AuthCard
        title="Registration Pending Approval"
        subtitle="Your business application is under review."
      >
        <div className="my-4 flex flex-col items-center gap-4 text-center">
          <div className="flex size-16 items-center justify-center rounded-full bg-primary-container text-on-primary-container">
            <span className="material-symbols-rounded text-[32px]">hourglass_top</span>
          </div>

          <p className="text-body-m text-on-surface-variant">
            Thank you for registering your business with <strong>Giya</strong>. To ensure network trust and security, all new merchant accounts require verification by a Platform Admin (<code className="rounded bg-surface-container px-1 py-0.5 text-label-s">teamocsph@gmail.com</code>).
          </p>

          <p className="text-body-s text-outline">
            Once approved, your business portal dashboard, rewards catalog, and campaign engine will be unlocked automatically.
          </p>

          {statusMessage ? (
            <div role="status" className="w-full rounded-md3-xs bg-surface-container p-3 text-body-s text-on-surface">
              {statusMessage}
            </div>
          ) : null}

          <div className="flex w-full flex-col gap-3 pt-2">
            <Button
              type="button"
              variant="filled"
              size="touch"
              onClick={checkStatus}
              disabled={checking}
            >
              {checking ? "Checking Status..." : "Check Approval Status"}
            </Button>

            <Button
              type="button"
              variant="outlined"
              size="touch"
              onClick={handleSignOut}
            >
              Sign Out
            </Button>
          </div>
        </div>
      </AuthCard>
    </div>
  );
}
