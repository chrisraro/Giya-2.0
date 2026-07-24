// Minimal shell for the (business) route group. Dashboard chrome (sidebar,
// topbar) lives in the nested (portal) layout, so /business/onboarding keeps
// this chrome-free experience.
export default function BusinessLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-surface text-on-surface">{children}</div>;
}
