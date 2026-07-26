const STORAGE_KEY = "custom-cards-sim-luffy-only-v1";
const SAVED_DECKS_KEY = "custom-cards-sim-luffy-only-saved-decks-v1";
const CUSTOM_CARDS_KEY = "custom-cards-sim-imported-cards-v1";
const PROJECT_CARDS_API = "/api/project-cards";
const CARD_FILES = [
  { path: "data/cards/leaders.json", category: "leader" },
  { path: "data/cards/characters.json", category: "character" },
  { path: "data/cards/events.json", category: "event" },
  { path: "data/cards/stages.json", category: "stage" },
  { path: "data/cards/custom-project-cards.json", optional: true, projectCards: true }
];
const CARD_BACK_IMAGE = "images/basic/card-back-custom.png";
const DON_CARD_IMAGE = "images/basic/don-card-custom.png";
const DON_DECK_IMAGE = "images/basic/don-deck-custom.png";
const IMPORT_IMAGE_MAX_WIDTH = 760;
const IMPORT_IMAGE_MAX_HEIGHT = 1064;
const IMPORT_IMAGE_QUALITY = 0.84;

function initialView() {
  const requestedView = new URLSearchParams(window.location.search).get("view");
  return ["home", "builder", "game", "settings"].includes(requestedView) ? requestedView : "home";
}

const state = {
  cards: [],
  leaderId: "",
  deck: {},
  // Token types this deck makes available in game. Deliberately a separate list
  // from `deck` so tokens never count toward the 50-card main deck, have no copy
  // limit, and are entirely optional. Only the TYPES are chosen here - how many
  // copies exist during a match is decided at the table, not in the builder.
  tokens: [],
  deckName: "",
  activeView: initialView(),
  game: null,
  practiceDecks: {
    player: "current",
    opponent: "current"
  },
  searchMode: "AND",
  sortField: "number",
  rotationOnly: false,
  searchRenderTimer: null,
  editingCardId: "",
  creationImageData: ""
};

const el = {
  viewButtons: document.querySelectorAll("[data-view]"),
  viewPanels: document.querySelectorAll("[data-view-panel]"),
  navTabs: document.querySelectorAll(".nav-tab"),
  homeLeader: document.querySelector("#homeLeader"),
  homeDeckCount: document.querySelector("#homeDeckCount"),
  homePoolCount: document.querySelector("#homePoolCount"),
  leaderTotal: document.querySelector("#leaderTotal"),
  characterTotal: document.querySelector("#characterTotal"),
  eventTotal: document.querySelector("#eventTotal"),
  stageTotal: document.querySelector("#stageTotal"),
  deckTitle: document.querySelector("#deckTitle"),
  deckName: document.querySelector("#deckName"),
  deckCount: document.querySelector("#deckCount"),
  deckWarnings: document.querySelector("#deckWarnings"),
  leaderSlot: document.querySelector("#leaderSlot"),
  deckList: document.querySelector("#deckList"),
  cardGrid: document.querySelector("#cardGrid"),
  filteredCount: document.querySelector("#filteredCount"),
  collectionHint: document.querySelector("#collectionHint"),
  searchInput: document.querySelector("#searchInput"),
  filterQuick: document.querySelector("#filterQuick"),
  categoryFilter: document.querySelector("#categoryFilter"),
  colorFilter: document.querySelector("#colorFilter"),
  setFilter: document.querySelector("#setFilter"),
  costFilter: document.querySelector("#costFilter"),
  powerFilter: document.querySelector("#powerFilter"),
  counterFilter: document.querySelector("#counterFilter"),
  rarityFilter: document.querySelector("#rarityFilter"),
  blockFilter: document.querySelector("#blockFilter"),
  clearSearch: document.querySelector("#clearSearch"),
  runSearch: document.querySelector("#runSearch"),
  showSearchTips: document.querySelector("#showSearchTips"),
  closeSearchTips: document.querySelector("#closeSearchTips"),
  searchTipsDialog: document.querySelector("#searchTipsDialog"),
  openCardImport: document.querySelector("#openCardImport"),
  closeCardImport: document.querySelector("#closeCardImport"),
  cardImportDialog: document.querySelector("#cardImportDialog"),
  cardImportForm: document.querySelector("#cardImportForm"),
  importImage: document.querySelector("#importImage"),
  importCardNumber: document.querySelector("#importCardNumber"),
  importName: document.querySelector("#importName"),
  importCategory: document.querySelector("#importCategory"),
  importColors: document.querySelector("#importColors"),
  importCost: document.querySelector("#importCost"),
  importPower: document.querySelector("#importPower"),
  importCounter: document.querySelector("#importCounter"),
  importAttribute: document.querySelector("#importAttribute"),
  importTypes: document.querySelector("#importTypes"),
  importRarity: document.querySelector("#importRarity"),
  importKeywords: document.querySelector("#importKeywords"),
  importEffectText: document.querySelector("#importEffectText"),
  importStatus: document.querySelector("#importStatus"),
  clearImportedCards: document.querySelector("#clearImportedCards"),
  saveDeck: document.querySelector("#saveDeck"),
  startPracticeTop: document.querySelector("#startPracticeTop"),
  quickBuild: document.querySelector("#quickBuild"),
  clearDeckHome: document.querySelector("#clearDeckHome"),
  autoFillDeck: document.querySelector("#autoFillDeck"),
  clearDeck: document.querySelector("#clearDeck"),
  resetFilters: document.querySelector("#resetFilters"),
  saveDeckMini: document.querySelector("#saveDeckMini"),
  savedDecksTab: document.querySelector("#savedDecksTab"),
  savedDecksPanel: document.querySelector("#savedDecksPanel"),
  closeSavedDecks: document.querySelector("#closeSavedDecks"),
  savedDeckList: document.querySelector("#savedDeckList"),
  cardCreationTab: document.querySelector("#cardCreationTab"),
  cardCreationPanel: document.querySelector("#cardCreationPanel"),
  closeCardCreation: document.querySelector("#closeCardCreation"),
  cardCreationForm: document.querySelector("#cardCreationForm"),
  creationImage: document.querySelector("#creationImage"),
  creationImageUrl: document.querySelector("#creationImageUrl"),
  creationCardNumber: document.querySelector("#creationCardNumber"),
  creationName: document.querySelector("#creationName"),
  creationCategory: document.querySelector("#creationCategory"),
  creationColors: document.querySelector("#creationColors"),
  creationCost: document.querySelector("#creationCost"),
  creationPower: document.querySelector("#creationPower"),
  creationCounter: document.querySelector("#creationCounter"),
  creationAttribute: document.querySelector("#creationAttribute"),
  creationTypes: document.querySelector("#creationTypes"),
  creationRarity: document.querySelector("#creationRarity"),
  creationCopyLimit: document.querySelector("#creationCopyLimit"),
  creationKeywords: document.querySelector("#creationKeywords"),
  creationEffectText: document.querySelector("#creationEffectText"),
  creationStatus: document.querySelector("#creationStatus"),
  libraryStatus: document.querySelector("#libraryStatus"),
  restoreCards: document.querySelector("#restoreCards"),
  restoreHint: document.querySelector("#restoreHint"),
  scanProgress: document.querySelector("#scanProgress"),
  scanProgressFill: document.querySelector("#scanProgressFill"),
  scanProgressLabel: document.querySelector("#scanProgressLabel"),
  clearCreationForm: document.querySelector("#clearCreationForm"),
  creationImagePreview: document.querySelector("#creationImagePreview"),
  startGame: document.querySelector("#startGame"),
  drawCard: document.querySelector("#drawCard"),
  addDon: document.querySelector("#addDon"),
  passTurn: document.querySelector("#passTurn"),
  endGame: document.querySelector("#endGame"),
  phaseAction: document.querySelector("#phaseAction"),
  phaseStatus: document.querySelector("#phaseStatus"),
  gameTitle: document.querySelector("#gameTitle"),
  turnBadge: document.querySelector("#turnBadge"),
  phaseLog: document.querySelector("#phaseLog"),
  gameBoard: document.querySelector("#gameBoard"),
  gameLogMessages: document.querySelector("#gameLogMessages"),
  previewImage: document.querySelector("#previewImage"),
  previewPlaceholder: document.querySelector("#previewPlaceholder"),
  cardDialog: document.querySelector("#cardDialog"),
  cardPreview: document.querySelector("#cardPreview"),
  closePreview: document.querySelector("#closePreview")
};

function isBlockEffect(effect) {
  return Boolean(
    effect &&
    effect.system !== "customEffectV2" &&
    effect.timing &&
    Array.isArray(effect.actions)
  );
}

function isCustomEffectV2(effect) {
  return effect?.system === "customEffectV2";
}

function effectDedupeKey(effect) {
  if (!effect || typeof effect !== "object") return JSON.stringify(effect);
  const system = effect.system || effect.type || "effect";
  const id = effect.id || "";
  if (id) return `${system}:${id}`;
  return `${system}:${effect.event?.type || effect.timing?.type || ""}:${effect.generatedText || effect.text || effect.sourceText || JSON.stringify(effect)}`;
}

function dedupeEffects(effects) {
  const seen = new Set();
  const deduped = [];

  (Array.isArray(effects) ? effects : []).forEach(effect => {
    const key = effectDedupeKey(effect);
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(effect);
  });

  return deduped;
}

function dedupeCustomEffectV2(rawEffects, explicitEffects = []) {
  return dedupeEffects([
    ...(Array.isArray(explicitEffects) ? explicitEffects : []),
    ...(Array.isArray(rawEffects) ? rawEffects.filter(isCustomEffectV2) : [])
  ]);
}

function normalizeCard(raw, category) {
  const id = String(raw.id || raw.cardNumber || crypto.randomUUID());
  const cardNumber = raw.cardNumber || id;
  const setCode = String(cardNumber).split("-")[0] || "";
  const colorText = String(raw.color || raw.colors || "colorless");
  const normalizedCategory = normalizeCategory(category || raw.category || raw.cardType);
  const colors = colorText
    .split(/[,/]/)
    .map(color => color.trim().toLowerCase())
    .filter(Boolean);
  const rawEffects = dedupeEffects(Array.isArray(raw.effects) ? raw.effects : []);
  const customEffectV2 = dedupeCustomEffectV2(rawEffects, raw.customEffectV2);
  const blockEffects = Array.isArray(raw.effectBlocks)
    ? raw.effectBlocks
    : rawEffects.filter(isBlockEffect);
  const effects = rawEffects.length
    ? rawEffects
        .map(effect => effect.generatedText || effect.text || effect.sourceText)
        .filter(Boolean)
        .join("\n")
    : String(raw.effect || raw.text || "");

  return {
    id,
    cardNumber,
    setCode,
    block: setCode.replace(/\d.*/, "") || setCode,
    name: raw.name || "Unnamed Card",
    category: normalizedCategory,
    type: raw.type || "",
    colors: colors.length ? colors : ["colorless"],
    attribute: raw.attribute || "",
    cost: raw.cost ?? "",
    power: raw.power ?? "",
    counter: raw.counter ?? "",
    life: raw.life ?? "",
    rarity: raw.rarity || "",
    // Deck copy limit. Preserved with ?? (not ||) because 0 is the meaningful
    // value for "unlimited"; falls back to the standard 4 when a card predates
    // this option. Never left `undefined` - Firebase refuses to write undefined,
    // and that broke multiplayer match setup.
    copyLimit: raw.copyLimit ?? DEFAULT_COPY_LIMIT,
    keywords: Array.isArray(raw.keywords) ? raw.keywords : [],
    effects,
    rawEffects,
    customEffectV2,
    effectBlocks: blockEffects,
    imageUrl: normalizeImagePath(raw.image || ""),
    effectScript: raw.effectScript || raw.script || "",
    imported: Boolean(raw.imported || raw.needsCoding),
    needsCoding: Boolean(raw.needsCoding),
    importSource: raw.importSource || null,
    effectStatus: raw.effectStatus || ""
  };
}

function normalizeImportedCard(raw) {
  const category = normalizeCategory(raw.category || raw.cardType || raw.type);
  return normalizeCard(raw, category);
}

function normalizeCategory(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["leader", "character", "event", "stage", "token"].includes(text)) return text;
  if (text.includes("leader")) return "leader";
  if (text.includes("event")) return "event";
  if (text.includes("stage")) return "stage";
  if (text.includes("token")) return "token";
  return "character";
}

