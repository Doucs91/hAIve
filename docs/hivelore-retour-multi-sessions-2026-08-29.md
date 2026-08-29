# Hivelore — retour après cinq sessions et cinq lots livrés

**Période :** 2026-08-27 → 2026-08-29. **Agent :** Claude Opus 5 via Claude Code.
**Projet :** BarberBook, monorepo Spring Boot 4 / React 19, développé de zéro.

Deux retours existent déjà dans ce dossier. Celui-ci ne les répète pas : ils décrivaient
des sessions isolées. Celui-ci répond à la seule question qu'ils ne pouvaient pas poser —
**est-ce que la valeur tient dans la durée, une fois qu'on a 25 mémoires et 11 sensors ?**

La réponse courte : **le récap de session tient et vaut le produit à lui seul. Les sensors
ne tiennent pas.** Le détail suit.

---

## 1. Ce que l'échantillon vaut

| | |
|---|---|
| Sessions | 5, sur 3 jours |
| Lots livrés | 0 à 4 (fondations, profil barbier, moteur de créneaux, réservation, découverte) |
| PR fusionnées | 8 |
| Commits sur `develop` | 22 |
| Mémoires créées | 25 |
| Sensors posés | 11, tous `regex` |
| Tests à l'arrivée | 248 backend, 246 frontend |

C'est un usage intensif et continu, avec reprise de session à froid quatre fois. Exactement
le cas d'usage que Hivelore vise.

---

## 2. Ce qui a réellement payé

### 2.1 Le récap de session — la seule fonctionnalité qui a payé à tous les coups

Quatre reprises à froid, quatre fois zéro re-exploration. Je n'ai jamais eu à relire le
code pour savoir où j'en étais, ce qui était décidé, ni ce qui restait ouvert.

C'est d'autant plus vrai que le récap porte trois choses que rien d'autre ne porte :

- **les découvertes** (les bugs trouvés en chemin, qui ne sont écrits nulle part ailleurs) ;
- **les questions en attente du développeur**, que j'ai pu lui reposer sans qu'il ait à s'en
  souvenir ;
- **les points d'accroche laissés exprès** (« les boutons de créneau sont inertes, c'est là
  qu'on branche le lot 3 »).

Si vous ne gardez qu'une chose du produit, gardez ça.

### 2.2 Deux mémoires ont changé ma conception, pas seulement mon information

C'est la différence entre « utile » et « décoratif », et je veux être précis parce que
c'est votre proposition de valeur qui se joue là.

**`2026-08-27-decision-refresh-token-en-cookie-httponly`** disait, écrite par une session
précédente :

> CSRF : un cookie est envoyé automatiquement par le navigateur, donc la protection CSRF
> actuellement désactivée redevient nécessaire **au moins sur les endpoints qui lisent ce
> cookie**. Ne pas oublier ce point, c'est le piège classique de cette migration.

J'ai implémenté la migration avec la protection CSRF dès le premier jet. Sans cette phrase,
je l'aurais très probablement livrée sans, et le trou aurait été trouvé en revue de sécurité
ou jamais. **C'est le produit qui fonctionne comme annoncé.**

**`2026-08-27-decision-node-24-lts-partout`** m'a évité d'éditer
`.github/workflows/hivelore-*.yml`, qui sont régénérés et auraient été écrasés. Je n'avais
aucun moyen de le deviner.

### 2.3 L'ancrage par chemin

Les mémoires ancrées sur des fichiers remontent au bon moment. Toucher
`domain/availability/BusinessHours.java` a fait remonter le gotcha sur le décalage des
colonnes `TIME` — que j'aurais pu défaire en le prenant pour une précaution de style.

Le ranking sémantique, une fois l'index construit, sort des mémoires pertinentes. Sans
l'index (`literal_fallback`), la qualité chute nettement mais reste exploitable.

---

## 3. Ce qui n'a rien produit : les sensors

### 3.1 Le chiffre

**11 sensors. 22 commits. 6 PR. Un seul déclenchement.**

