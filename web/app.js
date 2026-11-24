// Printr — interface web : composer, imprimer et planifier des tickets.
// Preact + htm, sans étape de compilation.

import { html, render, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from '/vendor/preact-htm.mjs';

// Langue de l'installation (PRINTR_LANG côté serveur), lue dans <html lang> : T('Bonjour', 'Hello', 'Hallo').
const LANG = document.documentElement.lang;
const EN = LANG === 'en';
const NL = LANG === 'nl';
const LOCALE = EN ? 'en-US' : NL ? 'nl-BE' : 'fr-FR';
const T = (fr, en, nl) => (EN ? en : NL ? nl : fr);

// ============================================================================
// Outils
// ============================================================================

const listeners = {};
const bus = {
  on(event, fn) { (listeners[event] ||= new Set()).add(fn); return () => listeners[event].delete(fn); },
  emit(event, data) { listeners[event]?.forEach((fn) => fn(data)); },
};

async function api(method, path, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof Blob) {
    opts.body = body;
    opts.headers['Content-Type'] = body.type || 'application/octet-stream';
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error(T('Impossible de joindre Printr. Vérifie la connexion.', "Can't reach Printr. Check your connection.", "Kan Bonnetje niet bereiken. Controleer je verbinding."));
  }
  let data = null;
  try { data = await res.json(); } catch { /* corps vide */ }
  if (res.status === 401 && path !== '/api/login') bus.emit('unauthorized');
  if (!res.ok) throw new Error(data?.error ? capitalize(data.error) : T(`Erreur ${res.status}`, `Error ${res.status}`, `Fout ${res.status}`));
  return data;
}

const toast = (message, kind = 'ok', emoji) => bus.emit('toast', { message, kind, emoji });

// Réponse d'une impression : imprimé, imprimé avec des blocs en erreur, ou en attente de
// l'imprimante (absente : le ticket sortira à son retour).
// Ce que l'imprimante peut faire, selon `printer_status` : libellé court, bandeau, et message quand
// un ticket attend à cause d'elle.
const PRINTER_STATES = {
  ready: { emoji: '✅', label: () => T('Imprimante prête', 'Printer ready', 'Printer klaar') },
  missing: {
    emoji: '🔌', label: () => T('Imprimante déconnectée', 'Printer disconnected', 'Printer losgekoppeld'),
    banner: () => T('Imprimante déconnectée : les tickets attendront son retour.', 'Printer disconnected: tickets will wait for it to come back.', 'Printer losgekoppeld: bonnetjes wachten tot hij terug is.'),
    queued: () => T('Imprimante absente : le ticket sortira dès son retour.', 'Printer missing: the ticket will come out as soon as it is back.', 'Printer ontbreekt: het bonnetje komt eruit zodra hij terug is.'),
  },
  cover_open: {
    emoji: '📂', label: () => T('Capot ouvert', 'Cover open', 'Klep open'),
    banner: () => T('Le capot de l’imprimante est ouvert : les tickets attendront qu’il soit refermé.', 'The printer cover is open: tickets will wait until it is closed.', 'De klep van de printer staat open: bonnetjes wachten tot hij dicht is.'),
    queued: () => T('Capot ouvert : le ticket sortira dès qu’il sera refermé.', 'Cover open: the ticket will come out as soon as it is closed.', 'Klep open: het bonnetje komt eruit zodra hij dicht is.'),
  },
  paper_out: {
    emoji: '🧻', label: () => T('Plus de papier', 'Out of paper', 'Papier op'),
    banner: () => T('L’imprimante n’a plus de papier : les tickets attendront un nouveau rouleau.', 'The printer is out of paper: tickets will wait for a new roll.', 'De printer heeft geen papier meer: bonnetjes wachten op een nieuwe rol.'),
    queued: () => T('Plus de papier : le ticket sortira dès qu’un rouleau sera remis.', 'Out of paper: the ticket will come out as soon as a roll is put back.', 'Papier op: het bonnetje komt eruit zodra er een nieuwe rol in zit.'),
  },
};
const printerState = (code) => PRINTER_STATES[code] || PRINTER_STATES.missing;

function printedToast(r, message = T('Imprimé !', 'Printed!', 'Afgedrukt!'), emoji = '🧾') {
  bus.emit('printer');
  if (r?.stalled) return toast(T('L’imprimante ne prend plus rien (capot, papier ?) : le ticket sortira quand elle sera prête.', 'The printer is not taking anything (cover, paper?): the ticket will come out when it is ready.', 'De printer neemt niets meer aan (klep, papier?): het bonnetje komt eruit zodra hij klaar is.'), 'warn', '⏳');
  if (r?.queued) return toast(printerState(r.printer_status).queued(), 'warn', '⏳');
  if (r?.errors?.length) return toast(T(`Imprimé, avec ${r.errors.length} bloc(s) en erreur`, `Printed, with ${r.errors.length} block(s) in error`, `Afgedrukt, met ${r.errors.length} blok(ken) met fouten`), 'error', '⚠️');
  return toast(message, 'ok', emoji);
}
const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const uid = () => Math.random().toString(36).slice(2, 10);
const clone = (v) => JSON.parse(JSON.stringify(v));

function useHash() {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const onChange = () => { setHash(location.hash || '#/'); window.scrollTo({ top: 0 }); };
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

function useDebounced(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* navigation privée */ } },
  del(key) { try { localStorage.removeItem(key); } catch { /* idem */ } },
};

// Ouvre une photo, orientée comme sur le téléphone (EXIF).
async function loadPhoto(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(T('Image illisible', 'Unreadable image', 'Onleesbare afbeelding')));
      img.src = URL.createObjectURL(file);
    });
  }
}

// Découpe la zone cadrée d'une photo et la réduit avant l'envoi : rapide même en 4G. Une petite
// zone (fort zoom) est agrandie à la largeur du papier : le cadre remplit toujours le ticket.
const PAPER_DOTS = 512;
function cropPhoto(source, crop, max = 1024) {
  const scale = Math.max(PAPER_DOTS, Math.min(max, crop.w)) / crop.w;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(crop.w * scale);
  canvas.height = Math.round(crop.h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
}

async function uploadBlob(blob) {
  const { id } = await api('POST', '/api/images', blob);
  return id;
}

// ============================================================================
// Icônes
// ============================================================================

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  ticket: '<path d="M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  heart: '<path d="M12 20s-7-4.4-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.6-9 9-9 9z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  printer: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="9" rx="2"/><path d="M6 14h12v7H6z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="4"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l-5-5 5-5M5 12h11"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-5-6.7"/>',
  save: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  'file-edit': '<path d="M10 21H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h8l5 5v2"/><path d="M14 3v5h5M8 12h6M8 16h3"/><path d="m18.5 13 2.5 2.5-6 6H12.5V19z"/>',
  scissors: '<circle cx="6" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><path d="M8.6 8.5 21 16.5M8.6 15.5 21 7.5"/>',
};

const Icon = ({ name, size = 20 }) => html`<svg class="icon" width=${size} height=${size} viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
  dangerouslySetInnerHTML=${{ __html: ICONS[name] || '' }} />`;

const Spinner = () => html`<span class="spinner" role="status" aria-label=${T('Chargement', 'Loading', 'Laden')}></span>`;

const Avatar = ({ user, size = '' }) => html`<span class="avatar ${size}" style=${{ background: user?.color || '#999' }}
  title=${user?.name}>${(user?.name || '?')[0].toUpperCase()}</span>`;

// ============================================================================
// Catalogue des blocs
// ============================================================================

const SIGNS = [
  ['belier', T('Bélier ♈', 'Aries ♈', 'Ram ♈')], ['taureau', T('Taureau ♉', 'Taurus ♉', 'Stier ♉')], ['gemeaux', T('Gémeaux ♊', 'Gemini ♊', 'Tweelingen ♊')], ['cancer', T('Cancer ♋', 'Cancer ♋', 'Kreeft ♋')],
  ['lion', T('Lion ♌', 'Leo ♌', 'Leeuw ♌')], ['vierge', T('Vierge ♍', 'Virgo ♍', 'Maagd ♍')], ['balance', T('Balance ♎', 'Libra ♎', 'Weegschaal ♎')], ['scorpion', T('Scorpion ♏', 'Scorpio ♏', 'Schorpioen ♏')],
  ['sagittaire', T('Sagittaire ♐', 'Sagittarius ♐', 'Boogschutter ♐')], ['capricorne', T('Capricorne ♑', 'Capricorn ♑', 'Steenbok ♑')], ['verseau', T('Verseau ♒', 'Aquarius ♒', 'Waterman ♒')], ['poissons', T('Poissons ♓', 'Pisces ♓', 'Vissen ♓')],
];
const TONES = [['serieux', T('Sérieux', 'Serious', 'Serieus')], ['farfelu', T('Farfelu', 'Silly', 'Gek')], ['vachard', T('Vachard', 'Snarky', 'Bijtend')], ['insultant', T('Insultant', 'Insulting', 'Beledigend')]];
// Calcul mental : un niveau de plus, pour le début de l'élémentaire (issue n° 4).
const MATH_LEVELS = [['debutant', T('Débutant', 'Beginner', 'Beginner')], ['facile', T('Facile', 'Easy', 'Makkelijk')], ['moyen', T('Moyen', 'Medium', 'Gemiddeld')], ['difficile', T('Difficile', 'Hard', 'Moeilijk')]];
const MATH_OPERATIONS = [['addition', '+', T('Additions', 'Additions', 'Optellingen')], ['subtraction', '−', T('Soustractions', 'Subtractions', 'Aftrekkingen')],
  ['multiplication', '×', T('Multiplications', 'Multiplications', 'Vermenigvuldigingen')], ['division', '÷', T('Divisions', 'Divisions', 'Delingen')]];
const MATH_TABLES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => [n, String(n), T(`Table de ${n}`, `${n} times table`, `Tafel van ${n}`)]);
const LEVELS = [['facile', T('Facile', 'Easy', 'Makkelijk')], ['moyen', T('Moyen', 'Medium', 'Gemiddeld')], ['difficile', T('Difficile', 'Hard', 'Moeilijk')]];
const WORD_THEMES = [
  ['', T('Au hasard', 'Random', 'Willekeurig')], ['animaux', T('Animaux', 'Animals', 'Dieren')], ['fruits_legumes', T('Fruits et légumes', 'Fruit and vegetables', 'Groenten en fruit')],
  ['cuisine', T('Cuisine', 'Cooking', 'Koken')], ['nature', T('Nature', 'Nature', 'Natuur')], ['sport', T('Sport', 'Sport', 'Sport')], ['metiers', T('Métiers', 'Jobs', 'Beroepen')],
  ['maison', T('Maison', 'Home', 'Thuis')], ['voyage', T('Voyage', 'Travel', 'Reizen')], ['musique', T('Musique', 'Music', 'Muziek')], ['ecole', T('École', 'School', 'School')],
  ['developpement', T('Développement', 'Development', 'Ontwikkeling')], ['devops', 'DevOps'], ['reseaux', T('Réseaux', 'Networking', 'Netwerken')],
  ['ia', T('Intelligence artificielle', 'Artificial intelligence', 'Artificiële intelligentie')],
];
const PICTOS = [['coeur', '❤️'], ['etoile', '⭐'], ['soleil', '☀️'], ['fleur', '🌸'], ['sourire', '😊']];
const label = (options, value) => options.find(([v]) => v === value)?.[1] ?? value;
const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

const G = {
  layout: T('Mise en page', 'Layout', 'Opmaak'), daily: T('Au quotidien', 'Everyday', 'Dagelijks leven'),
  grids: T('Jeux : grilles et chiffres', 'Games: grids and numbers', 'Spelletjes: roosters en cijfers'), words: T('Jeux : mots et lettres', 'Games: words and letters', 'Spelletjes: woorden en letters'),
  challenges: T('Jeux : défis et créativité', 'Games: challenges and creativity', 'Spelletjes: uitdagingen en creativiteit'),
  gift: T('Petites attentions', 'Little gifts', 'Kleine attenties'), info: T('Infos', 'Info', 'Info'), org: T('Organisation', 'Organization', 'Organisatie'),
};
const FAMILY_THEMES = WORD_THEMES.filter(([v]) => !['developpement', 'devops', 'reseaux', 'ia'].includes(v));
const WEEKDAYS = [
  ['lundi', T('Lundi', 'Monday', 'Maandag')], ['mardi', T('Mardi', 'Tuesday', 'Dinsdag')], ['mercredi', T('Mercredi', 'Wednesday', 'Woensdag')], ['jeudi', T('Jeudi', 'Thursday', 'Donderdag')],
  ['vendredi', T('Vendredi', 'Friday', 'Vrijdag')], ['samedi', T('Samedi', 'Saturday', 'Zaterdag')], ['dimanche', T('Dimanche', 'Sunday', 'Zondag')],
];
const EVERY = [
  [1, T('Chaque semaine', 'Every week', 'Elke week')], [2, T('Une semaine sur deux', 'Every other week', 'Om de week')],
  [3, T('Toutes les 3 semaines', 'Every 3 weeks', 'Om de 3 weken')], [4, T('Toutes les 4 semaines', 'Every 4 weeks', 'Om de 4 weken')],
];

// Réglages du serveur utiles à l'appli, relus avec /api/status.
const SERVER = { mqtt: null, autoUpdate: false, lastUpdate: null, city: null, customBlocks: [] };
// Champ « Ville » des blocs à lieu (météo, air, soleil, ciel) : vide, c'est la ville des réglages.
const cityField = () => ({
  key: 'location', label: T('Ville', 'City', 'Stad'), kind: 'text',
  get placeholder() { return SERVER.city ? T(`${SERVER.city} (ville des réglages)`, `${SERVER.city} (default city)`, `${SERVER.city} (standaardstad)`) : T('Lyon, ou « 45.76,4.83 »', 'Lyon, or "45.76,4.83"', 'Lyon, of "45.76,4.83"'); },
  get help() { return SERVER.city ? '' : T('Astuce : une ville par défaut se règle dans Mon compte → Réglages.', 'Tip: a default city can be set in My account → Settings.', 'Tip: een standaardstad stel je in via Mijn account → Instellingen.'); },
});
const citySummary = (b) => b.location || SERVER.city || '';

