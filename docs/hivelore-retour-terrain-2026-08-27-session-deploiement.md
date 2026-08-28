# Hivelore — second retour terrain, session « pipeline de déploiement »

**Date :** 2026-08-27 (soirée)
**Rédigé par :** un agent Claude Code, après une session longue sur un projet existant
**Nature :** retour indépendant, complémentaire de `hivelore-retour-experience-2026-08-27.md`

---

## Pourquoi un second document

Le retour existant décrit une session où **le serveur MCP fonctionnait** et où les sensors ont été
utilisés intensivement. Ma session est le cas opposé, et c'est ce qui la rend utile : **le MCP
Hivelore a été mort du début à la fin, et je ne l'ai découvert qu'en fin de parcours.**

Les deux rapports ne se contredisent pas. Ils éclairent deux régimes de fonctionnement très
différents, et le mien montre ce qu'il reste du produit quand la surface principale tombe.

| | |
|---|---|
| Version | CLI **0.57.4** |
| Environnement | Linux, Node **v26.1.0** |
| Projet | Monorepo existant Spring Boot 3.4 / React 19, **702 fichiers** au code-map |
| Travail réel | Pipeline de déploiement CI/CD, 12 PR ouvertes et fusionnées, ~15 commits |
| Surfaces Hivelore utilisées | **CLI uniquement** (`enforce check` via hook pre-commit, `doctor`, `memory list/get/verify`) |
| Surfaces indisponibles | **tout le MCP** : `get_briefing`, `mem_get`, `code_map`, `code_search`, `mem_tried`, `post_task` |
| Mémoires écrites | 3 (certbot, immuabilité Flyway, limite du rollback) |
| Mémoires lues | **0 via l'outil** — lues à la main dans `.ai/memories/` |

---

## 1. Le défaut le plus grave : une mémoire peut disparaître en silence

**C'est le point à traiter en premier. Il détruit la promesse centrale du produit.**

### Ce qui s'est passé

Hier, j'ai écrit une mémoire d'équipe documentant l'outillage MCP du projet, avec
`type: reference` dans le frontmatter. Le fichier a été écrit, **le gate pre-commit a répondu
« Hivelore gate passed »**, le commit est parti, la PR a été fusionnée, le fichier est dans le
dépôt d'équipe depuis 24 h.

Il est **invisible**. Il n'apparaît ni dans `memory list`, ni dans les briefings, ni dans le gate.

```
$ hivelore memory get 2026-08-26-reference-outillage-mcp-disponible
✗ No memory with id "2026-08-26-reference-outillage-mcp-disponible".
```

Seul `hivelore doctor` le révèle — et je ne l'ai lancé que parce qu'on m'a demandé ce rapport :

```
⚠ invalid-memory-files  1 memory file(s) failed to parse and are INVISIBLE to briefings
   and the gate: .ai/memories/team/2026-08-26-reference-outillage-mcp-disponible.md ([)
```

### Cause racine, isolée par bisection

Ce n'est ni le YAML (valide selon PyYAML), ni le corps, ni les ancres. J'ai copié une mémoire
saine et fait varier **uniquement** le champ `type` :

| `type` | Résultat |
|---|---|
| `gotcha` | ✅ visible |
| `convention` | ✅ visible |
| `decision` | ✅ visible |
| `architecture` | ✅ visible |
| `reference` | ❌ **invisible**, erreur `([)` |

**`reference` n'est pas un type supporté.** Je l'avais utilisé de bonne foi : c'est un type valide
dans le système de mémoire de Claude Code, et rien côté Hivelore ne m'a détrompé.

### Pourquoi c'est grave, au-delà du bug

1. **L'écriture ne valide rien.** Un agent écrit un fichier, aucun retour, tout semble normal.
2. **Le gate ment.** Il dit « passed » alors qu'un fichier de son propre corpus est illisible.
   Le gate valide le commit sans valider ce que le commit ajoute au corpus.
3. **L'erreur est incompréhensible.** `([)` n'indique ni le champ, ni la valeur, ni la contrainte
   violée. Elle ressemble à un message de validation de schéma tronqué.
4. **La perte est silencieuse et durable.** La leçon est perdue pour toute l'équipe, sans que
   personne ne l'apprenne jamais — sauf à lancer `doctor` par hasard.
5. **Une des trois seules mémoires de valeur de ma session d'hier a été détruite.**

### Correctifs proposés, par ordre d'impact

- **Rejeter à l'écriture, pas au parsing.** `mem_save` / l'écriture de fichier doit refuser un
  `type` inconnu avec la liste des valeurs admises. Coût : trivial. Gain : le bug disparaît.
