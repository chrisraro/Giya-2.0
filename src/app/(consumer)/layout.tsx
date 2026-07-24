import { BottomNav } from "@/components/shell/bottom-nav";

export default function ConsumerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-surface pb-24">
      {children}
      <BottomNav />
    </div>
  );
}