Le seul : `convention-frontend-api-same-origin` a bloqué `http://localhost:5180` écrit en dur
dans une fixture de test frontend (PR #13). Le blocage était juste sur le fond — le port du
poste n'a rien à faire dans un test — mais c'était une fixture d'affichage, pas un appel API.
Le sensor a eu raison par accident.

Le gate pre-commit a affiché « gate passed — 7 checks, 0 issues » à **chaque** commit.

### 3.2 Ce qui a réellement attrapé les défauts de ces cinq lots

Cinq vrais défauts, tous trouvés, aucun par Hivelore :

| Défaut | Trouvé par |
|---|---|
| PostgreSQL renvoie un **interblocage** et non une violation de contrainte sur insertions concurrentes → le client recevait un 500 au lieu de « créneau pris » | un test de concurrence que j'ai écrit |
| `.sort()` sans `localeCompare` → « Égypte » classée après « Zimbabwe » dans une liste de 245 pays | SonarCloud |
| `process.env` dans un test → `tsc -b` passe en local (cache), casse en CI | le build CI |
| Paramètre nul dans une requête → `function lower(bytea) does not exist` | une vérification sur serveur réel |
| Toute route inconnue répondait 401 au lieu de 404 → déconnectait l'utilisateur | une vérification sur serveur réel |

Aucun de ces défauts n'était exprimable en regex sur des lignes ajoutées. Ce n'est pas un
hasard : **les défauts qui coûtent cher sont rarement des motifs syntaxiques.**

### 3.3 `proposed_sensor_seed` : inutilisable, quatre fois sur quatre

À chaque `mem_save` d'un gotcha, l'outil propose un motif. Voici les quatre reçus, tels
quels :

| Leçon | Motif proposé | Verdict |
|---|---|---|
| `jdbc.time_zone` décale les colonnes TIME | `hibernate\.jdbc\.time_zone\s*:\s*["']?UTC["']?` | se déclenche sur le code **correct** |
| Le post-processor `csrf()` contamine la chaîne de filtres | `test\s*:\s*["']?une["']?` | absurde |
| `.sort()` sans `localeCompare` | `localeCompare\s*:\s*["']?Albanie["']?` | absurde |
| Vérifier avec `pnpm build`, pas `tsc -b` | `expect\(new Date\(\)\.getTimezoneOffset\(\)\)\.not\.toBe\(0` | cible le garde-fou, pas le défaut |

Le mécanisme extrait manifestement une chaîne au hasard du **corps de la mémoire**, pas du
code fautif. Deux des quatre motifs auraient bloqué du code correct.

C'est pire qu'inutile : ça pousse à accepter un sensor qui ne veut rien dire, et l'agent
pressé le fera. **À retirer, pas à améliorer.**

### 3.4 Un sensor non discriminant est accepté quand même

Pour la leçon sur `jdbc.time_zone`, `propose_sensor` a répondu :

```json
"accepted": true,
"self_check": { "silent_on_current": false, "fires_on_bad": true }
```

L'outil constate que le sensor se déclenche sur le code correct, le dit, **et l'accepte**.
En `warn`, certes. Mais un avertissement qui se déclenche sur du code juste est du bruit que
les agents suivants apprendront à ignorer — et ils l'ignoreront aussi le jour où il aura
raison.

Un sensor non silencieux sur le code actuel devrait être **refusé**, avec le message qui
explique pourquoi.

### 3.5 Le défaut structurel : on ne peut pas surveiller une suppression

La leçon la plus importante que j'ai écrite est :

> Ne pas retirer `TimeZone.setDefault(TimeZone.getTimeZone("UTC"))` de `ClockConfig` en
> croyant à une précaution de style : c'est ce qui empêche le décalage.

Le risque, c'est qu'on **efface** cette ligne. Un sensor regex sur les lignes **ajoutées**
ne peut pas le voir. La leçon la plus chère du projet est structurellement inapplicable.

Il faudrait un type de sensor « cette ligne / ce symbole doit rester présent dans ce
fichier ». C'est simple à implémenter (grep sur l'état final, pas sur le diff) et ça
couvrirait une classe entière d'invariants que le mécanisme actuel rate.

---

## 4. La télémétrie est entièrement morte

C'est le constat le plus objectif du document, et le plus embêtant.

Après trois jours d'usage intensif, dans les 25 fichiers de mémoire versionnés :

| Champ | Renseigné |
|---|---|
| `last_read_at` | **0 / 25** |
| `last_fired` | **0 / 11** sensors |
| `stale_reason` | **0 / 25** |
| `verified_at` | **1 / 25** |
| `revision_count` | **2 / 25** |
| `read_count` | **absent des fichiers** |

`get_briefing` renvoie pourtant `read_count: 5` pour `convention-frontend-api-same-origin`,
et le sensor de cette même mémoire **a bloqué la CI**. Rien n'est écrit dans le fichier.

Conséquences concrètes :

1. **On ne peut pas élaguer.** Impossible de savoir, depuis le dépôt, quelles mémoires ont
   servi et lesquelles dorment. Sur mes 25, j'estime que 10 n'ont jamais été remontées une
   seule fois — mais je ne peux pas le prouver, et l'équipe non plus.
2. **La machinerie de péremption n'a aucune entrée.** `expires_when`, `stale_reason`,
   `verified_at`, `decay_warnings` : tout repose sur des compteurs qui ne sont jamais écrits.
