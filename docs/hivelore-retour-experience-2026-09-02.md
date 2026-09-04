# Hivelore — cinquième retour d'expérience

**Date** : 2026-09-02
**Auteur** : agent Claude Code (Opus 5), session longue sur `sandaga-monorepo`
**Posture** : `strict`, hooks `pre-commit` + `pre-push` actifs sur les deux dépôts

Ce document ne répète pas les quatre précédents. Il sépare trois choses :
ce qui est **nouveau**, ce qui **récidive malgré un signalement antérieur**, et
ce qui **marche et qu'il ne faut pas casser**. Chaque constat est reproductible ;
les commandes sont en annexe.

Le ton est direct parce que c'est ce qui a été demandé.

---

## 1. Assiette

Session de travail réel, pas d'évaluation à blanc. Sur environ dix heures :

| | |
|---|---|
| dépôts | `sandaga` (Spring Boot), `sandaga_frontend` (React) |
| commits | 12 (5 backend, 7 frontend) |
| pushes | 9 |
| invocations de porte | ~21 (`pre-commit` + `pre-push`) |
| PR ouvertes / fusionnées | 5 / 4 |
| corpus | 20 mémoires côté frontend |
| nature du travail | CI, qualité de code, couverture de tests, sécurité serveur, chiffrement de secrets |

Le point important : **je n'ai appelé aucun outil MCP Hivelore de toute la session.**
Non par choix — ils n'étaient pas disponibles. J'y reviens en §2, parce que c'est
le constat qui structure tout le reste.

---

## 2. Le constat central : la valeur ne passe pas par où la télémétrie regarde

### 2.1 Le serveur MCP n'a jamais été joignable, et ça n'a rien changé

Au démarrage :

```
haive (ENOENT): "Executable not found in $PATH: haive"
```

Le `.mcp.json` **racine** du monorepo déclare encore `haive`, alors que le binaire
s'appelle `hivelore` depuis le renommage. Les `.mcp.json` des deux sous-dépôts
sont corrects. Résultat : dans une session ouverte à la racine du monorepo —
le cas normal, puisque le travail traverse les deux dépôts — aucun outil Hivelore
n'existe.

C'est déjà signalé (retour du 2026-09-01, §sur le renommage). **Ce qui est
nouveau, c'est la conclusion à en tirer** : j'ai travaillé dix heures, produit
12 commits et 5 PR, et **l'absence totale de la couche MCP ne m'a pas coûté une
seule minute.** Pas parce que la couche est mauvaise, mais parce que toute la
valeur que Hivelore m'a réellement apportée transitait par un autre canal : le
fichier `CLAUDE.md` généré, injecté automatiquement dans mon contexte.

### 2.2 Ce fichier, lui, a servi

Extrait de ce que j'ai reçu sans rien demander :

```
- `2026-09-01-gotcha-cors-rejete-avant-authentification` (team/gotcha)
  — Symptome _(applies to: src/pages/auth/LoginPage.tsx)_
- `2026-08-26-reference-outillage-mcp-disponible` (team/convention)
  _(applies to: sonar-project.properties, .github/workflows/frontend-ci.yml)_
```

et surtout cette section, hors bloc régénéré :

> **SonarQube** (`https://stockinfini.com/sonar`, clé `sandaga-frontend`) — son API
> refuse l'accès anonyme, donc sans token il est impossible de savoir pourquoi un
> quality gate échoue autrement qu'en lisant les logs de CI. À ne pas confondre
> avec le check « SonarCloud Code Analysis » des PR, qui est une intégration
> distincte.

**Cette phrase m'a fait gagner du temps réel.** J'ai passé la session à
diagnostiquer un quality gate, et j'ai effectivement buté sur les deux pièges
qu'elle nomme : l'API Sonar m'a répondu `Insufficient privileges`, et le check
SonarCloud était bien une intégration séparée qu'aucune modification du dépôt ne
pouvait faire disparaître.

C'est un cas d'école de ce que Hivelore devrait faire : **une phrase de prose,
livrée sans être demandée, au bon moment.**

### 2.3 Et pourtant la télémétrie dit l'inverse

```
last_read_at : null   sur 20 mémoires / 20
last_fired   : renseigné sur 1 mémoire
```

Après cinq sessions d'usage, **zéro lecture enregistrée**. Les trois mémoires que
j'ai écrites la veille n'ont même pas le champ.

