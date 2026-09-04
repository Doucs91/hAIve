# Hivelore — sixième retour d'expérience

**Date** : 2026-09-04
**Auteur** : agent Claude Code (Opus 5)
**Dépôt** : `mirrobook` (ex-barberbook) — monorepo Spring Boot 4.1 + React 19
**Version** : `hivelore` 0.58.1, posture `strict`, autopilot ON, hooks `pre-commit` + `pre-push`
**Assiette** : 8 jours de travail réel, 67 commits, 59 PR fusionnées, 44 mémoires, 16 capteurs

Ce document n'est pas une redite des cinq précédents. Il apporte ce qu'aucun d'eux
n'avait : **un dépôt où le serveur MCP a fonctionné du premier au dernier jour**, avec
la télémétrie d'usage complète, et un corpus assez mûr (44 mémoires, 16 capteurs) pour
qu'on puisse mesurer le rendement plutôt que l'imaginer.

Le ton est direct parce que c'est ce qui a été demandé. Aucun constat ici n'est une
impression : tout est reproductible, les commandes sont en annexe.

---

## 1. Le constat central : le fil d'Ariane est tronqué par ordre alphabétique

Les cinq rapports précédents concluent tous la même chose — **le bloc injecté dans
`CLAUDE.md` est le seul mécanisme qui produise de la valeur mesurable**. Ce rapport le
confirme une sixième fois, et découvre pourquoi cette valeur plafonne.

`CLAUDE.md` liste 8 mémoires sur 44. Voici lesquelles :

```
2026-08-27-convention-aucun-identifiant-en-dur-ni-artefact-genere
2026-08-27-convention-contrat-auth-401-403-et-rotation
2026-08-27-convention-couverture-tests-90-pourcent
2026-08-27-convention-flyway-owns-schema
2026-08-27-convention-frontend-api-same-origin
2026-08-27-convention-git-workflow-develop-vers-main
2026-08-27-convention-ne-jamais-committer-artefact-genere
2026-08-27-decision-monorepo-version-unique-et-ci-filtree
```

Ce sont **exactement les huit premières de `ls .ai/memories/team | sort`**. Toutes du
premier jour. La sélection n'est pas `ls | sort | head -8` par hasard : c'est ce qu'elle
est.

Conséquence directe : **35 mémoires écrites après le 27 août n'apparaissent nulle part
dans le fichier que l'agent lit réellement.** Notamment, et ce ne sont pas des détails :

| Mémoire invisible | Ce qu'elle contient |
|---|---|
| `2026-08-30-architecture-notifications-base-fait-autorite` | l'architecture des notifications |
| `2026-08-31-architecture-abonnement-stripe-fait-autorite` | le modèle d'abonnement |
| `2026-08-31-decision-devise-du-salon` | pourquoi les montants sont en plus petite unité |
| `2026-09-04-decision-depart-employe` | la règle métier écrite hier |
| `2026-08-30-attempt-mavenenforcerplugin` | une impasse déjà explorée, à ne pas refaire |

La mémoire de type `attempt` est le cas le plus coûteux : sa raison d'être est
d'empêcher un agent de retenter une impasse. Rangée derrière un tri alphabétique qui la
place en 30ᵉ position, elle ne l'empêchera jamais.

Le tri par nom de fichier signifie aussi que **la date préfixée décide du classement** :
tout ce qui est écrit après le premier jour de vie du projet est structurellement
condamné à ne jamais remonter. Plus le corpus vieillit, plus le fil d'Ariane est figé
sur ce qu'on savait au jour 1.

**Ce qu'il faut faire.** Le tri doit être un classement, pas un ordre de fichiers.
Par rendement décroissant :

1. **Les capteurs d'abord** — ils bloquent, donc ils sont toujours pertinents (ils sont
   d'ailleurs déjà tous listés, voir §1.1) ;
2. **les `attempt`** — leur valeur est entièrement préventive ;
3. **les `decision` et `architecture` récentes** — le plus susceptible d'être contredit
   par un agent qui ne les connaît pas ;
