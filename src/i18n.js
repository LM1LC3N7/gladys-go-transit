// -----------------------------------------------------------------------------
// Every text the user reads, in English and French: feature names, the values
// published, the status line and the answers of the buttons.
// -----------------------------------------------------------------------------

export const LABELS = {
  en: {
    departure: (n) => (n === 1 ? 'Next departure' : `Departure ${n}`),
    line: (n) => (n === 1 ? 'Next departure line' : `Departure ${n} line`),
    status: (n) => (n === 1 ? 'Next departure status' : `Departure ${n} status`),
    summary: 'Next departures',
    alertsDevice: 'GO Transit – Service alerts',
    alertCount: 'Active alerts',
    latestAlert: 'Latest alert',
    noAlert: 'No alert',
    stop: 'GO',
    none: 'No upcoming departure',
    onTime: 'On time',
    late: (m) => `+${m} min`,
    early: (m) => `${m} min early`,
    cancelled: 'Cancelled',
    scheduled: 'Scheduled',
    platform: (p) => `Pl. ${p}`,
  },
  fr: {
    departure: (n) => (n === 1 ? 'Prochain départ' : `Départ ${n}`),
    line: (n) => (n === 1 ? 'Ligne du prochain départ' : `Ligne du départ ${n}`),
    status: (n) => (n === 1 ? 'État du prochain départ' : `État du départ ${n}`),
    summary: 'Prochains départs',
    alertsDevice: 'GO Transit – Alertes de service',
    alertCount: 'Alertes en cours',
    latestAlert: 'Dernière alerte',
    noAlert: 'Aucune alerte',
    stop: 'GO',
    none: 'Aucun départ à venir',
    onTime: "À l'heure",
    late: (m) => `+${m} min`,
    early: (m) => `${m} min d'avance`,
    cancelled: 'Annulé',
    scheduled: 'Horaire prévu',
    platform: (p) => `Voie ${p}`,
  },
};