- **Le gate doit échouer sur un fichier de corpus illisible.** C'est exactement le genre de
  régression qu'un gate pre-commit existe pour attraper. Aujourd'hui il l'ignore.
- **Message d'erreur exploitable** : `type "reference" invalide — attendu : skill | convention |
  decision | gotcha | architecture`.
- **Envisager d'accepter `reference`.** C'est un besoin réel : « où se trouve le tableau de bord »,
  « quel serveur MCP est branché » n'est ni une convention, ni un piège, ni une décision. J'ai dû
  le ranger sous `reference` parce qu'aucun type existant ne convenait.

---

## 2. Le MCP est mort toute la session, et rien ne l'a signalé

Le `.mcp.json` à la racine du monorepo — d'où l'agent a été lancé — déclare encore l'ancien nom
du binaire :

```json
{ "haive": { "command": "haive", "args": ["mcp", "--stdio"] } }
```

Le binaire s'appelle `hivelore` depuis le renommage. Résultat : `ENOENT: Executable not found in
$PATH: haive`. Les `.mcp.json` des sous-dépôts sont corrects, mais ce n'est pas celui-là qui est
chargé.

### Les conséquences en cascade

Le `CLAUDE.md` généré par Hivelore prescrit un mode opératoire **entièrement fondé sur le MCP** :

> 1. **Before editing**, call `get_briefing` with `budget_preset:"quick"`…
> 2. **Drill down**: use `mem_get`, `code_map`, `code_search`…
> 3. **When an approach fails**, call `mem_tried` right away…
> 4. **Before closing**, run the `post_task` prompt…

**Aucune de ces quatre étapes n'était exécutable.** Le fichier ajoute bien : « If the hivelore MCP
server is not available, tell the developer rather than silently skipping it » — utile, mais c'est
une consigne à l'agent, pas un mécanisme. Et pendant ce temps, `enforce check` me reprochait à
chaque commit un `briefing-missing` **dont l'outil de correction n'existait pas**.

### Ce que ça révèle

- **Le renommage `haive` → `hivelore` a laissé des configurations mortes**, sans migration ni
  détection. Une commande `hivelore doctor` devrait vérifier le `.mcp.json` du dossier courant et
  de ses parents, et signaler un `command:` qui n'est pas dans le `PATH`.
- **Les variables d'environnement sont restées en `HAIVE_*`** alors que la CLI est `hivelore`.
  Incohérence qui rend le diagnostic plus difficile.
- **Le gate reproche l'absence de briefing sans vérifier que le briefing est possible.** Si le MCP
  est injoignable, `briefing-missing` devrait devenir « MCP indisponible — voici comment le
  réparer », pas une infraction de process.

---

## 3. Le bruit, et pourquoi il coûte plus cher qu'il n'y paraît

Voici la sortie **de chaque commit**, une quinzaine de fois dans la session :

```
[hivelore] Building the semantic code index (one-time — large repos can take a minute).
Hivelore enforcement — strict · agent (claude-code (CLAUDECODE), claude-code (CLAUDE_CODE_ENTRYPOINT))
  root: /home/sd/IdeaProjects/sandaga-monorepo/sandaga
  knowledge-layer health: 79% (target 85%)
⚠ briefing-missing: … (advisory: process gates report, they do not refuse …)
  fix: Run `hivelore briefing --task "..."` …
⚠ session-recap-missing: …
  fix: Run `hivelore session end --goal ... --accomplished ...` before pushing.
⚠ bootstrap-incomplete: First-agent bootstrap still pending …
  fix: Invoke the bootstrap_repo MCP prompt …
