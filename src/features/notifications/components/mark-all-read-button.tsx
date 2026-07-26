"use client";

import { useFormStatus } from "react-dom";

import { CircularProgress } from "@/components/ui/progress";

// The inbox header's "Mark all read" submit button.
//
// WHY THIS IS ITS OWN COMPONENT AND NOT A RENDER PROP.
//
// The obvious shape for "give me the pending flag and let me draw the button"
// is a render prop: `<FormPending>{(pending) => <button .../>}</FormPending>`.
// That shape is a Server Component crash, and it took /notifications down in
// production. `useFormStatus` is a hook, so anything reading it is a client
// component, so the render prop is a FUNCTION passed from a server component
// (the page) across the client boundary. React's Flight serializer cannot
// encode a function, and refuses:
//
//   Error: Functions cannot be passed directly to Client Components unless you
//   explicitly expose it by marking it with "use server".
//     {children: function children}
//
// It fails at RENDER, not at build, so the build is green and the page 500s -
// and only for the people who have something unread, because the button is the
// only thing behind `unread > 0`. Everybody else got a working inbox.
//
// The fix is the pattern this feature already used one file over
// (notification-row-button.tsx): the CLIENT component reads its own
// `useFormStatus`, and the server component passes it nothing but data. Nothing
// crosses the boundary that cannot be serialized because nothing crosses it but
// props React can encode.
//
// Rendered inside the `<form>` it belongs to: `useFormStatus` reports the
// nearest ancestor form, and a sibling of the form reads `false` forever.

export function MarkAllReadButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="inline-flex h-9 items-center gap-2 rounded-full px-4 text-label-l text-primary transition-colors duration-200 ease-standard motion-reduce:transition-none hover:bg-surface-container outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-40"
    >
      {/* The spinner's 16px box is always in the layout, empty when idle.
          Growing the button by 24px mid-press would drag it leftward across
          the header. */}
      <span className="inline-flex size-4 items-center justify-center">
        {pending ? <CircularProgress size="sm" /> : null}
      </span>
      Mark all read
    </button>
  );
}
