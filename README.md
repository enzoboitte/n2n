# n2n — node-to-node

Éditeur visuel de workflows local-first avec IA intégrée et écosystème MCP.

Une alternative légère à n8n, **architecture client/serveur** : un serveur Bun (TypeScript, compilable en binaire autonome) gère les modules Python, MCP, webhooks, cron et l'IA ; une UI web Next.js s'y connecte en HTTP/SSE.

## Démarrage rapide

```bash
npm install
npm run dev
```

Lance le **serveur Bun** (port 9999, API + webhooks + spawn Python + MCP + proxy llama) en parallèle de **Next.js** (port 3000, UI web). Au premier démarrage, `~/.n2n/` est créé et seedé avec une vingtaine de modules de base (text, http-request, json-decode, list-map, env-watch, cron-tick, webhook-receive, mcp-tool, …).

L'UI parle HTTP/SSE au serveur (CORS ouvert par défaut), donc tu peux aussi héberger l'UI ailleurs et garder le serveur local.

Variantes :

```bash
npm run dev:server     # serveur Bun seul, watch mode
npm run dev:next       # Next.js seul
npm run dev:electron   # mode legacy : Electron + Next.js sans serveur Bun
```

Binaire serveur autonome (runtime Bun embarqué, ~50 Mo, démarrage instantané) :

```bash
npm run build:server   # → ./n2n-server
./n2n-server           # plus besoin de Node, npm ou Bun installés
```

Variables d'env serveur :