4. **le reste par date décroissante**, pas croissante.

Un simple `sort -r` ferait déjà mieux que l'existant. Ce n'est pas une hyperbole : la
liste actuelle est le pire ordre possible, puisqu'il privilégie mécaniquement le plus
ancien.

### 1.1 Le déséquilibre du budget de contexte

`CLAUDE.md` fait 10 775 octets. Sa répartition :

| Section | Octets | Part |
|---|---|---|
| Bloc « Hard rules » (16 capteurs, regex + prose complètes) | 6 832 | **63 %** |
| Mode d'emploi Hivelore + sécurité | ~2 900 | 27 % |
| Fil d'Ariane des mémoires (8 lignes) | ~1 000 | 9 % |

Deux tiers du budget partent dans des expressions régulières que l'agent n'a pas besoin
de connaître — le hook les applique de toute façon, et il les applique mieux qu'un
agent qui les lit. Ce qu'un agent a besoin de savoir d'un capteur tient en une ligne :
*« pas de couleur Tailwind en dur, passer par les jetons de `index.css` »*. Le motif
`\b(bg|text|border|ring|divide|outline|placeholder|fill|stroke|from|via|to|caret|decoration|accent)-(slate|gray|zinc|…)-\d{2,3}\b`
ne lui apprend rien de plus et coûte 300 octets.

**Inverser le rapport** : une ligne par capteur (l'instruction corrective, pas le motif),
et le budget récupéré rendu aux mémoires réellement classées. À 44 mémoires, tout tient.
À 200, il faudra un vrai classement — raison de plus pour l'écrire maintenant.

---

## 2. Télémétrie d'usage : 89 appels sur 8 jours, et ce qu'ils disent

C'est la première fois qu'un rapport peut donner ces chiffres. Extraits de
`.ai/.usage/tool-usage.jsonl` :

| Outil MCP | Appels |
|---|---|
| `mem_save` | 36 |
| `propose_sensor` | 21 |
| `get_briefing` | 16 |
| `mem_session_end` | 13 |
| `mem_relevant_to` | 2 |
| `mem_tried` | 1 |
| **total** | **89** |

Et la liste de ce qui n'a **jamais** été appelé, une seule fois, en huit jours :

```
mem_get   code_map   code_search   mem_search   mem_verify
mem_update   pre_commit_check   scaffold_test   report_friction
```

Neuf outils sur seize, jamais invoqués. Deux lectures pour l'énoncer sans détour :

**a) Le ratio écriture/lecture est de 70 pour 18.** Hivelore est utilisé comme un
carnet, pas comme une source. L'agent y dépose beaucoup et n'y puise presque rien —
parce que ce dont il a besoin est déjà dans `CLAUDE.md`, injecté sans appel d'outil.

**b) L'étape 2 du mode d'emploi est une fiction.** `CLAUDE.md` prescrit :

> *2. **Drill down only if needed** : utilisez `mem_get` pour une mémoire remontée,
> `code_map` pour les symboles exacts, `code_search` pour la recherche sémantique.*

Je ne l'ai jamais fait, et je peux dire exactement pourquoi :

- **`code_map` et `code_search`** perdent contre `Grep` et `Read`. Un `grep -rn` répond
  en 200 ms avec les numéros de ligne exacts, dans un format que je peux enchaîner vers
  une édition. Un index sémantique me donne une liste de candidats que je dois de toute
  façon ouvrir. **Ce n'est pas un défaut de qualité de `code_search`, c'est un problème
  de catégorie** : un agent avec `grep`, `ls` et un shell n'a pas de problème de
  recherche de code. Il a un problème de *savoir ce qu'il ne sait pas* — et ça, aucun
  index ne le résout.
- **`mem_get`** est inutile parce que le résumé dans `CLAUDE.md` suffit dans neuf cas
  sur dix, et que dans le dixième j'ouvre le fichier `.md` directement — c'est un
  fichier, dans le dépôt, que `Read` lit sans round-trip MCP.