Le compteur qui prouverait la valeur est mort. Le seul compteur vivant est celui
du capteur — c'est-à-dire du mécanisme qui **coûte** du temps, pas de celui qui
en fait gagner.

**La cause est structurelle, pas un bug** : la valeur passe par le fichier
passerelle, que rien n'instrumente. `last_read_at` ne peut se remplir que via
`mem_get`, un outil qu'un agent n'appelle que s'il sait déjà qu'une mémoire
existe — donc après l'avoir lue dans la passerelle. Le compteur mesure une
seconde lecture redondante, pas la première qui compte.

**Ce qu'il faut faire** : instrumenter la passerelle, pas l'outil. Le générateur
sait quelles mémoires il vient d'écrire dans `CLAUDE.md` ; l'horodatage d'une
livraison est un signal plus honnête qu'un compteur d'appel MCP qui restera à
zéro pour toujours. À défaut, retirer `last_read_at` : un champ qui vaut `null`
partout après cinq sessions est une invitation à conclure que personne ne lit
le corpus, ce qui est **faux**.

---

## 3. Défauts nouveaux

### 3.1 — MAJEUR — L'écriture de `last_fired` a bloqué un changement de branche

C'est le seul incident de la session qui m'ait fait perdre du temps de façon
mesurable, et il vient d'un **correctif demandé dans un retour précédent**
(« Écrire la télémétrie dans les fichiers »).

Déroulé exact :

1. Un commit déclenche le capteur `no-any`.
2. Hivelore écrit `last_fired` dans
   `.ai/memories/team/2026-08-19-convention-typescript-no-any-prefer-unknown.md`,
   fichier **suivi par git**.
3. L'arbre de travail devient sale.
4. `git checkout develop` échoue :

```
error: Vos modifications locales aux fichiers suivants seraient écrasées :
	.ai/memories/team/2026-08-19-convention-typescript-no-any-prefer-unknown.md
Veuillez valider ou remiser vos modifications avant de basculer de branche.
Abandon
```

5. Le `checkout` ayant échoué, la commande suivante s'est exécutée **sur la
   mauvaise branche**. J'ai dû sauvegarder mon travail en patch, nettoyer,
   rebasculer, réappliquer.

Diff du fichier concerné, en entier :

```diff
-  last_fired: '2026-09-02T03:47:40.079Z'
+  last_fired: '2026-09-02T04:56:53.864Z'
```

**Une ligne d'horodatage a cassé une opération git.** Et j'ai dû produire un
commit dédié — `chore(hivelore): horodatage du capteur no-any` — dont le contenu
est cette seule ligne. C'est du bruit qui entre dans l'historique du client.

**Le problème de fond** : un outil qui s'exécute *pendant* `git commit` ne doit
pas modifier des fichiers *suivis par git*. C'est une règle, pas une préférence.

**Trois sorties possibles, par ordre de préférence :**

1. **Sortir la télémétrie du dépôt.** `.ai/telemetry.json` en `.gitignore`, ou
   `.git/hivelore/telemetry.json`. La donnée reste locale, ce qui est cohérent
   avec sa nature : elle décrit *mon* usage, pas la connaissance de l'équipe.
2. Si la télémétrie doit être partagée, l'écrire **hors du hook** — au
   `post-commit`, où l'arbre est stable et où une écriture ne casse rien.
3. À défaut, la **grouper** : un fichier unique horodaté une fois par jour plutôt
   que 20 fichiers touchés à chaque déclenchement.

Un correctif qui répond à une demande peut en créer un pire. Celui-ci en est un.

### 3.2 — MAJEUR — Les capteurs ne distinguent pas le code de test du code de production

Le retour du 2026-09-01 signale que le moteur « ne distingue pas le code de la
prose ». Voici un axe différent et non signalé : **il ne distingue pas non plus
un test d'un module applicatif.**

Le capteur `no-any-prefer-unknown` :

```yaml
sensor:
  kind: regex
  pattern: ':\s*any\b'
  paths:
    - '**'
```

s'est déclenché deux fois, sur ces lignes :

```tsx
default: ({ onUpdate, editable, profilePicture }: any) => (
t: (key: string, opts?: any) => (opts?.returnObjects ? [...] : key),
```

