# n2n — node-to-node

Éditeur visuel de workflows local-first avec IA intégrée et écosystème MCP.

Une alternative légère à n8n, en Electron + Next.js + Python, où chaque module est un script Python avec un manifeste JSON, et où une IA locale (llama-server) peut construire et manipuler les graphes via tool calling.

## Démarrage rapide

```bash
npm install
npm run dev
```

Cela lance Next.js (port 3000) + Electron en parallèle. Au premier démarrage, `~/.n2n/` est créé et seedé avec une vingtaine de modules de base (text, http-request, json-decode, list-map, env-watch, cron-tick, webhook-receive, mcp-tool, …).

### Prérequis

- Node 20+
- Python 3.10+ (les modules sont en Python)
- Optionnel : un `llama-server` lancé sur `localhost:8080` pour le chat IA

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

- **Renderer** : Next.js 16 (App Router) + React + Tailwind
- **Main process** : Electron + Node http server (webhooks) + spawn child processes (Python modules, MCP servers)
- **Modules Python** : stdio JSON-RPC simple (`{inputs, params, letters, env}` → `{outputs}`)
- **MCP** : JSON-RPC 2.0 over stdio (hand-rolled, sans SDK)
- **AI tools** : OpenAI-compatible function calling envoyé à llama-server, multi-tour avec compaction

## Licence

Licence propriétaire — voir [LICENSE](./LICENSE).

Résumé non contractuel :
- **Lecture, étude personnelle, contribution via PR** : libres et gratuites.
- **Modification ou redistribution hors PR** : interdites sans accord écrit.
- **Usage commercial** : interdit par défaut. Possible sous accord prévoyant
  un reversement de **20 % du chiffre d'affaires brut** à l'auteur.
- Contact : Enzo BOITTE — `enzoboitte63000@gmail.com`
