// Bun macro entrypoint: walks assets/modules/ at compile time and inlines
// every module file as a literal into the produced binary. Pulled out of
// index.ts so any other module can import EMBEDDED_MODULES without having
// to re-declare the macro `with { type: "macro" }` annotation.

import { loadEmbeddedModules } from "./embed-modules.ts" with { type: "macro" };

export const EMBEDDED_MODULES = loadEmbeddedModules();
