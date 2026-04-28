"use client";

import { useEffect, useMemo, useState } from "react";
import { getApi, type McpServerState } from "@/lib/n2n";
import { useMcpServers } from "@/hooks/useMcpServers";

type Props = {
  onClose: () => void;
};

type PresetCategory =
  | "Fichiers"
  | "Dev"
  | "Bases de données"
  | "Recherche"
  | "Communication"
  | "Productivité"
  | "Mémoire & utilitaires"
  | "Cloud & infra"
  | "Commerce"
  | "Personnalisé";

type Preset = {
  id: string;
  name: string;
  description: string;
  category: PresetCategory;
  command: string;
  args: string[];
  env: Record<string, string>;
  notes?: string;
};

const PRESETS: Preset[] = [
  // ---------- Fichiers ----------
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Lire / écrire dans un dossier local",
    category: "Fichiers",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    env: {},
    notes: "Remplace /tmp par le chemin absolu du dossier autorisé.",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Lire et chercher des fichiers Drive",
    category: "Fichiers",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-gdrive"],
    env: {},
    notes:
      "Suis la procédure OAuth du paquet (gdrive auth) pour générer le credentials.json.",
  },

  // ---------- Dev ----------
  {
    id: "github",
    name: "GitHub",
    description: "Issues, PRs, branches, fichiers",
    category: "Dev",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
    notes:
      "Génère un token sur github.com/settings/tokens (permissions : repo).",
  },
  {
    id: "git",
    name: "Git (local)",
    description: "Lire/diff un dépôt git local",
    category: "Dev",
    command: "uvx",
    args: ["mcp-server-git", "--repository", "/chemin/du/repo"],
    env: {},
    notes:
      "Nécessite uv (curl -LsSf https://astral.sh/uv/install.sh | sh). Pointe vers un repo absolu.",
  },
  {
    id: "gitlab",
    name: "GitLab",
    description: "Projets, issues, MRs GitLab",
    category: "Dev",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-gitlab"],
    env: { GITLAB_PERSONAL_ACCESS_TOKEN: "", GITLAB_API_URL: "https://gitlab.com/api/v4" },
    notes:
      "Token : gitlab.com/-/user_settings/personal_access_tokens (scopes api, read_repository).",
  },
  {
    id: "azure-devops",
    name: "Azure DevOps",
    description: "Work items, repos, pipelines (Microsoft)",
    category: "Dev",
    command: "npx",
    args: ["-y", "@azure-devops/mcp", "TON_ORG"],
    env: {},
    notes:
      "Remplace TON_ORG par le nom de ton organisation Azure DevOps. Authentification via az login.",
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Issues et stack traces depuis Sentry",
    category: "Dev",
    command: "uvx",
    args: ["mcp-server-sentry", "--auth-token", "TON_TOKEN"],
    env: {},
    notes:
      "Token : sentry.io → Settings → Account → API → Auth Tokens (scope project:read).",
  },
  {
    id: "playwright",
    name: "Playwright",
    description: "Automatiser un navigateur (Microsoft)",
    category: "Dev",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    env: {},
    notes: "Successeur recommandé de Puppeteer, plus stable sur le web moderne.",
  },
  {
    id: "puppeteer",
    name: "Puppeteer",
    description: "Pilotage Chromium headless",
    category: "Dev",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    env: {},
  },
  {
    id: "docker",
    name: "Docker",
    description: "Conteneurs, images, compose",
    category: "Dev",
    command: "uvx",
    args: ["docker-mcp"],
    env: {},
    notes: "Le démon Docker doit tourner sur la machine.",
  },
  {
    id: "kubernetes",
    name: "Kubernetes",
    description: "kubectl piloté par MCP",
    category: "Dev",
    command: "npx",
    args: ["-y", "mcp-server-kubernetes"],
    env: {},
    notes: "Utilise le contexte courant de ~/.kube/config.",
  },

  // ---------- Bases de données ----------
  {
    id: "postgres",
    name: "PostgreSQL",
    description: "Lecture seule sur une base Postgres",
    category: "Bases de données",
    command: "npx",
    args: [
      "-y",
      "@modelcontextprotocol/server-postgres",
      "postgresql://user:password@localhost:5432/db",
    ],
    env: {},
    notes:
      "Remplace l'URL par ta connection string. Le serveur n'expose qu'un accès en lecture.",
  },
  {
    id: "sqlite",
    name: "SQLite",
    description: "Requêter un fichier .sqlite local",
    category: "Bases de données",
    command: "uvx",
    args: ["mcp-server-sqlite", "--db-path", "/chemin/vers/base.sqlite"],
    env: {},
  },
  {
    id: "redis",
    name: "Redis",
    description: "Lire/écrire dans Redis",
    category: "Bases de données",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-redis", "redis://localhost:6379"],
    env: {},
  },
  {
    id: "mongodb",
    name: "MongoDB",
    description: "Requêter une instance MongoDB",
    category: "Bases de données",
    command: "npx",
    args: ["-y", "mongodb-mcp-server"],
    env: { MDB_MCP_CONNECTION_STRING: "mongodb://localhost:27017" },
  },
  {
    id: "bigquery",
    name: "BigQuery (Google Cloud)",
    description: "Requêter des datasets BigQuery",
    category: "Bases de données",
    command: "uvx",
    args: ["mcp-bigquery-server", "--project", "TON_PROJECT_ID"],
    env: {},
    notes:
      "Authentifie-toi d'abord via gcloud auth application-default login. Remplace TON_PROJECT_ID.",
  },

  // ---------- Recherche ----------
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Recherche web via Brave",
    category: "Recherche",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    env: { BRAVE_API_KEY: "" },
    notes: "Récupère une clé sur brave.com/search/api.",
  },
  {
    id: "tavily",
    name: "Tavily Search",
    description: "Search API orientée agents",
    category: "Recherche",
    command: "npx",
    args: ["-y", "tavily-mcp"],
    env: { TAVILY_API_KEY: "" },
    notes: "Crée une clé sur app.tavily.com.",
  },
  {
    id: "exa",
    name: "Exa",
    description: "Recherche neuronale et résumés",
    category: "Recherche",
    command: "npx",
    args: ["-y", "exa-mcp-server"],
    env: { EXA_API_KEY: "" },
    notes: "Clé sur dashboard.exa.ai.",
  },
  {
    id: "perplexity",
    name: "Perplexity Ask",
    description: "Q&A web via l'API Perplexity",
    category: "Recherche",
    command: "npx",
    args: ["-y", "server-perplexity-ask"],
    env: { PERPLEXITY_API_KEY: "" },
    notes: "Clé sur perplexity.ai/settings/api.",
  },
  {
    id: "fetch",
    name: "Fetch (HTTP)",
    description: "Requêtes HTTP arbitraires",
    category: "Recherche",
    command: "uvx",
    args: ["mcp-server-fetch"],
    env: {},
    notes: "Nécessite uv (curl -LsSf https://astral.sh/uv/install.sh | sh).",
  },

  // ---------- Communication ----------
  {
    id: "slack",
    name: "Slack",
    description: "Lire les canaux, poster des messages",
    category: "Communication",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    env: { SLACK_BOT_TOKEN: "xoxb-…", SLACK_TEAM_ID: "T0…" },
    notes: "Bot token + ID de team. Voir api.slack.com/apps.",
  },
  {
    id: "discord",
    name: "Discord",
    description: "Lire/écrire dans des serveurs Discord",
    category: "Communication",
    command: "npx",
    args: ["-y", "@hanweg/mcp-discord"],
    env: { DISCORD_TOKEN: "" },
    notes: "Token de bot Discord (developer portal).",
  },
  {
    id: "gmail",
    name: "Gmail",
    description: "Lire et envoyer des e-mails",
    category: "Communication",
    command: "npx",
    args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
    env: {},
    notes: "Lance la commande une première fois pour faire l'OAuth Google.",
  },

  // ---------- Productivité ----------
  {
    id: "google-workspace",
    name: "Google Workspace (suite complète)",
    description: "Gmail, Drive, Calendar, Docs, Sheets, Slides, Forms, Tasks, Contacts",
    category: "Productivité",
    command: "uvx",
    args: ["workspace-mcp", "--tool-tier", "core"],
    env: { GOOGLE_OAUTH_CLIENT_ID: "", GOOGLE_OAUTH_CLIENT_SECRET: "" },
    notes:
      "Crée un OAuth client (type Desktop) sur console.cloud.google.com → APIs & Services → Identifiants. Couvre 12 services Google.",
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    description: "Évènements, agendas, invitations (via Workspace MCP)",
    category: "Productivité",
    command: "uvx",
    args: ["workspace-mcp", "--tools", "calendar"],
    env: { GOOGLE_OAUTH_CLIENT_ID: "", GOOGLE_OAUTH_CLIENT_SECRET: "" },
    notes: "Variante de google-workspace limitée à Calendar.",
  },
  {
    id: "google-search-console",
    name: "Google Search Console",
    description: "Performance SEO, sitemaps, indexation",
    category: "Productivité",
    command: "npx",
    args: ["-y", "mcp-server-gsc"],
    env: { GOOGLE_APPLICATION_CREDENTIALS: "/chemin/vers/service-account.json" },
    notes:
      "Crée un service account (Search Console API) et donne-lui accès à la propriété, puis pointe vers son JSON.",
  },
  {
    id: "youtube",
    name: "YouTube",
    description: "Métadonnées vidéos, transcripts, recherche",
    category: "Productivité",
    command: "npx",
    args: ["-y", "@kazuph/mcp-youtube"],
    env: {},
    notes:
      "Variantes : npx -y youtube-mcp-server, ou yt-mcp pour les transcripts via youtube-transcript-api.",
  },
  {
    id: "ms-365",
    name: "Microsoft 365 (Outlook, OneDrive, Excel, OneNote, To Do…)",
    description: "Suite Microsoft 365 perso via Microsoft Graph",
    category: "Productivité",
    command: "npx",
    args: ["-y", "@softeria/ms-365-mcp-server"],
    env: {},
    notes:
      "Première exécution : suis le device-code login Microsoft. 200+ outils sur l'API Graph.",
  },
  {
    id: "ms-365-org",
    name: "Microsoft 365 — mode organisation",
    description: "Ajoute Teams, SharePoint, Online Meetings, Présence, etc.",
    category: "Productivité",
    command: "npx",
    args: ["-y", "@softeria/ms-365-mcp-server", "--org-mode"],
    env: {},
    notes:
      "Identique au preset précédent + accès aux ressources d'entreprise (Teams, SharePoint, Planner avancé).",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Pages, bases et recherche Notion",
    category: "Productivité",
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    env: { NOTION_API_KEY: "secret_…" },
    notes:
      "Crée une intégration sur notion.so/profile/integrations puis partage les pages avec.",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Issues, cycles, projets Linear",
    category: "Productivité",
    command: "npx",
    args: ["-y", "mcp-remote", "https://mcp.linear.app/sse"],
    env: {},
    notes: "OAuth automatique au premier lancement.",
  },
  {
    id: "atlassian",
    name: "Jira & Confluence",
    description: "Suite Atlassian (sooperset)",
    category: "Productivité",
    command: "uvx",
    args: ["mcp-atlassian"],
    env: {
      CONFLUENCE_URL: "https://ton-domaine.atlassian.net/wiki",
      CONFLUENCE_USERNAME: "",
      CONFLUENCE_API_TOKEN: "",
      JIRA_URL: "https://ton-domaine.atlassian.net",
      JIRA_USERNAME: "",
      JIRA_API_TOKEN: "",
    },
    notes: "Token API : id.atlassian.com/manage-profile/security/api-tokens.",
  },
  {
    id: "google-maps",
    name: "Google Maps",
    description: "Geocoding, directions, places",
    category: "Productivité",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-google-maps"],
    env: { GOOGLE_MAPS_API_KEY: "" },
    notes: "Active l'API Places sur la console Google Cloud.",
  },
  {
    id: "airtable",
    name: "Airtable",
    description: "Bases et tables Airtable",
    category: "Productivité",
    command: "npx",
    args: ["-y", "airtable-mcp-server"],
    env: { AIRTABLE_API_KEY: "pat…" },
    notes: "Token : airtable.com/create/tokens.",
  },

  // ---------- Mémoire & utilitaires ----------
  {
    id: "memory",
    name: "Memory (knowledge graph)",
    description: "Mémoire persistante en knowledge graph",
    category: "Mémoire & utilitaires",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    env: {},
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    description: "Raisonnement étape par étape",
    category: "Mémoire & utilitaires",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequentialthinking"],
    env: {},
  },
  {
    id: "time",
    name: "Time",
    description: "Heure, fuseaux horaires, conversions",
    category: "Mémoire & utilitaires",
    command: "uvx",
    args: ["mcp-server-time"],
    env: {},
  },
  {
    id: "everything",
    name: "Everything (démo)",
    description: "Serveur de référence (tools, prompts, resources)",
    category: "Mémoire & utilitaires",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything"],
    env: {},
  },

  // ---------- Cloud & infra ----------
  {
    id: "google-cloud",
    name: "Google Cloud (gcloud)",
    description: "Pilote ton GCP via la CLI gcloud",
    category: "Cloud & infra",
    command: "npx",
    args: ["-y", "@google-cloud/gcloud-mcp"],
    env: {},
    notes:
      "Authentifie-toi en local avec gcloud auth login + gcloud config set project.",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "Workers, KV, R2, DNS",
    category: "Cloud & infra",
    command: "npx",
    args: ["-y", "@cloudflare/mcp-server-cloudflare"],
    env: { CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" },
    notes: "Token : dash.cloudflare.com/profile/api-tokens.",
  },
  {
    id: "aws-kb-retrieval",
    name: "AWS Bedrock KB",
    description: "Knowledge bases Bedrock",
    category: "Cloud & infra",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-aws-kb-retrieval"],
    env: {
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
      AWS_REGION: "us-east-1",
    },
  },
  {
    id: "cli-microsoft-365",
    name: "CLI for Microsoft 365 (admin)",
    description: "Commandes admin M365 / SharePoint / Entra ID",
    category: "Cloud & infra",
    command: "npx",
    args: ["-y", "@pnp/cli-microsoft365-mcp-server"],
    env: {},
    notes:
      "Pratique pour les actions d'administration en langage naturel. Authentifie-toi avec m365 login.",
  },

  // ---------- Commerce ----------
  {
    id: "stripe",
    name: "Stripe",
    description: "Clients, paiements, produits",
    category: "Commerce",
    command: "npx",
    args: ["-y", "@stripe/mcp", "--tools=all"],
    env: { STRIPE_SECRET_KEY: "sk_test_…" },
    notes: "Utilise une clé restreinte (Restricted Key) pour limiter les actions.",
  },
  {
    id: "shopify",
    name: "Shopify Dev",
    description: "Storefront, Admin API, docs",
    category: "Commerce",
    command: "npx",
    args: ["-y", "@shopify/dev-mcp"],
    env: {},
    notes: "Pratique pour explorer la documentation et les schémas Shopify.",
  },

  // ---------- Custom ----------
  {
    id: "custom",
    name: "Personnalisé…",
    description: "Commande arbitraire",
    category: "Personnalisé",
    command: "",
    args: [],
    env: {},
  },
];