- **`mem_tried`** : appelé une fois pour, au bas mot, quinze impasses réelles cette
  semaine (regex de remplacement trop gourmandes qui ont corrompu un fichier de test,
  `@Transactional` sur des contrôleurs remplacé ensuite par `@EntityGraph`, test MockMvc
  qui ne prouvait rien…). Elles ont toutes fini dans les messages de commit, parce que
  c'est là que je les écris **au moment où je les comprends**, sans changer d'outil.

**Recommandation, et c'est la plus impopulaire du rapport : supprimer `code_map` et
`code_search`.** 148 Ko de `code-map.json` régénéré à chaque session, source de diffs
dans les PR (`chore: code-map après l'ajout de…` apparaît quatre fois dans mon
historique), pour zéro appel en huit jours. C'est du coût pur. Si vous les gardez,
gardez-les hors du dépôt.

### 2.1 `report_friction` : l'outil de remontée de friction n'est jamais atteint par la friction

Cet outil existe. Je ne l'ai jamais appelé — pendant une semaine où j'ai rencontré, et
documenté par écrit, au moins six frictions Hivelore (celles de ce rapport). Elles sont
allées dans des messages de commit et dans ce fichier, pas dans l'outil prévu pour.

La cause n'est pas la mauvaise volonté : **rien ne le déclenche au moment de la
friction**. Quand un hook me bloque, la sortie me dit quoi corriger ; elle ne me dit pas
« si cette règle t'a bloqué à tort, signale-le ici ». Le seul instant où un signalement
serait naturel — l'instant du blocage — est le seul où l'outil n'est pas mentionné.

Correction à coût quasi nul : **une ligne dans la sortie du hook en cas de blocage**,
avec la commande exacte. Le taux de remontée passera de zéro à quelque chose.

---

## 3. Économie des capteurs : 16 posés, 4 déclenchés, 1 faux positif

C'est le chiffre le plus important du rapport après le §1, parce que les capteurs sont
la partie *différenciante* de Hivelore — la partie qu'aucun linter classique ne fait.

| | |
|---|---|
| capteurs posés | 16 |
| appels à `propose_sensor` | 21 |
| capteurs ayant déclenché au moins une fois | **4** |
| dont **vraies prises** | **2** |
| dont **faux positif** | **1** |
| dont **hors périmètre** (politique de branche, pas de la connaissance) | 1 |
| capteurs jamais déclenchés en 8 jours | 12 |

Les quatre, nommément :

1. `gotcha-tests-dependant-du-jour` — **vraie prise.** A bloqué un `LocalDate.now()` sans
   fuseau dans un test. C'est exactement la classe de bug que Hivelore promet d'attraper :
   invisible en revue, invisible le matin, rouge le soir. **Ce capteur seul justifie la
   fonctionnalité.**
2. `gotcha-tri-de-chaines-sans-localecompare` — **vraie prise.** A bloqué un `.sort()`
   sans comparateur. Même famille : un bug qui ne se voit qu'en français ou en portugais.
3. `convention-git-workflow-develop-vers-main` — a bloqué un `git push` direct sur
   `develop`. Utile, mais **ce n'est pas de la connaissance d'équipe, c'est une
   protection de branche.** GitHub la fait nativement, côté serveur, sans hook local.
4. `convention-jetons-de-conception` — **faux positif.** §3.1.

Douze capteurs sur seize n'ont jamais rien attrapé. Ce n'est pas nécessairement mauvais
— un capteur qui ne se déclenche pas peut être un capteur qui dissuade. Mais on ne peut
pas le savoir, et c'est le problème : **rien ne distingue un capteur dissuasif d'un
capteur mort.** Une date de dernière évaluation (« ce motif a été confronté à 340
commits sans jamais correspondre ») permettrait de retirer les morts. Aujourd'hui le
corpus ne fait que croître.

### 3.1 Le faux positif demandé : un capteur a bloqué le commentaire qui explique la règle