function normalizeImagePath(path) {
  return String(path || "").replace(/^\.\.\//, "");
}

async function loadCardFile(file) {
  const cacheBreaker = file.optional ? `?v=${Date.now()}` : "";
  const response = await fetch(`${file.path}${cacheBreaker}`, { cache: file.optional ? "no-store" : "default" });

  if (!response.ok) {
    if (file.optional) return [];
    throw new Error(`Could not load ${file.path}`);
  }

  const payload = await response.json();
  const cards = Array.isArray(payload)
    ? payload
    : Object.values(payload || {});

  return cards.map(card => normalizeCard(card, file.category || card.category || card.cardType));
}

// Identity of a card in the pool. Keyed by CARD NUMBER for every category.
//
// Leaders used to be keyed by name instead, which silently collapsed different
// leaders that share a name - and in a custom set that's normal (there are five
// separate cards called "Ichigo Kurosaki" here). Only one of them would ever
// appear, with no error, so a newly added leader looked like it hadn't saved.
// Name is still the fallback for a card with no number at all.
function cardLibraryKey(card) {
  const category = normalizeCategory(card.category || card.cardType);
  const name = String(card.name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  const number = String(card.cardNumber || card.id || "").trim().toLowerCase();

  return `${category}:${number || name}`;
}

function dedupeCards(cards) {
  const seen = new Set();
  const deduped = [];

  cards.forEach(card => {
    const key = cardLibraryKey(card);
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(card);
  });

  return deduped;
}

// Pull the shared Firebase library into the shape the card pool expects.
// Failures are non-fatal: the site still runs on the bundled files.
async function loadSharedCardsForPool() {
  const library = await getCardLibrary();
  if (!library) return { cards: [], deleted: new Set() };

  try {
    const { cards, deleted } = await library.loadSharedCards();
    return {
      cards: cards.map(card => normalizeCard(card, card.category || card.cardType)),
      deleted: deleted || new Set()
    };
  } catch (error) {
    console.warn("Shared cards not loaded into the pool:", error);
    return { cards: [], deleted: new Set() };
  }
}

async function loadCardPool() {
  try {
    const groups = await Promise.all(CARD_FILES.map(loadCardFile));
    const loadedCards = groups.flat();

    // Cards uploaded by players live ONLY in the shared library - they are not
    // written back into the bundled JSON files. Without merging them here the
    // pool showed nothing but what ships in the repo, which is why a card could
    // save successfully to Firebase and still never appear on the site.
    const { cards: sharedCards, deleted } = await loadSharedCardsForPool();

    const byKey = new Map();
    loadedCards.forEach(card => {
      // NOTE: the tombstone set is keyed by CARD NUMBER. app.js's
      // cardLibraryKey() returns a category-prefixed dedupe key
      // ("token:jjba-001"), which never matches - use projectCardKey().
      // A deleted card must not come back from the bundled JSON file; that's
      // what made deleting a bundled card look like it silently failed.
      if (!deleted.has(projectCardKey(card))) byKey.set(cardLibraryKey(card), card);
    });
    // Shared copies win: they're the edited/newer version of a bundled card.
    sharedCards.forEach(card => byKey.set(cardLibraryKey(card), card));
    const pooledCards = [...byKey.values()];

    const loadedKeys = new Set(pooledCards.map(cardLibraryKey));
    const legacyCards = loadImportedCards()
      .map(normalizeImportedCard)
      .filter(card => !loadedKeys.has(cardLibraryKey(card)));

    state.cards = dedupeCards([
      ...pooledCards,
      ...legacyCards
    ]).sort((a, b) => a.cardNumber.localeCompare(b.cardNumber));
    populateFilterOptions();
    renderAll();
    updateImportStatus();
  } catch (error) {
    el.cardGrid.innerHTML = `<div class="empty">Card data could not be loaded. Run this through the included local server, then refresh.</div>`;
    if (el.phaseLog) el.phaseLog.textContent = error.message;
    setGameLog(error.message);
  }
}

function loadImportedCards() {
  try {
    const cards = JSON.parse(localStorage.getItem(CUSTOM_CARDS_KEY) || "[]");
    if (!Array.isArray(cards)) return [];
    return dedupeImportedCards(cards);
  } catch {
    localStorage.removeItem(CUSTOM_CARDS_KEY);
    return [];
  }
}

function importedCardDedupeKey(card) {
  const category = normalizeCategory(card.category || card.cardType || card.type);
  const name = String(card.name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  return category === "leader" && name
    ? `${category}:${name}`
    : `${category}:${card.cardNumber || card.id || name}`;
}

function dedupeImportedCards(cards) {
  const seen = new Set();
  const deduped = [];

  cards.forEach(card => {
    const key = importedCardDedupeKey(card);

    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(card);
  });

  if (deduped.length !== cards.length) {
    try {
      localStorage.setItem(CUSTOM_CARDS_KEY, JSON.stringify(deduped));
    } catch (error) {
      console.warn(error);
    }
  }

  return deduped;
}

function saveImportedCards(cards) {
  try {
    localStorage.setItem(CUSTOM_CARDS_KEY, JSON.stringify(cards));
    return true;
  } catch (error) {
    console.error(error);
    toast("Card library storage is full. Clear imports or use a smaller image.");
    return false;
  }
}

// ── Card storage: server vs static hosting ───────────────
// Saving cards normally POSTs to /api/project-cards, which only exists when the
// bundled Node server is running. On static hosting (GitHub Pages) there is no
// backend, so that POST 404s and saving used to fail outright with "start the
// local server". Instead we fall back to this browser's own storage: the shipped
// JSON file stays the shared baseline, and anything saved here is layered on top
// of it for this device.
const LOCAL_PROJECT_CARDS_KEY = "custom-cards-sim-local-project-cards-v1";
const LOCAL_PROJECT_DELETIONS_KEY = "custom-cards-sim-local-project-deletions-v1";

// Cached so we don't fire a doomed request on every single save.
let projectCardsApiAvailable = null;

// The shared Firebase-backed card library. Loaded lazily (and only once) because
// app.js is a classic script and the service is an ES module.
let cardLibraryPromise = null;
let cardLibraryUnavailable = false;
// Guards the one-time auto-publish of the bundled cards on a fresh deployment.
let sharedLibrarySeedAttempted = false;
// So the "library unreachable" warning appears once, not on every save.
let sharedLibraryWarned = false;

function getCardLibrary() {
  if (cardLibraryUnavailable) return Promise.resolve(null);
  if (!cardLibraryPromise) {
    cardLibraryPromise = import("./js/firebase/cardLibraryService.js")
      .catch(error => {
        console.warn("Shared card library unavailable:", error);
        cardLibraryUnavailable = true;
        return null;
      });
  }
  return cardLibraryPromise;
}

function projectCardKey(card) {
  return String(card?.cardNumber || card?.id || "").trim();
}

// Work out exactly WHY the shared library isn't reachable, rather than just
// echoing "Permission denied". The three things that actually go wrong are a
// database URL pointing at the wrong region, unpublished rules, and Anonymous
// sign-in being switched off - each needs a different fix, so name the right one.
async function diagnoseSharedLibrary() {
  let databaseURL = "";
  try {
    ({ databaseURL } = (await import("./js/firebase/firebaseConfig.js")).firebaseConfig);
  } catch {
    return "Firebase config missing (js/firebase/firebaseConfig.js).";
  }

  const base = String(databaseURL || "").replace(/\/+$/, "");
  if (!base) return "No databaseURL set in js/firebase/firebaseConfig.js.";

  // cardIndex is world-readable under the shipped rules, so this one request
  // distinguishes "wrong database" from "rules not published".
  let response;
  try {
    response = await fetch(`${base}/cardIndex.json?shallow=true`);
  } catch {
    return "Can't reach Firebase at all — check your internet connection.";
  }

  if (response.status === 404) {
    const body = await response.json().catch(() => ({}));
    return body.correctUrl
      ? `Wrong database URL. Firebase says the real one is ${body.correctUrl} — put that in js/firebase/firebaseConfig.js as databaseURL.`
      : `No database at ${base}. Check databaseURL in js/firebase/firebaseConfig.js.`;
  }

  if (response.status === 401 || response.status === 403) {
    return `Rules not published on THIS database (${base}). ` +
      "In Firebase Console → Realtime Database, use the dropdown at the top to select that exact URL, " +
      "then paste database.rules.json into its Rules tab and Publish.";
  }

  if (!response.ok) return `Firebase returned HTTP ${response.status}.`;

  // Reads work, so the rules are live and the database URL is right. That
  // leaves sign-in - actually attempt it and report the real reason, because
  // "domain not authorised" and "Anonymous turned off" need different fixes and
  // both otherwise surface as a vague permission error.
  try {
    const { waitForUser } = await import("./js/firebase/firebaseApp.js");
    await waitForUser();
  } catch (error) {
    const code = String(error?.code || error?.message || "");

    if (/unauthorized-domain/i.test(code)) {
      return `This site's domain isn't authorised. Add "${location.hostname}" in ` +
        "Firebase Console → Authentication → Settings → Authorized domains. " +
        "(localhost is allowed by default, which is why it works locally but not here.)";
    }

    if (/operation-not-allowed|configuration-not-found/i.test(code)) {
      return "Anonymous sign-in is switched off. Enable it in Firebase Console → " +
        "Authentication → Sign-in method → Anonymous. (GitHub sign-in is not used.)";
    }

    return `Sign-in failed (${code}).`;
  }

  return "Signed in and rules are readable — try reloading the page.";
}

// Settings -> Shared Card Library
async function refreshLibraryStatus() {
  if (!el.libraryStatus) return;

  const library = await getCardLibrary();
  if (!library) {
    el.libraryStatus.textContent =
      "Not connected — cards save to this browser only. Check the Firebase settings.";
    return;
  }

  try {
    const { cards, fetched } = await library.loadSharedCards();
    el.libraryStatus.textContent =
      `Connected — ${cards.length} shared card${cards.length === 1 ? "" : "s"}` +
      (fetched ? ` (${fetched} downloaded just now)` : " (all cached)");
  } catch (error) {
    console.warn(error);
    el.libraryStatus.textContent = "Not connected — checking why…";

    // Probe the database directly to say which of the three setup steps is
    // actually missing, instead of just repeating "Permission denied".
    const reason = await diagnoseSharedLibrary();
    el.libraryStatus.textContent =
      `Not connected. ${reason} Until then, cards save to this browser only.`;
  }
}

// Show how many cards this browser could put back, so the button isn't a
// mystery when there's nothing to restore.
async function refreshRestoreHint() {
  if (!el.restoreHint) return;

  const library = await getCardLibrary();
  if (!library) return;

  try {
    const missing = await library.findRecoverableCards();
    if (missing.length) {
      el.restoreHint.textContent =
        `${missing.length} card${missing.length === 1 ? "" : "s"} cached here are missing from the ` +
        `shared library: ${missing.map(c => c.name || c.cardNumber).join(", ")}. Restore puts them back.`;
    } else {
      el.restoreHint.textContent =
        "Nothing to restore — every card cached in this browser is already in the shared library.";
    }
  } catch (error) {
    console.warn(error);
  }
}

async function restoreCardsFromCache() {
  const library = await getCardLibrary();
  if (!library) {
    toast("Shared library unavailable");
    return;
  }

  const button = el.restoreCards;
  if (button) { button.disabled = true; button.textContent = "Restoring…"; }

  try {
    const { restored, cards } = await library.restoreCardsFromCache();
    toast(restored ? `Restored ${restored} card${restored === 1 ? "" : "s"}` : "Nothing to restore");
    if (restored) console.info("Restored:", cards);
    await refreshLibraryStatus();
    await refreshRestoreHint();
    await loadCardPool();
  } catch (error) {
    console.error(error);
    toast(`Restore failed: ${error.message}`);
  } finally {
    if (button) { button.disabled = false; button.textContent = "Restore"; }
  }
}

function readLocalProjectCards() {
  try {
    const cards = JSON.parse(localStorage.getItem(LOCAL_PROJECT_CARDS_KEY) || "[]");
    return Array.isArray(cards) ? cards : [];
  } catch {
    localStorage.removeItem(LOCAL_PROJECT_CARDS_KEY);
    return [];
  }
}

function readLocalProjectDeletions() {
  try {
    const keys = JSON.parse(localStorage.getItem(LOCAL_PROJECT_DELETIONS_KEY) || "[]");
    return new Set(Array.isArray(keys) ? keys : []);
  } catch {
    localStorage.removeItem(LOCAL_PROJECT_DELETIONS_KEY);
    return new Set();
  }
}

// Read just the shipped file, with no local layer applied.
async function loadShippedProjectCards() {
  try {
    const response = await fetch(`data/cards/custom-project-cards.json?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload) ? payload : Object.values(payload || {});
  } catch {
    return [];
  }
}

async function loadProjectCards() {
  const shipped = await loadShippedProjectCards();
  const merged = new Map();

  // Deletions come from two places: this browser's local layer (used when the
  // shared library is unreachable) and the shared tombstones. Both must be
  // honoured here - checking only the local set meant a deleted bundled card
  // stayed in this list, and the next save re-uploaded it and wiped its
  // tombstone. That's why deleted cards kept coming back.
  const deleted = readLocalProjectDeletions();

  const library = await getCardLibrary();
  let sharedCards = [];
  if (library) {
    try {
      const shared = await library.loadSharedCards();
      sharedCards = shared.cards;
      (shared.deleted || new Set()).forEach(key => deleted.add(key));
    } catch (error) {
      console.warn("Could not load shared cards:", error);
    }
  }

  // 1. Cards that ship with the repo are the baseline.
  shipped.forEach(card => {
    const key = projectCardKey(card);
    if (key && !deleted.has(key)) merged.set(key, card);
  });

  // 2. The shared Firebase library layers on top - this is what makes a card
  //    uploaded by one player visible to everyone, permanently.
  if (library) {
    try {
      let cards = sharedCards;

      // Publish any bundled card the library doesn't have yet. Runs on every
      // page load rather than only when the library is empty, so a fresh
      // deployment - or a repo update that adds new cards - lands in the shared
      // library with no button to press. Seeding skips cards that already exist
      // and cards someone deliberately deleted, so it's safe to repeat and safe
      // if several visitors load at once. The flag keeps it to one attempt per
      // page load.
      if (shipped.length && !sharedLibrarySeedAttempted) {
        sharedLibrarySeedAttempted = true;
        const seeded = await library.seedSharedCardsFrom(shipped);
        if (seeded) {
          console.info(`Published ${seeded} bundled card(s) to the shared library.`);
          ({ cards } = await library.loadSharedCards());
        }
      }

      cards.forEach(card => {
        const key = projectCardKey(card);
        if (key) merged.set(key, card);
      });
    } catch (error) {
      // Offline or misconfigured Firebase must not stop the app loading; the
      // shipped set plus anything cached locally still works.
      console.warn("Could not load shared cards:", error);
    }
  }

  // 3. Anything saved to this browser (used when Firebase is unreachable).
  readLocalProjectCards().forEach(card => {
    const key = projectCardKey(card);
    if (key) merged.set(key, card);
  });

  return [...merged.values()];
}

// Persist the full card set to this browser. Deletions are recorded separately:
// without them, removing a card that ships in the JSON file would just reappear
// on the next load.
async function saveProjectCardsLocally(cards) {
  const shipped = await loadShippedProjectCards();
  const keptKeys = new Set(cards.map(projectCardKey).filter(Boolean));
  const deletions = shipped
    .map(projectCardKey)
    .filter(key => key && !keptKeys.has(key));

  try {
    localStorage.setItem(LOCAL_PROJECT_CARDS_KEY, JSON.stringify(cards));
    localStorage.setItem(LOCAL_PROJECT_DELETIONS_KEY, JSON.stringify(deletions));
    return true;
  } catch (error) {
    console.error(error);
    toast("Browser storage is full. Delete some cards or use smaller images.");
    return false;
  }
}

function projectCardsToObject(cards) {
  return cards.reduce((result, card) => {
    const key = String(card.cardNumber || card.id || "").trim();
    if (!key) return result;
    const effects = dedupeEffects(card.effects || []);
    const effectKeys = new Set(effects.map(effectDedupeKey));
    const customEffectV2 = dedupeCustomEffectV2([], card.customEffectV2)
      .filter(effect => !effectKeys.has(effectDedupeKey(effect)));
    const effectBlocks = dedupeEffects(card.effectBlocks || []);
    result[key] = {
      ...card,
      id: card.id || key,
      cardNumber: card.cardNumber || key,
      effects,
      customEffectV2,
      effectBlocks,
      imported: card.imported !== false
    };
    return result;
  }, {});
}

// Publish ONE card. Saving used to hand the whole library to syncSharedCards,
// which diffed ~40 cards of base64 artwork on every save - slow enough that a
// card seemed not to appear until later, and it re-uploaded deleted cards that
// were still in the list (clearing their tombstones). Writing just the card
// being saved is instant and can't disturb anything else.
async function publishSingleCard(card) {
  const library = await getCardLibrary();

  if (library) {
    try {
      await library.saveSharedCard(card);
      localStorage.removeItem(LOCAL_PROJECT_CARDS_KEY);
      localStorage.removeItem(LOCAL_PROJECT_DELETIONS_KEY);
      return true;
    } catch (error) {
      console.warn("Shared card save failed, falling back:", error);
      if (!sharedLibraryWarned) {
        sharedLibraryWarned = true;
        toast("Saved to this browser only — shared library unreachable (see Settings)");
      }
    }
  }

  // No library (offline / static-only): keep the whole-list local fallback.
  const existing = (await loadProjectCards())
    .filter(other => projectCardKey(other) !== projectCardKey(card));
  return saveProjectCardsLocally([...existing, card]);
}

async function saveProjectCards(cards) {
  // Shared Firebase library first: this is the only store that persists for
  // EVERY player, and it works on static hosting where there's no backend.
  const library = await getCardLibrary();
  if (library) {
    try {
      const { uploaded, deleted } = await library.syncSharedCards(cards);
      if (uploaded || deleted) {
        toast(uploaded
          ? `Saved to the shared library — everyone can use ${uploaded === 1 ? "it" : "them"} now`
          : "Removed from the shared library");
      }
      // Clear any browser-only copies now that the real library has them.
      localStorage.removeItem(LOCAL_PROJECT_CARDS_KEY);
      localStorage.removeItem(LOCAL_PROJECT_DELETIONS_KEY);
      return true;
    } catch (error) {
      console.warn("Shared card save failed, falling back:", error);
      // Warn once per session, not on every save - the caller already toasts
      // "<card> saved", and two toasts per save was just noise.
      if (!sharedLibraryWarned) {
        sharedLibraryWarned = true;
        toast("Saved to this browser only — shared library unreachable (see Settings)");
      }
      return saveProjectCardsLocally(cards);
    }
  }

  // Skip the request entirely once we know there's no backend (static hosting).
  if (projectCardsApiAvailable === false) {
    const saved = await saveProjectCardsLocally(cards);
    if (saved) toast("Card saved to this browser");
    return saved;
  }

  try {
    const response = await fetch(PROJECT_CARDS_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(projectCardsToObject(cards))
    });

    // 404/405 means we're on static hosting with no API behind this path;
    // anything else is a genuine server-side failure worth surfacing.
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      projectCardsApiAvailable = false;
      const saved = await saveProjectCardsLocally(cards);
      if (saved) toast("Card saved to this browser");
      return saved;
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Server returned ${response.status}`);
    }

    projectCardsApiAvailable = true;
    return true;
  } catch (error) {
    // A thrown fetch is a network-level failure - on GitHub Pages the request
    // never reaches anything, so treat it the same as a missing API.
    if (error instanceof TypeError) {
      projectCardsApiAvailable = false;
      const saved = await saveProjectCardsLocally(cards);
      if (saved) toast("Card saved to this browser");
      return saved;
    }

    console.error(error);
    toast(`Save failed: ${error.message}`);
    return false;
  }
}

function nextImportedCardNumber(prefix = "JJBA") {
  const numbers = [
    ...state.cards,
    ...loadImportedCards()
  ]
    .map(card => String(card.cardNumber || ""))
    .map(number => number.match(new RegExp(`^${prefix}-(\\d+)$`, "i"))?.[1])
    .filter(Boolean)
    .map(Number);
  const next = numbers.length ? Math.max(...numbers) + 1 : 1;
  return `${prefix}-${String(next).padStart(3, "0")}`;
}

function updateImportStatus() {
  if (!el.importStatus) return;
  const importedCount = state.cards.filter(card => card.imported || card.needsCoding).length;
  el.importStatus.textContent = `Custom/project cards: ${importedCount}`;
}

function openCardImportDialog() {
  if (!el.cardImportDialog) return;
  if (!el.importCardNumber.value.trim()) {
    el.importCardNumber.value = nextImportedCardNumber();
  }
  updateImportStatus();
  el.cardImportDialog.showModal();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read image file."));
    reader.readAsDataURL(file);
  });
}

function loadImageSource(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // Needed so canvas pixel access (compression, OCR) works on remote images
    // from CORS-permitting hosts; ignored for data: URLs.
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load card image."));
    image.src = source;
  });
}

async function compressImageDataUrl(source) {
  if (!source?.startsWith("data:image/")) return source;
  try {
    const image = await loadImageSource(source);
    const scale = Math.min(
      1,
      IMPORT_IMAGE_MAX_WIDTH / image.naturalWidth,
      IMPORT_IMAGE_MAX_HEIGHT / image.naturalHeight
    );
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const compressed = canvas.toDataURL("image/webp", IMPORT_IMAGE_QUALITY);
    if (compressed.startsWith("data:image/webp") && compressed.length < source.length) {
      return compressed;
    }
    const jpeg = canvas.toDataURL("image/jpeg", IMPORT_IMAGE_QUALITY);
    return jpeg.length < source.length ? jpeg : source;
  } catch (error) {
    console.warn(error);
    return source;
  }
}

async function compressImportedCardImages(cards) {
  const compactCards = [];
  for (const card of cards) {
    if (String(card.image || "").startsWith("data:image/")) {
      compactCards.push({ ...card, image: await compressImageDataUrl(card.image) });
    } else {
      compactCards.push(card);
    }
  }
  return compactCards;
}

function csvValues(value) {
  return String(value || "")
    .split(/[,/]/)
    .map(part => part.trim())
    .filter(Boolean);
}

function setSelectValueWithFallback(select, value) {
  if (!select) return;
  const normalized = String(value ?? "");

  if (normalized && ![...select.options].some(option => option.value === normalized)) {
    const option = document.createElement("option");
    option.value = normalized;
    option.textContent = normalized;
    select.appendChild(option);
  }

  select.value = normalized;
}

const EFFECT_BRICKS = {
  attachRestedDon: {
    label: "Attach Rested DON!!",
    type: "activateMain",
    actionId: "attachRestedDonToLeaderOrCharacter",
    fields: [
      ["timing", "Timing", "select", "activateMain", [["activateMain", "Activate: Main"], ["onPlay", "On Play"], ["whenAttacking", "When Attacking"]]],
      ["amount", "Amount", "number", 1],
      ["target", "Target", "select", "leaderOrCharacter", [["leaderOrCharacter", "Leader or Character"], ["character", "Character only"]]],
      ["oncePerTurn", "Once per turn", "checkbox", true],
      ["optional", "Optional / up to", "checkbox", true]
    ]
  },
  searchTopDeck: {
    label: "Search Top Deck",
    type: "onPlay",
    actionId: "lookTopCards",
    fields: [
      ["timing", "Timing", "select", "onPlay", [["onPlay", "On Play"], ["main", "Main"], ["trigger", "Trigger"]]],
      ["look", "Look at top", "number", 5],
      ["add", "Add up to", "number", 1],
      ["typeText", "Type contains", "text", ""],
      ["maxCost", "Cost or less", "number", ""],
      ["destination", "Rest go to", "select", "bottomDeck", [["bottomDeck", "Bottom deck"], ["trash", "Trash"], ["life", "Life"]]],
      ["thenDraw", "Then draw 1", "checkbox", false]
    ]
  },
  drawCards: {
    label: "Draw Cards",
    type: "onPlay",
    actionId: "drawCards",
    fields: [
      ["timing", "Timing", "select", "onPlay", [["onPlay", "On Play"], ["main", "Main"], ["activateMain", "Activate: Main"], ["endOfYourTurn", "End of Your Turn"]]],
      ["amount", "Amount", "number", 1],
      ["requiredName", "Requires character name", "text", ""],
      ["requiredAttachedDon", "Requires attached DON!!", "number", ""]
    ]
  },
  powerBoost: {
    label: "Power Boost",
    type: "main",
    actionId: "powerBoost",
    fields: [
      ["timing", "Timing", "select", "main", [["main", "Main"], ["counter", "Counter"], ["trigger", "Trigger"], ["yourTurn", "Your Turn"]]],
      ["target", "Target", "select", "leaderOrCharacter", [["leaderOrCharacter", "Leader or Character"], ["charactersWithDon", "Characters with DON!!"], ["self", "This card"]]],
      ["power", "Power", "number", 1000],
      ["duration", "Duration", "select", "turn", [["turn", "This turn"], ["battle", "This battle"]]],
      ["requiredTokens", "DON!! x", "number", ""]
    ]
  },
  koOpponent: {
    label: "K.O. Opponent Character",
    type: "main",
    actionId: "koOpponentCharacterByPower",
    fields: [
      ["timing", "Timing", "select", "main", [["main", "Main"], ["trigger", "Trigger"], ["whenAttacking", "When Attacking"]]],
      ["maxPower", "Power or less", "number", ""],
      ["maxCost", "Cost or less", "number", ""],
      ["keyword", "Keyword", "text", ""]
    ]
  },
  restCard: {
    label: "Rest / Ready Cards",
    type: "main",
    actionId: "restOpponentCardThenSetOwnCostActive",
    fields: [
      ["timing", "Timing", "select", "main", [["main", "Main"], ["counter", "Counter"]]],
      ["restOpponent", "Rest opponent card", "checkbox", true],
      ["setOwnActive", "Set own card active", "checkbox", false],
      ["maxCost", "Own cost or less", "number", ""]
    ]
  },
  playNamedFromHand: {
    label: "Play Named From Hand",
    type: "onPlay",
    actionId: "restDonPlayNamedCharacterFromHand",
    fields: [
      ["timing", "Timing", "select", "onPlay", [["onPlay", "On Play"], ["main", "Main"], ["whenAttacking", "When Attacking"]]],
      ["requiredName", "Name", "text", ""],
      ["costActiveDon", "Rest DON!! cost", "number", 1]
    ]
  },
  trashNamedReadySelf: {
    label: "Trash Named, Ready Self",
    type: "whenAttacking",
    actionId: "trashOwnNamedCharacterSetSourceActive",
    fields: [
      ["timing", "Timing", "select", "whenAttacking", [["whenAttacking", "When Attacking"], ["activateMain", "Activate: Main"]]],
      ["requiredName", "Name to trash", "text", ""],
      ["oncePerTurn", "Once per turn", "checkbox", true]
    ]
  },
  activateEventFromHand: {
    label: "Activate Event From Hand",
    type: "whenAttacking",
    actionId: "activateHamonEventFromHandThenDraw",
    fields: [
      ["timing", "Timing", "select", "whenAttacking", [["whenAttacking", "When Attacking"], ["activateMain", "Activate: Main"]]],
      ["typeText", "Event type", "text", "Hamon"],
      ["thenDraw", "Then draw 1", "checkbox", true]
    ]
  }
};

function parseEffectTextToBlocks(effectText, cardNumber) {
  const text = String(effectText || "").trim();

  if (!text) {
    return {
      effects: [],
      validation: { valid: true, errors: [], warnings: [] }
    };
  }

  try {
    const result = window.CustomEffectV2?.parseAndValidate
      ? window.CustomEffectV2.parseAndValidate(text, { cardNumber })
      : window.EffectBlockValidator?.parseAndValidate(text, { cardNumber });

    if (!result) {
      return {
        effects: [],
        validation: { valid: true, errors: [], warnings: [] }
      };
    }

    return {
      effects: result.valid ? result.effects : result.effects,
      validation: result.validation
    };
  } catch (error) {
    return {
      effects: [],
      validation: {
        valid: false,
        errors: [error.message],
        warnings: []
      }
    };
  }
}

function initializeEffectBlockEditor() {
  // Effect block editor disabled - effects saved as plain text only
}


function creationBlockEffectsForSave(cardNumber) {
  return {
    effects: [],
    validation: { valid: true, errors: [], warnings: [] }
  };
}

function effectTimingText(effect) {
  if (isCustomEffectV2(effect)) {
    return window.CustomEffectV2?.labelForEvent?.(effect.event?.type) || effect.event?.type || "Effect";
  }

  return timingLabel(effect?.timing?.type || effect?.type);
}

function targetText(effect, targetId) {
  const target = effect?.targets?.find(item => item.id === targetId);
  if (!target) return targetId || "no target";

  const player = {
    self: "your",
    opponent: "opponent's",
    any: "any"
  }[target.controller] || target.controller;
  const zone = {
    leader: "Leader",
    opponentLeader: "Leader",
    characters: "Characters",
    leaderOrCharacters: "Leader or Characters",
    stage: "Stage",
    hand: "hand",
    trash: "trash",
    deck: "deck",
    deckTop: "top deck",
    board: "board cards",
    source: "this card",
    don: "DON!!",
    activeDon: "active DON!!",
    restedDon: "rested DON!!",
    life: "life"
  }[target.zone] || target.zone;
  const amount = target.count?.max
    ? `${target.optional ? "up to " : ""}${target.count.max} `
    : "";
  const filters = target.filters?.length
    ? ` (${target.filters.map(filter => `${filter.field} ${filter.operator} ${filter.value}`).join(", ")})`
    : "";

  return `${amount}${player} ${zone}${filters}`;
}

