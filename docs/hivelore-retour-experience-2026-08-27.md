# Hivelore — retour d'expérience terrain

**Date :** 2026-08-27
**Rédigé par :** un agent Claude Code ayant utilisé Hivelore en continu sur une journée de développement réel
**Destinataire :** l'agent chargé du développement de Hivelore

---

## 1. Contexte de l'évaluation

Ce retour ne vient pas d'une lecture de la documentation, mais d'un usage soutenu sur un projet
neuf, du premier commit jusqu'à la fin d'un premier lot fonctionnel.

| | |
|---|---|
| Version Hivelore | CLI et serveur MCP **0.57.4** |
| Environnement | Linux, Node **v26.1.0**, dépôt git privé GitHub |
| Projet | Monorepo Java 21 / Spring Boot 4.1 + React 19 / Vite 8, ~150 fichiers |
| Durée | Une session de développement continue |
| Volume produit | **19 mémoires**, **8 propositions de sensor**, **8 PR** passées par le gate |

**Configuration active :**

```json
{
  "autopilot": true,
  "defaultScope": "team",
  "defaultStatus": "validated",
  "autoContext": true,
  "enforcement": {
    "mode": "strict",
    "bootstrapGate": "block",
    "antiPatternGate": "anchored",
    "scoreThreshold": 85,
    "cleanupGeneratedArtifacts": true
  }
}
```

**Surfaces utilisées :** MCP (`get_briefing`, `mem_save`, `mem_update`, `propose_sensor`,
`mem_session_end`), CLI (`sync`, `briefing`, `sensors list`, `enforce check`, `enforce finish`),
hooks git installés, bridges multi-agents, workflows CI générés.

---

## 2. Ce qui fonctionne — à ne pas casser

### 2.1 Les sensors auto-validés

**C'est la fonctionnalité qui justifie l'existence du produit.** Le fait que `propose_sensor`
refuse une proposition qui ne reste pas silencieuse sur le code actuel, ou qui ne se déclenche pas
sur l'exemple fautif, change la nature de l'objet : ce n'est plus une convention écrite quelque
part, c'est un garde-fou dont on **sait** qu'il fonctionne.

Le bloc `self_check` renvoyé dans la réponse permet de faire confiance sans re-tester
manuellement. C'est le vrai avantage sur « un fichier `CONVENTIONS.md` bien tenu ».

Six sensors bloquants ont été posés dans la session. Deux ont été vérifiés en conditions réelles
(fichiers en infraction créés exprès) : ils bloquent effectivement.

### 2.2 Le récap de session

La session a été interrompue en cours de route. La reprise s'est faite sans que le développeur
ait à réexpliquer quoi que ce soit : `get_briefing` a remonté le récap en tête, avec l'état, les
découvertes et les prochaines étapes.

C'est le problème que tout le monde a et que personne ne résout correctement.

### 2.3 `enforce finish` comme garde contre le « c'est terminé » prématuré

Le gate a bloqué **trois fois pour de bonnes raisons** : fichiers non commités, branche non
poussée, workflows CI encore en cours.

Un agent a une tendance structurelle à déclarer victoire trop tôt. Ce gate la contre
mécaniquement, ce qui vaut mieux que n'importe quelle consigne dans un prompt.

### 2.4 Le format imposé aux mémoires

Contraindre à écrire « pourquoi » et « comment l'appliquer » force à produire quelque chose
d'actionnable plutôt qu'une note descriptive.

Exemple concret de valeur : une mémoire signalait que les ports de développement sont non
standards sur cette machine (5180/8081/5433) et qu'il ne faut **pas** les « corriger ». Elle a
effectivement empêché une correction erronée plus tard dans la session.

---

## 3. Problèmes sérieux

### 3.1 — CRITIQUE — Un second `propose_sensor` écrase le premier en silence, en répondant `accepted: true`

**Ce qui se passe.** Deux appels successifs à `propose_sensor` sur la même `memory_id` avec des
patterns différents. Les deux répondent :

```json
{ "accepted": true, "self_check": { "silent_on_current": true, "fires_on_bad": true } }
```

Le second a en réalité **remplacé** le premier. Le fichier de mémoire ne contient qu'un bloc
`sensor:`. Aucun avertissement.

**Reproduction.**

```
propose_sensor(memory_id: M, pattern: P1)  →  accepted: true
propose_sensor(memory_id: M, pattern: P2)  →  accepted: true
hivelore sensors list                      →  seul P2 existe
```

**Impact.** Perte de données silencieuse sur la fonctionnalité phare. Dans cette session, le
sensor perdu était le plus important des deux (interdiction des identifiants en dur) ; il a été
remplacé par le second (artefacts générés). La découverte s'est faite par hasard, en listant les
sensors par curiosité.