const BLOCKS = [
  {
    type: 'title', label: T('Titre', 'Title', 'Titel'), emoji: '🔠', group: G.layout, desc: T('Un grand titre centré', 'A big centered title', 'Een grote gecentreerde titel'),
    defaults: { text: T('Bonjour !', 'Hello!', 'Hallo!'), size: 2 },
    fields: [
      { key: 'text', label: T('Texte', 'Text', 'Tekst'), kind: 'text' },
      { key: 'size', label: T('Taille', 'Size', 'Grootte'), kind: 'segmented', options: [[1, 'S'], [2, 'M'], [3, 'L'], [4, 'XL']] },
    ],
    summary: (b) => b.text,
  },
  {
    type: 'text', label: T('Texte', 'Text', 'Tekst'), emoji: '📝', group: G.layout, desc: T('Un paragraphe libre', 'A free paragraph', 'Een vrije alinea'),
    defaults: { text: '', align: 'left' },
    fields: [
      { key: 'text', label: T('Texte', 'Text', 'Tekst'), kind: 'textarea', placeholder: T('Écris ce que tu veux…', 'Write whatever you like…', 'Schrijf wat je wilt…') },
      { key: 'align', label: T('Alignement', 'Alignment', 'Uitlijning'), kind: 'segmented', options: [['left', T('Gauche', 'Left', 'Links')], ['center', T('Centré', 'Centered', 'Gecentreerd')], ['right', T('Droite', 'Right', 'Rechts')]] },
      { key: 'size', label: T('Taille', 'Size', 'Grootte'), kind: 'segmented', options: [[1, T('Normale', 'Normal', 'Normaal')], [2, T('Grande', 'Large', 'Groot')], [3, T('Énorme', 'Huge', 'Enorm')]] },
      { key: 'bold', label: T('Gras', 'Bold', 'Vet'), kind: 'toggle' },
      { key: 'underline', label: T('Souligné', 'Underline', 'Onderstreept'), kind: 'toggle' },
      { key: 'reverse', label: T('Inversé (blanc sur noir)', 'Inverted (white on black)', 'Omgekeerd (wit op zwart)'), kind: 'toggle' },
      { key: 'small', label: T('Petite police', 'Small font', 'Klein lettertype'), kind: 'toggle' },
    ],
    summary: (b) => b.text || T('Vide', 'Empty', 'Leeg'),
  },
  {
    type: 'date', label: T('Date', 'Date', 'Datum'), emoji: '📅', group: G.layout, desc: T('La date du jour, ou une autre, en toutes lettres', "Today's date, or another one, written out", "De datum van vandaag, of een andere, voluit geschreven"),
    defaults: {},
    fields: [
      { key: 'offset', label: T('Dans combien de jours ?', 'In how many days?', 'Binnen hoeveel dagen?'), kind: 'number', min: -365, max: 365,
        help: T('Pour préparer des tickets à l’avance : 1 pour demain, 2 pour après-demain…', 'To prepare tickets ahead: 1 for tomorrow, 2 for the day after…', 'Om bonnetjes vooraf klaar te maken: 1 voor morgen, 2 voor overmorgen…') },
      { key: 'date', label: T('… ou une date précise', '… or a set date', '… of een vaste datum'), kind: 'date' },
    ],
    summary: (b) => (b.date ? new Date(`${b.date}T12:00`).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long' })
      : Number(b.offset) ? T(`dans ${b.offset} j`, `in ${b.offset} d`, `over ${b.offset} d`) : ''),
  },
  {
    type: 'separator', label: T('Séparateur', 'Separator', 'Scheidingslijn'), emoji: '➖', group: G.layout, desc: T('Une ligne de séparation', 'A dividing line', 'Een scheidingslijn'),
    defaults: { style: '-' },
    fields: [{ key: 'style', label: T('Style', 'Style', 'Stijl'), kind: 'segmented', options: [['-', '—'], ['=', '='], ['═', '═'], ['─', '─'], ['·', '·'], ['*', '*'], ['~', '~']] }],
  },
  {
    type: 'feed', label: T('Espace', 'Space', 'Ruimte'), emoji: '↕️', group: G.layout, desc: T("De l'air entre deux blocs", 'Some air between two blocks', 'Wat lucht tussen twee blokken'),
    defaults: { lines: 1 },
    fields: [{ key: 'lines', label: T('Lignes vides', 'Empty lines', 'Lege regels'), kind: 'number', min: 1, max: 10 }],
    summary: (b) => T(`${b.lines} ligne${b.lines > 1 ? 's' : ''}`, `${b.lines} line${b.lines > 1 ? 's' : ''}`, `${b.lines} regel${b.lines > 1 ? 's' : ''}`),
  },
  { type: 'cut', label: T('Coupe', 'Cut', 'Knippen'), emoji: '✂️', group: G.layout, desc: T('Coupe le papier ici : la suite sort sur un autre ticket', 'Cuts the paper here: the rest comes out on another ticket', 'Knipt het papier hier af: de rest komt op een ander bonnetje'), defaults: {}, fields: [] },
  {
    type: 'image', label: T('Image', 'Image', 'Afbeelding'), emoji: '🖼️', group: G.layout, desc: T('Une photo, imprimée en noir et blanc', 'A photo, printed in black and white', 'Een foto, afgedrukt in zwart-wit'),
    defaults: { dither: true, dither_algorithm: 'floyd-steinberg' },
    fields: [
      { key: 'upload', label: T('Photo', 'Photo', 'Foto'), kind: 'image' },
      { key: 'url', label: T("… ou adresse web d'une image", '… or the web address of an image', '… of het webadres van een afbeelding'), kind: 'text', placeholder: 'https://…' },
      { key: 'dither', label: T('Tramage', 'Dithering', 'Rasteren'), kind: 'toggle', help: T('Idéal pour les photos. Désactive-le pour un logo ou un dessin.', 'Ideal for photos. Turn it off for a logo or a drawing.', 'Ideaal voor foto\'s. Zet het uit voor een logo of een tekening.') },
      {
        key: 'dither_algorithm', label: T('Algorithme de tramage', 'Dithering algorithm', 'Rasteralgoritme'), kind: 'select', when: (d) => d.dither !== false,
        options: [
          ['floyd-steinberg', T('Floyd–Steinberg : dégradés doux (photos)', 'Floyd–Steinberg: smooth gradients (photos)', 'Floyd–Steinberg: zachte verlopen (foto\'s)')],
          ['atkinson', T('Atkinson : plus contrasté, aplats nets', 'Atkinson: more contrast, cleaner flat areas', 'Atkinson: meer contrast, nettere vlakken')],
          ['bayer', T('Bayer : trame régulière, sans grain', 'Bayer: regular pattern, no grain', 'Bayer: regelmatig patroon, geen korrel')],
        ],
      },
    ],
    normalize: (d) => { if (d.upload) delete d.url; return d; },
    summary: (b) => (b.upload ? T('Photo', 'Photo', 'Foto') : b.url ? T('Image du web', 'Web image', 'Webafbeelding') : T('Aucune image', 'No image', 'Geen afbeelding')),
  },
  {
    type: 'qr', label: 'QR code', emoji: '🔳', group: G.layout, desc: T('Un lien à scanner', 'A link to scan', 'Een link om te scannen'),
    defaults: { data: '', size: 6 },
    fields: [
      { key: 'data', label: T('Lien ou texte', 'Link or text', 'Link of tekst'), kind: 'text', placeholder: 'https://…' },
      { key: 'caption', label: T('Légende', 'Caption', 'Bijschrift'), kind: 'text', placeholder: T('Optionnelle', 'Optional', 'Optioneel') },
      { key: 'size', label: T('Taille', 'Size', 'Grootte'), kind: 'number', min: 2, max: 12 },
    ],
    summary: (b) => b.data || T('Vide', 'Empty', 'Leeg'),
  },
  {
    type: 'picto', label: T('Pictogramme', 'Pictogram', 'Pictogram'), emoji: '💖', group: G.layout, desc: T('Cœur, étoile, soleil, fleur…', 'Heart, star, sun, flower…', 'Hart, ster, zon, bloem…'),
    defaults: { shape: 'coeur', size: 'moyen', count: 1 },
    fields: [
      { key: 'shape', label: T('Forme', 'Shape', 'Vorm'), kind: 'icons', options: PICTOS },
      { key: 'size', label: T('Taille', 'Size', 'Grootte'), kind: 'segmented', options: [['petit', T('Petit', 'Small', 'Klein')], ['moyen', T('Moyen', 'Medium', 'Gemiddeld')], ['grand', T('Grand', 'Large', 'Groot')]] },
      { key: 'count', label: T('Combien ?', 'How many?', 'Hoeveel?'), kind: 'number', min: 1, max: 7 },
    ],
    summary: (b) => `${label(PICTOS, b.shape)} × ${b.count}`,
  },
  {
    type: 'weather', label: T('Météo', 'Weather', 'Weer'), emoji: '🌤️', group: G.daily, desc: T('Le temps du jour et des suivants', "Today's weather and the days ahead", "Het weer van vandaag en de komende dagen"),
    defaults: { location: '', days: 1, outfit: false, wind: true, sun: true },
    fields: [
      cityField(),
      { key: 'days', label: T('Prévisions', 'Forecast', 'Weersverwachting'), kind: 'segmented', options: [[1, T("Aujourd'hui", 'Today', 'Vandaag')], [3, T('3 jours', '3 days', '3 dagen')], [5, T('5 jours', '5 days', '5 dagen')], [7, T('7 jours', '7 days', '7 dagen')]] },
      { key: 'outfit', label: T('Comment s’habiller', 'What to wear', 'Wat trek je aan'), kind: 'toggle', help: T('« Manteau et bonnet, prends un parapluie » : d’après les prévisions du jour.', '“Coat and hat, take an umbrella”: from today’s forecast.', '“Jas en muts, neem een paraplu mee”: volgens de weersverwachting van vandaag.') },
      { key: 'wind', label: T('Vent et UV', 'Wind and UV', 'Wind en UV'), kind: 'toggle' },
      { key: 'sun', label: T('Lever et coucher du soleil', 'Sunrise and sunset', 'Zonsopgang en zonsondergang'), kind: 'toggle' },
    ],
    summary: citySummary,
  },
  {
    type: 'barnum', label: T('Horoscope', 'Horoscope', 'Horoscoop'), emoji: '🌟', group: G.daily, desc: T('Le vrai ciel du jour, hors ligne et gratuit', 'The real sky of the day, offline and free', 'De echte hemel van vandaag, offline en gratis'),
    defaults: { sign: 'lion', sky: false },
    fields: [
      { key: 'sign', label: T('Signe', 'Sign', 'Sterrenbeeld'), kind: 'select', options: SIGNS },
      { key: 'birth_date', label: T('… ou date de naissance', '… or birth date', '… of geboortedatum'), kind: 'date', help: T('Si elle est indiquée, Barnum en déduit le signe.', 'If it is given, Barnum works out the sign from it.', 'Als je die invult, leidt Barnum het sterrenbeeld daaruit af.') },
      { key: 'sky', label: T("Afficher le ciel du jour", "Show today's sky", "Toon de hemel van vandaag"), kind: 'toggle', help: T('La position des planètes, et celles qui sont rétrogrades.', 'The position of the planets, and which ones are retrograde.', 'De positie van de planeten en welke retrograde zijn.') },
    ],
    summary: (b) => (b.birth_date ? T(`Né le ${b.birth_date}`, `Born on ${b.birth_date}`, `Geboren op ${b.birth_date}`) : label(SIGNS, b.sign)),
  },
  {
    type: 'custom', label: T('Bloc perso', 'Custom block', 'Eigen blok'), emoji: '🧩', group: G.org,
    desc: T('Un script à toi dans /opt/bonnetje/blokken', 'Your own script in /opt/bonnetje/blokken', 'Je eigen script in /opt/bonnetje/blokken'),
    get defaults() { return { name: SERVER.customBlocks[0] || '' }; },
    fields: [
      {
        key: 'name', label: T('Script', 'Script', 'Script'), kind: 'select',
        get options() { return SERVER.customBlocks.length ? SERVER.customBlocks.map((n) => [n, n]) : [['', T('Aucun script trouvé', 'No script found', 'Geen script gevonden')]]; },
        help: T('Un fichier exécutable qui affiche des blocs en JSON.', 'An executable file that prints blocks as JSON.', 'Een uitvoerbaar bestand dat blokken als JSON afdrukt.'),
      },
    ],
    summary: (b) => b.name || '',
  },
  {
    type: 'horoscope', label: T('Horoscope Claude', 'Claude horoscope', 'Claude-horoscoop'), emoji: '🔮', group: G.daily, desc: T('Sérieux, farfelu… ou insultant', 'Serious, silly… or insulting', 'Serieus, gek… of beledigend'), ai: true,
    defaults: { sign: 'lion', tone: 'serieux' },
    fields: [
      { key: 'sign', label: T('Signe', 'Sign', 'Sterrenbeeld'), kind: 'select', options: SIGNS },
      { key: 'tone', label: T('Ton', 'Tone', 'Toon'), kind: 'segmented', options: TONES },
    ],
    summary: (b) => `${label(SIGNS, b.sign)} · ${label(TONES, b.tone)}`,
  },
  { type: 'word_of_the_day', label: T('Mot du jour', 'Word of the day', 'Woord van de dag'), emoji: '📖', group: G.daily, desc: T('Un mot rare et sa définition', 'A rare word and its definition', 'Een zeldzaam woord en de betekenis ervan'), ai: true, defaults: {}, fields: [] },
  { type: 'saint', label: T('Saint du jour', 'Name day', 'Heilige van de dag'), emoji: '😇', group: G.daily, desc: T('La fête du jour', 'The French name-day calendar', 'De Franse naamdagkalender'), defaults: {}, fields: [] },
  { type: 'quote', label: T('Citation', 'Quote', 'Citaat'), emoji: '💬', group: G.daily, desc: T('Une citation française célèbre', 'A famous quote', 'Een beroemd citaat'), defaults: {}, fields: [] },
  {
    type: 'fortune', label: 'Fortune', emoji: '🥠', group: G.daily, desc: T('Un petit papier façon biscuit chinois, dit par une vache si on veut', 'A fortune-cookie line, said by a cow if you like', 'Een gelukskoekjesbriefje, desgewenst uitgesproken door een koe'),
    defaults: { source: 'builtin', cow: true },
    fields: [
      { key: 'cow', label: T('Une vache le dit (cowsay)', 'A cow says it (cowsay)', 'Een koe zegt het (cowsay)'), kind: 'toggle' },
      { key: 'source', label: T('Les phrases', 'Lines', 'Zinnen'), kind: 'segmented', options: [['builtin', T('Celles de Printr', 'Printr’s', 'Die van Bonnetje')], ['system', T('La commande fortune', 'The fortune command', 'Het commando fortune')]], help: T('La commande fortune doit être installée sur le serveur (paquet fortune-mod).', 'The fortune command must be installed on the server (fortune-mod package).', 'Het commando fortune moet op de server geïnstalleerd zijn (pakket fortune-mod).') },
      { key: 'seed', label: T('Numéro', 'Number', 'Nummer'), kind: 'number', optional: true, help: T('Laisse vide pour une phrase au hasard.', 'Leave empty for a random line.', 'Laat leeg voor een willekeurige zin.') },
    ],
    summary: (b) => (b.cow ? T('Dit par une vache', 'Said by a cow', 'Uitgesproken door een koe') : T('Au hasard', 'Random', 'Willekeurig')),
  },
  { type: 'moon', label: T('Lune', 'Moon', 'Maan'), emoji: '🌙', group: G.daily, desc: T('Phase et prochaines lunes', 'Phase and upcoming moons', 'Fase en komende manen'), defaults: {}, fields: [] },
  {
    type: 'sun', label: T('Soleil', 'Sun', 'Zon'), emoji: '🌅', group: G.daily, desc: T('Lever, coucher, durée du jour', 'Sunrise, sunset, length of day', 'Zonsopgang, zonsondergang, daglengte'),
    defaults: { location: '' },
    fields: [cityField()],
    summary: citySummary,
  },
  {
    type: 'sky', label: T('Le ciel ce soir', "Tonight's sky", "De hemel vanavond"), emoji: '🔭', group: G.daily, desc: T('Planètes, passages de l’ISS, lune, étoiles filantes', 'Planets, ISS passes, moon, shooting stars', 'Planeten, ISS-overvluchten, maan, vallende sterren'),
    defaults: { location: '' },
    fields: [cityField()],
    summary: citySummary,
  },
  {
    type: 'air_quality', label: T("Qualité de l'air", 'Air quality', 'Luchtkwaliteit'), emoji: '🍃', group: G.daily, desc: T('Pollution et pollens', 'Pollution and pollen', 'Vervuiling en pollen'),
    defaults: { location: '', pollutants: true, pollen: true },
    fields: [
      cityField(),
      { key: 'pollutants', label: T('Polluants', 'Pollutants', 'Verontreinigende stoffen'), kind: 'toggle', help: T('Particules fines, ozone, dioxyde d’azote', 'Fine particles, ozone, nitrogen dioxide', 'Fijn stof, ozon, stikstofdioxide') },
      { key: 'pollen', label: T('Pollens', 'Pollen', 'Pollen'), kind: 'toggle' },
    ],
    summary: citySummary,
  },
  {
    type: 'holidays', label: T('Jours fériés', 'Public holidays', 'Feestdagen'), emoji: '🏖️', group: G.daily, desc: T('Les prochains jours fériés', 'The next public holidays', 'De volgende feestdagen'),
    defaults: { zone: 'metropole', count: 1 },
    fields: [
      { key: 'zone', label: T('Zone', 'Zone', 'Zone'), kind: 'segmented', options: [['metropole', T('Métropole', 'Mainland France', 'Vasteland van Frankrijk')], ['alsace-moselle', 'Alsace-Moselle']] },
      { key: 'count', label: T('Combien ?', 'How many?', 'Hoeveel?'), kind: 'number', min: 1, max: 12 },
    ],
  },
  {
    type: 'countdown', label: T('Compte à rebours', 'Countdown', 'Aftelling'), emoji: '⏳', group: G.daily, desc: T('« J-12 avant les vacances »', '“12 days until the holidays”', '“Nog 12 dagen tot de vakantie”'),
    defaults: { label: T('Vacances', 'Holidays', 'Vakantie'), date: inDays(30) },
    fields: [
      { key: 'label', label: T('Événement', 'Event', 'Evenement'), kind: 'text' },
      { key: 'date', label: T('Date', 'Date', 'Datum'), kind: 'date' },
    ],
    summary: (b) => `${b.label} · ${b.date}`,
  },
  {
    type: 'birthdays', label: T('Anniversaires', 'Birthdays', 'Verjaardagen'), emoji: '🎂', group: G.daily, desc: T('« Aujourd’hui, Léo a 12 ans ! », et les suivants', '“Today, Leo turns 12!”, and the next ones', '“Vandaag wordt Leo 12!”, en de volgende'),
    defaults: { list: '', upcoming: 3, family: true },
    fields: [
      { key: 'family', label: T('Avec ceux de la famille', 'With the family’s', 'Met die van de familie'), kind: 'toggle', help: T('La liste commune, que chacun complète.', 'The shared list, which everyone adds to.', 'De gedeelde lijst, die iedereen aanvult.') },
      { key: 'family_list', label: T('Anniversaires de la famille', 'Family birthdays', 'Verjaardagen van de familie'), kind: 'familyBirthdays', when: (b) => b.family !== false },
      { key: 'list', label: T('Rien que pour ce ticket', 'Just for this ticket', 'Alleen voor dit bonnetje'), kind: 'textarea', placeholder: T('Léo, 12/03/2014\nCamille, 14/11', 'Leo, 03/12/2014\nCamille, 11/14', 'Leo, 03/12/2014\nCamille, 11/14'), help: T('Une personne par ligne, la date à la fin (jour/mois, l’année pour l’âge).', 'One person per line, the date last (month/day, the year for the age).', 'Eén persoon per regel, de datum laatst (maand/dag, het jaar voor de leeftijd).') },
      { key: 'upcoming', label: T('Combien des suivants', 'How many next ones', 'Hoeveel volgende'), kind: 'number', min: 1, max: 10 },
    ],
    summary: (b) => (b.list || '').split('\n').map((l) => l.split(/[,:]/)[0].trim()).filter(Boolean).slice(0, 4).join(', ')
      || (b.family !== false ? T('La famille', 'The family', 'De familie') : T('Personne', 'Nobody', 'Niemand')),
  },
  {
    type: 'riddle', label: T('Énigme', 'Riddle', 'Raadsel'), emoji: '🧩', group: G.challenges, desc: T('125 énigmes, réponse à l’envers', 'Riddles, charades, logic, the answer upside down', 'Raadsels, charades, logica, antwoord ondersteboven'),
    defaults: { answer: 'envers' },
    fields: [
      { key: 'kind', label: T('Famille', 'Type', 'Soort'), kind: 'select', options: [['', T('Toutes', 'All', 'Alle')], ['devinette', T('Devinettes', 'Classic riddles', 'Klassieke raadsels')], ['charade', T('Charades', 'Charades', 'Charades')], ['logique', T('Logique', 'Logic', 'Logica')], ['calcul', T('Calcul', 'Maths', 'Rekenen')]] },
      { key: 'answer', label: T('Réponse', 'Answer', 'Antwoord'), kind: 'select', options: [['envers', T("À l'envers, en bas", 'Upside down, at the bottom', 'Ondersteboven, onderaan')], ['lendemain', T('Le lendemain', 'The next day', 'De volgende dag')], ['dessous', T('Juste en dessous', 'Right below', 'Meteen eronder')], ['aucune', T('Pas de réponse', 'No answer', 'Geen antwoord')]] },
    ],
  },
  {
    type: 'workout', label: T('Défi sportif', 'Workout challenge', 'Sportuitdaging'), emoji: '💪', group: G.challenges, desc: T('Sans équipement, trois niveaux', 'No equipment, three levels', 'Zonder materiaal, drie niveaus'),
    defaults: { level: 'moyen' },
    fields: [{ key: 'level', label: T('Niveau', 'Level', 'Niveau'), kind: 'segmented', options: LEVELS }],
    summary: (b) => label(LEVELS, b.level),
  },
  {
    type: 'sudoku', label: 'Sudoku', emoji: '🔢', group: G.grids, desc: T('Une grille à remplir au stylo', 'A grid to fill in with a pen', 'Een rooster om met pen in te vullen'),
    defaults: { difficulty: 'moyen' },
    fields: [
      { key: 'difficulty', label: T('Difficulté', 'Difficulty', 'Moeilijkheid'), kind: 'segmented', options: LEVELS },
      { key: 'seed', label: T('Numéro de grille', 'Grid number', 'Roosternummer'), kind: 'number', optional: true, help: T('Laisse vide pour une nouvelle grille.', 'Leave empty for a new grid.', 'Laat leeg voor een nieuw rooster.') },
      { key: 'solution', label: T('Imprimer la solution de cette grille', "Print this grid's solution", "Print de oplossing van dit rooster"), kind: 'toggle' },
    ],
    summary: (b) => label(LEVELS, b.difficulty),
  },
  {
    type: 'word_search', label: T('Mots mêlés', 'Word search', 'Woordzoeker'), emoji: '🔤', group: G.words, desc: T('Des mots cachés dans une grille de lettres', 'Hidden words in a grid of letters', 'Verborgen woorden in een rooster van letters'),
    defaults: { difficulty: 'moyen', theme: '', words: [] },
    fields: [
      { key: 'difficulty', label: T('Difficulté', 'Difficulty', 'Moeilijkheid'), kind: 'segmented', options: LEVELS },
      { key: 'theme', label: T('Thème', 'Theme', 'Thema'), kind: 'select', options: WORD_THEMES },
      { key: 'words', label: T('Mes mots (remplacent le thème)', 'My words (replace the theme)', 'Mijn woorden (vervangen het thema)'), kind: 'list', placeholder: T('grand-mère…', 'grandmother…', 'grootmoeder…'), add: T('Ajouter un mot', 'Add a word', 'Woord toevoegen') },
      { key: 'seed', label: T('Numéro de grille', 'Grid number', 'Roosternummer'), kind: 'number', optional: true, help: T('Laisse vide pour une nouvelle grille.', 'Leave empty for a new grid.', 'Laat leeg voor een nieuw rooster.') },
      { key: 'solution', label: T('Imprimer la solution de cette grille', "Print this grid's solution", "Print de oplossing van dit rooster"), kind: 'toggle' },
    ],
    summary: (b) => [(b.words || []).length ? T('mes mots', 'my words', 'mijn woorden') : label(WORD_THEMES, b.theme || ''), label(LEVELS, b.difficulty)].join(' · '),
  },
  {
    type: 'train_tracks', label: T('Voie ferrée', 'Railway track', 'Spoorweg'), emoji: '🚂', group: G.grids, desc: T('Relier A à B en une seule voie', 'Connect A to B with a single track', 'Verbind A met B met één enkel spoor'),
    defaults: { difficulty: 'moyen' },
    fields: [
      { key: 'difficulty', label: T('Difficulté', 'Difficulty', 'Moeilijkheid'), kind: 'segmented', options: LEVELS },
      { key: 'seed', label: T('Numéro de grille', 'Grid number', 'Roosternummer'), kind: 'number', optional: true, help: T('Laisse vide pour une nouvelle grille.', 'Leave empty for a new grid.', 'Laat leeg voor een nieuw rooster.') },
      { key: 'solution', label: T('Imprimer la solution de cette grille', "Print this grid's solution", "Print de oplossing van dit rooster"), kind: 'toggle' },
    ],
    summary: (b) => label(LEVELS, b.difficulty),
  },
  {
    type: 'maze', label: T('Labyrinthe', 'Maze', 'Doolhof'), emoji: '🌀', group: G.grids, desc: T('Entrée en haut, sortie en bas', 'Entrance at the top, exit at the bottom', 'Ingang bovenaan, uitgang onderaan'),
    defaults: { width: 12, height: 16 },
    fields: [
      { key: 'width', label: T('Largeur', 'Width', 'Breedte'), kind: 'number', min: 4, max: 40 },
      { key: 'height', label: T('Hauteur', 'Height', 'Hoogte'), kind: 'number', min: 4, max: 60 },
    ],
    summary: (b) => `${b.width} × ${b.height}`,
  },
  {
    type: 'arrow_word', label: T('Mots fléchés', 'Arrow words', 'Pijlwoorden'), emoji: '✍️', group: G.words, desc: T('Une grille de mots fléchés, définitions par Claude', 'An arrow-word grid, clues written by Claude', 'Een pijlwoordenrooster, omschrijvingen van Claude'), ai: true,
    defaults: { level: 2, size: 'moyen' },
    fields: [
      { key: 'level', label: T('Niveau', 'Level', 'Niveau'), kind: 'segmented', options: [[1, T('Facile', 'Easy', 'Makkelijk')], [2, T('Moyen', 'Medium', 'Gemiddeld')], [3, T('Difficile', 'Hard', 'Moeilijk')], [4, 'Expert']],
        help: T('Niveaux 3 et 4 : définitions plus fines, rédigées par un modèle plus cher (une dizaine de centimes par grille neuve).', 'Levels 3 and 4: finer clues, written by a more expensive model (around 10 cents per new grid).', 'Niveau 3 en 4: fijnere omschrijvingen, geschreven door een duurder model (ongeveer 10 cent per nieuw rooster).') },
      { key: 'size', label: T('Taille', 'Size', 'Grootte'), kind: 'segmented', options: [['petit', T('Petite', 'Small', 'Klein')], ['moyen', T('Moyenne', 'Medium', 'Gemiddeld')], ['grand', T('Grande', 'Large', 'Groot')]] },
      { key: 'seed', label: T('Numéro de grille', 'Grid number', 'Roosternummer'), kind: 'number', optional: true, help: T('Laisse vide pour une nouvelle grille.', 'Leave empty for a new grid.', 'Laat leeg voor een nieuw rooster.') },
      { key: 'solution', label: T('Imprimer la solution de cette grille', "Print this grid's solution", "Print de oplossing van dit rooster"), kind: 'toggle', help: T('Même numéro, même taille et même niveau.', 'Same number, same size and same level.', 'Zelfde nummer, zelfde grootte en zelfde niveau.') },
    ],
    summary: (b) => {
      const lv = ({ 1: T('Facile', 'Easy', 'Makkelijk'), 2: T('Moyen', 'Medium', 'Gemiddeld'), 3: T('Difficile', 'Hard', 'Moeilijk'), 4: 'Expert' })[b.level] || '';
      const sz = ({ petit: T('petite', 'small', 'klein'), moyen: T('moyenne', 'medium', 'middelgroot'), grand: T('grande', 'large', 'groot') })[b.size] || '';
      return T(`${lv} · ${sz} grille`, `${lv} · ${sz} grid`, `${lv} · ${sz} rooster`);
    },
  },
  {
    type: 'crossword', label: T('Mots croisés', 'Crossword', 'Kruiswoordraadsel'), emoji: '🔤', group: G.words, desc: T('Une grille de mots croisés, définitions par Claude', 'A crossword grid, clues written by Claude', 'Een kruiswoordraadsel, omschrijvingen van Claude'), ai: true,
    defaults: { level: 2, size: 'moyen' },
    fields: [
      { key: 'level', label: T('Niveau', 'Level', 'Niveau'), kind: 'segmented', options: [[1, T('Facile', 'Easy', 'Makkelijk')], [2, T('Moyen', 'Medium', 'Gemiddeld')], [3, T('Difficile', 'Hard', 'Moeilijk')], [4, 'Expert']],
        help: T('Niveaux 3 et 4 : définitions plus fines, rédigées par un modèle plus cher (une dizaine de centimes par grille neuve).', 'Levels 3 and 4: finer clues, written by a more expensive model (around 10 cents per new grid).', 'Niveau 3 en 4: fijnere omschrijvingen, geschreven door een duurder model (ongeveer 10 cent per nieuw rooster).') },
      { key: 'size', label: T('Taille', 'Size', 'Grootte'), kind: 'segmented', options: [['petit', T('Petite (7 × 7)', 'Small (7 × 7)', 'Klein (7 × 7)')], ['moyen', T('Moyenne (9 × 9)', 'Medium (9 × 9)', 'Middelgroot (9 × 9)')], ['grand', T('Grande (11 × 11)', 'Large (11 × 11)', 'Groot (11 × 11)')]] },
      { key: 'seed', label: T('Numéro de grille', 'Grid number', 'Roosternummer'), kind: 'number', optional: true, help: T('Laisse vide pour une nouvelle grille.', 'Leave empty for a new grid.', 'Laat leeg voor een nieuw rooster.') },
      { key: 'solution', label: T('Imprimer la solution de cette grille', "Print this grid's solution", "Print de oplossing van dit rooster"), kind: 'toggle', help: T('Même numéro, même taille et même niveau.', 'Same number, same size and same level.', 'Zelfde nummer, zelfde grootte en zelfde niveau.') },
    ],
    summary: (b) => {
      const lv = ({ 1: T('Facile', 'Easy', 'Makkelijk'), 2: T('Moyen', 'Medium', 'Gemiddeld'), 3: T('Difficile', 'Hard', 'Moeilijk'), 4: 'Expert' })[b.level] || '';
      const sz = ({ petit: T('petite', 'small', 'klein'), moyen: T('moyenne', 'medium', 'middelgroot'), grand: T('grande', 'large', 'groot') })[b.size] || '';
      return T(`${lv} · ${sz} grille`, `${lv} · ${sz} grid`, `${lv} · ${sz} rooster`);
    },
  },
  {
    type: 'nonogram', label: T('Logimage', 'Nonogram', 'Nonogram'), emoji: '🖍️', group: G.grids, desc: T('Noircir des cases pour révéler un dessin', 'Shade squares to reveal a picture', 'Kleur vakjes in om een tekening te onthullen'),
    defaults: {},
    fields: [
      { key: 'number', label: T('Numéro du dessin (1 à 10)', 'Picture number (1 to 10)', 'Nummer van de tekening (1 tot 10)'), kind: 'number', min: 1, max: 10, optional: true },
      { key: 'solution', label: T('Imprimer la solution', 'Print the solution', 'Print de oplossing'), kind: 'toggle' },
    ],
  },
  {
    type: 'kakuro', label: 'Kakuro', emoji: '➕', group: G.grids, desc: T('Des sommes à composer, chiffres de 1 à 9', 'Sums to build from digits 1 to 9', 'Sommen om te maken met de cijfers 1 tot 9'),
    defaults: { difficulty: 'moyen' },
    fields: [
      { key: 'difficulty', label: T('Difficulté', 'Difficulty', 'Moeilijkheid'), kind: 'segmented', options: LEVELS },
      { key: 'seed', label: T('Numéro de grille', 'Grid number', 'Roosternummer'), kind: 'number', optional: true, help: T('Laisse vide pour une nouvelle grille.', 'Leave empty for a new grid.', 'Laat leeg voor een nieuw rooster.') },
      { key: 'solution', label: T('Imprimer la solution de cette grille', "Print this grid's solution", "Print de oplossing van dit rooster"), kind: 'toggle' },
    ],
    summary: (b) => label(LEVELS, b.difficulty),
  },
  {
    type: 'takuzu', label: 'Takuzu', emoji: '0️⃣', group: G.grids, desc: T('Des 0 et des 1, jamais trois pareils', '0s and 1s, never three alike', 'Nullen en enen, nooit drie dezelfde'),
    defaults: { difficulty: 'moyen' },
    fields: [
      { key: 'difficulty', label: T('Difficulté', 'Difficulty', 'Moeilijkheid'), kind: 'segmented', options: LEVELS },
      { key: 'seed', label: T('Numéro de grille', 'Grid number', 'Roosternummer'), kind: 'number', optional: true, help: T('Laisse vide pour une nouvelle grille.', 'Leave empty for a new grid.', 'Laat leeg voor een nieuw rooster.') },
      { key: 'solution', label: T('Imprimer la solution de cette grille', "Print this grid's solution", "Print de oplossing van dit rooster"), kind: 'toggle' },
    ],
    summary: (b) => label(LEVELS, b.difficulty),
  },
  {
    type: 'hashi', label: 'Hashi', emoji: '🌉', group: G.grids, desc: T('Relier les îles par des ponts', 'Connect the islands with bridges', 'Verbind de eilanden met bruggen'),
    defaults: { difficulty: 'moyen' },
    fields: [
      { key: 'difficulty', label: T('Difficulté', 'Difficulty', 'Moeilijkheid'), kind: 'segmented', options: LEVELS },
      { key: 'seed', label: T('Numéro de grille', 'Grid number', 'Roosternummer'), kind: 'number', optional: true, help: T('Laisse vide pour une nouvelle grille.', 'Leave empty for a new grid.', 'Laat leeg voor een nieuw rooster.') },
      { key: 'solution', label: T('Imprimer la solution de cette grille', "Print this grid's solution", "Print de oplossing van dit rooster"), kind: 'toggle' },
    ],
    summary: (b) => label(LEVELS, b.difficulty),
  },
  {
    type: 'petit_bac', label: T('Petit bac', 'Categories', 'Categorieën'), emoji: '✏️', group: G.words, desc: T('Une lettre, des catégories, à jouer en famille', 'One letter, some categories, to play as a family', 'Eén letter, een paar categorieën, om samen als gezin te spelen'),
    defaults: { players: 1, count: 6, categories: [] },
    fields: [
      { key: 'players', label: T('Joueurs (une feuille chacun)', 'Players (one sheet each)', 'Spelers (elk één blad)'), kind: 'number', min: 1, max: 6 },
      { key: 'letter', label: T('Lettre', 'Letter', 'Letter'), kind: 'text', placeholder: T('Au hasard', 'Random', 'Willekeurig'), maxlength: 1 },
      { key: 'count', label: T('Nombre de catégories', 'Number of categories', 'Aantal categorieën'), kind: 'number', min: 3, max: 12 },
      { key: 'categories', label: T('Mes catégories (remplacent le tirage)', 'My categories (replace the draw)', 'Mijn categorieën (vervangen de loting)'), kind: 'list', placeholder: T('Dinosaure…', 'Dinosaur…', 'Dinosaurus…'), add: T('Ajouter une catégorie', 'Add a category', 'Categorie toevoegen') },
    ],
    summary: (b) => T(
      `${b.players} joueur${b.players > 1 ? 's' : ''}${b.letter ? ` · lettre ${b.letter.toUpperCase()}` : ''}`,
      `${b.players} player${b.players > 1 ? 's' : ''}${b.letter ? ` · letter ${b.letter.toUpperCase()}` : ''}`,
      `${b.players} speler${b.players > 1 ? 's' : ''}${b.letter ? ` · letter ${b.letter.toUpperCase()}` : ''}`,
    ),
  },
  {
    type: 'mental_math', label: T('Calcul mental', 'Mental math', 'Hoofdrekenen'), emoji: '➗', group: G.grids, desc: T('Une fiche d’opérations, résultats à l’envers', 'A sheet of sums, answers upside down', 'Een blad met sommen, antwoorden ondersteboven'),
    defaults: { difficulty: 'facile', count: 10, operations: [], tables: [] },
    fields: [
      { key: 'difficulty', label: T('Niveau', 'Level', 'Niveau'), kind: 'segmented', options: MATH_LEVELS },
      { key: 'operations', label: T('Opérations', 'Operations', 'Bewerkingen'), kind: 'multi', options: MATH_OPERATIONS,
        help: T('Rien de coché : toutes celles du niveau.', 'Nothing checked: all of them for the level.', 'Niets aangevinkt: alle bewerkingen van het niveau.') },
      { key: 'tables', label: T('Tables à réviser', 'Times tables to practice', 'Tafels om te oefenen'), kind: 'multi', options: MATH_TABLES,
        when: (b) => !b.operations?.length || b.operations.some((o) => o === 'multiplication' || o === 'division'),
        help: T('Pour les multiplications et les divisions. Rien de coché : celles du niveau.', 'For multiplications and divisions. Nothing checked: those of the level.', 'Voor vermenigvuldigingen en delingen. Niets aangevinkt: die van het niveau.') },
      { key: 'count', label: T('Nombre d’opérations', 'Number of operations', 'Aantal bewerkingen'), kind: 'number', min: 4, max: 30 },
    ],
    summary: (b) => {
      const ops = b.operations?.length ? ` · ${b.operations.map((o) => label(MATH_OPERATIONS, o)).join(' ')}` : '';
      return T(`${label(MATH_LEVELS, b.difficulty)}${ops} · ${b.count} opérations`, `${label(MATH_LEVELS, b.difficulty)}${ops} · ${b.count} operations`, `${label(MATH_LEVELS, b.difficulty)}${ops} · ${b.count} bewerkingen`);
    },
  },
  {
    type: 'anagram', label: T('Mot mystère', 'Mystery word', 'Mysterieus woord'), emoji: '🔀', group: G.words, desc: T('Des lettres mélangées à remettre dans l’ordre', 'Scrambled letters to put back in order', 'Door elkaar gehusselde letters om in de juiste volgorde te zetten'),
    defaults: { count: 3, theme: '' },
    fields: [
      { key: 'theme', label: T('Thème', 'Theme', 'Thema'), kind: 'select', options: FAMILY_THEMES },
      { key: 'count', label: T('Nombre de mots', 'Number of words', 'Aantal woorden'), kind: 'number', min: 1, max: 6 },
    ],
    summary: (b) => T(
      `${b.count} mot${b.count > 1 ? 's' : ''} · ${label(WORD_THEMES, b.theme || '')}`,
      `${b.count} word${b.count > 1 ? 's' : ''} · ${label(WORD_THEMES, b.theme || '')}`, `${b.count} woord${b.count > 1 ? 'en' : ''} · ${label(WORD_THEMES, b.theme || '')}`,
    ),
  },
  {
    type: 'cipher', label: T('Message codé', 'Coded message', 'Gecodeerd bericht'), emoji: '🕵️', group: G.words, desc: T('César, morse ou nombres, à déchiffrer', 'Caesar, Morse or numbers, to decode', 'Caesar, morse of cijfers, om te ontcijferen'),
    defaults: { cipher: 'cesar', answer: true, message: '' },
    fields: [
      { key: 'cipher', label: T('Code', 'Code', 'Code'), kind: 'segmented', options: [['cesar', T('César', 'Caesar', 'Caesar')], ['morse', 'Morse'], ['nombres', T('Nombres', 'Numbers', 'Cijfers')]] },
      { key: 'message', label: T('Message secret', 'Secret message', 'Geheim bericht'), kind: 'textarea', placeholder: T('Laisse vide pour un message au hasard', 'Leave empty for a random message', 'Laat leeg voor een willekeurig bericht') },
      { key: 'answer', label: T('Imprimer la réponse à l’envers', 'Print the answer upside down', 'Print het antwoord ondersteboven'), kind: 'toggle' },
    ],
    summary: (b) => ({ cesar: T('César', 'Caesar', 'Caesar'), morse: 'Morse', nombres: T('Nombres', 'Numbers', 'Cijfers') })[b.cipher] || '',
  },
  {
    type: 'chess', label: T('Échecs', 'Chess', 'Schaken'), emoji: '♟️', group: G.challenges, desc: T('Le problème du jour de Lichess, solution à l’envers', 'Lichess daily puzzle, answer upside down', 'De dagelijkse puzzel van Lichess, oplossing ondersteboven'),
    defaults: { solution: true },
    fields: [
      { key: 'solution', label: T('Imprimer la solution (à l’envers)', 'Print the answer (upside down)', 'Print het antwoord (ondersteboven)'), kind: 'toggle' },
    ],
    summary: () => T('Problème du jour', 'Daily puzzle', 'Dagpuzzel'),
  },
  {
    type: 'coloring', label: T('Coloriage', 'Coloring', 'Kleurplaat'), emoji: '🎨', group: G.challenges, desc: T('Un mandala à colorier, toujours différent', 'A mandala to color, always different', 'Een mandala om in te kleuren, altijd anders'),
    defaults: {},
    fields: [{ key: 'seed', label: T('Numéro du mandala', 'Mandala number', 'Mandalanummer'), kind: 'number', optional: true, help: T('Laisse vide pour un nouveau mandala.', 'Leave empty for a new mandala.', 'Laat leeg voor een nieuwe mandala.') }],
  },
  {
    type: 'coupon', label: T('Bon à offrir', 'Gift voucher', 'Cadeaubon'), emoji: '🎟️', group: G.gift, desc: T('« Bon pour un petit-déjeuner au lit »', '“Voucher for breakfast in bed”', '“Bon voor ontbijt op bed”'),
    defaults: { count: 1, text: '' },
    fields: [
      { key: 'text', label: T('Bon pour…', 'Voucher for…', 'Bon voor…'), kind: 'text', placeholder: T('un petit-déjeuner au lit (vide : une idée au hasard)', 'breakfast in bed (empty: a random idea)', 'ontbijt op bed (leeg: een willekeurig idee)') },
      { key: 'from', label: T('Offert par', 'From', 'Van'), kind: 'text' },
      { key: 'to', label: T('Pour', 'To', 'Voor'), kind: 'text' },
      { key: 'valid_until', label: T('Valable jusqu’au', 'Valid until', 'Geldig tot'), kind: 'date' },
      { key: 'count', label: T('Nombre de bons', 'Number of vouchers', 'Aantal bonnen'), kind: 'number', min: 1, max: 6 },
    ],
    summary: (b) => b.text || T('Idée au hasard', 'Random idea', 'Willekeurig idee'),
  },
  {
    type: 'story', label: T('Histoire du soir', 'Bedtime story', 'Verhaaltje voor het slapengaan'), emoji: '🌙', group: G.gift, desc: T('Un conte où les enfants sont les héros', 'A tale where the kids are the heroes', 'Een sprookje waarin de kinderen de helden zijn'), ai: true,
    defaults: { children: '', theme: '', length: 'short' },
    fields: [
      { key: 'children', label: T('Les héros', 'The heroes', 'De helden'), kind: 'text', placeholder: T('Léo, Camille', 'Leo, Camille', 'Leo, Camille') },
      { key: 'theme', label: T('Un thème ? (facultatif)', 'A theme? (optional)', 'Een thema? (optioneel)'), kind: 'text', placeholder: T('Les dragons, l’espace, la mer…', 'Dragons, space, the sea…', 'Draken, de ruimte, de zee…') },
      { key: 'length', label: T('Longueur', 'Length', 'Lengte'), kind: 'segmented', options: [['short', T('Courte', 'Short', 'Kort')], ['long', T('Longue', 'Long', 'Lang')]] },
    ],
    summary: (b) => b.children || T('Aucun héros', 'No heroes', 'Geen helden'),
  },
  {
    type: 'news', label: T('Actualités', 'News', 'Nieuws'), emoji: '📰', group: G.info, desc: T('Revue de presse depuis tes flux RSS', 'Press review from your RSS feeds', 'Persoverzicht uit je RSS-feeds'),
    defaults: EN
      ? { title: 'World', feeds: ['https://feeds.bbci.co.uk/news/world/rss.xml', 'https://hackaday.com/blog/feed/'], count: 3, qr: 2, themes: [], exclude: [] }
      : { title: 'France', feeds: ['https://www.franceinfo.fr/titres.rss', 'https://www.lemonde.fr/rss/une.xml'], count: 3, qr: 2, themes: [], exclude: [] },
    fields: [
      { key: 'title', label: T('Titre du bandeau', 'Banner title', 'Titel van de banner'), kind: 'text' },
      { key: 'feeds', label: T('Flux RSS', 'RSS feeds', 'RSS-feeds'), kind: 'list', placeholder: 'https://…', add: T('Ajouter un flux', 'Add a feed', 'Een feed toevoegen') },
      { key: 'themes', label: T('Thèmes favoris', 'Favorite topics', 'Favoriete onderwerpen'), kind: 'list', placeholder: T('climat, sciences…', 'climate, science…', 'klimaat, wetenschap…'), add: T('Ajouter un thème', 'Add a topic', 'Een onderwerp toevoegen') },
      { key: 'exclude', label: T('Mots à écarter', 'Words to exclude', 'Uit te sluiten woorden'), kind: 'list', placeholder: T('football…', 'football…', 'voetbal…'), add: T('Ajouter un mot', 'Add a word', 'Woord toevoegen') },
      { key: 'count', label: T('Articles', 'Articles', 'Artikels'), kind: 'number', min: 1, max: 5 },
      { key: 'qr', label: 'QR codes', kind: 'segmented', options: [[0, T('Aucun', 'None', 'Geen')], [1, '1'], [2, '2']] },
    ],
    summary: (b) => b.title,
  },
  {
    type: 'on_this_day', label: T('Éphéméride', 'On this day', 'Op deze dag'), emoji: '🏛️', group: G.info, desc: T("C'est arrivé un jour comme aujourd'hui", 'It happened on a day like today', 'Het gebeurde op een dag zoals vandaag'),
    defaults: { count: 3 },
    fields: [{ key: 'count', label: T('Événements', 'Events', 'Gebeurtenissen'), kind: 'number', min: 1, max: 10 }],
  },
  {
    type: 'crypto', label: 'Crypto', emoji: '🪙', group: G.info, desc: T('Cours et variation sur 24 h', 'Price and 24 h change', 'Koers en verandering over 24 u'),
    defaults: { coins: ['bitcoin', 'ethereum'], currency: 'eur' },
    fields: [
      { key: 'coins', label: T('Cryptomonnaies (identifiants CoinGecko)', 'Cryptocurrencies (CoinGecko IDs)', 'Cryptomunten (CoinGecko-ID\'s)'), kind: 'list', placeholder: 'bitcoin', add: T('Ajouter', 'Add', 'Toevoegen') },
      { key: 'currency', label: T('Devise', 'Currency', 'Munteenheid'), kind: 'segmented', options: [['eur', 'Euro'], ['usd', 'Dollar']] },
    ],
    summary: (b) => (b.coins || []).join(', '),
  },
  {
    type: 'todo', label: T('À faire', 'To do', 'Te doen'), emoji: '✅', group: G.org, desc: T('Une liste à cocher au stylo', 'A checklist to tick with a pen', 'Een lijst om met een pen af te vinken'),
    defaults: { title: T('À faire', 'To do', 'Te doen'), items: [''] },
    fields: [
      { key: 'title', label: T('Titre', 'Title', 'Titel'), kind: 'text' },
      { key: 'items', label: T('Choses à faire', 'Things to do', 'Dingen om te doen'), kind: 'list', placeholder: T('Acheter du pain', 'Buy bread', 'Brood kopen'), add: T('Ajouter une ligne', 'Add a line', 'Een regel toevoegen') },
    ],
    summary: (b) => `${(b.items || []).filter(Boolean).length} ${T('élément(s)', 'item(s)', 'item(s)')}`,
  },
  {
    type: 'recipe', label: T('Recette', 'Recipe', 'Recept'), emoji: '🍳', group: G.org, desc: T('Une recette lue sur son site, sans la pub', 'A recipe read from its website, without the ads', 'Een recept van de website, zonder reclame'),
    defaults: { url: '', steps: true, qr: true },
    fields: [
      { key: 'url', label: T('Adresse de la recette', 'Recipe address', 'Adres van het recept'), kind: 'text', placeholder: 'https://…',
        help: T('La plupart des sites de cuisine marchent (ils décrivent leurs recettes en données schema.org).', 'Most cooking websites work (they describe their recipes with schema.org data).', 'De meeste kooksites werken (ze beschrijven hun recepten met schema.org-gegevens).') },
      { key: 'steps', label: T('Imprimer les étapes', 'Print the steps', 'De stappen afdrukken'), kind: 'toggle', help: T('Sinon, seulement les ingrédients : une liste de courses.', 'Otherwise, only the ingredients: a shopping list.', 'Anders enkel de ingrediënten: een boodschappenlijst.') },
      { key: 'qr', label: T('QR code vers la page', 'QR code to the page', 'QR-code naar de pagina'), kind: 'toggle' },
    ],
    summary: (b) => (b.url || '').replace(/^https?:\/\/(www\.)?/, '').slice(0, 40) || T('Aucune adresse', 'No address', 'Geen adres'),
  },
  {
    type: 'recipe_claude', label: T('Recette par Claude', 'Claude recipe', 'Recept van Claude'), emoji: '👩‍🍳', group: G.org, desc: T('Le nom d’un plat, Claude écrit la recette', 'Name a dish, Claude writes the recipe', 'Geef een gerecht, Claude schrijft het recept'), ai: true,
    defaults: { dish: '', servings: 4, steps: true },
    fields: [
      { key: 'dish', label: T('Plat', 'Dish', 'Gerecht'), kind: 'text', placeholder: T('Blanquette de veau, crêpes…', 'Lasagna, pancakes…', 'Lasagne, pannenkoeken…') },
      { key: 'servings', label: T('Pour combien de personnes', 'Servings', 'Aantal personen'), kind: 'number', min: 1, max: 20 },
      { key: 'steps', label: T('Imprimer les étapes', 'Print the steps', 'De stappen afdrukken'), kind: 'toggle', help: T('Sinon, seulement les ingrédients : une liste de courses.', 'Otherwise, only the ingredients: a shopping list.', 'Anders enkel de ingrediënten: een boodschappenlijst.') },
    ],
    summary: (b) => (b.dish ? T(`${b.dish} · ${b.servings} pers.`, `${b.dish} · serves ${b.servings}`, `${b.dish} · voor ${b.servings} pers.`) : T('Aucun plat', 'No dish', 'Geen gerecht')),
  },
  {
    type: 'recipe_from_ingredients', label: T('Qu’est-ce qu’on mange ?', 'What’s for dinner?', 'Wat eten we vanavond?'), emoji: '🥕', group: G.org, desc: T('Les ingrédients qu’on a, Claude trouve la recette', 'What’s in the fridge, Claude finds the recipe', 'Wat er in de koelkast ligt, Claude vindt het recept'), ai: true,
    defaults: { ingredients: '', servings: 4, wish: '', steps: true },
    fields: [
      { key: 'ingredients', label: T('Ingrédients sous la main', 'Ingredients at hand', 'Ingrediënten in huis'), kind: 'textarea', placeholder: T('Courgettes, feta, riz…', 'Zucchini, feta, rice…', 'Courgette, feta, rijst…'), help: T('Un par ligne ou séparés par des virgules. Les basiques du placard (sel, huile, beurre, œufs…) sont déjà comptés.', 'One per line or separated by commas. Pantry basics (salt, oil, butter, eggs…) are already counted.', 'Eén per regel of gescheiden door komma\'s. Basisproducten (zout, olie, boter, eieren…) zijn al meegeteld.') },
      { key: 'servings', label: T('Pour combien de personnes', 'Servings', 'Aantal personen'), kind: 'number', min: 1, max: 20 },
      { key: 'wish', label: T('Une envie ? (facultatif)', 'Any wish? (optional)', 'Een wens? (optioneel)'), kind: 'text', placeholder: T('Rapide, végétarien, pour un pique-nique…', 'Quick, vegetarian, for a picnic…', 'Snel, vegetarisch, voor een picknick…') },
      { key: 'steps', label: T('Imprimer les étapes', 'Print the steps', 'De stappen afdrukken'), kind: 'toggle', help: T('Sinon, seulement les ingrédients.', 'Otherwise, only the ingredients.', 'Anders enkel de ingrediënten.') },
    ],
    summary: (b) => (b.ingredients || '').split(/[\n,;]/).map((x) => x.trim()).filter(Boolean).slice(0, 4).join(', ') || T('Aucun ingrédient', 'No ingredients', 'Geen ingrediënten'),
  },
  {
    type: 'shopping', label: T('Liste de courses', 'Shopping list', 'Boodschappenlijst'), emoji: '🛒', group: G.org, desc: T('La liste partagée de l’appli', "The app's shared list", "De gedeelde lijst van de app"),
    defaults: { title: T('Liste de courses', 'Shopping list', 'Boodschappenlijst'), clear: true },
    fields: [
      { key: 'title', label: T('Titre', 'Title', 'Titel'), kind: 'text' },
      { key: 'clear', label: T('Vider la liste une fois imprimée', 'Clear the list once printed', 'De lijst leegmaken na het afdrukken'), kind: 'toggle' },
    ],
  },
  {
    type: 'agenda', label: 'Agenda', emoji: '🗓️', group: G.org, desc: T('Tes rendez-vous, depuis un calendrier en ligne', 'Your appointments, from an online calendar', 'Je afspraken, uit een online agenda'),
    defaults: { calendars: [''], days: 1 },
    fields: [
      { key: 'calendars', label: T('Liens des calendriers (ICS)', 'Calendar links (ICS)', 'Agendalinks (ICS)'), kind: 'list', placeholder: 'webcal://…', add: T('Ajouter un calendrier', 'Add a calendar', 'Een agenda toevoegen'),
        help: T('iCloud : partage le calendrier en public et copie le lien. Google : « Adresse secrète au format iCal ».', 'iCloud: share the calendar publicly and copy the link. Google: “Secret address in iCal format”.', 'iCloud: deel de agenda openbaar en kopieer de link. Google: “Geheim adres in iCal-indeling”.') },
      { key: 'days', label: T('Jours', 'Days', 'Dagen'), kind: 'number', min: 1, max: 7 },
      { key: 'title', label: T('Titre', 'Title', 'Titel'), kind: 'text', placeholder: 'Agenda' },
    ],
    summary: (b) => T(`${b.days} jour${b.days > 1 ? 's' : ''}`, `${b.days} day${b.days > 1 ? 's' : ''}`, `${b.days} dag${b.days > 1 ? 'en' : ''}`),
  },
  {
    type: 'bins', label: T('Poubelles', 'Bins', 'Afval'), emoji: '🗑️', group: G.org, desc: T('« Ce soir, on sort le bac jaune »', '“Tonight, put out the yellow bin”', '“Vanavond de gele container buitenzetten”'),
    defaults: { when: 'veille', always: false, collections: [{ name: T('Bac jaune', 'Yellow bin', 'Gele container'), days: ['jeudi'], every: 1 }] },
    fields: [
      { key: 'collections', label: T('Ramassages', 'Pickups', 'Ophalingen'), kind: 'bins' },
      { key: 'when', label: T('Rappel', 'Reminder', 'Herinnering'), kind: 'segmented', options: [['veille', T('La veille au soir', 'The evening before', 'De avond ervoor')], ['jour', T('Le jour même', 'On the day', 'Op de dag zelf')]] },
      { key: 'always', label: T('Imprimer aussi les jours sans ramassage', 'Also print on days without pickup', 'Ook printen op dagen zonder ophaling'), kind: 'toggle' },
    ],
    normalize: (d) => {
      d.collections = (d.collections || []).filter((c) => c.name?.trim()).map((c) => {
        const out = { name: c.name.trim(), days: c.days, every: Number(c.every) || 1 };
        if (out.every > 1 && c.from) out.from = c.from;
        return out;
      });
      return d;
    },
    summary: (b) => (b.collections || []).map((c) => c.name).filter(Boolean).join(', '),
  },
  {
    type: 'chores', label: T('Tâches ménagères', 'Chores', 'Huishoudtaken'), emoji: '🧹', group: G.org, desc: T('Qui fait quoi, à tour de rôle', 'Who does what, taking turns', 'Wie doet wat, om beurten'),
    defaults: { tasks: [T('Vider le lave-vaisselle', 'Empty the dishwasher', 'De vaatwasser uitruimen'), T('Mettre la table', 'Set the table', 'De tafel dekken'), T('Sortir les poubelles', 'Take out the trash', 'Het vuilnis buitenzetten')], people: [], period: 'week' },
    fields: [
      { key: 'tasks', label: T('Tâches', 'Chores', 'Huishoudtaken'), kind: 'list', placeholder: T('Arroser les plantes…', 'Water the plants…', 'De planten water geven…'), add: T('Ajouter une tâche', 'Add a chore', 'Taak toevoegen') },
      { key: 'people', label: T('Qui les fait', 'Who does them', 'Wie ze doet'), kind: 'list', placeholder: T('Prénom', 'Name', 'Naam'), add: T('Ajouter quelqu’un', 'Add someone', 'Iemand toevoegen') },
      { key: 'period', label: T('On change', 'Rotate', 'Wisselen'), kind: 'segmented', options: [['day', T('Chaque jour', 'Daily', 'Dagelijks')], ['week', T('Chaque semaine', 'Weekly', 'Wekelijks')]] },
    ],
    summary: (b) => ((b.people || []).filter(Boolean).length ? `${b.people.filter(Boolean).join(', ')} · ${b.period === 'day' ? T('chaque jour', 'daily', 'dagelijks') : T('chaque semaine', 'weekly', 'wekelijks')}` : T('Personne', 'Nobody', 'Niemand')),
  },
  {
    type: 'wifi', label: T('Wi-Fi invités', 'Guest Wi-Fi', 'Gasten-wifi'), emoji: '📶', group: G.org, desc: T('Un QR code pour se connecter', 'A QR code to connect', 'Een QR-code om te verbinden'),
    defaults: { ssid: '', password: '', security: 'wpa', show_password: true },
    fields: [
      { key: 'ssid', label: T('Nom du réseau', 'Network name', 'Netwerknaam'), kind: 'text' },
      { key: 'password', label: T('Mot de passe', 'Password', 'Wachtwoord'), kind: 'text' },
      { key: 'security', label: T('Sécurité', 'Security', 'Beveiliging'), kind: 'segmented', options: [['wpa', 'WPA'], ['wep', 'WEP'], ['none', T('Ouvert', 'Open', 'Open')]] },
      { key: 'show_password', label: T('Écrire le mot de passe en clair', 'Show the password in plain text', 'Wachtwoord leesbaar tonen'), kind: 'toggle' },
    ],
    summary: (b) => b.ssid,
  },
  {
    type: 'monthly_report', label: T('Bilan du mois', 'Monthly report', 'Maandoverzicht'), emoji: '🧾', group: G.org, desc: T('Qui a imprimé quoi, façon ticket de caisse', 'Who printed what, like a till receipt', 'Wie wat heeft geprint, zoals een kassabon'),
    defaults: {},
    fields: [{ key: 'month', label: T('Mois', 'Month', 'Maand'), kind: 'month', help: T('Laisse vide pour le mois en cours.', 'Leave empty for the current month.', 'Laat leeg voor de huidige maand.') }],
  },
];
const BLOCK = Object.fromEntries(BLOCKS.map((b) => [b.type, b]));
// Noms français acceptés par le serveur dans les tickets JSON (scripts, exemples) : l'appli les
// reconnaît aussi, au lieu d'afficher « mots_meles ».
const ALIASES = {
  mots_meles: 'word_search', mots_caches: 'word_search', mots_en_grille: 'word_search', voie_ferree: 'train_tracks',
  rails: 'train_tracks', defi_sportif: 'workout', enigme: 'riddle', calcul_mental: 'mental_math', mot_mystere: 'anagram',
  anagramme: 'anagram', logimage: 'nonogram', picross: 'nonogram', message_code: 'cipher', courses: 'shopping',
  bon: 'coupon', poubelles: 'bins', bilan: 'monthly_report', mots_fleches: 'arrow_word', fleches: 'arrow_word',
  mots_croises: 'crossword', croises: 'crossword', recette: 'recipe', recette_claude: 'recipe_claude', recette_ingredients: 'recipe_from_ingredients', ciel: 'sky',
  coloriage: 'coloring', taches: 'chores', echecs: 'chess', anniversaires: 'birthdays', histoire: 'story', binairo: 'takuzu', ponts: 'hashi',
};
for (const [alias, type] of Object.entries(ALIASES)) BLOCK[alias] = BLOCK[type];
// Ancien nom accepté par le serveur.
BLOCK.enigme = BLOCK.riddle;
BLOCK.defi_sportif = BLOCK.workout;

