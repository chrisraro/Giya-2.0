import "server-only";

export interface RegionTarget {
  region: string;
  isPrimary: boolean;
  endpointUrl: string;
}

export function resolveRegionTarget(clientPop?: string): RegionTarget {
  const pop = (clientPop ?? "sin1").toLowerCase();

  if (pop.startsWith("sin") || pop.startsWith("mnl")) {
    return {
      region: "ap-southeast-1",
      isPrimary: true,
      endpointUrl: process.env.SUPABASE_URL ?? "https://zlfxfzlnklqhajacngxf.supabase.co",
    };
  }

  return {
    region: "ap-east-1",
    isPrimary: false,
    endpointUrl: process.env.SUPABASE_READ_REPLICA_URL ?? "https://zlfxfzlnklqhajacngxf.supabase.co",
  };
}

export function buildEdgeCacheHeaders(options: {
  isStatic?: boolean;
  maxAgeSeconds?: number;
  staleWhileRevalidateSeconds?: number;
}): Record<string, string> {
  const maxAge = options.maxAgeSeconds ?? 60;
  const swr = options.staleWhileRevalidateSeconds ?? 300;

  if (options.isStatic) {
    return {
      "Cache-Control": `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=${swr}`,
      "CDN-Cache-Control": `public, s-maxage=${maxAge * 2}`,
    };
  }

  return {
    "Cache-Control": "private, no-cache, no-store, must-revalidate",
  };
}
