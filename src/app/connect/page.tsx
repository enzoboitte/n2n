"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ServerPicker } from "@/components/ui/ServerPicker";
import { getActiveProfile, listServerProfiles, pingServer } from "@/lib/n2n";

// Standalone landing page for choosing / managing n2n backends. The Electron
// build ships this route and the workspace navigates here whenever no
// profile is active or the active one is unreachable.
export default function ConnectPage() {
  const router = useRouter();
  const [hasWorkingConnection, setHasWorkingConnection] = useState(false);

  // If we land here while already connected (e.g. user clicked the gear from
  // the workspace), expose a "Retour" button. We only set this once so the
  // affordance doesn't disappear if the user starts editing a profile.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.n2n) {
      setHasWorkingConnection(true);
      return;
    }
    let cancelled = false;
    const active = getActiveProfile();
    if (!active) return;
    pingServer(active.url, {
      token: active.token,
      signal: AbortSignal.timeout(2000),
    })
      .then((info) => {
        if (cancelled) return;
        if (!info.authRequired || active.token) setHasWorkingConnection(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-slate-50 px-4 py-10 dark:bg-slate-900">
      <div className="flex w-full max-w-xl flex-col gap-3">
        <div className="flex items-center gap-3 text-slate-700 dark:text-slate-200">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-slate-900 text-[12px] font-bold text-white dark:bg-white dark:text-slate-900">
            n2n
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-lg font-semibold">Bienvenue</span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {listServerProfiles().length === 0
                ? "Pour commencer, déclare le serveur n2n auquel cette interface doit se connecter."
                : "Choisis un serveur pour ouvrir tes workflows."}
            </span>
          </div>
        </div>

        <ServerPicker
          title="Serveurs n2n"
          subtitle="Local · VPS · prod — tes connexions sont stockées localement, jamais envoyées au serveur."
          onConnected={() => {
            // Switching profile changes localStorage; do a hard reload of the
            // workspace to flush every cached hook against the new backend.
            if (typeof window !== "undefined") {
              window.location.assign("/");
            } else {
              router.replace("/");
            }
          }}
          onClose={
            hasWorkingConnection
              ? () => {
                  if (typeof window !== "undefined") window.location.assign("/");
                  else router.replace("/");
                }
              : undefined
          }
        />

        <p className="px-1 text-[11px] text-slate-400 dark:text-slate-500">
          Pour héberger ton propre serveur :{" "}
          <code>N2N_API_TOKEN=… ./n2n-server</code> derrière un proxy HTTPS,
          puis colle l'URL et le token ici.
        </p>
      </div>
    </div>
  );
}
