# 08 - Plan complet Hardening `code-intel-mcp`

## 1) Objectif

Renforcer la sécurité, la robustesse et la résilience opérationnelle de `code-intel-mcp` sans dégrader significativement l’expérience développeur locale.

Finalité :
- Réduire la surface d’attaque (I/O, exécution process, traversal, payload abuse).
- Prévenir fuites d’informations dans logs/erreurs.
- Garantir des comportements déterministes sous charge et en cas d’entrée malveillante.

## 2) Modèle de menace (threat model simplifié)

Actifs à protéger :
- Code source workspace.
- Secrets potentiellement présents dans fichiers/configs.
- Stabilité machine locale (CPU, mémoire, disque).

Menaces prioritaires :
1. Path traversal et accès hors workspace.
2. Injection d’arguments via outils shell (`rg`, `ast-grep`).
3. Denial of Service via payload volumineux ou requêtes coûteuses.
4. Exfiltration d’info via erreurs détaillées/logs.
5. Usage non autorisé d’endpoints sensibles.

Hypothèses :
- Service majoritairement local, mais peut être exposé sur réseau interne.
- Clients potentiels : agents IA, scripts, IDE plugins.

## 3) Axes de hardening

## Axe A - Validation d’entrées stricte

- Introduire Zod sur tous les payloads d’outils.
- Rejeter les champs inconnus (`strict()`).
- Bornes explicites:
  - taille max body (ex: 256KB)
  - longueur max query regex/pattern
  - nombre max de chemins en entrée
- Normaliser encodage/Unicode (éviter confusions de chemins).

Livrables :
- `schemas/tool-requests/*.schema.ts`
- Middleware de validation uniforme.

## Axe B - Sécurité filesystem (workspace boundary)

- Canonicaliser tout chemin (`realpath`) avant usage.
- Vérifier que le chemin final est enfant d’un `workspaceRoot` autorisé.
- Refuser symlinks sortants hors workspace (ou mode allowlist explicite).
- Interdire patterns dangereux (`..`, chemins absolus hors scope, UNC non autorisé).

Livrables :
- utilitaire `safe-path.ts`
- tests path traversal + symlink breakout.

## Axe C - Exécution process externe sécurisée

- Pour `rg`/`ast-grep` :
  - commande fixe + arguments allowlistés
  - aucun shell interpolation
  - timeout strict par commande (ex: 5s défaut)
  - limite output (taille + lignes)
- Circuit breaker simple sur erreurs répétées.

Livrables :
- wrapper `safe-spawn.ts`
- métriques de timeout/abort.

## Axe D - Durcissement HTTP/runtime

- Binding réseau configurable, défaut `127.0.0.1`.
- Option token API locale (header `x-api-key`) pour mode réseau.
- Rate limiting léger par IP/client (token bucket mémoire).
- CORS strict (désactivé sauf besoin explicite).
- Health endpoint minimal sans fuite d’environnement.

Livrables :
- config runtime `HOST`, `PORT`, `API_KEY`, `RATE_LIMIT_*`.

## Axe E - Logs, erreurs, confidentialité

- Journaliser par niveaux (`error`, `warn`, `info`, `debug`).
- Redaction automatique des motifs sensibles:
  - tokens, clés, secrets, URLs signées, emails (selon politique).
- Messages d’erreur clients génériques ; détails internes en debug local uniquement.
- Corrélation requête (`requestId`) pour audit sans exposer contenu sensible.

Livrables :
- `logger.ts` centralisé + `redaction-rules.ts`.

## Axe F - Dépendances & supply chain

- Audit régulier (`pnpm audit` + policy CI).
- Pinning versions critiques des outils shell wrappers.
- Vérification licence + provenance des dépendances ajoutées.

Livrables :
- workflow CI sécurité dédié (audit + policy gating optionnel).

## 4) Plan de livraison par phases

### Phase 1 - Baseline sécurité (1 sprint)
- Validation Zod systématique sur endpoints.
- `safe-path` + enforcement workspace root.
- Timeouts + output caps sur process externes.
- Erreurs génériques côté client.
- Tests d’attaque essentiels (traversal, payload oversize).

### Phase 2 - Durcissement runtime (1 sprint)
- API key optionnelle + binding loopback par défaut.
- Rate limiting mémoire.
- Logging structuré + redaction.
- CI sécurité : audit + tests de sécurité automatiques.

### Phase 3 - Résilience avancée (0.5-1 sprint)
- Circuit breaker par outil externe.
- Quotas par endpoint (coût max / minute).
- Rapport hardening périodique (score + recommandations).

## 5) Tests sécurité à ajouter

Unitaires :
- Rejet chemins hors workspace.
- Rejet payload > limite.
- Rejet paramètres non supportés.
- Redaction logs effective.

Intégration :
- `POST /tools/*` avec cas malveillants.
- Timeout simulé de process externe.
- Rate limit dépassé => réponse contrôlée (`429`).

Fuzz léger (optionnel) :
- génération d’inputs path/pattern aléatoires pour détecter crash.

## 6) SLO/SLI sécurité-opérations

SLI proposés :
- `request_error_rate` (hors erreurs utilisateur attendues).
- `external_tool_timeout_rate`.
- `rejected_requests_security` (validation/rate-limit/path).

SLO initiaux :
- Disponibilité locale fonctionnelle > 99% en usage normal.
- 100% des requêtes hors-policy rejetées avant exécution outil.

## 7) Politique de configuration recommandée

- Dev local (défaut):
  - `HOST=127.0.0.1`
  - `REQUEST_LOGS=false`
  - `API_KEY` vide
- Dev partagé / LAN:
  - `HOST=0.0.0.0`
  - `API_KEY` obligatoire
  - `RATE_LIMIT` activé
  - `REQUEST_LOGS=info`

## 8) Risques & compromis

- Plus de validation = friction initiale pour certains usages libres.
  - compromis : messages d’erreur explicites + docs d’adaptation.
- Rate limiting trop strict peut gêner agents.
  - compromis : profils de limites (`dev`, `ci`, `heavy-agent`).
- Redaction excessive peut réduire le debug.
  - compromis : mode debug local explicite, jamais en mode partagé.

## 9) Critères d’acceptation (Definition of Done)

- Tous endpoints couverts par validation schéma + limites.
- Impossible d’accéder à un fichier hors workspaceRoot autorisé.
- Process externes bornés (timeout + output cap) et testés.
- Logs redacted et erreurs client non sensibles.
- Tests sécurité intégrés au pipeline CI.
- `pnpm lint`, `pnpm type-check`, `pnpm test` passent.

## 10) Backlog d’implémentation (ordre conseillé)

1. Créer `safe-path.ts` et tests associés.
2. Ajouter middleware Zod global pour outils MCP.
3. Créer `safe-spawn.ts` et migrer `rg`/`ast-grep` dessus.
4. Uniformiser gestion d’erreur (`error-map` + requestId).
5. Ajouter rate limiting mémoire configurable.
6. Ajouter redaction logger central.
7. Renforcer CI sécurité (audit + tests ciblés).
8. Documenter profils de config et runbooks incidents.