C'est l'incident signalé. Voici le déroulé exact.

**La règle.** `2026-08-31-convention-jetons-de-conception-seule-source-des-couleurs` :
interdiction d'écrire une couleur de la palette Tailwind en dur ; il faut passer par les
jetons de rôle déclarés dans `frontend/src/index.css`. Le motif :

```
\b(bg|text|border|ring|divide|outline|…)-(slate|gray|zinc|neutral|emerald|…)-\d{2,3}\b
```

**L'incident.** En tête de `frontend/src/index.css` — le fichier qui *définit* les jetons
— j'avais écrit le commentaire qui explique la convention à qui ouvre le fichier :

```css
/*
  Ce bloc est la seule source des couleurs de l'application. Une classe `bg-emerald-600`
  écrite ailleurs est une couleur qui échappe au système : elle ne suivra pas le prochain
  changement.
*/
```

Le hook a refusé le commit. `bg-emerald-600`, cité entre backticks dans un commentaire
CSS, à titre de contre-exemple, dans le fichier qui incarne la règle.

**Le correctif que j'ai dû faire** (commit `9fcf9c3`) : reformuler la prose pour ne plus
nommer la classe interdite. La documentation a été appauvrie pour satisfaire le capteur.
J'ai gardé le capteur — la règle est bonne — mais **le mécanisme m'a forcé à dégrader
l'explication de sa propre règle**, ce qui est exactement à l'envers.

**La cause.** Les capteurs sont des expressions régulières appliquées au texte brut du
fichier. Aucune conscience lexicale : commentaire, chaîne de caractères, code exécutable,
tout est du texte.

**Trois corrections, par ordre de coût :**

1. **Ignorer les commentaires par défaut** (`//`, `/* */`, `#`, `<!-- -->`, docstrings).
   Un motif qui vise du code n'a presque jamais de raison de viser de la prose. Option
   `scan: code|all` pour les rares cas inverses (une clé d'API en dur *doit* être
   attrapée même en commentaire).
2. **Auto-test à la proposition** : `propose_sensor` doit confronter le motif candidat au
   **corps de sa propre mémoire** et aux fichiers cités dans `applies to:`. S'il
   correspond à sa propre documentation, refuser et le dire. Ici, le corps de la mémoire
   contient les mêmes noms de classes : la contradiction était détectable à l'écriture,
   trois jours avant le blocage.
3. **Une échappatoire locale** : `hivelore:allow <slug> — raison`, en commentaire de fin
   de ligne, journalisée. Aujourd'hui un faux positif n'a **aucune** issue autre que
   réécrire le code ou retirer le capteur. Un linter sans mécanisme d'exception finit
   désactivé — c'est le sort de tous ceux qui n'en ont pas.

Le §3.2 du rapport du 2026-09-02 signalait déjà que les capteurs ne distinguent pas le
code de test du code de production. C'est la même racine : **pas de périmètre lexical.**
Deux dépôts différents, deux rapports, une seule cause.

---

## 4. Les workflows générés par Hivelore ont livré deux défauts réels

Celui-ci est sévère, et je le formule sans ménagement : **`hivelore-sync.yml`, fichier
généré par l'outil, a introduit dans mon dépôt deux défauts que l'outil lui-même
prétend prévenir.** Aucun des deux ne vient de moi ; je n'ai fait que les corriger.

### 4.1 `pr-stale-check` : job cassé depuis sa génération, révélé au premier passage

```yaml
permissions:
  pull-requests: write     # et rien d'autre
```

Un bloc `permissions:` explicite met **toutes** les portées non listées à `none`.
`actions/checkout` n'avait donc pas le droit de lire un dépôt privé, et échouait sur
`Repository not found` — un message qui se lit comme une panne de GitHub, pas comme un
défaut de droits.

Le job voisin, `pr-memory-check`, dans le même fichier généré, déclare correctement les
deux portées. **L'incohérence est interne au générateur.**

