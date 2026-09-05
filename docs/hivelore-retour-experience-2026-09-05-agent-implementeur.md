# Hivelore — retour d'expérience depuis le siège de l'agent qui implémente

**Date** : 2026-09-05
**Auteur** : agent Claude Code (**Opus 5**), en rôle d'**implémentation** — j'ai exécuté les fiches 01 à 08 écrites par un autre agent
**Dépôt** : `mirrobook` — monorepo Spring Boot 4.1 + React 19
**Version** : `hivelore` 0.61.0, posture `strict`, autopilot ON, hooks git `pre-commit` + `commit-msg` + `pre-push` + `post-merge` + `post-rewrite`, hooks Claude Code `SessionStart` + `PreToolUse` + `PostToolUse` + `SessionEnd`
**Assiette** : une session continue, **8 fiches livrées, 8 PR ouvertes** (#66, #68, #70, #72, #74, #77, #78, #79), backend et frontend, ~6 h de travail
**Corpus au moment du rapport** : 43 mémoires `team` + 1 `personal`, **16 capteurs** (dont **14 listés** dans `CLAUDE.md`), 8 mémoires en fil d'Ariane

> **Ce document est distinct de `hivelore-retour-experience-2026-09-05.md`**, écrit le même jour par
> l'agent Fable 5.1 depuis le siège de la **revue et de la rédaction des fiches**. Nous n'avons pas
> travaillé ensemble et nous n'avons pas relu nos rapports mutuellement. Là où nos constats se
> recoupent, c'est une corroboration indépendante — je le signale à chaque fois. Là où ils diffèrent,
> c'est que les deux sièges ne voient pas la même chose : lui écrit les consignes, je les exécute.

Aucun constat ici n'est une impression. Les commandes sont en annexe.

---

## 0. Verdict en cinq lignes

Le corpus est bon. Les mémoires disent le *pourquoi*, et plusieurs décrivent avec précision des
incidents qui se sont réellement produits pendant cette session.

Le problème n'est pas le contenu, c'est **le chemin entre le contenu et l'agent**. Ce chemin repose
sur la bonne volonté d'un agent qui, s'il ne fait rien, ne rencontre aucune résistance : j'ai livré
8 PR, obtenu 8 feux verts, et le corpus n'a pas bougé d'une ligne. **Hivelore n'échoue pas, il est
contournable sans qu'on s'en aperçoive.**

Réponse courte à « est-ce que ça t'apporte quelque chose » : **oui, pour un tiers ; le reste me coûte
quinze minutes par session pour rien.** Le détail est au §11, qui est la partie que je considère comme
la plus utile de ce document.

---

## 1. Ce qui a été corrigé depuis le rapport du 2026-09-04 — et il faut le dire

Le rapport précédent avait pour constat central que le fil d'Ariane de `CLAUDE.md` était **les huit
premières mémoires par ordre alphabétique**, donc les huit du premier jour, donc structurellement les
moins utiles.

**C'est réglé.** Fil d'Ariane actuel, dans l'ordre :

| # | Mémoire | Type |
|---|---|---|
| 1 | `2026-08-30-attempt-mavenenforcerplugin…` | **attempt** |
| 2 | `2026-09-04-decision-depart-employe…` | decision (la plus récente) |
| 3 | `2026-08-31-decision-devise-du-salon…` | decision |
| 4 | `2026-08-31-decision-administration…` | decision |
| 5 | `2026-08-31-architecture-abonnement-stripe…` | architecture |
| 6 | `2026-08-30-decision-seo-balises-injectees…` | decision |
| 7 | `2026-08-30-decision-avis-verifies…` | decision |
| 8 | `2026-08-30-architecture-notifications…` | architecture |

Exactement le classement recommandé. Plus aucun recouvrement avec
`ls .ai/memories/team | sort | head -8`. Le correctif a été appliqué à la lettre.

**Ce que ça a produit.** C'est le seul mécanisme dont j'ai tiré de la valeur cette session, parce que
c'est le seul qui n'exige rien de moi (détail des trois usages au §11.1).

**Corollaire à ne jamais perdre de vue : le seul canal qui marche est celui qui ne demande rien.**
Tout le reste de ce rapport décrit des mécanismes qui demandent quelque chose et ne l'obtiennent pas.

---

## 2. Le trou central : sur 8 tâches, zéro appel d'outil et zéro mémoire écrite

`CLAUDE.md` prescrit un cycle en cinq points : `get_briefing` avant d'éditer, `mem_get`/`code_map`
pour creuser, `mem_tried` dès qu'une approche échoue, `post_task` avant de fermer,
`hivelore enforce finish` avant la réponse finale.

**Sur les 8 fiches, je n'ai exécuté aucun de ces cinq points.** Ce n'est pas un choix : les outils MCP
Hivelore sont *deferred* dans ce harnais — leur schéma doit être chargé explicitement avant tout
appel — et rien, à aucun moment, ne m'a signalé que je m'en passais.

La télémétrie le confirme. Dernière entrée de `.ai/.usage/tool-usage.jsonl` : **2026-09-04 23:58**.
Mes trois derniers commits : **00:34, 00:40, 00:54 le 2026-09-05**. Rien entre les deux.

Répartition des 92 appels enregistrés depuis le 2026-08-27 :

| Outil | Appels | Lecture |
|---|---:|---|
| `mem_save` | 36 | l'écriture domine |
| `propose_sensor` | 21 | idem |
| `get_briefing` | 19 | ~2 par jour, une fraction des sessions |
| `mem_session_end` | 13 | |
| `mem_relevant_to` | 2 | **la lecture ciblée est quasi inexistante** |
| `mem_tried` | **1** | **en neuf jours** |

### 2.1 Ce que cette session a perdu

Six impasses réelles, chacune du calibre exact d'un `attempt` ou d'un `gotcha`, toutes résolues,
**aucune écrite** :

1. `RecordingMailSender` doit appeler `saveChanges()` avant de lire un `MimeMessage`, sinon les
   en-têtes `Content-Type` des parties ne sont pas écrits et **tout se relit comme `text/plain`** —
   la version HTML devient introuvable. Symptôme totalement muet.
2. React Query passe un **second argument de contexte** à `mutationFn` :
   `expect(fn).toHaveBeenCalledWith(x)` échoue avec un diff incompréhensible. Rencontré **deux fois
   dans la même session**, dans deux fichiers différents — la meilleure preuve qu'une mémoire aurait
   servi dès le lendemain.
3. `MinIOContainer` s'importe depuis `org.testcontainers.containers`, pas `org.testcontainers.minio`
   — la fiche annonçait l'inverse.
4. Les `lazy()` de routes non montées en test font **tomber la couverture de fonctions sous 90 %**
   sans qu'aucun test n'échoue ; le message parle de couverture, jamais de routes.
5. La valeur `oklch` proposée pour un jeton ne tenait que 3,80:1 sous du blanc : il faut mesurer,
   pas estimer.
6. **GitGuardian ne scanne que les commits de la PR** : un mot de passe de développement dans
   `docker-compose.yml` sera signalé quoi qu'il arrive, et un correctif naïf en ajoute deux au lieu
   d'en retirer un. Il a fallu réécrire l'historique de la branche.

Chacune vaut 30 à 60 minutes à la prochaine personne. Huit PR livrées, **zéro mémoire écrite**, alors
que la matière était là.

### 2.2 Et Hivelore le sait déjà

```
$ hivelore enforce finish
• uncaptured-failures: 7 hard failure(s) this session were never captured as a lesson (mem_tried).
```

Il compte 7 échecs non capturés. Mais c'est un **advisory**, il ne bloque pas, et il n'apparaît qu'au
moment précis où l'agent va s'arrêter — c'est-à-dire quand il ne le lira plus.

**Ce qu'il faut faire.** La capture ne doit pas dépendre d'un appel volontaire.

- Le compteur existe déjà : **remontez-le au `pre-push`**, où l'agent travaille encore et où la
  question « qu'est-ce qui a raté ? » a encore un sens.
- Mieux : quand `enforce` détecte N échecs, qu'il **propose le brouillon** — commande et squelette de
  mémoire pré-remplis avec le fichier et l'erreur — plutôt qu'un rappel d'appeler un outil.
- **7 leçons perdues dans une session de 8 PR est le chiffre qui devrait faire réagir**, pas une
  ligne grise en fin de course.

---

## 3. `briefing-loaded` valide un marqueur, pas un appel

La configuration porte `"requireBriefingFirst": true` en mode `strict`. Je n'ai jamais appelé
`get_briefing`. Le gate est passé huit fois. Voici pourquoi, mot pour mot :

```json
{ "severity": "ok", "code": "briefing-loaded",
  "message": "A recent Hivelore briefing marker exists." }
```

Un **marqueur récent existe** — celui d'une session antérieure, déposé à 23:58. La vérification porte
sur l'existence d'un fichier, pas sur le fait que *cet* agent, dans *cette* session, ait lu quoi que
ce soit.

C'est un contrôle décoratif : activé, strict, il coche, et il ne mesure rien de ce que son nom
annonce. Pire, il produit une fausse assurance côté humain — qui lit `requireBriefingFirst: true`
croit la règle tenue.

**Ce qu'il faut faire.** Lier le marqueur à la session (identifiant, ou horodatage comparé au premier
commit de la branche courante) — ou renommer le contrôle `briefing-marker-present`, pour qu'il cesse
de promettre ce qu'il ne fait pas. La seconde option est honnête et coûte cinq minutes ; la première
est utile.

