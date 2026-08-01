// Constants for the home screen's discover section.
//
// These live beside page.tsx rather than inside it because Next.js constrains
// what a page module may export: `default`, `metadata`, `dynamic`, `revalidate`
// and a fixed set of route config keys, and nothing else. An extra export makes
// the generated route type fail its `{ [x: string]: never }` constraint, which
// surfaces only during `next build`'s type check and therefore breaks the
// deployment rather than the local test run.
//
// The test imports these too, which is what made the illegal export tempting.

/** How many shops the discover section lists before deferring to /scan. */
export const HOME_DISCOVER_LIMIT = 5;

// Shops the consumer already earns points at are dropped from "discover" (they
// are already in the balance strip above), so the read over-fetches to keep the
// section from coming back short after that filter.
export const HOME_DISCOVER_FETCH = HOME_DISCOVER_LIMIT * 2;