const newBlock = (type) => ({ uid: uid(), open: true, data: { type, ...clone(BLOCK[type].defaults) } });

// Données d'un bloc telles qu'attendues par le serveur : champs vides retirés.
function cleanBlock(data) {
  const def = BLOCK[data.type];
  // Les paramètres sans champ dans le formulaire (ajoutés à la main dans le JSON, comme le
  // numéro d'une énigme) sont conservés tels quels : ouvrir puis enregistrer ne perd rien.
  const known = new Set((def?.fields || []).map((f) => f.key));
  const out = Object.fromEntries(Object.entries(data).filter(([k, v]) => !known.has(k) && v !== '' && v != null));
  out.type = data.type;
  for (const field of def?.fields || []) {
    let v = data[field.key];
    if (field.kind === 'list') v = (v || []).map((s) => String(s).trim()).filter(Boolean);
    if (field.kind === 'number' && v !== '' && v != null) v = Number(v);
    if (v === '' || v == null || Number.isNaN(v)) continue;
    if (field.kind === 'list' && v.length === 0 && field.key !== 'items') continue;
    out[field.key] = v;
  }
  return def?.normalize ? def.normalize(out) : out;
}

const toTicket = (state) => ({ cut: state.cut, spacing: Number(state.spacing), blocks: state.blocks.map((b) => cleanBlock(b.data)) });

// YAML d'un ticket, pour Home Assistant. Une chaîne reste nue si rien ne peut la faire lire
// autrement : sinon entre apostrophes (guillemets JSON s'il y a des caractères de contrôle), pour
// « yes », « on », les nombres, les dates (2026-12-25 deviendrait une date), « : » ou « # ».
const YAML_PLAIN = /^[\p{L}_][^\n:#]*$/u;
const YAML_RESERVED = /^(true|false|yes|no|on|off|y|n|null|~)$/i;
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function yamlScalar(v, indent) {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'string') return String(v);
  // Texte sur plusieurs lignes : bloc littéral, lignes gardées telles quelles.
  if (v.includes('\n') && !/^\s/.test(v) && !v.includes('\r')) {
    const chomp = v.endsWith('\n\n') ? '+' : v.endsWith('\n') ? '' : '-';
    const lines = v.replace(/\n$/, '').split('\n');
    return `|${chomp}\n${lines.map((l) => (l ? indent + l : '')).join('\n')}`;
  }
  if (YAML_PLAIN.test(v) && !/[\x00-\x1f\x7f]|\s$/.test(v) && !YAML_RESERVED.test(v)) return v;
  return /[\x00-\x08\x0a-\x1f\x7f]/.test(v) ? JSON.stringify(v) : `'${v.replaceAll("'", "''")}'`;
}

// Valeur qui suit « clé: » ou « - » : sur la même ligne, ou en dessous, indentée de `indent`.
function yamlNode(v, indent) {
  if (Array.isArray(v)) return v.length ? `\n${v.map((x) => `${indent}-${yamlItem(x, `${indent}  `)}`).join('\n')}` : ' []';
  if (isMap(v)) return Object.keys(v).length ? `\n${yamlMap(v, indent)}` : ' {}';
  return ` ${yamlScalar(v, indent)}`;
}
const yamlMap = (obj, indent) =>
  Object.entries(obj).map(([k, v]) => `${indent}${yamlScalar(k, indent)}:${yamlNode(v, `${indent}  `)}`).join('\n');
// Élément de liste : un objet commence sur la ligne du tiret.
const yamlItem = (v, indent) => (isMap(v) && Object.keys(v).length ? ` ${yamlMap(v, indent).slice(indent.length)}` : yamlNode(v, indent));

// Action de l'intégration Printr pour Home Assistant, ou action MQTT standard qui publie le ticket
// sur le sujet d'impression (`prefix` : PRINTR_MQTT_PREFIX du serveur).
const haYaml = (ticket, label) =>
  `${yamlMap({ action: 'printr.print_ticket', data: { ...(label ? { label } : {}), ticket } }, '')}\n`;
const mqttYaml = (ticket, prefix) =>
  `${yamlMap({ action: 'mqtt.publish', data: { topic: `${prefix}/print`, payload: JSON.stringify(ticket) } }, '')}\n`;

const usesAi = (blocks) => blocks.some((b) => BLOCK[b.type || b.data?.type]?.ai);

function blockSummary(data) {
  const def = BLOCK[data.type];
  if (!def) return data.type;
  return def.summary ? def.summary(data) : def.desc;
}

// Modèles de tickets prêts à l'emploi, proposés par le composeur vide. Un bloc retiré du catalogue
// (par l'administrateur, ou faute de Claude) est simplement laissé de côté.
const TEMPLATES = [
  { emoji: '🌅', name: T('Brief du matin', 'Morning brief', 'Ochtendbriefing'), blocks: [['title', { text: T('Bonjour !', 'Good morning!', 'Goedemorgen!') }], ['date'], ['weather'], ['saint'], ['word_of_the_day'], ['quote']] },
  { emoji: '🧩', name: T('Pause jeux', 'Game break', 'Spelpauze'), blocks: [['title', { text: T('Pause jeux', 'Game break', 'Spelpauze') }], ['riddle'], ['sudoku'], ['word_search'], ['workout']] },
  { emoji: '🧒', name: T('Pour les enfants', 'For the kids', 'Voor de kinderen'), blocks: [['title', { text: T('Pour toi !', 'For you!', 'Voor jou!') }], ['maze'], ['mental_math'], ['coloring'], ['riddle']] },
  { emoji: '☀️', name: T('Week-end', 'Weekend', 'Weekend'), blocks: [['title', { text: T('Bon week-end !', 'Happy weekend!', 'Fijn weekend!') }], ['date'], ['weather', { days: 2 }], ['sky'], ['crossword'], ['on_this_day']] },
];
const templateBlocks = (tpl) => tpl.blocks.filter(([type]) => offered(BLOCK[type]))
  .map(([type, data]) => { const b = newBlock(type); return { ...b, open: false, data: { ...b.data, ...data } }; });

const emptyComposer = () => ({ id: null, name: '', icon: '🧾', shared: false, schedules: [], cut: true, spacing: 1, blocks: [] });

function composerFromPreset(preset, copy = false) {
  const t = preset.ticket || {};
  return {
    id: copy ? null : preset.id,
    name: copy ? T(`${preset.name} (copie)`, `${preset.name} (copy)`, `${preset.name} (kopie)`) : preset.name,
    icon: preset.icon || '🧾',
    shared: copy ? false : !!preset.shared,
    schedules: copy ? [] : clone(preset.schedules || []),
    cut: t.cut ?? true,
    spacing: t.spacing ?? 1,
    blocks: (t.blocks || []).map((data) => ({ uid: uid(), open: false, data: { ...clone(BLOCK[data.type]?.defaults || {}), ...data } })),
  };
}

// ============================================================================
// Planification : jours et heures
// ============================================================================

const DAY_LETTERS = T(['L', 'M', 'M', 'J', 'V', 'S', 'D'], ['M', 'T', 'W', 'T', 'F', 'S', 'S'], ['M', 'D', 'W', 'D', 'V', 'Z', 'Z']);
const DAY_NAMES = T(['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'], ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo']);

function daysLabel(days) {
  const d = [...days].sort().join('');
  if (d === '1234567') return T('Tous les jours', 'Every day', 'Elke dag');
  if (d === '12345') return T('En semaine', 'Weekdays', 'Op weekdagen');
  if (d === '67') return T('Le week-end', 'Weekends', 'In het weekend');
  return days.slice().sort().map((n) => DAY_NAMES[n - 1]).join(' ');
}
const timeLabel = (t) => T(t.replace(':', ' h '), t, t);
const scheduleLabel = (s) => `${daysLabel(s.days)} · ${timeLabel(s.time)}`;

// ============================================================================
// Composants de formulaire
// ============================================================================

function Field({ label: text, help, children }) {
  return html`<div class="field">${text && html`<label>${text}</label>`}${children}${help && html`<span class="help">${help}</span>`}</div>`;
}

function Switch({ label: text, checked, onChange, help }) {
  return html`<label class="switch">
    <span><span class="label">${text}</span>${help && html`<br/><span class="help muted" style="font-size:12.5px">${help}</span>`}</span>
    <input type="checkbox" checked=${!!checked} onChange=${(e) => onChange(e.target.checked)} />
    <span class="track"></span>
  </label>`;
}

function Segmented({ options, value, onChange }) {
  return html`<div class="segmented" role="radiogroup">
    ${options.map(([v, text]) => html`<button type="button" role="radio" aria-checked=${v === value}
      class=${v === value ? 'on' : ''} onClick=${() => onChange(v)}>${text}</button>`)}
  </div>`;
}

// Choix multiple en pastilles : la valeur est la liste des options cochées (vide : aucune).
function Multi({ options, value, onChange }) {
  const on = new Set(value || []);
  const toggle = (v) => onChange(options.map(([o]) => o).filter((o) => (o === v ? !on.has(o) : on.has(o))));
  return html`<div class="multi">
    ${options.map(([v, text, aria]) => html`<button type="button" aria-pressed=${on.has(v)} aria-label=${aria || text}
      class=${on.has(v) ? 'on' : ''} onClick=${() => toggle(v)}>${text}</button>`)}
  </div>`;
}

function ListEdit({ value, onChange, placeholder, add }) {
  const items = value?.length ? value : [''];
  const set = (i, v) => onChange(items.map((x, j) => (j === i ? v : x)));
  return html`<div class="listedit">
    ${items.map((item, i) => html`<div class="item" key=${i}>
      <input class="input" value=${item} placeholder=${placeholder} onInput=${(e) => set(i, e.target.value)}
        onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); onChange([...items, '']); } }} />
      <button type="button" class="iconbtn danger" aria-label=${T('Retirer', 'Remove', 'Verwijderen')} onClick=${() => onChange(items.filter((_, j) => j !== i))}>
        <${Icon} name="x" /></button>
    </div>`)}
    <button type="button" class="btn ghost small" onClick=${() => onChange([...items, ''])}><${Icon} name="plus" size=${16} /> ${add || T('Ajouter', 'Add', 'Toevoegen')}</button>
  </div>`;
}