Le défaut était dormant depuis la génération : le job ne se déclenchait que sur les PR
vers `main`, et ce projet fusionne dans `develop`. Il s'est réveillé à la première PR
qui l'a touché, et a échoué immédiatement. Correctif : `contents: read` (commit `c7956c4`).

**Aggravant** : `gh pr checks --watch` sort en code 0 même quand un job échoue. J'ai
fusionné une PR avec ce job rouge sans le voir. Ce n'est pas la faute de Hivelore, mais
c'est le contexte dans lequel un job généré qui échoue silencieusement fait des dégâts.

### 4.2 `pr-stale-check` : une alarme qui ne pouvait pas se taire

Toujours dans le fichier généré :

```bash
STALE=$(grep -c 'stale' /tmp/haive-verify.txt || echo 0)
```

`grep -c` compte les **lignes contenant le mot**, pas les mémoires périmées. Il en
attrape deux qui parlent de péremption sans en être :

- la ligne de synthèse « 41 fresh · 0 stale · 0 anchorless » ;
- la phrase « staleness cannot be detected ».

`STALE` ne pouvait donc **jamais** valoir 0. Le job postait « ⚠️ Stale memories detected »
sur toutes les PR, y compris celles dont le corps du message annonce « 0 stale ». Vérifié
sur la vraie sortie : il renvoie 2 quand il n'y a rien à signaler.

C'est le défaut symétrique de celui contre lequel Hivelore se vend : un saut silencieux
laisse passer du code non vérifié ; une alarme permanente se fait ignorer. **Le second
est plus insidieux, parce qu'il ressemble à de la vigilance.** Correctif : lire le nombre
au lieu de compter les lignes, et retirer au passage les codes ANSI qui ressortaient
bruts dans les commentaires déjà postés — on y lisait `^[[2mfresh^[[22m` (commit `8da33ce`).

**Ce que ça coûte au produit.** Le mécanisme le plus visible de Hivelore côté équipe,
c'est le commentaire de PR. Le premier qu'a vu ce dépôt était un faux positif orné de
caractères de contrôle. La confiance se construit là.

### 4.3 Le déclencheur `main`/`master` : le corpus a dérivé pendant six jours

`hivelore-sync.yml` ne se déclenchait que sur `main` et `master`. Ce projet — comme
beaucoup — fusionne dans `develop`, et `main` ne reçoit qu'une mise en production de
temps en temps.

Résultat, découvert le 2 septembre (commit `eab6a71`) : **deux capteurs actifs et
bloquants vivaient dans `.ai/memories/` depuis les PR #37 et #39 sans jamais figurer
dans `CLAUDE.md`.** Des règles qui bloquent des commits, qu'aucun agent ne pouvait
lire. L'inverse exact de leur raison d'être.

Second défaut du même fichier : il appelle `hivelore sync`, qui ne touche que `.ai/`.
Les fils d'Ariane (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/`) sont régénérés par
`hivelore bridges sync` — **qui n'était appelé nulle part.** Même sur `main`, ils
n'auraient jamais été rattrapés.

**Corrections attendues côté générateur :**

