// The Graph API version, in a module with no `server-only` import so the
// browser can read it too. The Facebook JS SDK that renders oEmbed Page embeds
// is loaded with `version=<this>`, and a server call on one version feeding an
// SDK on another is two versions to keep alive. src/lib/integrations/meta.ts
// re-exports it; nothing else may declare a Graph version.

/** Pinned. An unpinned Graph version is a silent breaking change on Meta's schedule. */
export const META_GRAPH_VERSION = "v25.0";