const CATEGORY_ORDER: PresetCategory[] = [
  "Fichiers",
  "Dev",
  "Bases de données",
  "Recherche",
  "Communication",
  "Productivité",
  "Mémoire & utilitaires",
  "Cloud & infra",
  "Commerce",
  "Personnalisé",
];

type Editor = {
  name: string;
  command: string;
  argsText: string; // newline-separated for the form
  env: Record<string, string>;
  notes?: string;
};

function emptyEditor(): Editor {
  return { name: "", command: "", argsText: "", env: {} };
}

function fromServer(s: McpServerState): Editor {
  return {
    name: s.name,
    command: s.command,
    argsText: s.args.join("\n"),
    env: { ...s.env },
  };
}

function fromPreset(p: Preset): Editor {
  return {
    name: p.id === "custom" ? "" : p.id,
    command: p.command,
    argsText: p.args.join("\n"),
    env: { ...p.env },
    notes: p.notes,
  };
}

export function McpModal({ onClose }: Props) {
  const { servers, refresh } = useMcpServers();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editingExisting, setEditingExisting] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const filteredPresets = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return PRESETS;
    return PRESETS.filter((p) => {
      if (p.id === "custom") return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q)
      );
    });
  }, [search]);

  const groupedPresets = useMemo(() => {
    const map = new Map<PresetCategory, Preset[]>();
    for (const p of filteredPresets) {
      if (!map.has(p.category)) map.set(p.category, []);
      map.get(p.category)!.push(p);
    }
    return CATEGORY_ORDER.flatMap((cat) => {
      const items = map.get(cat);
      return items && items.length > 0
        ? [{ category: cat, items }]
        : [];
    });
  }, [filteredPresets]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (editor) {
          setEditor(null);
          setEditingExisting(null);
          setSaveError(null);
        } else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor, onClose]);

  const startEdit = (s: McpServerState) => {
    setEditor(fromServer(s));
    setEditingExisting(s.name);
    setSaveError(null);
  };

  const startCreate = (preset?: Preset) => {
    setEditor(preset ? fromPreset(preset) : emptyEditor());
    setEditingExisting(null);
    setSaveError(null);
  };

  const save = async () => {
    if (!editor) return;
    const api = getApi();
    if (!api) return;
    if (!editor.name.trim() || !/^[a-z0-9_-]+$/i.test(editor.name)) {
      setSaveError("Nom invalide (a-z, 0-9, _, -)");
      return;
    }
    if (!editor.command.trim()) {
      setSaveError("La commande est requise");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const args = editor.argsText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      // If renaming, delete old first
      if (editingExisting && editingExisting !== editor.name) {
        await api.mcpDelete(editingExisting);
      }
      await api.mcpSave(editor.name, {
        command: editor.command,
        args,
        env: editor.env,
      });
      setEditor(null);
      setEditingExisting(null);
      await refresh();
    } catch (err) {
      setSaveError(String((err as Error).message ?? err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (name: string) => {
    if (!confirm(`Supprimer le serveur MCP "${name}" ?`)) return;
    const api = getApi();
    if (!api) return;
    await api.mcpDelete(name);
    await refresh();
  };

  const restart = async (name: string) => {
    const api = getApi();
    if (!api) return;
    await api.mcpRestart(name);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-slate-700">
          <div className="flex flex-col leading-tight">
            <span className="text-base font-semibold">Serveurs MCP</span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Branche n'importe quel service compatible Model Context Protocol
            </span>
          </div>
          <button
            onClick={onClose}
            title="Fermer"
            className="flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            ×
          </button>
        </header>

        <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto px-5 py-4">
          {!editor && (
            <>
              {servers.length === 0 ? (
                <p className="rounded border border-dashed border-slate-300 p-3 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                  Aucun serveur enregistré. Choisis un preset ci-dessous pour
                  démarrer en 30 secondes.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {servers.map((s) => (
                    <li
                      key={s.name}
                      className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/50"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${
                              s.connected
                                ? "bg-emerald-500"
                                : s.error
                                  ? "bg-rose-500"
                                  : "bg-slate-400"
                            }`}
                            title={
                              s.connected
                                ? "Connecté"
                                : s.error || "Non connecté"
                            }
                          />
                          <span className="truncate font-mono text-sm font-medium">
                            {s.name}
                          </span>
                          <span className="text-[11px] text-slate-500 dark:text-slate-400">
                            {s.tools.length} outil{s.tools.length > 1 ? "s" : ""}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => restart(s.name)}
                            className="rounded px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-700"
                          >
                            Relancer
                          </button>
                          <button
                            onClick={() => startEdit(s)}
                            className="rounded px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-700"
                          >
                            Modifier
                          </button>
                          <button
                            onClick={() => remove(s.name)}
                            className="rounded px-2 py-0.5 text-[11px] text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                          >
                            Supprimer
                          </button>
                        </div>
                      </div>
                      {s.error && (
                        <p className="mt-1 break-words text-[11px] text-rose-600 dark:text-rose-400">
                          {s.error}
                        </p>
                      )}
                      {s.connected && s.tools.length > 0 && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-[11px] text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
                            Voir les outils
                          </summary>
                          <ul className="mt-1 flex flex-wrap gap-1">
                            {s.tools.map((t) => (
                              <li
                                key={t.name}
                                title={t.description}
                                className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-700 dark:bg-slate-900 dark:text-slate-300"
                              >
                                {t.name}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-2 flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    Ajouter un serveur
                  </p>
                  <span className="text-[11px] text-slate-400 dark:text-slate-500">
                    {filteredPresets.length} / {PRESETS.length}
                  </span>
                </div>

                <div className="relative">
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Rechercher (nom, description, catégorie)…"
                    className="w-full rounded-md border border-slate-200 bg-white py-1.5 pl-8 pr-8 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
                  />
                  <svg
                    className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <circle cx="11" cy="11" r="7" />
                    <path d="m21 21-4.3-4.3" />
                  </svg>
                  {search && (
                    <button
                      onClick={() => setSearch("")}
                      title="Effacer"
                      className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      ×
                    </button>
                  )}
                </div>

                {groupedPresets.length === 0 ? (
                  <p className="rounded border border-dashed border-slate-300 p-3 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
                    Aucun preset ne correspond à « {search} ».
                  </p>
                ) : (
                  groupedPresets.map(({ category, items }) => (
                    <div key={category} className="flex flex-col gap-1.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                        {category}
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        {items.map((p) => (
                          <button
                            key={p.id}
                            onClick={() => startCreate(p)}
                            title={p.notes}
                            className="flex flex-col items-start gap-0.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-left transition hover:border-indigo-400 hover:bg-indigo-50/40 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-indigo-500 dark:hover:bg-indigo-950/20"
                          >
                            <span className="text-sm font-medium">{p.name}</span>
                            <span className="text-[11px] text-slate-500 dark:text-slate-400">
                              {p.description}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          {editor && (
            <EditorForm
              editor={editor}
              setEditor={setEditor}
              isNew={!editingExisting}
              error={saveError}
            />
          )}
        </div>

        {editor && (
          <footer className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-slate-700 dark:bg-slate-800/40">
            <button
              onClick={() => {
                setEditor(null);
                setEditingExisting(null);
                setSaveError(null);
              }}
              className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              Annuler
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
            >
              {saving ? "Démarrage…" : "Enregistrer & lancer"}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

function EditorForm({
  editor,
  setEditor,
  isNew,
  error,
}: {
  editor: Editor;
  setEditor: (e: Editor) => void;
  isNew: boolean;
  error: string | null;
}) {
  const updateEnv = (next: Record<string, string>) =>
    setEditor({ ...editor, env: next });
  const entries = Object.entries(editor.env);

  return (
    <div className="flex flex-col gap-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {isNew ? "Nouveau serveur" : "Modifier le serveur"}
      </div>

      {editor.notes && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          ℹ️ {editor.notes}
        </p>
      )}

      <Field label="Nom (identifiant unique)">
        <input
          type="text"
          value={editor.name}
          placeholder="github"
          onChange={(e) => setEditor({ ...editor, name: e.target.value })}
          className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 font-mono text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
        />
      </Field>
      <Field label="Commande">
        <input
          type="text"
          value={editor.command}
          placeholder="npx"
          onChange={(e) => setEditor({ ...editor, command: e.target.value })}
          className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 font-mono text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
        />
      </Field>
      <Field label="Arguments (un par ligne)">
        <textarea
          value={editor.argsText}
          onChange={(e) => setEditor({ ...editor, argsText: e.target.value })}
          rows={4}
          className="w-full resize-y rounded-md border border-slate-200 bg-white px-2 py-1.5 font-mono text-xs outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
        />
      </Field>
      <Field label="Variables d'environnement du serveur">
        <div className="flex flex-col gap-1.5">
          {entries.length === 0 && (
            <span className="text-[11px] text-slate-400">Aucune.</span>
          )}
          {entries.map(([k, v], i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                type="text"
                value={k}
                placeholder="NOM"
                onChange={(e) => {
                  const next: Record<string, string> = {};
                  entries.forEach(([ek, ev], ei) => {
                    if (ei === i) next[e.target.value] = ev;
                    else next[ek] = ev;
                  });
                  updateEnv(next);
                }}
                className="w-1/3 rounded border border-slate-200 bg-white px-2 py-1 font-mono text-xs outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
              />
              <input
                type="text"
                value={v}
                placeholder="valeur"
                onChange={(e) => {
                  const next: Record<string, string> = { ...editor.env };
                  next[k] = e.target.value;
                  updateEnv(next);
                }}
                className="flex-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
              />
              <button
                onClick={() => {
                  const next: Record<string, string> = { ...editor.env };
                  delete next[k];
                  updateEnv(next);
                }}
                title="Retirer"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/40"
              >
                ×
              </button>
            </div>
          ))}
          <button
            onClick={() => updateEnv({ ...editor.env, "": "" })}
            className="self-start rounded border border-dashed border-slate-300 px-2 py-1 text-xs text-slate-500 hover:border-indigo-400 hover:text-indigo-500 dark:border-slate-700 dark:text-slate-400"
          >
            + Ajouter
          </button>
        </div>
      </Field>

      {error && (
        <p className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] font-medium text-slate-600 dark:text-slate-300">
        {label}
      </label>
      {children}
    </div>
  );
}
