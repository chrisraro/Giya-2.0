"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

import { acceptInviteAction } from "../actions";

export interface InviteAcceptProps {
  token: string;
}

/**
 * The one write on `/invite/[token]`. Split out of the page (a server
 * component) because accepting is a user-initiated CLICK, never a page
 * render - see service.ts's `previewInvite` header for why that split is
 * load-bearing, not just componentisation.
 */
export function InviteAccept({ token }: InviteAcceptProps) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function accept() {
    setPending(true);
    setError(null);

    const result = await acceptInviteAction(token);

    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.push("/business/dashboard");
  }

  return (
    <div className="flex flex-col gap-3">
      <Button type="button" variant="filled" size="touch" disabled={pending} onClick={() => void accept()}>
        {pending ? "Joining..." : "Accept invite"}
      </Button>
      {error ? (
        <p role="alert" className="text-body-s text-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
