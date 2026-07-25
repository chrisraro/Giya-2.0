import { NotFoundPanel } from "@/components/shell/not-found-panel";

// The ROOT 404 boundary.
//
// Next requires this file for the global case: any URL that matches no route
// at all, anywhere in the app, renders here inside the root layout. Without it
// Next falls back to its own built-in 404, which emits its inline `<style>` as
// a React child rather than a real stylesheet, so none of its colours ever
// apply and the text inherits whatever the surrounding layout set. On this
// app's light `bg-surface` that computed to white on near-white, roughly
// 1.02:1 contrast, which is invisible.
//
// This one deliberately does NOT sit inside the consumer shell: an unmatched
// URL can be reached from the marketing site, the business portal or the auth
// pages just as easily as from the consumer app, so the recovery link is the
// Giya landing page rather than the wallet. `(consumer)/not-found.tsx` handles
// the consumer-shell case and takes precedence for routes inside that group.
export default function NotFound() {
  return (
    <NotFoundPanel
      title="We could not find that page"
      body="The link may be old or mistyped, or the page may have moved. Nothing is wrong with your account."
      actions={[{ label: "Go to Giya home", href: "/", icon: "home" }]}
    />
  );
}
