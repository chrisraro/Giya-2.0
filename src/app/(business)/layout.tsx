// Minimal shell for the (business) route group. Dashboard chrome (sidebar,
// topbar) arrives in a later task and will live in a nested layout so that
// /business/onboarding keeps this chrome-free experience.
export default function BusinessLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-surface text-on-surface">{children}</div>;
}
