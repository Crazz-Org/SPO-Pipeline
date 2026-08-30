# Politique d'autorisations — SPO-Pipeline

> **Statut au 2026-08-30.** Audit de cohérence autorisations ↔ processus, suivi de sa
> correction. `.claude/settings.json` (ce dépôt) et le `deny` de `~/.claude/settings.json` sont
> à jour ; les mesures ci-dessous décrivent l'état *avant* correction et servent de référence.

## Le problème

Trois couches d'autorisations existent, et le dépôt pipeline n'en a aucune.

| Couche | Contenu | Portée |
|---|---|---|
| `~/.claude/settings.json` | 14 règles `gh`, **0 règle `git`** | toutes machines, tous dépôts |
| `~/.claude/settings.local.json` | `git commit/config/push/remote` — les écritures, pas les lectures | idem, non versionné |
| `SPO-WebClient/.claude/settings.json` | 70 règles (git complet, npm, npx), deny durci, 3 hooks | produit |
| `SPO-Pipeline/.claude/settings.json` | **absent** | — |

Mesure sur les transcripts de sessions SPO-Pipeline (1 665 appels Bash) :

```
non couvert : git status 73 · git log 73 · git diff 52 · git add 44 · git show 30
              git checkout 29 · git worktree 29 · gh api graphql 28 · git branch 25
              git pull 24 · gh api repos 23 · git fetch 21 · git grep 15 · git rev-parse 10
couvert     : gh pr view 93 · gh pr merge 40 · gh pr create 34 · git push 52 · git commit 45
```

Environ **430 appels git/gh sur ~500** déclenchent une demande d'autorisation. Le blocage est
la règle, pas l'exception — l'inverse de l'intention.

## Pourquoi ça touche aussi les steps automatisés

`orchestrator/steps/llm.js` lance `claude -p` avec `CLAUDE_CONFIG_DIR=~/.claude-accounts/poolN`.
Ces répertoires n'ont **pas** de `settings.json` : les règles utilisateur disparaissent pour
tous les steps LLM. Restent les règles *projet*, résolues depuis le `cwd` du step
(`config.js` → `cwdForStep`) :

| Step | `cwd` | Règles projet visibles |
|---|---|---|
| PLAN, IMPLEMENT | worktree produit (`worktrees/issue-N/`) | les 70 règles WebClient (`.claude/settings.json` est versionné, donc présent dans chaque worktree) ✅ |
| DIAGNOSE, VALIDATE, CITATION_VERIFIER | racine SPO-Pipeline | **aucune** ❌ |

Ces trois steps tournent en `permissionMode: 'default'` sans humain pour répondre : toute
commande Bash non triviallement read-only est **refusée**, pas mise en attente.

### La couche compte, comblée elle aussi

Le tableau ci-dessus dit que les règles *utilisateur* disparaissent pour tous les steps LLM. La
politique projet suffit tant que chaque step atterrit dans un répertoire qui en porte une —
c'est le cas aujourd'hui (racine du pipeline ou worktree produit), ce qui **masque** le trou
sans le combler. Un step dont le `cwd` n'aurait pas de `.claude/settings.json` tournerait sans
aucune règle.

Le répertoire d'un compte **est** son `CLAUDE_CONFIG_DIR`, donc un `settings.json` posé dedans
est sa couche utilisateur. `spo account sync-settings` y installe `<repo>/.claude/settings.json`
tel quel, pour chaque compte du pool : le plancher d'autorisations ne dépend plus ni du `cwd` du
step, ni du compte que la rotation a choisi. La commande est idempotente et tourne toute seule à
deux moments — `spo account add`, et chaque démarrage `--real` du daemon, pour qu'un compte
ajouté ou réactivé entre deux runs ne reste pas en retard.

Le fichier écrit dans le pool est machine-owned : il porte une clé `"//"` qui le dit, et il est
réécrit à chaque sync. **La source unique reste `<repo>/.claude/settings.json`**, celle que git
relit — le CLI ne garde pas une seconde copie des règles qui pourrait diverger. Pour changer la
politique : éditer la source, puis `bin/spo account sync-settings`.

Un détail qui aurait pu passer inaperçu : `accounts.hasCredentials()` répond « ce compte
détient-il de vrais credentials ? » par exclusion des fichiers que le module gère lui-même. Le
`settings.json` synchronisé y est donc explicitement exclu — sans ça, synchroniser le pool ferait
dire à `spo accounts` que chaque compte est authentifié, y compris ceux qui ne le sont pas.
Couvert par un test de régression.

Conséquence directe : DIAGNOSE est le filet de sécurité prévu pour la CI-forensics
(`doc/improvisation-analysis.md`, cause R2 — `gh run view --log-failed`, `gh api …/jobs`) et il
n'a aucune de ces autorisations. VALIDATE doit lire `git diff` du worktree produit et ne le
peut pas non plus. Créer `SPO-Pipeline/.claude/settings.json` corrige les deux d'un coup, sans
toucher aux répertoires de comptes.

