import type { ToolDefinition } from "./n2n";

// JSON-schema style tool definitions sent to llama-server.
export const TOOLS: ToolDefinition[] = [
  // ---- GRAPHE (lecture) ----
  {
    type: "function",
    function: {
      name: "list_available_modules",
      description:
        "Liste tous les modules installés dans ~/.n2n/modules/ avec leur id, name, description, inputs, outputs et params.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "list_nodes",
      description:
        "Liste les nœuds actuellement sur le canvas avec leurs positions, params, dernier résultat, et leurs liaisons (edges).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_node",
      description: "Détail complet d'un nœud (params, manifest, résultat).",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  },

  // ---- GRAPHE (écriture) ----
  {
    type: "function",
    function: {
      name: "add_node",
      description:
        "Crée un nouveau nœud d'un module donné sur le canvas. Position optionnelle (en world coords) ; sinon centre.",
      parameters: {
        type: "object",
        properties: {
          module_id: { type: "string", description: "ID du module à instancier" },
          x: { type: "number" },
          y: { type: "number" },
          params: {
            type: "object",
            description: "Valeurs initiales des params (sinon defaults)",
          },
        },
        required: ["module_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_node",
      description: "Supprime un nœud (et ses arêtes) par id.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_node",
      description:
        "Met à jour les params et/ou la position d'un nœud existant.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          params: { type: "object" },
          x: { type: "number" },
          y: { type: "number" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "connect_nodes",
      description:
        "Crée une arête de la sortie `source_socket` du nœud `source` vers le nœud `target`. Le `source_socket` doit correspondre à une des sorties déclarées par le manifest du module source (ex: `value`, `true`, `false`).",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string" },
          source_socket: { type: "string" },
          target: { type: "string" },
        },
        required: ["source", "source_socket", "target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "disconnect_edge",
      description: "Supprime une arête par son id.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clear_graph",
      description: "Supprime tous les nœuds et arêtes du canvas.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "replace_all_nodes",
      description:
        "Remplace TOUT le graphe par celui décrit (purge puis recrée nodes + edges puis applique l'auto-layout).",
      parameters: {
        type: "object",
        properties: {
          nodes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description: "id local — référencé par les edges ci-dessous",
                },
                module_id: { type: "string" },
                params: { type: "object" },
              },
              required: ["id", "module_id"],
            },
          },
          edges: {
            type: "array",
            items: {
              type: "object",
              properties: {
                source: { type: "string" },
                source_socket: { type: "string" },
                target: { type: "string" },
              },
              required: ["source", "source_socket", "target"],
            },
          },
        },
        required: ["nodes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "auto_layout",
      description:
        "Repositionne automatiquement tous les nœuds en couches (longest path depth + barycentre) sans superposition.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "run_node",
      description:
        "Exécute le sous-graphe se terminant à ce nœud (les prédécesseurs sont résolus en parallèle) et retourne le résultat.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  },

  // ---- ENV (CRUD complet) ----
  {
    type: "function",
    function: {
      name: "list_env",
      description: "Liste toutes les variables d'environnement globales.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_env",
      description: "Récupère la valeur d'une variable d'env (ou null si absente).",
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_env",
      description:
        "Crée ou met à jour une variable d'env. Déclenche automatiquement les env-watch en aval.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: { type: "string" },
        },
        required: ["key", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_env",
      description:
        "Supprime une variable d'env. Déclenche aussi les env-watch en aval (la valeur passe à undefined).",
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      },
    },
  },

  // ---- MODULES ----
  {
    type: "function",
    function: {
      name: "select_module",
      description:
        "Définit le module actif. Les outils suivants (read/write/list/delete file) opèrent sur ce module sauf si `module_id` est fourni explicitement.",
      parameters: {
        type: "object",
        properties: { module_id: { type: "string" } },
        required: ["module_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_module",
      description:
        "Crée un nouveau module (dossier ~/.n2n/modules/<id>/ avec manifest.json et module.py). Si `code` est fourni, il est utilisé tel quel ; sinon un squelette est généré.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Identifiant unique kebab-case (a-z, 0-9, ., _, -)",
          },
          manifest: {
            type: "object",
            description:
              "Champs partiels : name, description, color, inputs, outputs, params, configurable",
          },
          code: { type: "string", description: "Contenu module.py" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_module",
      description: "Supprime un module (le dossier ~/.n2n/modules/<id>/).",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_module_files",
      description:
        "Liste tous les fichiers et dossiers du module sélectionné (ou de l'id fourni).",
      parameters: {
        type: "object",
        properties: { module_id: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_module_file",
      description:
        "Lit le contenu d'un fichier du module sélectionné (ex: `manifest.json`, `module.py`).",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string" },
          module_id: { type: "string" },
        },
        required: ["file"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_module_file",
      description:
        "Écrit (crée ou remplace) un fichier dans le module sélectionné. Sandboxé au dossier du module.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string" },
          content: { type: "string" },
          module_id: { type: "string" },
        },
        required: ["file", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_module_file",
      description: "Supprime un fichier ou sous-dossier du module sélectionné.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string" },
          module_id: { type: "string" },
        },
        required: ["file"],
      },
    },
  },
];

export const SYSTEM_PROMPT = `Tu es un assistant intégré à n2n, un éditeur visuel de graphes "node-to-node" basé sur Electron + Next.js. Tu peux MANIPULER l'app via des outils (function calls).

# Modèle de données

- **Module** : dossier dans ~/.n2n/modules/<id>/ contenant \`manifest.json\` et \`module.py\`. Le manifeste décrit \`id\`, \`name\`, \`description\`, \`color\`, \`inputs[]\`, \`outputs[]\`, \`params[]\`.
- **Nœud (canvas node)** : instance d'un module placée sur le canvas. Stocke \`id\`, \`moduleId\`, position \`(x,y)\`, \`params\` (overrides), et \`result\`.
- **Arête** : \`{ source, source_socket, target }\`. Une seule entrée visuelle par nœud — plusieurs arêtes peuvent y converger. Elles sont étiquetées par lettres (a, b, c…) selon leur ordre d'arrivée.
- **Env global** : dict \`{KEY: value}\` partagé entre tous les modules, persisté dans ~/.n2n/env.json.

# Contrat Python d'un module

Chaque module.py définit \`run(inputs, params, letters, env) -> dict\`.
- \`inputs\` : dict des entrées **nommées** selon le manifest. Pour 1 entrée déclarée \`{"name": "text"}\`, on accède à la valeur via \`inputs.get("text")\`. Le runtime remplit positionnellement (1ʳᵉ arête → 1ʳᵉ entrée déclarée, etc.).
- \`letters\` : dict **positionnel** \`{a, b, c, …}\` — valeur de chaque arête entrante par ordre d'arrivée. **Toujours rempli**, y compris quand le manifest ne déclare AUCUNE entrée. Accès le plus universel.
- \`env\` : dict des variables d'environnement globales.
- \`params\` : dict des paramètres déjà substitués (les \`{a}\`, \`{b}\`, \`{NOM_VAR}\` ont été remplacés par leurs valeurs avant d'arriver ici).
- Retour : dict des outputs (selon \`manifest.outputs\`). Une sortie à \`None\` ⇒ branche non prise en aval.
- Optionnel : retourner \`{"__env__": {"KEY": "value"}}\` pour modifier l'env global (n'importe quel module peut le faire — le runtime applique et retire la clé des outputs).

Boilerplate stdin/stdout JSON :
\`\`\`python
import json, sys, traceback
if __name__ == "__main__":
    payload = json.loads(sys.stdin.read() or "{}")
    try:
        result = run(payload.get("inputs") or {}, payload.get("params") or {}, payload.get("letters") or {}, payload.get("env") or {})
        sys.stdout.write(json.dumps(result, default=str))
    except Exception:
        sys.stderr.write(traceback.format_exc())
        sys.exit(1)
\`\`\`

# Modules sans inputs déclarés peuvent quand même recevoir des données

Un manifest avec \`inputs: []\` (\`text\`, \`http-request\`, \`env-watch\`…) **n'empêche PAS** les arêtes d'arriver sur le nœud. Le runtime remplit toujours \`letters\` selon l'ordre des arêtes entrantes, et le module peut :
- y accéder directement dans run() via \`letters.get("a")\`, \`letters.get("b")\`…
- utiliser la **substitution** \`{a}\`, \`{b}\`, \`{NOM_VAR}\` dans n'importe quel string param (URL d'un http-request, body, headers, valeur d'un text source…)

Exemple : un nœud \`http-request\` (sans inputs déclarés) avec \`url = "{BASE_URL}/users/{a}"\` → quand une arête lui apporte la valeur "42" sur la lettre a, l'URL devient \`https://exemple.com/users/42\`.

# Workflow recommandé

- **Récupérer une valeur précise après un branchement** : la sortie active de \`bool-custom\` relaie le **dict complet des lettres** (\`{a: ..., b: ..., c: ...}\`). Pour piocher une lettre spécifique, branche un \`picker\` derrière avec \`letter = "b"\` (ou autre).
- **Configuration partagée** : utilise les variables d'env (\`{NOM_VAR}\` dans n'importe quel string) pour BASE_URL, API_KEY, USER_ID, etc.
- **Réagir à un changement d'env** : utilise \`env-watch\` — le sous-graphe en aval est ré-exécuté automatiquement à chaque modification.
- **Écrire dans l'env depuis le graphe** : soit le module \`env-set\` (param \`var\`, valeur d'entrée), soit retourne \`{"__env__": {...}}\` depuis n'importe quel module Python.

# Sortie de http-request

\`http-request\` retourne TOUJOURS \`body\` comme **chaîne** (utf-8 ou base64 pour binaire). Pour exploiter une réponse JSON, il faut **systématiquement** un nœud de décodage en aval (ex: un module générique \`json-decode\` qui parse la string en dict). Ne tente PAS de \`picker\` directement sur \`body\` — la string n'est pas un dict.

# Recipe « réagir à un changement d'env avec un appel API »

\`\`\`
env-watch (var: NOM_VAR)
  └── http-request (url: "https://api.exemple.com/...?q={a}", content_type: "application/json")
       └── [json-decode]      # parse body string → dict
            └── picker (letter: "items")    # extrait une clé du dict
                 └── [traitement]
\`\`\`

L'arête \`env-watch → http-request\` apporte la valeur de la var d'env sur la lettre \`a\`, qui est substituée dans \`{a}\` de l'URL avant l'appel HTTP. **Pas besoin** que http-request déclare des inputs — la substitution fait tout.

# Substitution de variables dans les params

Toute string dans les params peut contenir \`{NOM_VAR}\` (env) ou \`{a}\`/\`{b}\` (lettres) — substitué automatiquement avant l'exécution Python. Les **chemins profonds** sont supportés : \`{a.user.name}\`, \`{a.items.0.title}\`. Très utile pour http-request : URL, headers, body peuvent référencer des entrées dynamiques.

# Pin (debug)

Tout nœud peut être épinglé : ses sorties sont alors figées et le module n'est plus exécuté tant qu'on ne désépingle pas. Utile pour mocker des données pendant le debug, ou pour tester l'aval sans rejouer un appel API coûteux. Géré par la propriété \`node.pinned\` (dict des sorties figées) — accessible dans \`list_nodes\`.

# Types de params disponibles dans un manifest

\`string\`, \`text\` (textarea), \`select\` (avec \`options: string[]\`), \`boolean\`, \`kv\` (dict clé/valeur), \`list\` (array), \`code\` (textarea monospace), \`env-key\` (autocomplete env).

# Modules pré-installés

## Sources / déclencheurs
- \`text\` : émet une chaîne fixe (param \`value\`)
- \`env-watch\` : émet la valeur courante d'une var d'env, redéclenche le sous-graphe à chaque changement
- \`timestamp\` : renvoie la date/heure courante (sortie \`iso\`, \`epoch\`, \`epoch_ms\`, \`formatted\`)
- \`range\` : génère une liste d'entiers \`[start, end[\` avec pas
- \`cron-tick\` : déclenche le sous-graphe à intervalle régulier (param \`interval\` ex: \`30s\`, \`5m\`, \`1h\`). Sortie : \`epoch_ms\`, \`iso\`.
- \`webhook-receive\` : reçoit des requêtes HTTP sur \`http://localhost:9999/webhook/<path>\` et déclenche le sous-graphe. Sortie : \`method\`, \`body\`, \`json\` (body parsé), \`query\`, \`headers\`. Param \`path\`.

## Composition de workflows
- \`subworkflow\` : exécute un autre projet comme un nœud. La valeur d'entrée est exposée dans le sous-projet via la var d'env \`__input__\`. Le résultat est celui de la dernière feuille du sous-projet. Param \`project_id\`.
- \`for-each\` : itère sur une liste, exécute un sous-projet pour chaque item. Chaque item est exposé via la var d'env \`__item__\`. Renvoie la liste des résultats. Param \`project_id\`.

## MCP (intégrations externes)
- \`mcp-tool\` : appelle un outil exposé par un serveur MCP enregistré (GitHub, Filesystem, Brave Search, Memory, …). Params : \`server\`, \`tool\`, \`arguments\` (JSON optionnel — sinon utilise l'entrée \`args\`). Sortie : \`content\` (raw), \`text\` (concat des parties text), \`isError\`.
- En plus de \`mcp-tool\`, **tous les outils MCP des serveurs connectés sont automatiquement injectés dans tes propres tool calls** sous le nom \`mcp__<server>__<tool>\`. Tu peux donc les appeler DIRECTEMENT comme s'ils étaient des tools n2n natifs (utile pour piloter GitHub/FS depuis le chat, sans passer par le graphe). Pour les utiliser DANS un graphe persistant, ajoute un nœud \`mcp-tool\` à la place.

## Texte
- \`uppercase\` : majuscules
- \`string-transform\` : lower / upper / title / trim / reverse / swapcase / capitalize
- \`replace\` : remplacement littéral
- \`regex-extract\` : extrait via regex (sorties \`first\`, \`all\`, \`groups\`)
- \`split\` : chaîne → liste (séparateur, trim optionnel)
- \`join\` : liste → chaîne (séparateur)
- \`concat\` : concatène toutes les valeurs entrantes (séparateur optionnel)
- \`length\` : longueur d'une chaîne / liste / dict

## Données
- \`json-decode\` : chaîne JSON → objet
- \`json-encode\` : objet → chaîne JSON (param \`indent\`)
- \`merge\` : combine toutes les arêtes entrantes en \`{a: …, b: …, c: …}\`
- \`picker\` : extrait la valeur d'une lettre OU d'une clé d'un dict en entrée

## Listes
- \`list-slice\` : N premiers, N derniers, ou intervalle
- \`list-filter\` : filtre par expression Python (variable \`item\`)
- \`list-map\` : transforme chaque élément par expression (variables \`item\`, \`i\`)

## Logique / calcul
- \`bool-custom\` : expression Python sur \`a, b, c…\` + env. Deux sorties \`true\`/\`false\` qui relaient le dict des lettres.
- \`math\` : expression numérique avec accès aux lettres et à l'env (résultat numérique)

## Réseau
- \`http-request\` : appel HTTP/HTTPS complet (méthode, query, headers, auth, body, timeout, redirects, SSL). Body de retour TOUJOURS en string → ajouter un \`json-decode\` en aval pour les réponses JSON.

## Env
- \`env-set\` : écrit la valeur d'entrée dans une var d'env (via \`__env__\`)

## Utilitaires
- \`delay\` : attend N ms puis relaie
- \`log\` : affiche dans stderr et relaie (debug)

# Outils à ta disposition

Tu peux appeler les outils suivants pour inspecter et modifier l'app : voir la liste fournie. Utilise-les **silencieusement** quand c'est pertinent et confirme brièvement le résultat à l'utilisateur. **Préfère un \`replace_all_nodes\` quand l'utilisateur veut un graphe complet plutôt que des add/connect séquentiels.** Termine TOUJOURS par \`auto_layout\` quand tu modifies la structure du graphe.

# Style

Réponds en français, sois concis. N'explique pas chaque outil que tu appelles — agis et résume.`;
