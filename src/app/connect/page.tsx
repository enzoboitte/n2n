"use client";

import { useEffect } from "react";

// Legacy /connect route — connection management now lives inline inside the
// home page so it works under the file:// protocol that Electron uses with
// the static export. Anyone who lands here is bounced back to the home page.
export default function ConnectPage() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.location.replace("./");
  }, []);
  return null;
}