## Contradictions deny ↔ processus (arbitrées le 2026-08-30)

- `gh pr edit*` reste en **deny** — la commande est cassée côté Projects classic ; le substitut
  est `gh api repos/… -X PATCH`, couvert par la règle `gh api repos/Crazz-Org/…/*`.
- `gh issue close*` et `gh pr close*` **sortent du deny, sans allow** : fermer une carte fait
  partie du processus (l'orchestrateur le fait en Node dans `report-intake.js`, hors couche
  permission ; une session Claude en était empêchée par un blocage dur). Elles demandent
  désormais confirmation au lieu d'être refusées.
- `gh issue delete*` et `gh repo delete*` restent en deny — irréversibles.

## Choix assumés dans les règles

- **`gh api graphql*` est autorisé.** 28 usages, aucune alternative CLI pour déplacer une carte
  sur un board Projects v2. Contrepartie explicite : une règle sur `gh api` ne peut pas
  exprimer « GET seulement », donc cette règle autorise structurellement n'importe quelle
  mutation GraphQL et **contourne les deny posés sur les sous-commandes `gh`**. Décision du
  mainteneur, prise en connaissance de cause.
- **`git fetch` / `git pull` sont scopés**, contrairement au dépôt produit qui les autorise en
  bloc. `--upload-pack='<cmd>'` et les URL `ext::` font de ces commandes de l'exécution
  arbitraire ; seules les formes nues et `origin*` sont autorisées.
- **`git -C * <sous-commande>*`** : le `*` placé avant la sous-commande peut absorber des
  options injectées (`-c core.pager=…`). Risque résiduel connu, conservé par parité avec la
  politique du dépôt produit qui utilise déjà ces formes.
- `sed` n'est autorisé que sous la forme `sed -n *` (lecture), jamais `sed -i`.

## Murs non réglables par `settings.json`

Certains refus viennent du harness lui-même et **aucune règle d'allow ne les lève** :

1. **Édition de `.claude/settings.json` et `.claude/hooks/*.sh`.** Le tool layer refuse
   (« which is a sensitive file » / refus du classifieur auto mode). Un journal de tâche montre
   IMPLEMENT rendant un verdict partiel sur ce mur, qualifié à raison de *tooling blocker* et
   non de défaut de plan. **Toute carte dont le plan exige de modifier ces fichiers doit être
   appliquée par un humain** — le driver ne peut pas la faire aboutir. À traiter comme une
   cause de park connue plutôt que comme un échec d'exécution.
2. `git stash` nu en worktree — la pile est partagée entre worktrees, cf. consignes de session.

## Le contenu appliqué dans `SPO-Pipeline/.claude/settings.json`

```json
{
  "permissions": {
    "allow": [
      "Read", "Grep", "Glob", "Edit", "Write",

      "Bash(git status*)", "Bash(git log*)", "Bash(git diff*)", "Bash(git show*)",
      "Bash(git branch*)", "Bash(git blame*)", "Bash(git grep*)", "Bash(git ls-files*)",
      "Bash(git ls-tree*)", "Bash(git rev-parse*)", "Bash(git rev-list*)",
      "Bash(git describe*)", "Bash(git merge-base*)", "Bash(git reflog*)",
      "Bash(git remote*)", "Bash(git config*)", "Bash(git check-ignore*)",
      "Bash(git worktree*)",

      "Bash(git add*)", "Bash(git commit*)", "Bash(git push*)", "Bash(git checkout*)",
      "Bash(git switch*)", "Bash(git restore*)", "Bash(git merge*)", "Bash(git rebase*)",
      "Bash(git cherry-pick*)", "Bash(git stash*)", "Bash(git tag*)", "Bash(git mv*)",
      "Bash(git apply*)", "Bash(git init*)",

      "Bash(git fetch)", "Bash(git fetch origin*)", "Bash(git fetch --all*)",
      "Bash(git pull)", "Bash(git pull origin*)", "Bash(git pull --ff-only*)",

      "Bash(git -C * status*)", "Bash(git -C * log*)", "Bash(git -C * diff*)",
      "Bash(git -C * show*)", "Bash(git -C * rev-parse*)", "Bash(git -C * branch*)",
      "Bash(git -C * worktree*)",

      "Bash(gh auth status*)", "Bash(gh api rate_limit*)", "Bash(gh api graphql*)",
      "Bash(gh api repos/Crazz-Org/SPO-WebClient/*)",
      "Bash(gh api repos/Crazz-Org/SPO-Pipeline/*)",
      "Bash(gh pr create*)", "Bash(gh pr view*)", "Bash(gh pr list*)", "Bash(gh pr diff*)",
      "Bash(gh pr checks*)", "Bash(gh pr merge*)",
      "Bash(gh issue create*)", "Bash(gh issue view*)", "Bash(gh issue list*)",
      "Bash(gh issue comment*)", "Bash(gh issue edit*)",
      "Bash(gh label list*)", "Bash(gh run list*)", "Bash(gh run view*)",
      "Bash(gh project list*)", "Bash(gh project field-list*)", "Bash(gh project item-list*)",
      "Bash(gh project item-add*)", "Bash(gh project item-edit*)",

      "Bash(node *)", "Bash(npm test*)", "Bash(npm run *)", "Bash(npm ci*)", "Bash(npm ls*)",
      "Bash(bin/spo *)", "Bash(./bin/spo *)",

      "Bash(ls *)", "Bash(pwd*)", "Bash(cd *)", "Bash(cat *)", "Bash(head *)",
      "Bash(tail *)", "Bash(wc *)", "Bash(sort *)", "Bash(uniq *)", "Bash(cut *)",
      "Bash(jq *)", "Bash(sed -n *)", "Bash(tree *)", "Bash(which *)", "Bash(echo *)",
      "Bash(mkdir -p *)",

      "mcp__ccd_session_mgmt__set_session_title"
    ],
    "deny": [
      "Bash(git clean*)", "Bash(git rm -rf*)", "Bash(git filter-branch*)",
      "Bash(git filter-repo*)", "Bash(git gc --prune*)", "Bash(git prune*)",
      "Bash(git reflog expire*)", "Bash(git push --force*)", "Bash(git push -f*)",
      "Bash(git reset --hard*)", "Bash(git branch -D*)",
      "Bash(gh pr edit*)", "Bash(gh issue delete*)", "Bash(gh repo delete*)"
    ]
  }
}
```

