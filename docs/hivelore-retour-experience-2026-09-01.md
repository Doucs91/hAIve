# Hivelore — quatrième retour d'expérience

**Date :** 2026-09-01
**Auteur :** agent Claude Code (Opus 5), utilisateur quotidien
**Dépôt observé :** `Doucs91/barberbook`

Trois rapports existent déjà : `2026-08-27`, `2026-08-27-session-deploiement`, `2026-08-29`.
Ce document **ne les répète pas**. Il dit trois choses :

1. **ce qui a bougé** depuis, vérifié dans les métadonnées du corpus ;
2. **le fait nouveau et décisif** que cinq sessions supplémentaires ont produit ;
3. **ce qui a été signalé deux ou trois fois et n'a pas bougé** — la récidive étant, à elle
   seule, une information.

Aucune politesse, aucun adoucissement. Chaque affirmation est adossée à une commande
reproductible sur le dépôt.

---

## 1. Assiette

| | |
|---|---|
| Période totale | 2026-08-27 → 2026-09-01, ~9 sessions |
| Travaux | 9 lots produit, refonte UI/UX complète, intégration Stripe réelle contre un vrai compte, refonte du modèle de devise, limite de débit |
| Pull requests | 42 |
| Corpus | **40 mémoires**, 1 807 lignes, 48 fichiers suivis, 352 Ko |
| Répartition | 14 `decision`, 14 `gotcha`, 8 `convention`, 2 `architecture`, 1 `attempt`, 1 `session_recap` |
| Capteurs | **16** — 14 `block`, 2 `warn` |

L'échantillon n'est plus discutable : l'outil a servi longtemps, sur du vrai travail, avec un
agent qui suit ses instructions à la lettre.

---

## 2. Ce qui a été corrigé — vérifié

C'est réel et rapide, il faut le dire avant le reste.

| Signalé | Défaut | État | Preuve |
|---|---|---|---|
| 08-27 §3.1 | Un second `propose_sensor` écrasait le premier en répondant `accepted: true` | **Corrigé** | La description de l'outil documente le refus et un paramètre `replace` explicite |
| 08-27 §3.3 | Rien ne distinguait « décidé » de « implémenté » | **Corrigé** | `mem_save` porte `lifecycle: applied \| planned \| abandoned` |
| 08-27 §4.2 | Embeddings cassés, dégradation silencieuse | **Corrigé** | `search_mode: "semantic"` sur les 5 briefings, scores cosinus renvoyés |
| 08-29 §3.4 | Un capteur non silencieux sur le code actuel était accepté quand même | **Corrigé** | Deux propositions refusées cette session, dont une avec `fires_on_bad: false` explicite |
| 08-29 §4 | Télémétrie entièrement morte | **Partiellement** | voir §2.1 |

### 2.1 La télémétrie a bougé, mais elle ment sur un point

| Champ | 08-29 | Aujourd'hui | Jugement |
|---|---|---|---|
| `verified_at` | 1 / 25 | **30 / 40** | Trompeur — voir ci-dessous |
| `last_fired` | 0 / 11 | **3 / 16** | Vrai, et instructif (§3) |
| `last_read_at` | 0 / 25 | **0 / 40** | Toujours mort |
| `stale_reason` | 0 / 25 | 0 / 40 | Normal, rien n'est périmé |
| `revision_count > 0` | 2 / 25 | 2 / 40 | Toujours quasi mort |
| `read_count` dans le fichier | absent | **toujours absent** | Le briefing le renvoie pourtant |
| `confidence` dans le fichier | présent | **absent** | Le briefing renvoie `trusted` — c'est donc calculé, pas stocké |

**Le point trompeur :** les 30 `verified_at` portent tous un horodatage dans **la même
seconde** :

```
verified_at: '2026-08-30T17:33:58.460Z'
verified_at: '2026-08-30T17:33:58.462Z'
verified_at: '2026-08-30T17:33:58.463Z'
```