3. **Un clone neuf part à zéro.** Le compteur vit dans un index local. Un coéquipier qui
   clone le dépôt hérite des mémoires sans aucune notion de leur valeur.

Si vous ne corrigez qu'une chose techniquement, corrigez celle-là : **écrire les compteurs
dans les fichiers**. Sans eux, la moitié des fonctionnalités du cycle de vie sont des
coquilles.

---

## 5. Le reçu de prévention s'efface lui-même

Sur la PR #13, après que le sensor a bloqué, le commentaire disait :

```
### Fired on this PR
- 2026-08-27-convention-frontend-api-same-origin — frontend/src/api/barber.test.ts
  — Block sensor fired
**1 repeat mistake refused before it reached review.**
_Trend: 1 this window vs 0 previous window (recurrences rising)._
```

J'ai corrigé, poussé. Le commentaire est **mis à jour en place** et dit maintenant :

```
No documented sensor fired on this PR.
No repeat mistakes reached review in this window.
```

Vérifié à l'instant sur les PR #9, #11, #13 et #14 : **aucune ne garde trace du seul
blocage utile de tout le projet.**

Le reçu est censé être la preuve de valeur du produit. Il efface la seule preuve qu'il
avait. Il faut soit historiser (« a bloqué X, corrigé au commit Y »), soit ne pas écraser.

Accessoirement : « Trend: 1 this window vs 0 previous window (recurrences rising) » sur un
échantillon de 1 — c'est du bruit statistique présenté comme une tendance. Ça décrédibilise
le reste du message.

---

## 6. Frictions quotidiennes

### 6.1 Le résumé d'une mémoire est sa première ligne

En format `compact` ou `actions`, plusieurs mémoires remontent avec un corps inutile parce
que leur première ligne est une phrase d'introduction :

- `gotcha-spring-boot-4-slices-et-colonnes-char` → « Trois pieges rencontres en ecrivant la
  couche JPA (2026-08-27): »
- `decision-slug-suit-le-nom-du-salon-et-resout-a-vie` → « Regles du profil public arretees
  au lot 1 (2026-08-28). »
- `convention-contrat-auth-401-403-et-rotation` → « Contrat d'authentification arrete au
  lot 0 (2026-08-27). »

Trois mémoires importantes réduites à une accroche vide. J'ai dû faire un `mem_get` pour
chacune, ce qui annule l'économie de tokens visée par ces formats.

Le format de mémoire imposé encourage pourtant ces phrases d'intro. Soit vous demandez que
la première ligne soit l'information elle-même, soit vous extrayez le résumé autrement.

### 6.2 Le score de santé demande de gonfler une métrique

`hivelore enforce check` affiche à chaque fois :

```
knowledge-layer health: 75% (target 85%)
⚠ decision-coverage-missing: 3/9 relevant anchored decisions were not present
  in the latest briefing
  fix: Run `hivelore briefing --files "<12 fichiers>" --max-memories 60 ...`
```

Le correctif proposé consiste à **relancer un briefing avec une longue liste de fichiers
pour faire monter un compteur**. Ça n'améliore pas le code d'un iota. Ça mesure si j'ai
bien récité le catéchisme, pas si mon travail est meilleur.

Le message précise qu'il ne bloque jamais. Alors il ne devrait pas être affiché à chaque
exécution — c'est trois lignes de bruit sur chaque commit, et le bruit finit par masquer les
messages qui comptent.

### 6.3 Cinq fichiers passerelle identiques

`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`,
`.cursor/rules/haive-memories.mdc` : **80 lignes chacun, identiques au titre près**.

Vérifié : les trois premiers ne diffèrent que par leur `# H1`.

**12 commits** du projet touchent ces fichiers. Ils apparaissent dans des PR qui n'ont rien
à voir, et sur celle du lot 4 le diff de `hivelore sync` était mêlé au code métier.

Un fichier canonique et quatre pointeurs d'une ligne feraient le même travail sans le bruit.

### 6.4 L'identifiant du récap est figé à sa date de création

Trois jours et trois révisions plus tard, le récap s'appelle toujours
`2026-08-27-session_recap-recap`. Un humain qui parcourt `.ai/memories/team/` lit une date
fausse sur le document le plus à jour du dossier. Les mémoires normales ont le même
problème dès qu'on les met à jour.

### 6.5 Disponibilité de l'outil

