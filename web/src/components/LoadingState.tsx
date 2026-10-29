// Suspense fallback with a reserved height so streamed content does not shift the page.
export function LoadingState({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" className="min-h-64 space-y-4">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="bp-app-skel h-24" />
      <div aria-hidden="true" className="bp-app-grid2">
        <div className="bp-app-skel h-40" />
        <div className="bp-app-skel h-40" />
      </div>
    </div>
  );
}