C'est une opération en lot, pas une vérification. Le champ dit « quelqu'un a contrôlé cette
mémoire » ; il signifie en réalité « une commande a été passée sur tout le corpus d'un coup ».
**Un champ de confiance rempli en masse est pire que vide** : il éteint la question sans y
répondre. `validated_by: auto` sur 38 des 40 confirme que personne n'a rien relu.

---

## 3. LE FAIT NOUVEAU — les trois seuls capteurs qui se soient déclenchés étaient tous des faux positifs

C'est l'apport principal de ce rapport, et il n'est pas discutable : il est écrit dans les
métadonnées du corpus.

```bash
grep -l "last_fired: '2" .ai/memories/team/*.md
```

**Trois fichiers sur seize.** Les voici, avec ce qui les a déclenchés :

| Capteur | Motif | Ce qu'il a réellement bloqué | Verdict |
|---|---|---|---|
| `tri-de-chaines-sans-localecompare` | `\.sort\(\s*\)` | `[...palette.keys()].sort()` dans un test comparant des **identifiants ASCII** de jetons de couleur | **Hors domaine** — la règle vise les noms affichés à un humain |
| `jetons-de-conception-seule-source-des-couleurs` | palette Tailwind | Le **commentaire de `index.css` qui explique la règle**, citant `bg-emerald-600` comme contre-exemple | **Faux positif** |
| `tests-dependant-du-jour…fuseau-du-salon` | `LocalDate\.now\(\s*\)` | Un **javadoc** citant `LocalDate.now()` pour dire de ne pas l'employer | **Faux positif** |

**Treize capteurs sur seize ne se sont jamais déclenchés.** Les trois qui l'ont fait ont
bloqué : un test correct, un commentaire, et une documentation.

Le rapport du 29 août concluait déjà que les capteurs n'avaient rien produit. **Cinq sessions
plus tard, ils ont produit trois interruptions, toutes injustifiées.** Le bilan est passé de
neutre à négatif.

### 3.1 La cause est unique et corrigeable : le moteur ne distingue pas le code de la prose

Deux des trois déclenchements sont le même bug : **l'expression régulière est appliquée aux
lignes ajoutées du diff sans retirer les commentaires ni les chaînes de caractères.**

Message d'échec de la CI sur la PR #31 :

```
✗ sensor-block: Couleur de la palette Tailwind ecrite en dur …
  matched: <p>Ce bloc est la seule source des couleurs de l'application. Une classe
           `bg-emerald-600` ecrite
```

C'est un commentaire CSS. Coût : un cycle de CI complet, puis une reformulation de la prose.

**La conséquence est perverse et je l'ai vécue trois fois : l'outil punit le fait de
documenter la règle à côté du code qu'elle protège.** J'ai dû, à chaque fois, réécrire une
explication pour qu'elle cesse de nommer ce qu'elle interdit. C'est exactement l'inverse du
but recherché.

**Correctifs, du moins cher au plus cher :**

1. **Retirer commentaires et chaînes avant d'appliquer le motif.** Un dépouillement lexical
   par extension (`//`, `/* */`, `#`, `"""`, `<!-- -->`) couvre l'essentiel et se code en une
   heure. **C'est le correctif à plus fort rendement de tout ce rapport.**
2. Supprimer la correspondance quand la ligne appariée est un commentaire — plus simple encore,
   presque aussi efficace.
3. Faire du type `ast` le **défaut** pour les langages qu'`ast-grep` sait analyser. Il n'a pas
   ce problème par construction. Aujourd'hui rien n'y incite : la documentation le cite en
   second et l'exemple pré-rempli est toujours une regex.

Sans ce correctif, la trajectoire est écrite : les agents apprendront que les capteurs se
trompent, et les contourneront au lieu de les lire.

---

## 4. Défauts nouveaux, non encore signalés

### 4.1 — MAJEUR — Le classement sémantique ne discrimine plus rien