// Ramassages des poubelles : un nom, un jour, une fréquence (et une date de référence).
// La liste des anniversaires commune à la famille, enregistrée sur le serveur (bloc Anniversaires).
function FamilyBirthdays() {
  const [list, setList] = useState(null);
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('GET', '/api/birthdays').then((r) => setList(r.list || '')).catch(() => setList('')); }, []);
  const count = (list || '').split('\n').filter((l) => l.trim()).length;
  const save = async () => {
    setBusy(true);
    try {
      const r = await api('PUT', '/api/birthdays', { list: draft });
      setList(r.list); setOpen(false);
      toast(T('Anniversaires de la famille enregistrés', 'Family birthdays saved', 'Familieverjaardagen opgeslagen'), 'ok', '🎂');
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return html`<button type="button" class="btn secondary small" disabled=${list === null} onClick=${() => { setDraft(list || ''); setOpen(true); }}>
      ${count ? T(`${count} personne${count > 1 ? 's' : ''} · Modifier`, `${count} ${count > 1 ? 'people' : 'person'} · Edit`, `${count} ${count > 1 ? 'personen' : 'persoon'} · Bewerken`) : T('Ajouter des anniversaires', 'Add birthdays', 'Verjaardagen toevoegen')}</button>
    ${open && html`<${Sheet} title=${T('Anniversaires de la famille', 'Family birthdays', 'Verjaardagen van de familie')} onClose=${() => setOpen(false)} footer=${html`
      <button class="btn secondary" onClick=${() => setOpen(false)}>${T('Annuler', 'Cancel', 'Annuleren')}</button>
      <button class="btn primary grow" disabled=${busy} onClick=${save}><${Icon} name="check" /> ${T('Enregistrer', 'Save', 'Opslaan')}</button>`}>
      <p class="muted" style="margin:0 0 10px">${T(
        'Une liste pour toute la famille : chacun la complète, et tous les blocs Anniversaires l’utilisent. Une personne par ligne, la date à la fin (jour/mois, l’année pour l’âge).',
        'One list for the whole family: everyone adds to it, and every Birthdays block uses it. One person per line, the date last (month/day, the year for the age).', 'Eén lijst voor het hele gezin: iedereen vult aan en elk blok Verjaardagen gebruikt ze. Eén persoon per regel, de datum als laatste (maand/dag, het jaar voor de leeftijd).',
      )}</p>
      <textarea class="input" rows="10" value=${draft} placeholder=${T('Mamie, 02/01/1950\nLéo, 12/03/2014', 'Grandma, 01/02/1950\nLeo, 03/12/2014', 'Oma, 01/02/1950\nLeo, 03/12/2014')}
        onInput=${(e) => setDraft(e.target.value)}></textarea>
    </${Sheet}>`}`;
}

function BinsEdit({ value, onChange }) {
  const rows = value?.length ? value : [{ name: '', days: ['lundi'], every: 1 }];
  const set = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return html`<div class="bins">
    ${rows.map((r, i) => html`<div class="bin-row" key=${i}>
      <div class="item">
        <input class="input" value=${r.name} placeholder=${T('Bac jaune, verre…', 'Yellow bin, glass…', 'Gele bak, glas…')} onInput=${(e) => set(i, { name: e.target.value })} />
        <button type="button" class="iconbtn danger" aria-label=${T('Retirer', 'Remove', 'Verwijderen')} onClick=${() => onChange(rows.filter((_, j) => j !== i))}><${Icon} name="x" /></button>
      </div>
      <div class="bin-when">
        <select class="input" value=${r.days?.[0] || 'lundi'} onChange=${(e) => set(i, { days: [e.target.value] })}>
          ${WEEKDAYS.map(([v, t]) => html`<option value=${v}>${t}</option>`)}</select>
        <select class="input" value=${r.every || 1} onChange=${(e) => set(i, { every: Number(e.target.value) })}>
          ${EVERY.map(([v, t]) => html`<option value=${v}>${t}</option>`)}</select>
      </div>
      ${(r.every || 1) > 1 && html`<label class="help">${T('Un jour de ramassage connu, pour caler les semaines :', 'A known pickup day, to line up the weeks:', 'Een bekende ophaaldag, om de weken af te stemmen:')}
        <input class="input" type="date" value=${r.from || ''} onInput=${(e) => set(i, { from: e.target.value })} /></label>`}
    </div>`)}
    <button type="button" class="btn ghost small" onClick=${() => onChange([...rows, { name: '', days: ['lundi'], every: 1 }])}>
      <${Icon} name="plus" size=${16} /> ${T('Ajouter un ramassage', 'Add a pickup', 'Ophaling toevoegen')}</button>
  </div>`;
}

// Formats du cadre (largeur / hauteur) : le ticket imprime exactement la zone cadrée.
const PHOTO_FORMATS = [['portrait', T('Portrait', 'Portrait', 'Staand'), 3 / 4], ['carre', T('Carré', 'Square', 'Vierkant'), 1], ['paysage', T('Paysage', 'Landscape', 'Liggend'), 4 / 3]];
const MAX_ZOOM = 5;

function PhotoField({ value, onChange }) {
  const input = useRef();
  const [photo, setPhoto] = useState(null); // { source, url, w, h }
  const [format, setFormat] = useState('portrait');
  const [view, setView] = useState({ zoom: 1, cx: 0.5, cy: 0.5 }); // zoom 1 : la photo couvre le cadre
  const [busy, setBusy] = useState(false);
  // Le cadrage se fait dans une fenêtre à part : dans la page, le doigt doit faire défiler.
  const [editing, setEditing] = useState(false);
  const pick = async (file) => {
    if (!file) return;
    try {
      const source = await loadPhoto(file);
      const w = source.width, h = source.height;
      setFormat(w > h * 1.15 ? 'paysage' : h > w * 1.15 ? 'portrait' : 'carre');
      setView({ zoom: 1, cx: 0.5, cy: 0.5 });
      setPhoto({ source, url: URL.createObjectURL(file), w, h });
      setEditing(true);
    } catch (e) { toast(e.message, 'error'); }
  };
  const remove = () => { setPhoto(null); onChange(null); if (input.current) input.current.value = ''; };
  const ratio = PHOTO_FORMATS.find(([v]) => v === format)[2];

  // Envoie la zone cadrée une fois le geste terminé ; seul le dernier envoi compte.
  const sent = useRef(0);
  useEffect(() => {
    if (!photo) return;
    const n = ++sent.current;
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        const id = await uploadBlob(await cropPhoto(photo.source, cropArea(photo, ratio, view)));
        if (n === sent.current) onChange(id);
      } catch (e) { toast(e.message, 'error'); } finally { if (n === sent.current) setBusy(false); }
    }, 600);
    return () => clearTimeout(timer);
  }, [photo, ratio, view.zoom, view.cx, view.cy]);

  const chooser = html`<input ref=${input} type="file" accept="image/*" hidden onChange=${(e) => pick(e.target.files[0])} />`;
  if (!photo && !value) {
    return html`<div class="photo-drop" onClick=${() => input.current.click()} role="button" tabindex="0"
      onKeyDown=${(e) => (e.key === 'Enter' || e.key === ' ') && input.current.click()}>${chooser}
      <div><div class="big-emoji">📷</div><strong>${T('Prendre ou choisir une photo', 'Take or choose a photo', 'Foto nemen of kiezen')}</strong></div></div>`;
  }
  // Photo déjà enregistrée (ticket rouvert) : elle est déjà cadrée, on la montre telle quelle.
  if (!photo) {
    return html`<div class="photo-saved">${chooser}
      <img src=${`/api/images/${value}`} alt=${T('Photo choisie', 'Chosen photo', 'Gekozen foto')} />
      <div class="photo-actions">
        <button type="button" class="btn secondary small" onClick=${() => input.current.click()}><${Icon} name="camera" size=${16} /> ${T('Changer de photo', 'Change photo', 'Andere foto kiezen')}</button>
        <button type="button" class="btn ghost small" onClick=${remove}><${Icon} name="x" size=${16} /> ${T('Retirer', 'Remove', 'Verwijderen')}</button>
      </div></div>`;
  }
  return html`<div class="photo-crop">${chooser}
    <button type="button" class="cropper-open" aria-label=${T('Cadrer la photo', 'Crop the photo', 'Foto bijsnijden')} onClick=${() => setEditing(true)}>
      <${Cropper} photo=${photo} ratio=${ratio} view=${view} busy=${busy} /></button>
    <div class="photo-actions">
      <button type="button" class="btn secondary small" onClick=${() => setEditing(true)}><${Icon} name="sliders" size=${16} /> ${T('Cadrer', 'Crop', 'Bijsnijden')}</button>
      <button type="button" class="btn ghost small" onClick=${() => input.current.click()}><${Icon} name="camera" size=${16} /> ${T('Changer de photo', 'Change photo', 'Andere foto kiezen')}</button>
      <button type="button" class="btn ghost small" onClick=${remove}><${Icon} name="x" size=${16} /> ${T('Retirer', 'Remove', 'Verwijderen')}</button>
    </div>
    ${editing && html`<${Sheet} title=${T('Cadrer la photo', 'Crop the photo', 'Foto bijsnijden')} onClose=${() => setEditing(false)}
      footer=${html`<button type="button" class="btn primary block" onClick=${() => setEditing(false)}><${Icon} name="check" /> ${T('Valider le cadrage', 'Confirm crop', 'Uitsnede bevestigen')}</button>`}>
      <div class="photo-editor">
        <${Cropper} photo=${photo} ratio=${ratio} view=${view} onView=${setView} busy=${busy} interactive />
        <div class="photo-tools">
          <${Segmented} options=${PHOTO_FORMATS.map(([v, t]) => [v, t])} value=${format}
            onChange=${(f) => { setFormat(f); setView({ zoom: 1, cx: 0.5, cy: 0.5 }); }} />
          <label class="zoom"><${Icon} name="search" size=${16} />
            <input type="range" min="1" max=${MAX_ZOOM} step="0.01" value=${view.zoom} aria-label="Zoom"
              onInput=${(e) => setView((v) => clampView(photo, ratio, { ...v, zoom: Number(e.target.value) }))} /></label>
        </div>
        <p class="help muted">${T(
          'Glisse pour déplacer, pince ou fais défiler pour zoomer. Le ticket imprime exactement le cadre, en noir et blanc.',
          'Drag to move, pinch or scroll to zoom. The ticket prints exactly the frame, in black and white.', 'Sleep om te verplaatsen, knijp of scroll om te zoomen. Het bonnetje print precies het kader, in zwart-wit.',
        )}</p>
      </div>
    </${Sheet}>`}
  </div>`;
}

// Zone de la photo (en pixels de la photo) visible dans un cadre de rapport `ratio`.
function cropArea(photo, ratio, { zoom, cx, cy }) {
  // À zoom 1, la plus grande zone de ce rapport qui tient dans la photo.
  const fullW = Math.min(photo.w, photo.h * ratio);
  const w = fullW / zoom, h = w / ratio;
  return { x: cx * photo.w - w / 2, y: cy * photo.h - h / 2, w, h };
}

// Garde le zoom dans ses bornes et le cadre entièrement dans la photo.
function clampView(photo, ratio, view) {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom));
  const { w, h } = cropArea(photo, ratio, { ...view, zoom });
  const clamp = (c, half, size) => Math.min(1 - half / size, Math.max(half / size, c));
  return { zoom, cx: clamp(view.cx, w / 2, photo.w), cy: clamp(view.cy, h / 2, photo.h) };
}

// Cadre de la photo : simple aperçu dans la page, ou cadrage au doigt (`interactive`).
function Cropper({ photo, ratio, view, onView, busy, interactive = false }) {
  const frame = useRef();
  const pointers = useRef(new Map());
  const gesture = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);

  const crop = cropArea(photo, ratio, view);
  const scale = width / crop.w; // pixels à l'écran par pixel de la photo
  // Déplace la vue d'un décalage à l'écran (dx, dy) et zoome d'un facteur autour d'un point.
  const move = (v, dx, dy, factor = 1, at = null) => {
    let { zoom, cx, cy } = v;
    const area = cropArea(photo, ratio, v);
    const s = width / area.w;
    cx -= dx / s / photo.w;
    cy -= dy / s / photo.h;
    if (factor !== 1 && at) {
      const rect = frame.current.getBoundingClientRect();
      // Le point de la photo sous le doigt reste sous le doigt.
      const px = area.x + (at.x - rect.left) / s, py = area.y + (at.y - rect.top) / s;
      const next = Math.min(MAX_ZOOM, Math.max(1, zoom * factor));
      const k = zoom / next;
      cx = (px + (cx * photo.w - px) * k) / photo.w;
      cy = (py + (cy * photo.h - py) * k) / photo.h;
      zoom = next;
    }
    return clampView(photo, ratio, { zoom, cx, cy });
  };
  const snapshot = () => {
    const pts = [...pointers.current.values()];
    const mid = { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
    const dist = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    return { mid, dist };
  };
  const down = (e) => {
    // La capture garde le geste même si le doigt sort du cadre ; simple confort.
    try { frame.current.setPointerCapture(e.pointerId); } catch { /* pointeur déjà relâché */ }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gesture.current = snapshot();
  };
  const moveEvt = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const prev = gesture.current, now = snapshot();
    const factor = prev.dist && now.dist ? now.dist / prev.dist : 1;
    onView((v) => move(v, now.mid.x - prev.mid.x, now.mid.y - prev.mid.y, factor, now.mid));
    gesture.current = now;
  };
  const up = (e) => {
    pointers.current.delete(e.pointerId);
    gesture.current = pointers.current.size ? snapshot() : null;
  };
  const wheel = (e) => {
    e.preventDefault();
    onView((v) => move(v, 0, 0, Math.exp(-e.deltaY * 0.0015), { x: e.clientX, y: e.clientY }));
  };
  useEffect(() => {
    if (!interactive) return undefined;
    // Écouteur non passif : la molette zoome au lieu de faire défiler la page.
    const el = frame.current;
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });

  const gestures = interactive ? { onPointerDown: down, onPointerMove: moveEvt, onPointerUp: up, onPointerCancel: up } : {};
  // Le format prime : sur un écran bas, c'est la largeur qui s'adapte à la hauteur permise.
  const size = { aspectRatio: String(ratio), width: `min(100%, calc(${interactive ? 58 : 70}dvh * ${ratio}))` };
  return html`<div class="cropper ${interactive ? 'interactive' : ''}" ref=${frame} style=${size} ...${gestures}>
    ${width > 0 && html`<img src=${photo.url} alt=${T('Photo à cadrer', 'Photo to crop', 'Foto om bij te snijden')} draggable="false"
      style=${{ width: `${photo.w * scale}px`, height: `${photo.h * scale}px`, left: `${-crop.x * scale}px`, top: `${-crop.y * scale}px` }} />`}
    <div class="cropper-grid" aria-hidden="true"></div>
    ${busy && html`<div class="cropper-busy"><${Spinner} /></div>`}
  </div>`;
}

function FieldInput({ field, value, onChange }) {
  switch (field.kind) {
    case 'textarea':
      return html`<textarea class="input" rows="3" value=${value ?? ''} placeholder=${field.placeholder} onInput=${(e) => onChange(e.target.value)}></textarea>`;
    case 'number':
      return html`<input class="input" type="number" inputmode="numeric" min=${field.min} max=${field.max} value=${value ?? ''}
        placeholder=${field.optional ? T('Au hasard', 'Random', 'Willekeurig') : ''} onInput=${(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />`;
    case 'select':
      return html`<select class="input" value=${value ?? ''} onChange=${(e) => onChange(e.target.value)}>
        ${field.options.map(([v, text]) => html`<option value=${v}>${text}</option>`)}
      </select>`;
    case 'segmented':
      return html`<${Segmented} options=${field.options} value=${value} onChange=${onChange} />`;
    case 'multi':
      return html`<${Multi} options=${field.options} value=${value} onChange=${onChange} />`;
    case 'icons':
      return html`<div class="pictos">${field.options.map(([v, emoji]) => html`<button type="button" class=${v === value ? 'on' : ''}
        aria-label=${v} onClick=${() => onChange(v)}>${emoji}</button>`)}</div>`;
    case 'list':
      return html`<${ListEdit} value=${value} onChange=${onChange} placeholder=${field.placeholder} add=${field.add} />`;
    case 'date':
      return html`<input class="input" type="date" value=${value ?? ''} onInput=${(e) => onChange(e.target.value)} />`;
    case 'month':
      return html`<input class="input" type="month" value=${value ?? ''} onInput=${(e) => onChange(e.target.value)} />`;
    case 'bins':
      return html`<${BinsEdit} value=${value} onChange=${onChange} />`;
    case 'familyBirthdays':
      return html`<${FamilyBirthdays} />`;
    case 'image':
      return html`<${PhotoField} value=${value} onChange=${onChange} />`;
    default:
      return html`<input class="input" value=${value ?? ''} placeholder=${field.placeholder} maxlength=${field.maxlength}
        onInput=${(e) => onChange(e.target.value)} />`;
  }
}

function BlockFields({ data, onChange }) {
  const def = BLOCK[data.type];
  if (!def?.fields.length) {
    const hint = def?.desc?.toLowerCase() || T('ce bloc se suffit à lui-même', 'this block is self-explanatory', 'dit blok spreekt voor zich');
    return html`<p class="muted first" style="margin-bottom:0">${T(`Rien à régler : ${hint}.`, `Nothing to set up: ${hint}.`, `Niets in te stellen: ${hint}.`)}</p>`;
  }
  const set = (key) => (v) => onChange({ ...data, [key]: v });
  // `when` : champ affiché seulement s'il a un sens pour les réglages en cours.
  const fields = def.fields.filter((f) => !f.when || f.when(data));
  return html`<div class="first">${fields.map((f) => f.kind === 'toggle'
    ? html`<${Switch} key=${f.key} label=${f.label} help=${f.help} checked=${data[f.key]} onChange=${set(f.key)} />`
    : html`<${Field} key=${f.key} label=${f.label} help=${f.help}><${FieldInput} field=${f} value=${data[f.key]} onChange=${set(f.key)} /></${Field}>`)}
  </div>`;
}

// ============================================================================
// Fenêtres
// ============================================================================

function Sheet({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, []);
  return html`<div class="overlay" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="sheet ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label=${title}>
      <div class="grabber"></div>
      <div class="sheet-head"><h2>${title}</h2>
        <button class="iconbtn" aria-label=${T('Fermer', 'Close', 'Sluiten')} onClick=${onClose}><${Icon} name="x" /></button></div>
      ${children}
      ${footer && html`<div class="sheet-foot">${footer}</div>`}
    </div>
  </div>`;
}

function Confirm({ title, message, action, danger, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  return html`<${Sheet} title=${title} onClose=${onClose} footer=${html`
    <button class="btn secondary" onClick=${onClose}>${T('Annuler', 'Cancel', 'Annuleren')}</button>
    <button class="btn ${danger ? 'danger' : 'primary'} grow" disabled=${busy}
      onClick=${async () => { setBusy(true); try { await onConfirm(); onClose(); } finally { setBusy(false); } }}>
      ${busy ? html`<${Spinner} />` : action}</button>`}>
    <p style="margin-top:0">${message}</p>
  </${Sheet}>`;
}

// ============================================================================
// Aperçu : ruban de papier
// ============================================================================

function Paper({ preview, loading }) {
  if (!preview) {
    return html`<div class="paper-wrap"><div class="paper ${loading ? 'loading' : ''}"><div class="paper-empty">
      ${loading ? html`<${Spinner} />` : T('Ajoute des blocs pour voir ton ticket ici.', 'Add blocks to see your ticket here.', 'Voeg blokken toe om je bonnetje hier te zien.')}</div></div></div>`;
  }
  const dots = preview.paper_dots || 512;
  return html`<div class="paper-wrap"><div class="paper ${loading ? 'loading' : ''}" style=${{ '--cols': dots / 12 }}>
    ${preview.ops.length === 0 && html`<div class="paper-empty">${T('Ton ticket est vide.', 'Your ticket is empty.', 'Je bonnetje is leeg.')}</div>`}
    ${preview.ops.map((op, i) => {
      if (op.t === 'cut') return html`<div class="cut" key=${i} role="separator" aria-label=${T('Coupe', 'Cut', 'Knippen')}><${Icon} name="scissors" /></div>`;
      if (op.t === 'feed') return html`<div class="feed" key=${i} style=${{ height: `${op.n * 1.32}em` }}></div>`;
      if (op.t === 'image') return html`<img class="img" key=${i} src=${op.src} alt="" style=${{ aspectRatio: `${op.width} / ${op.height}`, width: `${(100 * op.width) / dots}%`, display: 'block', margin: '2px auto' }} />`;
      const cls = ['ln', op.bold && 'b', op.underline && 'u', op.reverse && 'r', op.small && 'small', op.flip && 'flip',
        op.align === 'center' && 'c', op.align === 'right' && 'rt'].filter(Boolean).join(' ');
      const size = op.size > 1 ? { fontSize: `${op.size * 100}%`, lineHeight: 1.18 } : null;
      return html`<div class=${cls} key=${i} style=${size}><span>${op.text}</span></div>`;
    })}
  </div></div>`;
}

function PaperMeta({ preview }) {
  if (!preview) return null;
  const cm = Math.round((preview.height_dots / 180) * 2.54);
  const failed = preview.reports.filter((r) => r.error).length;
  const count = preview.reports.length;
  return html`<div class="paper-meta">
    <span>${T(`≈ ${cm} cm de papier`, `≈ ${cm} cm of paper`, `≈ ${cm} cm papier`)}</span>
    ${failed ? html`<span style="color:var(--danger)">${T(`${failed} bloc${failed > 1 ? 's' : ''} en erreur`, `${failed} block${failed > 1 ? 's' : ''} in error`, `${failed} blok${failed > 1 ? 'ken' : ''} met fout`)}</span>`
      : html`<span>${T(`${count} bloc${count > 1 ? 's' : ''}`, `${count} block${count > 1 ? 's' : ''}`, `${count} blok${count > 1 ? 'ken' : ''}`)}</span>`}
  </div>`;
}

// Calcule l'aperçu d'un ticket, en différé pendant la saisie.
function usePreview(ticket) {
  const key = JSON.stringify(ticket);
  const debounced = useDebounced(key, 450);
  const [state, setState] = useState({ preview: null, loading: false });
  useEffect(() => {
    let alive = true;
    const t = JSON.parse(debounced);
    if (!t.blocks.length) { setState({ preview: null, loading: false }); return; }
    setState((s) => ({ ...s, loading: true }));
    api('POST', '/api/preview', { ticket: t })
      .then((preview) => alive && setState({ preview, loading: false }))
      .catch((e) => alive && setState((s) => ({ preview: s.preview, loading: false, error: e.message })));
    return () => { alive = false; };
  }, [debounced]);
  return { ...state, loading: state.loading || key !== debounced };
}

// ============================================================================
// Écran : connexion
// ============================================================================

// Après un changement de réglages, le serveur se relance (systemd ou Docker) : on attend qu'il
// réponde de nouveau, puis on recharge la page, dans la bonne langue.
async function waitForRestart() {
  await new Promise((r) => setTimeout(r, 1500));
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch('/api/status', { credentials: 'same-origin' })).ok) { location.reload(); return; }
    } catch { /* pas encore relancé */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  toast(T('Printr met du temps à redémarrer. Recharge la page dans un instant.', 'Printr is taking a while to restart. Reload the page in a moment.', 'Bonnetje heeft tijd nodig om te herstarten. Laad de pagina zo opnieuw.'), 'warn');
}

const Restarting = () => html`<div class="restarting" role="status"><${Spinner} />
  <p class="muted">${T('Printr redémarre pour appliquer les réglages…', 'Printr is restarting to apply the settings…', 'Bonnetje herstart om de instellingen toe te passen…')}</p></div>`;

// Restaurer une sauvegarde : tout est remplacé (l'état actuel reste gardé sur le Pi), puis chacun se
// reconnecte. Depuis « Mon compte » (administrateur), ou sur une installation neuve.
function RestoreButton({ cls = 'btn secondary small', label }) {
  const input = useRef();
  const [file, setFile] = useState(null);
  const [restarting, setRestarting] = useState(false);
  const restore = async () => {
    try {
      const r = await api('POST', '/api/restore', file);
      toast(T(`Sauvegarde restaurée : ${r.users} compte(s), ${r.presets} ticket(s)`, `Backup restored: ${r.users} account(s), ${r.presets} ticket(s)`, `Back-up hersteld: ${r.users} account(s), ${r.presets} bonnetje(s)`), 'ok', '📦');
      if (r.restarting) { setRestarting(true); waitForRestart(); } else setTimeout(() => location.reload(), 1200);
    } catch (e) { toast(e.message, 'error'); }
  };
  return html`<button type="button" class=${cls} onClick=${() => input.current.click()}>${label}</button>
    <input ref=${input} type="file" accept=".json,application/json" hidden
      onChange=${(e) => { setFile(e.target.files[0] || null); e.target.value = ''; }} />
    ${file && html`<${Confirm} title=${T('Restaurer cette sauvegarde ?', 'Restore this backup?', 'Deze back-up herstellen?')} danger action=${T('Restaurer', 'Restore', 'Herstellen')}
      message=${T(
        `« ${file.name} » remplace les comptes, les tickets, l’historique, les réglages et les photos de ce Printr. L’état actuel reste gardé sur le Pi, au cas où. Chacun devra se reconnecter.`,
        `“${file.name}” replaces the accounts, tickets, history, settings and photos of this Printr. The current state is kept on the Pi, just in case. Everyone will have to sign in again.`, `“${file.name}” vervangt de accounts, bonnetjes, geschiedenis, instellingen en foto's van deze Bonnetje. De huidige staat blijft voor alle zekerheid bewaard op de Pi. Iedereen moet opnieuw inloggen.`,
      )}
      onConfirm=${restore} onClose=${() => setFile(null)} />`}
    ${restarting && html`<div class="overlay"><div class="sheet"><${Restarting} /></div></div>`}`;
}

// Premier lancement : aucun compte encore, on crée le sien directement ici (et on choisit la langue).
function FirstAccount({ onLogin }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [lang, setLang] = useState(LANG || 'fr');
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { user, restarting } = await api('POST', '/api/setup', { name, password, lang });
      store.set('printr.lastUser', user.id);
      if (restarting) { setRestarting(true); waitForRestart(); return; }
      toast(T(`Bienvenue ${user.name} !`, `Welcome, ${user.name}!`, `Welkom, ${user.name}!`), 'ok', '🎉');
      onLogin(user);
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  if (restarting) return html`<${Restarting} />`;
  return html`<form class="first-account" onSubmit=${submit}>
    <div class="first-lang"><${Segmented} options=${[['nl', 'Nederlands'], ['fr', 'Français'], ['en', 'English']]} value=${lang} onChange=${setLang} /></div>
    <p style="margin:24px 0 14px"><strong>${T('Bienvenue !', 'Welcome!', 'Welkom!')}</strong><br/><span class="muted">${T(
      'Crée ton compte pour commencer. Tu pourras ensuite ajouter le reste de la famille.',
      'Create your account to get started. You can add the rest of the family afterwards.', 'Maak je account aan om te beginnen. Daarna kun je de rest van het gezin toevoegen.',
    )}</span></p>
    <div class="field"><input class="input" placeholder=${T('Ton prénom', 'Your first name', 'Je voornaam')} autocomplete="username" value=${name} onInput=${(e) => setName(e.target.value)} autofocus /></div>
    <div class="field"><input class="input" type="password" placeholder=${T('Mot de passe (8 caractères minimum)', 'Password (8 characters minimum)', 'Wachtwoord (minimaal 8 tekens)')} autocomplete="new-password"
      value=${password} onInput=${(e) => setPassword(e.target.value)} /></div>
    <button class="btn primary big block" disabled=${busy || !name.trim() || password.length < 8}>${busy ? html`<${Spinner} />` : T('Créer mon compte', 'Create my account', 'Mijn account aanmaken')}</button>
    <div class="first-restore"><${RestoreButton} cls="btn ghost small" label=${T('Ou restaurer une sauvegarde', 'Or restore a backup', 'Of herstel een back-up')} /></div>
  </form>`;
}

