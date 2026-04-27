export function EmptyState() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="rounded-lg border border-dashed border-slate-300 bg-white/60 px-6 py-3 text-sm text-slate-500 backdrop-blur-sm dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-400">
        Cliquez un module dans la palette pour l&apos;ajouter
      </div>
    </div>
  );
}