function costText(cost) {
  const labels = {
    donMinus: `DON!! -${cost.amount ?? 1}`,
    restDon: `Rest ${cost.amount ?? 1} DON!!`,
    restThisCard: "Rest this card",
    trashThisCard: "Trash this card",
    trashCardsFromHand: `Trash ${cost.amount ?? 1} card(s) from hand`,
    discardCards: `Discard ${cost.amount ?? 1} card(s)`,
    returnDon: `Return ${cost.amount ?? 1} DON!!`,
    trashLife: `Trash ${cost.amount ?? 1} life`
  };

  return labels[cost.type] || cost.type;
}

function actionText(effect, action) {
  const target = isCustomEffectV2(effect)
    ? friendlyV2TargetText(effect, action.target)
    : targetText(effect, action.target);
  const duration = {
    untilEndOfTurn: "this turn",
    untilOpponentNextTurn: "opponent's next turn",
    duringBattle: "this battle",
    permanent: "the game"
  }[action.duration] || action.duration || "turn";
  const labels = {
    draw: `Draw ${action.amount ?? 1} card(s)`,
    ko: `K.O. ${target}`,
    rest: `Rest ${target}`,
    setActive: `Set ${target} active`,
    modifyPower: `Give ${target} ${Number(action.amount || 0) >= 0 ? "+" : ""}${action.amount ?? 0} power during ${duration}`,
    setPower: `Set ${target} power to ${action.amount ?? 0}${action.duration === "permanent" ? "" : ` during ${duration}`}`,
    giveKeyword: `Give ${target} ${action.keyword || "keyword"} during ${duration}`,
    addStatus: `Give ${target} ${statusText(action.status)} during ${duration}`,
    preventEvent: "Prevent the current event",
    addRestedDon: `Add ${action.amount ?? 1} rested DON!!`,
    setDonActive: `Set ${action.amount ?? 1} DON!! active`,
    returnDon: `Return ${action.amount ?? 1} DON!!`,
    chooseOne: `Choose one mode (${Array.isArray(action.options) ? action.options.length : 0} option(s))`,
    playFromHand: `Play ${target} from hand`,
    playFromTrash: `Play ${target} from trash`,
    playThisCard: "Play this card",
    addThisCardToHand: "Add this card to hand",
    activateMainEffect: "Activate this card's Main effect",
    trashTopDeck: `Trash top ${action.amount ?? 1} card(s) of deck`,
    trashSelectedHand: `Trash ${target} from hand`,
    opponentPlaceHandBottomDeck: `Place ${action.amount ?? 1} opponent hand card(s) on bottom deck`,
    addTrashToBottomDeck: `Put ${action.amount ?? 1} trash card(s) on bottom deck`,
    searchTopDeck: `Look at top ${action.amount ?? 1} card(s) of deck; choose ${target} to ${searchDestinationText(action.selectedDestination || "hand")}; rest to ${searchDestinationText(action.restDestination || "bottomDeck")}`,
    reveal: `Reveal ${target}`,
    addToHand: `Add ${target} to hand`,
    putRestBottomDeck: "Put the remaining cards on bottom deck",
    putRestTrash: "Put the remaining cards in trash",
    trashOpponentLife: `Trash ${action.amount ?? 1} opponent life`,
    healLife: `Add ${action.amount ?? 1} life`,
    trashThisCard: "Trash this card",
    bounceToHand: `Return ${target} to hand`,
    placeBottomDeck: `Place ${target} on bottom deck`,
    placeTrashBottomDeckSelected: `Place ${target} on bottom deck`,
    attachRestedDon: `Attach up to ${action.amount ?? 1} rested DON!! to ${target}`,
    playSelected: `Play ${target}`
  };

  const label = labels[action.type] || action.type;
  const conditions = Array.isArray(action.conditions) && action.conditions.length
    ? ` if ${action.conditions.map(conditionText).join(" and ")}`
    : "";

  return `${label}${conditions}`;
}

function statusText(status) {
  const labels = {
    cannotAttackLeader: "cannot attack leaders",
    cannotAttack: "cannot attack",
    cannotBlock: "cannot block",
    cannotBecomeActive: "cannot become active",
    cannotBeRested: "cannot be rested"
  };

  return labels[status] || status || "a restriction";
}

function searchDestinationText(destination) {
  return {
    hand: "hand",
    characterField: "field",
    trash: "trash",
    bottomDeck: "bottom deck",
    topDeck: "top deck",
    life: "life"
  }[destination] || destination || "hand";
}

function conditionText(condition = {}) {
  if (condition.type === "controlCardName") {
    return `you control ${condition.value}`;
  }

  if (condition.type === "leaderNameEquals") {
    return `your Leader is exactly ${condition.value}`;
  }

  if (condition.type === "leaderNameIncludes") {
    return `your Leader name includes ${condition.value}`;
  }

  if (condition.type === "selfControlsCharacterPower") {
    return `you control a Character with power ${condition.operator || ">="} ${condition.value}`;
  }

  if (condition.type === "opponentControlsCharacterPower") {
    return `opponent controls a Character with power ${condition.operator || ">="} ${condition.value}`;
  }

  const controller = condition.controller === "opponent" ? "opponent" : "you";
  const value = condition.value ?? condition.amount ?? "";
  const operator = condition.operator ? ` ${condition.operator}` : "";

  return `${controller} ${condition.field || condition.type}${operator}${value !== "" ? ` ${value}` : ""}`;
}

function friendlyV2TargetText(effect, targetId) {
  if (!targetId) return "no target";

  const selectionTarget = effect?.targets?.find(target => target.id === targetId);

  if (selectionTarget) {
    return window.CustomEffectV2?.labelForSelectionTarget?.(selectionTarget) || selectionTarget.label || "chosen card";
  }

  return window.CustomEffectV2?.labelForTarget?.(targetId) || targetId;
}

function v2EventDetailsText(effect) {
  if (effect?.event?.type !== "wouldBeKOd") return "";

  const target = effect.event.target || { controller: "self", zone: "characters" };
  const controller = {
    self: "your",
    opponent: "opponent's",
    any: "any"
  }[target.controller] || target.controller || "your";
  const zone = {
    characters: "Characters",
    leader: "Leader",
    leaderOrCharacters: "Leader or Characters",
    stage: "Stage",
    board: "board cards"
  }[target.zone] || target.zone || "Characters";
  const cause = {
    cardEffect: "by a card effect",
    battle: "by battle",
    any: "by any cause"
  }[effect.event.sourceType] || "by a card effect";

  return `Replaces: ${controller} ${zone} would be K.O.'d ${cause}`;
}


function importedCardFromForm(imageDataUrl) {
  const cardNumber = el.importCardNumber.value.trim() || nextImportedCardNumber();
  const category = normalizeCategory(el.importCategory.value);
  const effectText = el.importEffectText.value.trim();
  const parsedBlocks = parseEffectTextToBlocks(effectText, cardNumber);
  const colors = csvValues(el.importColors.value).map(color => color.toLowerCase());
  const keywords = csvValues(el.importKeywords.value);
  const costOrLife = el.importCost.value === "" ? "" : Number(el.importCost.value);
  const customEffectV2 = parsedBlocks.effects.filter(isCustomEffectV2);
  const oldEffectBlocks = parsedBlocks.effects.filter(isBlockEffect);

  return {
    id: cardNumber,
    cardNumber,
    name: el.importName.value.trim(),
    category,
    cardType: category,
    type: el.importTypes.value.trim(),
    color: colors.join(","),
    colors,
    cost: category === "leader" ? "" : costOrLife,
    life: category === "leader" ? costOrLife : "",
    power: el.importPower.value === "" ? "" : Number(el.importPower.value),
    counter: el.importCounter.value === "" ? "" : Number(el.importCounter.value),
    attribute: el.importAttribute.value.trim(),
    rarity: el.importRarity.value.trim(),
    keywords,
    effects: parsedBlocks.validation.valid && parsedBlocks.effects.length
      ? parsedBlocks.effects
      : effectText
        ? [{ id: `${cardNumber}-text`, type: "text", text: effectText }]
        : [],
    effect: effectText,
    customEffectV2: parsedBlocks.validation.valid ? customEffectV2 : [],
    effectBlocks: parsedBlocks.validation.valid ? oldEffectBlocks : [],
    image: imageDataUrl,
    importedAt: new Date().toISOString(),
    imported: true,
    needsCoding: true
  };
}

function initializeCardCreation() {
  if (el.creationCardNumber && !el.creationCardNumber.value.trim()) {
    el.creationCardNumber.value = nextImportedCardNumber();
  }
}



function timingLabel(timing) {
  return {
    onPlay: "On Play",
    main: "Main",
    activateMain: "Activate: Main",
    whenAttacking: "When Attacking",
    counter: "Counter",
    trigger: "Trigger",
    yourTurn: "Your Turn",
    endOfYourTurn: "End of Your Turn"
  }[timing] || "Effect";
}

const CARD_SCRIPT_EVENTS = {
  on_play: "onPlay",
  main: "main",
  activate_main: "activateMain",
  when_attacking: "whenAttacking",
  counter: "counter",
  trigger: "trigger",
  your_turn: "yourTurn",
  end_of_your_turn: "endOfYourTurn"
};


function quotedValue(command, keyword) {
  const pattern = new RegExp(`(?:^|\\s)${keyword}\\s+"([^"]+)"`, "i");
  return (command.match(pattern) || [])[1] || "";
}

function numberAfter(command, keyword, fallback = "") {
  const pattern = new RegExp(`${keyword}\\s*(\\d+)`, "i");
  const value = (command.match(pattern) || [])[1];
  return value === undefined ? fallback : Number(value);
}

function unquotedToken(command, keyword) {
  const pattern = new RegExp(`(?:^|\\s)${keyword}\\s+([^\\s]+)`, "i");
  return (command.match(pattern) || [])[1] || "";
}

function expandFriendlyCardScript(script) {
  const lines = String(script || "").split(/\r?\n/);
  const output = [];
  let friendlyBlock = null;

  const flushFriendlyBlock = () => {
    if (!friendlyBlock) return;
    output.push(...translateFriendlyBlock(friendlyBlock.type, friendlyBlock.lines));
    friendlyBlock = null;
  };

  lines.forEach(rawLine => {
    const line = rawLine.trim();
    const eventMatch = line.match(/^([a-z_]+)(?:\s+([^:]+))?:\s*$/i);
    const friendlyLabel = line.match(/^([a-z ]+):\s*$/i);

    if (eventMatch && CARD_SCRIPT_EVENTS[eventMatch[1]]) {
      flushFriendlyBlock();
      output.push(rawLine);
      return;
    }

    if (friendlyLabel) {
      const label = friendlyLabel[1].toLowerCase().replace(/\s+/g, "_");
      const blockType = {
        search: "search",
        set_don_active: "setDonActive",
        set_active_don: "setDonActive",
        rest_don_cost: "restDonCost",
        cannot_play: "cannotPlay",
        attach_rested_don: "attachRestedDon",
        give_keyword: "giveKeyword",
        trash_from_hand: "trashFromHand",
        place_opponent_card: "placeOpponentCard",
        if_no_card_played: "ifNoCardPlayed",
        play_from_hand: "playFromHand",
        draw: "draw",
        power: "power",
        ko: "ko",
        rest: "rest",
        play: "play",
        use_event: "useEvent",
        activate_event: "useEvent",
        return: "return",
        trash_named: "trashNamed",
        trash_self: "trashSelf",
        ready_self: "readySelf",
        ready: "ready"
      }[label];

      if (blockType) {
        flushFriendlyBlock();
        friendlyBlock = { type: blockType, lines: [] };
        return;
      }
    }

    if (friendlyBlock) {
      friendlyBlock.lines.push(line);
      return;
    }

    output.push(rawLine);
  });

  flushFriendlyBlock();
  return output.join("\n");
}

function translateFriendlyBlock(type, lines) {
  const text = lines.join(" ");
  const lower = text.toLowerCase();

  if (type === "search") {
    const top = (text.match(/\btop\s+(\d+)/i) || [])[1] || 5;
    const reveal = text.match(/\breveal\s+(?:(up\s*to|up_to)\s+)?(\d+)/i);
    const add = text.match(/\badd\s+(?:(up\s*to|up_to)\s+)?(\d+)/i);
    const addAmount = (reveal || add || [])[2] || 1;
    const addMode = (reveal?.[1] || add?.[1]) ? "add_up_to" : "add";
    const toLine = lines.find(line => /\bto field\b/i.test(line) || /\bto\s+(hand|life|trash|character field|character_field|field|play)\b/i.test(line)) || "";
    const restLine = lines.find(line => /\bsend rest to\b/i.test(line) || /\brest_to\b/i.test(line)) || "";
    const toField = (toLine.match(/\bto field\s*:?\s*([a-z_ ]+)/i) || toLine.match(/\bto\s+(hand|life|trash|character field|character_field|field|play)/i) || [])[1] || "hand";
    const restTo = (restLine.match(/\bsend rest to\s+([a-z_]+)/i) || restLine.match(/\brest_to\s+([a-z_]+)/i) || [])[1] || "bottom_deck";
    const filters = searchFilterCommandParts(text).join(" ");
    const grantKeyword = (text.match(/\bgains?\s+([a-z ]+?)(?=\s|$)/i) || [])[1];
    return [`  search_top ${top} ${addMode} ${addAmount}${filters ? ` ${filters}` : ""} to ${toField.trim().replace(/\s+/g, "_")}${grantKeyword ? ` grant_keyword "${grantKeyword.trim()}"` : ""} rest_to ${restTo.trim().replace(/\s+/g, "_")}`];
  }

  if (type === "setDonActive") {
    return [`  set_active_don up_to ${Number((text.match(/(\d+)/) || [])[1] || 1)}`];
  }

  if (type === "cannotPlay") {
    const cardType = lower.includes("event")
      ? "event"
      : lower.includes("stage")
        ? "stage"
        : lower.includes("leader")
          ? "leader"
          : "character";
    return [`  lock_play ${cardType} this_turn`];
  }

  if (type === "restDonCost") {
    return [`  rest_don_cost ${Number((text.match(/(\d+)/) || [])[1] || 1)}`];
  }

  if (type === "attachRestedDon") {
    const amount = Number((text.match(/(?:up\s*to|up_to|exactly)?\s*(\d+)/i) || [])[1] || 1);
    const target = lower.includes("characters") && !lower.includes("leader")
      ? "characters"
      : lower.includes("character") && !lower.includes("leader")
        ? "character"
        : "leader_or_character";
    return [`  attach_rested_don up_to ${amount} to ${target}`];
  }

  if (type === "giveKeyword") {
    const keyword = (text.match(/\bkeyword\s+["{[]?([^"\]}]+)["}\]]?/i) || text.match(/\b(unblockable|rush|blocker|double attack|banish)\b/i) || [])[1] || "unblockable";
    const target = lower.includes("opponent")
      ? "opponent_card"
      : lower.includes("leader") && !lower.includes("character")
        ? "leader"
        : "own_card";
    const duration = lower.includes("battle") ? "battle" : "turn";
    return [`  give_keyword target ${target} keyword "${keyword.trim()}" duration ${duration}`];
  }

  if (type === "trashFromHand") {
    return [`  trash_from_hand ${Number((text.match(/(\d+)/) || [])[1] || 1)}`];
  }

  if (type === "placeOpponentCard") {
    const filters = searchFilterCommandParts(text).join(" ");
    const destination = lower.includes("top_or_bottom") || lower.includes("top or bottom")
      ? "top_or_bottom_deck"
      : lower.includes("top")
        ? "top_deck"
        : "bottom_deck";
    return [`  place_opponent_card${filters ? ` ${filters}` : ""} to ${destination}`];
  }

  if (type === "ifNoCardPlayed") {
    return ["  if_no_card_played"];
  }

  if (type === "playFromHand") {
    const amount = (text.match(/(?:up\s*to|up_to)?\s*(\d+)/i) || [])[1] || 1;
    const filters = searchFilterCommandParts(text).join(" ");
    const toLine = lines.find(line => /\bto\s+(hand|life|trash|character field|character_field|field|play)\b/i.test(line)) || "";
    const toField = (toLine.match(/\bto\s+(hand|life|trash|character field|character_field|field|play)/i) || [])[1] || "character_field";
    return [`  play_from_hand up_to ${amount}${filters ? ` ${filters}` : ""} to ${toField.trim().replace(/\s+/g, "_")}`];
  }

  if (type === "draw") {
    return [`  draw ${Number((text.match(/(\d+)/) || [])[1] || 1)}`];
  }

  if (type === "power") {
    const power = (text.match(/[+＋]\s*(\d+)/) || [])[1] || (text.match(/(\d+)\s*power/i) || [])[1] || 1000;
    const duration = lower.includes("battle") ? "battle" : "turn";
    const target = lower.includes("target leader") && !lower.includes("character")
      ? "leader"
      : "leader_or_character";
    return [`  power target ${target} +${power} duration ${duration}`];
  }

  if (type === "ko") {
    const filters = searchFilterCommandParts(text).join(" ");
    return [`  ko_opponent${filters ? ` ${filters}` : ""}`];
  }

  if (type === "rest") {
    return ["  rest_opponent card"];
  }

  if (type === "ready") {
    const cost = (text.match(/cost\s*(?:<=|or less|less than or equal to)?\s*(\d+)/i) || [])[1] || "";
    return [`  set_own_active${cost ? ` cost_or_less ${cost}` : ""}`];
  }

  if (type === "play") {
    const name = (text.match(/\[([^\]]+)\]/) || text.match(/"([^"]+)"/) || [])[1] || "Card Name";
    const restDon = (text.match(/rest\s+(\d+)\s+don/i) || [])[1] || 0;
    return [`  play_named "${name}" from hand rest_don ${restDon}`];
  }

  if (type === "useEvent") {
    const eventType = (text.match(/\{([^}]+)\}/) || text.match(/"([^"]+)"/) || [])[1] || "Hamon";
    return [`  activate_event_type "${eventType}" from hand${lower.includes("draw") ? " then_draw" : ""}`];
  }

  if (type === "return") {
    const cost = (text.match(/cost\s*(?:<=|or less|less than or equal to)?\s*(\d+)/i) || [])[1] || 3;
    return [`  return_opponent_character cost_or_less ${cost}`];
  }

  if (type === "trashNamed") {
    const name = (text.match(/\[([^\]]+)\]/) || text.match(/"([^"]+)"/) || [])[1] || "Card Name";
    return [`  trash_named "${name}"`];
  }

  if (type === "trashSelf") {
    return ["  trash_self"];
  }

  if (type === "readySelf") {
    return ["  ready_self"];
  }

  return lines.map(line => `  ${line}`);
}

function searchFilterCommandParts(text) {
  const parts = [];
  const quote = value => `"${String(value).replace(/"/g, "")}"`;
  const filterPatterns = [
    ["type", /\b(?:type|subtype)\s+(?:includes?|=|is)?\s*["{[]([^"}\]]+)["}\]]/ig],
    ["type", /\b(?:type|subtype)\s+(?:includes?|=|is)?\s*([a-z][a-z0-9 /-]*?)(?=\s+(?:cost|power|counter|life|color|card type|card_type|category|name|rarity|set|attribute|keyword)\b|$)/ig],
    ["color", /\bcolor\s+(?:=|is)?\s*"?([a-z]+)"?/ig],
    ["card_type", /\b(?:card type|card_type|category)\s+(?:=|is)?\s*"?([a-z]+)"?/ig],
    ["attribute", /\battribute\s+(?:=|is)?\s*"?([a-z]+)"?/ig],
    ["keyword", /\bkeyword\s+(?:includes?|=|is)?\s*"?([a-z ]+?)"?(?=\s+(?:cost|power|counter|color|type|card|name|rarity|set|attribute)\b|$)/ig],
    ["name", /\bname\s+(?:includes?|=|is)?\s*["[]([^"\]]+)["\]]/ig],
    ["name_not", /\bname\s+(?:not|!=|other than)\s*["[]([^"\]]+)["\]]/ig],
    ["rarity", /\brarity\s+(?:=|is)?\s*"?([a-z]+)"?/ig],
    ["set", /\bset\s+(?:=|is)?\s*"?([a-z0-9-]+)"?/ig]
  ];

  filterPatterns.forEach(([key, pattern]) => {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      parts.push(`${key} ${quote(match[1].trim())}`);
    }
  });

  [
    ["cost_or_less", /\bcost\s*(?:<=|≤|or less|less than or equal to)\s*(\d+)/i],
    ["cost_at_least", /\bcost\s*(?:>=|≥|or more|at least)\s*(\d+)/i],
    ["power_or_less", /\bpower\s*(?:<=|≤|or less|less than or equal to)\s*(\d+)/i],
    ["power_at_least", /\bpower\s*(?:>=|≥|or more|at least)\s*(\d+)/i],
    ["counter_or_less", /\bcounter\s*(?:<=|≤|or less|less than or equal to)\s*(\d+)/i],
    ["counter_at_least", /\bcounter\s*(?:>=|≥|or more|at least)\s*(\d+)/i],
    ["life_or_less", /\blife\s*(?:<=|≤|or less|less than or equal to)\s*(\d+)/i],
    ["life_at_least", /\blife\s*(?:>=|≥|or more|at least)\s*(\d+)/i]
  ].forEach(([key, pattern]) => {
    const value = (text.match(pattern) || [])[1];
    if (value !== undefined) parts.push(`${key} ${value}`);
  });

  if (/\bno counter\b|\bwithout counter\b/i.test(text)) parts.push("counter 0");
  return parts;
}