## Retouches ailleurs

**Fait** — `~/.claude/settings.json` : `Bash(gh issue close*)` et `Bash(gh pr close*)` retirés du
`deny`. C'était nécessaire, pas cosmétique : le deny utilisateur l'emporte sur l'allow projet,
donc tant qu'ils y étaient le blocage dur persistait quoi qu'on mette dans le dépôt. Le `deny`
utilisateur ne garde plus que `gh pr edit`, `gh issue delete`, `gh repo delete`.

**Fait** — `SPO-WebClient/.claude/settings.local.json` : références mortes supprimées. Les
serveurs MCP `github` et `context7` étaient déclarés dans `enabledMcpjsonServers` alors que
`.mcp.json` ne contient que `playwright`, et la règle `mcp__github__get_issue` autorisait un
outil inexistant (aucune référence à `mcp__github__*` ni `mcp__context7__*` dans le dépôt).
Également retirés : `Bash(gh api graphql -f 'query= *)`, strictement couvert par la règle
`Bash(gh api *)` voisine et de toute façon dépendant d'un guillemet dans la commande, et
`Bash(scripts/board-status.sh 268)`, épinglé sur un numéro de carte ponctuel.

**Reste à faire**

- **`~/.claude/settings.local.json`** : ses 4 règles (`git commit/config/push/remote`) sont des
  écritures isolées, sans les lectures correspondantes. Redondantes pour ce dépôt une fois la
  politique projet en place ; à replier dans `~/.claude/settings.json` ou à supprimer.
- **`~/.claude/settings.json`** ne contient toujours aucune règle `git`. Sans effet ici (le
  projet couvre), mais tout autre dépôt sans politique propre repart de zéro.
- **`Bash(gh api *)`** dans `SPO-WebClient/.claude/settings.local.json` : règle non scopée, elle
  autorise n'importe quelle mutation sur n'importe quel dépôt. Laissée en l'état — la resserrer
  changerait la posture de sécurité du dépôt produit, décision distincte de cet audit.

## GitHub : l'outil natif est `gh`, pas un MCP

- `gh` est authentifié (compte `Crazz-E`, scopes `repo, project, workflow, read:org, gist`) et
  c'est déjà le socle : tout l'orchestrateur l'appelle en `execFile` depuis Node
  (`steps/scripted.js`, `intake.js`, `park-loop.js`, `report-intake.js`). Ces appels-là passent
  **hors de la couche permission de Claude** — le pipeline automatisé n'est jamais bloqué, seules
  les sessions Claude le sont.
- Aucun serveur MCP GitHub n'est configuré (`mcpServers` global vide, pas de `.mcp.json` ici).
  Le connecteur `plugin:engineering:github` exige un OAuth impossible en session
  non-interactive.
- **Ne pas ajouter de MCP GitHub** : il dupliquerait `gh` sans rien apporter et introduirait une
  seconde surface d'authentification. Le manque réel est documentaire, pas outillé — voir le
  `CLAUDE.md` de ce dépôt pour les conventions `gh` qui étaient jusqu'ici re-découvertes à
  chaque session.
