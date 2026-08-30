# CLAUDE.md — SPO-Pipeline

Orchestrateur autonome du backlog SPO-WebClient : une carte GitHub entre en `Todo`, en ressort
`Done` avec une PR mergée, ou est *parkée* avec un motif. `orchestrator/` est la machine à états,
`prompts/` les steps LLM, `doc/state-machine-spec.md` la spécification.

> Ce fichier est chargé à chaque appel LLM dont le `cwd` est la racine du dépôt — DIAGNOSE,
> VALIDATE, CITATION_VERIFIER (`config.js` → `cwdForStep`). Le garder court est une contrainte
> de coût, pas un style : y ajouter du contexte, c'est le payer à chaque step.

## Conventions `gh` — pièges déjà payés

Ne pas les re-découvrir. `gh` est l'outil GitHub natif du projet (compte `Crazz-E`, scopes
`repo, project, workflow`) ; aucun MCP GitHub n'est configuré et il ne faut pas en ajouter.

- **`gh pr edit` ne marche pas** sur ce dépôt (board Projects classic) — la commande est en
  `deny`. Éditer une PR passe par `gh api repos/Crazz-Org/<repo>/pulls/<n> -X PATCH`.
- **Déplacer une carte sur le board** n'a pas d'équivalent CLI : c'est `gh api graphql` avec une
  mutation `updateProjectV2ItemFieldValue`. Les ids de champs se lisent avec
  `gh project field-list 1 --owner Crazz-Org --format json` ; relevé complet dans
  `doc/board-audit.md`.
- **Ajouter une option à un champ single-select** : mutation GraphQL également, il n'existe pas
  de `gh project field-create` pour ça (`orchestrator/README.md`).
- **Verdict par code de sortie**, jamais par lecture de la sortie texte de `gh`.
- Les appels `gh` de l'orchestrateur partent de Node en `execFile` — ils ne passent pas par la
  couche permission de Claude. Un blocage d'autorisation ne concerne donc jamais le daemon,
  uniquement une session Claude.

## Autorisations

Politique, mesures et arbitrages : `doc/permissions.md`. Deux points à connaître avant de
planifier une carte :

- **`.claude/settings.json` et `.claude/hooks/*.sh` ne sont pas éditables** par un agent : le
  harness les refuse comme fichiers sensibles, indépendamment des règles du dépôt. Une carte
  dont le plan exige de les modifier ne peut pas aboutir — la parker avec ce motif plutôt que
  de la faire échouer en IMPLEMENT.
- DIAGNOSE / VALIDATE / CITATION_VERIFIER tournent depuis la racine du dépôt en
  `permissionMode: 'default'` **sans humain** : ce que `.claude/settings.json` n'autorise pas
  est refusé, pas mis en attente.
- `.claude/settings.json` est la **source unique** de la politique : il est aussi installé comme
  couche utilisateur de chaque compte du pool (`spo account sync-settings`, automatique à
  `account add` et à chaque démarrage `--real`). Après l'avoir édité, resynchroniser.

## Git

Le dépôt utilise des worktrees pour deux usages distincts :

- `worktrees/issue-<n>/` — checkouts **de SPO-WebClient**, créés et détruits par le step
  WORKTREE. Ne pas y toucher à la main pendant qu'une tâche tourne.
- `.claude/worktrees/<slug>/` — worktrees de travail sur *ce* dépôt.

La pile `git stash` est partagée entre tous les worktrees et plusieurs sessions peuvent tourner
en parallèle : ne jamais utiliser `git stash` / `git stash pop` nus. Préférer un commit WIP.