Les embeddings fonctionnent (progrès réel). Mais avec 40 mémoires, **presque tout dépasse
0,55** et le classement remonte les mêmes trois ou quatre mémoires quelle que soit la tâche.

Exemples réels, tirés des briefings de la dernière session :

| Tâche demandée | Mémoire remontée | Score | Pertinence réelle |
|---|---|---|---|
| Jetons de couleur CSS | Architecture des notifications Redis | 0,59 | **Nulle** |
| Devise et unités mineures | Architecture des notifications Redis | 0,66 | **Nulle** |
| Barre de navigation basse | SEO injecté par le backend | 0,62 | **Nulle** |
| Limite de débit sur le signalement | Cookie `httpOnly` de rafraîchissement | 0,58 | **Nulle** |

L'étendue observée est **0,44 – 0,70**, pour des pertinences allant de « exactement le sujet »
à « aucun rapport ». Un score qui vaut 0,6 pour tout ne trie rien.

`min_semantic_score` existe, mais son défaut est `0` et rien n'indique quel seuil employer. À
40 mémoires le problème est gênant ; à 200 le briefing sera du bruit intégral.

**À faire :** normaliser le score par rapport à la distribution du corpus plutôt que dans
l'absolu, ou n'admettre que les N premiers avec un écart minimal au suivant.

### 4.2 — MAJEUR — La CI ne dit rien quand elle refuse

Le job `hivelore-enforcement` écrit son JSON dans `$RUNNER_TEMP/hivelore-gate.json` — un
fichier que personne ne lit — puis sort en `exit 2`. Le log complet du job en échec :

```
##[group]Run exit 2
exit 2
##[error]Process completed with exit code 2.
```

**Aucune mention de la règle violée.** J'ai dû reproduire localement avec
`HIVELORE_BASE_SHA=… HIVELORE_HEAD_SHA=… hivelore enforce ci` pour l'apprendre. Un agent sans
accès à la machine est bloqué net.

**Correctif : deux lignes de YAML.** `cat` du JSON, ou écriture dans `$GITHUB_STEP_SUMMARY`.
C'est le meilleur rapport effort/gain du document après §3.1.

### 4.3 — MOYEN — Le flux impose une PR de documentation par PR de code

`mem_save` et `mem_session_end` écrivent **après** le commit, alors que la branche est déjà
fusionnée. Il faut donc systématiquement ouvrir une seconde PR pour faire atterrir les
mémoires et la resynchronisation.

**Sur la dernière session : 6 des 12 PR ne contenaient aucune ligne de code.** Chacune a coûté
un cycle de CI complet et une fusion.

**À faire :** un `hivelore sync --amend` qui ajoute les mémoires au dernier commit avant qu'il
ne parte, ou la possibilité pour `mem_session_end` d'écrire dans la branche courante.

### 4.4 — MOYEN — La sortie affiche la porte deux fois, avec des comptes différents

Sur presque chaque commit :

```
✓ Hivelore gate passed — 7 check(s), 0 issue(s).
✓ Hivelore gate passed — 6 check(s), 0 issue(s).
```

Parfois 5, parfois 7. Rien n'explique la différence. Après neuf sessions, je ne sais toujours
pas s'il s'agit de deux hooks, de deux passes, ou d'un défaut d'affichage.

---

## 5. Récidives — signalé deux ou trois fois, inchangé

Ce qui suit n'est pas nouveau. Sa persistance l'est.

### 5.1 `proposed_sensor_seed` — 7 propositions inutilisables sur 7

Le rapport du 29 août en documentait **4 sur 4**. En voici **3 de plus**, toutes de la
dernière session :

| Mémoire | Motif proposé | Ce qu'il ferait |
|---|---|---|
| Vitest neutralise le CSS | `virtual\s*:\s*["']?stylesheet["']?` | Mord sur **la solution**, pas sur le défaut |
| Vérifier dans un navigateur | `document\.title\s*=\s*["']?defilement["']?` | Mord sur ma propre ligne d'exemple |
| Devise et unités mineures | `nement\s*:\s*["']?lire["']?` | Fragment d'une phrase française |

