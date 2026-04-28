# Exemples de projets n2n

Trois projets liés démontrant le système de sous-workflows :

| Fichier | Rôle | Entrée (`__input__`) | Sortie |
| --- | --- | --- | --- |
| `0a000000-0000-0000-0000-000000000001.json` | **weather-fetch** (sub) | nom de ville | ligne météo formatée |
| `0a000000-0000-0000-0000-000000000002.json` | **text-stats** (sub) | texte libre | dict `{a: chars, b: words, c: longest}` |
| `0a000000-0000-0000-0000-000000000003.json` | **pipeline-demo** (main) | — | JSON combiné loggé |

Le projet principal :

1. Découpe une liste de villes en CSV (`text` → `split`).
2. Fait un **for-each** sur ces villes en appelant `weather-fetch` pour chacune (résultat = liste de lignes météo).
3. En parallèle, passe un échantillon de texte à `text-stats` via un **subworkflow** direct.
4. Fusionne les deux résultats + un `timestamp`, encode en JSON, et logge.

## Installation

Les UUID sont fixes pour que les références croisées (`for-each.project_id`, `subworkflow.project_id`) fonctionnent. **Ne pas passer par le bouton "Importer"** du menu projet (il régénère les IDs et casse les liens). Copier directement :

```bash
cp assets/example-projects/*.json ~/.n2n/projects/
```

Puis relancer `npm run dev` (ou ouvrir le menu projet pour voir les trois nouveaux projets). Sélectionner **pipeline-demo (main)** et cliquer sur le nœud `log` pour exécuter la chaîne.
