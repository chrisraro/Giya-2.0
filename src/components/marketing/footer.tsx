import Link from "next/link";
import { Logo } from "@/components/brand/logo";

const COLUMNS = [
  { title: "Product", links: [{ href: "/home", label: "Open Giya" }, { href: "/business", label: "For businesses" }] },
  { title: "Legal", links: [{ href: "/privacy", label: "Privacy policy" }, { href: "/terms", label: "Terms of service" }] },
] as const;

export function MarketingFooter() {
  return (
    <footer className="border-t border-outline-variant bg-surface-container-low">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:grid-cols-2 md:grid-cols-4">
        <div className="space-y-3">
          <div className="text-primary"><Logo variant="lockup" /></div>
          <p className="text-body-s text-on-surface-variant">Turn every receipt into rewards.</p>
        </div>
        {COLUMNS.map((col) => (
          <div key={col.title}>
            <h3 className="text-title-s text-on-surface">{col.title}</h3>
            <ul className="mt-3 space-y-2">
              {col.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-body-m text-on-surface-variant transition-colors hover:text-on-surface">{l.label}</Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div>
          <h3 className="text-title-s text-on-surface">Contact</h3>
          <a href="mailto:teamocsph@gmail.com" className="mt-3 block text-body-m text-on-surface-variant transition-colors hover:text-on-surface">teamocsph@gmail.com</a>
        </div>
      </div>
      <div className="border-t border-outline-variant/60">
        <p className="mx-auto max-w-6xl px-4 py-4 text-body-s text-on-surface-variant">© 2026 Giya. Made in the Philippines.</p>
      </div>
    </footer>
  );
}
