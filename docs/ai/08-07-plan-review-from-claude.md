# Revue d'architecture + Plan d'implémentation production-ready
# code-intel-mcp — findDuplicates + Hardening

> Document destiné à l'orchestrateur. Autonome et exécutable tel quel.
> Dernière révision : 2026-02-28

---

## 1. Contexte et objectif

`code-intel-mcp` est un serveur HTTP local exposant des outils d'analyse de code
pour agents IA et IDE plugins. L'objectif est d'ajouter la détection de
duplications (`findDuplicates`) tout en portant l'ensemble du service à un niveau
de robustesse publiable : documentation, tests, sécurité, observabilité.

**Contraintes structurelles :**
- Local-first / self-hosted, pas de cloud dependency
- TypeScript/JavaScript uniquement en Phase 1
- Déterminisme strict (mêmes entrées → mêmes sorties)
- Zero infrastructure externe (pas de base de données, pas d'embeddings)

---

## 2. État du code existant — vulnérabilités confirmées

Ces problèmes ont été vérifiés dans le code source. Ils précèdent tout nouveau
développement.

### 2.1 Sécurité P0 (à corriger avant tout nouveau endpoint)

| # | Fichier | Ligne | Problème | Impact |
|---|---------|-------|----------|--------|
| V1 | `server.ts` | `readJsonBody` L149 | Pas de limite de taille — DoS par accumulation mémoire | Critique |
| V2 | `server.ts` | L479 | `error.message` exposé en réponse client — fuite d'info | Critique |
| V3 | `ast-grep-service.ts` | L79 | `spawnSync` sans `timeout` ni `maxBuffer` — DoS/freeze | Critique |
| V4 | `search-text-service.ts` | L118 | `spawnSync('rg')` sans `timeout` ni `maxBuffer` | Critique |

### 2.2 Sécurité P1 (à corriger en Phase 1)

| # | Fichier | Problème |
|---|---------|----------|
| V5 | `search-text-service.ts` | `collectFiles` walk récursif sans vérification symlink breakout |
| V6 | `contracts.ts` | Zéro validation runtime — cast aveugle `as Record<string, unknown>` |
| V7 | `server.ts` | `workspaceRoot` utilisé tel quel sans canonicalisation ni vérification boundary |

### 2.3 Architecture P1 (dettes à solder)

| # | Problème |
|---|----------|
| A1 | `ToolRequest` générique (`query?`, `symbol?`, `options?`) mal adapté à un outil aussi paramétrique que `findDuplicates` |
| A2 | Pas de logger centralisé — `console.log` / `console.error` éparpillés |
| A3 | Binding `0.0.0.0` non désactivé si exposé sur réseau interne |

---

## 3. Décisions d'architecture (rationnel)

### 3.1 Contrat `findDuplicates` — type dédié, pas `ToolRequest` générique

`ToolRequest` est conçu pour des requêtes simples (symbol + filePath). `findDuplicates`
a 8 paramètres spécifiques. Solution : créer `FindDuplicatesRequest` et
`FindDuplicatesResponse` dans `contracts.ts`, routés séparément dans `server.ts`.
Les outils existants conservent `ToolRequest` sans changement de rupture.

### 3.2 Pipeline de détection — bucket map, pas N²

```
Fichiers → Fenêtrage glissant → Normalisation → SHA-256
                                                   ↓
                                           bucket: hash → [occurrences]
                                                   ↓
                               Groupes candidats (bucket.size ≥ 2)
                                                   ↓
                               Validation AST (Type-3 : Jaccard shingles)
                                                   ↓
                                        Score + tri + limite
```

Le bucket map garantit O(N·W) où W = taille fenêtre, pas O(N²).
Le passage AST n'est fait que sur les candidats détectés, pas sur toutes les paires.

### 3.3 Hash — `node:crypto` SHA-256, pas `xxhash`

Pas de dépendance externe. SHA-256 est déterministe multi-plateforme. À remplacer
par `xxhash` seulement si benchmark prouve bottleneck mesurable (> 20% du budget).

### 3.4 Validation — Zod colocalisé dans `contracts.ts`

Pas de répertoire `schemas/` séparé. Schémas Zod dans `contracts.ts`, types TS
dérivés via `z.infer<>`. Middleware de validation centralisé dans `server.ts`
évite duplication.

### 3.5 Sécurité filesystem — `safe-path.ts` partagé

Utilitaire unique utilisé par tous les services (search, struct, duplicates).
`assertWithinWorkspace(root, path)` → canonicalise via `realpathSync` ou
équivalent cross-platform, rejette si le résultat n'est pas enfant de `root`.

### 3.6 Process externe — `safe-spawn.ts`

Wrapper sur `spawnSync`/`spawn` avec : timeout strict, maxBuffer, args allowlist,
zéro interpolation shell. Tous les appels existants (`rg`, `ast-grep`) migrés dessus.

### 3.7 Rate limiting — semaphore de concurrence, pas token bucket IP

Pour usage local, le risque n'est pas volumétrique par IP mais coût CPU par
scan. Un semaphore de concurrence par endpoint (max N scans simultanés) est
plus adapté et plus simple.

### 3.8 Logging — logger structuré centralisé

Remplace les `console.log` éparpillés. Niveaux : `error / warn / info / debug`.
Redaction automatique de motifs sensibles (tokens, clés). En mode local,
`debug` activable par env var. Réponses client jamais détaillées.

---

## 4. Plan de livraison — 4 phases séquentielles

### Phase 0 — Correctifs P0 (pré-requis absolu, ~0.5 sprint)

**Objectif : rendre le service existant sûr avant d'y ajouter quoi que ce soit.**

#### Tâches

| ID | Fichier | Action |
|----|---------|--------|
| T0-1 | `server.ts` | Ajouter limite 256 KB dans `readJsonBody` : compter octets chunks, throw avec code `PAYLOAD_TOO_LARGE` si dépassé → HTTP 413 `{"ok":false,"error":"payload too large"}` |
| T0-2 | `server.ts` | Remplacer `error.message` L479 par `'internal error'` ; logger le message réel via `console.error` |
| T0-3 | `ast-grep-service.ts` | Ajouter `timeout: 5000, maxBuffer: 4 * 1024 * 1024` au `spawnSync` |
| T0-4 | `search-text-service.ts` | Idem `spawnSync('rg')` |
| T0-5 | Tests | Tests unitaires pour T0-1/T0-2 ; tests d'intégration simulant timeout (via runner mock) |

#### Critères de validation Phase 0

- `curl -d @payload-257kb.json POST /tools/searchText` → HTTP 413
- `curl -d '{"bad":"json"' POST /tools/searchText` → HTTP 500, body = `{"ok":false,"error":"internal error"}` (pas de stack trace)
- `pnpm test` passe

---

### Phase 1 — Hardening complet (1-1.5 sprint)

**Objectif : service prêt pour publication, sans dette sécurité.**

#### 1.A — Infrastructure sécurité

| ID | Fichier | Action |
|----|---------|--------|
| T1-1 | `src/safe-path.ts` (nouveau) | Exporter `assertWithinWorkspace(root: string, userPath: string): string` : resolve + realpath-compatible + vérif prefix. Rejeter : `..`, chemin absolu hors root, UNC non autorisé, symlink sortant |
| T1-2 | `src/safe-spawn.ts` (nouveau) | Exporter `safeSpawnSync(cmd, args, opts): SpawnResult` avec : `timeout` obligatoire, `maxBuffer` obligatoire, args = `string[]` (jamais interpolé), stdout/stderr capés |
| T1-3 | `src/ast-grep-service.ts` | Migrer `spawnSync` → `safeSpawnSync`; passer `workspaceRoot` par `assertWithinWorkspace` |
| T1-4 | `src/search-text-service.ts` | Migrer `spawnSync` → `safeSpawnSync`; `collectFiles` résoud les paths via `assertWithinWorkspace` |
| T1-5 | `src/contracts.ts` | Ajouter schémas Zod pour `ToolRequest` et tous les types existants; dériver types TS via `z.infer<>` |
| T1-6 | `src/server.ts` | Middleware validation Zod uniforme : valider body avant dispatch, erreur 400 générique si invalide |
| T1-7 | `src/logger.ts` (nouveau) | Logger structuré : niveaux `error/warn/info/debug`, format JSON, redaction patterns sensibles, configurable via `CODE_INTEL_LOG_LEVEL` |
| T1-8 | `src/server.ts` | Remplacer tous les `console.*` par `logger.*` |

#### 1.B — Config runtime étendue

Variables d'environnement à ajouter :

```
CODE_INTEL_HOST          défaut: 127.0.0.1
CODE_INTEL_PORT          défaut: 4545
CODE_INTEL_API_KEY       défaut: vide (désactivé)
CODE_INTEL_LOG_LEVEL     défaut: info
CODE_INTEL_MAX_BODY_BYTES défaut: 262144
CODE_INTEL_SPAWN_TIMEOUT  défaut: 5000
```

En mode réseau partagé (`HOST != 127.0.0.1`) : `API_KEY` exigée au démarrage
ou warning visible.

#### 1.C — Tests sécurité obligatoires

Fichier : `src/__tests__/security.test.ts`

```
[ ] Path traversal : workspaceRoot + "../../../etc/passwd" → rejeté
[ ] Symlink breakout : lien hors workspace → rejeté
[ ] Payload 257 KB → HTTP 413
[ ] Corps non-JSON → HTTP 400, body générique
[ ] Champ inconnu dans body → HTTP 400 (Zod strict)
[ ] Process external timeout simulé → HTTP 500, body générique, log interne
[ ] Output process externe tronqué proprement (maxBuffer)
[ ] x-api-key absent quand HOST != 127.0.0.1 → HTTP 401
```

#### Critères de validation Phase 1

- Tous les tests sécurité passent
- `pnpm audit` ne remonte aucune vulnérabilité high/critical
- Health endpoint ne contient aucune info d'environnement (process.env, version Node, etc.)
- `pnpm lint && pnpm type-check && pnpm test`

---

### Phase 2 — `findDuplicates` complet (1.5-2 sprints)

**Objectif : détection Type-1/2/3 stable, publiable, avec observabilité complète.**

#### 2.A — Contrat API

Fichier : `src/contracts.ts` (extension)

```typescript
// Requête
export interface FindDuplicatesRequest {
  workspaceRoot: string;
  paths?: string[];               // défaut: ["."]
  exclude?: string[];             // globs
  minLines?: number;              // défaut: 6
  minTokens?: number;             // défaut: 40
  minSimilarity?: number;         // 0-1, défaut: 0.86 (Type-3 only)
  maxGroups?: number;             // défaut: 100
  includeIntraFile?: boolean;     // défaut: true
  mode?: 'fast' | 'balanced' | 'strict'; // défaut: balanced
}

// Réponse
export interface DuplicateOccurrence {
  filePath: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
  snippetPreview: string;         // 2 premières lignes max
}

export interface DuplicateGroup {
  groupId: string;                // "dup_0001"
  fingerprint: string;            // "sha256:..."
  kind: 'type1' | 'type2' | 'type3';
  similarity: number;             // 1.0 pour type1/2
  occurrences: DuplicateOccurrence[];
  metrics: {
    linesPerOccurrence: number;
    tokenCount: number;
    occurrenceCount: number;
    estimatedDupLines: number;    // linesPerOcc * (count - 1)
    impactScore: number;          // estimatedDupLines * dispersionFactor
  };
  suggestedAction: 'extract-function' | 'shared-util' | 'review';
}

export interface FindDuplicatesResult {
  groups: DuplicateGroup[];
  summary: {
    scannedFiles: number;
    candidateWindows: number;
    groupsFound: number;
    durationMs: number;
    mode: string;
    peakMemoryMb: number;
  };
}
```

Schéma Zod correspondant dans `contracts.ts`, dérivé des interfaces.

#### 2.B — Pipeline de détection

Fichier : `src/duplicate-detection-service.ts` (nouveau)

**Étape 1 — Corpus**
```
- Résolution via glob (fast-glob) + exclusions
- assertWithinWorkspace() sur chaque path résolu
- Lecture streamée, rejet fichiers > 500 KB (configurable)
```

**Étape 2 — Fenêtrage + Normalisation + Hash**
```
Pour chaque fichier :
  Pour chaque fenêtre de minLines lignes :
    tokens = scan lexical TypeScript (ts.createScanner)
    normalisés : identifiants → ID, strings → STR, numbers → NUM
    hash = SHA-256(tokens normalisés)
    bucket[hash].push({ filePath, startLine, endLine, tokenCount, rawTokens })

Après parcours :
  groupes_candidats = [buckets avec size ≥ 2]
  → Type-1 et Type-2 détectés ici (hash exact post-normalisation)
```

**Étape 3 — Validation AST (mode balanced/strict)**
```
Pour chaque groupe candidat :
  Reparser les occurrences avec ts.createSourceFile
  Extraire shingles AST (séquence de SyntaxKind, n=4)
  Jaccard(shingles_A, shingles_B) >= minSimilarity ?
    → confirmer comme Type-3 si < 1.0
    → confirmer comme Type-2 si hash normalisé identique
    → rejeter sinon (faux positif)
```

**Étape 4 — Scoring + Ranking**
```
impactScore = estimatedDupLines * log2(1 + nbFichiersDifférents)
suggestedAction :
  - 1 fichier → 'extract-function'
  - 2-3 fichiers, < 30 lignes → 'shared-util'
  - sinon → 'review'
Tri descendant impactScore, truncation maxGroups
```

**Garde-fous mémoire :**
- Vérifier `process.memoryUsage().heapUsed` après chaque fichier
- Si > 300 MB : arrêter le scan, retourner résultats partiels avec flag
  `summary.truncated: true`

#### 2.C — Modes d'exécution

| Mode | Comportement |
|------|-------------|
| `fast` | Hash uniquement, pas de validation AST, seuils par défaut permissifs |
| `balanced` | Hash + validation AST sur top 200 candidats |
| `strict` | Hash + validation AST complète + seuils relevés (`minSimilarity: 0.92`) |

#### 2.D — Cache incrémental

Fichier : `src/duplicate-cache.ts` (nouveau)

```
Cache clé = SHA-256(filePath + mtime + fileSize)
Valeur = fenêtres + hashes calculés pour ce fichier
Stockage : fichier JSON dans workspaceRoot/.code-intel-cache/dup-cache.json
Invalidation : à chaque démarrage, purger les entrées dont le fichier n'existe plus
```

#### 2.E — Intégration `server.ts`

```typescript
case 'findDuplicates': {
  const parsed = FindDuplicatesRequestSchema.safeParse(body);
  if (!parsed.success) { respond(400, zodError(parsed.error)); return; }
  const req = assertPathsWithinWorkspace(parsed.data); // throws si hors scope
  const sem = getEndpointSemaphore('findDuplicates', 2); // max 2 concurrent
  const ticket = await sem.acquire();
  try {
    respond(200, await findDuplicates(req));
  } finally {
    ticket.release();
  }
}
```

#### 2.F — Tests

**Unitaires** (fichier : `src/__tests__/duplicate-detection.test.ts`) :
```
[ ] Normalisation : identifiant renommé → même hash que original
[ ] Hash stable multi-plateforme (fixture JSON figée)
[ ] Bucket map : 3 occurrences identiques → 1 groupe de 3
[ ] Bucket map : 2 fragments distincts → 2 groupes de 1 → filtrés
[ ] Jaccard shingles : code similaire à 87% → Type-3 si minSimilarity=0.86
[ ] Score impact : plus de fichiers impactés → score plus élevé
[ ] Mémoire : garde-fou déclenché → résultat partiel avec truncated:true
```

**Intégration** (fichier : `src/__tests__/find-duplicates.integration.test.ts`) :
```
[ ] Endpoint retourne HTTP 200 avec groupes valides sur fixture simple
[ ] Stabilité : 3 runs consécutifs → groupIds identiques (déterminisme)
[ ] Mode fast plus rapide que balanced (benchmark dans test)
[ ] Exclusions respectées (node_modules absent des résultats)
[ ] Cas vide : workspace sans duplications → groups: []
[ ] Payload invalide → HTTP 400
[ ] Path traversal dans paths[] → HTTP 400
```

**Golden tests** (fichier : `fixtures/duplicates/expected-output.json`) :
- Snapshot JSON de référence sur fixture figée
- Comparé bit-à-bit à chaque run CI

**Budget perf** (fichier : `src/__tests__/perf.test.ts`) :
```
[ ] Mode balanced, ~500 fichiers TS : < 1s, < 300MB RAM
[ ] Mode balanced, ~2k fichiers TS : < 4s, < 300MB RAM
```

#### Critères de validation Phase 2

- Détection Type-1/2 validée sur toutes les fixtures
- Détection Type-3 validée (≥ 1 cas golden)
- Golden tests stables sur 5 runs
- Budgets perf respectés sur machine de référence
- `pnpm lint && pnpm type-check && pnpm test`

---

### Phase 3 — CI, observabilité, publication (0.5-1 sprint)

**Objectif : qualité publiable à la communauté.**

#### 3.A — CI sécurité

Fichier : `.github/workflows/security.yml` (ou équivalent)

```yaml
jobs:
  security:
    steps:
      - pnpm audit --audit-level=high
      - pnpm test -- --testPathPattern=security
      - pnpm test -- --testPathPattern=perf
```

#### 3.B — `sinceGitRef` (scan incrémental orienté PR)

Via `safe-spawn.ts` :
```
git diff --name-only <ref> HEAD | filtre .ts/.tsx/.js/.jsx
→ scanner uniquement ces fichiers
→ détecter nouvelles duplications introduites dans la PR
```

Intégration : paramètre optionnel `sinceGitRef?: string` dans `FindDuplicatesRequest`.

#### 3.C — Export rapport

Paramètre `outputFormat?: 'json' | 'markdown'` dans requête.
Markdown : table de résumé + sections par groupe avec liens fichiers.

#### 3.D — Observabilité

SLI à monitorer dans les logs :
- `request_duration_ms` par endpoint
- `external_tool_timeout_count` (rg, ast-grep)
- `rejected_requests_security` (path traversal, payload oversize, auth)
- `duplicate_scan_truncated` (garde-fou mémoire déclenché)

Tous loggés via `logger.ts` en niveau `info` sur chaque requête terminée.

#### 3.E — Documentation

- `services/code-intel-mcp/README.md` :
  - installation, démarrage, config env vars
  - exemples cURL pour chaque endpoint
  - section sécurité (profils dev local / réseau partagé)
  - section contribution / tests

#### Critères de validation Phase 3

- CI passe sur branche fraîche (zéro secret commité, audit propre)
- `sinceGitRef` fonctionne sur repo de test avec PR simulée
- README lisible et autonome pour un nouvel utilisateur
- Health endpoint retourne tous les tools, dont `findDuplicates`

---

## 5. Ordre d'implémentation condensé (backlog orchestrateur)

```
PHASE 0 (prérequis, ~2j)
  [ ] T0-1 readJsonBody 256KB limit + HTTP 413
  [ ] T0-2 error.message masqué côté client
  [ ] T0-3 ast-grep-service spawnSync timeout+maxBuffer
  [ ] T0-4 search-text-service spawnSync timeout+maxBuffer
  [ ] T0-5 Tests unitaires T0-1..4

PHASE 1 (~1.5 sprint)
  [ ] T1-1 safe-path.ts + tests traversal/symlink
  [ ] T1-2 safe-spawn.ts
  [ ] T1-3 ast-grep-service migré safe-spawn
  [ ] T1-4 search-text-service migré safe-spawn + collectFiles via safe-path
  [ ] T1-5 contracts.ts : Zod schemas + types dérivés
  [ ] T1-6 server.ts : middleware Zod uniforme
  [ ] T1-7 logger.ts centralisé + redaction
  [ ] T1-8 server.ts : console.* → logger.*
  [ ] T1-9 config runtime : HOST, API_KEY, LOG_LEVEL, MAX_BODY_BYTES, SPAWN_TIMEOUT
  [ ] T1-10 security.test.ts complet (8 cas listés ci-dessus)

PHASE 2 (~2 sprints)
  [ ] T2-1 contracts.ts : FindDuplicatesRequest/Response + Zod
  [ ] T2-2 duplicate-detection-service.ts : étapes 1+2 (corpus + bucket hash)
  [ ] T2-3 duplicate-detection-service.ts : étape 3 (validation AST + Type-3)
  [ ] T2-4 duplicate-detection-service.ts : étape 4 (scoring + ranking)
  [ ] T2-5 duplicate-cache.ts (cache incrémental mtime)
  [ ] T2-6 server.ts : brancher /tools/findDuplicates + semaphore
  [ ] T2-7 fixtures/duplicates/ : clones Type-1, Type-2, Type-3, cas limites
  [ ] T2-8 duplicate-detection.test.ts (unitaires, 8 cas)
  [ ] T2-9 find-duplicates.integration.test.ts (7 cas)
  [ ] T2-10 fixtures/duplicates/expected-output.json (golden test)
  [ ] T2-11 perf.test.ts (budgets 500f/2kf)
  [ ] T2-12 modes fast/balanced/strict
  [ ] T2-13 garde-fou mémoire 300MB + truncated:true

PHASE 3 (~0.5-1 sprint)
  [ ] T3-1 FindDuplicatesRequest.sinceGitRef via safe-spawn
  [ ] T3-2 outputFormat markdown
  [ ] T3-3 SLI loggés sur chaque requête
  [ ] T3-4 CI workflow security + perf
  [ ] T3-5 README complet
```

---

## 6. Fichiers critiques (référence rapide)

```
services/code-intel-mcp/src/
  server.ts                          — routeur HTTP, modifier
  contracts.ts                       — types + Zod, modifier
  ast-grep-service.ts                — migrer safe-spawn
  search-text-service.ts             — migrer safe-spawn + safe-path
  safe-path.ts                       — créer (T1-1)
  safe-spawn.ts                      — créer (T1-2)
  logger.ts                          — créer (T1-7)
  duplicate-detection-service.ts     — créer (T2-2..4)
  duplicate-cache.ts                 — créer (T2-5)
  __tests__/
    security.test.ts                 — créer (T1-10)
    duplicate-detection.test.ts      — créer (T2-8)
    find-duplicates.integration.test.ts — créer (T2-9)
    perf.test.ts                     — créer (T2-11)
  fixtures/
    duplicates/
      type1-exact/                   — créer (T2-7)
      type2-renamed/                 — créer (T2-7)
      type3-similar/                 — créer (T2-7)
      expected-output.json           — créer (T2-10)
```

---

## 7. Preuves que le système fonctionne comme attendu

### À chaque PR / avant merge

```bash
pnpm lint                    # zéro warning
pnpm type-check              # zéro erreur
pnpm test                    # 100% pass, golden tests stables
pnpm test -- --testPathPattern=security   # tous les cas sécurité
pnpm test -- --testPathPattern=perf       # budgets respectés
pnpm audit --audit-level=high             # zéro vuln high+
```

### Test manuel de non-régression (smoke test post-déploiement)

```bash
# 1. Santé
curl http://127.0.0.1:4545/health | jq .tools

# 2. Traversal rejeté
curl -s -X POST http://127.0.0.1:4545/tools/findDuplicates \
  -H 'content-type: application/json' \
  -d '{"workspaceRoot":"/tmp","paths":["../../etc"]}' | jq .

# 3. Payload oversize rejeté (HTTP 413)
python3 -c "print('{\"workspaceRoot\":\"/tmp\",\"q\":\"' + 'a'*300000 + '\"}')" | \
  curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://127.0.0.1:4545/tools/findDuplicates \
  -H 'content-type: application/json' -d @-

# 4. Scan réel sur workspace courant
curl -s -X POST http://127.0.0.1:4545/tools/findDuplicates \
  -H 'content-type: application/json' \
  -d '{"workspaceRoot":"'$(pwd)'","mode":"fast","maxGroups":10}' | jq .summary

# 5. Stabilité : 3 runs identiques
for i in 1 2 3; do
  curl -s -X POST http://127.0.0.1:4545/tools/findDuplicates \
    -d '{"workspaceRoot":"'$(pwd)'"}' | jq '[.groups[].groupId]'
done
# Les 3 sorties doivent être identiques
```

### Indicateur de qualité publiable

- [ ] Zero vulnérabilité P0 dans le code
- [ ] 100% des endpoints validés par Zod
- [ ] Impossible d'accéder hors workspaceRoot (testé automatiquement)
- [ ] Process externes bornés timeout + output (testés via mock)
- [ ] Golden tests stables sur 5 runs consécutifs
- [ ] Budgets perf tenus en CI (pas seulement en local)
- [ ] README autonome pour un nouvel utilisateur
- [ ] Health endpoint ne fuit aucune info système