function parseSearchCommand(command) {
  const quoted = key => quotedValue(command, key) || unquotedToken(command, key);

  return {
    amount: numberAfter(command, "search_top", 5),
    add: numberAfter(command, "add_up_to", numberAfter(command, "add", 1)),
    typeText: quoted("type"),
    color: quoted("color"),
    cardTypeFilter: quoted("card_type"),
    attributeFilter: quoted("attribute"),
    keyword: quoted("keyword"),
    nameIncludes: quoted("name"),
    nameNot: quoted("name_not"),
    rarityFilter: quoted("rarity"),
    setFilter: quoted("set"),
    grantKeyword: quoted("grant_keyword"),
    maxCost: numberAfter(command, "cost_or_less", ""),
    minCost: numberAfter(command, "cost_at_least", ""),
    maxPower: numberAfter(command, "power_or_less", ""),
    minPower: numberAfter(command, "power_at_least", ""),
    maxCounter: numberAfter(command, "counter_or_less", ""),
    minCounter: numberAfter(command, "counter_at_least", ""),
    exactCounter: numberAfter(command, "\\bcounter", ""),
    maxLife: numberAfter(command, "life_or_less", ""),
    minLife: numberAfter(command, "life_at_least", ""),
    toField: quoted("to") || unquotedToken(command, "to") || "hand",
    destination: quoted("rest_to") || unquotedToken(command, "rest_to") || "bottomDeck"
  };
}

function parseRestDonCostCommand(command) {
  return Math.max(0, Number((String(command || "").match(/rest_don_cost\s+(\d+)/i) || [])[1] || 0));
}

function parseGiveKeywordCommand(command) {
  return {
    target: unquotedToken(command, "target") || "own_card",
    keyword: quotedValue(command, "keyword") || unquotedToken(command, "keyword") || "unblockable",
    duration: unquotedToken(command, "duration") || "turn"
  };
}

function parseTrashFromHandCommand(command) {
  return Math.max(1, Number((String(command || "").match(/trash_from_hand\s+(\d+)/i) || [])[1] || 1));
}

function parsePlaceOpponentCardCommand(command) {
  const filters = parseSearchCommand(`search_top 0 add 1 ${String(command || "").replace(/^place_opponent_card\s*/i, "")}`);

  return {
    ...filters,
    destination: unquotedToken(command, "to") || quotedValue(command, "to") || "bottom_deck"
  };
}

function parsePlayFromHandCommand(command) {
  const search = parseSearchCommand(`search_top 0 add ${numberAfter(command, "up_to", 1)} ${String(command || "").replace(/^play_from_hand\s*/i, "")}`);

  return {
    ...search,
    amount: numberAfter(command, "up_to", 1),
    toField: unquotedToken(command, "to") || quotedValue(command, "to") || "character_field"
  };
}

function parseCardScript(script, cardNumber) {
  const lines = expandFriendlyCardScript(script).split(/\r?\n/);
  const blocks = [];
  const errors = [];
  let current = null;

  const finishBlock = () => {
    if (current) blocks.push(current);
  };

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;

    const eventMatch = line.match(/^([a-z_]+)(?:\s+([^:]+))?:\s*$/i);
    if (eventMatch && CARD_SCRIPT_EVENTS[eventMatch[1]]) {
      finishBlock();
      current = {
        eventKey: eventMatch[1],
        type: CARD_SCRIPT_EVENTS[eventMatch[1]],
        modifiers: String(eventMatch[2] || "").toLowerCase(),
        commands: []
      };
      return;
    }

    if (!current) {
      errors.push(`Line ${index + 1}: start with an event block like on_play:`);
      return;
    }

    current.commands.push(line);
  });

  finishBlock();

  if (!blocks.length && String(script || "").trim()) {
    errors.push("No event blocks found. Try on_play:, main:, activate_main:, or when_attacking:.");
  }

  const effects = blocks.flatMap((block, index) => {
    const effect = effectFromScriptBlock(block, cardNumber, index, errors);
    return Array.isArray(effect) ? effect : [effect];
  });
  return { effects: effects.filter(Boolean), errors };
}

function scriptBlockText(block) {
  const label = timingLabel(block.type);
  return `${label}${block.modifiers.includes("once_per_turn") ? " Once Per Turn" : ""}: ${block.commands.join(" Then, ")}`;
}

function effectFromScriptBlock(block, cardNumber, index, errors) {
  const commands = block.commands.map(command => command.toLowerCase());
  const rawCommands = block.commands;
  const base = {
    id: `${cardNumber}-script-${index + 1}`,
    type: block.type,
    text: scriptBlockText(block),
    oncePerTurn: block.modifiers.includes("once_per_turn")
  };

  const setDonCommand = rawCommands.find(command => /^set_active_don\b/i.test(command));
  const attachCommand = rawCommands.find(command => /^attach_rested_don\b/i.test(command));
  const searchCommand = rawCommands.find(command => /^search_top\b/i.test(command));
  const drawCommand = rawCommands.find(command => /^draw\b/i.test(command));
  const lockCommand = rawCommands.find(command => /^lock_play\b/i.test(command));
  const playNamedCommand = rawCommands.find(command => /^play_named\b/i.test(command));
  const activateEventCommand = rawCommands.find(command => /^activate_event_type\b/i.test(command));
  const trashNamedCommand = rawCommands.find(command => /^trash_named\b/i.test(command));
  const trashSelfCommand = rawCommands.find(command => /^trash_self\b/i.test(command));
  const readySelfCommand = rawCommands.find(command => /^ready_self\b/i.test(command));
  const koCommand = rawCommands.find(command => /^ko_opponent\b/i.test(command));
  const restCommand = rawCommands.find(command => /^rest_opponent\b/i.test(command));
  const powerCommand = rawCommands.find(command => /^power\b/i.test(command));
  const returnCommand = rawCommands.find(command => /^return_opponent_character\b/i.test(command));
  const setOwnActiveCommand = rawCommands.find(command => /^set_own_active\b/i.test(command));
  const restDonCostCommand = rawCommands.find(command => /^rest_don_cost\b/i.test(command));
  const giveKeywordCommand = rawCommands.find(command => /^give_keyword\b/i.test(command));
  const trashFromHandCommand = rawCommands.find(command => /^trash_from_hand\b/i.test(command));
  const placeOpponentCardCommand = rawCommands.find(command => /^place_opponent_card\b/i.test(command));
  const ifNoCardPlayedCommand = rawCommands.find(command => /^if_no_card_played\b/i.test(command));
  const playFromHandCommand = rawCommands.find(command => /^play_from_hand\b/i.test(command));

  if (drawCommand && searchCommand) {
    const drawIndex = rawCommands.indexOf(drawCommand);
    const searchIndex = rawCommands.indexOf(searchCommand);
    const drawEffect = {
      ...base,
      id: `${base.id}-draw`,
      text: `${timingLabel(block.type)}: ${drawCommand}`,
      actionId: "drawCards",
      amount: numberAfter(drawCommand, "draw", 1)
    };
    const searchBlock = {
      ...block,
      commands: rawCommands.filter(command => command !== drawCommand)
    };
    const searchEffect = effectFromScriptBlock(searchBlock, cardNumber, `${index + 1}-search`, errors);
    const ordered = drawIndex < searchIndex
      ? [drawEffect, searchEffect]
      : [searchEffect, drawEffect];

    return ordered.filter(Boolean);
  }

  if (setDonCommand && lockCommand) {
    return {
      ...base,
      actionId: "setActiveDonThenLockCardType",
      amount: numberAfter(setDonCommand, "up_to", 1),
      lockCardType: lockCommand.toLowerCase().includes("event")
        ? "event"
        : lockCommand.toLowerCase().includes("stage")
          ? "stage"
          : "character"
    };
  }

  if (trashSelfCommand && restCommand) {
    return {
      ...base,
      actionId: "trashSelfThenRestOpponentCard"
    };
  }

  if (trashSelfCommand) {
    return {
      ...base,
      actionId: "trashSelf"
    };
  }

  if (searchCommand && ifNoCardPlayedCommand && playFromHandCommand) {
    const search = parseSearchCommand(searchCommand);
    const fallback = parsePlayFromHandCommand(playFromHandCommand);

    return {
      ...base,
      actionId: "searchPlayOrPlayFromHand",
      ...search,
      fallbackTypeText: fallback.typeText,
      fallbackColor: fallback.color,
      fallbackCardTypeFilter: fallback.cardTypeFilter || "character",
      fallbackAttributeFilter: fallback.attributeFilter,
      fallbackKeyword: fallback.keyword,
      fallbackNameIncludes: fallback.nameIncludes,
      fallbackNameNot: fallback.nameNot,
      fallbackMaxCost: fallback.maxCost,
      fallbackMinCost: fallback.minCost,
      fallbackToField: fallback.toField,
      fallbackAmount: fallback.amount
    };
  }

  if (restDonCostCommand && giveKeywordCommand) {
    const keywordEffect = parseGiveKeywordCommand(giveKeywordCommand);

    return {
      ...base,
      actionId: "restDonGiveKeyword",
      costActiveDon: parseRestDonCostCommand(restDonCostCommand),
      ...keywordEffect
    };
  }

  if (trashFromHandCommand && powerCommand) {
    return {
      ...base,
      actionId: "trashHandThenPower",
      trashCount: parseTrashFromHandCommand(trashFromHandCommand),
      powerModifier: numberAfter(powerCommand, "\\+", 1000),
      target: unquotedToken(powerCommand, "target") || "leader_or_character",
      duration: unquotedToken(powerCommand, "duration") || (block.type === "counter" ? "battle" : "turn")
    };
  }

  if (restDonCostCommand && placeOpponentCardCommand) {
    const place = parsePlaceOpponentCardCommand(placeOpponentCardCommand);

    return {
      ...base,
      actionId: "restDonPlaceOpponentCardOnDeck",
      costActiveDon: parseRestDonCostCommand(restDonCostCommand),
      ...place
    };
  }

  if (setDonCommand) {
    return {
      ...base,
      actionId: "setActiveDon",
      amount: numberAfter(setDonCommand, "up_to", 1)
    };
  }

  if (attachCommand) {
    const amount = numberAfter(attachCommand, "up_to", numberAfter(attachCommand, "exactly", 1));
    const toCharacters = attachCommand.toLowerCase().includes("to characters");
    if (toCharacters && drawCommand) {
      return {
        ...base,
        actionId: "attachRestedDonToCharactersThenDraw",
        amount
      };
    }

    return {
      ...base,
      actionId: "attachRestedDonToLeaderOrCharacter",
      amount,
      optional: attachCommand.toLowerCase().includes("up_to")
    };
  }

  if (searchCommand) {
    const search = parseSearchCommand(searchCommand);

    return {
      ...base,
      actionId: drawCommand ? "lookTopFiveTypeThenDrawOne" : "lookTopFiveTypeAddOne",
      ...search
    };
  }

  if (playNamedCommand) {
    return {
      ...base,
      actionId: "restDonPlayNamedCharacterFromHand",
      requiredName: quotedValue(playNamedCommand, "play_named"),
      costActiveDon: numberAfter(playNamedCommand, "rest_don", 1),
      optional: true
    };
  }

  if (activateEventCommand) {
    return {
      ...base,
      actionId: "activateHamonEventFromHandThenDraw",
      typeText: quotedValue(activateEventCommand, "activate_event_type") || "Hamon",
      optional: true
    };
  }

  if (trashNamedCommand && readySelfCommand) {
    return {
      ...base,
      actionId: "trashOwnNamedCharacterSetSourceActive",
      requiredName: quotedValue(trashNamedCommand, "trash_named")
    };
  }

  if (powerCommand && returnCommand) {
    return {
      ...base,
      actionId: "turnPowerThenBounceCostCharacter",
      powerModifier: numberAfter(powerCommand, "\\+", 3000),
      maxCost: numberAfter(returnCommand, "cost_or_less", 3)
    };
  }

  if (restCommand && setOwnActiveCommand) {
    return {
      ...base,
      actionId: "restOpponentCardThenSetOwnCostActive",
      maxCost: numberAfter(setOwnActiveCommand, "cost_or_less", 5)
    };
  }

  if (restCommand) {
    return {
      ...base,
      actionId: "restOpponentCard"
    };
  }

  if (koCommand) {
    const maxCost = numberAfter(koCommand, "cost_or_less", "");
    const maxPower = numberAfter(koCommand, "power_or_less", "");
    return {
      ...base,
      actionId: maxCost !== "" ? "koOpponentCharacterByCostAndKeyword" : "koOpponentCharacterByPower",
      maxCost,
      maxPower,
      keyword: quotedValue(koCommand, "keyword")
    };
  }

  if (drawCommand) {
    return {
      ...base,
      actionId: "drawCards",
      amount: numberAfter(drawCommand, "draw", 1)
    };
  }

  if (powerCommand) {
    return {
      ...base,
      actionId: block.type === "counter" ? "leaderOrCharacterCounterPower" : "leaderOrCharacterTriggerPower",
      powerModifier: numberAfter(powerCommand, "\\+", 1000)
    };
  }

  errors.push(`${timingLabel(block.type)} has commands I can save as text, but cannot play yet: ${rawCommands.join(", ")}`);
  return {
    ...base
  };
}


function suggestCardScriptFromText(text) {
  const lower = String(text || "").toLowerCase();
  const lines = [];
  const event = lower.includes("when attacking")
    ? "when_attacking once_per_turn:"
    : lower.includes("activate:main") || lower.includes("activate: main")
      ? "activate_main once_per_turn:"
      : lower.includes("counter")
        ? "counter:"
        : lower.includes("main")
          ? "main:"
          : "on_play:";

  lines.push(event);

  if (lower.includes("set up to") && lower.includes("don") && lower.includes("active")) {
    lines.push("Set DON Active:");
    lines.push(`  Up to ${Number((lower.match(/set up to\s+(\d+)/) || [])[1] || 1)}`);
  }

  if (lower.includes("cannot play character")) {
    lines.push("Cannot Play:");
    lines.push("  character");
    lines.push("  this turn");
  }

  if (lower.includes("attach") && lower.includes("rested don")) {
    const amount = Number((lower.match(/up to\s+(\d+)/) || [])[1] || 1);
    const target = lower.includes("characters in any way") || lower.includes("to your characters")
      ? "characters"
      : "leader_or_character";
    lines.push("Attach Rested DON:");
    lines.push(`  Up to ${amount}`);
    lines.push(`  To ${target}`);
  }

  if (lower.includes("look at the top")) {
    const look = Number((lower.match(/top\s+(\d+)/) || [])[1] || 5);
    const add = Number((lower.match(/up to\s+(\d+)/) || [])[1] || 1);
    const type = (text.match(/[{\[]([^}\]]+)[}\]]/) || [])[1] || "";
    const cost = (lower.match(/cost\s+(\d+)\s+or less/) || [])[1];
    lines.push("Search:");
    lines.push(`  Top ${look}`);
    lines.push(`  Reveal up_to ${add}`);
    if (type) lines.push(`  Where type includes "${type}"`);
    if (cost) lines.push(`  Where cost <= ${cost}`);
    lines.push(lower.includes("play up to") ? "  Add revealed to character_field" : "  Add revealed to hand");
    if (lower.includes("gains") && lower.includes("rush")) lines.push("  If played character gains Rush");
    lines.push("  Send rest to bottom_deck");
  }

  if (lower.includes("play up to 1") && lower.includes("from your hand")) {
    const name = (text.match(/\[([^\]]+)\]/) || [])[1] || "Card Name";
    const restDon = (lower.match(/rest\s+(\d+)\s+don/) || [])[1] || 1;
    lines.push("Play:");
    lines.push(`  "${name}" from hand`);
    lines.push(`  Rest ${restDon} DON`);
  }

  if (lower.includes("activate up to 1") && lower.includes("event")) {
    const type = (text.match(/[{\[]([^}\]]+)[}\]]/) || [])[1] || "Hamon";
    lines.push("Use Event:");
    lines.push(`  Type "${type}" from hand`);
    if (lower.includes("draw")) lines.push("  Then draw");
  }

  if (lower.includes("trash") && lower.includes("set this card") && lower.includes("active")) {
    const name = (text.match(/\[([^\]]+)\]/) || [])[1] || "Card Name";
    lines.push("Trash Named:");
    lines.push(`  "${name}"`);
    lines.push("Ready Self:");
  } else if (lower.includes("trash this character") || lower.includes("trash this card")) {
    lines.push("Trash Self:");
  }

  if (lower.includes("draw 1") && !lines.some(line => line.includes("then_draw")) && !lines.includes("Search:")) {
    lines.push("Draw:");
    lines.push("  1");
  }

  if (lines.length === 1) {
    lines.push("  # I need more specific text. Try saying: draw 1, search_top 5, attach rested DON, or set active DON.");
  }

  return lines.join("\n");
}


function effectsToCardScript(card) {
  if (card.effectScript) return card.effectScript;
  const text = String(card.effects || "");
  return text
    ? `on_play:\n  # Existing text-only effect:\n  # ${text.replace(/\n/g, "\n  # ")}`
    : "";
}


function creationCardFromForm(imageDataUrl) {
  const cardNumber = el.creationCardNumber.value.trim() || nextImportedCardNumber();
  const category = normalizeCategory(el.creationCategory.value);
  const colors = csvValues(el.creationColors.value).map(color => color.toLowerCase());
  const keywords = csvValues(el.creationKeywords.value);
  const costOrLife = el.creationCost.value === "" ? "" : Number(el.creationCost.value);
  const effectText = el.creationEffectText?.value.trim() || "";

  return {
    id: cardNumber,
    cardNumber,
    name: el.creationName.value.trim(),
    category,
    cardType: category,
    type: el.creationTypes.value.trim(),
    color: colors.join(","),
    colors,
    cost: category === "leader" ? "" : costOrLife,
    life: category === "leader" ? costOrLife : "",
    power: el.creationPower.value === "" ? "" : Number(el.creationPower.value),
    counter: el.creationCounter.value === "" ? "" : Number(el.creationCounter.value),
    attribute: el.creationAttribute.value.trim(),
    rarity: el.creationRarity.value.trim(),
    // How many copies of this card a deck may hold. 0 means unlimited; absent
    // on older cards, which fall back to the standard 4 (see cardCopyLimit).
    copyLimit: el.creationCopyLimit ? Number(el.creationCopyLimit.value) : DEFAULT_COPY_LIMIT,
    keywords,
    effect: effectText,
    image: imageDataUrl,
    imported: true,
    importedAt: new Date().toISOString()
  };
}

async function saveCreatedCard(event) {
  event.preventDefault();
  const file = el.creationImage.files?.[0];
  const imageUrl = el.creationImageUrl?.value.trim() || "";

  if (!imageUrl && !file && !state.creationImageData) {
    toast("Provide an image URL or upload a card image first");
    return;
  }

  if (!el.creationName.value.trim()) {
    toast("Name is required");
    return;
  }

  // Prefer an image URL - stores only the link, not a base64 PNG blob. Fall
  // back to the uploaded file (compressed base64) only when no URL is given.
  let imageSource;
  if (imageUrl) {
    imageSource = imageUrl;
  } else if (file) {
    imageSource = await compressImageDataUrl(await readFileAsDataUrl(file));
  } else {
    imageSource = state.creationImageData;
  }
  // Compress just this card's artwork, then publish only this card - no need to
  // load, diff and re-upload the entire library to add one entry.
  const [card] = await compressImportedCardImages([creationCardFromForm(imageSource)]);
  if (!await publishSingleCard(card)) return;

  // Editing a card and changing its number used to leave the original behind as
  // a duplicate: the old entry was filtered out of the list above, but the sync
  // deliberately never deletes by omission (that behaviour once wiped the whole
  // library). Remove the old key explicitly instead.
  const previousKey = state.editingCardId;
  if (previousKey && previousKey !== card.cardNumber && previousKey !== card.id) {
    const library = await getCardLibrary();
    try {
      if (library) await library.deleteSharedCard(previousKey);
    } catch (error) {
      console.warn("Could not remove the pre-edit card:", error);
    }
    delete state.deck[previousKey];
    if (state.leaderId === previousKey) state.leaderId = card.cardNumber;
    saveDeck(false);
  }

  clearCreationForm(true);
  toast(`${card.name} saved`);
  await loadCardPool();
}