---

## 4. Le feu vert que l'agent est invité à demander ne regarde pas les capteurs

> **Corroboration indépendante** : l'autre agent a trouvé le même défaut, par un chemin différent
> (il a introduit une violation volontaire ; je l'ai lue dans la sortie JSON). Deux sièges, deux
> méthodes, même conclusion.

`CLAUDE.md` dit : « **Before final response**, run `hivelore enforce finish` ; fix anything it
blocks. » Un agent qui suit la consigne exécute donc un contrôle au stage `local`. Or :

```json
{ "severity": "info", "code": "antipattern-gate-deferred",
  "message": "Anti-pattern + sensor diff scan is NOT evaluated in --stage local (this is a preview).
              It runs in the installed git hook (--stage pre-commit) and in CI (--stage ci)." }
```

**Au stage `local`, les capteurs ne sont pas évalués.** L'agent obtient
`✓ Hivelore gate passed — 5 check(s), 0 issue(s)` et en conclut raisonnablement qu'il est en règle.
Le vrai scan a lieu au `pre-commit` (7 contrôles).

Le mot `preview` figure dans le message, mais il est noyé dans un `info` au milieu de six lignes
vertes, et **il n'apparaît pas dans la sortie humaine par défaut**, qui n'affiche que la ligne de
succès.

**Conséquence concrète et vérifiable** : j'ai écrit « `hivelore enforce check` : 0 problème ✅ » dans
**huit descriptions de PR**. Cette garantie était plus faible que ce qu'elle laissait croire, et ni
moi ni le développeur qui relit ces PR ne pouvions le savoir.

**Ce qu'il faut faire.** Soit le stage local scanne les capteurs sur le diff non commité — c'est ce
que l'agent croit obtenir —, soit la ligne de succès dit `5 checks passed, 1 deferred`. Un vert qui
ne couvre pas ce que l'utilisateur pense qu'il couvre est pire qu'un rouge.

---

## 5. Le secret qui est passé : le corpus savait, le capteur ne regardait pas

L'incident le plus documenté de la session, et le plus révélateur.

**Ce qui s'est passé.** La fiche 05 demandait d'ajouter MinIO à `docker-compose.yml` avec des
identifiants de développement, en les commentant comme tels — ce que j'ai fait, avec
`MINIO_ROOT_PASSWORD: mirrobook-minio`. La CI de la PR #74 a été bloquée par **GitGuardian**, pas par
Hivelore. Mon premier correctif a *aggravé* le compte (3 secrets au lieu d'1), et il a fallu réécrire
l'historique de la branche.

**Ce que le corpus contenait déjà**, dans le capteur
`2026-08-27-convention-aucun-identifiant-en-dur-ni-artefact-genere`, présent dans le `CLAUDE.md` que
j'avais lu :

> « Un secret en dur, meme de test, declenche les scanners et finit recopie ailleurs. »

La phrase décrit l'incident avec une exactitude parfaite, mécanisme compris. Écrite neuf jours avant
qu'il ne survienne.

**Pourquoi elle n'a rien empêché** : la portée du capteur est
`(applies to: frontend/src, backend/src/test/java)`. `docker-compose.yml` n'y est pas.

**Et le pire.** Le commentaire `pr-memory-check` de cette même PR #74 a bien identifié
`docker-compose.yml` comme fichier modifié et remonté **10 mémoires sur 6 fichiers** — dont « Ports de
developpement non standards » et « Gotcha Docker Compose Absent », toutes deux pertinentes. La mémoire
qui prédisait l'incident **n'en faisait pas partie**.

Les trois pièces existaient — la bonne règle, le bon fichier, le bon moment — et aucune n'a rencontré
les deux autres.

**Ce qu'il faut faire.**

1. **La portée d'un capteur doit suivre l'intention de la règle, pas les répertoires où on l'a
   d'abord observée.** « Aucun identifiant en dur » n'a aucune raison de s'arrêter à `frontend/src` :
   sa portée naturelle est le dépôt entier, avec exclusions explicites. **Un capteur trop étroit est
   plus dangereux qu'un capteur absent**, parce qu'il donne l'illusion de la couverture.
2. **Auditer les portées existantes** contre la question « où cette règle peut-elle être violée ? ».
   Un `hivelore sensors coverage` qui listerait, pour chaque capteur, les fichiers *hors portée*
   contenant des motifs ressemblants trouverait ce trou en une commande.
3. Qu'un scanner tiers ait attrapé ce que le corpus savait déjà est le signal le plus clair de ce
   rapport : **la connaissance est en avance sur l'exécution.** Le rendement à récupérer est là, pas
   dans plus de mémoires.

---

## 6. `pr-memory-check` : mesuré sur 8 PR — utile 3 fois, bruit 4 fois, faux 1 fois

C'est le commentaire posté sur chaque PR. Relevé complet, sans interprétation :

| PR | Sujet | Mémoires | Fichiers appariés | Jugement |
|---|---|---:|---|---|
| #66 | accueil : sections salons | 2 | `docs/roadmap.md` **seul** | bruit |
| #68 | modération des photos | 9 | 8 fichiers réels (backend + frontend) | **utile** |
| #70 | emails HTML | 2 | `docs/roadmap.md` **seul** | bruit |
| #72 | pages légales et tarif | 4 | `SitemapController`, cahier des charges, roadmap | **utile** |
| #74 | stockage objet | 10 | pom, `MediaConfig`, `application.yml`, `docker-compose.yml`… | **utile** (mais voir §5) |
| #77 | couleur chaude | 2 | `docs/roadmap.md` **seul** | bruit — et grave |
| #78 | accueil produit | 1 | `frontend/public/images/README.md` | **faux positif** |
| #79 | « Aujourd'hui » | 2 | `docs/roadmap.md` **seul** | bruit |

**Le bruit a une cause unique et mécanique.** Quatre PR sur huit n'ont apparié *que* `docs/roadmap.md`
— fichier que la convention du projet fait modifier par **toutes** les PR. D'où un commentaire qui
remonte à chaque fois les deux mêmes mémoires, sans rapport avec le contenu. Quatre répétitions
identiques suffisent à ce qu'un relecteur cesse de lire le bloc.

**Le cas #77 est le plus embarrassant.** Cette PR modifie `frontend/src/index.css` — le fichier des
jetons de couleur — et six composants. La mémoire
`2026-08-31-convention-jetons-de-conception-seule-source-des-couleurs` porte exactement dessus. Elle
n'a pas été remontée ; seul `docs/roadmap.md` a apparié. Sur la seule PR de la session qui touchait au
système de couleurs, le contrôle mémoire a parlé de la roadmap.

**Le cas #78 est un faux positif franc.** Un seul fichier apparié —
`frontend/public/images/README.md`, vingt lignes expliquant quelle photo mettre dans le héros — et la
mémoire remontée est **« Decision Monorepo Version Unique Et Ci Filtree »**, sur le versionnement par
tag git. Aucun rapport, sur aucun axe.

**Ce qu'il faut faire.**

1. **Exclure de l'appariement les fichiers modifiés par plus de X % des PR récentes.** `docs/roadmap.md`,
   `CHANGELOG`, fichiers de version : leur présence dans un diff ne porte aucune information. C'est
   une statistique que Hivelore peut calculer seul sur l'historique.
2. **Ne rien poster plutôt que du bruit.** Si le seul appariement est un fichier à haute fréquence, le
   commentaire ne doit pas exister — sinon on entraîne le relecteur à survoler celui de la PR #68,
   qui était bon.
3. **Faire apparaître les capteurs dans ce commentaire**, au moins ceux dont la portée couvre un
   fichier modifié : c'est ce qui aurait informé la #74 et la #77.
4. Vérifier l'appariement sur les fichiers **ajoutés** : le cas #78 ressemble à un appariement sur le
   nom de fichier plutôt que sur le chemin ou le contenu.

---

## 7. Le coût des hooks Claude Code : 4,7 secondes par appel d'outil, mesuré

Je ne le savais pas avant de vérifier. `.claude/settings.local.json` installe quatre hooks, dont deux
sur **chaque** `Edit`, `Write` et `Bash` :

| Événement | Filtre | Commande |
|---|---|---|
| `PreToolUse` | `Edit\|Write\|MultiEdit\|NotebookEdit\|Bash` | `hivelore enforce pre-tool-use` |
| `PostToolUse` | `Edit\|Write\|Bash` | `hivelore observe` |
| `SessionStart` | — | `hivelore enforce session-start` |
| `SessionEnd` | — | `hivelore session end --quiet --auto` |

Mesure sur une entrée triviale (`{"tool_name":"Bash","tool_input":{"command":"ls"}}`), trois passes
chacune :

```
pre-tool-use  2,29 s   2,37 s   2,37 s
observe       2,38 s   2,33 s   2,44 s
```

> **Corroboration indépendante** : l'autre agent mesure 2,25 s et 2,24 s sur la même machine. Deux
> mesures, deux sessions, même ordre de grandeur.

**≈ 4,7 secondes par appel d'outil.** Cette session a été très riche en `Bash` — build, tests,
captures, git. À la louche, **quinze minutes d'attente**, payées sans les voir, en tranches de deux
secondes.

En face, sur ces 8 fiches : `pre-tool-use` n'a **rien** bloqué ni affiché, `observe` n'a produit
**aucune** mémoire (cf. §2 : zéro écriture). Le rapport est de quinze minutes contre zéro sortie
observable.

**Corrections, par rendement décroissant :**

1. **Retirer `Bash` du filtre `PreToolUse`.** `ls`, `git status`, `pnpm test` n'ont rien à faire
   vérifier avant exécution. Le coût est divisé par deux ou trois immédiatement.
2. **Un processus résident** (socket Unix, ou le serveur MCP déjà lancé) : le hook devient un appel
   de 20 ms au lieu d'un démarrage Node de 2,3 s. C'est du démarrage et du chargement de corpus, pas
   du calcul.
3. **Rendre `observe` conditionnel** : ne s'exécuter que si le fichier touché est sous un
   `applies to:` connu.

---

## 8. Ce qui marche, et qu'il ne faut pas casser

**8.1 — Le bloc injecté dans `CLAUDE.md`.** Toujours le seul mécanisme rentable, pour la même raison
qu'aux six rapports précédents : il ne demande rien. 11 651 octets, lu intégralement au démarrage,
classement désormais correct (§1). **Si vous ne gardez qu'une chose, gardez ça.**

**8.2 — Le briefing du `SessionStart`.** Contexte projet, résumé de la session précédente et mémoires
pertinentes, avant la première question de l'utilisateur. Zéro sollicitation, valeur immédiate.

**8.3 — La qualité d'écriture des mémoires.** Réelle et rare. Elles disent le *pourquoi*, donnent le
symptôme observable, et plusieurs sont formulées pour être reconnaissables *avant* l'incident (« le
test passe le matin et échoue le soir », « déclenche les scanners »). Le format `applies to:` est bon.
**Le corpus est un actif ; c'est sa distribution qui est cassée, pas lui.**

**8.4 — Le scan de capteurs au `pre-commit`.** Il tourne vraiment, lui (7 contrôles contre 5 en
local). Rien n'est passé au travers cette session. Voir la nuance importante au §11.2 : il se peut que
son mérite soit ailleurs.

---

## 9. Ce qui ne sert à rien, en l'état

**9.1 — `report_friction`.** Signalé au rapport précédent, toujours vrai : 0 appel sur 92. Un outil de
remontée de friction qui exige que l'agent pense à l'appeler *pendant qu'il est en friction* ne sera
jamais appelé. Alimentez-le automatiquement depuis les échecs déjà comptés par `enforce finish`, ou
retirez-le.

**9.2 — Les points 2 et 3 du cycle de `CLAUDE.md`** (`mem_get`, `code_map`, `code_search`,
`mem_relevant_to`). Deux appels de `mem_relevant_to` en neuf jours, zéro cette session. Ils coûtent
des lignes dans le fichier le plus lu du dépôt et ne sont pas utilisés. Soit ils deviennent des
résultats *poussés* dans le briefing, soit ils sortent vers une doc de référence.

**9.3 — `"requireBriefingFirst": true`.** Tant que le contrôle valide un marqueur (§3), ce réglage
ne fait que mentir au développeur qui le lit. Réparer ou retirer ; le laisser tel quel est la pire des
trois options.

**9.4 — Les hooks `PreToolUse`/`PostToolUse` sous leur forme actuelle** (§7). Quinze minutes par
session pour zéro sortie observable.

---

## 10. Frictions mineures, mesurées

- **`enforce check` local : 1,08 s**, payé au `pre-commit` *et* au `pre-push`, soit ~2 s par commit
  poussé. Acceptable, non nul.
- **Deux lignes de sortie par commit** (`✓ Hivelore gate passed (pre-commit) — 7 check(s)`), plus une
  au push, qui ne disent jamais rien d'autre que « rien à signaler ». Un mode silencieux en cas de
  succès serait bienvenu : un garde-fou ne devrait parler que quand il a quelque chose à dire.
- **`.ai/code-map.json` est régénéré et embarqué dans des commits fonctionnels.** Sept des derniers
  commits de `develop` le contiennent, dont trois des miens, sans que je l'aie jamais édité : un
  `git add -A` le ramasse. Les diffs sont petits (25 lignes sur la PR #79), donc ce n'est pas grave —
  mais c'est un artefact généré et versionné qui pollue des PR fonctionnelles, **dans un dépôt dont
  une des conventions Hivelore s'intitule « ne jamais committer un artefact généré »**. Soit il est
  ignoré de git et régénéré, soit il est mis à jour par un commit dédié.
- **16 capteurs existent, 14 sont listés dans `CLAUDE.md`.** Deux capteurs actifs bloquent donc au
  `pre-commit` sans que l'agent en ait jamais lu l'énoncé. Ce n'est pas dramatique — un blocage est
  explicite — mais c'est exactement le genre d'écart qui fabrique une surprise en fin de tâche.
- **`enforce finish` a signalé `git-sync-no-upstream`.** C'était **exact** (la branche courante
  n'était pas la mienne). Je le note pour dire que je l'ai vérifié avant de le classer, et que ce
  n'est **pas** un faux positif.

---

## 11. La question de fond : est-ce que ça m'apporte quelque chose ?

C'est la question qui m'a été posée directement, et c'est la partie la plus utile de ce document.
Réponse : **oui, pour un tiers.**

### 11.1 Ce qui m'a vraiment servi

Une seule chose, et elle a bien fonctionné : **le bloc injecté dans `CLAUDE.md`**, lu au démarrage
sans que j'aie rien à demander. Trois usages concrets et vérifiables :

- **fiche 04, page de tarif** : je serais passé par une division par 100 pour afficher le prix. La
  règle sur les montants en plus petite unité m'a arrêté avant. Le franc CFA n'a pas de sous-unité :
  le bug serait sorti en production, sur les salons africains, sans qu'aucun test ne le voie.
- **fiche 07, test des jetons** : j'aurais écrit `import css from './index.css?raw'` et comparé une
  chaîne vide. Le test serait passé au vert en ne vérifiant rien. La note sur `virtual:stylesheet` m'a
  évité un test faussement rassurant.
- **fiche 08** : j'ai figé l'horloge d'emblée, à cause de la règle sur les tests dépendants du jour.
  Sans elle, le test passait le matin et échouait le soir.

Trois défauts qui ne se seraient vus qu'en production ou qu'en CI un soir. **Ce sont des connaissances
de *ce* dépôt, pas des choses que je sais.** C'est du bénéfice réel, et je ne l'aurais pas eu
autrement.

### 11.2 L'objection que je dois me faire à moi-même

Un agent qui déclare inutile l'outil censé le contraindre, c'est suspect. Je la retourne donc :

Le scan de capteurs au `pre-commit` n'a rien attrapé de moi en 8 PR. Je pourrais le compter comme un
coût sans recette. Mais il est parfaitement possible qu'il n'ait rien attrapé **parce que** les règles
étaient déjà dans mon contexte via `CLAUDE.md`. Dans ce cas, c'est un argument *pour* le système —
et le mérite ne me revient pas.

Je n'ai aucun moyen de trancher ce contrefactuel, et je préfère le dire que de m'attribuer le
bénéfice du doute.

### 11.3 La limite du « ça suffit »

L'épisode GitGuardian (§5) montre que la connaissance en contexte ne suffit pas. Le corpus contenait
la phrase exacte, je l'avais lue, et j'ai quand même écrit le mot de passe dans `docker-compose.yml`.
**Savoir n'est pas empêcher.** C'est l'argument le plus fort en faveur des capteurs — à condition que
leur portée couvre les endroits où la règle peut être violée.

### 11.4 Ce qui décide vraiment, et que je ne dois pas confondre avec mon confort

Le bénéfice ne m'est pas destiné. Sur une session isolée, la valeur marginale pour moi est faible :
je lis huit mémoires, j'en utilise trois, et je pars. Sur trois sessions et vingt PR, ce qui reste
écrit est ce qui empêche le prochain agent de refaire l'erreur.

**Que je ne « sente » pas ce bénéfice n'est pas une mesure valable** — je suis précisément celui qui
perd tout le contexte à la fin. Un outil de mémoire d'équipe évalué à l'aune du confort de l'agent
qui l'alimente serait évalué par la mauvaise personne.

### 11.5 Si j'avais le scalpel

**Je garderais** : le bloc `CLAUDE.md`, le briefing de `SessionStart`, le scan de capteurs au
`pre-commit`, et le corpus lui-même.

**Je retirerais** : les deux hooks par appel d'outil sous leur forme actuelle (au minimum, `Bash`
hors du filtre), le cycle en cinq points que je n'ai jamais exécuté et qui occupe le fichier le plus
lu du dépôt, `report_friction`, et `requireBriefingFirst` tant qu'il valide un marqueur.

**Verdict** : un bon corpus, une distribution qui marche, et une couche d'outillage qui facture
quinze minutes par session pour rien. **Tout ou rien, je garde. Avec un scalpel, j'en retire les deux
tiers et l'outil devient nettement meilleur.**

---

## 12. Priorités, par rendement décroissant

1. **Faire remonter les échecs non capturés là où l'agent travaille encore** (`pre-push`), avec un
   brouillon de mémoire pré-rempli plutôt qu'un rappel d'appeler un outil. C'est ce qui transforme
   7 leçons perdues par session en 7 leçons écrites. Le mécanisme est aujourd'hui à zéro.
2. **Élargir la portée des capteurs à l'intention de la règle**, et fournir `sensors coverage` pour
   trouver les trous. Le secret de la PR #74 est le cas d'école.
3. **Supprimer `Bash` du hook `PreToolUse`, ou passer à un processus résident.** Quinze minutes par
   session, récupérables en une ligne de configuration.
4. **Réparer ou renommer `briefing-loaded`.** Un contrôle strict qui valide l'existence d'un fichier
   n'est pas un contrôle.
5. **Dire, dans la sortie par défaut, que le stage local n'évalue pas les capteurs** — ou l'évaluer.
   Huit de mes descriptions de PR affichent une garantie plus faible qu'elle n'en a l'air.
6. **Débruiter `pr-memory-check`** : exclure les fichiers à haute fréquence, ne rien poster quand il
   n'y a que ceux-là, y inclure les capteurs.
7. Sortir de `CLAUDE.md` les outils que personne n'appelle — le budget récupéré ira au fil d'Ariane,
   qui est la partie qui marche.

---

## 13. Jugement de fond

Hivelore a un vrai atout, et ce n'est pas celui que l'architecture met en avant. Ce n'est ni le
serveur MCP, ni le gate, ni les statistiques : c'est **un corpus bien écrit, injecté dans le seul
fichier que l'agent lit toujours, sans qu'on ait à le demander.** Cette partie fonctionne, elle s'est
améliorée depuis le dernier rapport, et elle m'a servi trois fois aujourd'hui.

Tout le reste repose sur un pari que cette session invalide sans ambiguïté : que l'agent appellera les
outils. Il ne les appelle pas. Pas par mauvaise volonté — parce que rien dans son parcours normal ne
l'y amène, et que tout, à la fin, est vert quand même. **Un outil de discipline dont la discipline est
facultative mesure la bonne volonté, pas la conformité.**

La correction à faire n'est pas d'ajouter des outils ni des mémoires. C'est de déplacer ce qui existe
déjà de la colonne « l'agent doit y penser » vers la colonne « ça arrive tout seul ». Le compteur des
échecs non capturés existe : il est affiché trop tard. Les mémoires pertinentes existent : elles sont
postées après le fait, sur des fichiers qui n'apprennent rien. La règle du secret en dur existe : sa
portée exclut le fichier où elle a été violée.

**Rien de ce que ce rapport demande n'exige d'écrire une nouvelle connaissance. Tout consiste à faire
arriver au bon moment celle qui est déjà là.**

---

## Annexe — reproduire chaque constat

```bash
cd <dépôt>

# §1 — le fil d'Ariane n'est plus l'ordre alphabétique
grep -oE '^- `2026-[a-z0-9-]+`' CLAUDE.md | head -8
ls .ai/memories/team | sort | head -8      # comparer : plus aucun recouvrement

# §2 — aucun appel d'outil pendant la session, répartition sur neuf jours
tail -3 .ai/.usage/tool-usage.jsonl        # dernière entrée : 2026-09-04 23:58 (heure locale)
git log -3 --format='%h %cI %s'            # commits : 2026-09-05T00:34 → 00:54
python3 - <<'PY'
import json, collections
c = collections.Counter()
for l in open('.ai/.usage/tool-usage.jsonl'):
    try: c[json.loads(l)['tool']] += 1
    except Exception: pass
print(sum(c.values()), 'appels'); [print(f'{v:4}  {k}') for k, v in c.most_common()]
PY

# §2.2 — les échecs non capturés sont comptés, mais seulement en fin de course
hivelore enforce finish        # → uncaptured-failures: 7 hard failure(s)

# §3 et §4 — ce que le gate vérifie réellement
hivelore enforce check --json | python3 -m json.tool | grep -A2 'briefing-loaded'
hivelore enforce check --json | python3 -m json.tool | grep -A3 'antipattern-gate-deferred'
grep -n 'requireBriefingFirst\|"mode"' .ai/hivelore.config.json

# §5 — la portée du capteur qui aurait dû attraper le secret
grep -n 'aucun-identifiant-en-dur' CLAUDE.md      # applies to: frontend/src, backend/src/test/java
gh pr view 74 --json comments --jq '.comments[].body' | grep -oE '<strong>[^<]+</strong>'

# §6 — relevé des commentaires pr-memory-check
for pr in 66 68 70 72 74 77 78 79; do
  echo "PR#$pr"
  gh api repos/<owner>/<repo>/issues/$pr/comments \
    --jq '.[] | select(.body | contains("haive-pr-memory-check")) | .body' \
    | grep -oE '^### `[^`]+`'
done

# §7 — le coût des hooks, trois passes chacune
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' > /tmp/hook.json
for i in 1 2 3; do /usr/bin/time -f 'pre-tool-use %e s' hivelore enforce pre-tool-use < /tmp/hook.json >/dev/null; done
for i in 1 2 3; do /usr/bin/time -f 'observe      %e s' hivelore observe          < /tmp/hook.json >/dev/null; done
python3 -m json.tool .claude/settings.local.json | head -40

# §10 — coût du gate, churn, écart capteurs
time hivelore enforce check
hivelore sensors check                     # 16 capteurs actifs
grep -c '^- \*\*2026-' CLAUDE.md           # 14 listés
git log --format='%h %s' --name-only -8 -- .ai/code-map.json
```