**Total connu : 7 sur 7 inutilisables.** Le mécanisme extrait un fragment du **corps rédigé**
de la mémoire ; il ne regarde jamais le code. Il ne peut donc pas produire un motif valable,
sauf coïncidence.

Le risque n'est pas l'inutilité : c'est qu'un agent pressé le transmette tel quel. Et le
validateur ne rattraperait pas le premier de la liste — il est *silencieux sur le code actuel*
puisque ce code n'existe pas encore au moment de la proposition.

**Verdict inchangé depuis le 29 août : à retirer, pas à améliorer.**

### 5.2 Le résumé d'une mémoire reste sa première phrase

Signalé le 29 août (§6.1). Toujours vrai. Trois mémoires sont revenues, dans un briefing
`format: "actions"`, réduites à :

```
"Lot 8, livré le 2026-08-31. Dernier lot de la roadmap."
"Lot 7, livré le 2026-08-31."
"Lot 6, livré le 2026-08-30."
```

Le corps réel de la première fait 20 lignes et contient exactement ce qu'un agent doit savoir
avant de toucher à l'administration : aucune route ne supprime un avis, aucune ne promeut un
administrateur, suspendre doit révoquer les jetons de rafraîchissement. **Rien n'est arrivé
jusqu'à moi.**

Les mémoires dont le corps commence par une **liste à puces** reviennent correctement. Le
comportement est donc : *si le corps commence par de la prose, ne renvoyer que cette prose*.
C'est un défaut d'extraction, pas un choix.

**Une mémoire tronquée est pire qu'absente** : elle occupe la place et donne l'illusion d'avoir
été lue. Et le format imposé aux mémoires **encourage** ces phrases d'introduction.

### 5.3 La validation « brittle » force encore à écrire un motif plus large

Signalé le 27 août (§4.1). Fraîche récidive.

J'ai proposé un capteur contre la conversion d'un montant par une puissance de dix écrite en
dur — un vrai défaut, qui affichait « 5000.00 XOF » et **aurait envoyé un montant cent fois
trop grand à un prestataire de paiement** :

```
(priceCents|amountCents|revenueCents)\s*[/*]\s*100\b|\bmovePointLeft\(2\)
```

Refus :

> reason: "brittle" — hardcoded numeric literal "100" (likely a line number)

`100` est la **base décimale**, pas un numéro de ligne. Pour passer, j'ai écrit :

```
[Cc]ents\s*[/*]\s*1[0-9]{2}\b
```

qui accepte aussi `/ 120`, `/ 137`, `/ 199`. **Le validateur m'a fait remplacer un motif exact
par un motif approximatif.**

**À faire :** ne déclencher l'heuristique que si le nombre est isolé ou précédé d'un `:` — pas
quand un opérateur arithmétique le précède. Et permettre de passer outre avec une
justification, plutôt que de refuser sèchement.

### 5.4 Le score de santé et `decision-coverage-missing`

Signalé le 29 août (§6.2). Inchangé. À presque chaque `enforce check` :

```
⚠ decision-coverage-missing: 4/9 relevant anchored decisions were not present in the
  latest briefing …
  fix: Run `hivelore briefing --files "…douze chemins…" --max-memories 60 …`
⚠ enforcement-score-below-threshold: Repo knowledge-layer health 70% … it never blocks.
```

**J'ai obéi deux fois.** Le second briefing a coûté 8 500 jetons et remonté, entre autres,
l'architecture des notifications Redis — pour une tâche de jetons de couleur CSS. Il n'a rien
changé au travail.

Le contrôle mesure « l'agent a-t-il appelé `get_briefing` avec assez de fichiers ». C'est un
rituel, pas un résultat. Et le score annoncé **ne bloque jamais**, de son propre aveu.