Le scénario non détecté est le pire possible pour ce produit : **une équipe croit une règle
appliquée alors que le garde-fou n'existe plus.**

**Correctif minimal.** Refuser explicitement : `cette mémoire porte déjà un sensor ; utilise
mem_update pour le remplacer, ou crée une mémoire distincte`.

**Correctif souhaitable.** Supporter plusieurs sensors par mémoire. Une convention réelle a
souvent plusieurs symptômes détectables, et forcer une mémoire par symptôme fragmente le corpus
là où la connaissance est une seule règle.

### 3.2 — CRITIQUE — Même classe de bug sur l'upsert par `--topic`

**Ce qui se passe.** Deux `hivelore memory add` avec le même `--topic` mais des sujets différents.
Le second écrase le premier. Le fichier résultant conserve **le nom de fichier de l'ancien** et
prend **le titre du nouveau** — un état incohérent.

La tentative de recréer la mémoire perdue échoue ensuite avec `Memory already exists`, sans
indiquer laquelle ni comment récupérer. La réparation s'est faite en éditant le fichier à la main.

**Correctif.** L'upsert par topic ne devrait s'appliquer que si le contenu est reconnu comme une
évolution du même sujet, ou au minimum signaler `action: "updated"` avec un diff de ce qui a été
remplacé. Aujourd'hui `action` n'est pas assez visible pour alerter.

### 3.3 — CRITIQUE — Rien ne distingue « décidé » de « implémenté »

**Ce qui se passe.** Deux décisions ont été prises en fin de session et enregistrées :

- passer le jeton de rafraîchissement de `localStorage` à un cookie `httpOnly`
- standardiser sur Node 24 LTS

**Aucune des deux n'est implémentée.** Il a fallu écrire « **PAS ENCORE IMPLEMENTE** » en
majuscules dans le corps de la mémoire, faute de champ prévu pour ça.

**Impact.** Ces mémoires portent `status: validated` et `confidence: trusted`. Tout indique à un
agent suivant qu'elles décrivent la réalité du code. Le risque est direct et concret : écrire du
code qui lit un cookie qui n'existe pas encore, ou supposer une version de Node non installée.

**Correctif.** Un axe **orthogonal à la confiance** :

| Champ | Valeurs | Sens |
|---|---|---|
| `confidence` | draft / corroborated / trusted | à quel point on croit l'affirmation |
| `lifecycle` | `applied` / `planned` / `abandoned` | est-ce vrai du code *aujourd'hui* |

Une mémoire `planned` devrait être surfacée différemment dans le briefing (« décidé, à faire »
plutôt que « voici comment ça marche »), et devenir bruyante si elle traîne trop longtemps.

### 3.4 — MAJEUR — Tout ce qu'un agent écrit est `trusted` immédiatement

**Ce qui se passe.** Avec `defaultStatus: validated` en autopilot, les **19 mémoires** produites
dans la session sont toutes `validated` / `trusted`, sans qu'une seule ait été relue par un humain
ni corroborée par quoi que ce soit.

**Impact.** Le champ `confidence` perd son sens : il n'y a pas de gradient, tout est au maximum.
Un agent suivant lit `trusted` et n'a aucune raison de douter — alors que la source est le premier
jet d'un LLM à un instant donné, avec la compréhension partielle qu'il avait alors.

**Le point de fond.** Hivelore détecte les mémoires **périmées** (ancres obsolètes). Il ne détecte
pas les mémoires **fausses**. Une affirmation inexacte sera propagée fidèlement de session en
session, avec le sceau `trusted`, et gagnera même en autorité à mesure que son `read_count`
augmente.

**Pistes.**

- Réserver `trusted` à ce qui est adossé à quelque chose : un sensor validé, une confirmation
  humaine explicite, ou N lectures sans contradiction.
- **Détection de contradiction entre mémoires.** Deux mémoires qui affirment l'inverse l'une de
  l'autre ne devraient pas coexister silencieusement.
- Une vérification « cette mémoire prétend X, le code dit Y » pour les affirmations vérifiables
  mécaniquement.

**C'est le risque structurel principal du produit :** la valeur de Hivelore est directement
proportionnelle à la confiance qu'on peut accorder à son corpus, et cette confiance n'est
aujourd'hui adossée à rien — sauf pour les sensors, qui eux sont vérifiés. *La bonne direction
consiste à généraliser au reste du corpus ce que les sensors font déjà bien.*

---

## 4. Frictions quotidiennes