function Login({ onLogin }) {
  const [users, setUsers] = useState(null);
  const [who, setWho] = useState(store.get('printr.lastUser'));
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const field = useRef();

  useEffect(() => { api('GET', '/api/users').then(setUsers).catch(() => setUsers([])); }, []);
  useEffect(() => { if (who) field.current?.focus(); }, [who]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { user } = await api('POST', '/api/login', { user_id: who, password });
      store.set('printr.lastUser', user.id);
      onLogin(user);
    } catch (err) {
      toast(err.message, 'error');
      setShake(true);
      setTimeout(() => setShake(false), 450);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return html`<div class="login"><div class="login-card">
    <img class="logo" src="/mark.png" alt="" />
    <h1>Printr</h1>
    <p class="muted" style="margin:0">${T("L'imprimante de la maison", 'The printer of the house', 'De printer van het huis')}</p>
    ${users === null ? html`<div style="margin:32px"><${Spinner} /></div>` : users.length === 0
      ? html`<${FirstAccount} onLogin=${onLogin} />`
      : html`<div class="who">${users.map((u) => html`<button type="button" class=${who === u.id ? 'on' : ''}
          style=${{ color: u.color }} onClick=${() => setWho(u.id)}><${Avatar} user=${u} size="large" />
          <span style="color:var(--ink-2)">${u.name}</span></button>`)}</div>`}
    ${who && users?.length > 0 && html`<form onSubmit=${submit} class=${shake ? 'shake' : ''}>
      <div class="field"><input ref=${field} class="input" type="password" autocomplete="current-password"
        placeholder=${T('Mot de passe', 'Password', 'Wachtwoord')} value=${password} onInput=${(e) => setPassword(e.target.value)}
        style="text-align:center;font-size:18px;min-height:52px" /></div>
      <button class="btn primary big block" disabled=${busy || !password}>${busy ? html`<${Spinner} />` : T('Entrer', 'Sign in', 'Inloggen')}</button>
    </form>`}
  </div></div>`;
}

// ============================================================================
// Écran : accueil (presets)
// ============================================================================

function PresetCard({ preset, me, onPrint, onEdit, onCopy, onDelete }) {
  const [busy, setBusy] = useState(false);
  const mine = preset.owner?.id === me.id;
  const blocks = preset.ticket?.blocks || [];
  const print = async () => { setBusy(true); try { await onPrint(preset); } finally { setBusy(false); } };
  return html`<div class="card preset">
    <div class="preset-head">
      <div class="preset-icon">${preset.icon || '🧾'}</div>
      <div class="grow">
        <h3>${preset.name}</h3>
        <div class="meta">
          ${preset.schedules?.filter((s) => s.enabled).map((s) => html`<span class="chip accent" key=${s.id}><${Icon} name="clock" />${scheduleLabel(s)}</span>`)}
          ${preset.shared && mine && html`<span class="chip"><${Icon} name="users" />${T('Partagé', 'Shared', 'Gedeeld')}</span>`}
          ${!mine && preset.owner && html`<span class="chip"><${Avatar} user=${preset.owner} size="small" />${preset.owner.name}</span>`}
        </div>
      </div>
    </div>
    <div class="blocks-line">${blocks.map((b) => `${BLOCK[b.type]?.emoji || '▫️'} ${BLOCK[b.type]?.label || b.type}`).join('  ·  ') || T('Ticket vide', 'Empty ticket', 'Leeg bonnetje')}</div>
    <div class="preset-actions">
      <button class="btn primary small" disabled=${busy} onClick=${print}>${busy ? html`<${Spinner} />` : html`<${Icon} name="printer" size=${17} />`} ${T('Imprimer', 'Print', 'Printen')}</button>
      ${mine
        ? html`<button class="btn secondary small" onClick=${() => onEdit(preset)}><${Icon} name="edit" size=${16} /> ${T('Modifier', 'Edit', 'Bewerken')}</button>`
        : html`<button class="btn secondary small" onClick=${() => onCopy(preset)}><${Icon} name="copy" size=${16} /> ${T('Copier', 'Copy', 'Kopiëren')}</button>`}
      <span class="grow"></span>
      ${mine && html`<button class="iconbtn" aria-label=${T('Dupliquer', 'Duplicate', 'Dupliceren')} title=${T('Dupliquer', 'Duplicate', 'Dupliceren')} onClick=${() => onCopy(preset)}><${Icon} name="copy" /></button>
        <button class="iconbtn danger" aria-label=${T('Supprimer', 'Delete', 'Verwijderen')} title=${T('Supprimer', 'Delete', 'Verwijderen')} onClick=${() => onDelete(preset)}><${Icon} name="trash" /></button>`}
    </div>
  </div>`;
}

function Home({ me, presets, reload, openComposer }) {
  const [confirm, setConfirm] = useState(null);
  const mine = presets?.filter((p) => p.owner?.id === me.id) || [];
  const family = presets?.filter((p) => p.owner?.id !== me.id) || [];
  const hour = new Date().getHours();
  const hello = hour < 5 ? T('Bonne nuit', 'Good night', 'Goedenacht') : hour < 18 ? T('Bonjour', 'Hello', 'Hallo') : T('Bonsoir', 'Good evening', 'Goedenavond');
  const today = new Date().toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });

  const print = async (preset) => {
    try {
      printedToast(await api('POST', `/api/presets/${preset.id}/print`));
    } catch (e) { toast(e.message, 'error'); }
  };
  const remove = (preset) => setConfirm({
    title: T('Supprimer ce ticket ?', 'Delete this ticket?', 'Dit bonnetje verwijderen?'),
    message: html`${T('« ', '“', '“')}${preset.name}${T(' » et ses planifications seront supprimés définitivement.', '” and its schedules will be permanently deleted.', '” en de bijbehorende planningen worden definitief verwijderd.')}`,
    action: T('Supprimer', 'Delete', 'Verwijderen'), danger: true,
    onConfirm: async () => { await api('DELETE', `/api/presets/${preset.id}`); toast(T('Ticket supprimé', 'Ticket deleted', 'Bonnetje verwijderd'), 'ok', '🗑️'); reload(); },
  });
  const cards = (list) => html`<div class="presets">${list.map((p) => html`<${PresetCard} key=${p.id} preset=${p} me=${me}
    onPrint=${print} onEdit=${(x) => openComposer(composerFromPreset(x))} onCopy=${(x) => openComposer(composerFromPreset(x, true))} onDelete=${remove} />`)}</div>`;

  return html`<div class="page">
    <h2 style="margin:4px 2px 2px;font-size:26px;letter-spacing:-0.02em">${hello} ${me.name} 👋</h2>
    <p class="muted" style="margin:0 2px 18px">${capitalize(today)}</p>
    <div class="hero">
      <a class="action-card coral" href="#/message"><div class="big-emoji">💌</div><div><strong>${T('Petit mot', 'Little note', 'Briefje')}</strong><span>${T('Une photo, quelques mots', 'A photo, a few words', 'Een foto, een paar woorden')}</span></div></a>
      <button class="action-card sky" onClick=${() => openComposer(emptyComposer())}><div class="big-emoji">🧾</div><div><strong>${T('Nouveau ticket', 'New ticket', 'Nieuw bonnetje')}</strong><span>${T('Compose bloc par bloc', 'Compose block by block', 'Stel blok per blok samen')}</span></div></button>
      <a class="action-card mint wide" href="#/courses"><div class="big-emoji">🛒</div><div><strong>${T('Courses', 'Shopping', 'Boodschappen')}</strong><span>${T('La liste de toute la famille', "The whole family's list", "De lijst van het hele gezin")}</span></div></a>
    </div>
    <div class="section-title">${T('Mes tickets', 'My tickets', 'Mijn bonnetjes')}</div>
    ${presets === null ? html`<div style="padding:30px;display:grid;place-items:center"><${Spinner} /></div>`
      : mine.length ? cards(mine)
      : html`<div class="empty"><div class="big-emoji">🌱</div><h3>${T('Pas encore de ticket enregistré', 'No saved ticket yet', 'Nog geen opgeslagen bonnetje')}</h3>
          <p class="muted" style="margin:0 0 16px">${T(
            "Compose un ticket, puis enregistre-le pour l'imprimer en un geste… ou chaque matin.",
            'Compose a ticket, then save it to print it in one tap… or every morning.', 'Stel een bonnetje samen en sla het op om het met één tik te printen… of elke ochtend.',
          )}</p>
          <button class="btn primary" onClick=${() => openComposer(emptyComposer())}><${Icon} name="plus" /> ${T('Composer mon premier ticket', 'Compose my first ticket', 'Mijn eerste bonnetje samenstellen')}</button></div>`}
    ${family.length > 0 && html`<div class="section-title">${T('Partagés par la famille', 'Shared by the family', 'Gedeeld door het gezin')}</div>${cards(family)}`}
    ${confirm && html`<${Confirm} ...${confirm} onClose=${() => setConfirm(null)} />`}
  </div>`;
}

// ============================================================================
// Écran : composer
// ============================================================================

// Ticket d'exemple de chaque bloc (celui du site, intégré au binaire), montré au clic sur l'œil.
const EXAMPLE = {
  fortune: 'fortune',
  hashi: 'hashi',
  takuzu: 'takuzu',
  kakuro: 'kakuro',
  story: 'histoire',
  birthdays: 'anniversaires',
  chess: 'echecs',
  title: 'titre', text: 'texte', date: 'date', separator: 'separateur', feed: 'espace', cut: 'coupe', image: 'image', qr: 'qr',
  picto: 'pictogramme', weather: 'meteo', barnum: 'horoscope', horoscope: 'horoscope_claude', word_of_the_day: 'mot_du_jour',
  saint: 'saint', quote: 'citation', moon: 'lune', sun: 'soleil', sky: 'ciel', air_quality: 'air', holidays: 'jours_feries',
  countdown: 'compte_a_rebours', riddle: 'enigme', workout: 'defi_sportif', sudoku: 'sudoku', maze: 'labyrinthe',
  word_search: 'mots_meles', train_tracks: 'voie_ferree', arrow_word: 'mots_fleches', crossword: 'mots_croises', nonogram: 'logimage',
  petit_bac: 'petit_bac', mental_math: 'calcul_mental', anagram: 'mot_mystere', cipher: 'message_code',
  coloring: 'coloriage', coupon: 'bon', news: 'actualites', on_this_day: 'ephemeride', crypto: 'crypto', todo: 'a_faire',
  chores: 'taches', shopping: 'courses', recipe: 'recette', recipe_claude: 'recette_claude', recipe_from_ingredients: 'recette_ingredients', agenda: 'agenda', bins: 'poubelles', wifi: 'wifi', monthly_report: 'bilan',
};
const exampleUrl = (type) => EXAMPLE[type] && `/exemples/${EN || NL ? 'en/' : ''}${EXAMPLE[type]}.png`;

// Mots-clés de recherche, dans les deux langues, en plus du nom et de la description.
const KEYWORDS = {
  fortune: 'fortune cowsay vache cow biscuit cookie chinois proverbe proverb maxime blague joke hasard random',
  hashi: 'hashi ponts bridges iles islands relier connect logique logic casse-tete puzzle',
  takuzu: 'takuzu binairo binaire binary 0 1 zero un one grille grid logique logic casse-tete puzzle',
  kakuro: 'kakuro sommes sums chiffres digits mots croises crossword nombres numbers casse-tete puzzle',
  story: 'histoire story conte tale soir bedtime dodo sleep enfants kids children claude ia ai',
  birthdays: 'anniversaires birthdays age fete party famille family compte a rebours countdown',
  chess: 'echecs chess probleme puzzle lichess mat checkmate echiquier board strategie',
  chores: 'taches menageres chores menage housework corvees rotation famille family planning',
  title: 'titre title gros big', text: 'texte text paragraphe paragraph message', date: 'date jour day calendrier',
  separator: 'separateur separator ligne line trait', feed: 'espace space blanc vide blank', cut: 'coupe cut couper ciseaux scissors morceau piece',
  image: 'image photo picture', qr: 'qr code lien link url', picto: 'pictogramme pictogram coeur heart etoile star dessin drawing',
  weather: 'meteo weather pluie rain temps soleil sun temperature', barnum: 'horoscope astrologie astrology signe sign zodiaque ciel sky',
  horoscope: 'horoscope astrologie astrology signe sign zodiaque claude ia ai', word_of_the_day: 'mot word definition vocabulaire vocabulary claude',
  saint: 'saint fete name day prenom', quote: 'citation quote phrase', moon: 'lune moon phase', sun: 'soleil sun lever coucher sunrise sunset',
  sky: 'ciel sky etoiles stars planetes planets iss station spatiale space astronomie astronomy nuit night',
  air_quality: 'air pollution pollen qualite quality', holidays: 'feries holidays conge vacances',
  countdown: 'compte rebours countdown jours days vacances', riddle: 'enigme riddle devinette charade logique',
  workout: 'sport defi workout exercice exercise', sudoku: 'sudoku grille chiffres numbers puzzle', maze: 'labyrinthe maze',
  word_search: 'mots meles word search grille puzzle', train_tracks: 'voie ferree train tracks rails puzzle',
  arrow_word: 'mots fleches arrow words grille',
  crossword: 'mots croises crossword grille grid definitions clues', nonogram: 'logimage nonogram picross pixel',
  petit_bac: 'petit bac categories jeu game', mental_math: 'calcul mental math maths additions multiplications tables enfants kids',
  anagram: 'mot mystere anagramme anagram lettres letters', cipher: 'message code secret cesar caesar morse',
  coloring: 'coloriage coloring mandala dessin', coupon: 'bon cadeau coupon gift offrir',
  news: 'actualites news rss presse journal', on_this_day: 'ephemeride histoire history wikipedia', crypto: 'crypto bitcoin ethereum',
  todo: 'faire todo liste list taches tasks',
  recipe: 'recette recipe cuisine cooking ingredients plat dish site', recipe_claude: 'recette recipe cuisine cooking ingredients plat dish claude ia ai',
  recipe_from_ingredients: 'recette recipe cuisine cooking ingredients frigo fridge restes leftovers manger dinner diner repas meal claude ia ai', shopping: 'courses shopping liste list', agenda: 'agenda calendar calendrier evenements ics',
  bins: 'poubelles bins trash dechets recyclage', wifi: 'wifi invites guests reseau network', monthly_report: 'bilan mois monthly report statistiques stats',
};

// Étiquettes des blocs, pour les filtres du catalogue et la recherche (« Claude » vient de `ai`).
const KIDS = ['fortune', 'story', 'picto', 'riddle', 'workout', 'word_search', 'maze', 'nonogram', 'petit_bac', 'mental_math', 'anagram', 'cipher', 'coloring'];
const TOGETHER = ['riddle', 'workout', 'petit_bac', 'anagram'];
// Ni réseau ni Claude : tout est calculé sur place, gratuitement.
const OFFLINE = [
  'title', 'text', 'date', 'separator', 'feed', 'image', 'qr', 'picto', 'barnum', 'saint', 'quote', 'moon', 'holidays', 'countdown',
  'riddle', 'workout', 'sudoku', 'word_search', 'train_tracks', 'maze', 'nonogram', 'petit_bac', 'mental_math', 'anagram', 'cipher',
  'coloring', 'coupon', 'todo', 'shopping', 'bins', 'wifi', 'monthly_report', 'chores', 'birthdays', 'kakuro', 'takuzu', 'hashi', 'fortune',
];
const FILTERS = [
  { id: 'kids', emoji: '🧒', label: T('Pour les enfants', 'For kids', 'Voor kinderen'), words: 'enfants enfant kids children', test: (b) => KIDS.includes(b.type) },
  { id: 'offline', emoji: '📴', label: T('Hors ligne et gratuit', 'Offline and free', 'Offline en gratis'), words: 'hors ligne gratuit offline free', test: (b) => OFFLINE.includes(b.type) },
  { id: 'together', emoji: '👥', label: T('À plusieurs', 'Together', 'Samen'), words: 'plusieurs ensemble famille together group family', test: (b) => TOGETHER.includes(b.type) },
  { id: 'claude', emoji: '✨', label: 'Claude', words: 'claude ia ai', test: (b) => !!b.ai },
];
const tagWords = (b) => FILTERS.filter((f) => f.test(b)).map((f) => f.words).join(' ');
const GROUP_ORDER = Object.values(G);

// Ce que le serveur dit du catalogue (relu avec `/api/status`) : blocs retirés par l'administrateur,
// Claude disponible ou non.
const CATALOG = { hidden: [], claude: true };
// Sans Claude, ces blocs n'impriment rien d'utile ; les grilles, elles, gardent leurs définitions en cache.
const NEEDS_CLAUDE = ['story', 'horoscope', 'word_of_the_day', 'recipe_claude', 'recipe_from_ingredients'];
const offered = (b) => !CATALOG.hidden.includes(b.type) && (CATALOG.claude || !NEEDS_CLAUDE.includes(b.type));

// Sans accents ni majuscules : « meteo » trouve « Météo ».
const fold = (text) => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Favoris et récents du compte, gardés par le serveur ; ici, la dernière version lue (le catalogue
// s'ouvre aussitôt, puis se met à jour). Avant la 1.9, ils étaient dans le navigateur : ces clés-là
// sont reprises une fois dans le compte, puis effacées.
const MY_CATALOG = { favorites: [], recent: [] };
const OLD_FAVORITES = 'printr.favorites';
const OLD_RECENT = 'printr.recent';

async function loadMyCatalog() {
  const mine = await api('GET', '/api/me/catalog');
  const old = { favorites: store.get(OLD_FAVORITES, []), recent: store.get(OLD_RECENT, []) };
  if (!mine.favorites.length && !mine.recent.length && (old.favorites.length || old.recent.length)) {
    await api('PUT', '/api/me/catalog', old);
    Object.assign(mine, old);
  }
  store.del(OLD_FAVORITES);
  store.del(OLD_RECENT);
  return Object.assign(MY_CATALOG, { favorites: mine.favorites, recent: mine.recent });
}

// Exemple d'un bloc, en grand, avant de l'ajouter.
function ExampleSheet({ block, onPick, onClose }) {
  return html`<${Sheet} title=${`${block.emoji} ${block.label}`} onClose=${onClose} footer=${html`
    <button class="btn primary grow" onClick=${() => onPick(block.type)}><${Icon} name="plus" /> ${T('Ajouter ce bloc', 'Add this block', 'Dit blok toevoegen')}</button>`}>
    <p class="muted" style="margin:0 0 12px">${block.desc}</p>
    <div class="example-ticket"><img src=${exampleUrl(block.type)} alt=${block.label} /></div>
  </${Sheet}>`;
}

function CatalogItem({ block, favorite, onPick, onFavorite, onExample }) {
  const url = exampleUrl(block.type);
  return html`<div class="cat-item">
    <button type="button" class="cat-main" onClick=${() => onPick(block.type)}>
      <span class="emoji">${block.emoji}</span>
      <strong>${block.label}${block.ai && html` <span class="badge">Claude</span>`}</strong><span>${block.desc}</span>
    </button>
    <div class="cat-tools">
      ${url && html`<button type="button" class="iconbtn" aria-label=${T(`Voir un exemple : ${block.label}`, `See an example: ${block.label}`, `Bekijk een voorbeeld: ${block.label}`)}
        title=${T('Voir un exemple', 'See an example', 'Bekijk een voorbeeld')} onClick=${() => onExample(block)}><${Icon} name="eye" size=${18} /></button>`}
      <button type="button" class="iconbtn star ${favorite ? 'on' : ''}" aria-pressed=${favorite}
        aria-label=${favorite ? T(`Retirer ${block.label} des favoris`, `Remove ${block.label} from favorites`, `${block.label} verwijderen uit favorieten`) : T(`Ajouter ${block.label} aux favoris`, `Add ${block.label} to favorites`, `${block.label} toevoegen aan favorieten`)}
        title=${favorite ? T('Retirer des favoris', 'Remove from favorites', 'Verwijderen uit favorieten') : T('Ajouter aux favoris', 'Add to favorites', 'Toevoegen aan favorieten')}
        onClick=${() => onFavorite(block.type)}>${favorite ? '★' : '☆'}</button>
    </div>
  </div>`;
}

function Catalog({ onPick, onClose }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState(null);
  const [favorites, setFavorites] = useState(MY_CATALOG.favorites);
  const [recent, setRecent] = useState(MY_CATALOG.recent);
  const [example, setExample] = useState(null);
  useEffect(() => {
    loadMyCatalog().then((mine) => { setFavorites(mine.favorites); setRecent(mine.recent); }).catch(() => {});
  }, []);
  const q = fold(query.trim());
  const only = FILTERS.find((f) => f.id === filter);
  const filters = FILTERS.filter((f) => f.id !== 'claude' || CATALOG.claude);
  const matches = BLOCKS.filter((b) => offered(b) && (!only || only.test(b)) && (!q || q.split(/\s+/).every((word) =>
    fold(`${b.label} ${b.desc} ${b.type} ${KEYWORDS[b.type] || ''} ${tagWords(b)}`).includes(word))));
  const groups = [...new Set(matches.map((b) => b.group))].sort((a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b));
  const browsing = !q && !only;

  // Le bloc ajouté passe en tête des récents du compte.
  const pick = (type) => {
    MY_CATALOG.recent = [type, ...recent.filter((t) => t !== type)].slice(0, 8);
    api('PUT', '/api/me/catalog', { recent: MY_CATALOG.recent }).catch(() => {});
    onPick(type);
  };
  const toggleFavorite = (type) => {
    const before = favorites;
    const next = favorites.includes(type) ? favorites.filter((t) => t !== type) : [...favorites, type];
    setFavorites(next);
    MY_CATALOG.favorites = next;
    api('PUT', '/api/me/catalog', { favorites: next }).catch((e) => {
      setFavorites(before);
      MY_CATALOG.favorites = before;
      toast(e.message, 'error');
    });
  };
  const item = (b) => html`<${CatalogItem} key=${b.type} block=${b} favorite=${favorites.includes(b.type)}
    onPick=${pick} onFavorite=${toggleFavorite} onExample=${setExample} />`;
  const section = (title, blocks) => blocks.length > 0 && html`<div class="catalog-group"><h4>${title}</h4><div class="catalog">${blocks.map(item)}</div></div>`;
  const known = (types) => types.map((t) => BLOCK[t]).filter((b) => b && offered(b));
  const favoriteBlocks = known(favorites);
  const recentBlocks = known(recent).filter((b) => !favorites.includes(b.type)).slice(0, 4);

  return html`<${Sheet} title=${T('Ajouter un bloc', 'Add a block', 'Een blok toevoegen')} onClose=${onClose} wide>
    <div class="catalog-search"><input class="input" placeholder=${T('Rechercher : météo, photo, sudoku…', 'Search: weather, photo, sudoku…', 'Zoeken: weer, foto, sudoku…')} value=${query}
      onInput=${(e) => setQuery(e.target.value)} autofocus />
      <div class="cat-filters" role="group" aria-label=${T('Filtrer les blocs', 'Filter blocks', 'Blokken filteren')}>
        ${filters.map((f) => html`<button type="button" key=${f.id} class=${filter === f.id ? 'on' : ''} aria-pressed=${filter === f.id}
          onClick=${() => setFilter(filter === f.id ? null : f.id)}><span aria-hidden="true">${f.emoji}</span> ${f.label}</button>`)}
      </div></div>
    ${browsing && section(T('Mes favoris', 'My favorites', 'Mijn favorieten'), favoriteBlocks)}
    ${browsing && section(T('Récemment ajoutés', 'Recently added', 'Recent toegevoegd'), recentBlocks)}
    ${groups.map((g) => html`<div key=${g}>${section(g, matches.filter((b) => b.group === g))}</div>`)}
    ${matches.length === 0 && html`<p class="muted" style="text-align:center;padding:24px">${T('Aucun bloc ne correspond.', 'No block matches.', 'Geen blok gevonden.')}</p>`}
    ${example && html`<${ExampleSheet} block=${example} onPick=${(t) => { setExample(null); pick(t); }} onClose=${() => setExample(null)} />`}
  </${Sheet}>`;
}

function BlockCard({ item, index, count, error, dragging, onChange, onToggle, onMove, onGrab, onCopy, onRemove }) {
  const def = BLOCK[item.data.type] || { emoji: '▫️', label: item.data.type };
  // L'apparition n'est animée qu'une fois : un bloc déplacé dans la liste ne doit pas « reclignoter ».
  const [shown, setShown] = useState(false);
  const keys = (e) => {
    const d = { ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (!d) return;
    e.preventDefault();
    if (index + d >= 0 && index + d < count) onMove(d);
  };
  return html`<div class="card block ${item.open ? 'open' : ''} ${error ? 'error' : ''} ${shown ? 'shown' : ''} ${dragging ? 'dragging' : ''}"
    data-uid=${item.uid} onAnimationEnd=${(e) => e.target === e.currentTarget && setShown(true)}>
    <div class="block-head" onClick=${onToggle}>
      <button class="grip" aria-label=${T('Déplacer (glisser, ou flèches haut et bas)', 'Move (drag, or use the up and down arrows)', 'Verplaatsen (slepen, of gebruik de pijltjes omhoog en omlaag)')} title=${T('Glisser pour déplacer', 'Drag to move', 'Sleep om te verplaatsen')}
        onClick=${(e) => e.stopPropagation()} onPointerDown=${onGrab} onKeyDown=${keys}><${Icon} name="grip" /></button>
      <div class="block-emoji">${def.emoji}</div>
      <div class="grow">
        <div class="block-title">${def.label}${def.ai ? html` <span class="chip warn" style="height:20px;font-size:11px;margin-left:4px">Claude</span>` : ''}</div>
        <div class="block-summary">${blockSummary(item.data)}</div>
      </div>
      <div class="block-tools" onClick=${(e) => e.stopPropagation()}>
        <button class="iconbtn" aria-label=${T('Dupliquer', 'Duplicate', 'Dupliceren')} onClick=${onCopy}><${Icon} name="copy" /></button>
        <button class="iconbtn danger" aria-label=${T('Supprimer', 'Delete', 'Verwijderen')} onClick=${onRemove}><${Icon} name="trash" /></button>
      </div>
    </div>
    ${error && html`<div class="block-error">${error}</div>`}
    ${item.open && html`<div class="block-body"><${BlockFields} data=${item.data} onChange=${onChange} /></div>`}
  </div>`;
}

// Glisser-déposer des blocs par leur poignée, au doigt comme à la souris. Le bloc suit le pointeur ;
// dès que son bord dépasse le milieu d'un voisin, les deux échangent leur place dans la liste.
// Près du haut ou du bas de l'écran, la page défile toute seule.
function useDragSort(setBlocks) {
  const list = useRef(null);
  const drag = useRef(null);
  const [dragging, setDragging] = useState(null);
  const cards = () => [...(list.current?.children || [])].filter((c) => c.dataset.uid);
  const card = (id) => cards().find((c) => c.dataset.uid === id);

  // Où le pointeur emmène le bloc (en coordonnées de la liste, pour survivre au défilement).
  const target = (d) => d.top + (d.y + scrollY) - d.y0;
  const follow = () => {
    const d = drag.current;
    const el = d && card(d.uid);
    if (el) el.style.transform = `translateY(${target(d) - el.offsetTop}px)`;
  };
  const reorder = (uid, to, neighbor) => {
    const d = drag.current, el = neighbor && card(neighbor);
    if (d) Object.assign(d, { pending: true, flip: el && { uid: neighbor, top: el.offsetTop } });
    setBlocks((b) => {
      const n = [...b];
      const [x] = n.splice(n.findIndex((y) => y.uid === uid), 1);
      n.splice(to, 0, x);
      return n;
    });
  };
  const check = () => {
    const d = drag.current;
    if (!d || d.pending) return follow();
    const all = cards();
    const el = all.find((c) => c.dataset.uid === d.uid);
    const i = all.indexOf(el);
    const top = target(d), bottom = top + el.offsetHeight;
    const prev = all[i - 1], next = all[i + 1];
    if (next && bottom > next.offsetTop + next.offsetHeight / 2) reorder(d.uid, i + 1, next.dataset.uid);
    else if (prev && top < prev.offsetTop + prev.offsetHeight / 2) reorder(d.uid, i - 1, prev.dataset.uid);
    follow();
  };

  // Après chaque échange : le bloc déplacé reste sous le pointeur, le voisin glisse à sa place.
  const settle = () => {
    const d = drag.current;
    if (!d) return;
    d.pending = false;
    const f = d.flip;
    d.flip = null;
    const el = f && card(f.uid);
    if (el) {
      el.style.transition = 'none';
      el.style.transform = `translateY(${f.top - el.offsetTop}px)`;
      el.getBoundingClientRect();
      el.style.transition = 'transform .18s ease';
      el.style.transform = '';
    }
    check();
  };

  const scroll = () => {
    const d = drag.current;
    if (!d) return;
    const edge = 90, bottomEdge = innerHeight - (innerWidth < 900 ? 170 : 110);
    const speed = d.y < edge ? -(edge - d.y) / 5 : d.y > bottomEdge ? (d.y - bottomEdge) / 5 : 0;
    if (speed) { scrollBy(0, Math.max(-18, Math.min(18, speed))); check(); }
    d.frame = requestAnimationFrame(scroll);
  };

  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    cancelAnimationFrame(d.frame);
    removeEventListener('pointermove', d.onMove);
    removeEventListener('pointerup', end);
    removeEventListener('pointercancel', end);
    const el = card(d.uid);
    if (el) {
      el.style.transition = 'transform .18s ease';
      el.style.transform = '';
      setTimeout(() => (el.style.transition = ''), 200);
    }
    setDragging(null);
  };

  const grab = (uid) => (e) => {
    if (e.button !== 0 || drag.current) return;
    e.preventDefault();
    e.stopPropagation();
    const el = card(uid);
    const d = { uid, top: el.offsetTop, y0: e.clientY + scrollY, y: e.clientY, pending: false };
    d.onMove = (ev) => { if (ev.pointerId === e.pointerId) { d.y = ev.clientY; check(); } };
    drag.current = d;
    addEventListener('pointermove', d.onMove);
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
    d.frame = requestAnimationFrame(scroll);
    setDragging(uid);
    // Blocs repliés pendant le déplacement : une liste courte se parcourt mieux, surtout au doigt.
    if (cards().some((c) => c.classList.contains('open'))) {
      d.pending = true;
      setBlocks((b) => b.map((x) => (x.open ? { ...x, open: false } : x)));
    }
  };

  // Clavier : un cran vers le haut ou le bas, et la poignée garde le focus.
  const step = (uid, i, d) => {
    reorder(uid, i + d);
    requestAnimationFrame(() => card(uid)?.querySelector('.grip')?.focus());
  };

  useEffect(() => end, []);
  return { list, dragging, grab, step, settle };
}

const ICON_CHOICES = ['🧾', '☀️', '🌙', '🔮', '💌', '❤️', '📰', '🧩', '💪', '🌤️', '✅', '🎉', '☕', '🏠', '🎂', '🌸'];

// Heure au format 24 h, quel que soit l'appareil : le champ <input type="time"> s'affiche
// en 12 h selon la langue du système, et un « AM » oublié décale l'impression de 12 heures.
function TimePicker({ value, onChange }) {
  const [h, m] = (value || '08:00').split(':');
  const pad = (n) => String(n).padStart(2, '0');
  const minutes = Array.from({ length: 12 }, (_, i) => pad(i * 5));
  if (!minutes.includes(m)) minutes.push(m);
  minutes.sort();
  return html`<div class="time-picker" role="group" aria-label=${T('Heure', 'Time', 'Tijd')}>
    <select aria-label=${T('Heures', 'Hours', 'Uren')} value=${h} onChange=${(e) => onChange(`${e.target.value}:${m}`)}>
      ${Array.from({ length: 24 }, (_, i) => pad(i)).map((v) => html`<option value=${v}>${v}</option>`)}
    </select>
    <span>${T('h', ':', ':')}</span>
    <select aria-label=${T('Minutes', 'Minutes', 'Minuten')} value=${m} onChange=${(e) => onChange(`${h}:${e.target.value}`)}>
      ${minutes.map((v) => html`<option value=${v}>${v}</option>`)}
    </select>
  </div>`;
}

function ScheduleEditor({ schedules, onChange }) {
  const update = (i, patch) => onChange(schedules.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const toggleDay = (i, d) => {
    const days = schedules[i].days.includes(d) ? schedules[i].days.filter((x) => x !== d) : [...schedules[i].days, d];
    update(i, { days: days.sort() });
  };
  return html`<div>
    ${schedules.map((s, i) => html`<div class="schedule" key=${s.id || i}>
      <div class="row wrap" style="justify-content:space-between">
        <div class="days">${DAY_LETTERS.map((l, k) => html`<button type="button" class=${s.days.includes(k + 1) ? 'on' : ''}
          aria-label=${DAY_NAMES[k]} onClick=${() => toggleDay(i, k + 1)}>${l}</button>`)}</div>
        <${TimePicker} value=${s.time} onChange=${(time) => update(i, { time })} />
      </div>
      <div class="row" style="margin-top:8px">
        <div class="quick-days">
          <button type="button" class="btn ghost small" onClick=${() => update(i, { days: [1, 2, 3, 4, 5, 6, 7] })}>${T('Tous les jours', 'Every day', 'Elke dag')}</button>
          <button type="button" class="btn ghost small" onClick=${() => update(i, { days: [1, 2, 3, 4, 5] })}>${T('En semaine', 'Weekdays', 'Op weekdagen')}</button>
          <button type="button" class="btn ghost small" onClick=${() => update(i, { days: [6, 7] })}>${T('Week-end', 'Weekend', 'Weekend')}</button>
        </div>
        <span class="grow"></span>
        <label class="switch" style="padding:0"><input type="checkbox" checked=${s.enabled} onChange=${(e) => update(i, { enabled: e.target.checked })} /><span class="track"></span></label>
        <button class="iconbtn danger" aria-label=${T('Retirer', 'Remove', 'Verwijderen')} onClick=${() => onChange(schedules.filter((_, j) => j !== i))}><${Icon} name="trash" /></button>
      </div>
    </div>`)}
    <button type="button" class="btn secondary small" onClick=${() => onChange([...schedules, { days: [1, 2, 3, 4, 5], time: '08:00', enabled: true }])}>
      <${Icon} name="clock" size=${16} /> ${T('Ajouter un horaire', 'Add a schedule', 'Een planning toevoegen')}</button>
  </div>`;
}

function SaveSheet({ state, onSave, onClose, focusSchedule }) {
  const [draft, setDraft] = useState({ name: state.name, icon: state.icon, shared: state.shared, schedules: clone(state.schedules) });
  const [busy, setBusy] = useState(false);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const invalid = draft.schedules.some((s) => !s.days.length || !s.time);
  const ai = usesAi(state.blocks.map((b) => b.data));
  const save = async () => { setBusy(true); try { await onSave(draft); onClose(); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); } };
  return html`<${Sheet} title=${state.id ? T('Réglages du ticket', 'Ticket settings', 'Bonnetje-instellingen') : T('Enregistrer le ticket', 'Save ticket', 'Bonnetje opslaan')} onClose=${onClose} footer=${html`
    <button class="btn secondary" onClick=${onClose}>${T('Annuler', 'Cancel', 'Annuleren')}</button>
    <button class="btn primary grow" disabled=${busy || !draft.name.trim() || invalid} onClick=${save}>${busy ? html`<${Spinner} />` : T('Enregistrer', 'Save', 'Opslaan')}</button>`}>
    <${Field} label=${T('Nom', 'Name', 'Naam')}><input class="input" value=${draft.name} placeholder=${T('Horoscope du matin', 'Morning horoscope', 'Ochtendhoroscoop')} autofocus=${!focusSchedule}
      onInput=${(e) => set({ name: e.target.value })} /></${Field}>
    <${Field} label=${T('Icône', 'Icon', 'Pictogram')}><div class="icon-picker">${ICON_CHOICES.map((i) => html`<button type="button" class=${draft.icon === i ? 'on' : ''}
      onClick=${() => set({ icon: i })}>${i}</button>`)}</div></${Field}>
    <${Switch} label=${T('Partager avec la famille', 'Share with the family', 'Delen met het gezin')} help=${T("Les autres pourront l'imprimer et le copier.", 'Others will be able to print and copy it.', 'Anderen kunnen het afdrukken en kopiëren.')} checked=${draft.shared} onChange=${(v) => set({ shared: v })} />
    <div class="section-title" style="margin-top:18px">${T('Impression automatique', 'Automatic printing', 'Automatisch afdrukken')}</div>
    <${ScheduleEditor} schedules=${draft.schedules} onChange=${(schedules) => set({ schedules })} />
    ${ai && draft.schedules.length > 0 && html`<p class="help muted" style="font-size:13px;margin-bottom:0">
      🔮 ${T(
        'Ce ticket utilise Claude : un petit appel par impression, facturé avec une clé API ou compté sur l’abonnement avec la CLI (le contenu est gardé en cache pour la journée).',
        'This ticket uses Claude: a small call per print, billed with an API key or counted against the subscription with the CLI (the content is cached for the day).', 'Dit bonnetje gebruikt Claude: een kleine aanroep per afdruk, gefactureerd via een API-sleutel of verrekend met het abonnement via de CLI (de inhoud wordt voor de dag gecachet).',
      )}</p>`}
  </${Sheet}>`;
}

// Presse-papiers : l'API moderne n'existe qu'en HTTPS ou sur localhost, et l'appli est souvent
// servie en HTTP sur le réseau local ; repli par le texte sélectionné dans la zone `area`, aussi
// quand le navigateur refuse l'accès au presse-papiers.
async function copyText(text, area) {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* refusé : repli ci-dessous */ }
  area.focus();
  area.select();
  return document.execCommand('copy');
}