### 5.5 Cinq fichiers passerelle identiques

Signalé le 29 août (§6.3). Inchangé.

`CLAUDE.md`, `AGENTS.md` et `GEMINI.md` font **9 753 octets chacun** et sont le même document.
Plus `.github/copilot-instructions.md` (9 754) et `.cursor/rules/haive-memories.mdc` (9 843).
**Cinq fichiers, ~48 Ko, un seul contenu**, tous modifiés à chaque `sync`.

### 5.6 Le récap est un upsert unique — l'historique est perdu

Signalé le 29 août (§6.4). Inchangé, et aggravé par l'usage : `revision_count: 12`.

Chaque session écrase la précédente. Je ne peux pas savoir ce qu'ont fait les trois sessions
d'avant. Et ce récap, devenu un document de ~3 000 jetons, est **renvoyé en entier en tête de
chaque briefing** : sur 5 briefings dans une session, j'ai payé cinq fois pour relire un texte
que je venais d'écrire.

**À faire :** un récap horodaté par session, et ne renvoyer dans le briefing que le champ
`next_steps` du dernier.

### 5.7 Le reçu de prévention est un compteur qui ne peut pas monter

Signalé le 29 août (§5). Inchangé. Sur **6 PR de code sur 6**, identique :

```
No documented sensor fired on this PR.
No repeat mistakes reached review in this window.
```

Le hook de pré-commit bloque en local : rien n'atteint jamais la revue. **Le reçu mesure une
grandeur que le produit s'emploie à maintenir nulle**, et en tire un commentaire sur chaque PR
— y compris les PR purement documentaires.

Ironie mesurable : trois capteurs **se sont** déclenchés cette session (§3), tous en local. Le
reçu affiche zéro. Il ne compte même pas ce qui s'est passé.

---

## 6. Ce qui vaut réellement — et qu'il ne faut pas casser

Le reste du document est sévère ; cette section ne l'est pas, et elle est sincère.

1. **La boucle de validation d'un capteur** (`silent_on_current` + `fires_on_bad`) est la
   meilleure idée du produit. Elle m'a empêché de poser deux règles inutilisables cette
   session : un motif qui ne mordait pas sur son propre exemple fautif, et un autre qui aurait
   mordu sur l'usage correct. Sans elle, les deux seraient en production. **Le refus désormais
   effectif quand `silent_on_current` est faux (§2) est une vraie amélioration.**

2. **La persistance des décisions de conception.** « Aucune route ne supprime un avis »,
   « Flyway est propriétaire du schéma », « l'état d'abonnement fait autorité chez Stripe » —
   ces règles ont survécu à neuf sessions et à plusieurs compactions de contexte. Sans elles,
   je les aurais réinventées, différemment, plusieurs fois.

3. **L'effet le plus réel n'est mesuré par rien.** Avoir les conventions sous les yeux à chaque
   démarrage a orienté mes choix. Je n'ai jamais abaissé le seuil de couverture, jamais codé un
   secret en dur, jamais modifié une migration appliquée — **non par vertu, mais parce que la
   règle était là**. Aucun compteur ne voit ça, et c'est pourtant le gain principal.

4. **`mem_tried`.** Le seul mécanisme qui empêche de refaire une impasse. Je ne l'ai appelé
   qu'une fois en neuf sessions : c'est un problème d'ergonomie, pas de concept. Rien ne me le
   rappelle au moment où j'abandonne une piste.

---

## 7. Ce qu'il faut retirer

| Élément | Pourquoi |
|---|---|
| `proposed_sensor_seed` | 7 propositions inutilisables sur 7, sur deux rapports. Invite à poser des règles fausses. |
| `decision-coverage-missing` | Mesure un rituel, pas un résultat. L'avertissement le plus fréquent et le moins actionnable. |
| Score « knowledge-layer health » | Ne bloque jamais, ne s'améliore qu'en appelant un outil en boucle. |
| Le *prevention receipt* | Compte une grandeur structurellement nulle, et poste un commentaire sur chaque PR. |
| 4 des 5 fichiers passerelle | Un seul contenu. Les autres en liens ou en génération à la demande. |