/** The status line and the answers of the buttons ({ en, fr }). */
export const MESSAGES = {
  noKey: {
    en: 'Add your GO API key (free, from Metrolinx) in the configuration.',
    fr: 'Ajoutez votre clé de l’API GO (gratuite, auprès de Metrolinx) dans la configuration.',
  },
  keyMalformed: {
    en: 'The API key holds characters a GO key never has (space, quote…): type it again.',
    fr: 'La clé d’API contient des caractères qu’une clé GO n’a jamais (espace, guillemet…) : saisissez-la à nouveau.',
  },
  keyRefused: {
    en: 'Metrolinx refuses this API key (403): reads stopped. Check the key, or ask Metrolinx whether it was switched off, then save it again or click “Test the key”.',
    fr: 'Metrolinx refuse cette clé d’API (403) : lectures arrêtées. Vérifiez la clé, ou demandez à Metrolinx si elle a été désactivée, puis enregistrez-la à nouveau ou cliquez sur « Tester la clé ».',
  },
  dataUnreadable: {
    en: 'The integration state in /data cannot be read: no call is made until it can (read again every 10 s).',
    fr: 'L’état de l’intégration dans /data est illisible : aucun appel tant qu’il ne l’est pas (relu toutes les 10 s).',
  },
  configUnread: {
    en: 'The configuration could not be read from Gladys: asked again shortly.',
    fr: 'La configuration n’a pas pu être lue depuis Gladys : redemandée sous peu.',
  },
  paused: (minutes) => ({
    en: `GO API unavailable or busy: calls paused for ${minutes} min.`,
    fr: `API GO indisponible ou saturée : appels en pause pendant ${minutes} min.`,
  }),
  budget: {
    en: 'Hourly call limit of the integration reached: the reads resume within the hour.',
    fr: 'Plafond horaire d’appels de l’intégration atteint : les lectures reprennent dans l’heure.',
  },
  nothingCreated: {
    en: 'Key saved. Open the “Discover” tab and add your stops (and the alerts device).',
    fr: 'Clé enregistrée. Ouvrez l’onglet « Découverte » et ajoutez vos gares (et l’appareil des alertes).',
  },
  ok: (read, total) => ({
    en: `Connected to the GO API: ${read}/${total} source(s) read.`,
    fr: `Connecté à l’API GO : ${read}/${total} source(s) lue(s).`,
  }),
  waiting: {
    en: 'Waiting for the first reading.',
    fr: 'En attente de la première lecture.',
  },
  allFailing: {
    en: 'No source could be read: see the integration logs.',
    fr: 'Aucune source n’a pu être lue : voir les journaux de l’intégration.',
  },
  invalidStops: (list) => ({
    en: ` Ignored (not a stop code): ${list}.`,
    fr: ` Ignorés (pas un code de gare) : ${list}.`,
  }),
  droppedStops: (list, max) => ({
    en: ` Only the first ${max} stops are watched; ignored: ${list}.`,
    fr: ` Seules les ${max} premières gares sont suivies ; ignorées : ${list}.`,
  }),
  unknownStops: (list) => ({
    en: ` Unknown to the GO API: ${list}.`,
    fr: ` Inconnues de l’API GO : ${list}.`,
  }),
  deniedEndpoint: (what) => ({
    en: ` Your key has no access to the ${what.en} (403): asked again later.`,
    fr: ` Votre clé n’a pas accès aux ${what.fr} (403) : redemandé plus tard.`,
  }),
  endpointNames: {
    departures: { en: 'departures', fr: 'départs' },
    alerts: { en: 'service alerts', fr: 'alertes de service' },
  },
  // Buttons.
  testOk: (detail) => ({
    en: `Key accepted by the GO API (${detail.en}).`,
    fr: `Clé acceptée par l’API GO (${detail.fr}).`,
  }),
  departuresAt: (n, code) => ({
    en: `${n} departure(s) at ${code}`,
    fr: `${n} départ(s) à ${code}`,
  }),
  alertsRead: (n) => ({ en: `${n} alert(s)`, fr: `${n} alerte(s)` }),
  stopUnknown: (code) => ({
    en: `stop ${code} unknown to the API`,
    fr: `gare ${code} inconnue de l’API`,
  }),
  answerReceived: { en: 'answer received', fr: 'réponse reçue' },
  testRefused: {
    en: 'Key refused by the GO API (403). Check it on the Metrolinx registration e-mail.',
    fr: 'Clé refusée par l’API GO (403). Vérifiez-la dans l’e-mail d’inscription de Metrolinx.',
  },
  testTooSoon: (seconds) => ({
    en: `Already tested a moment ago: try again in ${seconds} s.`,
    fr: `Déjà testée il y a un instant : réessayez dans ${seconds} s.`,
  }),
  testFailed: (reason) => ({
    en: `The key could not be tested (${reason.en}): nothing is concluded about it.`,
    fr: `La clé n’a pas pu être testée (${reason.fr}) : rien n’est conclu à son sujet.`,
  }),
  searchNone: (query) => ({
    en: `No GO stop matches “${query}”.`,
    fr: `Aucune gare GO ne correspond à « ${query} ».`,
  }),
  searchFound: (list) => ({
    en: `Stop codes to type in “Stops”: ${list}`,
    fr: `Codes à saisir dans « Gares et arrêts » : ${list}`,
  }),
  searchUnavailable: (reason) => ({
    en: `The list of stops cannot be read now (${reason.en}).`,
    fr: `La liste des gares ne peut pas être lue maintenant (${reason.fr}).`,
  }),
  reasons: {
    noKey: { en: 'no key', fr: 'aucune clé' },
    refused: { en: 'key refused', fr: 'clé refusée' },
    paused: { en: 'API paused', fr: 'API en pause' },
    budget: { en: 'hourly limit reached', fr: 'plafond horaire atteint' },
    data: { en: '/data unreadable', fr: '/data illisible' },
    timeout: { en: 'no answer within 10 s', fr: 'pas de réponse en 10 s' },
    network: { en: 'network error', fr: 'erreur réseau' },
    server: { en: 'server error', fr: 'erreur du serveur' },
    rate: { en: 'too many calls', fr: 'trop d’appels' },
    unreadable: { en: 'unreadable answer', fr: 'réponse illisible' },
    notfound: { en: 'not found', fr: 'introuvable' },
    error: { en: 'API error', fr: 'erreur de l’API' },
    auth: { en: 'access refused', fr: 'accès refusé' },
  },
};

/** One string of a { en, fr } message. */
export const pick = (message, language) => message[language] ?? message.en;

/** Two messages joined, language by language. */
export const join = (a, b) => ({ en: `${a.en}${b.en}`, fr: `${a.fr}${b.fr}` });
