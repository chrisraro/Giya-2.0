import { MarketingNav } from "@/components/marketing/nav";
import { MarketingFooter } from "@/components/marketing/footer";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="light flex min-h-dvh flex-col bg-surface text-on-surface">
      <noscript>
        <style>{`[data-reveal]{opacity:1!important;transform:none!important}`}</style>
      </noscript>
      <MarketingNav />
      <div className="flex-1">{children}</div>
      <MarketingFooter />
    </div>
  );
}
