"use client";

import { createContext, useContext } from "react";
import type { ProjectMeta } from "@/lib/n2n";

export type ProjectsContextValue = {
  projects: ProjectMeta[];
  activeId: string | null;
};

export const ProjectsContext = createContext<ProjectsContextValue>({
  projects: [],
  activeId: null,
});

export function useProjectsList(): ProjectsContextValue {
  return useContext(ProjectsContext);
}
