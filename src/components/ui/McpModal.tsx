"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getApi, getApiBase, getApiToken, type McpServerState } from "@/lib/n2n";
import { useMcpServers } from "@/hooks/useMcpServers";

function getOAuthBridge() {
  if (typeof window === "undefined") return null;
  return window.n2nElectron?.oauthBridge ?? null;
}

function isLocalApiBase(): boolean {
  try {
    const u = new URL(getApiBase());
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function buildN2nCallback(s: McpServerState): { full: string; base: string; localPath: string } {
  const base = getApiBase();
  const prefix = s.oauthCallbackPath || `/oauth/${encodeURIComponent(s.name)}/`;
  let localPath = "";
  // Try to extract the path the MCP listens on from the original auth URL's
  // redirect_uri so the user can register an exact URL.
  const authUrl = s.pendingAuth?.authUrl;
  if (authUrl) {
    try {
      const u = new URL(authUrl);
      const ru = u.searchParams.get("redirect_uri");
      if (ru) {
        const dest = new URL(ru);
        localPath = dest.pathname.replace(/^\//, "");
      }
    } catch {}
  }
  return {
    base: `${base}${prefix}`,
    localPath,
    full: `${base}${prefix}${localPath}`,
  };
}

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

type ConfigFileSpec = {
  path: string; // can use `~/` prefix
  description?: string;
  format?: "json" | "text";
};

type OAuthSpec = {
  provider: "google";
  clientSecretFile: string;
  tokensPath: string;
  scopes: string[];
  redirectUri?: string;
};

type Preset = {
  id: string;
  name: string;
  description: string;
  category: PresetCategory;
  command: string;
  args: string[];
  env: Record<string, string>;
  /**
   * Optional args appended to `command + args` when launching the one-off
   * authentication flow. Set for MCPs that ship a separate `auth` subcommand
   * (gmail-autoauth, gdrive…).
   */
  authArgs?: string[];
  /** Files the MCP reads from disk — surfaced as paste-textareas in the editor. */
  configFiles?: ConfigFileSpec[];
  /** Manual OAuth flow (n2n-driven). Generates tokens file directly. */
  oauth?: OAuthSpec;
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
    description: "Lire et chercher des fichiers Drive (OAuth manuel)",
    category: "Fichiers",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-gdrive"],
    env: {},
    configFiles: [
      {
        path: "~/.config/mcp-gdrive/gcp-oauth.keys.json",
        description:
          "Client OAuth Google (Desktop) avec la Drive API activée. Colle le JSON téléchargé depuis Google Cloud Console.",
        format: "json",
      },
    ],
    oauth: {
      provider: "google",
      clientSecretFile: "~/.config/mcp-gdrive/gcp-oauth.keys.json",
      tokensPath: "~/.config/mcp-gdrive/credentials.json",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      redirectUri: "http://localhost:3000/oauth2callback",
    },
    notes:
      "Active la Drive API, crée un OAuth client Desktop, colle le JSON, enregistre, puis « Démarrer OAuth » → consent → paste l'URL de callback. Tokens écrits directement.",
  },

  // ---------- Dev ----------
  {
    id: "github",
    name: "GitHub (OAuth)",
    description: "Serveur GitHub MCP officiel (OAuth navigateur, sans PAT)",
    category: "Dev",
    command: "npx",
    args: ["-y", "mcp-remote", "https://api.githubcopilot.com/mcp/"],
    env: {},
    notes:
      "Serveur GitHub MCP officiel (GA depuis sept. 2025). OAuth 2.1 + PKCE via mcp-remote.",
  },
  {
    id: "github-pat",
    name: "GitHub (PAT)",
    description: "Variante self-hosted avec token d'accès personnel",
    category: "Dev",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
    notes:
      "Génère un token sur github.com/settings/tokens (permissions : repo). Pratique pour les serveurs n2n headless.",
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
    description: "Lire et envoyer des e-mails (OAuth manuel, paste-callback)",
    category: "Communication",
    command: "npx",
    args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
    env: {},
    configFiles: [
      {
        path: "~/.gmail-mcp/gcp-oauth.keys.json",
        description:
          "Client OAuth Google (Application de bureau). Active Gmail API → APIs & Services → Identifiants → Créer → OAuth client ID type Desktop → télécharge le JSON et colle-le ici.",
        format: "json",
      },
    ],
    oauth: {
      provider: "google",
      clientSecretFile: "~/.gmail-mcp/gcp-oauth.keys.json",
      tokensPath: "~/.gmail-mcp/credentials.json",
      scopes: [
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.settings.basic",
      ],
      redirectUri: "http://localhost:3000/oauth2callback",
    },
    notes:
      "Workflow OAuth manuel (façon Python) : 1) Active Gmail API sur Google Cloud Console, 2) Crée un OAuth client Desktop, 3) Colle le JSON, 4) Enregistre, 5) Clique « Démarrer OAuth » — Google redirige vers localhost:3000 (la page ne charge pas, c'est normal), 6) Copie l'URL de la barre d'adresse, 7) Colle dans n2n. Pas de listener, pas de tunnel.",
  },

  // ---------- Productivité ----------
  {
    id: "google-workspace",
    name: "Google Workspace (suite complète)",
    description: "Gmail, Drive, Calendar, Docs, Sheets, Slides, Forms, Tasks, Contacts",
    category: "Productivité",
    command: "uvx",
    args: ["workspace-mcp", "--tool-tier", "core"],
    env: {
      GOOGLE_OAUTH_CLIENT_ID: "",
      GOOGLE_OAUTH_CLIENT_SECRET: "",
      MCP_ENABLE_OAUTH21: "true",
      WORKSPACE_MCP_STATELESS_MODE: "true",
    },
    notes:
      "Mode stateless 100 % env-vars. Crée un OAuth client (type Desktop) sur console.cloud.google.com → APIs & Services → Identifiants. Couvre 12 services Google. Si tu n'as pas encore de FASTMCP_SERVER_AUTH_GOOGLE_JWT_SIGNING_KEY, génères-en une avec `openssl rand -hex 32` et ajoute-la en env.",
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    description: "Évènements, agendas, invitations (via Workspace MCP)",
    category: "Productivité",
    command: "uvx",
    args: ["workspace-mcp", "--tools", "calendar"],
    env: {
      GOOGLE_OAUTH_CLIENT_ID: "",
      GOOGLE_OAUTH_CLIENT_SECRET: "",
      MCP_ENABLE_OAUTH21: "true",
      WORKSPACE_MCP_STATELESS_MODE: "true",
    },
    notes: "Variante de google-workspace limitée à Calendar (mode stateless).",
  },
  {
    id: "google-search-console",
    name: "Google Search Console",
    description: "Performance SEO, sitemaps, indexation (env-vars only)",
    category: "Productivité",
    command: "npx",
    args: ["-y", "@acamolese/google-search-console-mcp"],
    env: { GSC_CLIENT_ID: "", GSC_CLIENT_SECRET: "", GSC_REFRESH_TOKEN: "" },
    notes:
      "Génère le refresh token une fois (sur ta machine, via gsc-mcp auth) puis colle-le ici. Aucun fichier sur le serveur n2n.",
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
    description: "Suite Microsoft 365 perso via Microsoft Graph (env-vars + device-code)",
    category: "Productivité",
    command: "npx",
    args: ["-y", "@softeria/ms-365-mcp-server"],
    env: { MS365_MCP_CLIENT_ID: "" },
    notes:
      "Crée une app sur portal.azure.com → Entra ID → App registrations (type « Mobile/Desktop ») et colle son client ID. Le device-code login se fait une fois au premier lancement (URL imprimée dans le journal). Aucun fichier requis.",
  },
  {
    id: "ms-365-org",
    name: "Microsoft 365 — mode organisation",
    description: "Ajoute Teams, SharePoint, Online Meetings, Présence, etc.",
    category: "Productivité",
    command: "npx",
    args: ["-y", "@softeria/ms-365-mcp-server", "--org-mode"],
    env: { MS365_MCP_CLIENT_ID: "", MS365_MCP_TENANT_ID: "" },
    notes:
      "Identique + accès aux ressources d'entreprise (Teams, SharePoint, Planner avancé). Tenant ID requis.",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Pages, bases et recherche Notion (OAuth navigateur)",
    category: "Productivité",
    command: "npx",
    args: ["-y", "mcp-remote", "https://mcp.notion.com/mcp"],
    env: {},
    notes:
      "Serveur MCP officiel Notion. OAuth navigateur — pas besoin de créer une intégration ni de coller un secret.",
  },
  {
    id: "notion-token",
    name: "Notion (token API)",
    description: "Variante avec token d'intégration (sans navigateur)",
    category: "Productivité",
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    env: { NOTION_API_KEY: "secret_…" },
    notes:
      "Crée une intégration sur notion.so/profile/integrations puis partage les pages. Utile pour les serveurs n2n headless sans navigateur.",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Issues, cycles, projets Linear",
    category: "Productivité",
    command: "npx",
    args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
    env: {},
    notes:
      "Endpoint HTTP streamable officiel (le /sse historique sera retiré). OAuth navigateur automatique.",
  },
  {
    id: "atlassian",
    name: "Jira & Confluence",
    description: "Atlassian Rovo MCP officiel (OAuth navigateur)",
    category: "Productivité",
    command: "npx",
    args: ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/mcp"],
    env: {},
    notes:
      "Serveur Rovo MCP officiel Atlassian. OAuth navigateur — pas de tokens API à fabriquer.",
  },
  {
    id: "atlassian-token",
    name: "Jira & Confluence (tokens API)",
    description: "Variante self-hosted (sooperset/mcp-atlassian)",
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
    description: "Workers, KV, R2, DNS (OAuth navigateur)",
    category: "Cloud & infra",
    command: "npx",
    args: ["-y", "mcp-remote", "https://mcp.cloudflare.com/mcp"],
    env: {},
    notes:
      "Serveur MCP officiel Cloudflare. OAuth navigateur — pas de token API à fabriquer.",
  },
  {
    id: "cloudflare-observability",
    name: "Cloudflare — Observability",
    description: "Logs, analytics et alertes Cloudflare",
    category: "Cloud & infra",
    command: "npx",
    args: ["-y", "mcp-remote", "https://observability.mcp.cloudflare.com/mcp"],
    env: {},
    notes: "Variante spécialisée pour la stack observability de Cloudflare.",
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
    description: "Clients, paiements, produits (OAuth navigateur)",
    category: "Commerce",
    command: "npx",
    args: ["-y", "mcp-remote", "https://mcp.stripe.com/"],
    env: {},
    notes:
      "Serveur MCP officiel Stripe. OAuth navigateur — pas de STRIPE_SECRET_KEY à coller.",
  },
  {
    id: "stripe-key",
    name: "Stripe (clé API)",
    description: "Variante self-hosted avec clé restreinte",
    category: "Commerce",
    command: "npx",
    args: ["-y", "@stripe/mcp", "--tools=all"],
    env: { STRIPE_SECRET_KEY: "sk_test_…" },
    notes:
      "Utilise une clé restreinte (Restricted Key) pour limiter les actions. Pratique pour les serveurs n2n headless.",
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
  authArgsText: string;
  env: Record<string, string>;
  configFiles: ConfigFileSpec[];
  configFileContents: Record<string, string>; // path -> pasted content
  oauth?: OAuthSpec;
  notes?: string;
};

function emptyEditor(): Editor {
  return {
    name: "",
    command: "",
    argsText: "",
    authArgsText: "",
    env: {},
    configFiles: [],
    configFileContents: {},
  };
}

function fromServer(s: McpServerState): Editor {
  return {
    name: s.name,
    command: s.command,
    argsText: s.args.join("\n"),
    authArgsText: (s.authArgs || []).join("\n"),
    env: { ...s.env },
    configFiles: (s.configFiles || []).map((f) => ({ ...f })),
    configFileContents: {},
    oauth: s.oauth ? { ...s.oauth, scopes: [...s.oauth.scopes] } : undefined,
  };
}

function fromPreset(p: Preset): Editor {
  return {
    name: p.id === "custom" ? "" : p.id,
    command: p.command,
    argsText: p.args.join("\n"),
    authArgsText: (p.authArgs || []).join("\n"),
    env: { ...p.env },
    configFiles: (p.configFiles || []).map((f) => ({ ...f })),
    configFileContents: {},
    oauth: p.oauth ? { ...p.oauth, scopes: [...p.oauth.scopes] } : undefined,
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
      const authArgs = editor.authArgsText
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
        authArgs: authArgs.length > 0 ? authArgs : undefined,
        configFiles: editor.configFiles.length > 0 ? editor.configFiles : undefined,
        oauth: editor.oauth,
      });
      // Write any pasted config-file contents to disk on the server.
      for (const file of editor.configFiles) {
        const content = editor.configFileContents[file.path];
        if (content && content.trim()) {
          try {
            await api.mcpWriteConfigFile(editor.name, file.path, content);
          } catch (err) {
            setSaveError(
              `Échec écriture ${file.path} : ${
                String((err as Error).message ?? err)
              }`,
            );
            setSaving(false);
            return;
          }
        }
      }
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

  const auth = async (name: string) => {
    const api = getApi();
    if (!api) return;
    try {
      await api.mcpAuth(name);
    } catch (err) {
      setSaveError(String((err as Error).message ?? err));
    }
  };

  /**
   * Ask the server to send a `tools/call` to mcp-remote (fire-and-forget)
   * so it starts the OAuth flow. The server endpoint returns immediately;
   * the auth URL appears on stderr and surfaces via the AuthBanner.
   */
  const triggerOAuth = async (s: McpServerState) => {
    const api = getApi();
    if (!api) return;
    try {
      await api.mcpProbeOAuth(s.name);
    } catch (err) {
      setSaveError(String((err as Error).message ?? err));
    }
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
                          {s.authArgs && s.authArgs.length > 0 && (
                            <button
                              onClick={() => auth(s.name)}
                              disabled={s.authRunning}
                              title="Lance la sous-commande d'authentification (browser OAuth)"
                              className="rounded bg-indigo-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
                            >
                              {s.authRunning ? "Auth en cours…" : "Authentifier"}
                            </button>
                          )}
                          {s.connected &&
                            s.tools.length > 0 &&
                            !s.pendingAuth?.authUrl &&
                            !s.oauth && (
                              <button
                                onClick={() => triggerOAuth(s)}
                                title="Invoque un outil pour déclencher mcp-remote OAuth"
                                className="rounded bg-indigo-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-indigo-500"
                              >
                                Lancer OAuth
                              </button>
                            )}
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
                      {s.oauth && <GoogleOAuthBanner server={s} />}
                      {s.pendingAuth?.authUrl && (
                        <AuthBanner server={s} />
                      )}
                      {s.logs && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-[11px] text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
                            Journal du serveur
                          </summary>
                          <pre className="mt-1 max-h-40 overflow-auto rounded bg-slate-900 px-2 py-1.5 font-mono text-[10px] leading-snug text-slate-200">
                            {s.logs}
                          </pre>
                        </details>
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
      <Field label="Args d'authentification (optionnel — appendés pour la commande « auth »)">
        <textarea
          value={editor.authArgsText}
          onChange={(e) => setEditor({ ...editor, authArgsText: e.target.value })}
          rows={2}
          placeholder="ex. auth"
          className="w-full resize-y rounded-md border border-slate-200 bg-white px-2 py-1.5 font-mono text-xs outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
        />
      </Field>
      {editor.configFiles.length > 0 && (
        <Field label="Fichiers de config attendus par le MCP">
          <div className="flex flex-col gap-2">
            {editor.configFiles.map((file) => (
              <div
                key={file.path}
                className="rounded-md border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-800/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <code className="break-all font-mono text-[10px] text-slate-700 dark:text-slate-300">
                    {file.path}
                  </code>
                  {file.format && (
                    <span className="shrink-0 rounded bg-slate-200 px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                      {file.format}
                    </span>
                  )}
                </div>
                {file.description && (
                  <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
                    {file.description}
                  </p>
                )}
                <textarea
                  value={editor.configFileContents[file.path] || ""}
                  onChange={(e) =>
                    setEditor({
                      ...editor,
                      configFileContents: {
                        ...editor.configFileContents,
                        [file.path]: e.target.value,
                      },
                    })
                  }
                  rows={5}
                  placeholder={
                    file.format === "json"
                      ? "Colle le contenu JSON ici…"
                      : "Colle le contenu ici…"
                  }
                  className="mt-1 w-full resize-y rounded border border-slate-200 bg-white px-2 py-1.5 font-mono text-[10px] outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
                />
                <p className="mt-0.5 text-[10px] text-slate-400">
                  Le fichier est écrit sur le serveur n2n quand tu enregistres.
                  Laisse vide si tu l&apos;as déjà placé manuellement.
                </p>
              </div>
            ))}
          </div>
        </Field>
      )}

      <Field label="Variables d'environnement du serveur">
        <div className="flex flex-col gap-1.5">
          <OAuthJsonImporter env={editor.env} onApply={updateEnv} />
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

/**
 * Compact widget letting users paste a Google `gcp-oauth.keys.json` file
 * (the JSON downloaded from Google Cloud Console) and have client_id /
 * client_secret extracted into the matching env vars — no need to fiddle
 * with files on the n2n server.
 */
function OAuthJsonImporter({
  env,
  onApply,
}: {
  env: Record<string, string>;
  onApply: (next: Record<string, string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);

  const apply = () => {
    setFeedback(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      setFeedback("JSON invalide.");
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      setFeedback("Structure inattendue.");
      return;
    }
    const obj = parsed as Record<string, unknown>;
    const inner = (obj.installed || obj.web || obj) as Record<string, unknown>;
    const clientId = typeof inner.client_id === "string" ? inner.client_id : null;
    const clientSecret =
      typeof inner.client_secret === "string" ? inner.client_secret : null;
    if (!clientId || !clientSecret) {
      setFeedback(
        "client_id / client_secret introuvables. Attendu : champ « installed » ou « web » contenant ces clés.",
      );
      return;
    }
    // Pick env keys: prefer the ones already present; otherwise default to
    // the GOOGLE_OAUTH_* names used by the Gmail / Drive presets.
    const findKey = (re: RegExp, fallback: string) => {
      const match = Object.keys(env).find((k) => re.test(k));
      return match ?? fallback;
    };
    const idKey = findKey(/CLIENT[_-]?ID/i, "GOOGLE_OAUTH_CLIENT_ID");
    const secretKey = findKey(/CLIENT[_-]?SECRET/i, "GOOGLE_OAUTH_CLIENT_SECRET");
    const next = { ...env, [idKey]: clientId, [secretKey]: clientSecret };
    onApply(next);
    setRaw("");
    setOpen(false);
    setFeedback(null);
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="self-start rounded border border-dashed border-indigo-300 px-2 py-1 text-[11px] text-indigo-600 hover:border-indigo-500 hover:bg-indigo-50 dark:border-indigo-800 dark:text-indigo-400 dark:hover:bg-indigo-950/30"
      >
        Importer JSON OAuth (Google / autre)
      </button>
    );
  }

  return (
    <div className="rounded-md border border-indigo-200 bg-indigo-50/50 p-2 dark:border-indigo-900 dark:bg-indigo-950/20">
      <p className="mb-1 text-[10px] text-slate-600 dark:text-slate-300">
        Colle le contenu de ton{" "}
        <code className="font-mono">gcp-oauth.keys.json</code> (téléchargé
        depuis Google Cloud Console). On extrait <code>client_id</code> et{" "}
        <code>client_secret</code> et on remplit les variables{" "}
        <code className="font-mono">CLIENT_ID</code> /{" "}
        <code className="font-mono">CLIENT_SECRET</code> existantes.
      </p>
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        rows={5}
        placeholder='{"installed":{"client_id":"…","client_secret":"…",…}}'
        className="w-full resize-y rounded border border-slate-200 bg-white px-2 py-1.5 font-mono text-[10px] outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
      />
      {feedback && (
        <p className="mt-1 text-[10px] text-rose-600 dark:text-rose-400">
          {feedback}
        </p>
      )}
      <div className="mt-1 flex items-center gap-1.5">
        <button
          onClick={apply}
          className="rounded bg-indigo-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-indigo-500"
        >
          Importer
        </button>
        <button
          onClick={() => {
            setOpen(false);
            setRaw("");
            setFeedback(null);
          }}
          className="rounded px-2 py-0.5 text-[10px] text-slate-500 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-700"
        >
          Annuler
        </button>
      </div>
    </div>
  );
}

function AuthBanner({ server }: { server: McpServerState }) {
  const cb = useMemo(() => buildN2nCallback(server), [server]);
  const [copied, setCopied] = useState(false);
  const [bridgePort, setBridgePort] = useState<number | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const startedRef = useRef(false);

  const bridge = getOAuthBridge();
  const local = isLocalApiBase();
  const port = server.pendingAuth?.localPort;

  // Auto-start the bridge when running in Electron AND the n2n server is
  // remote: this lets `localhost:<port>/oauth/callback` on the user's
  // machine reach the MCP process running on the remote n2n server.
  useEffect(() => {
    if (!bridge || local || !port) return;
    if (startedRef.current) return;
    startedRef.current = true;
    setBridgeError(null);
    bridge
      .start({
        port,
        serverName: server.name,
        apiBase: getApiBase(),
        token: getApiToken(),
      })
      .then(() => setBridgePort(port))
      .catch((err: unknown) => {
        startedRef.current = false;
        setBridgeError(String((err as Error)?.message ?? err));
      });
    return () => {
      if (startedRef.current && bridgePort) {
        bridge.stop(bridgePort).catch(() => undefined);
        startedRef.current = false;
        setBridgePort(null);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, local, port, server.name]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const open = async (url: string) => {
    if (typeof window === "undefined") return;
    // Prefer the system default browser when running in Electron — keeps
    // the user out of an embedded chromium and uses their existing Google
    // session.
    const ext = window.n2nElectron?.openExternal;
    if (ext) {
      try { await ext(url); return; } catch {}
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const dismiss = async () => {
    const api = getApi();
    if (!api) return;
    try { await api.mcpDismissAuth(server.name); } catch {}
    if (bridge && bridgePort) {
      try { await bridge.stop(bridgePort); } catch {}
    }
  };

  const authUrl = server.pendingAuth?.authUrl || "";

  return (
    <div className="mt-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 dark:border-indigo-900 dark:bg-indigo-950/30">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-base leading-none">🔐</span>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] font-semibold text-indigo-900 dark:text-indigo-200">
              Authentification OAuth requise
            </div>
            <button
              onClick={dismiss}
              title="Auth déjà terminée — masquer"
              className="rounded text-[10px] text-indigo-500 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-200"
            >
              J&apos;ai terminé ✓
            </button>
          </div>
          {bridge && !local && port && (
            <div className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10px] dark:border-emerald-900 dark:bg-emerald-950/30">
              {bridgePort ? (
                <span className="text-emerald-700 dark:text-emerald-300">
                  🔗 Tunnel local actif sur{" "}
                  <code className="font-mono">127.0.0.1:{bridgePort}</code> →{" "}
                  serveur n2n distant. Pas besoin de SSH.
                </span>
              ) : bridgeError ? (
                <span className="text-rose-700 dark:text-rose-300">
                  Tunnel impossible : {bridgeError}
                </span>
              ) : (
                <span className="text-emerald-700 dark:text-emerald-300">
                  🔗 Démarrage du tunnel local…
                </span>
              )}
            </div>
          )}
          {authUrl ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => open(authUrl)}
                className="rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-indigo-500"
              >
                Ouvrir le lien d&apos;authentification
              </button>
              <button
                onClick={() => copy(authUrl)}
                className="rounded-md border border-indigo-300 bg-white px-2 py-1 text-[11px] text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:bg-indigo-950 dark:text-indigo-200"
              >
                Copier l&apos;URL
              </button>
            </div>
          ) : port ? (
            <p className="text-[11px] text-indigo-900 dark:text-indigo-200">
              Le serveur écoute sur <code className="font-mono">localhost:{port}</code>{" "}
              mais n&apos;a pas (encore) imprimé d&apos;URL d&apos;auth. Patiente
              quelques secondes ou consulte le journal ci-dessous.
            </p>
          ) : null}

          <div className="rounded border border-indigo-200 bg-white p-2 dark:border-indigo-900 dark:bg-slate-900">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-700 dark:text-indigo-300">
              URL de callback à enregistrer
            </p>
            <p className="mt-0.5 text-[11px] text-slate-700 dark:text-slate-300">
              Si ce serveur n2n est <strong>distant</strong> (VPS, autre machine),
              ajoute cette URL aux <em>redirect URIs autorisés</em> de ton client
              OAuth (Google Cloud Console, GitHub OAuth Apps, etc.) avant
              d&apos;ouvrir le lien :
            </p>
            <div className="mt-1 flex items-center gap-1.5">
              <code className="flex-1 truncate rounded bg-slate-100 px-2 py-1 font-mono text-[10px] text-slate-800 dark:bg-slate-800 dark:text-slate-200">
                {cb.full}
              </code>
              <button
                onClick={() => copy(cb.full)}
                title="Copier"
                className="shrink-0 rounded border border-slate-300 bg-white px-2 py-1 text-[10px] text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                {copied ? "✓" : "Copier"}
              </button>
            </div>
            {!cb.localPath && (
              <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
                Le chemin exact dépend du MCP — complète après{" "}
                <code className="font-mono">/oauth/{server.name}/</code> avec le
                path qu&apos;utilise ton client OAuth (souvent{" "}
                <code className="font-mono">oauth2callback</code> ou{" "}
                <code className="font-mono">callback</code>).
              </p>
            )}
            <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
              Si n2n tourne sur la <strong>même machine</strong> que ton
              navigateur, le lien ci-dessus marche tel quel — la callback{" "}
              <code className="font-mono">localhost</code> du MCP est joignable
              directement.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Manual OAuth flow modeled on the Python implementation in tool_ai_bck:
 * 1) Click « Démarrer OAuth » → server returns auth URL → opens in browser.
 * 2) User authorizes on Google. Browser is redirected to localhost:3000
 *    which fails to load — but the URL bar contains `?code=…&state=…`.
 * 3) User copies the failed-page URL and pastes it back here.
 * 4) Server exchanges code for tokens, writes credentials.json the MCP
 *    expects, and restarts the server. No listener / tunnel needed.
 */
function GoogleOAuthBanner({ server }: { server: McpServerState }) {
  const [step, setStep] = useState<"idle" | "awaiting" | "completing" | "done">(
    "idle",
  );
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [redirectUri, setRedirectUri] = useState<string | null>(null);
  // Editable: must match what's registered in Google Cloud Console for
  // Web-type OAuth clients. Defaults to the preset value.
  const [redirectUriInput, setRedirectUriInput] = useState(
    server.oauth?.redirectUri || "http://localhost:3000/oauth2callback",
  );
  const [callbackInput, setCallbackInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); } catch {}
  };

  const openInBrowser = async (url: string) => {
    if (typeof window === "undefined") return;
    const ext = window.n2nElectron?.openExternal;
    if (ext) {
      try { await ext(url); return; } catch {}
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const start = async () => {
    setError(null);
    const api = getApi();
    if (!api) return;
    try {
      const out = await api.mcpOAuthStart(server.name, {
        redirectUri: redirectUriInput.trim() || undefined,
      });
      setSessionId(out.sessionId);
      setAuthUrl(out.authUrl);
      setRedirectUri(out.redirectUri);
      setStep("awaiting");
      void openInBrowser(out.authUrl);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    }
  };

  const complete = async () => {
    if (!sessionId) return;
    const api = getApi();
    if (!api) return;
    setError(null);
    setStep("completing");
    try {
      const trimmed = callbackInput.trim();
      const args = trimmed.startsWith("http")
        ? { sessionId, callbackUrl: trimmed }
        : { sessionId, code: trimmed };
      await api.mcpOAuthComplete(server.name, args);
      setStep("done");
      setCallbackInput("");
      setSessionId(null);
      setAuthUrl(null);
    } catch (err) {
      setError(String((err as Error).message ?? err));
      setStep("awaiting");
    }
  };

  return (
    <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-900 dark:bg-emerald-950/30">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-base leading-none">🔑</span>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="text-[11px] font-semibold text-emerald-900 dark:text-emerald-200">
            OAuth Google (manuel — paste-callback)
          </div>
          {step === "idle" && (
            <div className="flex flex-col gap-2">
              <div className="rounded border border-emerald-200 bg-white p-2 dark:border-emerald-900 dark:bg-slate-900">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                  redirect_uri
                </label>
                <p className="mt-0.5 text-[10px] text-slate-600 dark:text-slate-400">
                  Cette URL doit être <strong>exactement</strong> dans les
                  « URI de redirection autorisés » de ton client OAuth (Google
                  Cloud Console). Avec un client de type{" "}
                  <strong>Application de bureau</strong>, n&apos;importe quel{" "}
                  <code className="font-mono">http://localhost:*</code> marche.
                </p>
                <div className="mt-1 flex items-center gap-1.5">
                  <input
                    type="text"
                    value={redirectUriInput}
                    onChange={(e) => setRedirectUriInput(e.target.value)}
                    className="flex-1 rounded border border-slate-200 bg-white px-2 py-1 font-mono text-[10px] outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900"
                  />
                  <button
                    onClick={() => copy(redirectUriInput)}
                    title="Copier (à coller dans Google Cloud Console)"
                    className="shrink-0 rounded border border-slate-300 bg-white px-2 py-1 text-[10px] text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    Copier
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={start}
                  className="rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-500"
                >
                  Démarrer OAuth
                </button>
                <span className="text-[10px] text-emerald-800 dark:text-emerald-300">
                  Ouvre Google dans ton navigateur, tu copieras l&apos;URL de
                  retour.
                </span>
              </div>
            </div>
          )}
          {(step === "awaiting" || step === "completing") && (
            <>
              <p className="text-[11px] text-slate-700 dark:text-slate-300">
                Une fois l&apos;auth Google terminée, ton navigateur sera
                redirigé vers{" "}
                <code className="font-mono text-[10px]">{redirectUri}</code> —
                la page <strong>ne chargera pas</strong> (c&apos;est normal,
                rien n&apos;écoute là). <strong>Copie l&apos;URL complète</strong>{" "}
                depuis la barre d&apos;adresse et colle-la ci-dessous :
              </p>
              <textarea
                value={callbackInput}
                onChange={(e) => setCallbackInput(e.target.value)}
                rows={3}
                placeholder={`${redirectUri}?state=…&code=…`}
                className="w-full resize-y rounded border border-slate-200 bg-white px-2 py-1.5 font-mono text-[10px] outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={complete}
                  disabled={step === "completing" || !callbackInput.trim()}
                  className="rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-60"
                >
                  {step === "completing" ? "Échange en cours…" : "Valider l'auth"}
                </button>
                {authUrl && (
                  <button
                    onClick={() => void openInBrowser(authUrl)}
                    className="rounded-md border border-emerald-300 bg-white px-2 py-1 text-[11px] text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                  >
                    Réouvrir le lien Google
                  </button>
                )}
                <button
                  onClick={() => {
                    setStep("idle");
                    setSessionId(null);
                    setAuthUrl(null);
                    setCallbackInput("");
                    setError(null);
                  }}
                  className="rounded px-2 py-1 text-[10px] text-slate-500 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-700"
                >
                  Annuler
                </button>
              </div>
            </>
          )}
          {step === "done" && (
            <p className="text-[11px] text-emerald-800 dark:text-emerald-300">
              ✓ Tokens écrits, MCP redémarré. Tu peux utiliser ses outils.
            </p>
          )}
          {error && (
            <p className="rounded bg-rose-50 px-2 py-1 text-[11px] text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
