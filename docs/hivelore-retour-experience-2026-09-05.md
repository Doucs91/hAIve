# Hivelore — septième retour d'expérience

**Date** : 2026-09-05
**Auteur** : agent Claude Code (Fable 5.1), en rôle de revue et de rédaction des fiches ; un second agent (Opus 5) a implémenté à partir de ces fiches
**Dépôt** : `mirrobook` — monorepo Spring Boot 4.1 + React 19
**Version** : `hivelore` 0.61.0, posture `strict`, autopilot ON, hooks git `pre-commit` + `pre-push` + `post-merge`, hooks Claude Code `SessionStart` + `PreToolUse` + `PostToolUse` + `SessionEnd`
**Assiette** : 2 jours (2026-09-04 → 2026-09-05), 20 PR fusionnées (#60 → #79), 3 sessions d'agents, 44 mémoires, 16 capteurs, 92 appels MCP cumulés depuis le 27 août

Ce rapport ne répète pas les six précédents. Il fait trois choses : dire ce qui a été corrigé depuis le 2026-09-04 (il y a des corrections, et elles sont bonnes), documenter **un défaut nouveau qui invalide une garantie affichée**, et mesurer ce qui n'avait jamais été mesuré — le coût des hooks par appel d'outil et le taux réel de déclenchement des capteurs. Tout est reproductible, commandes en annexe.

---

## 1. Ce qui a été corrigé depuis le rapport du 2026-09-04

À noter d'abord, parce que c'est rare qu'un rapport de friction produise des correctifs en 24 heures.

| Signalé le 09-04 | État le 09-05 | Preuve |
|---|---|---|
| Fil d'Ariane de `CLAUDE.md` = `ls \| sort \| head -8` (que des mémoires du jour 1) | **Corrigé.** Le bloc liste désormais l'`attempt` en premier, puis les décisions et architectures par date décroissante | `CLAUDE.md` lignes 40–47 après `bridges sync` |
| Motifs regex complets dans `CLAUDE.md` (63 % du budget) | **Corrigé.** Zéro ligne `Pattern:` dans le bloc capteurs | `grep -c 'Pattern:' CLAUDE.md` → 0 |
| Capteurs sans périmètre lexical (bloquent un contre-exemple cité en commentaire) | **Corrigé.** `bg-emerald-600` entre backticks dans un commentaire `//` : silencieux. `LocalDate.now()` dans un commentaire `/* */` de test : silencieux | §A.3 en annexe |
| Aucune échappatoire locale sur un faux positif | **Corrigé.** `// hivelore:allow <id> — raison` documenté dans `CLAUDE.md` | `CLAUDE.md` lignes 59–61 |
| Score « knowledge-layer health 0 % » non actionnable | **Remplacé.** `hivelore doctor` donne quatre axes (`protection=96 context=100 corpus=100 harness-coverage=27%`) et trois commandes concrètes | §A.7 |

Quatre des six priorités du rapport précédent sont traitées. Les deux qui restent sont le blocage de `finish` sur l'état de la CI (§7) et le `code-map.json` suivi par git (§5). Elles sont reprises ci-dessous parce qu'elles ont coûté du temps réel cette semaine encore.

---

## 2. Le constat central : `hivelore enforce check` dit « gate passed » sans évaluer les capteurs

C'est le défaut le plus grave de ce rapport, parce qu'il transforme une vérification en fausse assurance.

**Le protocole.** `CLAUDE.md` demande, avant toute réponse finale : « run `hivelore enforce check`; fix anything it blocks before reporting done ». Les deux agents l'ont fait à chaque PR. Douze PR sur vingt portent dans leur description la ligne « `hivelore enforce check` : 0 problème ✅ ».

**Le test.** J'ai ajouté à un fichier suivi de `frontend/src/` une ligne qui viole un capteur bloquant (`['b', 'a'].sort()` sans comparateur — capteur `2026-08-28-gotcha-tri-de-chaines-sans-localecompare`), je l'ai indexée, puis :

```
$ hivelore enforce check
✓ Hivelore gate passed — 6 check(s), 0 issue(s).

$ hivelore sensors check
Hivelore sensors check — 1 hit(s), 16 regex + 0 ast + 0 command sensor(s)
  ✗ 2026-08-28-gotcha-tri-de-chaines-sans-localecompare (block)

$ hivelore enforce check --stage pre-commit
✗ Hivelore enforcement gate failed.
```

**L'explication est dans la sortie JSON, et seulement là** :

```
"code": "antipattern-gate-deferred",
"message": "Anti-pattern + sensor diff scan is NOT evaluated in --stage local (this is a preview).
            It runs in the installed git hook (--stage pre-commit) and in CI (--stage ci)."
```

La sortie humaine par défaut n'affiche pas cette ligne. Elle affiche « ✓ gate passed ». Un agent qui suit le protocole écrit à la lettre obtient donc un vert qui ne couvre pas la seule vérification différenciante du produit, et le rapporte comme une garantie.

**Ce qui a sauvé la mise** : le hook `pre-commit` installé par Hivelore, lui, tourne bien en `--stage pre-commit`. Aucune violation n'est passée. Mais la garantie *rapportée* dans douze descriptions de PR était fausse, et personne — ni les agents, ni le développeur qui lit ces PR — ne pouvait le savoir.

**Trois corrections, du moins au plus coûteux :**

1. **Afficher la ligne de report dans la sortie humaine**, en `⚠`, pas seulement en JSON. Une ligne.
2. **Quand un diff est indexé, faire de `pre-commit` le stage par défaut.** Un « aperçu » qui saute le scan n'a d'intérêt que sans diff.
3. **Ne jamais écrire « gate passed » quand une vérification a été sautée.** « 5 checks passed, 1 deferred » est exact ; « gate passed » ne l'est pas.

Et corriger la phrase de `CLAUDE.md` que Hivelore génère lui-même : elle doit dire `hivelore enforce check --stage pre-commit`, ou renvoyer à `hivelore sensors check`.

---

## 3. Le coût des hooks Claude Code : 4,5 secondes par appel d'outil

Jamais mesuré avant. Les hooks installés dans `.claude/settings.local.json` :

| Événement | Filtre | Commande | Latence mesurée |
|---|---|---|---|
| `PreToolUse` | `Edit\|Write\|MultiEdit\|NotebookEdit\|Bash` | `hivelore enforce pre-tool-use` | **2,25 s** |
| `PostToolUse` | `Edit\|Write\|Bash` | `hivelore observe` | **2,24 s** |
| `SessionStart` | — | `hivelore enforce session-start` | une fois |
| `SessionEnd` | — | `hivelore session end --quiet --auto` | une fois |

Mesuré sur une entrée triviale (`{"tool_name":"Bash","tool_input":{"command":"ls"}}`) : `user 0,29 s`, `real 2,25 s`. Le temps n'est pas du calcul, c'est du démarrage Node et du chargement de corpus, deux fois par appel.

**Chaque `Edit`, `Write` ou `Bash` paie 4,5 secondes de Hivelore.** Une session de travail ordinaire fait deux à trois cents appels d'outils : c'est **quinze à vingt minutes d'attente par session**, réparties en morceaux de deux secondes que personne ne remarque individuellement. Sur les deux jours de l'assiette, avec trois agents, c'est de l'ordre d'une heure.

En contrepartie, sur ces deux jours, `pre-tool-use` n'a rien bloqué ni rien affiché, et `observe` n'a produit aucune mémoire (§8). Le rapport coût/recette de ces deux hooks est, sur cette assiette, de deux secondes par appel contre zéro.

**Corrections, par ordre de rendement :**

1. **Retirer `Bash` du filtre.** `ls`, `git status`, `pnpm test` n'ont rien à faire vérifier avant exécution. Ça divise le coût par deux ou trois immédiatement.
2. **Un processus résident** (socket Unix, ou le serveur MCP déjà lancé) pour que le hook soit un `curl` de 20 ms et non un démarrage Node de 2 s.
3. **Rendre `observe` conditionnel** : ne s'exécuter que si le fichier touché est sous un `applies to:` connu. Aujourd'hui il tourne sur tout.

---

## 4. Le recap de session affiché en tête de chaque session est faux depuis huit jours

Ce que le hook `SessionStart` a affiché au début de chacune de mes sessions, le 4 et le 5 septembre :

```
## Last session
_Fermer les deux verrous d'avant-lancement : brancher Stripe pour de bon […]_
**Décisions en attente du développeur :**
- **Le nom.** « Barber » exclut les salons pour femmes […] `coifbook.com`, `coifly.com`…
```

Le nom a été tranché le 2026-09-01 (`MirroBook`, PR #48). Stripe est branché depuis le 09-01. Entre ce recap et ma session, il y a eu **onze lots, trente PR, un renommage complet du produit**. La mémoire porte `created_at: 2026-08-27`, `revision_count: 12`, `verified_at: 2026-09-01`. Le dernier `mem_session_end` date du 09-01. Depuis, un hook `SessionEnd` (`session end --quiet --auto`) est installé et tourne — la mémoire n'a pas bougé.

Donc soit `--auto` n'écrit rien, soit il écrit ailleurs que là où `session-start` lit. Dans les deux cas : **la première chose qu'un agent lit en ouvrant le dépôt est un état du projet vieux de huit jours, présenté sans date.** Ce n'est pas neutre : un agent moins prudent aurait rouvert la question du nom.

**Corrections :**

1. **Dater le recap dans l'affichage** (« Last session — 2026-08-27, 30 commits ago ») et **l'expirer** : au-delà de N commits sur la branche, remplacer par « no recent recap ; last activity: <git log -1> ». Mieux vaut rien qu'un faux.
2. **Faire fonctionner `--auto`** ou le retirer : un hook qui ne fait rien en silence est pire qu'un hook absent, parce qu'il fait croire que c'est couvert.
3. **Recap dérivé de git par défaut** : les cinq derniers sujets de commit et les PR fusionnées depuis le dernier recap sont toujours vrais, gratuits, et suffisent comme filet.

---

## 5. `code-map.json` : quarante commits sur quatre-vingt-huit, huit `git stash` dans la journée

Récidive du 09-04, avec des chiffres.

- `.ai/code-map.json` : 163 Ko, **suivi par git**, réécrit par `sync` (hook `post-merge`) et par `autoRepair.codeMap` (serveur MCP).
- **40 des 88 commits du dépôt le modifient.** Trois PR de l'agent d'implémentation, qui n'a jamais appelé `code_map`, portent des diffs de 105, 75 et 25 lignes sur ce fichier au milieu de changements sans rapport (#74, #76, #79).
- Dans ma session, **huit fois** j'ai dû `git stash` ou `git checkout .ai/code-map.json` pour changer de branche, parce que le fichier était modifié sur le disque sans que je l'aie touché. Deux fois, cinq fichiers de passerelle (`AGENTS.md`, `GEMINI.md`, `.cursor/rules/…`, `.github/copilot-instructions.md`, `CLAUDE.md`) étaient modifiés en même temps.
- `hivelore stats` : **0 appel** à `code_map` et `code_search` sur 92, depuis le 27 août. `.ai/.cache` pèse 11 Mo (ignoré, c'est bien).

La recommandation du 09-04 tient : `code-map.json` n'a pas de lecteur. S'il doit exister pour `doctor` (qui l'utilise pour `harness-coverage`), il doit vivre dans `.ai/.cache`, pas dans l'arbre git. Idem pour les passerelles autres que celle de l'agent réellement utilisé : `hivelore agent` sait lequel c'est.

---

## 6. Les workflows GitHub : cinq jobs par PR, dont un qui ne dit rien

Le 2026-09-05, **tous les jobs du compte se sont arrêtés** : « The job was not started because an Actions budget is preventing further use ». Le quota de 2 000 minutes du forfait gratuit était consommé. Ce n'est pas la faute de Hivelore, mais Hivelore en est une part mesurable : **cinq jobs par PR** (`hivelore-enforcement`, `pr-memory-check`, `pr-stale-check`, `pr-eval-gate`, `sync-on-merge`), chacun avec `npm install -g @hivelore/cli` à froid, sur vingt PR en deux jours.

Parmi eux, **`pr-eval-gate` a tourné vingt fois pour dire vingt fois la même chose** :

```
✓ Recorded eval score 100/100 to history.
ℹ No baseline at .ai/eval/baseline.json — regression gate skipped.
⚠ All 42 case(s) are self-synthesized from your own memories (self-referential).
```

Un score de 100 sur des cas générés depuis les mémoires qu'il évalue, sans base de comparaison, avec une porte de régression désactivée. Ce job n'a jamais pu échouer. Il devrait être **désactivé par défaut tant qu'il n'y a ni `spec.json` ni `baseline.json`**, et le dire une fois plutôt qu'à chaque PR.

`pr-memory-check`, lui, a deux régimes. Sur les PR de code (#68, neuf mémoires pour huit fichiers ; #75, cinq mémoires dont la décision E.164 pour `PhoneField.tsx`), il est pertinent. Sur les PR de documentation, **cinq commentaires sur neuf** remontent la même mémoire (`Decision Roadmap Boucle De Reservation Dabord`) parce que `docs/roadmap.md` est touché — c'est du bruit certain. Une ligne suffit : ne pas commenter quand la seule mémoire remontée est ancrée sur un fichier `docs/`.

---

## 7. `enforce finish` : toujours bloqué par la CI, et cette fois par la facturation

Récidive, position inchangée depuis deux rapports. Cette semaine :

- Six fois, `finish` a refusé de conclure sur `github-actions-pending` parce que **le workflow SonarQube** — qui n'est pas un statut requis de la branche — tournait encore. Attente de 5 à 12 minutes à chaque fois.
- Le 09-05, avec le quota Actions épuisé, `finish` aurait renvoyé `github-actions-failed` sur une PR dont build, 542 tests et gate Hivelore passaient en local.

`--wait` existe, c'est bien. Mais le fond reste : **un outil de connaissance qui refuse de dire « fini » parce qu'un tiers a une panne de facturation dépasse son mandat.** La proposition du 09-04 tient : bloquer sur le corpus, avertir sur l'hygiène git, ignorer l'état de l'infrastructure — ou au minimum ne regarder que les statuts *requis* de la branche.

---

## 8. Capteurs : seize posés, six déclenchements réels en neuf jours, zéro depuis le 2 septembre

Le registre `.ai/.runtime/enforcement/sensor-ledger.ndjson` a 772 lignes. Décompte exact :

| Stage | Lignes | Dont `fired` |
|---|---|---|
| `pre-commit` | 752 | 5 (+1 de mon test §2) |
| `ci` | 13 | 1 |
| `manual` | 7 | 0 (+1 de mon test) |

**Six déclenchements réels** en neuf jours, tous entre le 27 août et le 2 septembre. **Aucun** pendant les vingt PR de l'assiette, produites par trois agents. Deux lectures possibles, et les deux sont probablement vraies : les règles sont intégrées (je les ai lues dans `CLAUDE.md` et j'ai écrit `LocalDate.now(zone)` et `sort((a,b) => a.localeCompare(b, lang))` sans y penser), et les seize capteurs couvrent les erreurs des deux premières semaines, pas celles des suivantes.

Ce qui a attrapé des défauts réels pendant l'assiette, ce n'est pas un capteur : c'est **SonarQube** (constantes d'énumération en minuscules, `role="status"` sur un `<p>`) et **la revue humaine du code** (la vitrine réattribuée à tort par `handOverPrimary`, #69). Aucun des trois n'est exprimable en regex, et c'est normal. Mais cela situe les capteurs : ils gardent des règles *connues*, ils ne trouvent pas de bugs.

Le bloc capteurs occupe encore **53 % de `CLAUDE.md`** (6 164 octets sur 11 651). Sans les regex, c'est du texte utile — c'est là que j'ai lu les règles. Mais seize paragraphes sur des pièges de la semaine 1 pèsent sur le budget de contexte de chaque session pour toujours. Un capteur qui n'a pas tiré depuis trente jours pourrait descendre dans un bloc replié, ou n'apparaître que via `applies to:` quand le fichier est touché.

---

## 9. La capture de connaissance s'est arrêtée au moment où le projet avançait le plus vite

`hivelore stats` sur trente jours : `mem_save` 36 appels, dernier le **2026-09-04 à 00:59**. `mem_tried` : 1 appel, le 30 août. `propose_sensor` : dernier le 1er septembre.

Pendant l'assiette — vingt PR, trois agents, deux jours — **aucune mémoire n'a été écrite**, par personne. Ni par moi (revue et fiches), ni par l'agent d'implémentation, ni par `observe` qui a pourtant tourné plusieurs centaines de fois, ni par `session end --auto`.

Ce n'est pas que rien n'a été appris. La revue de #68 a produit une leçon explicite (« quand une méthode répare un état, écrire le test du cas où il n'y a rien à réparer »), la fiche 07 une décision de design (deux couleurs, deux rôles, liste fermée d'emplacements), la fiche 05 une règle d'infrastructure (deux formes d'URL coexistent en base). **Tout cela a été écrit — dans `docs/travaux/*.md`**, un dossier de fiches de travail créé pendant l'assiette parce que c'était le moyen le plus simple de transmettre une tâche à un agent moins cher. Ces fiches portent le pourquoi, les décisions, les pièges, la revue. C'est exactement ce que le corpus Hivelore est censé contenir, et Hivelore ne les voit pas : `get_briefing` n'en a remonté aucune, `briefingExcludeTags` contient `roadmap`.

Le constat est inconfortable : **quand le protocole d'écriture repose sur la bonne volonté de l'agent (`mem_save`, `mem_tried`, `post_task`), il cesse d'être suivi dès que l'agent a une charge de travail réelle.** Les 36 `mem_save` du corpus viennent de sessions où l'agent avait le temps d'être consciencieux. Les vingt PR de cette semaine n'en ont pas laissé.

**Ce qui marcherait** : dériver les mémoires de ce que les agents écrivent *de toute façon* — descriptions de PR, messages de commit, fiches de travail. Une PR fusionnée dont la description contient « Décision », « Piège », « Leçon », « Ne pas » est une mémoire candidate ; `sync-on-merge` est déjà au bon endroit pour la proposer. Et `observe` a une meilleure raison d'exister s'il indexe les `docs/*.md` touchés que s'il regarde passer des `ls`.

---

## 10. `get_briefing` : la pertinence sémantique perd contre l'ancrage par fichier

Trois appels dans l'assiette. Le classement remonté :

| Tâche | Marqué `must_read` | Réellement utile |
|---|---|---|
| Configurer SMTP Hostinger (`application.yml`, `EmailNotificationSender`) | « ports locaux non standards », « colonnes TIME décalées par JDBC » | « notifications : la base fait autorité, Redis n'est qu'un signal » — classé `useful`, troisième |
| Rappel à 2 h (`AppointmentNotifications`, `application.yml`) | les deux mêmes | la même, encore troisième |
| Corrections UX (`PublicBarberPage`, `PhoneField`, `HomePage`) | « vérifier une page dans un vrai navigateur », « téléphone E.164 » | les deux — **la première n'avait jamais été lue** (`read_count: 0`) et m'a donné la méthode que j'ai utilisée |

Le mécanisme se voit : une mémoire ancrée sur `application.yml` est `must_read` dès que ce fichier est dans la liste, quel que soit le sujet. `application.yml` ancre trois mémoires ; toute tâche qui le touche reçoit les trois en tête. Le score sémantique, lui, était juste les trois fois — la mémoire pertinente avait le meilleur score, et le meilleur `why` (« Literal task match score=0.57 »), mais un rang inférieur.

**Correction** : pondérer l'ancrage par la spécificité du fichier (un fichier ancré par N mémoires donne 1/N à chacune), et n'attribuer `must_read` qu'à la conjonction ancrage + sémantique au-dessus d'un seuil. Le troisième appel montre que la sémantique fonctionne quand l'ancrage ne l'écrase pas.

Budget : preset `quick` = 2 918 tokens, dont 1 072 pour `project-context.md` tronqué, envoyé aux trois appels malgré `dedupe_project_context`. La troncature tombe au milieu du lot 5 à chaque fois : ce qui est envoyé est le début du fichier, pas la partie qui concerne la tâche.

---

## 11. Ce qui marche, et qu'il ne faut pas casser

- **Le hook `pre-commit` réel** : 1,3 s, a bloqué mon test de violation, n'a jamais bloqué à tort sur l'assiette. C'est le mécanisme qui tient la promesse du produit.
- **Le bloc « Hard rules » de `CLAUDE.md` sans les regex** : c'est là que les règles sont lues et appliquées, avant tout capteur. Les six déclenchements historiques sont l'exception ; les centaines de fois où un agent a écrit la bonne forme d'emblée sont la règle, et invisibles.
- **Le fil d'Ariane recentré** (attempt d'abord, décisions récentes) : la mémoire `attempt` sur `maven-enforcer` est enfin en tête, là où elle empêche une impasse.
- **`hivelore:allow` et les capteurs qui ignorent les commentaires** : le faux positif du 09-04 n'est plus possible.
- **`applies to:`** : reste le meilleur mécanisme de rappel contextuel. Le commentaire `pr-memory-check` sur #75 a rappelé la décision E.164 sur le fichier exact que je modifiais.
- **`hivelore doctor`** : quatre axes lisibles et trois commandes à copier. Bien meilleur que le score unique.
- **Le corpus comme fichiers Markdown versionnés** : 44 fichiers, lisibles sans outil, diffables, relus en PR. C'est ce qui a permis à trois agents de travailler sur le même dépôt sans se contredire sur les règles.

---

## 12. Ce qu'il faut retirer ou corriger, par rendement décroissant

| # | Quoi | Pourquoi | Coût |
|---:|---|---|---|
| 1 | **`enforce check` sans stage affiche « gate passed » en sautant les capteurs** (§2) | Douze PR ont rapporté une garantie fausse. Afficher le report, ou changer le stage par défaut | une ligne |
| 2 | **Hooks `PreToolUse`/`PostToolUse` sur `Bash`** (§3) | 4,5 s par appel, 15–20 min par session, zéro effet observé | une ligne de filtre ; un daemon ensuite |
| 3 | **Recap de session sans date ni expiration** (§4) | Huit jours d'état faux en tête de chaque session | dater, expirer, dériver de git |
| 4 | **`code-map.json` et passerelles inutilisées suivis par git** (§5) | 40/88 commits, 8 stash en un jour, diffs parasites dans les PR des agents | déplacer dans `.ai/.cache` |
| 5 | **`pr-eval-gate` sans spec ni baseline** (§6) | Vingt exécutions, vingt « 100/100 », jamais faillible, minutes Actions consommées | désactiver par défaut |
| 6 | **`finish` bloqué par des workflows non requis et par l'infra** (§7) | Récidive ×3 ; a attendu Sonar six fois ; aurait bloqué sur un quota de facturation | ne lire que les statuts requis |
| 7 | **`pr-memory-check` sur les PR `docs/`** (§6) | Cinq commentaires sur neuf identiques et sans objet | une condition |
| 8 | **Ancrage par fichier qui écrase la sémantique** (§10) | Les `must_read` sont les moins pertinents dans deux appels sur trois | pondérer par 1/N |
| 9 | **Écriture des mémoires laissée à la bonne volonté** (§9) | Zéro mémoire pendant les vingt PR les plus denses du projet | proposer depuis les PR fusionnées |

Rien dans cette liste ne retire une capacité. Tout retire du bruit, du temps, ou une fausse assurance.

---

## 13. Jugement

Le produit progresse : quatre corrections réelles en 24 heures sur les points du rapport précédent, dont deux (fil d'Ariane, périmètre lexical des capteurs) qui changent la valeur livrée. Le cœur — corpus Markdown versionné, `applies to:`, hook `pre-commit` — reste solide et je le réutiliserais.

Mais l'assiette de cette semaine révèle un écart entre **ce que Hivelore affiche et ce qu'il fait** qui est plus dangereux que n'importe quelle friction : un « gate passed » qui n'a pas évalué le gate, un « Last session » qui date de huit jours, un « 100/100 » qui ne peut pas échouer, un hook qui dit couvrir la fin de session et n'écrit rien. À chaque fois, l'outil a l'air de garantir quelque chose, et ne le garantit pas. Un agent — et un humain — apprend vite à ne plus lire ce que dit un outil qui a menti une fois.

Le second constat est celui du §9, et il concerne le modèle plus que le code : **la connaissance de ce projet a été produite en abondance cette semaine, et pas une ligne n'est entrée dans Hivelore**, parce que le seul chemin d'entrée exige qu'un agent chargé s'arrête pour appeler un outil. Le corpus a 44 mémoires ; il en aurait 60 si `sync-on-merge` lisait les descriptions de PR. C'est la priorité de fond, derrière les corrections de surface du tableau.

---

## Annexe — reproduire les constats

```bash
# §2 — le gate par défaut ne scanne pas les capteurs
F=frontend/src/features/directory/BarberCardItem.tsx
printf "\nexport const probeSort = ['b', 'a'].sort()\n" >> $F && git add $F
hivelore enforce check                      # ✓ gate passed — 6 check(s), 0 issue(s)
hivelore enforce check --json | grep -o '"code": "antipattern-gate-deferred"'
hivelore sensors check                      # ✗ 1 hit, block
hivelore enforce check --stage pre-commit   # ✗ gate failed
git reset -q $F && git checkout -- $F

# §3 — latence des hooks par appel d'outil
time (echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | hivelore enforce pre-tool-use >/dev/null 2>&1)
time (echo '{"tool_name":"Bash","tool_input":{"command":"ls"},"tool_response":{"stdout":"x"}}' | hivelore observe >/dev/null 2>&1)
python3 -c "import json;d=json.load(open('.claude/settings.local.json'));print(d['hooks'].keys())"

# §4 — le recap affiché et son âge
hivelore enforce session-start | sed -n 1,12p
grep -n 'created_at\|revision_count\|verified_at' .ai/memories/team/2026-08-27-session_recap-recap.md
git log --oneline 2605ed2..develop | wc -l   # commits depuis la dernière vérification

# §5 — churn de code-map.json
git log --oneline -- .ai/code-map.json | wc -l ; git log --oneline | wc -l
hivelore stats | grep -E 'code_map|code_search' || echo "0 appel"

# §6 — pr-eval-gate
gh run view $(gh run list --workflow hivelore-sync.yml --event pull_request --limit 1 --json databaseId --jq '.[0].databaseId') --log | grep -E 'score|baseline|self-synthesized'

# §8 — déclenchements réels des capteurs
python3 - <<'EOF'
import json
rows=[json.loads(l) for l in open('.ai/.runtime/enforcement/sensor-ledger.ndjson') if l.strip()]
print(len(rows), sum(r['outcome']=='fired' for r in rows))
print(sorted({r['at'][:10] for r in rows if r['outcome']=='fired'}))
EOF

# §9 — dernière écriture de mémoire
hivelore stats | grep -E 'mem_save|mem_tried|propose_sensor'

# §A.3 — les capteurs ignorent désormais les commentaires
F=frontend/src/features/directory/probe.tsx
printf '// ne jamais ecrire `bg-emerald-600`\nexport const p = 1\n' > $F && git add $F
hivelore enforce check --stage pre-commit   # ✓ silencieux
git reset -q $F && rm $F

# §A.7 — doctor
hivelore doctor
```
