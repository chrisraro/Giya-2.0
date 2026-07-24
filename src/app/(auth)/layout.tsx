import Link from "next/link";
import { Logo } from "@/components/brand/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center bg-surface px-4 py-10">
      <Link
        href="/"
        aria-label="Giya home"
        className="mb-8 rounded-md3-sm text-primary outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Logo variant="lockup" />
      </Link>
      <div className="flex w-full flex-1 items-start justify-center">{children}</div>
    </div>
  );
}