function clearCreationForm(resetNumber = true) {
  el.cardCreationForm?.reset();
  state.editingCardId = "";
  state.creationImageData = "";
  if (el.creationImageUrl) el.creationImageUrl.value = "";
  if (resetNumber && el.creationCardNumber) el.creationCardNumber.value = nextImportedCardNumber();
  if (el.creationImagePreview) el.creationImagePreview.innerHTML = `<span>No image yet</span>`;
  if (el.creationStatus) el.creationStatus.textContent = "Ready";
}

function previewCreationImageUrl() {
  const url = el.creationImageUrl?.value.trim();
  if (!url || !el.creationImagePreview) return;
  state.creationImageData = url;
  el.creationImagePreview.innerHTML = `<img src="${escapeAttr(url)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'Could not load image URL'}))">`;
  // OCR works on URL images too when the host allows cross-origin reads;
  // runCardOcr degrades gracefully when it doesn't.
  runCardOcr(url);
}

async function previewCreationImage() {
  const file = el.creationImage.files?.[0];
  if (!file || !el.creationImagePreview) return;
  const imageDataUrl = await readFileAsDataUrl(file);
  state.creationImageData = imageDataUrl;
  el.creationImagePreview.innerHTML = `<img src="${escapeAttr(imageDataUrl)}" alt="">`;
  // OCR: try to auto-fill fields from the uploaded image (assist only).
  runCardOcr(imageDataUrl);
}

// =========================
// Card image OCR (assist-only auto-fill)
// =========================

function getOcrEnabled() {
  const stored = localStorage.getItem("optcgOcrEnabled");
  return stored === null ? true : stored === "true";
}

let tesseractLoadPromise = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractLoadPromise) return tesseractLoadPromise;
  tesseractLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    script.onload = () => resolve(window.Tesseract);
    script.onerror = () => { tesseractLoadPromise = null; reject(new Error("OCR library failed to load")); };
    document.head.appendChild(script);
  });
  return tesseractLoadPromise;
}

// Reusable OCR worker so language data loads once, and so per-region character
// whitelists can be applied (digits-only for cost dramatically cuts misreads).
let ocrWorkerPromise = null;
function getOcrWorker(Tesseract) {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = Tesseract.createWorker("eng");
  }
  return ocrWorkerPromise;
}

// Set-code prefixes already known to the app ("BLH1", "JJK1", ...). OCR often
// picks up a stray glyph beside the printed number (e.g. "NBLH1-005"); if a
// known prefix appears inside the raw text we snap to it.
function knownSetPrefixes() {
  const prefixes = new Set();
  [...state.cards, ...loadImportedCards()].forEach(card => {
    const match = String(card.cardNumber || "").match(/^([A-Z0-9]{2,5})-\d+/i);
    if (match) prefixes.add(match[1].toUpperCase());
  });
  return prefixes;
}

// ── Card layout map ──────────────────────────────────────
// These cards follow the standard OPTCG frame, so every field sits in a fixed
// place. Fractions are relative to the detected CARD bounding box (not the
// image file), so padded or whitespace-framed scans still line up.
//
//   ┌─[cost]────────────────[power]───────┐
//   │                                     │
//   │                 art                 │
//   │                                     │
//   │           C H A R A C T E R         │  <- type band
//   │              Card Name              │
//   │                       [BLH1-033][R] │  <- number + rarity
//   └─────────────────────────────────────┘
//
// Counter, Attribute, Types and Effect Text are deliberately NOT read: each one
// cost an extra OCR pass (and the counter/attribute needed extra passes of their
// own), which roughly doubled scan time for fields that are quick to type by
// hand and were the least accurate of the set.
const CARD_REGIONS = {
  // x, y, w, h as fractions of the card box.
  cost:      { x: 0.010, y: 0.010, w: 0.170, h: 0.105 },
  power:     { x: 0.600, y: 0.010, w: 0.290, h: 0.080 },
  typeBand:  { x: 0.180, y: 0.850, w: 0.640, h: 0.042 },
  name:      { x: 0.080, y: 0.882, w: 0.840, h: 0.060 },
  number:    { x: 0.700, y: 0.962, w: 0.300, h: 0.036 }
};

// OPTCG frame colours, matched against the average hue/lightness of the card's
// outer border. Far more reliable than trying to OCR a colour name.
const FRAME_COLORS = [
  { name: "red",    hue: 0,   sat: 0.45 },
  { name: "yellow", hue: 52,  sat: 0.45 },
  { name: "green",  hue: 140, sat: 0.30 },
  { name: "blue",   hue: 205, sat: 0.35 },
  { name: "purple", hue: 285, sat: 0.25 }
];

// Pick the most plausible name line: the longest mostly-alphabetic line that
// isn't a frame label. Prevents the failure mode where a neighbouring band's
// text was pasted into the name field.
function pickNameLine(text) {
  const JUNK = /CHARACTER|EVENT|STAGE|LEADER|TOKEN|DON!!|Trigger|On Play|Blocker|Counter|\[|\]/i;
  return String(text || "")
    .split(/\n+/)
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(line => line.length >= 3 && line.length <= 40)
    .filter(line => !JUNK.test(line))
    .filter(line => (line.match(/[A-Za-z]/g) || []).length / line.length > 0.6)
    .sort((a, b) => b.length - a.length)[0] || "";
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

// Sample the outer frame (a thin ring inside the card edge, avoiding the art and
// the white page behind it) and classify it into an OPTCG colour.
function detectCardColor(ctx, cardX, cardY, cardW, cardH) {
  const inset = 0.012;   // step inside the black outline
  const band = 0.030;    // how thick a ring to sample
  const strips = [
    { x: inset, y: 0.30, w: band, h: 0.40 },                 // left edge
    { x: 1 - inset - band, y: 0.30, w: band, h: 0.40 },      // right edge
    { x: 0.30, y: 1 - inset - band, w: 0.40, h: band }       // bottom edge
  ];

  let r = 0, g = 0, b = 0, n = 0;
  strips.forEach(strip => {
    const sx = Math.round(cardX + cardW * strip.x);
    const sy = Math.round(cardY + cardH * strip.y);
    const sw = Math.max(1, Math.round(cardW * strip.w));
    const sh = Math.max(1, Math.round(cardH * strip.h));
    const data = ctx.getImageData(sx, sy, sw, sh).data;
    for (let i = 0; i < data.length; i += 4) {
      // Ignore near-white pixels (page bleed / text on the frame).
      if (data[i] > 235 && data[i + 1] > 235 && data[i + 2] > 235) continue;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
  });

  if (!n) return "";
  r /= n; g /= n; b /= n;

  const { h, s, l } = rgbToHsl(r, g, b);

  // Very dark and/or unsaturated frames are black cards.
  if (l < 0.28 || s < 0.18) return "black";

  let best = "", bestDistance = Infinity;
  FRAME_COLORS.forEach(colour => {
    if (s < colour.sat - 0.2) return;
    let distance = Math.abs(h - colour.hue);
    if (distance > 180) distance = 360 - distance;   // hue wraps
    if (distance < bestDistance) { bestDistance = distance; best = colour.name; }
  });

  return bestDistance <= 40 ? best : "black";
}

// A full scan reads nine regions sequentially and takes a few seconds, which
// looked like nothing was happening. Report each step as it completes.
const SCAN_STEPS = [
  "Preparing image",
  "Finding card edges",
  "Reading cost",
  "Reading power",
  "Reading card type",
  "Reading name",
  "Reading card number",
  "Detecting colour"
];

function showScanProgress(stepIndex, labelOverride) {
  if (!el.scanProgress) return;

  el.scanProgress.hidden = false;
  const total = SCAN_STEPS.length;
  const clamped = Math.max(0, Math.min(stepIndex, total));
  const percent = Math.round((clamped / total) * 100);

  if (el.scanProgressFill) el.scanProgressFill.style.width = `${percent}%`;
  if (el.scanProgressLabel) {
    el.scanProgressLabel.textContent =
      `${labelOverride || SCAN_STEPS[clamped] || "Finishing"} — ${percent}%`;
  }
}

function hideScanProgress(finalLabel) {
  if (!el.scanProgress) return;

  if (finalLabel) {
    if (el.scanProgressFill) el.scanProgressFill.style.width = "100%";
    if (el.scanProgressLabel) el.scanProgressLabel.textContent = finalLabel;
    // Leave the completed bar up briefly so the result registers.
    window.setTimeout(() => { if (el.scanProgress) el.scanProgress.hidden = true; }, 1600);
    return;
  }

  el.scanProgress.hidden = true;
}

// Read every printed field from a card image and pre-fill the matching form
// controls. Assist only: it never locks a field and only fills fields the user
// hasn't set (or the auto-generated card #).
async function runCardOcr(source) {
  if (!getOcrEnabled() || !source) return;

  if (el.creationStatus) el.creationStatus.textContent = "Scanning image…";
  showScanProgress(0, "Loading scanner");
  try {
    const Tesseract = await loadTesseract();
    const worker = await getOcrWorker(Tesseract);
    const image = await loadImageSource(source);
    showScanProgress(1);

    // Composite onto white first: transparent PNG areas otherwise read as pure
    // black and wreck both region statistics and recognition.
    const base = document.createElement("canvas");
    base.width = image.naturalWidth;
    base.height = image.naturalHeight;
    const baseCtx = base.getContext("2d");
    baseCtx.fillStyle = "#ffffff";
    baseCtx.fillRect(0, 0, base.width, base.height);
    baseCtx.drawImage(image, 0, 0);

    // Find the card's actual bounding box so padded/whitespace-framed images
    // still map regions correctly (fractions are relative to the CARD, not the
    // file). Uses a 100px thumbnail for speed.
    const thumb = document.createElement("canvas");
    thumb.width = 100;
    thumb.height = 100;
    const thumbCtx = thumb.getContext("2d");
    thumbCtx.fillStyle = "#ffffff";
    thumbCtx.fillRect(0, 0, 100, 100);
    thumbCtx.drawImage(base, 0, 0, 100, 100);
    const tp = thumbCtx.getImageData(0, 0, 100, 100).data;
    const rowHasInk = new Array(100).fill(0);
    const colHasInk = new Array(100).fill(0);
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) {
        const i = (y * 100 + x) * 4;
        const gray = 0.299 * tp[i] + 0.587 * tp[i + 1] + 0.114 * tp[i + 2];
        if (gray < 240) { rowHasInk[y]++; colHasInk[x]++; }
      }
    }
    const firstIdx = arr => arr.findIndex(v => v > 3);
    const lastIdx = arr => arr.length - 1 - [...arr].reverse().findIndex(v => v > 3);
    let top = firstIdx(rowHasInk), bottom = lastIdx(rowHasInk);
    let left = firstIdx(colHasInk), right = lastIdx(colHasInk);
    if (top < 0 || bottom <= top || left < 0 || right <= left) {
      top = 0; bottom = 99; left = 0; right = 99;
    }
    const cardX = (left / 100) * base.width;
    const cardY = (top / 100) * base.height;
    const cardW = ((right - left + 1) / 100) * base.width;
    const cardH = ((bottom - top + 1) / 100) * base.height;

    // Upscaled, grayscaled, contrast-boosted crop of a card-relative region.
    // Dark regions (white-on-black bars like the name plate) are auto-inverted -
    // Tesseract reads dark-on-light far better than the reverse.
    const crop = (region, scale = 4) => {
      const { x: fx, y: fy, w: fw, h: fh, rotate = 0 } = region;
      const sx = cardX + cardW * fx;
      const sy = cardY + cardH * fy;
      const sw = Math.max(1, Math.round(cardW * fw));
      const sh = Math.max(1, Math.round(cardH * fh));

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const swapAxes = rotate === 90 || rotate === -90;
      canvas.width = (swapAxes ? sh : sw) * scale;
      canvas.height = (swapAxes ? sw : sh) * scale;

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.save();
      // The COUNTER value is printed sideways down the left edge; rotate it
      // upright so Tesseract can read it at all.
      if (rotate) {
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((rotate * Math.PI) / 180);
        ctx.translate(-(sw * scale) / 2, -(sh * scale) / 2);
      }
      ctx.drawImage(base, Math.round(sx), Math.round(sy), sw, sh, 0, 0, sw * scale, sh * scale);
      ctx.restore();

      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = pixels.data;
      let luminanceSum = 0;
      for (let i = 0; i < d.length; i += 4) {
        luminanceSum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      }
      const invert = (luminanceSum / (d.length / 4)) < 128;
      for (let i = 0; i < d.length; i += 4) {
        let gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (invert) gray = 255 - gray;
        // Push toward black/white around the midpoint to sharpen glyph edges.
        const boosted = Math.max(0, Math.min(255, (gray - 128) * 1.8 + 128));
        d[i] = d[i + 1] = d[i + 2] = boosted;
      }
      ctx.putImageData(pixels, 0, 0);
      return canvas;
    };

    // Regions run sequentially because the shared worker's parameters are
    // stateful. psm = page segmentation mode: telling Tesseract "this is a
    // single word/line" rather than a page is a large accuracy win on the
    // small, isolated numbers this layout uses.
    const PSM = { BLOCK: "6", LINE: "7", WORD: "8", CHAR: "10", RAW_LINE: "13" };
    const ocrRegion = async (region, { whitelist = "", psm = PSM.LINE, scale = 4 } = {}) => {
      try {
        await worker.setParameters({
          tessedit_char_whitelist: whitelist,
          tessedit_pageseg_mode: psm
        });
        const result = await worker.recognize(crop(region, scale));
        return String(result?.data?.text || "").trim();
      } catch {
        return "";
      }
    };

    const DIGITS = "0123456789";
    const SETCHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-";
    const WORDCHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz .,'-/&!";

    showScanProgress(2);
    const costText  = await ocrRegion(CARD_REGIONS.cost,     { whitelist: DIGITS, psm: PSM.CHAR, scale: 6 });
    showScanProgress(3);
    const powerText = await ocrRegion(CARD_REGIONS.power,    { whitelist: DIGITS, psm: PSM.WORD, scale: 5 });
    showScanProgress(4);
    const typeText  = await ocrRegion(CARD_REGIONS.typeBand, { whitelist: WORDCHARS, psm: PSM.LINE });
    showScanProgress(5);
    const nameText  = await ocrRegion(CARD_REGIONS.name,     { whitelist: WORDCHARS, psm: PSM.LINE });
    showScanProgress(6);
    const setText   = await ocrRegion(CARD_REGIONS.number,   { whitelist: SETCHARS, psm: PSM.LINE, scale: 6 });

    // Only ever fill a field the user has left blank.
    const fillInput = (field, value) => {
      if (field && value && !field.value.trim()) field.value = value;
    };
    const fillSelect = (field, value) => {
      if (!field || !value || field.value !== "") return false;
      const wanted = String(value).toLowerCase();
      const option = [...field.options].find(o => o.value.toLowerCase() === wanted);
      if (option) { field.value = option.value; return true; }
      return false;
    };

    const filled = [];

    // Cost -> top-left circle. Single-character read, digits only.
    const costMatch = costText.match(/\d{1,2}/);
    if (costMatch && Number(costMatch[0]) <= 10 && fillSelect(el.creationCost, costMatch[0])) {
      filled.push(`cost ${costMatch[0]}`);
    }

    // Power -> top-right. Always a multiple of 1000 on these cards, so snap to
    // the nearest thousand and reject anything outside the printable range.
    const powerDigits = powerText.replace(/\D/g, "");
    if (powerDigits && el.creationPower && !el.creationPower.value.trim()) {
      let power = Number(powerDigits);
      if (power > 0 && power <= 15000) {
        power = Math.round(power / 1000) * 1000;
        if (power > 0) {
          el.creationPower.value = String(power);
          filled.push(`power ${power}`);
        }
      }
    }

    // Card type -> the band above the name.
    const typeUpper = typeText.toUpperCase();
    const category = ["LEADER", "CHARACTER", "STAGE", "EVENT", "TOKEN"]
      .find(type => typeUpper.includes(type));
    if (category && fillSelect(el.creationCategory, category.toLowerCase())) {
      filled.push(category.toLowerCase());
    }

    // Colour -> read from the frame pixels, not from text (no OCR pass needed).
    showScanProgress(7);
    const frameColor = detectCardColor(baseCtx, cardX, cardY, cardW, cardH);
    if (frameColor && fillSelect(el.creationColors, frameColor)) {
      filled.push(frameColor);
    }

    // Name -> the line directly under the type band.
    const nameCandidate = pickNameLine(nameText);
    if (nameCandidate) {
      fillInput(el.creationName, nameCandidate);
      filled.push(`name "${nameCandidate}"`);
    }

    // Set number -> snap to a known set prefix when one appears in the raw text
    // (fixes stray leading glyphs like "NBLH1-005"), else fall back to pattern.
    if (el.creationCardNumber) {
      const current = el.creationCardNumber.value.trim();
      if (!current || /^JJBA-\d+$/i.test(current)) {
        const raw = setText.replace(/\s+/g, "").toUpperCase();
        let setNumber = "";
        for (const prefix of knownSetPrefixes()) {
          const snapped = raw.match(new RegExp(`${prefix}-?(\\d{2,3})`));
          if (snapped) { setNumber = `${prefix}-${snapped[1]}`; break; }
        }
        if (!setNumber) {
          const match = raw.match(/[A-Z]{2,4}\d{0,2}-\d{2,3}/);
          if (match) setNumber = match[0];
        }
        if (setNumber) {
          el.creationCardNumber.value = setNumber;
          filled.push(setNumber);
        }
      }
    }

    if (el.creationStatus) {
      el.creationStatus.textContent = filled.length
        ? `Scan complete — read ${filled.join(", ")}. Please review.`
        : "Scan complete — nothing recognised, please fill the fields manually";
    }
    hideScanProgress(filled.length
      ? `Done — ${filled.length} field${filled.length === 1 ? "" : "s"} read`
      : "Done — nothing recognised");
  } catch (error) {
    console.warn("Card OCR unavailable:", error);
    if (el.creationStatus) el.creationStatus.textContent = "Auto-scan unavailable — fill fields manually";
    hideScanProgress("Scan failed");
  }
}

async function importCardFromForm(event) {
  event.preventDefault();
  const file = el.importImage.files?.[0];

  if (!file) {
    toast("Upload a card image first");
    return;
  }

  if (!el.importName.value.trim()) {
    toast("Name is required");
    return;
  }

  const imageDataUrl = await compressImageDataUrl(await readFileAsDataUrl(file));
  // Publish only this card - see publishSingleCard.
  const [card] = await compressImportedCardImages([importedCardFromForm(imageDataUrl)]);
  if (!await publishSingleCard(card)) return;
  el.cardImportForm.reset();
  el.importCardNumber.value = nextImportedCardNumber();
  toast(`${card.name} imported`);
  await loadCardPool();
}

async function deleteImportedCard(cardId) {
  const card = getCard(cardId);

  if (!card?.imported) {
    toast("Only imported cards can be deleted from here");
    return;
  }

  if (!window.confirm(`Delete ${card.name} from your custom library?`)) return;

  // Delete this ONE card explicitly. This used to re-save the entire library
  // minus this card, which meant any hiccup loading the library silently
  // deleted everything that failed to load.
  const library = await getCardLibrary();
  if (library) {
    try {
      const { tombstoned } = await library.deleteSharedCard(card.cardNumber || cardId);
      if (!tombstoned) {
        toast("Deleted, but publish database.rules.json or it may come back");
      }
    } catch (error) {
      console.error(error);
      toast(`Delete failed: ${error.message}`);
      return;
    }
  } else {
    // No shared library (offline / static-only): fall back to the local layer.
    const remaining = (await loadProjectCards())
      .filter(existing => existing.id !== cardId && existing.cardNumber !== cardId);
    if (!await saveProjectCardsLocally(remaining)) return;
  }

  delete state.deck[cardId];
  if (state.leaderId === cardId) state.leaderId = "";
  saveDeck(false);
  await loadCardPool();
  toast(`${card.name} deleted`);
}

function openCardForEditing(card) {
  if (!card?.imported) {
    toast("Only custom cards can be edited here");
    return;
  }

  initializeCardCreation();
  state.editingCardId = card.id;
  state.creationImageData = card.imageUrl || "";

  if (el.creationImage) el.creationImage.value = "";
  el.creationCardNumber.value = card.cardNumber || card.id;
  el.creationName.value = card.name || "";
  el.creationCategory.value = normalizeCategory(card.category || card.cardType);
  setSelectValueWithFallback(el.creationColors, (card.colors || []).join(", "));
  setSelectValueWithFallback(el.creationCost, card.category === "leader" ? card.life || "" : card.cost || "");
  el.creationPower.value = card.power || "";
  setSelectValueWithFallback(el.creationCounter, card.counter || "");
  setSelectValueWithFallback(el.creationAttribute, card.attribute || "");
  el.creationTypes.value = card.type || "";
  setSelectValueWithFallback(el.creationRarity, card.rarity || "");
  // 0 is a real value here (unlimited), so don't collapse it with || "".
  if (el.creationCopyLimit) {
    const limit = Number(card.copyLimit);
    el.creationCopyLimit.value = String(Number.isFinite(limit) ? limit : DEFAULT_COPY_LIMIT);
  }
  setSelectValueWithFallback(el.creationKeywords, (card.keywords || []).join(", "));
  if (el.creationEffectText) el.creationEffectText.value = card.effect || card.effects || "";
  if (el.creationImagePreview) {
    el.creationImagePreview.innerHTML = card.imageUrl
      ? `<img src="${escapeAttr(card.imageUrl)}" alt="">`
      : `<span>No image yet</span>`;
  }
  if (el.creationStatus) el.creationStatus.textContent = `Editing ${card.name}`;
  if (el.savedDecksPanel) el.savedDecksPanel.hidden = true;
  if (el.cardCreationPanel) el.cardCreationPanel.hidden = false;
}

