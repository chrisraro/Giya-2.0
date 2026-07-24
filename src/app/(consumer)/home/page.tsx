import { Logo } from "@/components/brand/logo";

export default function HomePage() {
  return (
    <main className="mx-auto max-w-md px-4 pt-6">
      <Logo variant="lockup" className="text-primary" />
      <h1 className="mt-4 text-headline-m">Home</h1>
      <p className="mt-2 text-body-m text-on-surface-variant">Coming soon.</p>
    </main>
  );
}