// Configuration du ticket composé, à copier : en YAML, l'action Home Assistant (intégration Printr,
// ou MQTT quand le serveur y est relié) ; en JSON, le ticket tel que le prennent l'API, MQTT et
// `printr print`. Le dernier format choisi est gardé.
function TicketConfigSheet({ ticket, label, onClose }) {
  const [format, setFormatState] = useState(() => store.get('printr.config.format', 'yaml'));
  const setFormat = (f) => { setFormatState(f); store.set('printr.config.format', f); };
  const [via, setVia] = useState('integration');
  const mqtt = format === 'yaml' && via === 'mqtt' && SERVER.mqtt;
  const text = useMemo(() => {
    if (format === 'json') return `${JSON.stringify(ticket, null, 2)}\n`;
    return mqtt ? mqttYaml(ticket, mqtt) : haYaml(ticket, label);
  }, [format, ticket, label, mqtt]);
  const area = useRef(null);
  const copy = async () => {
    if (await copyText(text, area.current)) return toast(T('Configuration copiée', 'Configuration copied', 'Configuratie gekopieerd'), 'ok', '📋');
    area.current.select();
    toast(T('Copie impossible : le texte est sélectionné, copie-le à la main', 'Could not copy: the text is selected, copy it by hand', 'Kopiëren mislukt: de tekst is geselecteerd, kopieer hem zelf'), 'error');
  };
  const help = format === 'json'
    ? T('Le ticket en JSON, tel que le prennent l’API HTTP (/print), MQTT (printr/print) et printr print ticket.json.',
      'The ticket as JSON, as taken by the HTTP API (/print), MQTT (printr/print) and printr print ticket.json.', 'Het bonnetje als JSON, zoals de HTTP-API (/print), MQTT (printr/print) en printr print ticket.json het verwachten.')
    : `${mqtt
      ? T(`L’action mqtt.publish de Home Assistant, qui publie le ticket sur ${mqtt}/print : rien d’autre à installer que l’intégration MQTT.`,
        `Home Assistant’s mqtt.publish action, publishing the ticket on ${mqtt}/print: nothing to install but the MQTT integration.`, `De mqtt.publish-actie van Home Assistant, die het bonnetje publiceert op ${mqtt}/print: je hoeft enkel de MQTT-integratie te installeren.`)
      : T('L’action printr.print_ticket de l’intégration Printr pour Home Assistant.', 'The printr.print_ticket action of the Printr integration for Home Assistant.', 'De printr.print_ticket-actie van de Bonnetje-integratie voor Home Assistant.')
    } ${T('À coller dans une automatisation ou un script, en édition YAML.', 'Paste it into an automation or a script, in YAML mode.', 'Plak het in een automatisering of script, in YAML-modus.')}`;
  return html`<${Sheet} title=${T('Configuration du ticket', 'Ticket configuration', 'Bonnetjesconfiguratie')} wide onClose=${onClose} footer=${html`
    <button class="btn secondary" onClick=${onClose}>${T('Fermer', 'Close', 'Sluiten')}</button>
    <button class="btn primary grow" onClick=${copy}><${Icon} name="copy" /> ${T('Copier', 'Copy', 'Kopiëren')}</button>`}>
    <div class="config-switches">
      <${Segmented} options=${[['yaml', 'YAML'], ['json', 'JSON']]} value=${format} onChange=${setFormat} />
      ${format === 'yaml' && SERVER.mqtt && html`<${Segmented} options=${[['integration', T('Intégration Printr', 'Printr integration', 'Bonnetje-integratie')], ['mqtt', 'MQTT']]}
        value=${via} onChange=${setVia} />`}
    </div>
    <p class="muted">${help}</p>
    <textarea class="input code" ref=${area} readonly spellcheck=${false} aria-label=${format.toUpperCase()}
      rows=${Math.min(18, text.split('\n').length)} value=${text}></textarea>
  </${Sheet}>`;
}

function Composer({ initial, onSaved, admin }) {
  const [state, setState] = useState(initial);
  // Catalogue ouvert : `{ at }` = position d'insertion (à la fin si absente).
  const [catalog, setCatalog] = useState(null);
  const [saveSheet, setSaveSheet] = useState(null);
  const [configSheet, setConfigSheet] = useState(false);
  const [mobilePreview, setMobilePreview] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [saving, setSaving] = useState(false);
  const ticket = useMemo(() => toTicket(state), [state]);
  const { preview, loading } = usePreview(ticket);

  useEffect(() => setState(initial), [initial]);
  // Brouillon gardé localement tant qu'il n'est pas enregistré.
  useEffect(() => { if (!state.id) store.set('printr.draft', state); }, [state]);

  const setBlocks = (fn) => setState((s) => ({ ...s, blocks: fn(s.blocks) }));
  const sort = useDragSort(setBlocks);
  const added = useRef(null);
  const add = (type, at) => {
    const block = newBlock(type);
    added.current = block.uid;
    setBlocks((b) => {
      const n = b.map((x) => ({ ...x, open: false }));
      n.splice(at ?? n.length, 0, block);
      return n;
    });
    setCatalog(null);
  };
  useLayoutEffect(() => {
    sort.settle();
    const el = added.current && sort.list.current?.querySelector(`[data-uid="${added.current}"]`);
    added.current = null;
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [state.blocks]);
  const errors = preview?.reports?.map((r) => r.error) || [];

  const print = async () => {
    setPrinting(true);
    try {
      printedToast(await api('POST', '/api/print', { ticket, label: state.name || T('Ticket composé', 'Composed ticket', 'Samengesteld bonnetje') }));
    } catch (e) { toast(e.message, 'error'); } finally { setPrinting(false); }
  };

  const persist = async (meta) => {
    const body = { name: meta.name, icon: meta.icon, shared: meta.shared, schedules: meta.schedules, ticket };
    const saved = state.id ? await api('PUT', `/api/presets/${state.id}`, body) : await api('POST', '/api/presets', body);
    if (!state.id) store.del('printr.draft');
    setState((s) => ({ ...s, ...meta, id: saved.id, schedules: saved.schedules }));
    toast(state.id ? T('Ticket mis à jour', 'Ticket updated', 'Bonnetje bijgewerkt') : T('Ticket enregistré', 'Ticket saved', 'Bonnetje opgeslagen'), 'ok', '✨');
    onSaved();
  };
  const quickSave = async () => {
    if (!state.id) return setSaveSheet({});
    setSaving(true);
    try { await persist(state); } catch (e) { toast(e.message, 'error'); } finally { setSaving(false); }
  };

  return html`<div class="page">
    <div class="composer">
      <div>
        ${state.id && html`<div class="row" style="margin:0 2px 14px">
          <span style="font-size:26px">${state.icon}</span>
          <div class="grow"><div style="font-weight:800;font-size:18px">${state.name}</div>
            <div class="muted" style="font-size:13px">${state.schedules.filter((s) => s.enabled).map(scheduleLabel).join(' · ') || T('Pas de planification', 'No schedule', 'Geen planning')}</div></div>
          <button class="btn secondary small" onClick=${() => setSaveSheet({ focusSchedule: true })}><${Icon} name="sliders" size=${16} /> ${T('Réglages', 'Settings', 'Instellingen')}</button>
        </div>`}
        <div class="blocklist ${sort.dragging ? 'sorting' : ''}" ref=${sort.list}>
          ${state.blocks.length === 0 && html`<div class="empty" style="padding:30px 18px"><div class="big-emoji">✨</div>
            <h3>${T('Compose ton ticket', 'Compose your ticket', 'Stel je bonnetje samen')}</h3><p class="muted" style="margin:0 0 14px">${T(
              'Pars d’un modèle, à modifier ensuite, ou ajoute un premier bloc.', 'Start from a template and change it afterwards, or add a first block.', 'Begin met een sjabloon en pas het daarna aan, of voeg een eerste blok toe.')}</p>
            <div class="templates">${TEMPLATES.map((tpl) => {
              const blocks = templateBlocks(tpl);
              return html`<button type="button" class="template" key=${tpl.name}
                onClick=${() => setState((st) => ({ ...st, name: st.name || tpl.name, icon: tpl.emoji, blocks: templateBlocks(tpl) }))}>
                <span class="big-emoji" aria-hidden="true">${tpl.emoji}</span><strong>${tpl.name}</strong>
                <span class="muted">${blocks.map((b) => BLOCK[b.data.type].label).join(' · ')}</span></button>`;
            })}</div></div>`}
          ${state.blocks.map((item, i) => html`${i > 0 && html`<div class="inserter" key=${`+${item.uid}`}>
              <button aria-label=${T('Insérer un bloc ici', 'Insert a block here', 'Hier een blok invoegen')} title=${T('Insérer un bloc ici', 'Insert a block here', 'Hier een blok invoegen')} onClick=${() => setCatalog({ at: i })}><${Icon} name="plus" size=${14} /></button></div>`}
            <${BlockCard} key=${item.uid} item=${item} index=${i} count=${state.blocks.length} error=${errors[i]} dragging=${sort.dragging === item.uid}
            onToggle=${() => setBlocks((b) => b.map((x) => (x.uid === item.uid ? { ...x, open: !x.open } : x)))}
            onChange=${(data) => setBlocks((b) => b.map((x) => (x.uid === item.uid ? { ...x, data } : x)))}
            onMove=${(d) => sort.step(item.uid, i, d)} onGrab=${sort.grab(item.uid)}
            onCopy=${() => setBlocks((b) => [...b.slice(0, i + 1), { uid: uid(), open: true, data: clone(item.data) }, ...b.slice(i + 1)])}
            onRemove=${() => setBlocks((b) => b.filter((x) => x.uid !== item.uid))} />`)}
          <button class="add-block" onClick=${() => setCatalog({})}><${Icon} name="plus" /> ${T('Ajouter un bloc', 'Add a block', 'Een blok toevoegen')}</button>
        </div>
        <div class="card ticket-settings">
          <${Switch} label=${T('Couper le papier à la fin', 'Cut the paper at the end', 'Papier afsnijden op het einde')} checked=${state.cut} onChange=${(cut) => setState((s) => ({ ...s, cut }))} />
          <div class="spacing-row"><span class="label">${T('Espace entre les blocs', 'Space between blocks', 'Ruimte tussen blokken')}</span>
            <${Segmented} options=${[[0, T('Aucun', 'None', 'Geen')], [1, T('1 ligne', '1 line', '1 regel')], [2, T('2 lignes', '2 lines', '2 regels')]]} value=${Number(state.spacing)} onChange=${(spacing) => setState((s) => ({ ...s, spacing }))} /></div>
          ${admin && html`<button class="btn ghost small show-config" disabled=${!state.blocks.length} onClick=${() => setConfigSheet(true)}>
            <${Icon} name="file-edit" size=${16} /> ${T('Afficher la configuration du ticket', 'Show the ticket configuration', 'Bonnetjesconfiguratie tonen')}</button>`}
        </div>
        <div class="actionbar">
          <button class="btn ghost preview-fab" aria-label=${T('Aperçu', 'Preview', 'Voorbeeld')} onClick=${() => setMobilePreview(true)}><${Icon} name="eye" /><span class="lbl">${T('Aperçu', 'Preview', 'Voorbeeld')}</span></button>
          <button class="btn secondary" aria-label=${state.id ? T('Enregistrer', 'Save', 'Opslaan') : T('Garder', 'Keep', 'Bewaren')} disabled=${saving || !state.blocks.length} onClick=${quickSave}>${saving ? html`<${Spinner} />` : html`<${Icon} name="save" />`}<span class="lbl">${state.id ? T('Enregistrer', 'Save', 'Opslaan') : T('Garder', 'Keep', 'Bewaren')}</span></button>
          <button class="btn primary" disabled=${printing || !state.blocks.length} onClick=${print}>${printing ? html`<${Spinner} />` : html`<${Icon} name="printer" />`} ${T('Imprimer', 'Print', 'Printen')}</button>
        </div>
      </div>
      <aside class="preview-col"><${Paper} preview=${preview} loading=${loading} /><${PaperMeta} preview=${preview} /></aside>
    </div>
    ${catalog && html`<${Catalog} onPick=${(type) => add(type, catalog.at)} onClose=${() => setCatalog(null)} />`}
    ${configSheet && html`<${TicketConfigSheet} ticket=${ticket} label=${state.name} onClose=${() => setConfigSheet(false)} />`}
    ${saveSheet && html`<${SaveSheet} state=${state} focusSchedule=${saveSheet.focusSchedule} onSave=${persist} onClose=${() => setSaveSheet(null)} />`}
    ${mobilePreview && html`<${Sheet} title=${T('Aperçu', 'Preview', 'Voorbeeld')} onClose=${() => setMobilePreview(false)} footer=${html`
      <button class="btn primary grow" disabled=${printing} onClick=${print}>${printing ? html`<${Spinner} />` : html`<${Icon} name="printer" />`} ${T('Imprimer', 'Print', 'Printen')}</button>`}>
      <${Paper} preview=${preview} loading=${loading} /><${PaperMeta} preview=${preview} /></${Sheet}>`}
  </div>`;
}

// ============================================================================
// Écran : petit mot
// ============================================================================

function Message({ me, onSaved }) {
  const [title, setTitle] = useState(T('Pour toi', 'For you', 'Voor jou'));
  const [text, setText] = useState('');
  const [picto, setPicto] = useState('coeur');
  const [photo, setPhoto] = useState(null);
  const [signature, setSignature] = useState(me.name);
  const [printing, setPrinting] = useState(false);
  const [saveSheet, setSaveSheet] = useState(false);
  const [done, setDone] = useState(false);

  const ticket = useMemo(() => {
    const blocks = [];
    if (picto) blocks.push({ type: 'picto', shape: picto, size: 'moyen', count: 1 });
    if (title.trim()) blocks.push({ type: 'title', text: title.trim(), size: 2 });
    if (photo) blocks.push({ type: 'image', upload: photo, dither: true });
    if (text.trim()) blocks.push({ type: 'text', text: text.trim(), align: 'center' });
    if (signature.trim()) blocks.push({ type: 'text', text: `- ${signature.trim()}`, align: 'right', bold: true });
    blocks.push({ type: 'date' });
    return { cut: true, spacing: 1, blocks };
  }, [title, text, picto, photo, signature]);
  const { preview, loading } = usePreview(ticket);
  const empty = !text.trim() && !photo;

  const print = async () => {
    setPrinting(true);
    try {
      const r = await api('POST', '/api/print', { ticket, label: `${T('Petit mot', 'Little note', 'Briefje')}${title.trim() ? ` · ${title.trim()}` : ''}` });
      setDone(true);
      printedToast(r, T('Envoyé à l’imprimante !', 'Sent to the printer!', 'Naar de printer gestuurd!'), '💌');
      setTimeout(() => setDone(false), 2400);
    } catch (e) { toast(e.message, 'error'); } finally { setPrinting(false); }
  };

  return html`<div class="page"><div class="composer">
    <div class="message">
      <${Field} label=${T('Une photo ?', 'A photo?', 'Een foto?')}><${PhotoField} value=${photo} onChange=${setPhoto} /></${Field}>
      <${Field} label=${T('Un dessin ?', 'A drawing?', 'Een tekening?')}><div class="pictos">
        <button type="button" class=${!picto ? 'on' : ''} aria-label=${T('Aucun', 'None', 'Geen')} onClick=${() => setPicto(null)} style="font-size:15px;font-weight:800">Ø</button>
        ${PICTOS.map(([v, e]) => html`<button type="button" class=${picto === v ? 'on' : ''} aria-label=${v} onClick=${() => setPicto(v)}>${e}</button>`)}
      </div></${Field}>
      <${Field} label=${T('Titre', 'Title', 'Titel')}><input class="input" value=${title} placeholder=${T('Pour toi', 'For you', 'Voor jou')} onInput=${(e) => setTitle(e.target.value)} /></${Field}>
      <${Field} label=${T('Ton petit mot', 'Your little note', 'Je berichtje')}><textarea class="input" rows="5" value=${text} placeholder=${T('Je pense fort à toi…', 'Thinking of you…', 'Ik denk aan je…')}
        onInput=${(e) => setText(e.target.value)}></textarea></${Field}>
      <${Field} label=${T('Signé', 'Signed', 'Ondertekend')}><input class="input" value=${signature} onInput=${(e) => setSignature(e.target.value)} /></${Field}>
      <button class="btn primary big block" disabled=${printing || empty} onClick=${print}>
        ${printing ? html`<${Spinner} />` : done ? html`<${Icon} name="check" /> ${T('Envoyé !', 'Sent!', 'Verstuurd!')}` : html`<${Icon} name="send" /> ${T("Envoyer à l'imprimante", 'Send to the printer', 'Naar de printer sturen')}`}</button>
      <button class="btn ghost block" style="margin-top:8px" disabled=${empty} onClick=${() => setSaveSheet(true)}><${Icon} name="save" /> ${T('Garder comme modèle', 'Keep as a template', 'Bewaren als sjabloon')}</button>
      <div class="section-title" style="display:block">${T('Aperçu', 'Preview', 'Voorbeeld')}</div>
      <div style="display:block" class="message-preview"><${Paper} preview=${preview} loading=${loading} /></div>
    </div>
    <aside class="preview-col"><${Paper} preview=${preview} loading=${loading} /><${PaperMeta} preview=${preview} /></aside>
    ${saveSheet && html`<${SaveSheet}
      state=${{ ...emptyComposer(), name: title.trim() || T('Petit mot', 'Little note', 'Briefje'), icon: '💌', blocks: ticket.blocks.map((data) => ({ data })) }}
      onSave=${async (meta) => { await api('POST', '/api/presets', { ...meta, ticket }); toast(T('Modèle enregistré', 'Template saved', 'Sjabloon opgeslagen'), 'ok', '✨'); onSaved(); }}
      onClose=${() => setSaveSheet(false)} />`}
  </div></div>`;
}

// ============================================================================
// Écran : liste de courses
// ============================================================================

function Shopping({ users }) {
  const [items, setItems] = useState(null);
  const [text, setText] = useState('');
  const [clear, setClear] = useState(() => store.get('printr.shopping.clear', true));
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const input = useRef();
  const byName = Object.fromEntries((users || []).map((u) => [u.name, u]));
  const load = () => api('GET', '/api/shopping').then(setItems).catch((e) => { toast(e.message, 'error'); setItems([]); });
  useEffect(() => { load(); }, []);

  const add = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    try { setItems(await api('POST', '/api/shopping', { text })); setText(''); input.current?.focus(); } catch (err) { toast(err.message, 'error'); }
  };
  const remove = async (id) => {
    setItems((list) => list.filter((i) => i.id !== id));
    try { setItems(await api('DELETE', `/api/shopping/${id}`)); } catch (err) { toast(err.message, 'error'); load(); }
  };
  const print = async () => {
    setBusy(true);
    try {
      const ticket = { cut: true, spacing: 1, blocks: [{ type: 'date' }, { type: 'shopping', clear }] };
      printedToast(await api('POST', '/api/print', { ticket, label: T('Liste de courses', 'Shopping list', 'Boodschappenlijst') }),
        T('Liste imprimée, bonnes courses !', 'List printed, happy shopping!', 'Lijst afgedrukt, veel plezier met winkelen!'), '🛒');
      load();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  const setClearPref = (v) => { setClear(v); store.set('printr.shopping.clear', v); };

  return html`<div class="page" style="max-width:640px">
    <form class="shop-add" onSubmit=${add}>
      <input ref=${input} class="input" value=${text} placeholder=${T('Lait, pain, piles…', 'Milk, bread, batteries…', 'Melk, brood, batterijen…')} onInput=${(e) => setText(e.target.value)}
        aria-label=${T('Article à ajouter', 'Item to add', 'Toe te voegen artikel')} enterkeyhint="done" />
      <button class="btn primary" disabled=${!text.trim()}><${Icon} name="plus" /> ${T('Ajouter', 'Add', 'Toevoegen')}</button>
    </form>
    ${items === null ? html`<div style="padding:30px;display:grid;place-items:center"><${Spinner} /></div>`
      : !items.length ? html`<div class="empty"><div class="big-emoji">🧺</div><h3>${T('La liste est vide', 'The list is empty', 'De lijst is leeg')}</h3>
          <p class="muted" style="margin:0">${T(
            'Ajoute ce qui manque au fil de la semaine : toute la famille voit la même liste.',
            'Add what you need through the week: the whole family sees the same list.', 'Voeg toe wat je nodig hebt tijdens de week: het hele gezin ziet dezelfde lijst.',
          )}</p></div>`
      : html`<div class="card shop-list">${items.map((item) => html`<div class="shop-item" key=${item.id}>
          <button class="shop-check" aria-label=${T(`Retirer ${item.text}`, `Remove ${item.text}`, `${item.text} verwijderen`)} title=${T("C'est pris !", 'Got it!', 'Gepakt!')} onClick=${() => remove(item.id)}><${Icon} name="check" size=${16} /></button>
          <span class="grow">${item.text}</span>
          ${byName[item.by] ? html`<${Avatar} user=${byName[item.by]} size="small" />` : html`<span class="muted" style="font-size:12px">${item.by}</span>`}
        </div>`)}</div>
        <div class="shop-actions">
          <${Switch} label=${T('Vider la liste une fois imprimée', 'Clear the list once printed', 'De lijst leegmaken na het afdrukken')} checked=${clear} onChange=${setClearPref} />
          <button class="btn primary big block" disabled=${busy} onClick=${print}>${busy ? html`<${Spinner} />` : html`<${Icon} name="printer" />`} ${T('Imprimer la liste', 'Print the list', 'Lijst afdrukken')}</button>
          <button class="btn ghost block" onClick=${() => setConfirm(true)}><${Icon} name="trash" /> ${T('Tout effacer', 'Clear all', 'Alles wissen')}</button>
        </div>`}
    ${confirm && html`<${Confirm} title=${T('Effacer toute la liste ?', 'Clear the whole list?', 'De hele lijst wissen?')}
      message=${T('Tous les articles seront retirés, pour toute la famille.', 'All items will be removed, for the whole family.', 'Alle items worden verwijderd, voor het hele gezin.')}
      action=${T('Effacer', 'Clear', 'Wissen')} danger onConfirm=${async () => { setItems(await api('DELETE', '/api/shopping')); toast(T('Liste effacée', 'List cleared', 'Lijst gewist'), 'ok', '🧹'); }}
      onClose=${() => setConfirm(false)} />`}
  </div>`;
}

// ============================================================================
// Écran : historique
// ============================================================================

// Ticket de l'historique tel qu'il est sorti (gardé 30 jours), pour l'administrateur.
function HistoryPreview({ entry, onClose }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api('GET', `/api/history/${entry.preview}/preview`).then(setPreview).catch((e) => setError(e.message)); }, [entry.preview]);
  const when = new Date(entry.at).toLocaleString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  return html`<${Sheet} title=${entry.label} onClose=${onClose}>
    <p class="muted" style="margin:0 0 12px">${capitalize(when)} · ${entry.by === 'planification' ? T('impression planifiée', 'scheduled print', 'geplande afdruk') : T(`par ${entry.by}`, `by ${entry.by}`, `door ${entry.by}`)}</p>
    ${error ? html`<p class="muted">${error}</p>` : html`<${Paper} preview=${preview} loading=${!preview} />`}
  </${Sheet}>`;
}

