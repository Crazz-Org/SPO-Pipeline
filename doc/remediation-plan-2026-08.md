# Plan de remédiation & optimisation du pipeline — audit 2026-08-30

Produit par l'audit multi-agents du 2026-08-30 : 9 lecteurs-auditeurs par sous-système
(123 findings bruts), 16 vérifications adversariales (11 confirmées, 5 partielles corrigées,
0 réfutée), croisé avec les journaux réels (`journal/`, 15 cartes, 91 appels LLM, $131.60),
puis relu par un panel de 3 critiques (complétude, architecture, design de parallélisation)
dont les corrections sont intégrées ici. Ce document est le **contrat d'exécution** de la
phase de production : un chantier à la fois, testé intégralement avant de passer au suivant.

## Rappel de l'objectif du pipeline

Une carte GitHub entre en `Todo`, en ressort `Done` avec une PR mergée, ou est parkée avec un
motif — sans humain dans la boucle sauf aux points de décision (confirm/discard des rapports,
retry/abandon des parks). Critère de promotion (spec §Shadow mode) : taux de park < 15 % et
coût pondéré par carte mergée sous la baseline (~$12/session de l'ancien driver).

## État des lieux mesuré (journaux réels 2026-08-29/30)

- **Économie** : $131.60 sur 91 appels. PLAN = 52 % ($67.85) dont **$24.4 (36 % de PLAN) de
  re-planification après park** (le retry repart d'INTAKE). **46 % de la dépense totale sur
  les 4 cartes jamais mergées.** Coût par carte mergée ≈ $13.2 (au-dessus de la baseline $12) ;
  merges propres ≈ $7.1. Taux de park cartes : 27 % (cible < 15 %).
- **Latence** : 77.3 h sur 85.5 h de wall-clock = **attente d'une réponse humaine post-park**.
  Temps actif dominé par les steps LLM (IMPLEMENT 3.0 h, PLAN 1.6 h). GATE = ~2.5 min/run
  (0.68 h au total) : **le bench n'est PAS le goulot actuel** — et il a sa propre file
  (`~/.spo-bench/spool` → `running`), donc la sérialisation « one live world » est déjà
  assurée en dehors du pipeline.
- **Vérité des tests** : la suite `node --test` est 100 % hermétique (aucun spawn réel) — 4
  bugs de prod en 48 h l'ont traversée verte (E2BIG #452, deadline-kill #449,
  placeholder #443, head=base #247). Les verdicts VALIDATE réels ont bien piloté les
  transitions, mais ont été rendus **sans leurs intrants déclarés** (`diff.patch`, `gate.log`,
  `gate-report.md` ne sont jamais écrits) ; CITATION_VERIFIER n'a **jamais été exécutable** en
  réel (citations jamais peuplées → park systématique, observé sur issue-385) et **fail-open**
  en cas d'échec d'appel.
- **Journal** : 46 % des lignes du corpus sont du spam `unpark-scan-failed` (polling gh toutes
  les 5 s sans timer ni backoff, panne continue de 2 h 04 du canal retry le 30/08).

## Règles d'exécution des chantiers

1. **Un chantier à la fois.** Le chantier N+1 ne démarre pas tant que le gate de test du
   chantier N n'est pas vert.
2. **Une action = un sous-agent.** Chaque action est spécifiée avec ses fichiers cibles pour
   être exécutable par un sous-agent **Sonnet** sans contexte conversationnel — ses tests font
   partie de l'action. La **vérification** de chaque action (relecture adversariale du diff +
   exécution des tests ciblés) est faite par un sous-agent **Opus**. Le driver (session de
   production) reste l'architecte : il découpe, vérifie les vérifications, tranche les cas
   limites. Les items marqués **DÉCISION** ne se délèguent pas : le driver les instruit et les
   fait trancher par le mainteneur avant de dispatcher la moitié mécanique.
3. **Gate de chantier** : suite replay complète verte (`node --test`) + `daemon.js --dry-run`
   sur une carte synthétique + les vérifications spécifiques listées. Les gates marqués
   *(recette réelle)* exigent une carte réelle supervisée par le mainteneur — le driver
   s'arrête et la demande explicitement. À partir du chantier 3, la recette passe par le
   harnais `spo recette` (action 2.9).
4. **Toute modification de comportement** est répercutée dans `doc/state-machine-spec.md` /
   `orchestrator/README.md` dans la même action — quand une action amende une ligne précise de
   la spec, elle est listée dans sa colonne Fichiers.
5. Commits par action, PR par chantier (`gh api ... -X PATCH` pour éditer une PR, jamais
   `gh pr edit`). Les numéros de ligne du plan datent de l'audit : deux actions touchant la
   même région (ex. 2.7 réécrit la zone comment-scan) se séquencent rebase-aware, le driver
   re-résout les ancres.

---

## Chantier 1 — Vérité des juges (fail-closed + intrants réels)

**Pourquoi d'abord** : tant que DIAGNOSE/VALIDATE jugent sans intrants et que le vérificateur
de citations passe silencieusement sur échec, aucun verdict aval n'est fiable — tout le reste
du plan s'appuie sur ces verdicts.

| # | Action (exécution Sonnet, vérif Opus) | Fichiers |
|---|---|---|
| 1.1 | **Fail-closed CITATION_VERIFIER** : `cv.ok === false` ou `verdict` absent → `ParkSignal('citation-verifier-failed')`, jamais défaut PASS. Couvrir TOUTE la branche (PASS/REJECT/DIVERGES/échec/absence) — zéro test aujourd'hui. | `orchestrator/state-machine.js:421`, `test/` (nouveau) |
| 1.2 | **Peupler `citations`** : `realPushPr` écrit les citations extraites sur `ctx.task.citations` en plus de l'événement `rdo-citation` ; `task-values.js` lit l'événement journal en fallback (survit au restart). Test : carte RDO simulée jusqu'à VALIDATE. | `orchestrator/steps/scripted.js:543`, `orchestrator/task-values.js:136` |
| 1.3 | **Intrants des juges, conditionnels au point d'entrée** : le diff est généré **à l'entrée de DIAGNOSE/VALIDATE** (`git diff origin/main...HEAD` pour le travail commité, `git diff` simple pour le cas pré-commit — DIAGNOSE est atteignable depuis CHECK-fail/empty-implement AVANT tout push, il ne doit jamais parker faute de gate.log dans ces cas ; la spec dit « CHECK Failure → DIAGNOSE, never PARKED »). `gate.log` = **copie de la sortie du dernier run** de GATE (pas `logs/GATE.log`, qui accumule les visites) ; requis seulement en arrivant de GATE. `gate-report.md` depuis `~/.spo-bench/verdicts/<sha>.json` si présent. VALIDATE exige `diff.patch` (toujours disponible post-PUSH_PR) et parke `judge-inputs-missing` sinon. | `orchestrator/steps/scripted.js`, `orchestrator/state-machine.js`, `orchestrator/task-values.js:16-41` |
| 1.4 | **Routage des échecs transport** : dans handlePlan/handleImplement/handleValidate/handleDiagnose, `result.ok === false && (kind === 'error' \|\| timedOut)` → `ParkSignal('llm-transport-failed:<STEP>')` avec le détail — jamais DIAGNOSE, jamais `plan-invalid`/`validate-unrecognized-verdict`. (issue-452 : 3 DIAGNOSE payés $1.75 pour diagnostiquer un E2BIG.) `kind:'limit'` inchangé ici (rotation) — le classifieur lui-même est fiabilisé en 3.5. | `orchestrator/state-machine.js:186,243,427` |
| 1.5 | **Contrat `root_cause: null` honoré** : DIAGNOSE qui répond « pas de nouvelle cause » → `ParkSignal('diagnose-no-new-cause')` au lieu de fabriquer `unspecified-cause-N` et re-payer un IMPLEMENT (observé sur 213/428/452). | `orchestrator/state-machine.js:382` |
| 1.6 | **REJECT threading** : les `reasons`/`findings` d'un REJECT VALIDATE vont au ledger ET au `{{diagnosis}}` du IMPLEMENT suivant (même mécanique que le fix DIAGNOSE→IMPLEMENT existant). | `orchestrator/state-machine.js:432`, `orchestrator/task-values.js` |
| 1.7 | **CI en cours ≠ vert** : `conclusion: null` ou zéro check-run → attente bornée (re-poll ×N avec sleep) puis routage table des causes ; ne plus avancer vers MERGE avec la CI en vol (8/12 événements verts réels avaient `claude review` encore en cours). | `orchestrator/steps/scripted.js:695` |
| 1.8 | **Invariants** — **DÉCISION d'abord** : garder ou retirer la promesse de la spec (§CHECK, vérification par substring des `invariant_ids`, jamais implémentée). Si gardée : définir la cible exacte du scan (diff ? fichiers de test ? sortie de check ?) puis dispatcher la moitié mécanique. Si retirée : amender spec + prompts (plan.md). | `orchestrator/steps/scripted.js:424`, `doc/state-machine-spec.md`, `prompts/plan.md` |

**Gate C1** : replay complet + dry-run + *(recette réelle)* 1 carte S `touchesRdoMembers` avec
**un échec provoqué** (ex. gate fail) pour exercer DIAGNOSE avec ses intrants réels ;
assertions : CITATION_VERIFIER s'exécute réellement, VALIDATE lit `diff.patch`.

---

## Chantier 2 — Robustesse du daemon + harnais live

**Pourquoi avant l'économie** : « chaque step a une deadline » est aujourd'hui faux en réel
(GATE 129–240 s observés au-delà des 120 s « appliqués », un `gh` pendu gèle le daemon à vie
avec le lock) — et le soak non supervisé du chantier 3 n'est pas possible tant que c'est vrai.
Ce chantier construit aussi le harnais de recette réutilisé par tous les suivants.

| # | Action | Fichiers |
|---|---|---|
| 2.1 | **Timeouts réels des steps scripted** : `spawnStep` arme `spawnSync.timeout` par classe de commande (git 120 s, npm ci 600 s, gate 900 s, gh 120 s). **Piège connu** : spawnStep mappe `status:null` → exit 1 — brancher sur `result.signal`/`result.error` AVANT le mapping, sinon un GATE tué par timeout serait lu « gate fail » et paierait un DIAGNOSE (l'anti-pattern que 1.4 élimine). Test real-mode contracté : spawn injecté vérifiant l'option timeout ET le bookkeeping kill→retry-once→park. | `orchestrator/steps/scripted.js:78-101`, `orchestrator/config.js`, `test/` |
| 2.2 | **http.js : fix du hang de troncature** (réponse oversize → destroy sans settle → boucle remote-pull morte en silence). | `orchestrator/http.js:48` |
| 2.3 | **Orphan repark restaure `worktreePath`** depuis le snapshot state.json pour que `preserveWorktreeWip` s'exécute réellement (aujourd'hui no-op garanti — le filet de sweepWorktreeLeftovers au retry suivant reste, mais parke un cycle de plus). | `orchestrator/orphan-scan.js:99` |
| 2.4 | **orphanScan hors --real** : un démarrage `--shadow`/`--dry-run` sur le journal root vivant ne doit plus convertir des orphelins réels en parks sans ancre ni commentaire. | `orchestrator/daemon.js:233`, `orchestrator/orphan-scan.js` |
| 2.5 | **Écritures atomiques** : `state.json` en tmp+rename ; création du lock en write-tmp+link (le contenu vide lisible entre open et write est aujourd'hui balayable comme stale). | `orchestrator/journal.js:34`, `orchestrator/lock.js:78` |
| 2.6 | **Mutex triage** : rename `pending/<f>.json` → `in-progress/` AVANT l'appel LLM (même idiome que takeNextTask) — élimine le double-triage concurrent daemon vs `spo triage` (#443 : filed ET held à 20 s d'écart, PR #447 fermée à la main). | `orchestrator/auto-triage.js:107`, `orchestrator/report-intake.js` |
| 2.7 | **Réécriture unifiée du comment-scan** (unparkScan + reportConfirmScan) : pagination (`per_page=100` + boucle, filtre `id > anchor`), **allowlist d'auteurs** (collaborateurs du repo, lus une fois et cachés — retry/abandon/confirm/discard ne sont plus honorés depuis n'importe quel commentateur), backoff sur échecs consécutifs, timer dédié (60 s). Note : la cadence du timer n'est garantie qu'après C6 (le daemon mono-thread bloque en step) — le gate vérifie le comportement par cycle, pas la cadence. | `orchestrator/park-loop.js:232-266`, `orchestrator/report-intake.js`, `orchestrator/state-machine.js:751` |
| 2.8 | **Priorité des retries** : nommer les fichiers de retry pour qu'ils trient AVANT les cartes fraîches (`0000-retry-…`), conformément au commentaire de park-loop et à la spec (inversion bornée observée : max autoPullLimit cartes). | `orchestrator/park-loop.js:211-220` |
| 2.9 | **`spo recette`** : harnais live supervisé — une carte synthétique triviale end-to-end en `--real` contre une issue de test dédiée, budget cappé, nettoyage automatique, assertions sur le journal produit. Devient le gate réel standard des chantiers 3+. | `bin/spo`, `orchestrator/` (nouveau module), `test/` |

**Gate C2** : replay + chaos tests (kill -9 mi-step, child pendu simulé via spawn injecté,
double démarrage, takeover de lock) + `spo recette` verte.

---

## Chantier 3 — Économie de tokens

**Pourquoi** : 36 % de PLAN re-payé, triage en boucle infinie (2.5 h de sessions de 300 s sur
le rapport #449, jusqu'à épuisement du pool), $12 brûlés sur une carte structurellement
impossible (#428).

| # | Action | Fichiers |
|---|---|---|
| 3.1 | **Reprise après park** : `realWorktree` journalise le **sha `origin/main`** dans un événement lisible (aujourd'hui la sortie de rev-parse est jetée — rien à comparer au retry) ; à l'unpark-retry, si `journal/<id>/scratch/plan-*.md` existe ET que le sha n'a pas bougé, handlePlan court-circuite en re-journalisant les chemins existants — sinon re-PLAN. `reEnqueueTask` ne fait que porter le sha. Économie mesurable : ~$24 sur le corpus. | `orchestrator/steps/scripted.js` (realWorktree), `orchestrator/state-machine.js:181`, `orchestrator/park-loop.js` |
| 3.2 | **Garde fichiers-protégés** : après PLAN, scan de `plan_markdown` (et du criterion à l'intake) pour `.claude/settings.json` / `.claude/hooks/` → `ParkSignal('plan-requires-protected-files')` AVANT de payer IMPLEMENT (CLAUDE.md documente déjà ce mur ; #428 = $12.01). | `orchestrator/state-machine.js` (handlePlan), `orchestrator/intake.js` |
| 3.3 | **Cap + backoff auto-triage** : compteur d'échecs mécaniques par rapport (événement `report-triage-error` journalisé et compté) ; après 3, hold **mécanique distinct** (`report-held-mechanical`, commentaire dédié — pas le texte « reproduction did not confirm ») ; backoff exponentiel entre cycles pour un même rapport. | `orchestrator/auto-triage.js:107-244` |
| 3.4 | **Chemin de reprise d'un held** : `spo triage --retry <issue>` réinjecte un rapport held (mécanique ou do-not-file) dans le circuit — aujourd'hui dead end confirmé. | `orchestrator/auto-triage.js:113`, `bin/spo` |
| 3.5 | **Classifieur `limit` fiable** : `kind:'limit'` seulement sur `api_error_status === 429` ou un `terminal_reason` structuré — plus jamais le substring `/limit\|overloaded\|rate/i` sur le texte libre (un message contenant « rate » re-paie le step complet sur CHAQUE compte puis refroidit tout le pool 1 h). Acter la durée de cooldown par défaut (le `retryAfterMs` du CLI n'existe pas — le hint est du code mort) : la caler sur les fenêtres réelles observées (session 5 h). | `orchestrator/steps/llm.js:146`, `orchestrator/accounts.js` |
| 3.6 | **Intake = mêmes règles que le daemon** : rotation de comptes + `markLimit` sur `kind:'limit'` (draftCard/reviewCard/triageBugReport re-picken aujourd'hui le même compte rate-limité chaque cycle). S'appuie sur 3.5. | `orchestrator/intake.js:111,628-661` |
| 3.7 | **Budgets `--max-budget-usd`** — **DÉCISION d'abord** : leur retrait est une décision mainteneur enregistrée (step-contracts.js:34, « Claude Max, pas de risque de dépassement ») que l'audit propose de renverser au titre du garde-fou anti-runaway (IMPLEMENT $5.06/134 turns observé). Si rétablis : calibrage p95 (PLAN $6, IMPLEMENT $8, juges $3, intake $3) + park reason **distinct** `step-budget-exceeded` (après 1.4, un budget-kill parkerait sinon en `llm-transport-failed`, sémantiquement faux). Si maintenu tel quel : aligner spec/config/README qui promettent tous des caps inexistants. | `orchestrator/step-contracts.js:34-55`, `doc/state-machine-spec.md`, `orchestrator/config.js:261` |

**Gate C3** : replay + scénario de reprise simulé (park→retry sans re-PLAN) + **soak 24 h non
supervisé** (possible : C2 a rendu le daemon insensible aux hangs) en observant `spo cost` et
l'absence de spam journal.

---

## Chantier 4 — Boucles de remédiation correctes (main-moved, CI, transients)

**Pourquoi** : le chemin main-moved — 4/16 sessions mesurées en avaient besoin — est un piège
déterministe confirmé (park PUSH_PR puis boucle `branch-unmerged-leftover` au retry), et 77 h
d'attente humaine incluent des parks purement transients.

| # | Action | Fichiers |
|---|---|---|
| 4.1 | **Fix du piège PUSH_PR post-merge** : commit exit≠0 + arbre propre (`git status --porcelain` vide) + `HEAD != origin/main` → skip commit, continuer vers push (le merge commit de CI_CHECKS existe déjà). Garde le park pour le cas historique HEAD==origin/main (empty implement, issues 213/247/385). Corrige aussi la boucle `branch-unmerged-leftover` au retry (le merge local jamais poussé n'est couvert par aucune règle du sweep). | `orchestrator/steps/scripted.js:505-520` |
| 4.2 | **GATE-fail sur main bougé** : **pré-vérif d'abord** — le bench écrit-il `verdicts/<sha>.json` (avec `baseMain`) pour un run en ÉCHEC ? Sinon dériver baseMain du sha `origin/main` journalisé par 3.1. Puis : avant de router exit 1 vers DIAGNOSE, tester l'intersection main-moved (même logique que CI_CHECKS) ; si main a bougé → merge→CHECK directement, sans consommer le budget diagnose (issue-439 : budget épuisé sur un conflit qu'IMPLEMENT ne peut structurellement pas résoudre — confirmé). Amender la ligne CI_CHECKS de la spec. | `orchestrator/steps/scripted.js:644-655` (réutilise `:705-744`), `doc/state-machine-spec.md` (row GATE/CI_CHECKS) |
| 4.3 | **Table des causes CI alignée** sur les vrais noms de checks du repo produit + compteur de budget pour les retours IMPLEMENT via CI (aujourd'hui gratuits et sans ligne de ledger). | `orchestrator/ci-cause-table.js`, `orchestrator/state-machine.js` |
| 4.4 | **Auto-retry des parks transients** : `claim-rate-limited`, push/fetch réseau → N retries espacés (backoff journalisé) avant park terminal — réduit l'attente humaine sans élargir le catch-all (liste blanche de motifs, pas de retry générique). Amender spec Principes 2/5 (le catch-all reste la politique d'erreur ; ceci est une liste blanche explicite). | `orchestrator/steps/scripted.js:415`, `orchestrator/state-machine.js` (finalizePark), `doc/state-machine-spec.md` (Principes 2/5) |
| 4.5 | **ABANDONED complet** : cleanup (worktree remove, branche locale+remote, close PR ouverte), état visible dans `spo status`/`spo parked`/dashboard (aujourd'hui invisible ou compté PARKED partout ; worktree #443 qui fuit). | `orchestrator/park-loop.js`, `bin/spo:192-206`, `console/collect.js` |

**Gate C4** : replay (scénarios main-moved ×2, transients) + *(recette réelle via 2.9)* 1 carte
avec main-moved provoqué (merger une PR triviale pendant que la carte est au GATE).

---

## Chantier 5 — Kanban & observabilité fidèles

**Pourquoi** : le mainteneur pilote depuis le board et les commentaires d'issue ; chaque écart
board/réalité coûte une intervention humaine (le vrai goulot mesuré).

| # | Action | Fichiers |
|---|---|---|
| 5.1 | **Moves board manquants** : park pré-worktree via `gh api graphql` direct (mutation `updateProjectV2ItemFieldValue`, ids dans `doc/board-audit.md` — pas besoin de cwd produit) ; activité DIAGNOSE signalée (commentaire « diagnosing, attempt N/3 » ou colonne dédiée — décision driver) ; suppression des moves redondants à chaque retry IMPLEMENT. | `orchestrator/board.js`, `orchestrator/state-machine.js:239` |
| 5.2 | **Coût et durée sur la carte** : commentaire final Done enrichi (coût total, durée, nb tentatives — le coût est déjà sommé à FINISH) ; commentaire de park avec coût cumulé + historique des tentatives. | `orchestrator/steps/scripted.js:789`, `orchestrator/park-loop.js` (buildParkComment) |
| 5.3 | **PASS_WITH_FINDINGS routés** : les findings du validateur créent un commentaire structuré sur la PR (et optionnellement un brouillon de carte de suivi) au lieu d'être journalisés puis perdus. Idem verdict DIVERGES du citation-verifier. | `orchestrator/state-machine.js:429` |
| 5.4 | **`spo status` conforme à la spec** : profondeur file bench (`~/.spo-bench/spool`), santé des comptes + cooldowns, dépense du jour ; `llm-call` events enrichis de `duration_s`. | `bin/spo:192`, `orchestrator/steps/llm.js:518` |
| 5.5 | **Dashboard** : KPI semaine cohérent, timestamps de génération, exclusion des tâches synthétiques des stats all-time. | `console/collect.js:263`, `console/render.js:750` |

**Gate C5** : replay + *(recette réelle via 2.9)* en suivant le board à chaque transition —
zéro écart board/journal toléré sur le happy path.

---

## Chantier 6 — Parallélisation pipelinée (K workers, entonnoir bench)

**Pourquoi en avant-dernier** : gros refactor — il doit atterrir sur une base stabilisée
(C1–C4) et observable (C5). **Analyse de l'entonnoir** : le bench sérialise déjà lui-même
(file spool/running, `bench-submit --wait`) ; à ~2.5 min par gate contre 30–45 min de travail
LLM par carte, K=3 workers visent ~3× le débit — **minoré par le churn de re-gate** : chaque
FINISH peut renvoyer jusqu'à K−1 cartes en vol vers CHECK→GATE (voir 6.5). Le facteur
limitant devient le pool de comptes (K ≤ comptes sains, dynamique).

**Choix d'architecture acté (panel)** : **processus workers**, PAS de refactor async global.
`spawnSync` reste DANS les workers (la doctrine spawnSync-timeout de llm.js — « un race async
abandonne le perdant, laissant un `claude -p` orphelin qui dépense » — reste valide) ; le
starving de timers ne frappe que le dispatcher, qui n'exécute plus aucun step. Un bug de
handler crashe UN worker, pas K tâches (doctrine « a bug crashes the daemon loudly »
préservée). Les actions 6.5–6.7 sont des **conséquences de design** de la parallélisation
(spec §Account pool + invariant one-re-merge), pas des remédiations de défauts observés :
leurs valeurs par défaut (ex. compteur 2) sont des réglages à ajuster, sans preuve journal.

| # | Action (ordre d'exécution impératif) | Fichiers |
|---|---|---|
| 6.1 | **Mode worker + doctrine de crash** : `daemon.js --worker <taskDir>` exécute UNE tâche (runTask) et sort. `state.json.owner` devient `{host, workerPid, workerStartedAt}` (startedAt désambiguïse la réutilisation de pid). Worker crashé avec dispatcher vivant → le handler d'exit du dispatcher est autoritaire et reparke (`worker-crashed`, exit code en détail) ; l'orphanScan périodique SAUTE toute tâche dans la table des workers vivants (sinon double-repark). Dispatcher crashé → les workers meurent avec lui (systemd `KillMode=control-group`, défaut) et l'orphanScan du redémarrage les récupère. Chaque worker dans son propre **process group** (kill(-pid) emporte le child `claude` — un worker tué n'orphelise pas un appel qui dépense). Circuit-breaker : N crashs de workers consécutifs → le dispatcher sort non-zéro (un bug de state machine reste bruyant, pas un tapis de reparks). | `orchestrator/daemon.js`, `orchestrator/orphan-scan.js`, `orchestrator/state-machine.js` (snapshot) |
| 6.2 | **Leases de comptes + état pool atomique** : fichiers de lease par compte sous le pool (`{pid, startedAt}`, balayés par le même idiome pid-liveness que lock.js) ; `pick()` exclut les comptes leasés par un autre pid vivant ; cooldowns en écriture atomique (fichier par compte, ou tmp+rename+merge — `markLimit` est aujourd'hui un read-modify-write non verrouillé qui perd des cooldowns concurrents). Rotation mi-tâche : le worker prend un lease sur le compte suivant sain non leasé, parke `all-accounts-cooling` seulement si aucun. Cooldowns restent globaux au pool (une limite est par compte, pas par worker). Le dispatcher re-vérifie K ≤ comptes sains avant CHAQUE spawn. | `orchestrator/accounts.js:183-232`, `orchestrator/state-machine.js:82-114` |
| 6.3 | **Dispatcher** : boucle principale — prend jusqu'à K tâches, spawn les workers (async `spawn` simple côté dispatcher, pas de wrapper généralisé), attend leurs sorties ; lock unique conservé au dispatcher ; ses propres appels courts (auto-pull, scans) restent spawnSync. **Politique daemon.jsonl multi-process actée et documentée** : soit lignes petites en O_APPEND (le détail de park reste `{id, reason, lastState}`), soit événements remontés par l'exit summary des workers et écrits par le seul dispatcher — choisir. **Invariant taskDir single-writer écrit noir sur blanc** : les scanners côté dispatcher ne touchent qu'un taskDir terminal ou à owner mort (la table des workers vivants l'impose). Événements `worker-spawn`/`worker-exit` journalisés. | `orchestrator/daemon.js`, `orchestrator/state-machine.js` (drainQueueOnce parallèle), `orchestrator/journal.js` |
| 6.4 | **Mutex du repo produit** : sérialiser les phases WORKTREE-setup (fetch, worktree add/prune, branch -D, npm ci) et FINISH-teardown (worktree remove) via un lockfile borné (idiome `wx` de lock.js) — K fetchs/mutations worktree concurrents sur le même clone contendent sur les locks `.git` (FETCH_HEAD, packed-refs, .git/worktrees) et parkeraient en `worktree-fetch-failed`/`worktree-add-failed` spurieux ; K `npm ci` simultanés saturent disque/CPU. | `orchestrator/steps/scripted.js:361-418,833-841`, `orchestrator/lock.js` (réutilisé) |
| 6.5 | **Politique main-moved & merge multi-cartes** : `mainMoveUsed` → compteur configurable (défaut 2, réglage sans preuve journal) avec re-gate ; timeout GATE couvrant l'attente de file bench (K×durée — ou faire remonter la position de file par bench-submit pour armer la deadline au run, pas au submit). **DÉCISION à acter** : la merge queue GitHub sérialise l'atterrissage, PAS la sémantique — deux cartes aux fichiers disjoints mais interagissant comportementalement peuvent merger sans re-gate croisé (le test main-moved est une intersection de fichiers). Options : accepter explicitement (backstop = nightly) OU token d'admission MERGE au dispatcher (une carte entre CI_CHECKS-vert et FINISH à la fois). Amender la spec (« once; a second move → PARKED », row CI_CHECKS). | `orchestrator/state-machine.js:362`, `orchestrator/config.js`, `doc/state-machine-spec.md` (row CI_CHECKS) |
| 6.6 | **Intake/auto-pull adaptés** : invariant explicite « en-vol + en-file ≤ K » (l'auto-pull remplit jusqu'au watermark — l'ancien sens d'autoPullLimit reposait sur le drain awaité, qui disparaît) ; `makeTask` vérifie `journal/` AVANT `queue/` (ferme la fenêtre de double-enqueue) ; le dispatcher ne démarre jamais un fichier de queue dont l'id correspond à un worker vivant. | `orchestrator/config.js:117-128`, `orchestrator/intake.js:852`, `orchestrator/auto-pull.js`, `orchestrator/daemon.js` |
| 6.7 | **Observabilité workers** : `spo status` liste les workers (tâche, état, compte, durée) ; dashboard adapté. | `bin/spo`, `console/collect.js` |

**Gate C6** : le **dispatcher lui-même** en `--dry-run` K=3 sur UN journal root avec 3 cartes
synthétiques (1 seul lock, 3 worker exits, zéro écriture croisée de taskDir) + shadow K=3 avec
**1 seul compte sain** (les workers excédentaires attendent ou parkent, ne partagent jamais un
compte) + *(recette réelle via 2.9)* batch de 2 cartes S en parallèle supervisé.

---

## Chantier 7 — Consolidation véracité & doc

| # | Action | Fichiers |
|---|---|---|
| 7.1 | **Trous replay comblés** : exits shadow jamais forcés (worktree/check/pushPr/prMergeEnqueue/finish, prWait 1), legs d'erreur real-mode (fetch/rev-parse/npm-ci, add/commit/diff/patch, check-runs, merge enqueue, issue-comment/worktree-remove), branche oauthTokenFile, catch-alls runTask (invalid-task-json, runaway), assertion des reasons de park de l'account-rotation. | `test/` |
| 7.2 | **Bibliothèque de scénarios `spo recette`** : étendre le harnais 2.9 aux scénarios K>1 et main-moved (les recettes ad-hoc de C4/C6 deviennent des scénarios rejouables). | `bin/spo`, `orchestrator/` |
| 7.3 | **Tests de concurrence** : timers de runForever sous drain long, double-daemon, daemon+CLI simultanés (le seam exact du bug #443). | `test/` |
| 7.4 | **Comptabilité des appels tués** : un appel deadline-killed/E2BIG journalise `costUnknown: true` au lieu de `costUsd: 0` (le métrique d'efficacité vs baseline est aujourd'hui biaisé vers le bas). | `orchestrator/steps/llm.js:237`, `orchestrator/cost.js` |
| 7.5 | **Purge doc finale** : incohérences restantes (mention Bash de verify-citations.md, promesse plan-probe de plan.md, drift prompts/README.md, budget caps selon la décision 3.7, spec §CHECK selon la décision 1.8). | `prompts/`, `doc/` |

**Gate C7** : suite complète verte + `spo recette` (tous scénarios) + relecture Opus de la spec
mise à jour contre le code (zéro divergence non commentée).

---

## Findings notables volontairement NON traités (décisions à acter)

- **Préambule ~40k tokens de PLAN/IMPLEMENT** (CLAUDE.md produit non trimmé malgré la spec) :
  levier réel mais côté SPO-WebClient (trim du CLAUDE.md ou variante lean pour le pipeline) —
  à traiter comme carte produit, pas ici. Mesurer d'abord la part réelle via `duration_s` +
  coûts post-C5.
- **Claim-lost de minuit** : déjà corrigé côté SPO-WebClient (PR #451) — vérifié.
- **cwd des juges** (ils paient le CLAUDE.md pipeline avec les conventions `gh` inutiles) :
  marginal une fois 1.3 en place (les juges lisent leurs intrants, pas le repo) ; réévaluer
  après mesure.
- **Choix Fable vs Opus pour DIAGNOSE** : mémoire du projet — les diagnostics Fable ont déjà
  produit des parks à re-vérifier avec Opus. Le plan garde Fable (spec) ; si les parks
  `diagnose-*` restent > 10 % post-C1, escalader DIAGNOSE attempt-3 vers Opus (décision
  mainteneur).
- **Parks board-only pré-worktree** (carte restée en Todo) : comportement documenté « board
  best-effort » — corrigé quand même en 5.1 car peu coûteux, mais jamais bloquant.