async function clearImportedCards() {
  const cards = await loadProjectCards();
  const legacyCards = loadImportedCards();
  if (!cards.length) {
    toast(legacyCards.length ? "Only legacy browser cards found. Clearing those now." : "No editable project cards to clear");
    if (legacyCards.length) localStorage.removeItem(CUSTOM_CARDS_KEY);
    return;
  }

  if (!window.confirm(`Delete ${cards.length} editable project card${cards.length === 1 ? "" : "s"}? Base set cards stay installed.`)) {
    return;
  }

  const importedIds = new Set(cards.flatMap(card => [card.id, card.cardNumber].filter(Boolean)));

  if (!await saveProjectCards([])) return;
  localStorage.removeItem(CUSTOM_CARDS_KEY);
  // Also drop this browser's local card layer, so "clear overrides" really does
  // return to the shipped set rather than leaving tombstones behind.
  localStorage.removeItem(LOCAL_PROJECT_CARDS_KEY);
  localStorage.removeItem(LOCAL_PROJECT_DELETIONS_KEY);
  Object.keys(state.deck).forEach(id => {
    if (importedIds.has(id)) delete state.deck[id];
  });
  if (importedIds.has(state.leaderId)) state.leaderId = "";
  saveDeck(false);
  await loadCardPool();
  toast("Editable project card overrides cleared");
}

function loadSavedDeck() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.leaderId = saved.leaderId || "";
    state.deck = saved.deck || {};
    state.tokens = Array.isArray(saved.tokens) ? saved.tokens : [];
    state.deckName = saved.deckName || "";
    el.deckName.value = state.deckName;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

// Auto-save the WORKING DRAFT so the deck survives a reload. This does NOT touch
// the named Saved Decks list - only the Save button does (saveDeckToLibrary).
// Called on every edit. It used to also call saveNamedDeck() here, which is why
// a saved deck was rewritten continuously while you were still building it.
function saveDeck() {
  state.deckName = el.deckName.value.trim();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    leaderId: state.leaderId,
    deck: state.deck,
    tokens: state.tokens,
    deckName: state.deckName
  }));
  renderAll();
  queueDeckTableResize();
}

// Save the current deck into the named Saved Decks list. Overwrites a saved deck
// with the EXACT same name; otherwise adds a new one. Only the Save button runs
// this, so editing never disturbs your saved copy.
function saveDeckToLibrary() {
  saveDeck(); // keep the working draft in sync first

  const name = state.deckName || el.deckName.value.trim();
  if (!name) {
    toast("Name your deck before saving");
    el.deckName?.focus();
    return;
  }

  const existed = savedDecks().some(deck => deck.name === name);
  saveNamedDeck();
  toast(existed ? `Overwrote "${name}"` : `Saved "${name}"`);
  renderSavedDecks();
}

function savedDecks() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_DECKS_KEY) || "[]");
  } catch {
    localStorage.removeItem(SAVED_DECKS_KEY);
    return [];
  }
}

function currentDeckSnapshot() {
  return {
    name: state.deckName || el.deckName.value.trim() || "Current Deck",
    leaderId: state.leaderId,
    deck: { ...state.deck },
    tokens: [...state.tokens],
    savedAt: ""
  };
}

function deckSnapshotCount(deck) {
  return Object.values(deck || {}).reduce((sum, qty) => sum + Number(qty || 0), 0);
}

function isPlayableDeckSnapshot(snapshot) {
  // Gameplay only requires a valid leader - decks of any size may start.
  // The /50 count remains informational (see deck warnings), it is not enforced.
  return Boolean(snapshot?.leaderId && getCard(snapshot.leaderId));
}

function deckTextToSnapshot(deckDefinition) {
  const deck = {};
  String(deckDefinition?.deckText || "").trim().split(/\n+/).forEach(line => {
    const match = line.trim().match(/^(\d+)x(.+)$/);
    if (!match) return;
    const id = match[2].trim();
    deck[id] = (deck[id] || 0) + Number(match[1]);
  });

  return {
    name: deckDefinition?.name || "Template Deck",
    leaderId: deckDefinition?.leaderKey || "",
    deck,
    savedAt: ""
  };
}

function templateDeckOptions() {
  return (window.availableDecks || []).map(deckDefinition => ({
    value: `template:${deckDefinition.id}`,
    label: deckDefinition.name,
    snapshot: deckTextToSnapshot(deckDefinition)
  }));
}

function practiceDeckOptions() {
  const options = [
    {
      value: "current",
      label: "Current Deck",
      snapshot: currentDeckSnapshot()
    },
    ...savedDecks().map((deck, index) => ({
      value: `saved:${index}`,
      label: deck.name || `Saved Deck ${index + 1}`,
      snapshot: deck
    })),
    ...templateDeckOptions()
  ];

  return options;
}

function practiceDeckSnapshot(choice) {
  if (choice === "current") return currentDeckSnapshot();
  if (String(choice || "").startsWith("template:")) {
    const deckId = String(choice).slice("template:".length);
    const deckDefinition = (window.availableDecks || []).find(deck => deck.id === deckId);
    return deckDefinition ? deckTextToSnapshot(deckDefinition) : null;
  }
  const match = String(choice || "").match(/^saved:(\d+)$/);
  if (!match) return null;
  return savedDecks()[Number(match[1])] || null;
}

function normalizePracticeDeckChoices() {
  const playable = practiceDeckOptions().filter(option => isPlayableDeckSnapshot(option.snapshot));
  if (!playable.length) return;
  ["player", "opponent"].forEach(key => {
    if (!isPlayableDeckSnapshot(practiceDeckSnapshot(state.practiceDecks[key]))) {
      state.practiceDecks[key] = playable[0].value;
    }
  });
}

function saveNamedDeck() {
  const name = state.deckName || el.deckName.value.trim() || `Deck ${new Date().toLocaleDateString()}`;
  const decks = savedDecks().filter(deck => deck.name !== name);
  decks.unshift({
    name,
    leaderId: state.leaderId,
    deck: state.deck,
    tokens: state.tokens,
    savedAt: new Date().toISOString()
  });
  localStorage.setItem(SAVED_DECKS_KEY, JSON.stringify(decks.slice(0, 24)));
}

function loadNamedDeck(index) {
  const deck = savedDecks()[index];
  if (!deck) return;
  state.deckName = deck.name;
  state.leaderId = deck.leaderId || "";
  state.deck = deck.deck || {};
  state.tokens = Array.isArray(deck.tokens) ? deck.tokens : [];
  el.deckName.value = state.deckName;
  saveDeck(false);
  el.savedDecksPanel.hidden = true;
  toast(`${deck.name} loaded`);
}

function deleteNamedDeck(index) {
  const decks = savedDecks();
  const deck = decks[index];
  if (!deck) return;
  const name = deck.name || `Deck ${index + 1}`;
  if (!window.confirm(`Delete saved deck "${name}"?`)) return;
  decks.splice(index, 1);
  localStorage.setItem(SAVED_DECKS_KEY, JSON.stringify(decks));
  renderSavedDecks();
  toast(`${name} deleted`);
}

function showView(view) {
  state.activeView = view;
  el.viewPanels.forEach(panel => panel.classList.toggle("active", panel.dataset.viewPanel === view));
  el.navTabs.forEach(button => button.classList.toggle("active", button.dataset.view === view));
  if (view === "builder") queueDeckTableResize();
}

function cardsByCategory(category) {
  return state.cards.filter(card => card.category === category);
}

function getCard(id) {
  return state.cards.find(card => card.id === id);
}

function deckMainCount() {
  return Object.values(state.deck).reduce((sum, qty) => sum + qty, 0);
}

function deckEntries() {
  return Object.entries(state.deck)
    .map(([id, qty]) => ({ card: getCard(id), qty }))
    .filter(entry => entry.card)
    .sort((a, b) => {
      const costA = Number(a.card.cost || 0);
      const costB = Number(b.card.cost || 0);
      return costA - costB || a.card.name.localeCompare(b.card.name);
    });
}

// Standard OPTCG limit, used when a card doesn't specify its own.
const DEFAULT_COPY_LIMIT = 4;

// How many copies of a card a deck may hold. Cards carry `copyLimit`, where 0
// means unlimited; anything missing or invalid falls back to the standard 4, so
// cards made before this option existed keep working.
function cardCopyLimit(card) {
  const limit = Number(card?.copyLimit);
  if (limit === 0) return Infinity;
  return Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_COPY_LIMIT;
}

function addToDeck(id) {
  const card = getCard(id);
  if (!card) return;

  if (card.category === "leader") {
    state.leaderId = id;
    pruneDeckForLeader();
    saveDeck(false);
    toast(`${card.name} set as leader`);
    return;
  }

  if (!state.leaderId) {
    toast("Pick a leader first");
    return;
  }

  // Tokens are a type list, not deck contents: unlimited types, no copy limit,
  // and never counted against the 50. Adding one just makes it available in game.
  if (card.category === "token") {
    if (state.tokens.includes(id)) {
      toast(`${card.name} is already available`);
      return;
    }
    state.tokens.push(id);
    saveDeck(false);
    toast(`${card.name} added to tokens`);
    return;
  }

  if (!canCardJoinLeader(card)) {
    toast("That card does not match your leader colors");
    return;
  }

  if (deckMainCount() >= 50) {
    toast("Main deck is already at 50 cards");
    return;
  }

  const current = state.deck[id] || 0;
  const limit = cardCopyLimit(card);
  if (current >= limit) {
    toast(`Copy limit reached (${limit} max)`);
    return;
  }

  state.deck[id] = current + 1;
  saveDeck(false);
}

function addFourToDeck(id) {
  const card = getCard(id);
  if (!card) return;
  // A token type is either available or not - there are no copies to stack up.
  if (card.category === "leader" || card.category === "token") {
    addToDeck(id);
    return;
  }
  if (!state.leaderId) {
    toast("Pick a leader first");
    return;
  }
  if (!canCardJoinLeader(card)) {
    toast("That card does not match your leader colors");
    return;
  }
  // "Add a playset" - fills up to this card's own limit, not a hardcoded 4.
  // Unlimited cards stop at the 50-card deck cap rather than running forever.
  const limit = cardCopyLimit(card);
  let added = 0;
  while ((state.deck[id] || 0) < limit && deckMainCount() < 50) {
    state.deck[id] = (state.deck[id] || 0) + 1;
    added += 1;
  }
  saveDeck(false);
  toast(added ? `Added ${added} ${card.name}` : "Could not add more copies");
}

function canCardJoinLeader(card) {
  const leader = getCard(state.leaderId);
  if (!leader) return false;
  const leaderColors = new Set(leader.colors || []);
  return card.colors?.some(color => leaderColors.has(color));
}

function pruneDeckForLeader() {
  Object.keys(state.deck).forEach(id => {
    const card = getCard(id);
    if (!card || !canCardJoinLeader(card)) delete state.deck[id];
  });
}

function removeFromDeck(id) {
  // Tokens live in their own list and are removed as a whole type.
  if (state.tokens.includes(id)) {
    state.tokens = state.tokens.filter(tokenId => tokenId !== id);
    saveDeck(false);
    return;
  }
  if (!state.deck[id]) return;
  state.deck[id] -= 1;
  if (state.deck[id] <= 0) delete state.deck[id];
  saveDeck(false);
}

function clearDeck() {
  state.deck = {};
  state.tokens = [];
  state.leaderId = "";
  state.game = null;
  saveDeck(false);
}

function autoFillDeck() {
  if (!state.leaderId) {
    const firstLeader = cardsByCategory("leader")[0];
    if (firstLeader) state.leaderId = firstLeader.id;
  }

  const leader = getCard(state.leaderId);
  if (!leader) {
    toast("No leader available yet");
    return;
  }

  state.deck = {};
  const leaderColors = new Set(leader.colors);
  const candidates = state.cards
    .filter(card => card.category !== "leader")
    .filter(card => card.colors.some(color => leaderColors.has(color)))
    .sort((a, b) => Number(a.cost || 0) - Number(b.cost || 0));

  for (const card of candidates) {
    const limit = cardCopyLimit(card);
    while ((state.deck[card.id] || 0) < limit && deckMainCount() < 50) {
      state.deck[card.id] = (state.deck[card.id] || 0) + 1;
    }
    if (deckMainCount() >= 50) break;
  }

  saveDeck(false);
  toast("Deck auto-filled");
}

function filteredCards() {
  const query = el.searchInput.value.trim();
  const category = el.categoryFilter.value;
  const color = el.colorFilter.value;
  const leader = getCard(state.leaderId);
  const leaderColors = new Set(leader?.colors || []);

  return state.cards.filter(card => {
    // Leader-first browsing: with no leader picked the grid shows ONLY leaders,
    // so the first decision is always "who am I building around". Once one is
    // chosen it drops out of the way and the grid shows just that leader's
    // colours. An explicit Type filter still overrides this, so you can go back
    // and look at leaders again without clearing your deck.
    if (!category) {
      if (!leader) {
        if (card.category !== "leader") return false;
      } else if (card.category === "leader") {
        return false;
      }
    }

    return (!query || evaluateSearchQuery(query, card, state.searchMode))
      && (!category || card.category === category)
      && (!color || card.colors.includes(color))
      && (!el.setFilter.value || card.setCode === el.setFilter.value)
      && (!el.costFilter.value || String(displayCost(card)) === el.costFilter.value)
      && (!el.powerFilter.value || String(card.power) === el.powerFilter.value)
      && (!el.counterFilter.value || String(card.counter) === el.counterFilter.value)
      && (!el.rarityFilter.value || card.rarity === el.rarityFilter.value)
      && (!el.blockFilter.value || card.block === el.blockFilter.value)
      && (!state.rotationOnly || !/^test/i.test(card.cardNumber))
      // Once a leader is picked the grid is restricted to its colours, so what
      // you see is what you can actually play. Leaders and tokens are exempt -
      // tokens aren't deck cards, and leaders only appear here via the Type
      // filter, where hiding off-colour ones would stop you switching leader.
      && (!leader
        || card.category === "leader"
        || card.category === "token"
        || card.colors.some(cardColor => leaderColors.has(cardColor)));
  }).sort(compareCards);
}

// Standard OPTCG colour order. Anything unrecognised (or colourless) sorts last.
const COLOR_SORT_ORDER = ["red", "green", "blue", "purple", "black", "yellow"];

// A card's colours as sorted rank numbers, so mono-colour cards group ahead of
// the dual-colour cards that share their first colour (Red, then Red/Green…).
function colorRanks(card) {
  const colors = Array.isArray(card?.colors) ? card.colors : [];
  const ranks = colors
    .map(color => {
      const index = COLOR_SORT_ORDER.indexOf(String(color).trim().toLowerCase());
      return index === -1 ? COLOR_SORT_ORDER.length : index;
    })
    .sort((x, y) => x - y);

  return ranks.length ? ranks : [COLOR_SORT_ORDER.length];
}

function compareByColor(a, b) {
  const left = colorRanks(a);
  const right = colorRanks(b);

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    // A missing entry means fewer colours, which sorts first.
    const x = i < left.length ? left[i] : -1;
    const y = i < right.length ? right[i] : -1;
    if (x !== y) return x - y;
  }
  return 0;
}

// Colour is ALWAYS the primary grouping; the chosen sort field orders cards
// within each colour.
function compareCards(a, b) {
  const byColor = compareByColor(a, b);
  if (byColor !== 0) return byColor;

  if (state.sortField === "cost") return displayCost(a) - displayCost(b) || a.cardNumber.localeCompare(b.cardNumber);
  if (state.sortField === "name") return a.name.localeCompare(b.name) || a.cardNumber.localeCompare(b.cardNumber);
  if (state.sortField === "power") return Number(a.power || 0) - Number(b.power || 0) || a.cardNumber.localeCompare(b.cardNumber);
  return a.cardNumber.localeCompare(b.cardNumber);
}

function displayCost(card) {
  return Number(card.category === "leader" ? card.life || 0 : card.cost || 0);
}

function searchableText(card) {
  return [
    card.name,
    card.id,
    card.cardNumber,
    card.setCode,
    card.block,
    card.category,
    card.type,
    card.attribute,
    card.colors.join(" "),
    card.rarity,
    card.effects,
    card.keywords.join(" ")
  ].join(" ").toLowerCase();
}

function evaluateSearchQuery(query, card, mode = "AND") {
  const tokens = tokenizeSearch(query);
  if (!tokens.length) return true;
  let index = 0;

  function parseExpression() {
    let value = parseTerm();
    while (tokens[index] === "||") {
      index += 1;
      value = value || parseTerm();
    }
    return value;
  }

  function parseTerm() {
    let value = parseFactor();
    while (index < tokens.length && tokens[index] !== ")" && tokens[index] !== "||") {
      if (tokens[index] === "&&") index += 1;
      else if (mode === "OR") return value || parseTerm();
      value = value && parseFactor();
    }
    return value;
  }

  function parseFactor() {
    const token = tokens[index];
    index += 1;
    if (token === "(") {
      const value = parseExpression();
      if (tokens[index] === ")") index += 1;
      return value;
    }
    if (token === ")" || token === "&&" || token === "||") return true;
    return matchSearchToken(card, token);
  }

  return parseExpression();
}

function tokenizeSearch(query) {
  const tokens = [];
  const pattern = /\[[^\]]+\]|\(|\)|&&|\|\||[^\s()]+/g;
  let match;
  while ((match = pattern.exec(query)) !== null) tokens.push(match[0]);
  return tokens;
}

function matchSearchToken(card, token) {
  const text = searchableText(card);
  const exact = token.match(/^\[(.+)\]$/);
  if (exact) return text.includes(exact[1].toLowerCase());

  const range = token.match(/^(\d+)\.\.(\d+)$/);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    return [displayCost(card), Number(card.power || 0), Number(card.counter || 0), Number(card.life || 0)]
      .some(value => value >= min && value <= max);
  }

  return text.includes(token.toLowerCase());
}

function populateFilterOptions() {
  setSelectOptions(el.setFilter, "Set", uniqueValues(card => card.setCode));
  setSelectOptions(el.costFilter, "Cost", uniqueValues(card => String(displayCost(card))).sort((a, b) => Number(a) - Number(b)));
  setSelectOptions(el.powerFilter, "Power", uniqueValues(card => String(card.power)).sort((a, b) => Number(a) - Number(b)));
  setSelectOptions(el.counterFilter, "Counter", uniqueValues(card => String(card.counter)).sort((a, b) => Number(a) - Number(b)));
  setSelectOptions(el.rarityFilter, "Rarity", uniqueValues(card => card.rarity));
  setSelectOptions(el.blockFilter, "Block", uniqueValues(card => card.block));
}

function uniqueValues(reader) {
  return [...new Set(state.cards.map(reader).filter(value => value !== "" && value !== "undefined"))];
}

function setSelectOptions(select, label, values) {
  select.innerHTML = `<option value="">${label}</option>` + values
    .map(value => `<option value="${escapeAttr(value)}">${escapeHtml(value)}</option>`)
    .join("");
}

function setToggle(onButton, offButton, isOn) {
  onButton.classList.toggle("active", isOn);
  offButton.classList.toggle("active", !isOn);
}

function renderAll() {
  showView(state.activeView);
  renderHome();
  renderBuilder();
  renderGame();
}

function renderHome() {
  const leader = getCard(state.leaderId);
  const counts = {
    leader: cardsByCategory("leader").length,
    character: cardsByCategory("character").length,
    event: cardsByCategory("event").length,
    stage: cardsByCategory("stage").length
  };

  el.homeLeader.textContent = leader ? leader.name : "None";
  el.homeDeckCount.textContent = String(deckMainCount());
  el.homePoolCount.textContent = String(state.cards.length || 0);
  el.leaderTotal.textContent = String(counts.leader);
  el.characterTotal.textContent = String(counts.character);
  el.eventTotal.textContent = String(counts.event);
  el.stageTotal.textContent = String(counts.stage);
}