function History({ users, me }) {
  const [entries, setEntries] = useState(null);
  const [shown, setShown] = useState(null);
  // Relu toutes les 10 s, au retour sur l'onglet et quand l'état de l'imprimante change : un ticket
  // en attente passe à « imprimé » sans qu'on ait à recharger la page.
  useEffect(() => {
    const load = (first) => api('GET', '/api/history').then(setEntries)
      .catch((e) => { if (first) { toast(e.message, 'error'); setEntries([]); } });
    load(true);
    const timer = setInterval(() => { if (!document.hidden) load(); }, 10000);
    const onShow = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onShow);
    const off = bus.on('printer-changed', () => load());
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onShow); off(); };
  }, []);
  const byName = Object.fromEntries((users || []).map((u) => [u.name, u]));
  const dayLabel = (d) => {
    const today = new Date(); const y = new Date(Date.now() - 864e5);
    if (d.toDateString() === today.toDateString()) return T("Aujourd'hui", 'Today', 'Vandaag');
    if (d.toDateString() === y.toDateString()) return T('Hier', 'Yesterday', 'Gisteren');
    return capitalize(d.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' }));
  };
  if (entries === null) return html`<div class="page" style="display:grid;place-items:center;min-height:40vh"><${Spinner} /></div>`;
  if (!entries.length) return html`<div class="page"><div class="empty"><div class="big-emoji">🕰️</div><h3>${T("Rien d'imprimé pour l'instant", 'Nothing printed yet', 'Nog niets afgedrukt')}</h3>
    <p class="muted" style="margin:0">${T("Les impressions de toute la famille apparaîtront ici.", "The whole family's prints will show up here.", "De afdrukken van het hele gezin verschijnen hier.")}</p></div></div>`;
  const groups = [];
  for (const e of entries) {
    const label = dayLabel(new Date(e.at));
    if (groups.at(-1)?.label !== label) groups.push({ label, items: [] });
    groups.at(-1).items.push(e);
  }
  return html`<div class="page" style="max-width:760px">
    ${groups.map((g) => html`<div key=${g.label}><div class="history-day">${g.label}</div><div class="card">
      ${g.items.map((e, i) => html`<div class="history-item" key=${i}>
        <div class="history-time">${new Date(e.at).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}</div>
        ${byName[e.by] ? html`<${Avatar} user=${byName[e.by]} size="small" />` : html`<span class="chip" style="height:22px;padding:0 6px"><${Icon} name="clock" /></span>`}
        <div class="grow"><strong>${e.label}</strong>
          <div class="muted" style="font-size:13px">${e.by === 'planification' ? T('Impression planifiée', 'Scheduled print', 'Geplande afdruk') : T(`par ${e.by}`, `by ${e.by}`, `door ${e.by}`)}${e.printed_at
            ? T(` · sorti à ${new Date(e.printed_at).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}, en retard`, ` · came out at ${new Date(e.printed_at).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}, late`, ` · kwam om ${new Date(e.printed_at).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })} uit, te laat`) : ''}</div>
          ${e.errors?.length > 0 && html`<ul class="history-errors">${e.errors.map((err) => html`<li>${err}</li>`)}</ul>`}</div>
        ${e.queued ? html`<span class="chip warn">${T('En attente', 'Waiting', 'Wachtend')}</span>` : html`<span class="chip ${e.ok ? (e.errors?.length ? 'warn' : 'ok') : 'danger'}">${e.ok
          ? (e.errors?.length ? T('Partiel', 'Partial', 'Gedeeltelijk') : T('Imprimé', 'Printed', 'Afgedrukt'))
          : T('Échec', 'Failed', 'Mislukt')}</span>`}
        ${me?.admin && e.preview && html`<button class="iconbtn" aria-label=${T('Voir le ticket', 'See the ticket', 'Bonnetje bekijken')} title=${T('Voir le ticket', 'See the ticket', 'Bonnetje bekijken')}
          onClick=${() => setShown(e)}><${Icon} name="eye" /></button>`}
      </div>`)}
    </div></div>`)}
    <p class="muted history-note">${T("L'administrateur peut revoir les tickets imprimés pendant 30 jours.", 'The administrator can look back at printed tickets for 30 days.', 'De beheerder kan afgedrukte bonnetjes 30 dagen terugkijken.')}</p>
    ${shown && html`<${HistoryPreview} entry=${shown} onClose=${() => setShown(null)} />`}
  </div>`;
}

// ============================================================================
// Application
// ============================================================================

function Toasts() {
  const [items, setItems] = useState([]);
  useEffect(() => bus.on('toast', (t) => {
    const id = uid();
    setItems((x) => [...x.slice(-2), { ...t, id }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), t.kind === 'error' ? 5000 : 2600);
  }), []);
  return html`<div class="toasts" aria-live="polite">${items.map((t) => html`<div class="toast ${t.kind}" key=${t.id}>
    <span class="emoji">${t.emoji || (t.kind === 'error' ? '⚠️' : '✓')}</span><span>${t.message}</span></div>`)}</div>`;
}