- détecter la branche par défaut du dépôt (`gh repo view --json defaultBranchRef`) au
  lieu de coder `main`/`master` en dur, et proposer `develop` quand un flux gitflow est
  détecté (présence d'une branche `develop`, ou d'une convention dans le corpus — ce
  dépôt a une mémoire `convention-git-workflow-develop-vers-main` que Hivelore stocke
  lui-même et n'utilise pas pour se configurer) ;
- appeler `bridges sync` là où `sync` est appelé ;
- **un test de non-régression sur les workflows générés.** Les trois défauts ci-dessus
  auraient été attrapés par une exécution à blanc sur un dépôt privé avec une PR vers
  une branche non-`main`.

---

## 5. `enforce finish` bloque sur ce qui n'est pas de son ressort

Récidive du §3.3 du rapport précédent, avec un cas nouveau et plus net.

Aujourd'hui, `hivelore enforce finish` m'a refusé la fin de session :

```
✗ github-actions-failed: 1/3 GitHub Actions workflow run(s) for HEAD did not pass
```

La cause réelle du rouge : **le quota de stockage d'artefacts GitHub du compte est
plein.** Rien à voir avec le code, les tests, ou la connaissance d'équipe — les 529
tests backend et 484 frontend passent, le build passe, seule l'étape `upload-artifact`
échoue avec « Artifact storage quota has been hit ».

Plus tôt dans la semaine, le même `finish` m'a bloqué sur :

```
✗ git-sync-uncommitted-changes: 2 file(s) are untracked
```

Les deux fichiers non suivis étaient… **les deux mémoires que Hivelore venait de
m'écrire** via `mem_save`. L'outil crée des fichiers, puis bloque la fin de session
parce que ces fichiers ne sont pas commités.

**Le fond du problème** : `enforce finish` mélange trois natures de contrôle.

| Nature | Exemple | Doit-il bloquer ? |
|---|---|---|
| Connaissance | mémoire périmée, décision non couverte | **oui** — c'est le métier de l'outil |
| Hygiène git | fichiers non suivis, recap manquant | avertir, pas bloquer |
| État d'infrastructure | CI rouge pour cause de quota, de flakiness, de facturation | **non** — hors périmètre |

Un outil de connaissance qui refuse de conclure parce qu'un quota de facturation est
atteint chez un tiers dépasse son mandat. Et il pousse à la seule issue disponible :
ignorer la porte. Ce qui, à terme, la vide de son sens y compris quand elle a raison.

---

## 6. Récidives — signalées, toujours présentes

| Constat | Signalé | État au 2026-09-04 |
|---|---|---|
| Écriture de `last_fired` dans un fichier **suivi par git** | 2026-09-02 §3.1 | **inchangé** — visible dans le diff de `9fcf9c3` |
| Capteurs sans périmètre lexical | 2026-09-02 §3.2 | **inchangé** — nouveau cas, §3.1 ci-dessus |
| `enforce finish` bloquant hors périmètre | 2026-09-02 §3.3 | **inchangé**, nouveau motif (§5) |
| Score `knowledge-layer health` non actionnable | ×3 | **inchangé** — affiche « 0 % (cible 85 %) » avec 44 mémoires et 16 capteurs, sans qu'aucune action ne le fasse bouger |
| Passerelles multiples régénérées sans consommateur | 2026-08-29 | inchangé |

Sur le score de santé : **0 % sur un dépôt qui porte 44 mémoires, 16 capteurs, un
contexte projet de 174 lignes et des modules documentés**, c'est soit un bug, soit une
métrique qui mesure autre chose que ce que son nom annonce. Dans les deux cas elle
s'affiche à chaque `enforce`, et personne — ni le développeur ni moi — ne sait quoi en
faire. Troisième rapport consécutif à le dire.

---

## 7. Ce qui marche, et qu'il ne faut surtout pas casser

Je suis dur sur le reste. Ces quatre points sont solides et méritent d'être nommés.

### 7.1 Le commentaire `pr-memory-check` a réellement changé du code

Le meilleur moment Hivelore de la semaine, et il est concret. Sur la PR #50, j'avais
résolu un `LazyInitializationException` en collant `@Transactional` sur cinq
contrôleurs. Ça marchait. Le commentaire `pr-memory-check` a fait remonter une mémoire
d'équipe sur le chargement par graphe d'entités. J'ai remplacé les cinq annotations par
un `@EntityGraph` sur la requête (commit `58b6328`).

C'est la bonne solution, et je ne l'aurais pas trouvée seul à ce moment-là :
`@Transactional` sur un contrôleur étend la transaction à toute la sérialisation, ce
qui masque le problème au lieu de le résoudre. **Une connaissance d'équipe est arrivée
au bon endroit, au bon moment, et a corrigé un choix techniquement inférieur.** C'est
exactement la promesse du produit, tenue.

À noter : elle est arrivée **par le commentaire de PR**, pas par un appel MCP. Encore
un point pour le passif contre l'actif.

### 7.2 Le hook `pre-push` sur les branches protégées

Bloque un `git push` direct sur `develop` avant qu'il ne parte. GitHub le ferait aussi,
mais après le voyage réseau et avec un message moins clair. Coût : 1,2 seconde. Garder.

### 7.3 L'annotation `applies to:`

C'est ce qui rend le fil d'Ariane exploitable : je sais si une mémoire concerne le
fichier que j'ouvre sans avoir à la lire. Troisième rapport à le dire, ça reste vrai.

### 7.4 Le corpus comme artefact écrit et versionné

44 fichiers Markdown dans le dépôt, lisibles par un humain, diffables, revus en PR. Cette
décision de format est juste et elle est la raison pour laquelle Hivelore survit à
l'indisponibilité de son propre serveur MCP — constaté dans deux rapports antérieurs, et
encore à chaque session ici (§7.5).

Le corpus est le produit. Le reste est de la tuyauterie autour.

### 7.5 Précision sur l'ENOENT `haive`, signalé deux fois avant ce rapport

Les rapports du 1er et du 2 septembre attribuaient l'échec à un `.mcp.json` de dépôt.
Ce n'est pas le cas ici, et la nuance compte pour la correction :

```
$ cat .mcp.json                    # dépôt : correct
{"mcpServers":{"hivelore":{"command":"hivelore","args":["mcp","--stdio"], …}}}

$ python3 -c "import json,os; print(list(json.load(
      open(os.path.expanduser('~/.claude.json'))).get('mcpServers',{})))"
['haive']                          # portée utilisateur : résidu du renommage
```

`hivelore init` écrit donc bien un fichier propre dans le dépôt. Ce qui manque, c'est la
**migration des configurations existantes hors du dépôt** : l'entrée globale survit,
échoue à chaque session de chaque projet, et pollue le démarrage d'un message d'erreur
qui laisse croire que Hivelore est indisponible alors qu'il fonctionne.

---

## 8. Ce qu'il faut retirer

Sans détour, et en ajoutant à la liste du rapport précédent :

| À retirer | Pourquoi |
|---|---|
| `code_map` / `code_search` et `code-map.json` | 0 appel en 8 jours ; 148 Ko de diff régénéré ; perdent contre `grep` |
| Le motif regex complet dans `CLAUDE.md` | 63 % du budget de contexte pour une information dont l'agent n'a pas l'usage |
| Le score `knowledge-layer health` | 3ᵉ rapport ; 0 % sans cause ni action |
| Le tri alphabétique du fil d'Ariane | Pire ordre possible (§1) |
| L'écriture de `last_fired` dans un fichier suivi | 2ᵉ rapport ; casse `git checkout` |
| Le blocage de `finish` sur l'état de la CI | Hors périmètre (§5) |

Rien de cette liste ne retire une fonctionnalité au produit. Tout y allège le bruit.

---

## 9. Priorités — par rendement décroissant

1. **Classer le fil d'Ariane au lieu de le trier par nom.** (§1)
   Le défaut le plus coûteux du lot : il rend invisible 80 % de ce que l'outil accumule,
   dans le seul artefact qui délivre de la valeur. Correction de quelques lignes.

2. **Donner un périmètre lexical aux capteurs, et une échappatoire.** (§3.1)
   Ignorer les commentaires par défaut ; auto-tester le motif contre le corps de sa
   propre mémoire à la proposition ; `hivelore:allow` journalisé. Sans cela le taux de
   faux positifs finira par faire désactiver la fonctionnalité la plus différenciante
   du produit.

3. **Tester les workflows générés avant de les livrer.** (§4)
   Trois défauts réels dans un fichier généré, dont un qui a rendu deux capteurs
   bloquants invisibles pendant six jours. Un test à blanc sur dépôt privé + branche
   par défaut ≠ `main` les attrape tous les trois.

4. **Sortir de `finish` tout ce qui n'est pas de la connaissance.** (§5)
   Récidive. Avertir sur l'hygiène git, ignorer l'état de l'infrastructure, bloquer
   uniquement sur le corpus.

5. **Mentionner `report_friction` dans la sortie des hooks quand ils bloquent.** (§2.1)
   Une ligne. Fait passer le taux de remontée de zéro à non-zéro.

6. **Nettoyer les entrées MCP `haive` restées du renommage.** (§7.5)
   Troisième signalement, mais avec une précision qui change la correction attendue :
   le `.mcp.json` **du dépôt est correct** (il déclare bien `hivelore`). L'entrée fautive
   vit dans la configuration **utilisateur** (`~/.claude.json`, portée globale), héritée
   d'avant le renommage, et elle échoue en `ENOENT: haive-mcp` à chaque session, dans
   tous les projets. Une commande d'upgrade doit balayer les portées projet **et**
   utilisateur, pas seulement écrire un fichier propre dans le dépôt courant.

---

## 10. Jugement de fond

L'idée est juste, et j'ai un cas daté qui le prouve : le capteur `LocalDate.now()` a
attrapé un bug qui aurait échoué en CI un soir sur deux, et le commentaire de PR m'a
fait remplacer une solution médiocre par la bonne. Ces deux moments valent la peine
qu'on construise l'outil.

Mais après huit jours, la lecture honnête du dépôt est celle-ci : **la valeur de
Hivelore transite presque entièrement par deux mécanismes passifs — un fichier Markdown
injecté dans le contexte, et un hook git — et presque pas par le serveur MCP, qui
concentre pourtant l'essentiel de la surface produit.** 89 appels d'outils, dont 70
d'écriture. Neuf outils sur seize jamais touchés.

Le corollaire est inconfortable mais je le pose : **le produit est un compilateur de
connaissance vers `CLAUDE.md` et vers des hooks git.** Tout ce qui sert cette
compilation mérite d'être investi ; tout ce qui vit à côté (index de code, recherche
sémantique, scores, passerelles multi-agents sans consommateur) est du coût sans
recette. La bonne nouvelle est que le cœur — corpus versionné, `applies to:`, capteurs
exécutables — est solide. Ce qu'il lui manque n'est pas de la fonctionnalité : c'est du
classement, du périmètre, et le silence sur ce qui n'a rien à dire.