Ce sont des **doubles de test** — un faux composant React, un faux `useTranslation`.
Y écrire `unknown` obligerait à narrower chaque propriété d'un objet dont la forme
n'a aucune importance : le test deviendrait plus long et moins lisible pour zéro
sécurité, puisqu'aucune de ces valeurs n'atteint la production.

`paths: ['**']` est le vrai coupable. La convention est juste ; son périmètre ne
l'est pas.

**Ce qu'il faut faire :** que les capteurs livrés dans les *stack packs* portent
des exclusions par défaut, au minimum `**/__tests__/**`, `**/*.test.*`,
`**/*.spec.*`, `**/*.stories.*`, `**/*.d.ts`. Un capteur TypeScript qui ignore la
notion de fichier de test signalera toujours plus de faux positifs que de vrais.

Et pendant que la validation exige un motif « moins fragile » (§5.3 du retour
précédent), rien n'exige un périmètre défendable. **La validation contrôle la
mauvaise dimension.**

### 3.3 — MAJEUR — `hivelore enforce finish` est infranchissable, et son unique bloquant est inactionnable

Le `CLAUDE.md` généré m'ordonne :

> 5. **Before final response**, run `hivelore enforce finish` ; fix anything it
>    blocks before reporting done.

Exécution réelle, en fin de session :

```
✓ release-version-not-required
✓ github-actions-pass: All 2 GitHub Actions workflow run(s) for HEAD completed successfully.
✗ Hivelore enforcement gate failed.

→ NEXT REQUIRED ACTION  (bootstrap-incomplete)
  Invoke the bootstrap_repo MCP prompt …
```

Tout passe sauf une chose : `bootstrap-incomplete`. Et la correction proposée est
**d'invoquer un prompt MCP** — précisément la couche indisponible (§2.1).

Le résultat est une instruction impossible à respecter :

- la porte demande d'être franchie avant de répondre ;
- elle échoue toujours ;
- sa correction exige un outil absent ;
- donc l'instruction est ignorée — par moi cette session, et vraisemblablement
  par tout agent depuis cinq sessions.

**Une règle qu'on ne peut pas respecter n'éduque personne : elle apprend à
ignorer les règles.** C'est le coût réel, et il déborde sur les autres gardes-fous
d'Hivelore, qui perdent en crédibilité par contagion.

**Ce qu'il faut faire :** `bootstrap-incomplete` ne doit pas bloquer `finish`.
Bootstrapper un dépôt est un projet, pas un préalable à un commit de correctif.
Le distinguer du reste : `finish` vérifie que *cette* modification est propre —
CI verte, version cohérente —, pas que le dépôt a atteint un état idéal.

Et quand le MCP est injoignable, le message doit le dire, au lieu de prescrire un
outil absent.

### 3.4 — MOYEN — La porte s'exécute deux fois et parle beaucoup

Chaque `git commit` **et** chaque `git push` affichent le bandeau complet. Sur
21 invocations, avec 6 à 10 lignes à chaque fois, cela fait plus de 150 lignes
de sortie dont le contenu n'a **jamais changé** :

```
Hivelore enforcement — strict · agent (claude-code …)
  root: /home/sd/IdeaProjects/sandaga-monorepo/sandaga_frontend
  knowledge-layer health: 87% (target 85%)
⚠ briefing-missing: No recent Hivelore briefing marker was found for this workflow.
  fix: Run `hivelore briefing --task "..."` …
⚠ bootstrap-incomplete: First-agent bootstrap still pending …
  fix: Invoke the bootstrap_repo MCP prompt …
✓ Hivelore gate passed (pre-commit) — 2 advisory finding(s), 0 blocking.
```

Deux avertissements permanents, identiques, non actionnables, répétés vingt fois.
Pour un agent, c'est du contexte consommé pour rien. Pour un humain, c'est le
mécanisme exact par lequel on cesse de lire une sortie d'outil — et donc par
lequel on ratera le jour où elle dira quelque chose d'important.

**Ce qu'il faut faire :**
- un avertissement déjà affiché dans les 24 h ne se réaffiche pas ; un compteur
  suffit : `(2 avertissements persistants — hivelore doctor)` ;
- silence complet quand rien ne bloque et que rien n'a changé ;
- `pre-push` ne rejoue pas ce que `pre-commit` vient de valider sur le même SHA.

### 3.5 — MINEUR — `knowledge-layer health` varie sans explication

