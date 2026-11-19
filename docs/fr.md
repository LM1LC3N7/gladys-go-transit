# GO Transit

Les prochains départs de vos gares GO Transit (région de Toronto), leurs retards et leurs voies,
et les alertes de service du réseau, depuis l’API GO officielle de Metrolinx.

> Contient des informations sous licence Open Government Licence – Ontario – Metrolinx
> ([licence](https://assets.metrolinx.com/image/upload/v1663237565/Documents/Metrolinx/Open-Government-Licence-Ontario-Metrolinx.pdf)).
> Cette intégration est sans lien avec Metrolinx. Elle n’a jamais été testée avec une vraie clé :
> les formats viennent de la documentation de l’API (pages d’aide et exemples), et les premiers
> utilisateurs peuvent rencontrer un champ que les exemples ne montraient pas. En bref : jamais
> testé avec une vraie clé.

## 1. Obtenir une clé

1. Remplissez le [formulaire d’inscription](https://api.openmetrolinx.com/OpenDataAPI/Help/Registration/en)
   de l’API GO (gratuit). Metrolinx traite les demandes à la main : jusqu’à dix jours ouvrables.
2. La clé arrive par e-mail. Elle n’expire pas, mais Metrolinx désactive à la main une clé qui
   appelle trop. L’intégration s’impose donc ses propres limites (plus bas).

## 2. Configurer

- **Clé de l’API GO** : collez la clé. Gardée par Gladys dans sa base, jamais réaffichée, envoyée
  seulement à `api.openmetrolinx.com` (dans l’adresse de chaque appel, comme l’API le demande),
  jamais écrite dans les journaux, le statut ni les fichiers de l’intégration.
- **Gares et arrêts** : les codes GO, séparés par des virgules, 6 au plus : `UN` pour Union
  Station, `OA` pour Oakville… Le bouton **Chercher une gare** en bas de la page donne les codes (il
  lit la liste des gares une fois, puis la garde une semaine ; au plus une lecture toutes les
  30 s). Après le code, un filtre de lignes
  facultatif (`@LW`, plusieurs joints par `+` : `@LW+LE`) et un nom (`:Oakville vers le travail`) :
  `UN, OA@LW:Oakville vers le travail`.
- **Suivre les alertes de service** : propose l’appareil des alertes. **Lignes des alertes** :
  seulement les alertes de ces lignes (`LW, LE`) ; vide, toutes les alertes.
- **Avancé** : le rafraîchissement des départs (60 s par défaut, 60 s au moins), des alertes (300 s,
  120 s au moins), le nombre de départs par gare (1 à 5), la langue des valeurs (Metrolinx écrit les
  alertes en anglais et en français).

Ouvrez ensuite l’onglet **Découverte** et ajoutez vos gares et l’appareil des alertes. Seuls les
appareils ajoutés sont lus : une gare laissée dans l’écran Découverte ne coûte rien.

## 3. Ce que vous obtenez

Pour chaque gare :

- **Prochain départ**, **Départ 2**… : minutes d’attente (999 quand il n’y a pas de départ à ce
  rang).
- **Ligne du …** : ligne et direction (`LW - Aldershot GO`).
- **État du …** : `À l'heure`, `+5 min`, `2 min d'avance`, `Annulé`, ou `Horaire prévu` quand l’API
  ne donne que l’heure de l’horaire ; puis la voie quand elle est connue (`Voie 4`).
- **Prochains départs** : une ligne pour un tableau de bord
  (`LW 17:23 +5 min · Voie 4 | LE 17:30 À l'heure`), à l’heure de Toronto.

L’appareil des **alertes** : **Alertes en cours** (nombre, des lignes suivies) et **Dernière
alerte** (son objet).

Le widget **Départs GO** du tableau de bord montre le tableau d’une gare, décompté depuis la
dernière lecture.

Quand une gare n’a pas été lue depuis 15 minutes (ou deux fois son intervalle de rafraîchissement,
s’il est plus long), ses comptes à rebours passent à 999, ses textes sont vidés et **Prochains
départs** indique `Aucune lecture récente` ; le widget n’affiche rien non plus. C’est aussi le cas
après un redémarrage qui ne peut pas lire (pause, clé refusée). Une réponse dont l’heure propre
s’écarte de plus de 10 minutes de l’horloge du serveur (ou de l’hôte) est un vieil instantané : ni
publiée ni utilisée pour les scènes, et le statut le dit.

### Scènes

- **Départ GO en retard** : un départ d’une gare a au moins 5, 10, 15 ou 30 minutes de retard, ou
  est annulé. Une fois par départ et par seuil (un départ qui passe de 0 à 12 minutes déclenche 5 et
  10). Filtres : gare, événement, seuil, ligne. Variables : ligne, direction, numéro de trajet,
  retard, minutes d’attente, heures, état.
- **Nouvelle alerte GO** : Metrolinx a publié une alerte pour une ligne suivie, un événement par
  ligne de l’alerte (5 au plus). La première lecture après l’installation apprend seulement les
  alertes déjà présentes, pour ne pas toutes les recevoir d’un coup. Les alertes déjà annoncées sont
  retenues d’un redémarrage à l’autre.

## 4. Limites tenues par l’intégration

- **Un appel à la fois**, et **450 appels par heure glissante** au plus, tous ensemble, comptés
  avant chaque appel et gardés au redémarrage (6 gares chaque minute et les alertes toutes les
  5 minutes font 372).
- Chaque source est lue **une fois par intervalle**, redémarrages compris.
- Après un **429**, un **5xx**, aucune réponse en **10 s** ou une réponse illisible : tous les
  appels font une pause de 1 minute, puis 2, 4… jusqu’à 6 heures (`Retry-After` respecté), gardée
  au redémarrage. Un succès remet l’échelle à zéro.
- Réponses bornées : 512 Ko (2 Mo pour la liste des gares), coupées au-delà.
- **Clé refusée** (403 alors que la clé n’a rien lu d’autre, ou 401) : les lectures s’arrêtent, et le
  statut le dit. Retenu dans `/data` sous forme de 8 bits d’une empreinte salée, jamais la clé. Levé
  par une nouvelle clé ou un clic réussi sur **Tester la clé**. Enregistrer à nouveau la même clé ne
  la renvoie pas. Limite rare : après un redémarrage, une nouvelle clé dont la marque de 8 bits
  correspond à celle refusée (1 chance sur 256) attend un clic sur **Tester la clé**.
- Un 403 sur un type de données alors que la clé lit l’autre (la clé a perdu un droit) : seul ce
  type attend, 2 minutes doublées jusqu’à 1 heure.
- **Tester la clé** : une fois par minute au plus ; compte dans la limite horaire et n’est pas
  envoyé pendant une pause (la réponse le dit).
- Un code de gare inconnu de l’API est redemandé toutes les 30 minutes, et nommé dans le statut.
- `/data` illisible : aucun appel tant qu’il ne l’est pas (relu toutes les 10 s) ; rien n’est écrit
  par-dessus.

## 5. Messages d’état

L’écran Configuration dit quoi faire : ajouter la clé, clé refusée, pause et sa durée, plafond
horaire atteint, codes ignorés, gares inconnues de l’API, pas d’accès aux alertes.

## Vie privée

Le seul service appelé est `api.openmetrolinx.com`. La position de votre maison n’est jamais lue.