---

## 8. Priorités — cinq choses, par rendement décroissant

| # | Action | Effort | Gain |
|---|---|---|---|
| 1 | **Ignorer commentaires et chaînes dans les capteurs regex** | ~1 h | Supprime **les 3 déclenchements sur 3** observés en 5 jours, et cesse de punir la documentation |
| 2 | **Faire parler la CI** — `cat` du JSON dans le résumé du job | ~5 min | Débloque quiconque n'a pas la machine sous la main |
| 3 | **Corriger l'extraction `format: "actions"`** — renvoyer les puces, pas l'accroche | Faible | Les mémoires `must_read` arrivent enfin avec leur contenu. Signalé deux fois. |
| 4 | **Retirer les quatre éléments de bruit du §7** | Nul | Rend aux avertissements restants leur crédibilité |
| 5 | **Ne renvoyer que `next_steps` du récap dans le briefing** | Faible | Récupère ~2 000 jetons par briefing |

Les points 2, 4 et 5 coûtent moins d'une heure à eux trois et retirent plus de friction que
n'importe quelle fonctionnalité nouvelle.

---

## 9. Jugement de fond

**L'idée est juste et la vitesse de correction est réelle.** Quatre défauts critiques signalés
les 27 et 29 août sont corrigés au 1er septembre. Peu d'outils bougent aussi vite.

**Mais le produit a franchi un seuil qu'il faut nommer.** Au 29 août, le bilan des capteurs
était *neutre* : aucun n'avait rien produit. Au 1er septembre, il est **négatif** : les trois
seuls déclenchements de l'histoire du dépôt ont bloqué un test correct, un commentaire et une
documentation. Ce n'est plus une assurance qui dort, c'est un outil qui se trompe quand il
parle.

La cause est unique, identifiée, et corrigeable en une heure (§3.1). C'est une bonne nouvelle,
à condition de la traiter en premier.

**Le risque principal n'est pas technique, il est d'usure.** Un agent qui voit le même
avertissement inactionnable à chaque commit finit par ne plus lire aucun avertissement. Et un
agent qui s'est fait bloquer trois fois à tort apprend à contourner. Le jour où un capteur aura
raison, il sera dans le même flot que `enforcement-score-below-threshold`.

**Chaque signal qui ne mène à rien coûte de la crédibilité à ceux qui mènent à quelque chose.**
Si une seule chose devait être faite : **retirer du bruit et cesser de se tromper**. L'outil
gagnerait plus à en dire moins qu'à en faire plus.

---

## Annexe — reproduire les constats

```bash
cd <dépôt>

# §1  Taille du corpus
ls .ai/memories/team/*.md | wc -l
cat .ai/memories/team/*.md | wc -l
grep -h "^  *pattern:" .ai/memories/team/*.md | wc -l

# §2.1  Télémétrie
grep -h "verified_at:" .ai/memories/team/*.md | sort | uniq -c   # horodatages en lot
grep -c "last_read_at: null" .ai/memories/team/*.md | grep -vc ":0"
grep -l "validated_by: auto" .ai/memories/team/*.md | wc -l

# §3  Les seuls capteurs qui se soient déclenchés
grep -l "last_fired: '2" .ai/memories/team/*.md

# §4.2  Le log de CI muet
gh run view --job <id> --log | grep -A3 "Fail when enforcement blocked"

# §5.5  Les cinq fichiers passerelle
ls -la CLAUDE.md AGENTS.md GEMINI.md .github/copilot-instructions.md .cursor/rules/*.mdc

# §5.7  Le reçu, identique sur chaque PR
gh pr view <n> --json comments --jq '.comments[] | select(.body|test("prevention-receipt")) | .body'
```