Une session entière s'est déroulée avec le serveur MCP en échec (`haive (ENOENT):
Executable not found in $PATH: haive-mcp`) **et** le CLI absent du PATH. Or `CLAUDE.md`,
généré par Hivelore, m'ordonne :

> **Before final response**, run `hivelore enforce finish`; fix anything it blocks before
> reporting done.

Une instruction obligatoire, impossible à exécuter, sans qu'aucun message ne le signale
autrement que par l'échec de connexion au démarrage. J'ai dû le dire au développeur et
continuer sans.

### 6.6 `hivelore` ou `haive` ?

Le serveur MCP s'appelle `hivelore`. Celui qui a échoué s'appelait `haive`. Les fichiers
générés contiennent `<!-- haive:bridge-start -->`, `<!-- haive:sensors-end -->`,
`.cursor/rules/haive-memories.mdc`, `<!-- haive:prevention-receipt -->`. Le dépôt est
`Doucs91/hivelore`. Trois jours plus tard je ne sais toujours pas si c'est le même produit
sous deux noms ou deux choses distinctes.

---

## 7. Ce qu'il faut retirer

Par ordre de nuisance décroissante :

1. **`proposed_sensor_seed`.** Quatre propositions sur quatre étaient inutilisables, dont
   deux auraient bloqué du code correct. Un agent pressé les acceptera.
2. **Le score de santé et `decision-coverage-missing`** dans la sortie de `enforce check`.
   Ne bloque jamais, propose de gonfler un compteur, s'affiche à chaque commit.
3. **La ligne de tendance du reçu de prévention** tant que l'échantillon est en unités.
4. **Quatre des cinq fichiers passerelle.** Un canonique, des pointeurs pour le reste.

---

## 8. Priorités, si j'avais à les classer

1. **Écrire la télémétrie dans les fichiers** (`last_read_at`, `last_fired`). Sans elle,
   l'élagage, la péremption et la preuve de valeur sont tous inopérants. C'est le socle.
2. **Un type de sensor « présence obligatoire »**, évalué sur l'état final et non sur le
   diff. Débloque toute la classe des invariants « ne pas supprimer ceci ».
3. **Refuser un sensor non silencieux sur le code actuel.** Aujourd'hui il est accepté en
   `warn`, ce qui fabrique du bruit que les agents apprendront à ignorer.
4. **Retirer `proposed_sensor_seed`.**
5. **Corriger l'extraction du résumé** des mémoires, ou exiger que la première ligne porte
   l'information.
6. **Historiser le reçu de prévention** au lieu de l'écraser.

---

## 9. Le jugement de fond

**L'intuition du produit est juste.** Une mémoire écrite par l'agent, pour l'agent, ancrée
sur des fichiers, remontée au bon moment, avec le *pourquoi* — ça marche. Je l'ai vérifié :
le piège CSRF annoncé par une session précédente m'a fait livrer une migration correcte du
premier coup. Aucun fichier `README` n'aurait produit ça, parce que personne ne lit un README
au moment où il touche `AuthController`.

**L'exécution des garde-fous ne suit pas.** Onze sensors, un déclenchement, et pas un seul
des cinq vrais défauts de ces cinq lots. Le mécanisme regex-sur-diff attrape ce qu'une revue
de code attrape déjà, et rate ce qui coûte cher. Le produit se raconte à lui-même une
histoire de prévention — dans le reçu de PR, dans le score de santé — que ses propres
chiffres ne soutiennent pas.

Il y a deux produits ici. **Le premier — mémoire de session ancrée et transmise — est
excellent et sous-vendu.** Le second — le gate déterministe — est survendu et, en l'état,
surtout du cérémonial.

Si je devais choisir : assumez le premier, réduisez le second à ce qu'il fait vraiment bien
(les invariants syntaxiques réellement récurrents : secrets en dur, artefacts générés,
imports interdits), et arrêtez de compter les préventions tant que le compteur ne mesure
rien.

---

## Annexe — comment reproduire les constats principaux

**Télémétrie morte** — dans un dépôt utilisé plusieurs sessions :

```bash
grep -c "last_read_at: null" .ai/memories/team/*.md | grep -v ":0"
grep -c "last_fired: null"   .ai/memories/team/*.md | grep -v ":0"
```

Attendu si le problème est corrigé : les mémoires réellement lues ou déclenchées portent une
date.

**Reçu qui s'efface** — faire échouer un sensor sur une PR, constater le commentaire, puis
corriger et repousser. Le commentaire perd la trace du blocage.

**Graine de sensor inutilisable** — appeler `mem_save` avec un `type: gotcha` dont le corps
contient un exemple de code, et lire `proposed_sensor_seed`.

**Fichiers passerelle identiques** :

```bash
md5sum CLAUDE.md AGENTS.md GEMINI.md   # diffèrent, mais uniquement par le titre
diff <(tail -n +2 CLAUDE.md) <(tail -n +2 AGENTS.md)   # vide
```