function renderBuilder() {
  const leader = getCard(state.leaderId);
  const mainCount = deckMainCount();
  const warnings = [];

  el.deckTitle.textContent = state.deckName || el.deckName.value.trim() || "Untitled Deck";
  el.deckCount.textContent = String(mainCount);

  if (!leader) warnings.push("Choose exactly 1 leader.");
  if (mainCount !== 50) warnings.push(`Main deck has ${mainCount} cards. OPTCG style decks use 50.`);

  el.deckWarnings.innerHTML = warnings.map(text => `<div class="warning">${escapeHtml(text)}</div>`).join("");
  el.leaderSlot.innerHTML = leader ? renderDeckRow(leader, 1, true) : `<div class="empty">Leader slot</div>`;

  // Tokens render in the SAME grid as the deck cards. They used to sit in a
  // separate panel below, which fell outside the fixed-height scroll area and
  // so was effectively invisible. They carry a TOKEN badge instead of a copy
  // count and are never part of deckMainCount(), so the 50/50 total is unaffected.
  const entries = deckEntries();
  const tokenCards = state.tokens.map(id => getCard(id)).filter(Boolean);

  const deckMarkup = entries.map(entry => renderDeckRow(entry.card, entry.qty)).join("");
  const tokenMarkup = tokenCards.map(card => renderTokenRow(card)).join("");

  // Tokens render inline in the deck grid above (badged TOKEN); there is no
  // separate token section.
  el.deckList.innerHTML = (deckMarkup + tokenMarkup) ||
    `<div class="empty">Add up to 50 non-leader cards.</div>`;

  renderCardGrid();
  renderSavedDecks();
  queueDeckTableResize();
}

// A token type in the deck grid: same card visual, but badged TOKEN rather than
// carrying a copy count, since a type is simply available or not.
function renderTokenRow(card) {
  return `
    <div class="deck-row token-row" data-card-id="${escapeAttr(card.id)}" title="Token - does not count toward the 50">
      <div class="mini-card-art">${cardVisual(card)}</div>
      <span class="qty token-qty">TOKEN</span>
      <div class="deck-row-actions">
        <button class="deck-icon-btn remove-card-btn" type="button" data-remove="${escapeAttr(card.id)}" aria-label="Remove token ${escapeAttr(card.name)}" title="Remove token"><span aria-hidden="true">-</span></button>
        <button class="deck-icon-btn inspect-card-btn" type="button" data-inspect="${escapeAttr(card.id)}" aria-label="Inspect ${escapeAttr(card.name)}" title="Inspect">
          <span class="magnifier-icon" aria-hidden="true"></span>
        </button>
      </div>
    </div>
  `;
}

function renderDeckRow(card, qty, isLeader = false) {
  const removeButton = isLeader
    ? `<button class="deck-icon-btn remove-card-btn" type="button" data-clear-leader aria-label="Remove leader" title="Remove"><span aria-hidden="true">-</span></button>`
    : `<button class="deck-icon-btn remove-card-btn" type="button" data-remove="${escapeAttr(card.id)}" aria-label="Remove one ${escapeAttr(card.name)}" title="Remove one"><span aria-hidden="true">-</span></button>`;

  return `
    <div class="deck-row" data-card-id="${escapeAttr(card.id)}">
      <div class="mini-card-art">${cardVisual(card)}</div>
      <span class="qty">${qty}</span>
      <div class="deck-row-actions">
        ${removeButton}
        <button class="deck-icon-btn inspect-card-btn" type="button" data-inspect="${escapeAttr(card.id)}" aria-label="Inspect ${escapeAttr(card.name)}" title="Inspect">
          <span class="magnifier-icon" aria-hidden="true"></span>
        </button>
      </div>
    </div>
  `;
}

function renderSavedDecks() {
  const decks = savedDecks();
  el.savedDeckList.innerHTML = decks.length
    ? decks.map((deck, index) => {
      const leader = getCard(deck.leaderId);
      const count = deckSnapshotCount(deck.deck);

      return `
      <article class="saved-deck-row">
        <div class="saved-deck-leader-art">
          ${leader ? cardVisual(leader) : `<div class="proxy-card">No Leader</div>`}
        </div>
        <div class="saved-deck-info">
          <strong>${escapeHtml(deck.name)}</strong>
          <span>${leader ? escapeHtml(leader.name) : "No leader"} · ${count}/50 main deck</span>
          <small>${escapeHtml(deck.savedAt ? new Date(deck.savedAt).toLocaleString() : "No save date")}</small>
        </div>
        <div class="saved-deck-actions">
          <button type="button" data-load-deck="${index}">Load</button>
          <button class="ghost danger" type="button" data-delete-deck="${index}">Delete</button>
        </div>
      </article>
    `;
    }).join("")
    : `<div class="empty">No saved decks yet. Name a deck and hit Save.</div>`;
}

function queueDeckTableResize() {
  requestAnimationFrame(updateDeckTableHeight);
}

function updateDeckTableHeight() {
  const builderMain = document.querySelector(".builder-main");
  const deckTable = document.querySelector(".deck-table");
  const deckList = document.querySelector(".deck-list");
  const leaderSlot = document.querySelector(".leader-slot");
  const board = document.querySelector(".deck-board-scroll");
  if (!builderMain || !deckTable || !deckList || !board) return;

  const entries = deckEntries().length;
  const deckListWidth = Math.max(1, deckList.getBoundingClientRect().width);
  const minColumnWidth = 98;
  const columnGap = 28;
  const columns = Math.max(1, Math.floor((deckListWidth + columnGap) / (minColumnWidth + columnGap)));
  const mainRows = entries ? Math.ceil(entries / columns) : 1;
  // Open a bit taller than a single cramped row - enough to show one full row
  // plus a peek of the next (so it reads as scrollable) - without reserving two
  // whole rows, which felt too big. Real multi-row decks still grow past this,
  // and the `max` cap below keeps it on screen.
  const MIN_VISIBLE_ROWS = 1.5;
  const visualRows = Math.max(mainRows, MIN_VISIBLE_ROWS);

  const cardRowHeight = 148;
  const rowGap = 12;
  const boardPadding = 28;
  const deckChrome = 88;
  const warningHeight = el.deckWarnings.children.length ? 38 : 0;
  const boardHeight = boardPadding + Math.max(148, visualRows * cardRowHeight + Math.max(0, visualRows - 1) * rowGap);
  const desired = Math.ceil(deckChrome + warningHeight + boardHeight);
  const max = Math.floor(builderMain.getBoundingClientRect().height * 0.72);
  const min = state.leaderId || entries ? 230 : 170;
  const height = Math.max(min, Math.min(desired, max));

  builderMain.style.setProperty("--deck-table-height", `${height}px`);
}

function renderCardGrid() {
  clearTimeout(state.searchRenderTimer);
  const cards = filteredCards();
  el.filteredCount.textContent = String(cards.length);
  el.cardGrid.innerHTML = "";

  // Explain the leader-first filter, so a small count reads as "filtered"
  // rather than "my cards are missing".
  if (el.collectionHint) {
    const leader = getCard(state.leaderId);
    const total = state.cards.length;
    el.collectionHint.textContent = el.categoryFilter.value
      ? ""
      : !leader
        ? `Pick a leader to start — showing leaders only (${total} cards in all)`
        : `${leader.name}'s colours only — clear the leader to switch (${total} cards in all)`;
  }

  if (!cards.length) {
    el.cardGrid.innerHTML = `<div class="empty">No custom cards match those filters.</div>`;
    return;
  }

  const template = document.querySelector("#cardTemplate");
  cards.forEach(card => {
    const node = template.content.cloneNode(true);
    const article = node.querySelector(".card-tile");
    const image = node.querySelector(".card-image");
    const name = node.querySelector(".card-body strong");
    const meta = node.querySelector(".card-body span");
    const deleteButton = node.querySelector('[data-action="delete"]');
    const editButton = node.querySelector('[data-action="edit"]');

    article.dataset.id = card.id;
    image.innerHTML = cardVisual(card);
    name.textContent = card.name;
    meta.textContent = cardMeta(card);

    if (card.category === "leader") {
      article.querySelector('[data-action="add"]').textContent = "Leader";
    }

    if (card.imported && deleteButton) {
      deleteButton.hidden = false;
    }

    if (card.imported && editButton) {
      editButton.hidden = false;
    }

    el.cardGrid.appendChild(node);
  });
}

function scheduleCardGridRender() {
  clearTimeout(state.searchRenderTimer);
  state.searchRenderTimer = setTimeout(renderCardGrid, 160);
}

function cardVisual(card) {
  if (card?.imageUrl) {
    return `
      <img
        alt="${escapeAttr(card.name)}"
        src="${escapeAttr(card.imageUrl)}"
        data-fallback-name="${escapeAttr(card.name)}"
        data-fallback-number="${escapeAttr(card.cardNumber)}"
        data-fallback-color="${escapeAttr(colorValue(card))}"
      >
    `;
  }

  return proxyCardMarkup(card?.name || "Empty", card?.cardNumber || "", colorValue(card));
}

function tableCardVisual(card) {
  if (!card?.imageUrl) return proxyCardMarkup(card?.name || "Empty", card?.cardNumber || "", colorValue(card));
  return `
    <div class="table-card-art">
      <img
        alt="${escapeAttr(card.name)}"
        src="${escapeAttr(card.imageUrl)}"
        data-fallback-name="${escapeAttr(card.name)}"
        data-fallback-number="${escapeAttr(card.cardNumber)}"
        data-fallback-color="${escapeAttr(colorValue(card))}"
      >
    </div>
  `;
}

function proxyCardMarkup(name, number, color) {
  return `
    <div class="proxy-card" style="border-top: 6px solid ${escapeAttr(color)}">
      <strong>${escapeHtml(name)}</strong>
      <small>${escapeHtml(number)}</small>
    </div>
  `;
}

function cardMeta(card) {
  const bits = [
    card.cardNumber,
    capitalize(card.category),
    card.colors.join("/"),
    card.cost !== "" ? `Cost ${card.cost}` : "",
    card.power ? `${card.power} power` : ""
  ].filter(Boolean);
  return bits.join(" - ");
}

function previewCard(card) {
  if (!card) return;
  updatePracticePreview(card);
  el.cardPreview.innerHTML = `
    <div class="preview-layout">
      <div class="card-image">${cardVisual(card)}</div>
      <div>
        <p class="eyebrow">${escapeHtml(card.cardNumber)} - ${escapeHtml(capitalize(card.category))}</p>
        <h2>${escapeHtml(card.name)}</h2>
        <p>${escapeHtml(cardMeta(card))}</p>
        <p class="preview-copy">${escapeHtml(card.effects || "No effect text.")}</p>
      </div>
    </div>
  `;

  if (typeof el.cardDialog.showModal === "function") {
    el.cardDialog.showModal();
  }
}

function startPractice() {
  normalizePracticeDeckChoices();
  const playerDeck = practiceDeckSnapshot(state.practiceDecks.player);
  const opponentDeck = practiceDeckSnapshot(state.practiceDecks.opponent);

  if (!isPlayableDeckSnapshot(playerDeck) || !isPlayableDeckSnapshot(opponentDeck)) {
    toast("Pick two playable decks first");
    return;
  }

  sessionStorage.setItem("custom-cards-sim-practice-decks", JSON.stringify({
    player: playerDeck,
    opponent: opponentDeck
  }));
  window.location.href = "html/self.html";
  return;

  state.game = {
    turn: 1,
    active: "player",
    phase: "main",
    playerTurns: { player: 0, opponent: 0 },
    log: "",
    player: createPlayer("Player 1", playerDeck),
    opponent: createPlayer("Player 2", opponentDeck)
  };
  beginTurn("player");
  showView("game");
  renderGame();
}

function endPractice() {
  state.game = null;
  renderGame();
}

function createPlayer(name, deckSnapshot) {
  const leader = createInstance(getCard(deckSnapshot.leaderId));
  const deck = [];
  deckSnapshotEntries(deckSnapshot).forEach(({ card, qty }) => {
    for (let i = 0; i < qty; i += 1) deck.push(createInstance(card));
  });
  shuffle(deck);

  const player = {
    name,
    leader,
    deck,
    life: [],
    hand: [],
    characters: Array(5).fill(null),
    stage: null,
    trash: [],
    don: 0,
    maxDon: 0,
    donDeck: 10
  };

  const lifeCount = Math.max(1, Number(leader.life || 5));
  for (let i = 0; i < lifeCount; i += 1) drawTo(player, "life");
  for (let i = 0; i < 5; i += 1) drawTo(player, "hand");
  return player;
}

function deckSnapshotEntries(snapshot) {
  return Object.entries(snapshot?.deck || {})
    .map(([id, qty]) => ({ card: getCard(id), qty }))
    .filter(entry => entry.card)
    .sort((a, b) => {
      const costA = Number(a.card.cost || 0);
      const costB = Number(b.card.cost || 0);
      return costA - costB || a.card.name.localeCompare(b.card.name);
    });
}

function createInstance(card) {
  return {
    ...card,
    instanceId: crypto.randomUUID(),
    rested: false
  };
}

function drawTo(player, zone) {
  const card = player.deck.shift();
  if (card) player[zone].push(card);
  return card;
}

function beginTurn(playerKey) {
  const game = state.game;
  if (!game) return;
  const player = game[playerKey];
  game.active = playerKey;
  game.phase = "main";
  game.playerTurns[playerKey] += 1;
  if (playerKey === "player" && game.playerTurns[playerKey] > 1) game.turn += 1;

  refreshPlayer(player);
  const isFirstPlayerOpeningTurn = playerKey === "player" && game.playerTurns[playerKey] === 1;
  if (!isFirstPlayerOpeningTurn) drawTo(player, "hand");
  addDonForTurn(player, isFirstPlayerOpeningTurn ? 1 : 2);
  game.log = `${player.name}: Main Phase.`;
}

function refreshPlayer(player) {
  player.leader.rested = false;
  player.characters.forEach(card => {
    if (card) card.rested = false;
  });
  if (player.stage) player.stage.rested = false;
  player.don = player.maxDon;
}

function addDonForTurn(player, count) {
  const amount = Math.min(count, player.donDeck, 10 - player.maxDon);
  player.maxDon += amount;
  player.donDeck -= amount;
  player.don = player.maxDon;
}

function endMainPhase() {
  if (!state.game) return;
  const nextPlayer = state.game.active === "player" ? "opponent" : "player";
  beginTurn(nextPlayer);
  renderGame();
}

function renderGame() {
  const shell = document.querySelector(".practice-shell");
  shell?.classList.toggle("setup-mode", !state.game);
  shell?.classList.toggle("game-running", Boolean(state.game));
  if (el.startGame) el.startGame.hidden = Boolean(state.game);
  if (el.endGame) el.endGame.hidden = !state.game;
  if (el.phaseAction) el.phaseAction.hidden = !state.game;

  if (!state.game) {
    if (el.gameTitle) el.gameTitle.textContent = "Self-practice setup";
    if (el.turnBadge) el.turnBadge.textContent = "";
    if (el.phaseStatus) el.phaseStatus.textContent = "Select decks";
    normalizePracticeDeckChoices();
    setGameLog("Choose decks for both sides, then start the self-test.");
    updatePracticePreview(null);
    el.gameBoard.innerHTML = renderPracticeSetup();
    return;
  }

  if (el.gameTitle) el.gameTitle.textContent = state.deckName || "Practice Game";
  if (el.turnBadge) el.turnBadge.textContent = `Turn ${state.game.turn} - ${state.game[state.game.active].name}`;
  if (el.phaseStatus) el.phaseStatus.textContent = `Turn ${state.game.turn} - ${state.game[state.game.active].name} - Main Phase`;
  setGameLog(state.game.log);
  
  // Use manual board renderer for gameplay
  if (window.manualBoardRenderer) {
    console.log("Rendering manual board...");
    window.manualBoardRenderer.renderGameBoard(state.game);
    
    // Populate hand cards
    const handContainer = document.getElementById("handCards");
    if (handContainer && state.game.player && state.game.player.hand) {
      handContainer.innerHTML = state.game.player.hand
        .map(card => window.manualBoardRenderer.createCardElement(card, "hand"))
        .join("");
    }
  } else {
    console.warn("Manual board renderer not available, using fallback");
    el.gameBoard.innerHTML = renderPracticeBoard(state.game);
  }
}

function renderPracticeSetup() {
  const canStart = isPlayableDeckSnapshot(practiceDeckSnapshot(state.practiceDecks.player))
    && isPlayableDeckSnapshot(practiceDeckSnapshot(state.practiceDecks.opponent));

  return `
    <section class="practice-setup">
      <div class="practice-setup-head">
        <p class="eyebrow">Play vs self test mode</p>
        <h2>Select decks for both boards</h2>
      </div>
      <div class="practice-deck-selectors">
        ${renderPracticeDeckPicker("player", "Player 1 Board")}
        ${renderPracticeDeckPicker("opponent", "Player 2 Board")}
      </div>
      <div class="practice-setup-actions">
        <button type="button" data-start-practice ${canStart ? "" : "disabled"}>Start Game</button>
        <button class="ghost" type="button" data-open-builder>Open Deck Builder</button>
      </div>
    </section>
  `;
}

function renderPracticeDeckPicker(key, label) {
  const options = practiceDeckOptions();
  const selected = state.practiceDecks[key];
  const snapshot = practiceDeckSnapshot(selected);
  const leader = getCard(snapshot?.leaderId);
  const mainCount = deckSnapshotCount(snapshot?.deck);

  return `
    <article class="practice-deck-card">
      <label>
        <span>${escapeHtml(label)}</span>
        <select data-practice-deck="${escapeAttr(key)}">
          ${options.map(option => `
            <option value="${escapeAttr(option.value)}" ${option.value === selected ? "selected" : ""} ${isPlayableDeckSnapshot(option.snapshot) ? "" : "disabled"}>
              ${escapeHtml(option.label)}${isPlayableDeckSnapshot(option.snapshot) ? "" : " - needs cards"}
            </option>
          `).join("")}
        </select>
      </label>
      <div class="practice-deck-summary">
        <div class="practice-leader-preview">${leader ? cardVisual(leader) : `<div class="empty">No leader</div>`}</div>
        <div>
          <strong>${escapeHtml(snapshot?.name || "No deck selected")}</strong>
          <span>${leader ? escapeHtml(leader.name) : "No leader selected"}</span>
          <small>${mainCount}/50 main deck</small>
        </div>
      </div>
    </article>
  `;
}

function renderPracticeBoard(game) {
  return `
    <svg id="attackArrowOverlay" class="attack-arrow-overlay" aria-hidden="true"></svg>
    <div class="hand opponent-hand" id="player2Hand">${renderHand(game.opponent, "opponent")}</div>
    ${renderPlayArea(game.opponent, "opponent", game)}
    ${renderPlayArea(game.player, "player", game)}
    <div class="hand player-hand" id="player1Hand">${renderHand(game.player, "player")}</div>
  `;
}

function renderPlayArea(player, key, game = state.game) {
  const isActive = game && key === game.active;
  const leaderMarkup = player.leader
    ? `<div class="leader-card" data-preview-card="${escapeAttr(player.leader.id)}">${tableCardVisual(player.leader)}${renderKeywordBadges(player.leader)}</div>`
    : `<div class="empty-zone area-placeholder"></div>`;

  return `
    <section class="play-area ${key === "opponent" ? "opponent-area" : "player-area"}">
      <div class="character-area">
        ${player.characters.map((card, index) => renderBoardSlot(card, key, "characters", index)).join("")}
      </div>

      <div class="life-area">
        ${renderLifeCounter(player.life.length)}
      </div>

      <div class="area leader-area">
        ${isActive ? `<div class="active-player-dot"></div>` : ""}
        ${leaderMarkup}
      </div>
      <div class="area stage-area">${player.stage ? renderBoardSlot(player.stage, key, "stage", 0) : ""}</div>
      <div class="area deck-area">${renderCardPile(player.deck.length, "Deck", CARD_BACK_IMAGE)}</div>

      <div class="area don-deck-area">${renderCardPile(player.donDeck, "DON!! Deck", DON_DECK_IMAGE)}</div>
      <div class="area don-area">${renderDonArea(player)}</div>
      <button class="area trash-area" type="button" data-view-trash="${key}">${renderTrashPile(player)}</button>
    </section>
  `;
}

function renderLifeCounter(count) {
  const life = Math.max(0, count || 0);
  return `
    <div class="life-heart ${life === 1 ? "low-life" : ""} ${life === 0 ? "empty-life" : ""}" aria-label="${life} life">
      <span>${life}</span>
    </div>
  `;
}

function renderCardPile(count, label, image) {
  const stack = Math.min(4, Math.max(1, count || 0));
  return `
    <div class="card-pile" aria-label="${escapeAttr(label)}">
      ${Array.from({ length: stack }, (_, index) => `
        <img class="pile-card" src="${escapeAttr(image)}" alt="" style="--stack-index: ${index}">
      `).join("")}
      <span>${count}</span>
    </div>
  `;
}

function renderDonArea(player) {
  const donCards = Math.max(0, player.maxDon || player.don || 0);
  if (!donCards) {
    return `
      <div class="don-field-empty">
        <img src="${DON_CARD_IMAGE}" alt="">
        <span>${player.don}/${player.maxDon}</span>
      </div>
    `;
  }

  return `
    <div class="don-field">
      ${Array.from({ length: donCards }, (_, index) => `
        <img class="don-card-mini ${index >= player.don ? "rested-don" : ""}" src="${DON_CARD_IMAGE}" alt="DON!!">
      `).join("")}
      <span>${player.don}/${player.maxDon}</span>
    </div>
  `;
}