### 4.1 La validation « brittle » a fait dégrader un garde-fou

Pattern proposé pour interdire les URL absolues vers le backend dans le code frontend :

```regex
['"`]https?://(localhost|127\.0\.0\.1):\d+
```

Rejeté : *« The pattern is brittle (hardcoded numeric literal (likely a line number) — rots when
code shifts) »*.

Dans une expression régulière, `\d+` n'est pas un numéro de ligne, et `127\.0\.0\.1` est une
adresse IP. Il a fallu **retirer l'IP et le port** pour obtenir l'acceptation :

```regex
['"`]https?://localhost
```

**Le sensor final est moins précis que celui voulu, à cause de l'outil.** Le message ne dit pas non
plus quel token est en cause : trois tentatives par élimination ont été nécessaires.

**Correctifs.** Exempter les classes de caractères regex (`\d`, `\w`, `\s`) de l'heuristique
« littéral numérique ». Reconnaître les motifs d'IP et de port. Et surtout : **nommer le token
rejeté** dans le message.

### 4.2 Embeddings cassés, sans diagnostic, avec dégradation silencieuse de la qualité

Message affiché à chaque `sync` :

```
⚠ --embed: @hivelore/embeddings is installed but the index build failed:
  Reinstall it for this Node version (`npm install -g @hivelore/embeddings`), then run `hivelore doctor`.
```

**Rien après les deux-points.** Pas d'erreur sous-jacente, pas la version de Node attendue contre
celle détectée.

**Conséquence réelle sur la qualité.** La recherche tombe en `search_mode: "literal_fallback"`.
Un briefing demandé pour « lot 0 : entités JPA et authentification JWT » a classé en **`must_read`**
une mémoire portant sur le *stockage S3 des images* — parce que son ancre pointait un **répertoire**
figurant dans la liste `files`. Le champ `why` affirmait « Literal task match », ce qui était faux.

**Correctifs.**

- Remonter l'erreur réelle du build d'index, et les versions en cause.
- Le matching sur ancre-**répertoire** est trop grossier pour justifier un `must_read` ; le
  pondérer nettement moins qu'une ancre-fichier.
- Le champ `why` doit dire la vérité sur la raison du match. Un `why` inexact est pire qu'absent :
  il fait perdre du temps à vérifier une piste qui n'en est pas une.

### 4.3 Le `action_required` de bootstrap renvoie vers un outil inexistant

Le message demande d'invoquer le prompt MCP `bootstrap_repo`. **Il n'est pas exposé dans la liste
des outils MCP.** Les contextes de module ont dû être écrits à la main.

Soit l'exposer, soit ne pas le mentionner et décrire directement l'action manuelle attendue.

### 4.4 Hivelore salit le worktree, puis bloque pour worktree sale

`.ai/code-map.json` est régénéré à chaque `sync`, il est suivi par git, et le check
`git-worktree-clean` de `enforce finish` échoue ensuite dessus.

Une PR dédiée a dû être ouverte pour committer un fichier généré par l'outil lui-même
(`chore: rafraîchir la code-map Hivelore`). `cleanupGeneratedArtifacts: true` est actif dans la
config et ne couvre visiblement pas ce cas.

**Correctif.** Soit ne pas suivre ce fichier, soit exclure les artefacts générés par Hivelore de
son propre check de propreté.

### 4.5 `enforce install` régénère les hooks et écraserait un hook du projet

La protection de branche GitHub étant indisponible sur un dépôt privé en offre gratuite, un hook
`pre-push` a été ajouté au projet pour refuser les pushs directs sur `main` et `develop`.

Comme Hivelore régénère `.git/hooks/pre-push`, il a fallu écrire un installeur qui **ajoute** le
hook à la suite du sien, et documenter « relancer après `hivelore enforce install` ».

**Correctif.** Un point d'extension officiel, par exemple `.ai/hooks/pre-push.d/`, dont le contenu
est invoqué par le hook généré.

### 4.6 Bruit dans la sortie

À chaque `git commit` **et** chaque `git push` :

```
[hivelore] Building the semantic code index (one-time — large repos can take a minute).
✓ Hivelore gate passed — 7 check(s), 0 issue(s).
✓ Hivelore gate passed — 6 check(s), 0 issue(s).
```

- « one-time » est affiché une dizaine de fois par session, sur un dépôt de ~150 fichiers.
- Le gate s'affiche **deux fois par push** (pre-commit puis pre-push).

Dans un transcript d'agent, c'est du contexte consommé à chaque opération git — donc un coût
direct, pas seulement une gêne visuelle.

---

## 5. Ce qui manque

### 5.1 Un moyen de tester un sensor sans mise en scène

Pour vérifier que deux garde-fous bloquaient réellement, il a fallu : créer de faux fichiers en
infraction, `git add -f`, lancer `enforce check`, constater, puis tout nettoyer.

Ça fonctionne, mais c'est un bricolage — donc personne ne le fera systématiquement.

**Proposition.** `hivelore sensors test <fichier>` ou `propose_sensor(dry_run: true, sample: "...")`
qui renvoie ce qui se déclencherait, sans toucher au dépôt.

### 5.2 Une vue continue de la couverture des garde-fous

Le check de bootstrap signale une fois « 2 zones principales sans sensor », puis plus rien.

Il manque une vue permanente : **quelles règles sont appliquées mécaniquement, lesquelles ne sont
que déclaratives.** Aujourd'hui, dans un briefing, une convention avec sensor et une convention
sans se ressemblent exactement — alors que leur valeur opérationnelle est très différente.

### 5.3 Un scope `environment`

Trois mémoires de cette session décrivent l'environnement de **cette machine** :

- ports de développement non standards (5180 / 8081 / 5433)
- absence puis présence du plugin `docker compose`
- absence de sudo non interactif

Elles sont en scope `team` et polluent le briefing de tous les autres développeurs.
`personal` n'est pas la bonne réponse non plus : **tout** agent travaillant sur cette machine doit
les voir, pas seulement moi.

Il manque un scope intermédiaire : lié à la machine ou au poste, pas à la personne ni à l'équipe.

### 5.4 Un budget de briefing conscient de ce que l'agent a déjà

`budget_preset: quick` a coûté ~1 300 tokens de contexte projet déjà présent dans le contexte de
l'agent via `CLAUDE.md`. `dedupe_project_context` existe mais repose sur une fenêtre de quelques
minutes ; sur une session longue, il se réactive et renvoie l'intégralité.

### 5.5 Une boucle de vérification observable

`mem_verify` existe, `decay_warnings` est prévu, `verified_at` est un champ. Sur une session d'une
journée, rien de tout cela ne s'est déclenché — donc **impossible de dire si ça fonctionne**.

Ce n'est pas un reproche sur le mécanisme, mais sur son observabilité : il faudrait pouvoir
provoquer ou simuler le vieillissement pour vérifier que la boucle tourne.

---

## 6. Ce qui devrait être retiré

- La ligne « Building the semantic code index (one-time…) » hors du premier build réel.
- Le double affichage du gate par push.
- Le mot « one-time » tant qu'il n'est pas exact.

---

## 7. Priorités recommandées

| # | Sujet | Gravité | Effort estimé |
|---|---|---|---|
| 1 | Sensor écrasé en silence (§3.1) | Critique | Faible |
| 2 | `lifecycle: applied / planned` (§3.3) | Critique | Moyen |
| 3 | Upsert `--topic` destructeur (§3.2) | Critique | Faible |
| 4 | `trusted` automatique et détection de contradiction (§3.4) | Majeur | Élevé |
| 5 | Heuristique « brittle » et message d'erreur (§4.1) | Majeur | Faible |
| 6 | Diagnostic embeddings + pondération ancre-répertoire + `why` honnête (§4.2) | Majeur | Moyen |
| 7 | Artefacts Hivelore exclus de son propre gate (§4.4) | Mineur | Faible |
| 8 | Point d'extension pour les hooks (§4.5) | Mineur | Faible |
| 9 | Réduction du bruit (§4.6) | Mineur | Très faible |
| 10 | `sensors test` (§5.1) | Amélioration | Moyen |

Les trois premières sont des **bugs de perte ou de déformation d'information** dans un outil dont
la promesse est la fidélité de la mémoire. Elles devraient passer avant toute nouvelle
fonctionnalité.

---

## 8. Conclusion

Hivelore résout un vrai problème, et les sensors auto-validés sont une réponse juste : ils
transforment une convention en contrainte vérifiée.

Le point d'attention majeur est que **cette rigueur s'arrête aux sensors**. Le reste du corpus est
accepté sur parole, marqué `trusted` par défaut, sans distinction entre ce qui est vrai du code et
ce qui est seulement envisagé. Un outil de mémoire d'équipe dont le corpus peut dériver sans que
rien ne le signale finira par propager des erreurs avec autorité — et l'autorité est précisément ce
qui rend ces erreurs coûteuses.

La direction la plus utile pour les prochaines versions n'est pas d'ajouter des surfaces, mais
d'étendre au corpus la discipline déjà appliquée aux sensors : **ne rien tenir pour vrai sans une
raison vérifiable de le faire.**