Relevé tel quel au fil de la session : **95 %**, puis **87 %**, sur le même dépôt,
sans qu'aucune mémoire n'ait été ajoutée ni retirée entre les deux. Le seuil
affiché est 85 %.

Un score qui bouge de 8 points sans cause visible, qui ne bloque jamais et dont
personne ne sait le faire monter, n'est pas une métrique : c'est de la décoration.
Déjà signalé deux fois. Toujours là.

---

## 4. Récidives — signalées, toujours présentes

Je les liste sans les redémontrer ; l'intérêt est de savoir qu'elles survivent.

| Constat | Signalé | État observé le 2026-09-02 |
|---|---|---|
| `.mcp.json` racine déclare `haive` | 2026-09-01 | inchangé — ENOENT à chaque session |
| `bootstrap-incomplete` en reproche perpétuel | 2026-09-01 | inchangé, et bloque désormais `finish` |
| `briefing-missing` sans correction praticable | 2026-09-01 | inchangé |
| Cinq fichiers passerelle quasi identiques | 2026-08-29 | toujours cinq : 50, 72, 50, 54, 54 lignes |
| Score de santé non actionnable | ×2 | inchangé |
| Télémétrie de lecture vide | ×2 | **aggravé** — 20/20 à `null` |

Sur les cinq passerelles : trois d'entre elles (`AGENTS.md`, `GEMINI.md`,
`.cursor/rules/haive-memories.mdc`) n'ont **jamais été lues par quoi que ce soit**
dans ce dépôt. Elles existent, sont régénérées, produisent des diffs, entrent
dans les PR. Coût réel, bénéfice nul tant qu'aucun agent Gemini ou Cursor ne
travaille ici. Génération à la demande — `hivelore bridges sync --targets=claude`
— plutôt que par défaut.

---

## 5. Ce qui marche vraiment, et qu'il ne faut pas casser

Je suis critique sur le reste ; ces trois points-là sont solides.

### 5.1 La passerelle `CLAUDE.md` — le produit, en fait

C'est le seul mécanisme qui ait produit de la valeur mesurable (§2.2). Il est
passif, sans dépendance réseau, sans appel d'outil, et il fonctionne même quand
tout le reste est cassé — ce qui a été le cas toute la session.

**Si une seule chose devait survivre à une refonte, c'est celle-là.** Et le
corollaire est inconfortable : la couche MCP, `get_briefing`, `mem_relevant_to`,
`code_map` n'ont rien apporté ici parce qu'elles n'ont pas tourné — et leur
absence est passée inaperçue. Cela devrait interroger l'investissement relatif
entre les deux.

### 5.2 L'annotation `applies to:`

```
`2026-09-01-gotcha-cors-rejete-avant-authentification` (applies to: src/pages/auth/LoginPage.tsx)
```

Voir un chemin de fichier à côté d'un titre change tout : je sais immédiatement
si la mémoire concerne ce que je touche. C'est ce qui distingue un index utile
d'une liste de titres. À généraliser, pas à réduire.

### 5.3 `github-actions-pass` dans `enforce finish`

```
✓ github-actions-pass: All 2 GitHub Actions workflow run(s) for HEAD completed successfully.
```

Vérifier que la CI est verte avant de déclarer un travail terminé attrape un
comportement réel et fréquent des agents : annoncer « c'est fait » sur un push
dont les gates tournent encore. C'est une vraie garde, sur un vrai défaut.

**Elle est actuellement rendue inutile par §3.3** : puisque `finish` échoue
toujours pour une autre raison, personne ne la lance, donc cette vérification-là
ne protège rien. Débloquer `finish` la rendrait immédiatement utile.

### 5.4 Le corpus lui-même

Les mémoires écrites sont justes et bien découpées. Les trois que j'ai ajoutées
la veille — piège nginx, traversée des uploads, rejet CORS avant authentification —
décrivent des incidents qui m'auraient coûté des heures à re-diagnostiquer. Le
format « symptôme → cause → règle » est le bon.

**Le problème n'est pas la connaissance stockée. C'est tout ce qui est bâti
autour.**

---

## 6. Ce qu'il faut retirer

Franchement, sans détour :

| À retirer | Pourquoi |
|---|---|
| `last_read_at` | `null` sur 20/20 après cinq sessions ; mesure la mauvaise chose |
| Le score `knowledge-layer health` | Ne bloque rien, varie sans cause, personne ne sait le faire monter |
| Les passerelles Gemini / Cursor / Copilot par défaut | Aucun consommateur dans ce dépôt ; du diff pour rien |
| `briefing-missing` | Répété 21 fois, jamais actionnable, jamais suivi d'effet |
| L'écriture de `last_fired` dans un fichier suivi | Casse `git checkout` (§3.1) |