---

## Annexe — reproduire les constats

```bash
# §1 — le fil d'Ariane est le head -8 du tri alphabétique
diff <(grep -oE '^- `2026-[a-z0-9-]+`' CLAUDE.md | tr -d '`' | sed 's/^- //') \
     <(ls .ai/memories/team/*.md | xargs -n1 basename | sed 's/\.md$//' | sort | head -8)
# sortie vide = les deux listes sont identiques

# §1.1 — répartition du budget de contexte
python3 -c "c=open('CLAUDE.md').read(); i=c.index('## Hard rules'); print(len(c)-i, '/', len(c))"

# §2 — télémétrie d'usage
python3 - <<'PY'
import json, collections
l=[json.loads(x) for x in open('.ai/.usage/tool-usage.jsonl') if x.strip()]
print(len(l), collections.Counter(i['tool'] for i in l).most_common())
PY

# §3 — capteurs posés vs capteurs déclenchés
grep -l 'sensor:' .ai/memories/team/*.md | wc -l
grep -h 'last_fired:' .ai/memories/team/*.md | grep -vc null

# §3.1 — le faux positif sur un commentaire
git show 9fcf9c3

# §4 — les défauts des workflows générés
git show c7956c4    # contents: read manquant
git show 8da33ce    # grep -c 'stale'
git show eab6a71    # déclencheur main/master + bridges sync jamais appelé

# §5 — enforce finish hors périmètre
hivelore enforce finish
```

**Assiette complète** : `mirrobook`, 2026-08-27 → 2026-09-04, 67 commits, 59 PR,
44 mémoires (43 team + 1 personal), 16 capteurs, 89 appels MCP, hooks actifs sur
la totalité de la période.