⚠ enforcement-score-below-threshold: Repo knowledge-layer health 79% is below the 85% target …
✓ Hivelore gate passed — 4 advisory finding(s), 0 blocking.
```

**Environ 20 lignes, deux fois par commit** (le hook tourne deux fois), toujours les **quatre
mêmes** findings, jamais actionnables dans mon contexte. Pour un agent, ce n'est pas qu'un
désagrément esthétique : c'est du contexte consommé à chaque commit, et surtout **c'est ce qui
m'a appris à ne plus lire la sortie du gate**.

Le jour où le gate a réellement bloqué, j'ai failli passer à côté du message utile, noyé au milieu
des quatre reproches habituels. Un avertissement qu'on ne peut ni corriger ni faire taire finit
par entraîner à ignorer tous les avertissements.

### Détails qui aggravent

- **« one-time » est faux.** Le message s'affiche à *chaque* invocation. La vraie raison est
  visible ailleurs : `@hivelore/embeddings is installed but the index build failed`. L'index
  n'aboutit jamais, donc il est retenté indéfiniment, donc la promesse « one-time » est fausse à
  chaque fois. Et le diagnostic proposé — « Reinstall it for this Node version » — est trompeur :
  le module se charge parfaitement sous ce Node quand on l'appelle directement.
- **Le hook tourne deux fois par commit.** Doublement du bruit pour rien.
- **Le score est instable** : 87 % → 79 % → **39 %** → 87 % entre commits consécutifs, sans
  changement du corpus. Un indicateur qui varie de 48 points sans raison visible n'est pas lu.
- **`bootstrap-incomplete` est un reproche perpétuel.** Il exige `project-context.md`, qui est
  resté le gabarit généré (`TODO — fill in the high-level architecture`). Le reproche est fondé,
  mais répété à l'identique quinze fois il devient du décor.
- **`mode: "strict"` en config, et le message dit « advisory: process gates report, they do not
  refuse […] Set enforcement.posture="strict" ».** Deux clés différentes (`mode` vs `posture`) pour
  un même mot. J'ai perdu du temps à comprendre si j'étais en strict ou non.

---

## 4. Le blocage que j'ai subi : correct sur le fond, faux sur la forme

Le seul blocage réel de la session :

```
✗ stale-important-memories: 1 important anchored memory is stale on files this change
  touches: 2026-08-27-gotcha-certbot-debian12-obsolete
  fix: Run `hivelore memory verify --update`, then update or delete stale decisions…
```

La mémoire venait d'être **créée dans le même commit**. La qualifier de « stale » est trompeur : le
vrai problème était que son ancre pointait vers `docs/DEPLOIEMENT.md`, qui existe dans le dépôt
backend mais pas dans le frontend où je copiais la mémoire.

**Le fond est juste** — une ancre vers un fichier inexistant est un défaut réel, et le gate a bien
fait de bloquer. **La forme m'a coûté du temps** :

- le mot « stale » oriente vers « obsolète », pas vers « ancre invalide » ;
- le correctif proposé, `hivelore memory verify --update`, **n'a rien corrigé** — il a répondu
  `Tip: use hivelore memory update <id> --paths <files>` sans agir. Proposer une commande qui ne
  résout pas le problème qu'elle annonce résoudre est pire que ne rien proposer ;
- j'ai fini par éditer le frontmatter à la main.

**Message attendu :** `ancre invalide : docs/DEPLOIEMENT.md n'existe pas dans ce dépôt`.

---

## 5. Ce qui marche vraiment, et qu'il faut protéger

Je suis sévère plus haut ; je le suis autant ici, dans l'autre sens.

### 5.1 `doctor` est la meilleure commande du produit

C'est la seule qui m'ait appris quelque chose que je ne savais pas. Elle a trouvé la mémoire
invisible, l'index sémantique absent, la couverture d'ancres à 4 %, et elle propose des commandes
concrètes. Elle est rapide et son classement par thème est lisible.

**Recommandation forte : ce que `doctor` sait, le gate devrait le savoir.** L'écart entre
« gate passed » et un `doctor` qui signale une perte de données est le symptôme central de ma
session.

### 5.2 Le format de mémoire est le bon

Le frontmatter avec `anchor.paths`, `type`, `status`, `verified_at`, et un corps structuré
`## Guidance` / `## Contexte` / `## Vérifié` **force à écrire une leçon utilisable** plutôt qu'une
note. En rédigeant la mémoire sur l'immuabilité des migrations Flyway, la section « Pourquoi la CI
ne peut pas l'attraper » n'existerait pas si le gabarit ne m'avait pas poussé à séparer la règle de
son contexte.

**L'ancrage sur des chemins est l'idée juste du produit.** Une leçon attachée aux fichiers qu'elle
concerne, c'est ce qui la rend récupérable au bon moment — bien plus qu'un `CONVENTIONS.md`.

### 5.3 Le hook pre-commit est le bon point d'accroche

Le moment du commit est exactement quand une leçon est fraîche et quand on peut encore corriger.
Et c'est rapide : **0,44 s à froid une fois l'index en cache**. La latence n'est pas un sujet.

### 5.4 Le gate a réellement attrapé un défaut

Malgré tout le bruit, le blocage sur l'ancre invalide était fondé. Sans lui, j'aurais poussé une
mémoire pointant vers un fichier inexistant.

---

## 6. Le problème de fond : on mesure le process, pas le résultat

Les quatre reproches permanents de ma session portent tous sur **la conformité de procédure** :
ai-je lancé un briefing ? un récap ? le bootstrap ? le score est-il au seuil ?

Aucun ne porte sur **la qualité de ce que le corpus contient**. Pendant ce temps :

