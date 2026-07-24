import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Logo } from "@/components/brand/logo";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { icon: "home", label: "Home", active: true },
  { icon: "account_balance_wallet", label: "Wallet", active: false },
  { icon: "redeem", label: "Rewards", active: false },
  { icon: "person", label: "Profile", active: false },
] as const;

export function PhonePreview({ className }: { className?: string }) {
  return (
    <div className={cn("relative mx-auto w-[290px] select-none rounded-[2.25rem] border-8 border-inverse-surface bg-surface shadow-xl", className)}>
      <div className="space-y-4 px-4 pb-20 pt-8">
        <div className="flex items-center justify-between">
          <p className="text-title-m">Magandang umaga, Mia</p>
          <div className="text-primary"><Logo variant="mark" className="size-6" /></div>
        </div>
        <Card variant="elevated">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Kape Diaria</CardTitle>
              <Badge>+120 pts</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-headline-s text-on-surface">1,250 pts</p>
            <p className="mt-1">3 stamps to your free latte</p>
          </CardContent>
        </Card>
        <div className="flex items-center justify-between rounded-md3-md bg-surface-container px-4 py-3">
          <div className="flex gap-2 text-tertiary">
            {[0, 1, 2].map((i) => (<Logo key={i} variant="stamp" className="size-7" />))}
            {[0, 1].map((i) => (<Logo key={`e${i}`} variant="stamp" className="size-7 opacity-25" />))}
          </div>
          <p className="text-label-m text-on-surface-variant">3 of 5</p>
        </div>
      </div>
      {/* Mini bottom-nav strip mirroring the real app shell */}
      <div className="absolute inset-x-0 bottom-0 rounded-b-[1.75rem] border-t border-outline-variant bg-surface-container px-3 pb-3 pt-1">
        <div className="flex items-center justify-between">
          {NAV_ITEMS.slice(0, 2).map((n) => (<MiniNavItem key={n.icon} {...n} />))}
          <span className="flex size-11 -translate-y-3 items-center justify-center rounded-md3-lg bg-tertiary-container text-on-tertiary-container shadow-lg">
            <span aria-hidden className="material-symbols-rounded text-[20px]">document_scanner</span>
          </span>
          {NAV_ITEMS.slice(2).map((n) => (<MiniNavItem key={n.icon} {...n} />))}
        </div>
      </div>
    </div>
  );
}

function MiniNavItem({ icon, label, active }: (typeof NAV_ITEMS)[number]) {
  return (
    <span className="flex flex-col items-center gap-0.5">
      <span className={cn("flex h-6 w-10 items-center justify-center rounded-full", active && "bg-primary-container")}>
        <span aria-hidden className={cn("material-symbols-rounded text-[18px]", active ? "is-filled text-on-primary-container" : "text-on-surface-variant")}>{icon}</span>
      </span>
      <span className={cn("text-[10px] font-medium", active ? "text-on-surface" : "text-on-surface-variant")}>{label}</span>
    </span>
  );
}
