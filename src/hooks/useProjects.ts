"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getApi, type Project, type ProjectMeta } from "@/lib/n2n";

export type LoadedGraph = { id: string; nodes: unknown[]; edges: unknown[] };

type State = {
  projects: ProjectMeta[];
  activeId: string | null;
  ready: boolean;
};

type UseProjectsApi = State & {
  refresh: () => Promise<void>;
  switchTo: (id: string) => Promise<Project | null>;
  create: (name?: string) => Promise<Project | null>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<Project | null>; // returns next active project after delete
  duplicate: (id: string) => Promise<Project | null>;
  exportToFile: (id: string) => Promise<void>;
  importFromFile: () => Promise<Project | null>;
};

export function useProjects(): UseProjectsApi & {
  /** Set when the active project's graph has just been (re)loaded. */
  loadedGraph: { id: string; nodes: unknown[]; edges: unknown[] } | null;
} {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [loadedGraph, setLoadedGraph] = useState<{
    id: string;
    nodes: unknown[];
    edges: unknown[];
  } | null>(null);
  const bootRef = useRef(false);

  const refresh = useCallback(async () => {
    const api = getApi();
    if (!api) return;
    const list = await api.listProjects();
    setProjects(list);
  }, []);

  // Boot: load list, ensure an active project exists, hydrate it.
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    const api = getApi();
    if (!api) {
      setReady(true);
      return;
    }
    (async () => {
      let list = await api.listProjects();
      let id = await api.getActiveProjectId();
      if (!id || !list.find((p) => p.id === id)) {
        let project: Project;
        if (list.length === 0) {
          project = await api.createProject("Mon projet");
        } else {
          project = await api.loadProject(list[0].id);
        }
        await api.setActiveProjectId(project.id);
        id = project.id;
        list = await api.listProjects();
        setProjects(list);
        setActiveId(id);
        setLoadedGraph({
          id: project.id,
          nodes: project.nodes,
          edges: project.edges,
        });
        setReady(true);
        return;
      }
      const project = await api.loadProject(id);
      setProjects(list);
      setActiveId(id);
      setLoadedGraph({
        id: project.id,
        nodes: project.nodes,
        edges: project.edges,
      });
      setReady(true);
    })();
  }, []);

  const switchTo = useCallback(
    async (id: string): Promise<Project | null> => {
      const api = getApi();
      if (!api) return null;
      const project = await api.loadProject(id);
      await api.setActiveProjectId(id);
      setActiveId(id);
      setLoadedGraph({
        id: project.id,
        nodes: project.nodes,
        edges: project.edges,
      });
      // Refresh meta list (updatedAt may differ)
      const list = await api.listProjects();
      setProjects(list);
      return project;
    },
    [],
  );

  const create = useCallback(
    async (name?: string): Promise<Project | null> => {
      const api = getApi();
      if (!api) return null;
      const project = await api.createProject(name);
      await api.setActiveProjectId(project.id);
      setActiveId(project.id);
      setLoadedGraph({
        id: project.id,
        nodes: project.nodes,
        edges: project.edges,
      });
      const list = await api.listProjects();
      setProjects(list);
      return project;
    },
    [],
  );

  const rename = useCallback(async (id: string, name: string) => {
    const api = getApi();
    if (!api) return;
    await api.renameProject(id, name);
    const list = await api.listProjects();
    setProjects(list);
  }, []);

  const remove = useCallback(
    async (id: string): Promise<Project | null> => {
      const api = getApi();
      if (!api) return null;
      await api.deleteProject(id);
      let list = await api.listProjects();
      // If the active project was deleted, pick another or create one.
      if (id === activeId) {
        let fallback: Project;
        if (list.length === 0) {
          fallback = await api.createProject("Mon projet");
          list = await api.listProjects();
        } else {
          fallback = await api.loadProject(list[0].id);
        }
        await api.setActiveProjectId(fallback.id);
        setActiveId(fallback.id);
        setLoadedGraph({
          id: fallback.id,
          nodes: fallback.nodes,
          edges: fallback.edges,
        });
        setProjects(list);
        return fallback;
      }
      setProjects(list);
      return null;
    },
    [activeId],
  );

  const duplicate = useCallback(
    async (id: string): Promise<Project | null> => {
      const api = getApi();
      if (!api) return null;
      const project = await api.duplicateProject(id);
      const list = await api.listProjects();
      setProjects(list);
      return project;
    },
    [],
  );

  const exportToFile = useCallback(async (id: string) => {
    const api = getApi();
    if (!api) return;
    await api.exportProjectToFile(id);
  }, []);

  const importFromFile = useCallback(async (): Promise<Project | null> => {
    const api = getApi();
    if (!api) return null;
    const result = await api.importProjectFromFile();
    if (result.canceled) return null;
    if ("error" in result) throw new Error(result.error);
    const project = result.project;
    await api.setActiveProjectId(project.id);
    setActiveId(project.id);
    setLoadedGraph({
      id: project.id,
      nodes: project.nodes,
      edges: project.edges,
    });
    const list = await api.listProjects();
    setProjects(list);
    return project;
  }, []);

  return {
    projects,
    activeId,
    ready,
    loadedGraph,
    refresh,
    switchTo,
    create,
    rename,
    remove,
    duplicate,
    exportToFile,
    importFromFile,
  };
}