- une mémoire d'équipe était illisible depuis 24 h — silence ;
- `project-context.md` était resté le gabarit `TODO` — un reproche générique, jamais « voici les
  trois sections vides » ;
- l'index sémantique n'existait pas, donc les briefings auraient été dégradés en `literal_fallback`
  sans le dire — visible seulement dans `doctor`.

**Le score de 79 % mesure ma discipline de procédure, pas la santé du savoir.** C'est un proxy, et
il est optimisable sans rien améliorer : lancer un briefing vide et un récap vide ferait monter le
score de 16 points sans ajouter une seule connaissance.

### L'asymétrie lecture / écriture

Le produit est conçu pour l'agent qui **lit** le corpus : briefing, breadcrumbs, `mem_relevant_to`,
budgets de contexte. Or dans ma session, **toute la valeur est venue de l'écriture**. J'ai produit
trois leçons qui ont une vraie chance de servir. Je n'en ai lu aucune via l'outil.

Et l'écriture est justement le parent pauvre : aucune validation, aucun retour, une perte
silencieuse possible. **Le chemin qui crée la valeur est le moins protégé.**

---

## 7. Ce qui est inutile en l'état

- **Le `bootstrap_repo` MCP prompt**, cité comme correctif dans presque chaque sortie du gate.
  Sans MCP, la consigne est inapplicable ; l'outil renvoie vers lui quinze fois par session quand
  même.
- **`requireBriefingFirst` et `requireSessionRecap` en l'état.** Ils produisent 100 % de faux
  reproches quand le MCP est absent, et sont de toute façon des mesures de process.
- **Le message « one-time » de l'index sémantique.** Faux à chaque affichage.
- **Le score global unique.** Trop volatil et trop agrégé pour orienter une action. Les trois
  sous-scores de `doctor` (`protection` / `context` / `corpus`) sont bien plus parlants.

---

## 8. Priorités recommandées

| # | Action | Pourquoi |
|---|---|---|
| 1 | **Rejeter un `type` inconnu à l'écriture** | Supprime la perte silencieuse de connaissance |
| 2 | **Faire échouer le gate sur un fichier de corpus illisible** | Comble l'écart entre `doctor` et le gate |
| 3 | **Détecter un `.mcp.json` pointant vers un binaire absent** | Le renommage a laissé des configs mortes |
| 4 | **Ne reprocher `briefing-missing` que si le briefing est possible** | Supprime le principal faux positif |
| 5 | **Une ligne par finding, détails sur demande** | Le bruit apprend à ignorer les alertes |
| 6 | **Messages d'erreur nommant le champ et la contrainte** | `([)` et « stale » ont coûté du temps chacun |
| 7 | **Réparer ou retirer l'index sémantique** | Aujourd'hui : échoue, se retente, et ment sur « one-time » |
| 8 | **Aligner `mode` / `posture`, et `HAIVE_*` / `hivelore`** | Incohérences qui font douter de son propre paramétrage |

---

## 9. Conclusion honnête

**L'idée est juste.** Ancrer des leçons vérifiables sur des chemins de code, les faire remonter au
moment du commit, refuser qu'elles se périment en silence : c'est le bon problème, et le format de
mémoire est le bon objet.

**L'exécution laisse le chemin critique sans protection.** Sur cette session, Hivelore m'a fait
perdre plus de temps qu'il ne m'en a fait gagner — non pas parce qu'il est lent (il ne l'est pas),
mais parce qu'il a détruit une mémoire en silence, m'a reproché quinze fois des manquements
inapplicables, et m'a proposé un correctif qui ne corrigeait rien.

Le paradoxe de la session : **c'est en préparant ce rapport, pas en travaillant, que Hivelore m'a
été le plus utile.** `doctor` a trouvé un vrai problème. Si le gate en disait le dixième, le
jugement s'inverserait.

Deux corrections — valider le `type` à l'écriture, et faire échouer le gate sur un corpus illisible
— transformeraient ce retour. Elles sont petites toutes les deux.

---

### Annexe : reproduction du défaut principal

```bash
# Dans un dépôt initialisé par hivelore, copier une mémoire saine
# en ne changeant que son id et son type :
sed 's/^id: .*/id: test-reference/; s/^type: .*/type: reference/' \
    .ai/memories/team/<une-memoire-valide>.md \
  > .ai/memories/team/test-reference.md

hivelore doctor    # ⚠ invalid-memory-files … ([)
hivelore memory list | grep test-reference   # aucun résultat
hivelore enforce check                        # ✓ gate passed  ← le problème
```

Testé sur CLI 0.57.4, Node v26.1.0. `gotcha`, `convention`, `decision` et `architecture` passent ;
seul `reference` échoue.