function renderTrashPile(player) {
  const lastCard = player.trash[player.trash.length - 1];
  return `
    <div class="trash-pile">
      ${lastCard ? tableCardVisual(lastCard) : `<span class="trash-empty"></span>`}
      <span>${player.trash.length}</span>
    </div>
  `;
}

function renderHand(player, key) {
  return player.hand.length
    ? player.hand.map(card => renderHandCard(card, key)).join("")
    : `<div class="empty">Hand is empty.</div>`;
}

function renderBoardSlot(card, playerKey, zone, index) {
  if (!card) {
    return `
      <div class="character-slot empty-zone">
      </div>
    `;
  }
  return `
    <div class="character-slot zone ${card.rested ? "rested" : ""}" data-player-key="${playerKey}" data-zone="${zone}" data-index="${index}" data-preview-card="${escapeAttr(card.id)}">
      ${tableCardVisual(card)}
      ${renderKeywordBadges(card)}
      <div class="zone-actions">
        <button class="ghost" type="button" data-board-action="rest">Rest</button>
        <button class="ghost danger" type="button" data-board-action="trash">Trash</button>
      </div>
    </div>
  `;
}

function renderHandCard(card, playerKey) {
  return `
    <div class="hand-card" title="${escapeAttr(card.name)}" data-preview-card="${escapeAttr(card.id)}">
      ${cardVisual(card)}
      <button class="play-card-btn" type="button" data-play-card="${escapeAttr(card.instanceId)}" data-player-key="${playerKey}">Play ${displayCost(card)}</button>
    </div>
  `;
}

function renderKeywordBadges(card) {
  const keywords = cardKeywords(card);
  if (!keywords.length) return "";
  return `
    <div class="keyword-tags">
      ${keywords.map(keyword => `<span class="keyword-tag ${escapeAttr(keyword.className)}">${escapeHtml(keyword.label)}</span>`).join("")}
    </div>
  `;
}

function cardKeywords(card) {
  const normalizeKeyword = keyword => String(keyword || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  const values = new Set((card?.keywords || []).map(normalizeKeyword));
  const text = `${card?.effects || ""} ${(card?.keywords || []).join(" ")}`.toLowerCase();
  const hasCharacterRush = values.has("rushcharacters") || /\b(?:rush\s*:\s*characters?|characters?\s*:\s*rush)\b/i.test(text);
  const checks = [
    { key: "blocker", label: "Blocker", className: "blocker", test: () => values.has("blocker") || /\bblocker\b/.test(text) },
    { key: "rushCharacters", label: "Rush:Character", className: "rush", test: () => hasCharacterRush },
    { key: "rush", label: "Rush", className: "rush", test: () => values.has("rush") || (/\brush\b/.test(text) && !hasCharacterRush) },
    { key: "doubleAttack", label: "2x Attack", className: "double-attack", test: () => values.has("doubleattack") || /double attack/.test(text) },
    { key: "banish", label: "Banish", className: "banish", test: () => values.has("banish") || /\bbanish\b/.test(text) },
    { key: "unblockable", label: "Unblockable", className: "unblockable", test: () => values.has("unblockable") || /\bunblockable\b/.test(text) }
  ];

  return checks.filter(check => check.test()).map(({ label, className }) => ({ label, className }));
}

function setGameLog(message) {
  if (!el.gameLogMessages) return;
  el.gameLogMessages.innerHTML = `<div class="log-message">${escapeHtml(message || "No actions yet.")}</div>`;
}

function updatePracticePreview(card) {
  if (!el.previewImage || !el.previewPlaceholder) return;

  if (!card) {
    el.previewImage.hidden = true;
    el.previewImage.removeAttribute("src");
    el.previewPlaceholder.hidden = false;
    el.previewPlaceholder.textContent = "Hover a card to preview it";
    return;
  }

  if (card.imageUrl) {
    el.previewImage.hidden = false;
    el.previewImage.src = card.imageUrl;
    el.previewImage.alt = card.name;
    el.previewPlaceholder.hidden = true;
    return;
  }

  el.previewImage.hidden = true;
  el.previewImage.removeAttribute("src");
  el.previewPlaceholder.hidden = false;
  el.previewPlaceholder.textContent = `${card.name} - ${card.cardNumber}`;
}

function activePlayer() {
  return state.game ? state.game[state.game.active] : null;
}

function handleDraw() {
  const player = activePlayer();
  if (!player) return;
  const card = drawTo(player, "hand");
  state.game.log = card ? `${player.name} drew ${card.name}.` : `${player.name} tried to draw from an empty deck.`;
  renderGame();
}

function handleAddDon() {
  const player = activePlayer();
  if (!player) return;
  player.maxDon = Math.min(10, player.maxDon + 1);
  player.don = player.maxDon;
  state.game.log = `${player.name} set DON to ${player.don}/${player.maxDon}.`;
  renderGame();
}

function handlePassTurn() {
  if (!state.game) return;
  state.game.active = state.game.active === "player" ? "opponent" : "player";
  if (state.game.active === "player") state.game.turn += 1;
  state.game.log = `${state.game[state.game.active].name}'s turn.`;
  renderGame();
}

function playFromHand(playerKey, instanceId) {
  if (!state.game) return;
  if (state.game.active !== playerKey || state.game.phase !== "main") {
    toast("You can only play cards during your Main Phase");
    return;
  }
  const player = state.game[playerKey];
  const index = player.hand.findIndex(card => card.instanceId === instanceId);
  if (index < 0) return;

  const [card] = player.hand.splice(index, 1);
  const cost = Number(card.cost || 0);
  if (cost > player.don) {
    player.hand.splice(index, 0, card);
    toast(`Need ${cost} active DON!!`);
    renderGame();
    return;
  }
  player.don -= cost;

  if (card.category === "character") {
    const slot = player.characters.findIndex(value => !value);
    if (slot === -1) {
      player.hand.splice(index, 0, card);
      player.don += cost;
      toast("No open character slots");
      renderGame();
      return;
    }
    player.characters[slot] = card;
    state.game.log = `${player.name} played ${card.name}.`;
  } else if (card.category === "stage") {
    if (player.stage) player.trash.push(player.stage);
    player.stage = card;
    state.game.log = `${player.name} set ${card.name} as stage.`;
  } else {
    player.trash.push(card);
    state.game.log = `${player.name} used ${card.name} and sent it to trash.`;
  }

  renderGame();
}

function showTrash(playerKey) {
  if (!state.game) return;
  const player = state.game[playerKey];
  el.cardPreview.innerHTML = `
    <div class="trash-viewer">
      <h2>${escapeHtml(player.name)} Trash</h2>
      <div class="trash-card-grid">
        ${player.trash.length
          ? player.trash.slice().reverse().map(card => `
            <button class="trash-card-view" type="button" data-trash-preview="${escapeAttr(card.id)}">
              ${cardVisual(card)}
            </button>
          `).join("")
          : `<div class="empty">Trash is empty.</div>`}
      </div>
    </div>
  `;
  if (typeof el.cardDialog.showModal === "function") el.cardDialog.showModal();
}

function updateBoardCard(target, action) {
  if (!state.game) return;
  const player = state.game[target.dataset.playerKey];
  const zone = target.dataset.zone;
  const index = Number(target.dataset.index);
  const card = zone === "stage" ? player.stage : player.characters[index];
  if (!card) return;

  if (action === "rest") {
    card.rested = !card.rested;
    state.game.log = `${player.name} ${card.rested ? "rested" : "set active"} ${card.name}.`;
  }

  if (action === "trash") {
    if (zone === "stage") player.stage = null;
    else player.characters[index] = null;
    player.trash.push(card);
    state.game.log = `${player.name} moved ${card.name} to trash.`;
  }

  renderGame();
}

function shuffle(cards) {
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [cards[index], cards[swapIndex]] = [cards[swapIndex], cards[index]];
  }
}

function colorValue(card) {
  const color = card?.colors?.[0] || "colorless";
  return {
    red: "var(--red)",
    green: "var(--green)",
    blue: "var(--blue)",
    purple: "var(--purple)",
    yellow: "var(--yellow)",
    black: "#6f7986"
  }[color] || "var(--accent)";
}

function capitalize(value) {
  return String(value || "").charAt(0).toUpperCase() + String(value || "").slice(1);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

// Toasts share one fixed-position stack. Previously each was individually
// pinned to the bottom-right, so two at once landed on top of each other and
// both became unreadable.
function toastStack() {
  let stack = document.querySelector(".toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "toast-stack";
    document.body.appendChild(stack);
  }
  return stack;
}

function toast(message) {
  const stack = toastStack();

  // Repeating the same message just restarts its timer instead of stacking a
  // duplicate on top.
  const existing = [...stack.children].find(node => node.dataset.message === message);
  if (existing) {
    clearTimeout(Number(existing.dataset.timer));
    existing.dataset.timer = String(setTimeout(() => existing.remove(), 2600));
    return;
  }

  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  node.dataset.message = message;
  stack.appendChild(node);

  // Keep the stack short so a burst of saves can't fill the screen.
  while (stack.children.length > 3) stack.firstElementChild.remove();

  node.dataset.timer = String(setTimeout(() => node.remove(), 2600));
}

function bindEvents() {
  document.addEventListener("error", event => {
    const target = event.target;
    if (!(target instanceof HTMLImageElement) || !target.dataset.fallbackName) return;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = proxyCardMarkup(
      target.dataset.fallbackName,
      target.dataset.fallbackNumber,
      target.dataset.fallbackColor || "var(--accent)"
    ).trim();
    target.replaceWith(wrapper.firstElementChild);
  }, true);

  el.viewButtons.forEach(button => {
    button.addEventListener("click", () => showView(button.dataset.view));
  });

  document.getElementById("multiplayerButton").addEventListener("click", () => {
    window.location.href = "html/multiplayer.html";
  });

  // Nav: Multiplayer tab -> lobby page
  document.getElementById("navMultiplayer")?.addEventListener("click", () => {
    window.location.href = "html/multiplayer.html";
  });

  // Nav: Card Creator tab -> Deck Builder view with the Card Creation panel open.
  // Card Creator isn't a separate view, so after showView highlights the Deck
  // Builder tab we move the highlight to Card Creator to reflect where the user is.
  document.getElementById("navCardCreator")?.addEventListener("click", () => {
    showView("builder");
    initializeCardCreation();
    if (el.savedDecksPanel) el.savedDecksPanel.hidden = true;
    if (el.cardCreationPanel) el.cardCreationPanel.hidden = false;
    el.navTabs.forEach(tab => tab.classList.remove("active"));
    document.getElementById("navCardCreator").classList.add("active");
  });

  document.querySelectorAll("[data-open-self]").forEach(button => {
    button.addEventListener("click", () => {
      window.location.href = "html/self.html";
    });
  });

  [
    el.categoryFilter,
    el.colorFilter,
    el.setFilter,
    el.costFilter,
    el.powerFilter,
    el.counterFilter,
    el.rarityFilter,
    el.blockFilter
  ].forEach(input => {
    input.addEventListener("input", renderCardGrid);
  });

  el.filterQuick.addEventListener("input", () => {
    el.searchInput.value = el.filterQuick.value;
  });

  el.filterQuick.addEventListener("keydown", event => {
    if (event.key === "Enter") renderCardGrid();
  });

  el.searchInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      el.filterQuick.value = el.searchInput.value;
      renderCardGrid();
    }
  });

  el.runSearch.addEventListener("click", () => {
    el.filterQuick.value = el.searchInput.value;
    renderCardGrid();
  });

  el.deckName.addEventListener("input", () => {
    state.deckName = el.deckName.value.trim();
    renderHome();
    renderBuilder();
  });

  el.cardGrid.addEventListener("click", event => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    const article = event.target.closest(".card-tile");
    if (!action || !article) return;
    const card = getCard(article.dataset.id);
    if (!card) return;
    if (action === "preview" || action === "inspect") previewCard(card);
    if (action === "add") addToDeck(card.id);
    if (action === "edit") openCardForEditing(card);
    if (action === "delete") deleteImportedCard(card.id);
  });

  el.cardGrid.addEventListener("contextmenu", event => {
    const article = event.target.closest(".card-tile");
    if (!article) return;
    event.preventDefault();
    addFourToDeck(article.dataset.id);
  });

  el.deckList.addEventListener("click", event => {
    const removeId = event.target.closest("[data-remove]")?.dataset.remove;
    if (removeId) removeFromDeck(removeId);
    const inspectId = event.target.closest("[data-inspect]")?.dataset.inspect;
    if (inspectId) previewCard(getCard(inspectId));
  });

  el.tokenList?.addEventListener("click", event => {
    const removeId = event.target.closest("[data-remove]")?.dataset.remove;
    if (removeId) removeFromDeck(removeId);
    const inspectId = event.target.closest("[data-inspect]")?.dataset.inspect;
    if (inspectId) previewCard(getCard(inspectId));
  });

  el.leaderSlot.addEventListener("click", event => {
    if (event.target.closest("[data-clear-leader]")) {
      // Removing the leader clears the whole deck - its cards were chosen around
      // that leader's colours, so they no longer belong. Confirm only when there
      // is actually a deck to lose, so an empty builder just resets silently.
      const hasCards = deckMainCount() > 0 || state.tokens.length > 0;
      if (hasCards && !confirm("Remove the leader and clear the entire deck?")) return;

      state.leaderId = "";
      state.deck = {};
      state.tokens = [];
      saveDeck();
    }
    const inspectId = event.target.closest("[data-inspect]")?.dataset.inspect;
    if (inspectId) previewCard(getCard(inspectId));
  });

  el.clearDeck.addEventListener("click", clearDeck);
  el.clearDeckHome.addEventListener("click", clearDeck);
  el.restoreCards?.addEventListener("click", restoreCardsFromCache);
  el.quickBuild.addEventListener("click", autoFillDeck);
  el.saveDeck?.addEventListener("click", saveDeckToLibrary);
  el.saveDeckMini.addEventListener("click", saveDeckToLibrary);
  el.resetFilters.addEventListener("click", () => {
    el.searchInput.value = "";
    el.filterQuick.value = "";
    el.categoryFilter.value = "";
    el.colorFilter.value = "";
    el.setFilter.value = "";
    el.costFilter.value = "";
    el.powerFilter.value = "";
    el.counterFilter.value = "";
    el.rarityFilter.value = "";
    el.blockFilter.value = "";
    document.querySelectorAll("[data-color-shortcut]").forEach(wedge => wedge.classList.remove("selected"));
    renderCardGrid();
  });
  el.clearSearch?.addEventListener("click", () => {
    el.searchInput.value = "";
    el.filterQuick.value = "";
    renderCardGrid();
  });
  document.querySelectorAll("[data-color-shortcut]").forEach(button => {
    button.addEventListener("click", () => {
      el.colorFilter.value = button.dataset.colorShortcut;
      document.querySelectorAll("[data-color-shortcut]").forEach(wedge => {
        wedge.classList.toggle("selected", wedge.dataset.colorShortcut === button.dataset.colorShortcut);
      });
      renderCardGrid();
    });
  });
  document.querySelectorAll("[data-search-mode]").forEach(button => {
    button.addEventListener("click", () => {
      state.searchMode = button.dataset.searchMode;
      document.querySelectorAll("[data-search-mode]").forEach(modeButton => {
        modeButton.classList.toggle("active", modeButton === button);
      });
      renderCardGrid();
    });
  });
  document.querySelectorAll("[data-sort-field]").forEach(button => {
    button.addEventListener("click", () => {
      state.sortField = button.dataset.sortField;
      document.querySelectorAll("[data-sort-field]").forEach(sortButton => {
        sortButton.classList.toggle("active", sortButton === button);
      });
      renderCardGrid();
    });
  });
  el.showSearchTips.addEventListener("click", () => el.searchTipsDialog.showModal());
  el.closeSearchTips.addEventListener("click", () => el.searchTipsDialog.close());
  el.openCardImport?.addEventListener("click", openCardImportDialog);
  el.closeCardImport?.addEventListener("click", () => el.cardImportDialog.close());
  el.cardImportForm?.addEventListener("submit", importCardFromForm);
  el.clearImportedCards?.addEventListener("click", clearImportedCards);
  el.importCategory?.addEventListener("change", () => {
    el.importCost.placeholder = el.importCategory.value === "leader"
      ? "Life total"
      : "Cost";
  });
  el.savedDecksTab.addEventListener("click", () => {
    renderSavedDecks();
    el.savedDecksPanel.hidden = false;
    if (el.cardCreationPanel) el.cardCreationPanel.hidden = true;
  });
  el.closeSavedDecks.addEventListener("click", () => {
    el.savedDecksPanel.hidden = true;
  });
  el.savedDeckList.addEventListener("click", event => {
    const deleteIndex = event.target.closest("[data-delete-deck]")?.dataset.deleteDeck;
    if (deleteIndex !== undefined) {
      deleteNamedDeck(Number(deleteIndex));
      return;
    }
    const index = event.target.closest("[data-load-deck]")?.dataset.loadDeck;
    if (index !== undefined) loadNamedDeck(Number(index));
  });
  el.cardCreationTab?.addEventListener("click", () => {
    initializeCardCreation();
    el.savedDecksPanel.hidden = true;
    el.cardCreationPanel.hidden = false;
  });
  el.closeCardCreation?.addEventListener("click", () => {
    el.cardCreationPanel.hidden = true;
    // Panel closed but still in Deck Builder view - restore its tab highlight.
    el.navTabs.forEach(tab => tab.classList.toggle("active", tab.dataset.view === "builder"));
  });
  el.cardCreationForm?.addEventListener("submit", saveCreatedCard);
  el.creationImage?.addEventListener("change", previewCreationImage);
  el.creationImageUrl?.addEventListener("change", previewCreationImageUrl);

  // OCR toggle inside the Card Creator, kept in sync with the home-screen
  // "Enable Automatic Card Scanning" checkbox (same localStorage key).
  const creationOcrToggle = document.getElementById("creationOcrToggle");
  const homeOcrToggle = document.getElementById("setOcrEnabled");
  if (creationOcrToggle) {
    creationOcrToggle.checked = getOcrEnabled();
    creationOcrToggle.addEventListener("change", () => {
      localStorage.setItem("optcgOcrEnabled", String(creationOcrToggle.checked));
      if (homeOcrToggle) homeOcrToggle.checked = creationOcrToggle.checked;
    });
    homeOcrToggle?.addEventListener("change", () => {
      creationOcrToggle.checked = homeOcrToggle.checked;
    });
  }
  el.clearCreationForm?.addEventListener("click", () => clearCreationForm());
  el.creationCategory?.addEventListener("change", () => {
    el.creationCost.placeholder = el.creationCategory.value === "leader"
      ? "Life total"
      : "Cost";
  });
  el.startGame?.addEventListener("click", startPractice);
  el.startPracticeTop?.addEventListener("click", startPractice);
  el.endGame?.addEventListener("click", endPractice);
  el.phaseAction?.addEventListener("click", endMainPhase);
  el.drawCard?.addEventListener("click", handleDraw);
  el.addDon?.addEventListener("click", handleAddDon);
  el.passTurn?.addEventListener("click", handlePassTurn);
  el.closePreview.addEventListener("click", () => el.cardDialog.close());

  el.gameBoard.addEventListener("click", event => {
    if (event.target.closest("[data-start-practice]")) {
      startPractice();
      return;
    }

    if (event.target.closest("[data-open-builder]")) {
      showView("builder");
      return;
    }

    const trashButton = event.target.closest("[data-view-trash]");
    if (trashButton) {
      showTrash(trashButton.dataset.viewTrash);
      return;
    }

    const playButton = event.target.closest("[data-play-card]");
    if (playButton) {
      playFromHand(playButton.dataset.playerKey, playButton.dataset.playCard);
      return;
    }

    const actionButton = event.target.closest("[data-board-action]");
    const boardCard = event.target.closest("[data-player-key][data-zone]");
    if (actionButton && boardCard) updateBoardCard(boardCard, actionButton.dataset.boardAction);
  });

  el.cardPreview.addEventListener("click", event => {
    const trashPreviewId = event.target.closest("[data-trash-preview]")?.dataset.trashPreview;
    if (!trashPreviewId) return;
    previewCard(getCard(trashPreviewId));
  });

  el.gameBoard.addEventListener("change", event => {
    const select = event.target.closest("[data-practice-deck]");
    if (!select) return;
    state.practiceDecks[select.dataset.practiceDeck] = select.value;
    renderGame();
  });

  el.gameBoard.addEventListener("mouseover", event => {
    const previewNode = event.target.closest("[data-preview-card]");
    if (!previewNode) return;
    updatePracticePreview(getCard(previewNode.dataset.previewCard));
  });
}

loadSavedDeck();
bindEvents();
initializeCardCreation();
loadCardPool();
// Report shared-library connectivity in Settings without blocking startup.
refreshLibraryStatus();
refreshRestoreHint();
window.addEventListener("resize", () => {
  if (state.activeView === "builder") queueDeckTableResize();
});
