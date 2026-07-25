/**
 * Whether the internal design-system route may be served in this environment.
 *
 * A pure predicate over NODE_ENV rather than an inline `process.env` read, for
 * the same reason `shouldShowOcrStubNote` is one: the rule is worth a test,
 * and a test cannot change the ambient NODE_ENV of a module that already read
 * it at import time.
 *
 * Only "development" qualifies. This is an allowlist, not a
 * `!== "production"` denylist, so a preview deployment, a staging build, a CI
 * job or any future environment name is excluded by default. Getting that
 * backwards is precisely how `/design` ended up publicly live.
 *
 * ANY FUTURE `/design/*` PAGE MUST CALL THIS ITSELF, at the top of its own
 * component, exactly as `page.tsx` does:
 *
 *     if (!isDesignRouteEnabled(process.env.NODE_ENV)) notFound();
 *
 * A shared `layout.tsx` guard was tried and measured and does NOT work. It
 * produces the right 404 status, but by the time a layout runs, `children` is
 * already the resolved page element: the page's serialized component tree
 * still ends up in the response's RSC payload, so the swatch board leaks
 * inside a 404. (The business portal layout notes the same "children is
 * already resolved" property for a different reason.) The guard has to be in
 * the component that would otherwise render the content.
 */
export function isDesignRouteEnabled(nodeEnv: string | undefined): boolean {
  return nodeEnv === "development";
}