// Réglage de l'administrateur : les blocs proposés à toute la famille dans le catalogue.
function HiddenBlocksSheet({ onClose }) {
  const [hidden, setHidden] = useState(() => new Set(CATALOG.hidden));
  const [busy, setBusy] = useState(false);
  const toggle = (type) => setHidden((before) => {
    const next = new Set(before);
    if (next.has(type)) next.delete(type); else next.add(type);
    return next;
  });
  const save = async () => {
    setBusy(true);
    try {
      const blocks = [...hidden];
      await api('PUT', '/api/settings/hidden-blocks', { blocks });
      CATALOG.hidden = blocks;
      toast(T('Catalogue enregistré', 'Catalog saved', 'Catalogus opgeslagen'), 'ok', '🧩');
      onClose();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return html`<${Sheet} title=${T('Blocs proposés', 'Offered blocks', 'Aangeboden blokken')} onClose=${onClose} wide footer=${html`
    <button class="btn secondary" onClick=${onClose}>${T('Annuler', 'Cancel', 'Annuleren')}</button>
    <button class="btn primary grow" disabled=${busy} onClick=${save}><${Icon} name="check" /> ${T('Enregistrer', 'Save', 'Opslaan')}</button>`}>
    <p class="muted" style="margin:0">${T(
      'Touche un bloc pour le retirer du catalogue de toute la famille, ou pour l’y remettre. Les tickets qui l’utilisent déjà continuent de fonctionner.',
      'Tap a block to remove it from the whole family’s catalog, or to bring it back. Tickets that already use it keep working.', 'Tik op een blok om het uit de catalogus van het hele gezin te halen of terug te zetten. Bonnetjes die het al gebruiken blijven werken.',
    )}</p>
    ${!CATALOG.claude && html`<p class="muted" style="margin:8px 0 0">${T(
      'Claude n’est pas disponible : l’horoscope Claude, le mot du jour et la recette par Claude sont déjà masqués.',
      'Claude is not available: the Claude horoscope, word of the day and Claude recipe are already hidden.', 'Claude is niet beschikbaar: het Claude-horoscoop, het woord van de dag en het Claude-recept zijn al verborgen.',
    )}</p>`}
    ${GROUP_ORDER.map((g) => html`<div class="catalog-group" key=${g}><h4>${g}</h4>
      <div class="block-toggles">${BLOCKS.filter((b) => b.group === g).map((b) => {
        const shown = !hidden.has(b.type);
        return html`<button type="button" key=${b.type} class=${shown ? '' : 'off'} aria-pressed=${shown}
          onClick=${() => toggle(b.type)}><span aria-hidden="true">${b.emoji}</span> ${b.label}</button>`;
      })}</div></div>`)}
  </${Sheet}>`;
}

// Réglages du serveur (administrateur) : ce que fixe /etc/printr.env reste en lecture seule.
const LOCKED_HINT = T('Fixé dans /etc/printr.env', 'Set in /etc/printr.env', 'Ingesteld in /etc/printr.env');
const randomToken = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

function SettingSecret({ s, label, help, value, onChange, generate }) {
  const [editing, setEditing] = useState(false);
  let body;
  if (s.locked) body = html`<div class="setting-state"><span class="chip">${LOCKED_HINT}</span></div>`;
  else if (value === '' && s.set) body = html`<div class="setting-state"><span class="muted">${T('Sera effacé', 'Will be cleared', 'Wordt gewist')}</span>
    <button type="button" class="btn ghost small" onClick=${() => onChange(undefined)}>${T('Annuler', 'Undo', 'Ongedaan maken')}</button></div>`;
  else if (generate && value) body = html`<div class="setting-new-token"><code>${value}</code><span class="muted">${T(
    'Copie-le maintenant : Printr ne le montrera plus.', 'Copy it now: Printr won’t show it again.', 'Kopieer het nu: Bonnetje toont het niet opnieuw.')}</span>
    <button type="button" class="btn ghost small" onClick=${() => onChange(undefined)}>${T('Annuler', 'Undo', 'Ongedaan maken')}</button></div>`;
  else if (editing || !s.set) body = html`<div class="setting-state">
    <input class="input" type="password" autocomplete="off" value=${value || ''} onInput=${(e) => onChange(e.target.value.trim() || undefined)} />
    ${generate && html`<button type="button" class="btn secondary small" onClick=${() => onChange(randomToken())}>${T('Générer', 'Generate', 'Genereren')}</button>`}</div>`;
  else body = html`<div class="setting-state"><span class="setting-set">✓ ${T('Défini', 'Set', 'Ingesteld')}</span>
    <button type="button" class="btn ghost small" onClick=${() => (generate ? onChange(randomToken()) : setEditing(true))}>${T('Remplacer', 'Replace', 'Vervangen')}</button>
    <button type="button" class="btn ghost small" onClick=${() => onChange('')}>${T('Effacer', 'Clear', 'Wissen')}</button></div>`;
  return html`<${Field} label=${label} help=${help}>${body}</${Field}>`;
}

function SettingsSheet({ onClose }) {
  const [settings, setSettings] = useState(null);
  const [restart, setRestart] = useState(true);
  const [draft, setDraft] = useState({});
  const [printer, setPrinter] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  useEffect(() => {
    api('GET', '/api/settings').then((r) => {
      setSettings(Object.fromEntries(r.settings.map((x) => [x.key, x])));
      setRestart(r.restart);
    }).catch((e) => { toast(e.message, 'error'); onClose(); });
  }, []);
  if (!settings) return html`<${Sheet} title=${T('Réglages', 'Settings', 'Instellingen')} onClose=${onClose}><div class="boot"><${Spinner} /></div></${Sheet}>`;

  const set = (key, value) => setDraft((d) => {
    const next = { ...d };
    if (value === undefined) delete next[key]; else next[key] = value;
    return next;
  });
  const cur = (key) => draft[key] ?? settings[key]?.value ?? '';
  const lang = cur('PRINTR_LANG') || LANG || 'fr';
  // Ce qui change vraiment : un secret touché, ou une valeur différente de celle en vigueur.
  const changes = Object.fromEntries(Object.entries(draft).filter(([k, v]) =>
    !settings[k]?.locked && (settings[k]?.value === null && settings[k]?.set ? true : (settings[k]?.value ?? '') !== v)));
  const count = Object.keys(changes).length;

  const text = (key, label, help, placeholder, type = 'text') => html`<${Field} label=${label} help=${help}>
    <input class="input" type=${type} placeholder=${placeholder} value=${cur(key)} disabled=${settings[key].locked}
      inputmode=${type === 'number' ? 'numeric' : undefined} onInput=${(e) => set(key, e.target.value)} />
    ${settings[key].locked && html`<span class="chip setting-lock">${LOCKED_HINT}</span>`}</${Field}>`;
  const secret = (key, label, help, generate) => html`<${SettingSecret} s=${settings[key]} label=${label} help=${help}
    value=${draft[key]} generate=${generate} onChange=${(v) => set(key, v)} />`;
  const choice = (key, title, options) => html`<${Field} label=${title}>
    ${settings[key].locked ? html`<span class="chip setting-lock">${LOCKED_HINT} : ${label(options, cur(key))}</span>`
      : html`<${Segmented} options=${options} value=${key === 'PRINTR_LANG' ? lang : cur(key)} onChange=${(v) => set(key, v)} />`}</${Field}>`;
  const toggle = (key, text, help) => settings[key].locked
    ? html`<${Field} label=${text}><span class="chip setting-lock">${LOCKED_HINT}</span></${Field}>`
    : html`<${Switch} label=${text} help=${help} checked=${!['off', 'false', '0', 'no', 'non'].includes(cur(key))}
      onChange=${(on) => set(key, on ? '' : 'off')} />`;

  const target = cur('PRINTR_TCP') || cur('PRINTR_DEVICE') || '/dev/usb/lp0';
  const save = async () => {
    setBusy(true);
    try {
      const r = await api('PUT', '/api/settings', { values: changes });
      if (r.restarting) { setRestarting(true); waitForRestart(); return; }
      toast(T('Réglages enregistrés : redémarre Printr pour les appliquer.', 'Settings saved: restart Printr to apply them.', 'Instellingen opgeslagen: herstart Bonnetje om ze toe te passen.'), 'warn', '🔁');
      onClose();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  if (restarting) return html`<${Sheet} title=${T('Réglages', 'Settings', 'Instellingen')} onClose=${() => {}}><${Restarting} /></${Sheet}>`;

  const printerLocked = settings.PRINTR_DEVICE.locked || settings.PRINTR_TCP.locked;
  return html`<${Sheet} title=${T('Réglages', 'Settings', 'Instellingen')} onClose=${onClose} footer=${html`
    <button class="btn secondary" onClick=${onClose}>${T('Annuler', 'Cancel', 'Annuleren')}</button>
    <button class="btn primary grow" disabled=${busy || !count} onClick=${save}><${Icon} name="check" /> ${count
      ? T(`Enregistrer (${count})`, `Save (${count})`, `Opslaan (${count})`) : T('Enregistrer', 'Save', 'Opslaan')}</button>`}>
    <p class="muted" style="margin:0">${restart
      ? T('Printr redémarre quelques secondes pour appliquer les changements.', 'Printr restarts for a few seconds to apply changes.', 'Bonnetje herstart even om de wijzigingen toe te passen.')
      : T('Les changements s’appliquent au prochain redémarrage de Printr.', 'Changes apply the next time Printr restarts.', 'Wijzigingen worden toegepast bij de volgende herstart van Bonnetje.')}</p>

    <div class="section-title">${T('Général', 'General', 'Algemeen')}</div>
    ${choice('PRINTR_LANG', T('Langue', 'Language', 'Taal'), [['nl', 'Nederlands'], ['fr', 'Français'], ['en', 'English']])}
    ${text('PRINTR_CITY', T('Ville', 'City', 'Stad'), T('Météo, qualité de l’air et horaires du soleil, sauf si le bloc en précise une.', 'Weather, air quality and sun times, unless the block sets one.', 'Weer, luchtkwaliteit en zonnetijden, tenzij het blok er een instelt.'), T('Ex. Bordeaux', 'E.g. Boston', 'Bv. Gent'))}
    ${choice('PRINTR_UNITS', T('Unités de la météo', 'Weather units', 'Eenheden weer'), [['', T('°C et km/h', '°C and km/h', '°C en km/u')], ['imperial', T('°F et mph', '°F and mph', '°F en mph')]])}

    <div class="section-title">${T('Imprimante', 'Printer', 'Printer')}</div>
    ${printerLocked ? html`<${Field} label=${T('Imprimante', 'Printer', 'Printer')}><span class="chip setting-lock">${LOCKED_HINT} : ${target}</span></${Field}>`
      : printer ? html`<${WizardPrinter} settings=${settings} values=${draft} onValues=${(v) => setDraft((d) => ({ ...d, ...v }))} />`
      : html`<div class="setting-card paper-card"><span class="big-emoji" aria-hidden="true">${cur('PRINTR_TCP') ? '📡' : '🔌'}</span>
          <span class="grow"><strong>${target}</strong><span class="muted">${cur('PRINTR_TCP') ? T('Imprimante réseau', 'Network printer', 'Netwerkprinter') : 'USB'}</span>
          <button type="button" class="btn secondary small" onClick=${() => setPrinter(true)}>${T('Changer et tester', 'Change and test', 'Wijzigen en testen')}</button></span></div>`}
    ${choice('PRINTR_CODEPAGE', T('Page de code', 'Code page', 'Codepagina'), [['', T('PC858 (avec €)', 'PC858 (with €)', 'PC858 (met €)')], ['850', 'PC850']])}
    ${choice('PRINTR_PAPER_WIDTH', T('Largeur du papier', 'Paper width', 'Papierbreedte'), [['', T('512 points (TM-T88)', '512 dots (TM-T88)', '512 punten (TM-T88)')], ['576', T('576 points (la plupart des 80 mm)', '576 dots (most 80 mm printers)', '576 punten (de meeste 80 mm-printers)')]])}

    <div class="section-title">Claude</div>
    ${secret('ANTHROPIC_API_KEY', T('Clé d’API Anthropic', 'Anthropic API key', 'Anthropic API-sleutel'), html`<a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>`)}
    ${text('PRINTR_CLAUDE_MODEL', T('Modèle', 'Model', 'Model'), null, 'claude-haiku-5-5')}
    ${text('PRINTR_CLAUDE_TIMEOUT_SECS', T('Délai d’un appel (secondes)', 'Call timeout (seconds)', 'Time-out per oproep (seconden)'), T('À augmenter pour un modèle local lent.', 'Raise it for a slow local model.', 'Verhoog dit voor een traag lokaal model.'), '120', 'number')}

    <div class="section-title">Home Assistant · MQTT</div>
    ${secret('PRINTR_MQTT_URL', T('Adresse du broker', 'Broker address', 'Brokeradres'), T('Ex. mqtt://utilisateur:motdepasse@192.168.1.10:1883', 'E.g. mqtt://user:password@192.168.1.10:1883', 'Bv. mqtt://gebruiker:wachtwoord@192.168.1.10:1883'))}
    ${text('PRINTR_MQTT_PREFIX', T('Préfixe des sujets', 'Topic prefix', 'Topicvoorvoegsel'), null, 'printr')}
    ${toggle('PRINTR_MQTT_DISCOVERY', T('Découverte automatique', 'Automatic discovery', 'Automatische detectie'), T('Printr apparaît tout seul dans Home Assistant.', 'Printr shows up in Home Assistant by itself.', 'Bonnetje verschijnt vanzelf in Home Assistant.'))}

    <div class="section-title">${T('Scripts et limites', 'Scripts and limits', 'Scripts en limieten')}</div>
    ${secret('PRINTR_TOKEN', T('Jeton d’API', 'API token', 'API-token'), T('Pour les scripts : « Authorization: Bearer <jeton> ».', 'For scripts: “Authorization: Bearer <token>”.', 'Voor scripts: “Authorization: Bearer <token>”.'), true)}
    ${text('PRINTR_MAX_TICKETS_PER_HOUR', T('Tickets par heure et par compte', 'Tickets per hour and account', 'Bonnetjes per uur en per account'), T('0 : sans limite.', '0: no limit.', '0: geen limiet.'), '20', 'number')}
    ${text('PRINTR_QUEUE_HOURS', T('Attente si l’imprimante est absente (heures)', 'Wait when the printer is away (hours)', 'Wachttijd als de printer weg is (uren)'), null, '12', 'number')}
    ${toggle('PRINTR_UPDATE_CHECK', T('Signaler les nouvelles versions', 'Report new versions', 'Nieuwe versies melden'), T('Une fois par jour, Printr regarde sur GitHub.', 'Once a day, Printr checks GitHub.', 'Eén keer per dag kijkt Bonnetje op GitHub.'))}
    ${settings.PRINTR_AUTO_UPDATE.locked
      ? html`<${Field} label=${T('Installer automatiquement', 'Install automatically', 'Automatisch installeren')}><span class="chip setting-lock">${LOCKED_HINT}</span></${Field}>`
      : html`<${Switch} label=${T('Installer automatiquement, la nuit', 'Install automatically, at night', 'Automatisch installeren, \'s nachts')}
        help=${T('Seulement les versions signées par l’auteur de Printr, entre 3 h et 5 h ; retour à l’ancienne si la nouvelle ne démarre pas.', 'Only versions signed by Printr’s author, between 3 and 5 am; back to the previous one if the new one does not start.', 'Alleen versies die door de auteur van Bonnetje zijn ondertekend, tussen 3 en 5 uur; terug naar de vorige als de nieuwe niet start.')}
        checked=${cur('PRINTR_AUTO_UPDATE') === 'auto'} onChange=${(on) => set('PRINTR_AUTO_UPDATE', on ? 'auto' : '')} />`}
  </${Sheet}>`;
}

// Mon compte : la famille (ajouter, retirer), mon mot de passe, la déconnexion.
// Longueur de papier lisible : « 52 m », « 80 cm ».
const metres = (mm) => (mm >= 1000 ? `${Math.round(mm / 1000)}\u00a0m` : `${Math.round(mm / 10)}\u00a0cm`);

// La jauge de papier, estimée par Printr depuis la pose du rouleau, et le bouton pour en poser un neuf.
function PaperCard({ paper }) {
  const [open, setOpen] = useState(false);
  const [length, setLength] = useState(String(Math.round(paper.roll_mm / 1000)));
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault(); setBusy(true);
    try {
      await api('POST', '/api/paper/roll', { length_m: Number(length) });
      toast(T('Nouveau rouleau noté', 'New roll noted', 'Nieuwe rol genoteerd'), 'ok', '🧻');
      bus.emit('printer'); setOpen(false);
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  return html`<div class="setting-card paper-card">
    <span class="big-emoji" aria-hidden="true">🧻</span>
    <span class="grow"><strong>${T(`Environ ${metres(paper.remaining_mm)} restants`, `About ${metres(paper.remaining_mm)} left`, `Nog ongeveer ${metres(paper.remaining_mm)} over`)}</strong>
      <span class="paper-gauge ${paper.low ? 'low' : ''}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${paper.percent}
        aria-label=${T('Papier restant', 'Paper left', 'Resterend papier')}><span style=${`width:${paper.percent}%`}></span></span>
      <span class="muted">${T(`${paper.percent}\u00a0% d’un rouleau de ${metres(paper.roll_mm)}`, `${paper.percent}% of a ${metres(paper.roll_mm)} roll`, `${paper.percent}% van een rol van ${metres(paper.roll_mm)}`)}</span>
      ${!open && html`<button type="button" class="btn secondary small" onClick=${() => setOpen(true)}>${T('Nouveau rouleau', 'New roll', 'Nieuwe rol')}</button>`}</span>
  </div>
  ${open && html`<form class="family-add" onSubmit=${save}>
    <label class="paper-length">${T('Longueur du rouleau', 'Roll length', 'Lengte van de rol')}
      <input class="input" type="number" min="5" max="500" inputmode="numeric" value=${length} onInput=${(e) => setLength(e.target.value)} /> m</label>
    <button class="btn secondary" disabled=${busy || !(Number(length) >= 5 && Number(length) <= 500)}>${T('C’est posé', 'Done', 'Klaar')}</button>
  </form>
  <p class="muted paper-hint">${T(
    'Printr remet aussi la jauge à zéro tout seul quand l’imprimante passe de « plus de papier » à « prête », et cale la longueur sur ce qu’un rouleau entier a vraiment donné.',
    'Printr also resets the gauge by itself when the printer goes from “out of paper” to “ready”, and adjusts the length to what a whole roll really gave.', 'Bonnetje zet de meter ook zelf terug wanneer de printer van “papier op” naar “klaar” gaat, en past de lengte aan op wat een hele rol echt opleverde.',
  )}</p>`}`;
}

function AccountSheet({ me, users, version, update, paper, reloadUsers, onLogout, onClose }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [mine, setMine] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [picking, setPicking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const run = async (fn) => { setBusy(true); try { await fn(); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); } };
  const add = (e) => { e.preventDefault(); run(async () => {
    const { user } = await api('POST', '/api/users', { name, password });
    toast(T(`Compte créé pour ${user.name}`, `Account created for ${user.name}`, `Account aangemaakt voor ${user.name}`), 'ok', '👋');
    setName(''); setPassword(''); reloadUsers();
  }); };
  const changePassword = (e) => { e.preventDefault(); run(async () => {
    await api('PUT', '/api/me/password', { password: mine });
    toast(T('Mot de passe changé', 'Password changed', 'Wachtwoord gewijzigd'), 'ok', '🔑'); setMine('');
  }); };
  const remove = (u) => setConfirm({
    title: T(`Supprimer le compte de ${u.name} ?`, `Delete ${u.name}'s account?`, `Account van ${u.name} verwijderen?`),
    message: html`${T(
      'Ses tickets enregistrés et leurs planifications seront supprimés aussi.',
      'Their saved tickets and their schedules will be deleted too.', 'Opgeslagen bonnetjes en planningen worden ook verwijderd.',
    )}`,
    action: T('Supprimer', 'Delete', 'Verwijderen'), danger: true,
    onConfirm: async () => { await api('DELETE', `/api/users/${u.id}`); toast(T(`Compte de ${u.name} supprimé`, `${u.name}'s account deleted`, `Account van ${u.name} verwijderd`), 'ok', '🗑️'); reloadUsers(); },
  });
  return html`<${Sheet} title=${T('Mon compte', 'My account', 'Mijn account')} onClose=${onClose}>
    <div class="row" style="margin-bottom:6px"><${Avatar} user=${me} size="large" /><div><strong>${me.name}</strong>
      <div class="muted">${T('Connecté sur cet appareil', 'Signed in on this device', 'Aangemeld op dit toestel')}</div></div></div>

    ${me.admin && update && html`<a class="update-card" href=${update.url} target="_blank" rel="noopener">
      <span class="big-emoji">✨</span>
      <span class="grow"><strong>${T(`Printr ${update.version} est disponible`, `Printr ${update.version} is available`, `Bonnetje ${update.version} is beschikbaar`)}</strong>
        <span class="muted">${SERVER.autoUpdate ? T(
          `Tu as la ${version}. Elle s’installera toute seule cette nuit ; les nouveautés sont par ici.`,
          `You're on ${version}. It will install itself tonight; here's what's new.`, `Je hebt ${version}. Die installeert zich vanavond vanzelf; dit is er nieuw.`,
        ) : T(
          `Tu as la ${version}. Lis les nouveautés, puis mets à jour depuis ton ordinateur.`,
          `You're on ${version}. Read what's new, then update from your computer.`, `Je hebt ${version}. Lees wat er nieuw is en update dan vanaf je computer.`,
        )}</span></span>
      <${Icon} name="send" size=${18} /></a>`}
    ${me.admin && SERVER.lastUpdate && html`<p class="muted last-update">✨ ${T(
      `Mis à jour tout seul de la ${SERVER.lastUpdate.from} à la ${SERVER.lastUpdate.to}, le ${new Date(SERVER.lastUpdate.at).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long' })}.`,
      `Updated by itself from ${SERVER.lastUpdate.from} to ${SERVER.lastUpdate.to} on ${new Date(SERVER.lastUpdate.at).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long' })}.`, `Vanzelf bijgewerkt van ${SERVER.lastUpdate.from} naar ${SERVER.lastUpdate.to} op ${new Date(SERVER.lastUpdate.at).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long' })}.`,
    )}</p>`}

    ${paper && html`<div class="section-title">${T('L’imprimante', 'The printer', 'De printer')}</div><${PaperCard} paper=${paper} />`}

    <div class="section-title">${T('La famille', 'The family', 'De familie')}</div>
    <div class="card family">${users.map((u) => html`<div class="family-row" key=${u.id}>
      <${Avatar} user=${u} /><span class="grow">${u.name}${u.id === me.id ? html` <span class="muted">${T('(toi)', '(you)', '(jij)')}</span>` : ''}</span>
      ${u.admin && html`<span class="chip">Admin</span>`}
      ${me.admin && u.id !== me.id && html`<button class="iconbtn danger" aria-label=${T(`Supprimer ${u.name}`, `Delete ${u.name}`, `${u.name} verwijderen`)} title=${T('Supprimer', 'Delete', 'Verwijderen')} onClick=${() => remove(u)}><${Icon} name="trash" /></button>`}
    </div>`)}</div>
    <form class="family-add" onSubmit=${add}>
      <input class="input" placeholder=${T('Prénom', 'First name', 'Voornaam')} value=${name} onInput=${(e) => setName(e.target.value)} />
      <input class="input" type="password" placeholder=${T('Son mot de passe (8 caractères minimum)', 'Their password (8 characters minimum)', 'Wachtwoord (minstens 8 tekens)')} autocomplete="new-password" value=${password} onInput=${(e) => setPassword(e.target.value)} />
      <button class="btn secondary" disabled=${busy || !name.trim() || password.length < 8}><${Icon} name="plus" size=${16} /> ${T('Ajouter', 'Add', 'Toevoegen')}</button>
    </form>

    ${me.admin && html`<div class="section-title">${T('Printr', 'Printr', 'Bonnetje')}</div>
      <button type="button" class="setting-card" onClick=${() => setSettingsOpen(true)}>
        <span class="big-emoji" aria-hidden="true">⚙️</span>
        <span class="grow"><strong>${T('Réglages', 'Settings', 'Instellingen')}</strong>
          <span class="muted">${T('Imprimante, langue, ville, Claude, Home Assistant…', 'Printer, language, city, Claude, Home Assistant…', 'Printer, taal, stad, Claude, Home Assistant…')}</span></span>
        <${Icon} name="sliders" size=${18} /></button>`}

    ${me.admin && html`<div class="setting-card paper-card backup-card">
        <span class="big-emoji" aria-hidden="true">📦</span>
        <span class="grow"><strong>${T('Sauvegarde', 'Backup', 'Back-up')}</strong>
          <span class="muted">${T(
            'Comptes, tickets, historique, réglages et photos, dans un seul fichier. Il contient la clé Claude et les mots de passe (hachés) : garde-le en lieu sûr.',
            'Accounts, tickets, history, settings and photos, in a single file. It holds the Claude key and the passwords (hashed): keep it somewhere safe.', 'Accounts, bonnetjes, geschiedenis, instellingen en foto\'s, in één bestand. Het bevat de Claude-sleutel en de wachtwoorden (gehasht): bewaar het op een veilige plek.',
          )}</span>
          <span class="backup-actions"><a class="btn secondary small" href="/api/backup" download>${T('Télécharger', 'Download', 'Downloaden')}</a>
            <${RestoreButton} label=${T('Restaurer…', 'Restore…', 'Herstellen…')} /></span></span></div>`}

    ${me.admin && html`<div class="section-title">${T('Catalogue de la famille', 'The family’s catalog', 'Catalogus van het gezin')}</div>
      <button type="button" class="setting-card" onClick=${() => setPicking(true)}>
        <span class="big-emoji" aria-hidden="true">🧩</span>
        <span class="grow"><strong>${T('Blocs proposés', 'Offered blocks', 'Aangeboden blokken')}</strong>
          <span class="muted">${CATALOG.hidden.length
            ? T(`${CATALOG.hidden.length} bloc(s) retiré(s) du catalogue`, `${CATALOG.hidden.length} block(s) removed from the catalog`, `${CATALOG.hidden.length} blok(ken) uit de catalogus verwijderd`)
            : T('Tous les blocs sont proposés', 'All blocks are offered', 'Alle blokken worden aangeboden')}</span></span>
        <${Icon} name="sliders" size=${18} /></button>`}

    <div class="section-title">${T('Mon mot de passe', 'My password', 'Mijn wachtwoord')}</div>
    <form class="family-add" onSubmit=${changePassword}>
      <input class="input" type="password" placeholder=${T('Nouveau mot de passe (8 caractères minimum)', 'New password (8 characters minimum)', 'Nieuw wachtwoord (minstens 8 tekens)')} autocomplete="new-password" value=${mine} onInput=${(e) => setMine(e.target.value)} />
      <button class="btn secondary" disabled=${busy || mine.length < 8}>${T('Changer', 'Change', 'Wijzigen')}</button>
    </form>

    <button class="btn danger block" style="margin-top:22px" onClick=${onLogout}><${Icon} name="logout" /> ${T('Se déconnecter', 'Sign out', 'Afmelden')}</button>
    ${version && html`<p class="version">printr ${version}</p>`}
    ${confirm && html`<${Confirm} ...${confirm} onClose=${() => setConfirm(null)} />`}
    ${picking && html`<${HiddenBlocksSheet} onClose=${() => setPicking(false)} />`}
    ${settingsOpen && html`<${SettingsSheet} onClose=${() => setSettingsOpen(false)} />`}
  </${Sheet}>`;
}

// ============================================================================
// Première connexion au réseau (image Raspberry Pi) : depuis le point d'accès de Printr
// ============================================================================

const signalBars = (signal) => (signal >= 70 ? '▂▄▆█' : signal >= 45 ? '▂▄▆' : signal >= 20 ? '▂▄' : '▂');

function WifiSetup({ state }) {
  const [picked, setPicked] = useState(null); // { ssid, secure } ou { hidden: true }
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [joining, setJoining] = useState(state.joining);
  const name = picked?.hidden ? ssid.trim() : picked?.ssid;
  const needsPassword = picked?.hidden || picked?.secure;
  const submit = async (e) => {
    e.preventDefault(); setBusy(true);
    try {
      await api('POST', '/api/wifi', { ssid: name, password: needsPassword ? password : '' });
      setJoining(name);
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  if (joining) {
    return html`<div class="login"><div class="login-card wizard">
      <div class="wifi-joining" aria-hidden="true">📶</div>
      <h1>${T(`Connexion à « ${joining} »…`, `Joining “${joining}”…`, `Verbinden met “${joining}”…`)}</h1>
      <div class="wizard-body"><p class="muted">${T(
        'Ton téléphone va perdre le Wi-Fi de Printr : c’est normal. Dans un instant, Printr imprime un ticket avec l’adresse de l’appli.',
        'Your phone is about to lose Printr’s Wi-Fi: that’s expected. In a moment, Printr prints a ticket with the app’s address.', 'Je telefoon verliest zo meteen de wifi van Bonnetje: dat is normaal. Zo meteen drukt Bonnetje een bonnetje af met het adres van de app.',
      )}</p><p class="muted">${T(
        `Si le ticket annonce un échec, reconnecte-toi à « ${state.hotspot || 'Printr'} » et réessaie.`,
        `If the ticket reports a failure, reconnect to “${state.hotspot || 'Printr'}” and try again.`, `Meldt het bonnetje een mislukking, verbind dan opnieuw met “${state.hotspot || 'Printr'}” en probeer opnieuw.`,
      )}</p></div></div></div>`;
  }
  return html`<div class="login"><form class="login-card wizard" onSubmit=${submit}>
    <img class="logo" src="/mark.png" alt="" style="display:block" />
    <h1>${T('Le Wi-Fi de la maison', 'Your home Wi-Fi', 'Je wifi thuis')}</h1>
    ${state.error && html`<p class="wifi-error" role="alert">${state.error}</p>`}
    <div class="wizard-body">
      <p class="muted">${T('Choisis le réseau que Printr doit rejoindre.', 'Pick the network Printr should join.', 'Kies het netwerk waarmee Bonnetje verbinding moet maken.')}</p>
      <div class="wizard-printers">
        ${state.networks.map((n) => html`<button type="button" key=${n.ssid} class="setting-card ${picked?.ssid === n.ssid ? 'on' : ''}"
          onClick=${() => { setPicked(n); setPassword(''); }}>
          <span class="wifi-bars" aria-label=${`${n.signal} %`}>${signalBars(n.signal)}</span>
          <span class="grow"><strong>${n.ssid}</strong><span class="muted">${n.secure ? T('🔒 Protégé', '🔒 Secured', '🔒 Beveiligd') : T('Ouvert', 'Open', 'Open')}</span></span></button>`)}
        ${!state.networks.length && html`<p class="muted">${T('Aucun réseau trouvé : tape son nom ci-dessous.', 'No network found: type its name below.', 'Geen netwerk gevonden: typ de naam hieronder.')}</p>`}
        <button type="button" class="setting-card ${picked?.hidden ? 'on' : ''}" onClick=${() => setPicked({ hidden: true })}>
          <span class="big-emoji" aria-hidden="true">✍️</span>
          <span class="grow"><strong>${T('Autre réseau', 'Other network', 'Ander netwerk')}</strong><span class="muted">${T('Réseau masqué, ou absent de la liste', 'Hidden network, or not listed', 'Verborgen netwerk, of niet in de lijst')}</span></span></button>
      </div>
      ${picked?.hidden && html`<input class="input" placeholder=${T('Nom du réseau', 'Network name', 'Netwerknaam')} value=${ssid} onInput=${(e) => setSsid(e.target.value)} />`}
      ${picked && needsPassword && html`<input class="input" type="password" autocomplete="off" placeholder=${T('Mot de passe du Wi-Fi', 'Wi-Fi password', 'Wifi-wachtwoord')}
        value=${password} onInput=${(e) => setPassword(e.target.value)} />`}
    </div>
    <div class="wizard-actions"><button class="btn primary big block" disabled=${busy || !name || (needsPassword && password.length < 8)}>
      ${busy ? html`<${Spinner} />` : T('Connecter Printr', 'Connect Printr', 'Bonnetje verbinden')}</button></div>
  </form></div>`;
}

// ============================================================================
// Assistant de premier lancement (administrateur)
// ============================================================================

const ACCENTS = 'é è à ç ù €';

// Étape « imprimante » : détection, ticket de test, puis la page de code selon les accents.
function WizardPrinter({ settings, values, onValues }) {
  const locked = settings.PRINTR_DEVICE?.locked || settings.PRINTR_TCP?.locked;
  const [found, setFound] = useState(null);
  const [choice, setChoice] = useState(null);
  const [manual, setManual] = useState(settings.PRINTR_TCP?.value || '');
  const [pc850, setPc850] = useState(settings.PRINTR_CODEPAGE?.value === '850');
  const [step, setStep] = useState('pick'); // pick → printing → ask → ok
  const detect = () => {
    setFound(null);
    api('GET', '/api/setup/printers').then((r) => {
      setFound(r);
      const first = r.usb[0]?.device ? { device: r.usb[0].device } : r.network[0] ? { tcp: r.network[0].tcp }
        : settings.PRINTR_TCP?.value ? { manual: true } : null;
      setChoice((c) => c || first);
    }).catch((e) => { toast(e.message, 'error'); setFound({ usb: [], network: [] }); });
  };
  useEffect(() => { if (!locked) detect(); }, []);

  const target = choice?.manual ? { tcp: manual.trim() } : choice;
  const print = async (codepage) => {
    setStep('printing');
    try {
      await api('POST', '/api/setup/test-print', { ...target, pc850: codepage });
      setStep('ask');
    } catch (e) { toast(e.message, 'error'); setStep('pick'); }
  };
  const answer = (ok) => {
    if (ok) {
      setStep('ok');
      onValues({ PRINTR_DEVICE: target.device || '', PRINTR_TCP: target.tcp || '', PRINTR_CODEPAGE: pc850 ? '850' : '' });
    } else {
      // L'autre page de code : celle des imprimantes qui n'ont pas le « € » (PC850).
      setPc850(!pc850); print(!pc850);
    }
  };
  const pick = (c) => { setChoice(c); setStep('pick'); };

  if (locked) {
    const fixed = settings.PRINTR_TCP?.value || settings.PRINTR_DEVICE?.value;
    return html`<p class="muted">${T(
      `L’imprimante est réglée par le système (${fixed}). Pour en changer, modifie /etc/printr.env.`,
      `The printer is set by the system (${fixed}). To change it, edit /etc/printr.env.`, `De printer wordt door het systeem ingesteld (${fixed}). Om hem te wijzigen, pas je /etc/printr.env aan.`,
    )}</p>`;
  }
  const same = (c) => choice && !choice.manual && c.device === choice.device && c.tcp === choice.tcp;
  return html`<div class="wizard-printers">
    ${found === null ? html`<div class="wizard-searching"><${Spinner} /><span class="muted">${T('Recherche des imprimantes…', 'Looking for printers…', 'Printers zoeken…')}</span></div>` : html`
      ${found.usb.map((p) => html`<button type="button" class="setting-card ${same(p) ? 'on' : ''}" onClick=${() => pick({ device: p.device })}>
        <span class="big-emoji" aria-hidden="true">🔌</span>
        <span class="grow"><strong>${T('USB', 'USB', 'USB')} · ${p.device}</strong><span class="muted">${printerState(p.status || 'missing').label()}</span></span></button>`)}
      ${found.network.map((p) => html`<button type="button" class="setting-card ${same(p) ? 'on' : ''}" onClick=${() => pick({ tcp: p.tcp })}>
        <span class="big-emoji" aria-hidden="true">📡</span>
        <span class="grow"><strong>${T('Réseau', 'Network', 'Netwerk')} · ${p.tcp}</strong><span class="muted">${T('Répond sur le port 9100', 'Answers on port 9100', 'Antwoordt op poort 9100')}</span></span></button>`)}
      ${!found.usb.length && !found.network.length && html`<p class="muted">${T(
        'Aucune imprimante trouvée. Vérifie qu’elle est allumée et branchée, puis relance la recherche.',
        'No printer found. Check that it is on and plugged in, then search again.', 'Geen printer gevonden. Controleer of hij aanstaat en is aangesloten en zoek dan opnieuw.',
      )}</p>`}
      <button type="button" class="setting-card ${choice?.manual ? 'on' : ''}" onClick=${() => pick({ manual: true })}>
        <span class="big-emoji" aria-hidden="true">✍️</span>
        <span class="grow"><strong>${T('Autre imprimante réseau', 'Another network printer', 'Een andere netwerkprinter')}</strong><span class="muted">${T('Son adresse et son port', 'Its address and port', 'Adres en poort')}</span></span></button>
      ${choice?.manual && html`<input class="input" placeholder="192.168.1.50:9100" value=${manual} onInput=${(e) => { setManual(e.target.value); setStep('pick'); }} />`}
      <button type="button" class="btn ghost small" onClick=${detect}><${Icon} name="history" size=${16} /> ${T('Chercher de nouveau', 'Search again', 'Opnieuw zoeken')}</button>`}

    ${step === 'pick' && html`<button type="button" class="btn primary block" disabled=${!target || (choice?.manual && !/^.+:\d+$/.test(manual.trim()))}
      onClick=${() => print(pc850)}>🧾 ${T('Imprimer un ticket de test', 'Print a test ticket', 'Een testbonnetje printen')}</button>`}
    ${step === 'printing' && html`<div class="wizard-searching"><${Spinner} /><span class="muted">${T('Impression…', 'Printing…', 'Printen…')}</span></div>`}
    ${step === 'ask' && html`<div class="wizard-ask"><strong>${T(`Les accents (${ACCENTS}) sont-ils bien sortis ?`, `Did the accents (${ACCENTS}) come out right?`, `Zijn de accenten (${ACCENTS}) goed uitgekomen?`)}</strong>
      <div class="wizard-actions"><button type="button" class="btn primary" onClick=${() => answer(true)}>${T('Oui, parfait', 'Yes, perfect', 'Ja, perfect')}</button>
        <button type="button" class="btn secondary" onClick=${() => answer(false)}>${T('Non, des symboles bizarres', 'No, odd symbols', 'Nee, rare tekens')}</button></div>
      <span class="muted">${T('« Non » imprime un nouveau ticket avec l’autre page de code.', '“No” prints a new ticket with the other code page.', '“Nee” print een nieuw bonnetje met de andere codepagina.')}</span></div>`}
    ${step === 'ok' && html`<p class="wizard-ok">✅ ${T('L’imprimante est prête.', 'The printer is ready.', 'De printer is klaar.')}${values.PRINTR_CODEPAGE === '850' ? T(' (page de code PC850)', ' (PC850 code page)', ' (PC850-codepagina)') : ''}</p>`}
  </div>`;
}

const WIZARD_STEPS = [
  { id: 'printer', emoji: '🖨️', title: T('Ton imprimante', 'Your printer', 'Je printer') },
  { id: 'city', emoji: '🏙️', title: T('Ta ville', 'Your city', 'Je stad') },
  { id: 'claude', emoji: '✨', title: 'Claude' },
  { id: 'done', emoji: '🎉', title: T('C’est prêt !', 'All set!', 'Klaar!') },
];

function Wizard({ me, onDone }) {
  const [settings, setSettings] = useState(null);
  const [index, setIndex] = useState(0);
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  useEffect(() => {
    api('GET', '/api/settings').then((r) => setSettings(Object.fromEntries(r.settings.map((s) => [s.key, s]))))
      .catch((e) => { toast(e.message, 'error'); onDone(); });
  }, []);
  const set = (key, value) => setValues((v) => ({ ...v, [key]: value }));
  const step = WIZARD_STEPS[index];

  const finish = async () => {
    setBusy(true);
    try {
      await api('POST', '/api/wizard/done');
      // Mises à jour automatiques proposées par défaut : Printr se débrouille seul.
      const all = settings.PRINTR_AUTO_UPDATE && !settings.PRINTR_AUTO_UPDATE.set ? { PRINTR_AUTO_UPDATE: 'auto', ...values } : values;
      // Seulement ce qui change, et pas ce que le système fixe.
      const changes = Object.fromEntries(Object.entries(all)
        .filter(([k, v]) => !settings[k]?.locked && (settings[k]?.value ?? (settings[k]?.set ? null : '')) !== v));
      if (!Object.keys(changes).length) { onDone(); return; }
      const r = await api('PUT', '/api/settings', { values: changes });
      if (r.restarting) { setRestarting(true); waitForRestart(); return; }
      toast(T('Réglages enregistrés : redémarre Printr pour les appliquer.', 'Settings saved: restart Printr to apply them.', 'Instellingen opgeslagen: herstart Bonnetje om ze toe te passen.'), 'warn', '🔁');
      onDone();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };

  if (restarting) return html`<div class="login"><${Restarting} /></div>`;
  if (!settings) return html`<div class="boot"><${Spinner} /></div>`;
  const city = values.PRINTR_CITY ?? settings.PRINTR_CITY?.value ?? '';
  const key = values.ANTHROPIC_API_KEY ?? '';
  let body;
  if (step.id === 'printer') {
    body = html`<p class="muted">${T('Choisis l’imprimante, puis imprime un ticket pour vérifier.', 'Pick the printer, then print a ticket to check.', 'Kies de printer en print dan een bonnetje om te controleren.')}</p>
      <${WizardPrinter} settings=${settings} values=${values} onValues=${(v) => setValues((old) => ({ ...old, ...v }))} />`;
  } else if (step.id === 'city') {
    body = settings.PRINTR_CITY?.locked
      ? html`<p class="muted">${T(`La ville est réglée par le système : ${city}.`, `The city is set by the system: ${city}.`, `De stad wordt door het systeem ingesteld: ${city}.`)}</p>`
      : html`<${Field} help=${T('Pour la météo, la qualité de l’air et les horaires du soleil. Tu pourras la changer dans chaque bloc.',
          'For the weather, air quality and sun times. You can change it in each block.', 'Voor het weer, de luchtkwaliteit en de zonnetijden. Je kunt het in elk blok aanpassen.')}>
          <input class="input" placeholder=${T('Ex. Bordeaux', 'E.g. Boston', 'Bv. Gent')} value=${city} onInput=${(e) => set('PRINTR_CITY', e.target.value)} /></${Field}>`;
  } else if (step.id === 'claude') {
    body = settings.ANTHROPIC_API_KEY?.set
      ? html`<p class="muted">✅ ${T('Claude est déjà configuré : histoires, horoscope, recettes et mot du jour sont disponibles.',
          'Claude is already set up: stories, horoscope, recipes and word of the day are available.', 'Claude is al ingesteld: verhalen, horoscoop, recepten en woord van de dag zijn beschikbaar.')}</p>`
      : html`<p class="muted">${T(
          'Facultatif : avec une clé d’API Anthropic, Printr écrit des histoires, l’horoscope, des recettes et le mot du jour. Sans clé, tous les autres blocs marchent.',
          'Optional: with an Anthropic API key, Printr writes stories, the horoscope, recipes and the word of the day. Without one, every other block works.', 'Optioneel: met een Anthropic API-sleutel schrijft Bonnetje verhalen, de horoscoop, recepten en het woord van de dag. Zonder sleutel werken alle andere blokken gewoon.',
        )}</p>
        <${Field} help=${html`<a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">${T('Créer une clé sur console.anthropic.com', 'Create a key on console.anthropic.com', 'Maak een sleutel aan op console.anthropic.com')}</a>`}>
          <input class="input" type="password" autocomplete="off" placeholder="sk-ant-…" value=${key} onInput=${(e) => set('ANTHROPIC_API_KEY', e.target.value.trim())} /></${Field}>`;
  } else {
    body = html`<p class="muted">${T(
      'Ouvre Printr sur le téléphone de chacun à cette adresse, et ajoute-les depuis « Mon compte ».',
      'Open Printr on everyone’s phone at this address, and add them from “My account”.', 'Open Bonnetje op ieders telefoon via dit adres en voeg ze toe via “Mijn account”.',
    )}</p><p class="wizard-address">${location.origin}</p>
    ${settings.PRINTR_AUTO_UPDATE && !settings.PRINTR_AUTO_UPDATE.locked && html`<${Switch} label=${T('Mettre Printr à jour tout seul, la nuit', 'Keep Printr up to date by itself, at night', 'Bonnetje \'s nachts zelf up-to-date houden')}
      help=${T('Les nouvelles versions signées s’installent entre 3 h et 5 h.', 'New signed versions install between 3 and 5 am.', 'Nieuwe ondertekende versies worden tussen 3 en 5 uur geïnstalleerd.')}
      checked=${(values.PRINTR_AUTO_UPDATE ?? (settings.PRINTR_AUTO_UPDATE.set ? settings.PRINTR_AUTO_UPDATE.value : 'auto')) === 'auto'}
      onChange=${(on) => set('PRINTR_AUTO_UPDATE', on ? 'auto' : '')} />`}`;
  }
  const last = index === WIZARD_STEPS.length - 1;
  return html`<div class="login"><div class="login-card wizard">
    <ol class="wizard-steps" aria-label=${T('Étapes', 'Steps', 'Stappen')}>${WIZARD_STEPS.map((s, i) => html`<li class=${i === index ? 'on' : i < index ? 'done' : ''}
      aria-current=${i === index ? 'step' : undefined}>${s.emoji}</li>`)}</ol>
    ${index === 0 && html`<p class="muted" style="margin:0">${T(`Bienvenue ${me.name} ! Quelques réglages et c’est parti.`, `Welcome, ${me.name}! A few settings and you’re off.`, `Welkom, ${me.name}! Nog een paar instellingen en je kunt starten.`)}</p>`}
    <h1>${step.title}</h1>
    <div class="wizard-body">${body}</div>
    <div class="wizard-actions">
      ${index > 0 && html`<button type="button" class="btn ghost" onClick=${() => setIndex(index - 1)}>${T('Retour', 'Back', 'Terug')}</button>`}
      <span class="grow"></span>
      ${last
        ? html`<button type="button" class="btn primary big" disabled=${busy} onClick=${finish}>${busy ? html`<${Spinner} />` : T('C’est parti !', 'Let’s go!', 'Aan de slag!')}</button>`
        : html`<button type="button" class="btn primary" onClick=${() => setIndex(index + 1)}>${T('Suivant', 'Next', 'Volgende')}</button>`}
    </div>
    ${!last && html`<button type="button" class="btn ghost small wizard-skip" disabled=${busy} onClick=${finish}>${T('Passer, je réglerai plus tard', 'Skip, I’ll set it up later', 'Overslaan, ik stel het later in')}</button>`}
  </div></div>`;
}

const NAV = [
  { hash: '#/', label: T('Accueil', 'Home', 'Thuis'), icon: 'home', title: 'Printr' },
  { hash: '#/compose', label: T('Composer', 'Compose', 'Opstellen'), icon: 'ticket', title: T('Composer', 'Compose', 'Opstellen') },
  { hash: '#/message', label: T('Petit mot', 'Little note', 'Briefje'), icon: 'heart', title: T('Un petit mot', 'A little note', 'Een berichtje') },
  { hash: '#/history', label: T('Historique', 'History', 'Geschiedenis'), icon: 'history', title: T('Historique', 'History', 'Geschiedenis') },
];
// Écrans accessibles depuis l'accueil, sans onglet.
const ROUTES = [...NAV, { hash: '#/courses', title: T('Liste de courses', 'Shopping list', 'Boodschappenlijst') }];

function App() {
  const [me, setMe] = useState(undefined);
  const [users, setUsers] = useState([]);
  const [version, setVersion] = useState(null);
  const [update, setUpdate] = useState(null); // version plus récente publiée sur GitHub
  // L'imprimante est-elle là ? Et combien de tickets attendent son retour ? (vérifié toutes les 30 s)
  const [printer, setPrinter] = useState({ ready: true, status: 'ready', queued: 0, paper: null });
  const [presets, setPresets] = useState(null);
  const [composer, setComposer] = useState(() => store.get('printr.draft', null) || emptyComposer());
  const [scrolled, setScrolled] = useState(false);
  const [menu, setMenu] = useState(false);
  const [wizard, setWizard] = useState(false); // assistant de premier lancement à faire
  const [wifi, setWifi] = useState(null); // première connexion au réseau en cours
  const hash = useHash();

  const loadPresets = useCallback(() => api('GET', '/api/presets').then(setPresets).catch((e) => toast(e.message, 'error')), []);
  const loadUsers = useCallback(() => api('GET', '/api/users').then(setUsers).catch(() => {}), []);

  useEffect(() => {
    api('GET', '/api/wifi').then(setWifi).catch(() => {});
    api('GET', '/api/me').then(({ user }) => setMe(user)).catch(() => setMe(null));
    return bus.on('unauthorized', () => { Object.assign(MY_CATALOG, { favorites: [], recent: [] }); setMe(null); });
  }, []);
  useEffect(() => {
    if (!me) return;
    loadPresets();
    loadUsers();
    const status = () => api('GET', '/api/status').then((s) => {
      setVersion(s.version); setUpdate(s.update || null); setWizard(!!s.wizard);
      CATALOG.hidden = s.hidden_blocks || [];
      CATALOG.claude = !!s.claude;
      SERVER.mqtt = s.mqtt_prefix || null;
      SERVER.city = s.city || null;
      SERVER.customBlocks = s.custom_blocks || [];
      SERVER.autoUpdate = !!s.auto_update;
      SERVER.lastUpdate = s.last_update || null;
      setPrinter((before) => {
        const status = s.printer_status || (s.printer_ready === false ? 'missing' : 'ready');
        const now = { ready: status === 'ready', status, queued: s.queued || 0, paper: s.paper || null };
        if (before.status !== now.status || before.queued !== now.queued) bus.emit('printer-changed');
        return now;
      });
    }).catch(() => {});
    status();
    const timer = setInterval(status, 30000);
    const off = bus.on('printer', () => setTimeout(status, 600));
    return () => { clearInterval(timer); off(); };
  }, [me]);
  useEffect(() => {
    const onScroll = () => setScrolled(scrollY > 4);
    addEventListener('scroll', onScroll, { passive: true });
    return () => removeEventListener('scroll', onScroll);
  }, []);

  if (wifi) return html`<${WifiSetup} state=${wifi} /><${Toasts} />`;
  if (me === undefined) return html`<div class="boot"><${Spinner} /></div><${Toasts} />`;
  if (me === null) return html`<${Login} onLogin=${setMe} /><${Toasts} />`;
  if (wizard) return html`<${Wizard} me=${me} onDone=${() => { setWizard(false); bus.emit('printer'); }} /><${Toasts} />`;

  const openComposer = (state) => { setComposer(state); location.hash = '#/compose'; };
  const logout = async () => {
    await api('POST', '/api/logout').catch(() => {});
    Object.assign(MY_CATALOG, { favorites: [], recent: [] });
    setMenu(false); setMe(null);
  };
  const route = ROUTES.find((n) => n.hash === hash) || NAV[0];
  const title = route.hash === '#/compose'
    ? (composer.id ? T('Modifier le ticket', 'Edit ticket', 'Bonnetje bewerken') : T('Nouveau ticket', 'New ticket', 'Nieuw bonnetje'))
    : route.title;

  let page;
  if (route.hash === '#/compose') page = html`<${Composer} initial=${composer} onSaved=${loadPresets} admin=${me.admin} />`;
  else if (route.hash === '#/message') page = html`<${Message} me=${me} onSaved=${loadPresets} />`;
  else if (route.hash === '#/history') page = html`<${History} users=${users} me=${me} />`;
  else if (route.hash === '#/courses') page = html`<${Shopping} users=${users} />`;
  else page = html`<${Home} me=${me} presets=${presets} reload=${loadPresets} openComposer=${openComposer} />`;

  return html`<div class="shell">
    <nav class="sidebar" aria-label=${T('Navigation', 'Navigation', 'Navigatie')}>
      <div class="brand"><img src="/mark.png" alt="" />Printr</div>
      ${NAV.map((n) => html`<a class="navlink ${n.hash === route.hash ? 'active' : ''}" href=${n.hash}
        onClick=${n.hash === '#/compose' ? (e) => { if (route.hash !== '#/compose') { e.preventDefault(); openComposer(store.get('printr.draft', null) || emptyComposer()); } } : undefined}>
        <${Icon} name=${n.icon} />${n.label}</a>`)}
      <div class="spacer"></div>
      <div class="printer-state ${printer.ready ? 'ok' : 'off'}">${printerState(printer.status).label()}</div>
      ${version && html`<div class="version">printr ${version}${me.admin && update && html` · <a href=${update.url} target="_blank" rel="noopener">${T(`${update.version} disponible`, `${update.version} available`, `${update.version} beschikbaar`)}</a>`}</div>`}
      <div class="account-row">
        <button type="button" class="navlink account" onClick=${() => setMenu(true)}><${Avatar} user=${me} />
          <span class="grow"><strong>${me.name}</strong><span class="muted">${T('Mon compte', 'My account', 'Mijn account')}</span></span></button>
        <button class="iconbtn" aria-label=${T('Se déconnecter', 'Sign out', 'Afmelden')} title=${T('Se déconnecter', 'Sign out', 'Afmelden')} onClick=${logout}><${Icon} name="logout" /></button></div>
    </nav>
    <main class="main">
      <header class="topbar ${scrolled ? 'scrolled' : ''}">
        ${route.hash === '#/'
          ? html`<h1 class="home-title"><img src="/mark.png" alt="" />${title}${version && html`<span class="version">${version}</span>`}</h1>`
          : html`<h1>${title}</h1>`}
        ${route.hash === '#/compose' && composer.id && html`<button class="btn ghost small" onClick=${() => openComposer(emptyComposer())}><${Icon} name="plus" size=${16} /> ${T('Nouveau', 'New', 'Nieuw')}</button>`}
        <button class="me" aria-label=${T('Mon compte', 'My account', 'Mijn account')} title=${T('Mon compte', 'My account', 'Mijn account')} onClick=${() => setMenu(true)}><${Avatar} user=${me} /><span>${T('Mon compte', 'My account', 'Mijn account')}</span></button>
      </header>
      ${!printer.ready && html`<div class="printer-banner" role="status"><span class="emoji">${printerState(printer.status).emoji}</span>
        <span>${printerState(printer.status).banner()}
        ${printer.queued > 0 && html` <strong>${T(`${printer.queued} en attente`, `${printer.queued} waiting`, `${printer.queued} in wachtrij`)}</strong>`}</span></div>`}
      ${printer.ready && printer.paper?.low && html`<div class="printer-banner" role="status"><span class="emoji">🧻</span>
        <span>${T(`Papier presque fini : environ ${metres(printer.paper.remaining_mm)} restants. Pense à prévoir un rouleau !`, `Paper almost out: about ${metres(printer.paper.remaining_mm)} left. Time to get a new roll!`, `Papier bijna op: nog ongeveer ${metres(printer.paper.remaining_mm)} over. Tijd voor een nieuwe rol!`)}</span></div>`}
      ${page}
    </main>
    <nav class="tabbar" aria-label=${T('Navigation', 'Navigation', 'Navigatie')}>
      ${NAV.map((n) => html`<a class="tab ${n.hash === route.hash ? 'active' : ''}" href=${n.hash}><${Icon} name=${n.icon} />${n.label}</a>`)}
    </nav>
    ${menu && html`<${AccountSheet} me=${me} users=${users} version=${version} update=${update} paper=${printer.paper} reloadUsers=${loadUsers} onLogout=${logout} onClose=${() => setMenu(false)} />`}
    <${Toasts} />
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
