import "server-only";

import { decryptToken } from "@/lib/crypto/token-cipher";
import { isMetaConfigured, publishFacebookPost } from "@/lib/integrations/meta";
import * as repo from "./repo";

export type PublishResult =
  | { readonly ok: true; readonly postId: string }
  | { readonly ok: false; readonly message: string };

export async function publishCampaignToMeta(input: {
  readonly businessId: string;
  readonly connectionId: string;
  readonly message: string;
  readonly linkUrl?: string;
}): Promise<PublishResult> {
  if (!isMetaConfigured()) {
    return { ok: false, message: "Meta integration is not configured on this deployment." };
  }

  const connection = await repo.readConnectionSecret({
    connectionId: input.connectionId,
    businessId: input.businessId,
  });

  if (!connection || connection.status !== "connected") {
    return { ok: false, message: "No active Facebook Page connection found." };
  }

  try {
    const pageToken = decryptToken(connection.accessTokenEncrypted);
    const post = await publishFacebookPost({
      pageId: connection.externalAccountId,
      pageAccessToken: pageToken,
      message: input.message,
      link: input.linkUrl,
    });

    return { ok: true, postId: post.id };
  } catch (error: any) {
    return { ok: false, message: error?.message ?? "Failed to publish post to Meta." };
  }
}