- `N2N_HOST` (défaut `0.0.0.0`) — interface de bind. `0.0.0.0` rend le serveur joignable depuis le réseau (utile pour les webhooks et l'UI déportée).
- `N2N_PORT` (défaut `9999`) — port API + SSE (et webhooks par défaut).
- `N2N_WEBHOOK_PORT` (optionnel) — si défini, les webhooks tournent sur un **port dédié** (toujours bindé sur `N2N_HOST`). Pratique pour publier `/webhook/*` derrière un reverse proxy distinct de l'API.
- `N2N_CORS_ORIGIN` (défaut `*`) — restreint à l'origine de ton UI en prod (ex. `https://n2n.exemple.com`).
- `N2N_PYTHON` (défaut `python3`).
- `N2N_LLAMA_URL` (défaut `http://localhost:8080/v1/chat/completions`).

### Prérequis

- **Bun** ≥ 1.3 (serveur)
- **Node 20+** (UI Next.js / build front uniquement)
- **Python 3.10+** (modules)
- Optionnel : `llama-server` sur `localhost:8080` pour le chat IA

## Concepts

- **Module** : un dossier dans `~/.n2n/modules/<id>/` avec `manifest.json` + `module.py`. Le manifeste déclare inputs, outputs, params (typés). Le Python lit `{inputs, params, letters, env}` sur stdin et écrit le résultat sur stdout.
- **Nœud** : instance d'un module placée sur le canvas, avec ses propres params.
- **Lettres** : chaque arête entrante d'un nœud reçoit une lettre (a, b, c…) — utilisable dans les paramètres via `{a}`, `{a.path.b}`, etc.
- **Substitution** : `{NOM_VAR}` (env), `{a}` (lettre), `{a.path.0.foo}` (chemin profond) fonctionnent dans tous les params string.
- **Projets** : multi-projets avec import/export JSON (`~/.n2n/projects/`).

## Modules pré-installés

- **Sources** : `text`, `env-watch`, `cron-tick`, `webhook-receive`, `timestamp`, `range`
- **Texte** : `uppercase`, `string-transform`, `replace`, `regex-extract`, `concat`, `split`, `join`, `length`
- **Données** : `json-decode`, `json-encode`, `merge`, `picker`
- **Listes** : `list-slice`, `list-filter`, `list-map`
- **Logique** : `bool-custom` (Python expression), `math`
- **Réseau** : `http-request` (full HTTP/HTTPS — auth, headers, body, timeout, redirects, SSL)
- **Env** : `env-set`
- **Composition** : `subworkflow`, `for-each`
- **Intégrations** : `mcp-tool` (parle à n'importe quel serveur MCP)
- **Utilitaires** : `delay`, `log`

## IA intégrée (llama-server)

Le panneau de droite ouvre un chat connecté à `localhost:8080/v1/chat/completions` (compat OpenAI / llama.cpp). L'IA peut :

- inspecter et modifier le graphe (`add_node`, `connect_nodes`, `auto_layout`, `replace_all_nodes`…)
- créer/modifier/supprimer des modules (`create_module`, `write_module_file`…)
- lire/écrire les variables d'env (`set_env`, `get_env`, `delete_env`)
- appeler n'importe quel outil MCP enregistré (`mcp__<serveur>__<outil>` injectés automatiquement)

Elle gère le `<think>` mode (toggleable) et compacte automatiquement la conversation quand elle dépasse ~16 K caractères.

## MCP (Model Context Protocol)

Bouton **MCP** dans la palette → ajouter un serveur depuis un preset (Filesystem, GitHub, Brave Search, Memory, Fetch) ou en custom. Les outils du serveur sont automatiquement disponibles dans le chat IA et via le module `mcp-tool` dans le graphe.

## Stockage

Tout reste en local dans `~/.n2n/` :

```
~/.n2n/
├── modules/        # un dossier par module (manifest.json + module.py)
├── projects/       # un fichier JSON par projet (graphe + métadonnées)
├── env.json        # variables d'environnement globales
├── mcp-servers.json # serveurs MCP enregistrés
├── state.json      # projet actif
└── history.jsonl   # historique d'exécution
```

## Architecture

- **Serveur** : Bun + TypeScript (`server/index.ts`) — REST + SSE sur un seul port. Spawn les modules Python (stdio JSON), héberge le client MCP (JSON-RPC stdio), proxifie le streaming SSE vers llama-server, sert les webhooks utilisateurs sur `/webhook/<path>`, diffuse les événements (modulesChanged / cronTick / webhookFired / mcpChanged) en SSE sur `/api/events`. Compilable en binaire avec `bun build --compile`.
- **UI** : Next.js 16 (App Router) + React + Tailwind. `src/lib/n2n.ts` parle HTTP au serveur ; conserve un fallback vers `window.n2n` si on tourne dans Electron.
- **Modules Python** : stdio JSON-RPC simple (`{inputs, params, letters, env}` → `{outputs}`)
- **MCP** : JSON-RPC 2.0 over stdio (hand-rolled, sans SDK)
- **AI tools** : OpenAI-compatible function calling vers llama-server, multi-tour avec compaction
- **Mode Electron legacy** : `electron/main.cjs` reste fonctionnel et expose la même API via IPC ; le client privilégie le bridge IPC s'il est présent.

## Déploiement web séparé (UI sur Apache/Nginx, serveur ailleurs)

L'UI est un **SPA static** : `npm run build` produit `out/` (1 Mo de HTML/JS/CSS) que tu déposes sur n'importe quel hébergeur (Apache, Nginx, S3, GitHub Pages, …). Le serveur n2n peut tourner sur une autre machine.

### 1. Compiler les deux côtés

```bash
npm run build          # → out/      (UI static, à mettre derrière Apache)
npm run build:server   # → ./n2n-server  (binaire ~95 Mo, runtime Bun embarqué)
```

### 2. UI : exemple Apache

```apache
<VirtualHost *:80>
    ServerName n2n.exemple.com
    DocumentRoot /var/www/n2n
    <Directory /var/www/n2n>
        Require all granted
        # Fallback vers index.html pour les routes du SPA
        FallbackResource /index.html
    </Directory>
</VirtualHost>
```

`cp -r out/* /var/www/n2n/` et c'est en ligne.

### 3. Serveur : sur la même machine ou ailleurs

```bash
# sur le serveur (machine A)
N2N_HOST=0.0.0.0 \
N2N_PORT=9999 \
N2N_CORS_ORIGIN=https://n2n.exemple.com \
./n2n-server
```

Aucune dépendance — ni Node, ni Bun, ni npm. Le binaire embarque tout sauf Python (pour les modules) et `llama-server` (optionnel).

### 4. Connexion : la modale de config

Au premier chargement de l'UI, une **modale Paramètres** s'ouvre automatiquement et demande l'URL du serveur n2n (ex. `http://192.168.1.42:9999` ou `https://api.n2n.exemple.com`). Elle teste la connexion en direct via `/api/info` et persiste l'URL dans le `localStorage` du navigateur. Tu peux la rouvrir n'importe quand via l'icône ⚙ en haut à droite pour basculer entre plusieurs serveurs.

L'UI essaie dans l'ordre : `localStorage["n2n:apiUrl"]` → `NEXT_PUBLIC_N2N_API` (build time) → `window.__N2N_API__` (injectable par le serveur web) → `http://localhost:9999`.

### Notes prod

- **HTTPS / mixed content** : si l'UI est servie en HTTPS, le serveur n2n doit l'être aussi. Pour le rendre HTTPS sans toucher au binaire, mets-le derrière un reverse proxy (nginx/caddy) qui termine le TLS et renvoie sur `localhost:9999`.
- **CORS** : par défaut `*`. En prod, fixe `N2N_CORS_ORIGIN` à l'origine exacte de l'UI.
- **Webhooks publics, API privée** : démarrer avec `N2N_PORT=9999 N2N_WEBHOOK_PORT=9998` et n'ouvrir que `9998` au public, l'API restant accessible uniquement depuis le réseau interne.

## Licence

Licence propriétaire — voir [LICENSE](./LICENSE).

Résumé non contractuel :
- **Lecture, étude personnelle, contribution via PR** : libres et gratuites.
- **Modification ou redistribution hors PR** : interdites sans accord écrit.
- **Usage commercial** : interdit par défaut. Possible sous accord prévoyant
  un reversement de **20 % du chiffre d'affaires brut** à l'auteur.
- Contact : Enzo BOITTE — `enzoboitte63000@gmail.com`
