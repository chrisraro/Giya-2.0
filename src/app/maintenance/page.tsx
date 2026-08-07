import { EmptyState } from "@/components/consumer/empty-state";

export default function MaintenancePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-4 py-12 text-center">
      <EmptyState
        icon="build"
        title="System Maintenance"
        body="Giya is currently undergoing scheduled maintenance to improve our services. Please check back shortly."
      />
    </main>
  );
}