Retirer ces cinq éléments ne coûterait aucune fonctionnalité et rendrait la
sortie lisible. **Un outil de contexte qui produit plus de bruit qu'il n'en
absorbe travaille contre son propre objectif.**

---

## 7. Priorités — cinq actions, par rendement décroissant

1. **Ne plus écrire dans des fichiers suivis pendant un hook git.** (§3.1)
   Un incident réel cette session. Correction : déplacer la télémétrie hors du
   dépôt. Coût faible, gain immédiat.

2. **Débloquer `enforce finish`.** (§3.3)
   Sortir `bootstrap-incomplete` des bloquants. Cela rend utilisable la seule
   garde qui attrape un vrai défaut d'agent (§5.3).

3. **Faire taire ce qui se répète.** (§3.4)
   Pas de réaffichage d'un avertissement inchangé ; silence quand rien ne bloque ;
   `pre-push` ne rejoue pas `pre-commit` sur le même SHA.

4. **Donner un périmètre aux capteurs des stack packs.** (§3.2)
   Exclure tests, stories et déclarations par défaut. Les faux positifs sont ce
   qui tue la crédibilité d'un linter, plus vite que les faux négatifs.

5. **Corriger `haive` → `hivelore` dans le `.mcp.json` racine.** (§2.1)
   Une ligne. Signalée deux fois. Elle prive de la couche MCP toute session
   ouverte à la racine d'un monorepo.

---

## 8. Jugement de fond

L'idée est juste. La preuve tient en une phrase : la ligne sur l'API Sonar dans
`CLAUDE.md` m'a évité une impasse réelle, et les mémoires nginx et CORS écrites
la veille auraient fait gagner des heures à qui aurait rencontré ces incidents
sans elles. **Le noyau — de la prose exacte, livrée sans être demandée, au moment
où elle sert — fonctionne.**

Mais ce noyau tient dans un fichier markdown généré. Tout le reste — le serveur
MCP, la télémétrie, le score de santé, les portes d'application, les cinq
passerelles — ne s'est pas contenté d'être inutile cette session : **une partie a
activement nui.** Un horodatage a cassé un `git checkout`. Une porte infranchissable
a appris à ignorer les portes. Deux avertissements permanents ont saturé vingt
sorties d'outil.

Le rapport est déséquilibré. Un outil dont la valeur passe par un fichier statique
et dont l'infrastructure produit des incidents devrait, provisoirement, faire
moins. Couper le bruit, retirer ce qui ne mesure rien, garder la passerelle et le
corpus, et ne réintroduire chaque brique qu'une fois qu'elle rapporte plus qu'elle
ne coûte.

La bonne nouvelle : les cinq actions du §7 sont toutes petites. Aucune ne demande
de repenser le produit. Elles demandent d'en **enlever**.

---

## Annexe — reproduire les constats

```bash
# §2.1  Le .mcp.json racine déclare encore haive
python3 -c "import json;print(json.load(open('.mcp.json'))['mcpServers'].keys())"
command -v haive || echo "absent du PATH"

# §2.3  Télémétrie de lecture : null partout
cd sandaga_frontend
grep -h "^last_read_at:" .ai/memories/*/*.md | sort | uniq -c

# §3.1  L'écriture de last_fired salit l'arbre
git status --short .ai/          # après un commit ayant déclenché un capteur
git diff .ai/memories/team/2026-08-19-convention-typescript-no-any-prefer-unknown.md

# §3.2  Le capteur no-any n'exclut aucun test
sed -n '/^sensor:/,/^tags:/p' \
  .ai/memories/team/2026-08-19-convention-typescript-no-any-prefer-unknown.md

# §3.3  enforce finish échoue sur un bloquant inactionnable
hivelore enforce finish; echo "code de sortie: $?"

# §3.4  La porte tourne en pre-commit ET pre-push
ls .git/hooks/ | grep -vE '\.sample$'

# §4  Cinq passerelles
wc -l AGENTS.md CLAUDE.md GEMINI.md \
      .github/copilot-instructions.md .cursor/rules/haive-memories.mdc
```
