# 07 - Plan complet `findDuplicates` (local-first, low-cost)

## 1) Objectif

Construire un outil `findDuplicates` dans `code-intel-mcp` pour détecter des duplications de code utiles au refactoring, avec un coût CPU/mémoire faible et sans infrastructure externe.

Objectifs produit :
- Détecter les clones Type-1 (copie exacte) et Type-2 (renommage variables/littéraux).
- Couvrir partiellement les clones Type-3 (variations mineures) via score de similarité.
- Prioriser les résultats actionnables (impact global, dette potentielle).

Contraintes :
- Mode local/self-hosted.
- Compatible gros repo TypeScript/JavaScript sans indexation lourde obligatoire.
- Résultats stables et déterministes (mêmes entrées = mêmes groupes).

## 2) Périmètre fonctionnel

Inclus :
- Fichiers `.ts`, `.tsx`, `.js`, `.jsx`, optionnellement `.mjs`, `.cjs`.
- Détection inter-fichiers et intra-fichier.
- Exclusions par glob (`node_modules`, `dist`, `.next`, `coverage`, fichiers générés).
- Seuils configurables (`minLines`, `minTokens`, `maxGroups`, `minSimilarity`).

Exclus (phase initiale) :
- Détection cross-langage.
- Clone detection sémantique avancée basée embeddings/ML.
- Suggestions automatiques de refactor codemod.

## 3) Contrat API MCP

### Endpoint

`POST /tools/findDuplicates`

### Requête

```json
{
  "workspaceRoot": "E:/repo",
  "paths": ["src"],
  "exclude": ["**/*.test.ts", "**/generated/**"],
  "minLines": 6,
  "minTokens": 40,
  "minSimilarity": 0.86,
  "maxGroups": 100,
  "includeIntraFile": true,
  "mode": "balanced"
}
```

### Réponse

```json
{
  "groups": [
    {
      "groupId": "dup_0001",
      "fingerprint": "sha1:...",
      "kind": "type1|type2|type3",
      "similarity": 0.93,
      "occurrences": [
        {
          "filePath": "src/.../a.ts",
          "startLine": 31,
          "endLine": 54,
          "startCol": 1,
          "endCol": 2,
          "symbolName": "computePrice",
          "snippetPreview": "function computePrice(...) { ... }"
        }
      ],
      "metrics": {
        "linesPerOccurrence": 24,
        "tokenCount": 132,
        "occurrenceCount": 3,
        "estimatedDupLines": 48,
        "impactScore": 72
      },
      "suggestedAction": "extract-function"
    }
  ],
  "summary": {
    "scannedFiles": 389,
    "candidateWindows": 12450,
    "groupsFound": 18,
    "durationMs": 842,
    "mode": "balanced"
  }
}
```

## 4) Architecture technique

Pipeline en 4 étapes :

1. **Préparation corpus**
   - Résolution de fichiers via glob + exclusions.
   - Lecture streamée et extraction de fenêtres de code.

2. **Normalisation + fingerprinting rapide**
   - Tokenisation légère (TypeScript compiler API / scanner lexical).
   - Normalisation :
     - identifiants -> `ID`
     - chaînes -> `STR`
     - nombres -> `NUM`
     - espaces/commentaires supprimés
   - Fenêtrage glissant (`n` lignes ou `m` tokens).
   - Hash des fenêtres (`xxhash`/`sha1`) pour clustering initial.

3. **Validation structurelle (anti faux positifs)**
   - Reparse AST des candidats proches.
   - Signature structurelle (séquence de kinds AST, profondeur, arité).
   - Similarité type Jaccard/overlap sur shingles AST.

4. **Scoring + ranking**
   - Score d’impact :
     - duplication nette (`estimatedDupLines`)
     - dispersion (nombre de fichiers)
     - criticité chemin (`src/domain`, `src/application`, etc.)
   - Tri descendant + limite `maxGroups`.

## 5) Modes d’exécution

- `fast` : hash + normalisation seulement (très rapide, plus de bruit).
- `balanced` (défaut) : + validation AST sur top candidats.
- `strict` : seuils plus élevés + validation renforcée, moins de faux positifs.

## 6) Plan de livraison par phases

### Phase 1 - MVP exploitable (1 sprint)
- Nouveau contrat `findDuplicates` (`contracts.ts`).
- Service `duplicate-detection-service.ts`.
- Intégration endpoint serveur.
- Détection Type-1/Type-2 via fingerprints.
- Tests unitaires + fixtures.
- Documentation usage + exemples cURL.

### Phase 2 - Qualité des résultats (1 sprint)
- Validation AST sur candidats.
- Support Type-3 partiel (`minSimilarity`).
- Score d’impact et suggestions (`extract-function`, `shared util`, `strategy object`).
- Golden tests (snapshots JSON stables).

### Phase 3 - Performance & DX (0.5-1 sprint)
- Cache incrémental par fichier (mtime + hash contenu).
- Option `sinceGitRef` pour scan partiel orienté PR.
- Export rapport (`json`, `md`) pour CI et revue humaine.

## 7) Stratégie de tests

Unitaires :
- Normalisation des tokens (renommages/littéraux).
- Hash stable multi-plateforme.
- Clustering correct (fusion/split).

Intégration :
- Appels endpoint `POST /tools/findDuplicates` sur workspace fixture.
- Vérification de l’ordre et de la stabilité des `groupId`.

Non-régression perf :
- Budget cible (mode balanced):
  - < 1s sur repo test moyen (~500 fichiers TS)
  - < 4s sur gros repo local (~2k fichiers TS)
- Mémoire cible: < 300 MB pic en mode balanced.

## 8) Observabilité

Ajouter dans logs (niveau debug/info) :
- `scannedFiles`, `candidateWindows`, `groupsFound`, `durationMs`.
- Ratio faux positifs estimé (après validation AST).
- Top 5 groupes par impact.

## 9) Risques et mitigations

- Faux positifs élevés sur code boilerplate.
  - Mitigation : filtrer patterns standard + seuil `minTokens`.
- Coût CPU sur très gros monorepo.
  - Mitigation : scan par scope `paths`, mode `fast`, cache incrémental.
- Résultats instables d’un run à l’autre.
  - Mitigation : tri déterministe + hash normalisé + snapshots de contrat.

## 10) Critères d’acceptation (Definition of Done)

- Endpoint documenté et testable en local.
- Détection validée sur fixtures avec clones Type-1/Type-2.
- `pnpm lint`, `pnpm type-check`, `pnpm test` passent.
- Temps d’exécution dans les budgets définis (mode balanced).
- Résultat exploitable par agent (JSON compact, trié, actionnable).

## 11) Backlog d’implémentation (ordre conseillé)

1. Ajouter schéma requête/réponse dans `contracts.ts`.
2. Créer `duplicate-detection-service.ts` + types internes.
3. Brancher `/tools/findDuplicates` dans `server.ts`.
4. Ajouter fixtures de duplications réalistes.
5. Écrire tests unitaires + intégration serveur.
6. Ajouter doc dans `services/code-intel-mcp/README.md`.
7. Ajouter benchmark local simple (script perf).
