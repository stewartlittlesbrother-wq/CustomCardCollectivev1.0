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
// Card collections (sets/groups). Every card belongs to exactly one. The named
// groups are fixed; anything that doesn't fit lands in "everything-else". All
// cards that predate this feature (bundled + previously-shared) default to
// Goldrush717's Bleach - see COLLECTION_DEFAULT and normalizeCard.
// The shipped defaults. Users can add more (and override these) at runtime - see
// loadCollections / saveCollection. The live list is CARD_COLLECTIONS below.
const BUILTIN_COLLECTIONS = [
  // The full official One Piece TCG card list, pulled live from a public API and
  // hotlinked (no Firebase storage used). Read-only: not editable/deletable.
  { slug: "official-op", name: "Official One Piece TCG", official: true },
  { slug: "golds-bleach", name: "Goldrush717's Bleach", image: "images/basic/golds-bleach-set.jpg" },
  { slug: "strixs-set", name: "Strix's Set" },
  { slug: "gavilanterns-deltarune", name: "Gavilantern's Deltarune" },
  { slug: "rins-jojos", name: "Rin's Jojo's" },
  { slug: "pigs-jjk", name: "Pig's JJk", image: "images/basic/750341.jpg.webp" },
  { slug: "ravens-jjk", name: "Raven's JJk" },
  { slug: "malices-cards", name: "Malice's cards" },
  { slug: "midevilgmers-cards", name: "Midevilgmer's Cards" },
  { slug: "everything-else", name: "Everything else" }
];
const COLLECTION_DEFAULT = "golds-bleach";
const CUSTOM_COLLECTIONS_KEY = "custom-card-collections-v1";

// The LIVE collection list = built-ins + user-created ones (which may also
// override a built-in's name/image). Rebuilt by applyCustomCollections. Kept as
// a mutable array so every reader (picker, selects, normalize) sees new ones.
let CARD_COLLECTIONS = [...BUILTIN_COLLECTIONS];

// Merge a set of custom collections over the built-ins. Matching slugs override
// name/image; new slugs are inserted just before "everything-else" so that stays
// last. Called on load and after any add/edit.
function applyCustomCollections(customList) {
  const bySlug = new Map(BUILTIN_COLLECTIONS.map(entry => [entry.slug, { ...entry }]));
  (customList || []).forEach(entry => {
    const slug = String(entry.slug || "").trim();
    if (!slug) return;
    const existing = bySlug.get(slug) || { slug };
    bySlug.set(slug, {
      slug,
      name: entry.name || existing.name || slug,
      image: entry.image ?? existing.image ?? ""
    });
  });

  const everythingElse = bySlug.get("everything-else");
  bySlug.delete("everything-else");
  CARD_COLLECTIONS = [...bySlug.values()];
  if (everythingElse) CARD_COLLECTIONS.push(everythingElse);
}

// User-added collections stored in this browser (fallback / offline copy).
function loadLocalCustomCollections() {
  try {
    const list = JSON.parse(localStorage.getItem(CUSTOM_COLLECTIONS_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveLocalCustomCollections(list) {
  try {
    localStorage.setItem(CUSTOM_COLLECTIONS_KEY, JSON.stringify(list));
  } catch (error) {
    console.warn("Could not save collections locally:", error);
  }
}

// Load custom collections from the shared library (with a local fallback) and
// merge them into the live list. Safe to call before the card pool loads so a
// card's collection slug resolves correctly.
async function loadCollections() {
  let shared = [];
  try {
    const library = await getCardLibrary();
    if (library?.loadSharedCollections) {
      shared = await library.loadSharedCollections();
    }
  } catch (error) {
    console.warn("Shared collections unavailable:", error);
  }

  const local = loadLocalCustomCollections();
  // Shared wins over local for the same slug; keep any purely-local ones too.
  const merged = new Map(local.map(entry => [entry.slug, entry]));
  shared.forEach(entry => merged.set(entry.slug, entry));

  customCollections = [...merged.values()];
  applyCustomCollections(customCollections);
}

// The user-created / user-edited collections currently in memory (upserted by
// saveCollection). Persisted locally and to the shared library.
let customCollections = [];

// Create or update a collection (name + optional cover image), then refresh the
// picker and the collection dropdowns. Writes to the shared library so everyone
// gets it, with a local fallback when the library is unreachable.
async function saveCollection({ slug, name, image }) {
  const entry = {
    slug: String(slug || "").trim(),
    name: String(name || slug || "").trim(),
    image: String(image || "")
  };
  if (!entry.slug) return;

  const index = customCollections.findIndex(c => c.slug === entry.slug);
  if (index === -1) customCollections.push(entry);
  else customCollections[index] = entry;

  applyCustomCollections(customCollections);
  saveLocalCustomCollections(customCollections);

  try {
    const library = await getCardLibrary();
    if (library?.saveSharedCollection) await library.saveSharedCollection(entry);
  } catch (error) {
    console.warn("Collection not saved to shared library:", error);
    toast("Saved on this device only — shared library unreachable");
  }

  populateCollectionSelects();
  renderCardGrid();
}

function collectionSlugFromName(name) {
  const base = String(name || "").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "collection";
  let slug = base;
  let n = 2;
  while (CARD_COLLECTIONS.some(entry => entry.slug === slug)) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

function collectionName(slug) {
  return CARD_COLLECTIONS.find(entry => entry.slug === slug)?.name || "Everything else";
}

function normalizeCollectionSlug(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return COLLECTION_DEFAULT;
  const direct = CARD_COLLECTIONS.find(entry => entry.slug === text);
  if (direct) return direct.slug;
  // Allow matching by display name too (older imports may have stored the name).
  const byName = CARD_COLLECTIONS.find(entry => entry.name.toLowerCase() === text);
  return byName ? byName.slug : "everything-else";
}

// ── Alt art ──────────────────────────────────────────────
// A card can carry several extra images (altArts). Which one a player SEES is a
// per-device preference keyed by card number: an INDEX into the art cycle
// [default, ...altArts]. 0 (or absent) = the default art. Each player cycles
// their own art without changing the card for everyone. (Legacy prefs stored a
// boolean `true` for "show the one alt art" - that's read as index 1.)
const ALT_ART_PREFS_KEY = "custom-cards-alt-art-prefs-v1";
function getAltArtPrefs() {
  try { return JSON.parse(localStorage.getItem(ALT_ART_PREFS_KEY) || "{}") || {}; }
  catch { return {}; }
}
// Every artwork for a card, default first, then its alt arts (deduped, no blanks).
function cardArtList(card) {
  const main = card?.imageUrl || card?.image || "";
  const alts = Array.isArray(card?.altArts)
    ? card.altArts
    : (card?.altArt ? [card.altArt] : []);
  return [...new Set([main, ...alts].filter(Boolean))];
}
// The art index this player has selected for a card, clamped to what exists.
function altArtIndexFor(card) {
  const key = card?.cardNumber || card?.id;
  if (!key) return 0;
  const raw = getAltArtPrefs()[key];
  let idx = raw === true ? 1 : (Number(raw) || 0);   // legacy boolean = first alt
  const count = cardArtList(card).length;
  if (!Number.isInteger(idx) || idx < 0 || idx >= count) idx = 0;
  return idx;
}
function isAltArtPreferred(card) {
  return altArtIndexFor(card) > 0;
}
// Advance to the next artwork, wrapping past the last back to the default.
function cycleAltArtPref(card) {
  const key = card?.cardNumber || card?.id;
  if (!key) return;
  const count = cardArtList(card).length;
  if (count <= 1) return;
  const prefs = getAltArtPrefs();
  const next = (altArtIndexFor(card) + 1) % count;
  if (next === 0) delete prefs[key]; else prefs[key] = next;
  try { localStorage.setItem(ALT_ART_PREFS_KEY, JSON.stringify(prefs)); } catch {}
}
// The image a card should display for THIS player (their selected art).
function preferredCardImageUrl(card) {
  const list = cardArtList(card);
  return list[altArtIndexFor(card)] || card.imageUrl;
}

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
  // True until the first card-pool load finishes, so the collection screen can
  // show a "Loading…" message instead of an empty grid / "0 cards".
  cardsLoading: true,
  // True while the shared library is still downloading in the background after
  // the bundled cards have already painted. Lets the picker say "syncing" instead
  // of looking like a user's uploaded cards vanished.
  sharedSyncing: false,
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
  creationImageData: "",
  // Which collection the card browser is showing. null = show the collection
  // picker screen instead of the card grid.
  activeCollection: null
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
  exportDeck: document.querySelector("#exportDeck"),
  importDeck: document.querySelector("#importDeck"),
  deckSharePanel: document.querySelector("#deckSharePanel"),
  deckShareTitle: document.querySelector("#deckShareTitle"),
  deckShareText: document.querySelector("#deckShareText"),
  deckShareCopy: document.querySelector("#deckShareCopy"),
  deckShareLoad: document.querySelector("#deckShareLoad"),
  closeDeckShare: document.querySelector("#closeDeckShare"),
  cardGrid: document.querySelector("#cardGrid"),
  builderHoverPreview: document.querySelector("#builderHoverPreview"),
  builderHoverPreviewImg: document.querySelector("#builderHoverPreviewImg"),
  filteredCount: document.querySelector("#filteredCount"),
  collectionHint: document.querySelector("#collectionHint"),
  collectionPicker: document.querySelector("#collectionPicker"),
  collectionBack: document.querySelector("#collectionBack"),
  collectionEdit: document.querySelector("#collectionEdit"),
  viewAllToggle: document.querySelector("#viewAllToggle"),
  collectionHeading: document.querySelector("#collectionHeading"),
  collectionCountPill: document.querySelector("#collectionCountPill"),
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
  donDeckTab: document.querySelector("#donDeckTab"),
  donDeckPanel: document.querySelector("#donDeckPanel"),
  closeDonDeck: document.querySelector("#closeDonDeck"),
  importDonDeck: document.querySelector("#importDonDeck"),
  addDonCardBtn: document.querySelector("#addDonCardBtn"),
  addDonCardForm: document.querySelector("#addDonCardForm"),
  donCardName: document.querySelector("#donCardName"),
  donCardArtUrl: document.querySelector("#donCardArtUrl"),
  donCardArtImage: document.querySelector("#donCardArtImage"),
  cancelAddDonCard: document.querySelector("#cancelAddDonCard"),
  donCardStatus: document.querySelector("#donCardStatus"),
  donDeckEditId: document.querySelector("#donDeckEditId"),
  donDeckName: document.querySelector("#donDeckName"),
  donDeckCount: document.querySelector("#donDeckCount"),
  saveDonDeck: document.querySelector("#saveDonDeck"),
  clearDonDeckBuild: document.querySelector("#clearDonDeckBuild"),
  cancelDonDeckEdit: document.querySelector("#cancelDonDeckEdit"),
  donDeckStatus: document.querySelector("#donDeckStatus"),
  donDeckCurrent: document.querySelector("#donDeckCurrent"),
  donCardPool: document.querySelector("#donCardPool"),
  donDeckList: document.querySelector("#donDeckList"),
  cardCreationForm: document.querySelector("#cardCreationForm"),
  creationImage: document.querySelector("#creationImage"),
  creationImageUrl: document.querySelector("#creationImageUrl"),
  creationAddAltArt: document.querySelector("#creationAddAltArt"),
  creationAltArtList: document.querySelector("#creationAltArtList"),
  creationCardNumber: document.querySelector("#creationCardNumber"),
  creationName: document.querySelector("#creationName"),
  creationCategory: document.querySelector("#creationCategory"),
  creationCollection: document.querySelector("#creationCollection"),
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

  // Alt arts: a card can carry several extra images players cycle through. New
  // cards store an `altArts` array; older ones stored a single `altArt` string.
  // Firebase can hand an array back as an object ({0:…,1:…}), so accept that too.
  const rawAlts = raw.altArts;
  const altArtsSource = Array.isArray(rawAlts) ? rawAlts
    : (rawAlts && typeof rawAlts === "object") ? Object.values(rawAlts)
    : (raw.altArt ? [raw.altArt] : []);
  const altArts = [...new Set(altArtsSource.map(normalizeImagePath).filter(Boolean))];

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
    // Extra artworks players can cycle through (see alt-art prefs). `altArt`
    // stays as the first one for anything still reading the legacy single field.
    altArts,
    altArt: altArts[0] || "",
    // DON!! cards are shared library cards used only to build custom DON!! decks.
    // Flagged so they're kept out of the normal deck-building pool.
    donCard: Boolean(raw.donCard),
    // Which collection this card belongs to. Cards from before collections
    // existed have no value and fall back to Goldrush717's Bleach. DON!! cards
    // keep their own unregistered slug so they never inflate a real collection.
    collection: raw.donCard ? "don-cards" : normalizeCollectionSlug(raw.collection),
    effectScript: raw.effectScript || raw.script || "",
    imported: Boolean(raw.imported || raw.needsCoding),
    needsCoding: Boolean(raw.needsCoding),
    importSource: raw.importSource || null,
    effectStatus: raw.effectStatus || "",
    // Imported-card metadata. Kept as concrete values (never undefined, which
    // Firebase rejects) so JSON-imported cards preserve everything the source
    // provided and can round-trip back through the shared library unchanged.
    untapId: raw.untapId || "",
    subtype: raw.subtype || "",
    trigger: raw.trigger || "",
    donEffect: raw.donEffect || "",
    artist: raw.artist || "",
    creator: raw.creator || "",
    setName: raw.setName || "",
    printType: raw.printType || "",
    addedAt: raw.addedAt || raw.importedAt || "",
    lastEditedAt: raw.lastEditedAt || "",
    // Exact shared-library key this card loaded from (set by loadSharedCards).
    // Kept so edit/delete can target the real entry even if it lives under a
    // legacy number-only key. Client-only: stripped before any Firebase write.
    __storageKey: raw.__storageKey || ""
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
  // A card is unique by number AND collection: the same set number in two
  // different collections is two different cards and both must show in the pool.
  // Same number + same collection collapses to one (the newer copy wins).
  const collection = String(card.collection || "").trim().toLowerCase();

  return `${category}:${number || name}:${collection}`;
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
  // `ok` distinguishes a real read from a failure/absence, so callers can tell
  // "the library is genuinely empty" from "the read failed" and avoid wiping the
  // cards they already have on a transient error.
  if (!library) return { cards: [], deleted: new Set(), ok: false };

  try {
    const { cards, deleted } = await library.loadSharedCards();
    return {
      cards: cards.map(card => normalizeCard(card, card.category || card.cardType)),
      deleted: deleted || new Set(),
      ok: true
    };
  } catch (error) {
    console.warn("Shared cards not loaded into the pool:", error);
    return { cards: [], deleted: new Set(), ok: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Official One Piece TCG card list
//
// Pulled live from a free, no-key public API (optcgapi.com), which is CORS-open
// (any site may fetch it) and whose card IMAGES are freely hotlinkable. Cached
// locally for a day so we don't hammer their VPS. Nothing is written to Firebase
// - zero shared storage. The cards live in a read-only "official-op" collection.
//
// Loaded LAZILY: only when you actually open the "Official One Piece TCG"
// collection (see openCollection), so the ~2500-card list never slows down the
// rest of the builder.
// ─────────────────────────────────────────────────────────────────────────
const OFFICIAL_COLLECTION = "official-op";
const OFFICIAL_CARDS_KEY = "official-optcg-cards-v1";
const OFFICIAL_CARDS_TTL_MS = 24 * 60 * 60 * 1000;
const OPTCG_API_BASE = "https://optcgapi.com/api";

// One optcgapi record -> our raw card shape (normalizeCard finishes the job).
function officialCardToRaw(c) {
  const category = normalizeCategory(c.card_type);
  const colors = String(c.card_color || "").trim().split(/[\s,/]+/).filter(Boolean).join(",").toLowerCase();
  return {
    id: c.card_set_id,
    cardNumber: c.card_set_id,
    name: c.card_name || "",
    category,
    cardType: category,
    color: colors,
    cost: category === "leader" ? "" : (c.card_cost ?? ""),
    life: category === "leader" ? (c.life ?? "") : "",
    power: c.card_power ?? "",
    counter: c.counter_amount ?? "",
    attribute: c.attribute || "",
    type: c.sub_types || "",
    subtype: c.sub_types || "",
    rarity: c.rarity || "",
    effect: c.card_text || "",
    image: c.card_image || "",
    collection: OFFICIAL_COLLECTION,
    setName: c.set_name || c.set_id || "",
    official: true,
    // Not a user upload: keeps Edit/Delete off these cards, and keeps them out
    // of the local-project / shared-library save paths.
    imported: false
  };
}

// Fetch every set's cards (plus starter-deck and promo cards) and flatten them.
async function fetchOfficialCardsFromApi() {
  const setsRes = await fetch(`${OPTCG_API_BASE}/allSets/`);
  if (!setsRes.ok) throw new Error(`sets HTTP ${setsRes.status}`);
  const sets = await setsRes.json();
  const setIds = (Array.isArray(sets) ? sets : []).map(s => s.set_id).filter(Boolean);

  const grab = url => fetch(url).then(r => (r.ok ? r.json() : [])).catch(() => []);
  const setCardGroups = await Promise.all(setIds.map(id => grab(`${OPTCG_API_BASE}/sets/${id}/`)));
  const extras = await Promise.all([
    grab(`${OPTCG_API_BASE}/allSTCards/`),
    grab(`${OPTCG_API_BASE}/allPromoCards/`)
  ]);

  const seen = new Set();
  const raws = [];
  [...setCardGroups.flat(), ...extras.flat()].forEach(c => {
    if (!c || !c.card_set_id) return;
    // DON!! cards aren't playable main-deck cards; they belong to the DON screen.
    if (String(c.card_type || "").toUpperCase().includes("DON")) return;
    if (seen.has(c.card_set_id)) return;
    seen.add(c.card_set_id);
    raws.push(officialCardToRaw(c));
  });
  return raws;
}

function readOfficialCardCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(OFFICIAL_CARDS_KEY) || "null");
    if (cached && Array.isArray(cached.cards)) return cached;
  } catch {}
  return null;
}

// Normalized official cards, from cache when fresh, else refetched. Never throws
// - a failed fetch falls back to any (even stale) cache, then to an empty list.
async function loadOfficialCards() {
  const cached = readOfficialCardCache();
  if (cached && (Date.now() - Number(cached.fetchedAt || 0)) < OFFICIAL_CARDS_TTL_MS) {
    return cached.cards.map(raw => normalizeCard(raw));
  }
  try {
    const raws = await fetchOfficialCardsFromApi();
    if (raws.length) {
      // Cache the normalized raws for reuse + the game. Best-effort: if it's too
      // big for localStorage we just refetch next time rather than failing.
      try { localStorage.setItem(OFFICIAL_CARDS_KEY, JSON.stringify({ fetchedAt: Date.now(), cards: raws })); } catch {}
      return raws.map(raw => normalizeCard(raw));
    }
  } catch (error) {
    console.warn("Official card list fetch failed, using cache if any:", error);
  }
  return cached ? cached.cards.map(raw => normalizeCard(raw)) : [];
}

// Lazily load the official list and fold it into the in-memory pool the first
// time it's needed (when the official collection is opened). Won't disturb the
// user's own cards - they win on any key collision.
let officialCardsLoaded = false;
let officialMergeInFlight = false;
async function ensureOfficialCardsLoaded() {
  if (officialCardsLoaded || officialMergeInFlight) return;
  officialMergeInFlight = true;
  state.officialLoading = true;
  renderCardGrid();
  try {
    const official = await loadOfficialCards();
    officialCardsLoaded = official.length > 0;
    const existing = new Set(state.cards.map(cardLibraryKey));
    const additions = official.filter(card => !existing.has(cardLibraryKey(card)));
    if (additions.length) {
      state.cards = dedupeCards([...state.cards, ...additions])
        .sort((a, b) => a.cardNumber.localeCompare(b.cardNumber));
      populateFilterOptions();
    }
  } catch (error) {
    console.warn("Official cards load failed:", error);
  } finally {
    officialMergeInFlight = false;
    state.officialLoading = false;
    renderAll();
  }
}

// Build the in-memory pool from the bundled cards, the shared library, this
// device's imported/local cards, and the shared tombstones. Pulled out of
// loadCardPool so the builder can paint the bundled cards immediately and then
// re-run once the shared library finishes downloading.
function assembleCardPool(loadedCards, sharedCards, deleted) {
  const byKey = new Map();
  loadedCards.forEach(card => {
    // NOTE: the tombstone set is keyed by the shared STORAGE key. app.js's
    // cardLibraryKey() returns a category-prefixed dedupe key
    // ("token:jjba-001:coll"), which never matches - use isCardTombstoned().
    // A deleted card must not come back from the bundled JSON file; that's
    // what made deleting a bundled card look like it silently failed.
    if (!isCardTombstoned(deleted, card)) byKey.set(cardLibraryKey(card), card);
  });
  // Shared copies win: they're the edited/newer version of a bundled card.
  sharedCards.forEach(card => byKey.set(cardLibraryKey(card), card));
  const pooledCards = [...byKey.values()];

  const loadedKeys = new Set(pooledCards.map(cardLibraryKey));
  const legacyCards = loadImportedCards()
    .map(normalizeImportedCard)
    .filter(card => !loadedKeys.has(cardLibraryKey(card)));

  // Cards saved to THIS device only (the fallback when the shared library
  // couldn't be written - e.g. auth not ready yet, rules not published, or a
  // network blip). Without merging these, a card would save, show for a moment,
  // then vanish on the next pool reload. Shared/bundled copies still win.
  legacyCards.forEach(card => loadedKeys.add(cardLibraryKey(card)));
  const localProjectCards = readLocalProjectCards()
    .map(normalizeImportedCard)
    .filter(card => !loadedKeys.has(cardLibraryKey(card))
      && !isCardTombstoned(deleted, card));

  return dedupeCards([
    ...pooledCards,
    ...legacyCards,
    ...localProjectCards
  ]).sort((a, b) => a.cardNumber.localeCompare(b.cardNumber));
}

// The last shared-library snapshot we successfully loaded. Kept so a reload can
// paint immediately WITHOUT dropping the shared cards it already had, and so a
// transient shared-load failure (a Firebase blip returning nothing) doesn't wipe
// every uploaded card - including DON!! cards, which live ONLY in the shared
// library and so would otherwise "appear then vanish" on the next reload.
let lastSharedPool = { cards: [], deleted: new Set() };
// Guards against overlapping loads: only the most recent call may write state.
let poolLoadToken = 0;

async function loadCardPool() {
  const token = ++poolLoadToken;
  try {
    const groups = await Promise.all(CARD_FILES.map(loadCardFile));
    const loadedCards = groups.flat();

    // Paint the collection picker RIGHT AWAY, but seed it with the LAST KNOWN
    // shared cards (not an empty set) so a reload never flashes the pool down to
    // just the bundled cards - that flash is what made a freshly-uploaded DON!!
    // card seem to disappear for a moment. First load has an empty snapshot, so
    // this is just the bundled cards then.
    if (token === poolLoadToken) {
      state.cards = assembleCardPool(loadedCards, lastSharedPool.cards, lastSharedPool.deleted);
      state.cardsLoading = false;
      state.sharedSyncing = true;
      populateFilterOptions();
      renderAll();
      updateImportStatus();
    }

    // Cards uploaded by players live ONLY in the shared library - they are not
    // written back into the bundled JSON files. Fetch them (downloads now run in
    // parallel) and merge them in without blocking that first paint.
    const fresh = await loadSharedCardsForPool();

    // If the read FAILED (offline, rules hiccup, dropped index read), keep the
    // last good snapshot instead of wiping every shared/DON!! card. A successful
    // read always wins - even an empty one, so real deletions still take effect.
    const useShared = fresh.ok ? fresh : lastSharedPool;
    lastSharedPool = useShared;

    // Only the most recent load writes state, so overlapping reloads can't clobber
    // a newer result with a staler one.
    if (token === poolLoadToken) {
      state.cards = assembleCardPool(loadedCards, useShared.cards, useShared.deleted);
      state.sharedSyncing = false;
      populateFilterOptions();
      renderAll();
      updateImportStatus();
    }

    // NOTE: the big official-card list is NOT loaded here - it would slow down
    // the whole builder. It's loaded lazily the first time you open the
    // "Official One Piece TCG" collection (see openCollection).
  } catch (error) {
    if (token !== poolLoadToken) return;
    state.cardsLoading = false;
    state.sharedSyncing = false;
    el.cardGrid.style.display = "";
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
    cardLibraryPromise = import("./js/firebase/cardLibraryService.js?v=collections-3")
      .catch(error => {
        console.warn("Shared card library unavailable:", error);
        cardLibraryUnavailable = true;
        return null;
      });
  }
  return cardLibraryPromise;
}

// The shared-library STORAGE key. MUST stay byte-for-byte identical to
// cardLibraryService.cardLibraryKey(), because tombstones (the `deleted` set)
// are keyed this way and are matched against it. Number + collection, sanitized
// to a legal Firebase path segment, with the plain number kept when there's no
// collection (legacy / bundled cards).
function projectCardKey(card) {
  const number = String(card?.cardNumber || card?.id || "").trim().replace(/[.#$/\[\]]/g, "-");
  if (!number) return "";
  const collection = String(card?.collection || "").trim().replace(/[.#$/\[\]]/g, "-");
  return collection ? `${number}__${collection}` : number;
}

// The pre-collection storage key for the same card. Tombstones written before
// collections were part of the key live at the bare number, so a card must be
// checked against BOTH to stay deleted after this migration.
function legacyProjectKey(card) {
  return String(card?.cardNumber || card?.id || "").trim().replace(/[.#$/\[\]]/g, "-");
}

function isCardTombstoned(deleted, card) {
  return deleted.has(projectCardKey(card)) || deleted.has(legacyProjectKey(card));
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
    // Never auto-delete on a parse hiccup - that would silently wipe the user's
    // device-only cards. Just treat it as empty for this read.
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
    if (key && !isCardTombstoned(deleted, card)) merged.set(key, card);
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
    // Key by number+collection so the same set number in two collections keeps
    // both on-device (mirrors the shared library). cardNumber below stays the
    // human number, never this compound key.
    const key = projectCardKey(card);
    if (!key) return result;
    const number = String(card.cardNumber || card.id || "").trim();
    const effects = dedupeEffects(card.effects || []);
    const effectKeys = new Set(effects.map(effectDedupeKey));
    const customEffectV2 = dedupeCustomEffectV2([], card.customEffectV2)
      .filter(effect => !effectKeys.has(effectDedupeKey(effect)));
    const effectBlocks = dedupeEffects(card.effectBlocks || []);
    result[key] = {
      ...card,
      id: card.id || number || key,
      cardNumber: number || key,
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
      return "shared";
    } catch (error) {
      console.warn("Shared card save failed, falling back:", error);
      if (!sharedLibraryWarned) {
        sharedLibraryWarned = true;
        toast("Saved to this browser only — shared library unreachable (see Settings)");
      }
    }
  }

  // No library (offline / static-only): keep the whole-list local fallback.
  // Returns "local" so bulk callers can tell shared saves from device-only ones.
  const existing = (await loadProjectCards())
    .filter(other => projectCardKey(other) !== projectCardKey(card));
  return saveProjectCardsLocally([...existing, card]) ? "local" : false;
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

// ─────────────────────────────────────────────────────────────────────────
// Custom DON!! decks
//
// Works like the deck builder, but for DON!!. DON!! cards are shared library
// cards flagged `donCard: true` (in a hidden "don-cards" collection so they
// never show up in the normal card pool). A DON!! deck is a saved list of up to
// 10 of those cards, WITH each card's art embedded so the game never has to look
// them up. Players pick a deck at game start; no deck / no selection falls back
// to the standard 10 DON!!. Saved decks live per-device (localStorage) like the
// main saved decks; the DON!! cards themselves are shared for everyone.
// ─────────────────────────────────────────────────────────────────────────
const DON_DECKS_KEY = "custom-don-decks-v1";
const DON_ACTIVE_DECK_KEY = "custom-don-active-deck-v1";
const DON_COLLECTION = "don-cards";
const DON_DECK_MAX = 10;

// The deck currently being built in the DON!! screen: { editId, cards:[{n,art,name}] }.
let donBuild = { editId: "", cards: [] };

function getDonDecks() {
  try {
    const list = JSON.parse(localStorage.getItem(DON_DECKS_KEY) || "[]");
    return Array.isArray(list) ? list.filter(d => d && Array.isArray(d.cards)) : [];
  } catch { return []; }
}

function saveDonDecks(list) {
  try { localStorage.setItem(DON_DECKS_KEY, JSON.stringify(list || [])); } catch {}
}

function getActiveDonDeckId() {
  try { return localStorage.getItem(DON_ACTIVE_DECK_KEY) || ""; } catch { return ""; }
}

function setActiveDonDeckId(id) {
  try {
    if (id) localStorage.setItem(DON_ACTIVE_DECK_KEY, id);
    else localStorage.removeItem(DON_ACTIVE_DECK_KEY);
  } catch {}
}

// Every DON!! card currently in the shared pool.
function getDonPoolCards() {
  return (state.cards || []).filter(card => card && card.donCard);
}

// Open (or refresh) the whole DON!! screen.
function openDonDeckScreen() {
  resetDonBuild();
  hideAddDonCardForm();
  renderDonCardPool();
  renderDonDeckCurrent();
  renderDonDeckList();
}

function resetDonBuild() {
  donBuild = { editId: "", cards: [] };
  if (el.donDeckName) el.donDeckName.value = "";
  if (el.donDeckEditId) el.donDeckEditId.value = "";
  if (el.cancelDonDeckEdit) el.cancelDonDeckEdit.hidden = true;
  if (el.saveDonDeck) el.saveDonDeck.textContent = "Save Deck";
  if (el.donDeckStatus) el.donDeckStatus.textContent = "Ready";
  renderDonDeckCurrent();
}

// ── Adding a DON!! card to the shared pool ────────────────────────────────
function showAddDonCardForm() {
  if (!el.addDonCardForm) return;
  el.addDonCardForm.hidden = false;
  if (el.donCardName) el.donCardName.value = "";
  if (el.donCardArtUrl) el.donCardArtUrl.value = "";
  if (el.donCardArtImage) el.donCardArtImage.value = "";
  if (el.donCardStatus) el.donCardStatus.textContent = "";
  el.donCardArtUrl?.focus();
}

function hideAddDonCardForm() {
  if (el.addDonCardForm) el.addDonCardForm.hidden = true;
}

async function saveDonCard(event) {
  event.preventDefault();
  const name = (el.donCardName?.value || "").trim();
  const file = el.donCardArtImage?.files?.[0];
  const url = (el.donCardArtUrl?.value || "").trim();
  if (!file && !url) { toast("Add an image URL or upload a file for the DON!! card"); return; }

  if (el.donCardStatus) el.donCardStatus.textContent = "Saving image…";
  let image = "";
  try {
    if (file) image = await readFileAsDataUrl(file);
    else image = (await fetchRemoteImageAsDataUrl(url)) || url; // permanent copy
  } catch { image = url; }
  if (!image) { toast("Could not read that image"); if (el.donCardStatus) el.donCardStatus.textContent = ""; return; }

  // Compress the art exactly like the card creator does before saving. An
  // UPLOADED file becomes a full-resolution base64 data URL that can be several
  // megabytes - too big for the shared write to store, which is why file-based
  // DON!! uploads got stuck/vanished while image URLs (a short string, or a
  // proxied+shrunk copy) worked fine. compressImageDataUrl leaves plain URLs
  // untouched, so URL uploads behave exactly as before.
  if (el.donCardStatus) el.donCardStatus.textContent = "Optimizing image…";
  image = await compressImageDataUrl(image);

  // A unique DON!! card number; the id/cardNumber convention matches other cards.
  // Store the RAW card shape (with `image`, like creationCardFromForm) - NOT a
  // pre-normalized one - so the art survives the save→reload round-trip
  // (normalizeCard reads raw.image on load).
  const cardNumber = `DON-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
  const card = {
    id: cardNumber,
    cardNumber,
    name: name || "DON!!",
    category: "character",
    cardType: "character",
    color: "colorless",
    colors: ["colorless"],
    image,
    altArt: "",
    collection: DON_COLLECTION,
    donCard: true,
    imported: true,
    importedAt: new Date().toISOString(),
    untapId: cardNumber
  };

  // Show it in the pool IMMEDIATELY, before any network call, so it can never
  // seem to "not appear" while the shared library round-trips.
  const normalized = normalizeCard(card);
  const ensureInPool = () => {
    if (!state.cards.some(c => cardLibraryKey(c) === cardLibraryKey(normalized))) {
      state.cards.push(normalized);
    }
  };
  ensureInPool();
  hideAddDonCardForm();
  renderDonCardPool();

  // Publish to the shared library, but NEVER let a stalled write hang the UI on
  // "Publishing…" forever (which is what made uploads look permanently stuck).
  // Race it against a timeout; whatever happens, the card is also saved to this
  // device below, so it survives a reload and can be used to build a DON!! deck.
  if (el.donCardStatus) el.donCardStatus.textContent = "Publishing…";
  let result = null;
  try {
    result = await Promise.race([
      publishSingleCard(card),
      new Promise((_, reject) => setTimeout(() => reject(new Error("publish-timeout")), 15000))
    ]);
  } catch (error) {
    console.warn("DON!! card publish stalled or failed:", error);
  }

  // If it didn't make it to the shared library, guarantee a device-local copy so
  // it can't vanish on reload. (publishSingleCard already writes locally when it
  // returns "local"; this also covers the timeout case, where it never returned.)
  if (result !== "shared") {
    try {
      const existing = (await loadProjectCards())
        .filter(other => projectCardKey(other) !== projectCardKey(card));
      if (saveProjectCardsLocally([...existing, card])) result = result || "local";
    } catch (error) {
      console.warn("Could not save DON!! card locally:", error);
    }
  }

  // Reconcile with the shared library in the background - don't block the status
  // (or the user) on it, since that reload is exactly what could stall.
  Promise.resolve(loadCardPool())
    .then(() => { ensureInPool(); renderDonCardPool(); })
    .catch(() => {});

  ensureInPool();
  renderDonCardPool();

  // ALWAYS resolve the status - never leave it stuck on "Publishing…".
  if (el.donCardStatus) {
    el.donCardStatus.textContent = result === "shared"
      ? "Added to the shared pool ✓"
      : "Saved on this device — shared library was unreachable";
  }
  toast(result === "shared"
    ? "DON!! card added to the shared pool"
    : "DON!! card saved (this device only)");
}

async function deleteDonCard(cardNumber) {
  const card = getDonPoolCards().find(c => c.cardNumber === cardNumber);
  if (!card) return;
  // Reuse the standard imported-card delete (confirm + shared-library removal +
  // pool reload), then refresh the DON!! screen.
  await deleteImportedCard(card.id);
  donBuild.cards = donBuild.cards.filter(c => c.n !== cardNumber);
  renderDonCardPool();
  renderDonDeckCurrent();
}

// ── Building a deck from the pool ─────────────────────────────────────────
function renderDonCardPool() {
  if (!el.donCardPool) return;
  const cards = getDonPoolCards();
  el.donCardPool.innerHTML = "";
  if (!cards.length) {
    el.donCardPool.innerHTML = `<div class="don-pool-empty">No DON!! cards yet — use “+ Add DON!! Card” to add art everyone can build with.</div>`;
    return;
  }
  cards.forEach(card => {
    const inDeck = donBuild.cards.filter(c => c.n === card.cardNumber).length;
    const tile = document.createElement("div");
    tile.className = "don-pool-card";
    tile.innerHTML = `
      <div class="don-pool-art">${card.imageUrl ? `<img src="${card.imageUrl}" alt="">` : `<span>ド!!</span>`}</div>
      <div class="don-pool-name"></div>
      <div class="don-pool-actions">
        <button class="red-button" type="button" data-add-donpool="${card.cardNumber}">Add${inDeck ? ` (${inDeck})` : ""}</button>
        <button class="ghost danger" type="button" data-del-donpool="${card.cardNumber}">✕</button>
      </div>`;
    tile.querySelector(".don-pool-name").textContent = card.name || "DON!!";
    el.donCardPool.appendChild(tile);
  });
}

function addDonCardToBuild(cardNumber) {
  if (donBuild.cards.length >= DON_DECK_MAX) { toast(`A DON!! deck holds at most ${DON_DECK_MAX} cards`); return; }
  const card = getDonPoolCards().find(c => c.cardNumber === cardNumber);
  if (!card) return;
  donBuild.cards.push({ n: card.cardNumber, art: card.imageUrl || "", name: card.name || "DON!!" });
  renderDonDeckCurrent();
  renderDonCardPool();
}

function removeDonCardFromBuild(index) {
  donBuild.cards.splice(index, 1);
  renderDonDeckCurrent();
  renderDonCardPool();
}

function renderDonDeckCurrent() {
  if (el.donDeckCount) el.donDeckCount.textContent = String(donBuild.cards.length);
  if (!el.donDeckCurrent) return;
  el.donDeckCurrent.innerHTML = "";
  if (!donBuild.cards.length) {
    el.donDeckCurrent.innerHTML = `<span class="don-deck-empty-hint">Add DON!! cards from the pool below (up to ${DON_DECK_MAX}).</span>`;
    return;
  }
  donBuild.cards.forEach((c, index) => {
    const chip = document.createElement("div");
    chip.className = "don-deck-chip";
    chip.innerHTML = `
      <div class="don-deck-chip-art">${c.art ? `<img src="${c.art}" alt="">` : `<span>ド!!</span>`}</div>
      <button class="don-deck-chip-remove" type="button" data-remove-donbuild="${index}" title="Remove">✕</button>`;
    el.donDeckCurrent.appendChild(chip);
  });
}

function clearDonBuild() {
  donBuild.cards = [];
  renderDonDeckCurrent();
  renderDonCardPool();
}

function saveDonDeck() {
  const name = (el.donDeckName?.value || "").trim();
  if (!name) { toast("Name your DON!! deck"); return; }
  if (!donBuild.cards.length) { toast("Add at least one DON!! card"); return; }

  const decks = getDonDecks();
  const existing = donBuild.editId ? decks.find(d => d.id === donBuild.editId) : null;
  const cards = donBuild.cards.map(c => ({ n: c.n, art: c.art || "", name: c.name || "DON!!" }));
  if (existing) {
    existing.name = name;
    existing.cards = cards;
  } else {
    decks.push({ id: `don-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, cards });
  }
  saveDonDecks(decks);
  const wasEditing = Boolean(existing);
  resetDonBuild();
  renderDonDeckList();
  toast(wasEditing ? "DON!! deck updated" : "DON!! deck saved");
}

function editDonDeck(id) {
  const deck = getDonDecks().find(d => d.id === id);
  if (!deck) return;
  donBuild = {
    editId: deck.id,
    cards: (deck.cards || []).map(c => ({ n: c.n, art: c.art || "", name: c.name || "DON!!" }))
  };
  if (el.donDeckName) el.donDeckName.value = deck.name || "";
  if (el.cancelDonDeckEdit) el.cancelDonDeckEdit.hidden = false;
  if (el.saveDonDeck) el.saveDonDeck.textContent = "Update Deck";
  if (el.donDeckStatus) el.donDeckStatus.textContent = "Editing…";
  renderDonDeckCurrent();
  renderDonCardPool();
  el.donDeckName?.focus();
}

function deleteDonDeck(id) {
  const decks = getDonDecks().filter(d => d.id !== id);
  saveDonDecks(decks);
  if (getActiveDonDeckId() === id) setActiveDonDeckId("");
  renderDonDeckList();
  toast("DON!! deck deleted");
}

function useDonDeck(id) {
  setActiveDonDeckId(id || "");
  renderDonDeckList();
  const deck = getDonDecks().find(d => d.id === id);
  toast(id && deck ? `Using "${deck.name}" DON!! deck in games` : "Using standard DON!!");
}

function renderDonDeckList() {
  if (!el.donDeckList) return;
  const decks = getDonDecks();
  const activeId = getActiveDonDeckId();
  el.donDeckList.innerHTML = "";

  // The always-present standard option.
  const defaultRow = document.createElement("div");
  defaultRow.className = "don-deck-row" + (activeId ? "" : " active");
  defaultRow.innerHTML = `
    <div class="don-deck-art don-deck-art-default"><span>ド!!</span></div>
    <div class="don-deck-meta">
      <strong>Standard DON!!</strong>
      <small>10 DON!! · default art</small>
    </div>
    <div class="don-deck-row-actions">
      <button class="ghost" type="button" data-use-don="">${activeId ? "Use" : "In use"}</button>
    </div>`;
  el.donDeckList.appendChild(defaultRow);

  decks.forEach(deck => {
    const isActive = activeId === deck.id;
    const row = document.createElement("div");
    row.className = "don-deck-row" + (isActive ? " active" : "");
    const thumbs = (deck.cards || []).slice(0, 5)
      .map(c => c.art ? `<img src="${c.art}" alt="">` : `<span>ド!!</span>`).join("");
    row.innerHTML = `
      <div class="don-deck-art don-deck-art-stack">${thumbs || `<span>ド!!</span>`}</div>
      <div class="don-deck-meta">
        <strong></strong>
        <small>${(deck.cards || []).length} DON!!</small>
      </div>
      <div class="don-deck-row-actions">
        <button class="ghost" type="button" data-use-don="${deck.id}">${isActive ? "In use" : "Use"}</button>
        <button class="ghost" type="button" data-edit-don="${deck.id}">Edit</button>
        <button class="ghost" type="button" data-export-don="${deck.id}">Export</button>
        <button class="ghost danger" type="button" data-delete-don="${deck.id}">Delete</button>
      </div>`;
    row.querySelector(".don-deck-meta strong").textContent = deck.name || "DON!! deck";
    el.donDeckList.appendChild(row);
  });
}

function exportDonDeck(id) {
  const deck = getDonDecks().find(d => d.id === id);
  if (!deck) return;
  const payload = JSON.stringify({ type: "custom-don-deck", name: deck.name, cards: deck.cards });
  navigator.clipboard?.writeText(payload).then(
    () => toast("DON!! deck copied — share the text to let others import it"),
    () => window.prompt("Copy this DON!! deck code:", payload)
  );
}

function importDonDeckFromText() {
  const text = window.prompt("Paste a DON!! deck code:");
  if (!text) return;
  let data;
  try { data = JSON.parse(text.trim()); } catch { toast("That doesn't look like a DON!! deck code"); return; }
  if (!data || data.type !== "custom-don-deck" || !data.name || !Array.isArray(data.cards)) {
    toast("Invalid DON!! deck code"); return;
  }
  const decks = getDonDecks();
  decks.push({
    id: `don-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: String(data.name).slice(0, 60),
    cards: data.cards.slice(0, DON_DECK_MAX).map(c => ({
      n: String(c.n || ""),
      art: typeof c.art === "string" ? c.art : "",
      name: String(c.name || "DON!!").slice(0, 60)
    }))
  });
  saveDonDecks(decks);
  renderDonDeckList();
  toast(`Imported DON!! deck "${data.name}"`);
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

// Some card sites (Discord, Ultimate TCG Card Maker) hand out image URLs with a
// short-lived signed token - they load for a day, then 404 and the card goes
// blank. To make an imported card PERMANENT we pull its image NOW (while the
// token is still valid) and store a compressed copy inline, so it never depends
// on that link again.
//
// The image hosts don't send CORS headers, so a plain fetch/canvas is blocked.
// We route through a public image proxy (wsrv.nl) that fetches the image
// server-side and re-serves it WITH CORS, letting us read the bytes and inline
// them. Returns a data: URL, or null if the proxy/image is unreachable (caller
// then keeps the original URL as a best-effort fallback).
const IMAGE_PROXY = "https://wsrv.nl/";
async function fetchRemoteImageAsDataUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  // Data URLs and already-permanent hosts don't need proxying.
  if (url.startsWith("data:")) return url;

  const proxied = `${IMAGE_PROXY}?url=${encodeURIComponent(url)}` +
    `&w=${IMPORT_IMAGE_MAX_WIDTH}&we&output=webp&q=82`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(proxied, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.size || !/^image\//.test(blob.type)) return null;
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
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


// ── Alt-art rows in the card creator ─────────────────────
// Each "Add alt art" click appends a row (URL box + file picker + remove). An
// EXISTING alt art (when editing) is added as a row that already holds its image
// and shows a thumbnail, so it's kept unless the row is removed.
function makeAltArtRow(existingImage = "") {
  const row = document.createElement("div");
  row.className = "alt-art-row";
  row._existingImage = existingImage || "";
  row.innerHTML = `
    <div class="alt-art-thumb"${existingImage ? "" : " hidden"}>${existingImage ? `<img src="${escapeAttr(existingImage)}" alt="">` : ""}</div>
    <div class="alt-art-fields">
      <input type="url" class="alt-art-url" placeholder="Alt art image URL">
      <input type="file" class="alt-art-file" accept="image/png,image/jpeg,image/webp">
    </div>
    <button type="button" class="alt-art-remove" title="Remove this alt art">✕</button>
  `;
  row.querySelector(".alt-art-remove").addEventListener("click", () => row.remove());
  return row;
}

function addAltArtRow(existingImage = "") {
  if (!el.creationAltArtList) return;
  el.creationAltArtList.appendChild(makeAltArtRow(existingImage));
}

function clearAltArtRows() {
  if (el.creationAltArtList) el.creationAltArtList.innerHTML = "";
}

// Resolve every alt-art row to a final image (uploaded file > pasted URL >
// existing image), compressed and deduped, dropping empty rows.
async function collectAltArtSources() {
  const rows = el.creationAltArtList
    ? [...el.creationAltArtList.querySelectorAll(".alt-art-row")]
    : [];
  const arts = [];
  for (const row of rows) {
    const file = row.querySelector(".alt-art-file")?.files?.[0];
    const url = (row.querySelector(".alt-art-url")?.value || "").trim();
    let img = "";
    if (file) img = await compressImageDataUrl(await readFileAsDataUrl(file));
    else if (url) img = await compressImageDataUrl((await fetchRemoteImageAsDataUrl(url)) || url);
    else if (row._existingImage) img = row._existingImage;
    if (img) arts.push(img);
  }
  return [...new Set(arts.filter(Boolean))];
}

function creationCardFromForm(imageDataUrl, altArts = []) {
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
    altArts: Array.isArray(altArts) ? altArts.filter(Boolean) : (altArts ? [altArts] : []),
    // Which collection to file this card under. Defaults to the collection the
    // browser is currently showing, then to Goldrush717's Bleach.
    collection: normalizeCollectionSlug(
      el.creationCollection?.value || state.activeCollection || COLLECTION_DEFAULT
    ),
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

  // Set / card number is required.
  if (!el.creationCardNumber.value.trim()) {
    toast("Set / card number is required (e.g. JJBA-001)");
    return;
  }

  // Card type must be chosen (the dropdown starts on a blank placeholder).
  if (!el.creationCategory.value) {
    toast("Choose a card type");
    return;
  }

  // A colour is required (there's no "colorless" any more) - a card with no
  // colour would be hidden the moment a leader is picked.
  if (!csvValues(el.creationColors.value).length) {
    toast("Choose a color for the card");
    return;
  }

  // Cost (or Life, for leaders) must be chosen.
  if (el.creationCost.value === "") {
    toast(el.creationCategory.value === "leader" ? "Choose a life value" : "Choose a cost");
    return;
  }

  // Discord attachment links (media.discordapp.net / cdn.discordapp.com) carry a
  // signed expiry token and STOP WORKING after a day or two, which silently blanks
  // the card later. Warn and require the image be uploaded instead so it's stored
  // permanently. (This is what happened to the "Pig's Deltarune" cards.)
  if (imageUrl && /(?:media|cdn)\.discordapp\.(?:net|com)/i.test(imageUrl) && !file) {
    toast("Discord image links expire — upload the image file instead so it stays.");
    return;
  }

  // Prefer an uploaded file (permanent). For a pasted URL, try to store a
  // permanent copy now (via the image proxy) so it can't expire later; if that
  // can't be reached, fall back to keeping the link.
  let imageSource;
  if (imageUrl) {
    imageSource = (await fetchRemoteImageAsDataUrl(imageUrl)) || imageUrl;
  } else if (file) {
    imageSource = await compressImageDataUrl(await readFileAsDataUrl(file));
  } else {
    imageSource = state.creationImageData;
  }

  // Alt arts: whatever the "Add alt art" rows resolve to (uploaded files, pasted
  // URLs, or kept-existing images). Rows the user removed are simply gone, so no
  // separate "remove alt art" control is needed any more.
  const altArts = await collectAltArtSources();

  // Compress just this card's artwork, then publish only this card - no need to
  // load, diff and re-upload the entire library to add one entry.
  const [card] = await compressImportedCardImages([creationCardFromForm(imageSource, altArts)]);
  if (!await publishSingleCard(card)) return;

  // Editing a card so its IDENTITY moves - a new number OR a new collection -
  // used to leave the original behind as a duplicate: the old entry was filtered
  // out of the list above, but the sync deliberately never deletes by omission
  // (that behaviour once wiped the whole library). Remove the old entry
  // explicitly. Identity is now number+collection, so a card moved to another
  // collection (its number unchanged) must clear its old-collection entry too.
  // Deleting by the old card object uses its exact stored key, which correctly
  // targets a legacy number-only entry as well as a new compound one.
  const previousKey = state.editingCardId;
  const previousCard = previousKey ? getCard(previousKey) : null;
  const previousStorageKey = previousCard
    ? (previousCard.__storageKey || projectCardKey(previousCard))
    : String(previousKey || "").trim();
  const newStorageKey = projectCardKey(card);
  if (previousStorageKey && previousStorageKey !== newStorageKey) {
    const library = await getCardLibrary();
    try {
      if (library) await library.deleteSharedCard(previousCard || previousStorageKey);
    } catch (error) {
      console.warn("Could not remove the pre-edit card:", error);
    }
    delete state.deck[previousKey];
    if (state.leaderId === previousKey) state.leaderId = card.cardNumber;
    saveDeck(false);
  }

  // Reload the pool FIRST so the just-saved card is in state.cards, THEN clear
  // the form. clearCreationForm auto-fills the next card number via
  // nextImportedCardNumber(), which scans state.cards - if we cleared before the
  // reload it would hand out the SAME number again and the next save would
  // overwrite this card. (That's the "new card replaces the last one" bug.)
  toast(`${card.name} saved`);
  await loadCardPool();
  clearCreationForm(true);
}

function clearCreationForm(resetNumber = true) {
  el.cardCreationForm?.reset();
  state.editingCardId = "";
  state.creationImageData = "";
  if (el.creationImageUrl) el.creationImageUrl.value = "";
  if (resetNumber && el.creationCardNumber) el.creationCardNumber.value = nextImportedCardNumber();
  if (el.creationImagePreview) el.creationImagePreview.innerHTML = `<span>No image yet</span>`;
  if (el.creationStatus) el.creationStatus.textContent = "Ready";
  // Start a new card with no alt-art rows.
  clearAltArtRows();
  // Keep filing new cards into whatever collection you're browsing.
  preselectCreationCollection();
}

// Default the creation form's Collection dropdown to the collection currently
// open in the browser (if any), so cards you add while inside a collection go
// straight into it.
function preselectCreationCollection() {
  if (!el.creationCollection || !state.activeCollection) return;
  el.creationCollection.value = state.activeCollection;
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
      const { tombstoned } = await library.deleteSharedCard(card || card.cardNumber || cardId);
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

// Delete EVERY card in a collection from the shared library. Guarded by a
// confirm because it affects all players and can't be undone. Used by the
// code-locked collection tools in Settings.
async function clearCollectionCards(slug) {
  if (!slug) return true;

  const name = collectionName(slug);
  const cards = state.cards.filter(card => (card.collection || COLLECTION_DEFAULT) === slug);

  if (!cards.length) {
    toast(`${name} is already empty`);
    return true;
  }

  if (!window.confirm(
    `Are you sure you want to delete ALL ${cards.length} cards in "${name}"?\n\n` +
    `This removes them from the shared library for everyone and can't be undone.`
  )) return false;

  const library = await getCardLibrary();
  let failed = 0;

  if (library) {
    for (const card of cards) {
      try {
        await library.deleteSharedCard(card);
      } catch (error) {
        console.error("Failed to delete", card.cardNumber, error);
        failed++;
      }
      delete state.deck[card.id];
      if (state.leaderId === card.id) state.leaderId = "";
    }
  } else {
    // Offline / static-only fallback: drop them from the local project store.
    const remaining = (await loadProjectCards())
      .filter(existing => (existing.collection || COLLECTION_DEFAULT) !== slug);
    await saveProjectCardsLocally(remaining);
  }

  saveDeck(false);
  await loadCardPool();
  toast(failed
    ? `Cleared ${name}, but ${failed} card${failed === 1 ? "" : "s"} may return (publish database.rules.json)`
    : `Cleared all cards from ${name}`);
  return true;
}

// Remove a collection entirely: clear its cards, then delete the collection
// entry itself. Built-in collections can't be deleted (they're shipped in code)
// so they just end up empty.
async function removeCollectionEntirely(slug) {
  if (!slug) return;
  const name = collectionName(slug);
  const isBuiltIn = BUILTIN_COLLECTIONS.some(entry => entry.slug === slug);

  if (!window.confirm(
    `Remove the collection "${name}"?\n\n` +
    `This deletes all of its cards AND the collection itself for everyone.` +
    (isBuiltIn ? `\n\n(This is a built-in set, so its tile stays but will be empty.)` : ``)
  )) return;

  // clearCollectionCards has its own confirm; skip a double prompt by clearing
  // directly here.
  const cards = state.cards.filter(card => (card.collection || COLLECTION_DEFAULT) === slug);
  const library = await getCardLibrary();
  if (library) {
    for (const card of cards) {
      try { await library.deleteSharedCard(card); } catch {}
      delete state.deck[card.id];
    }
    try { if (library.deleteSharedCollection) await library.deleteSharedCollection(slug); } catch {}
  }

  // Drop it from the in-memory + local custom list (built-ins persist in code).
  customCollections = customCollections.filter(entry => entry.slug !== slug);
  saveLocalCustomCollections(customCollections);
  applyCustomCollections(customCollections);

  saveDeck(false);
  await loadCardPool();
  populateCollectionSelects();
  populateCollectionManageSelect();
  toast(isBuiltIn ? `Emptied ${name}` : `Removed ${name}`);
}

// ── Code-locked collection management (Settings) ─────────
const COLLECTION_MANAGE_CODE = "5433";

function populateCollectionManageSelect() {
  const select = document.getElementById("collectionManageSelect");
  if (!select) return;
  const previous = select.value;
  select.innerHTML = CARD_COLLECTIONS
    .map(entry => `<option value="${entry.slug}">${escapeHtml(entry.name)}</option>`)
    .join("");
  if (previous && CARD_COLLECTIONS.some(entry => entry.slug === previous)) {
    select.value = previous;
  }
}

// ── Custom board images (playmat / card back / DON!! back) ────────────────
// Uploaded in Settings, stored as data URLs in localStorage, and read by the
// game (self.js applyCustomImages) as CSS variables. Personal per device. Keys
// must match self.js's CUSTOM_IMAGE_KEYS.
const CUSTOM_IMAGE_KEYS = {
  playmat: "custom-img-playmat-v1",
  cardBack: "custom-img-cardback-v1",
  donBack: "custom-img-donback-v1"
};
const CUSTOM_IMAGE_PREVIEW_IDS = {
  playmat: "customPlaymatPreview",
  cardBack: "customCardBackPreview",
  donBack: "customDonBackPreview"
};

function readCustomImage(kind) {
  try { return localStorage.getItem(CUSTOM_IMAGE_KEYS[kind]) || ""; } catch { return ""; }
}

function refreshCustomImagePreview(kind) {
  const data = readCustomImage(kind);
  const preview = document.getElementById(CUSTOM_IMAGE_PREVIEW_IDS[kind]);
  if (preview) {
    preview.style.backgroundImage = data ? `url("${data}")` : "";
    preview.classList.toggle("has-image", Boolean(data));
  }
  const clearBtn = document.querySelector(`[data-custom-image-clear="${kind}"]`);
  if (clearBtn) clearBtn.hidden = !data;
}

async function handleCustomImageUpload(kind, file) {
  if (!file) return;
  try {
    const compressed = await compressImageDataUrl(await readFileAsDataUrl(file));
    localStorage.setItem(CUSTOM_IMAGE_KEYS[kind], compressed);
    refreshCustomImagePreview(kind);
    toast("Image saved — it shows in your next game");
  } catch (error) {
    console.warn(error);
    // localStorage quota is the usual failure for a big image.
    toast("Couldn't save that image — try a smaller one");
  }
}

function clearCustomImage(kind) {
  try { localStorage.removeItem(CUSTOM_IMAGE_KEYS[kind]); } catch {}
  refreshCustomImagePreview(kind);
  toast("Image removed");
}

function setupCustomImages() {
  document.querySelectorAll("[data-custom-image-input]").forEach(input => {
    input.addEventListener("change", event => {
      const kind = input.getAttribute("data-custom-image-input");
      handleCustomImageUpload(kind, event.target.files?.[0]);
      input.value = "";
    });
  });
  document.querySelectorAll("[data-custom-image-clear]").forEach(btn => {
    btn.addEventListener("click", () => clearCustomImage(btn.getAttribute("data-custom-image-clear")));
  });
  Object.keys(CUSTOM_IMAGE_KEYS).forEach(refreshCustomImagePreview);
}

function setupCollectionManagement() {
  const codeInput = document.getElementById("collectionManageCode");
  const unlockBtn = document.getElementById("collectionManageUnlock");
  const lockedRow = document.getElementById("collectionManageLocked");
  const panel = document.getElementById("collectionManagePanel");
  const select = document.getElementById("collectionManageSelect");
  const clearBtn = document.getElementById("collectionClearContents");
  const removeBtn = document.getElementById("collectionRemove");
  if (!unlockBtn || !panel) return;

  const unlock = () => {
    if (String(codeInput?.value || "").trim() !== COLLECTION_MANAGE_CODE) {
      toast("Wrong code");
      return;
    }
    if (lockedRow) lockedRow.hidden = true;
    panel.hidden = false;
    populateCollectionManageSelect();
  };
  unlockBtn.addEventListener("click", unlock);
  codeInput?.addEventListener("keydown", event => { if (event.key === "Enter") unlock(); });

  clearBtn?.addEventListener("click", () => clearCollectionCards(select?.value));
  removeBtn?.addEventListener("click", () => removeCollectionEntirely(select?.value));
}

// New / edit collection dialog. slug = null creates a new one; otherwise edits
// the existing collection's name + cover image.
function openCollectionEditor(slug = null) {
  const existing = slug ? CARD_COLLECTIONS.find(entry => entry.slug === slug) : null;
  document.getElementById("collectionEditorOverlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "collectionEditorOverlay";
  overlay.className = "collection-editor-overlay";
  overlay.innerHTML = `
    <div class="collection-editor">
      <h2>${existing ? "Edit collection" : "New collection"}</h2>
      <label>Name
        <input type="text" id="colEditName" maxlength="40" placeholder="e.g. My Custom Set" value="${escapeAttr(existing?.name || "")}">
      </label>
      <label>Cover image URL <small style="opacity:.6">(optional)</small>
        <input type="url" id="colEditImageUrl" placeholder="https://…" value="${escapeAttr(existing?.image && !String(existing.image).startsWith("data:") ? existing.image : "")}">
      </label>
      <label>…or upload an image
        <input type="file" id="colEditImageFile" accept="image/png,image/jpeg,image/webp">
      </label>
      <div class="collection-editor-preview" id="colEditPreview">${
        existing?.image ? `<img src="${escapeAttr(existing.image)}" alt="">` : `<span>No image</span>`
      }</div>
      <div class="collection-editor-actions">
        <button type="button" class="ghost" id="colEditCancel">Cancel</button>
        <button type="button" class="red-button" id="colEditSave">${existing ? "Save changes" : "Create collection"}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  let uploadedDataUrl = "";
  const preview = overlay.querySelector("#colEditPreview");
  const urlInput = overlay.querySelector("#colEditImageUrl");
  const fileInput = overlay.querySelector("#colEditImageFile");

  const refreshPreview = (src) => {
    preview.innerHTML = src ? `<img src="${escapeAttr(src)}" alt="">` : `<span>No image</span>`;
  };

  urlInput.addEventListener("input", () => { uploadedDataUrl = ""; refreshPreview(urlInput.value.trim()); });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      uploadedDataUrl = await compressImageDataUrl(await readFileAsDataUrl(file));
      urlInput.value = "";
      refreshPreview(uploadedDataUrl);
    } catch (error) {
      toast("Could not read that image");
    }
  });

  const close = () => overlay.remove();
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  overlay.querySelector("#colEditCancel").addEventListener("click", close);

  overlay.querySelector("#colEditSave").addEventListener("click", async () => {
    const name = overlay.querySelector("#colEditName").value.trim();
    if (!name) { toast("Give the collection a name"); return; }
    const image = uploadedDataUrl || urlInput.value.trim() || existing?.image || "";
    const targetSlug = existing?.slug || collectionSlugFromName(name);
    close();
    await saveCollection({ slug: targetSlug, name, image });
    toast(existing ? "Collection updated" : `Created "${name}"`);
    // Jump straight into a brand-new collection so it's obvious it worked.
    if (!existing) openCollection(targetSlug);
  });

  overlay.querySelector("#colEditName").focus();
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
  // Rebuild the alt-art rows from this card's existing arts, each holding its
  // stored image (kept unless the row is removed). New rows can be added on top.
  clearAltArtRows();
  cardArtList(card).slice(1).forEach(art => addAltArtRow(art));
  el.creationCardNumber.value = card.cardNumber || card.id;
  el.creationName.value = card.name || "";
  el.creationCategory.value = normalizeCategory(card.category || card.cardType);
  if (el.creationCollection) el.creationCollection.value = normalizeCollectionSlug(card.collection);
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

// ── Share a deck as text ─────────────────────────────────
// Format is deliberately simple and human-readable so it survives being pasted
// into chat/Discord and back out:
//
//   # Deck Name
//   Leader: BLH1-002
//   4x BLH1-036
//   3x BLH1-010
//   Token: JJBA-001
//
// Cards are referenced by card NUMBER, so importing works for anyone whose card
// pool has those cards (which the shared library provides).

function buildDeckText() {
  const lines = [];
  const name = state.deckName || el.deckName.value.trim();
  if (name) lines.push(`# ${name}`);

  if (state.leaderId) {
    const leader = getCard(state.leaderId);
    lines.push(`Leader: ${leader?.cardNumber || state.leaderId}`);
  }

  // Ordered the same way the deck list is shown, for a tidy paste.
  const shown = new Set();
  deckEntries().forEach(({ card, qty }) => {
    shown.add(card.id);
    lines.push(`${qty}x ${card.cardNumber || card.id}`);
  });

  // Export straight from the deck STATE for any entry deckEntries() couldn't
  // resolve to a pool card (e.g. the shared library hadn't finished loading).
  // The deck is keyed by the card's id/number, so exporting the key preserves
  // the card instead of silently dropping it from the list.
  Object.entries(state.deck || {}).forEach(([id, qty]) => {
    if (!shown.has(id) && qty > 0) lines.push(`${qty}x ${id}`);
  });

  (state.tokens || []).forEach(id => {
    const token = getCard(id);
    lines.push(`Token: ${token?.cardNumber || id}`);
  });

  return lines.join("\n");
}

// Turn the exact card NUMBER from a decklist line into the id our deck uses.
// Cards are keyed in state.deck by cardNumber, so this is mostly identity, but
// it validates the card actually exists in the pool.
function resolveDeckLineCard(rawNumber) {
  const wanted = String(rawNumber || "").trim().toLowerCase();
  if (!wanted) return null;
  return state.cards.find(card =>
    String(card.cardNumber || "").toLowerCase() === wanted ||
    String(card.id || "").toLowerCase() === wanted) || null;
}

// Parse a pasted decklist into { name, leaderId, deck, tokens, missing }.
// Lenient: accepts "4x NUM", "4 x NUM", "4 NUM", ignores blanks and # comments,
// and collects any card numbers it couldn't find so the user can be told.
function parseDeckShareText(text) {
  const result = { name: "", leaderId: "", deck: {}, tokens: [], missing: [] };

  String(text || "").split(/\r?\n/).forEach(rawLine => {
    const line = rawLine.trim();
    if (!line) return;

    // Deck name comment
    if (line.startsWith("#")) {
      if (!result.name) result.name = line.replace(/^#+/, "").trim();
      return;
    }

    const leaderMatch = line.match(/^leader\s*[:=]\s*(.+)$/i);
    if (leaderMatch) {
      const card = resolveDeckLineCard(leaderMatch[1]);
      // Keep the leader either way: the resolved id, or the raw number so it's
      // remembered (and resolves once the pool finishes loading) instead of lost.
      result.leaderId = card ? (card.id || card.cardNumber) : leaderMatch[1].trim();
      if (!card) result.missing.push(leaderMatch[1].trim());
      return;
    }

    const tokenMatch = line.match(/^tokens?\s*[:=]\s*(.+)$/i);
    if (tokenMatch) {
      // Allow "Token: A, B, C" or one per line.
      tokenMatch[1].split(/[,]/).forEach(part => {
        const raw = part.trim();
        if (!raw) return;
        const card = resolveDeckLineCard(part);
        const key = card ? (card.id || card.cardNumber) : raw;
        if (!result.tokens.includes(key)) result.tokens.push(key);
        if (!card) result.missing.push(raw);
      });
      return;
    }

    // "<qty> x <number>", "<qty>x<number>", or "<qty> <number>"
    const qtyMatch = line.match(/^(\d+)\s*x?\s*[:\s]?\s*(.+)$/i);
    if (qtyMatch) {
      const qty = Math.max(1, parseInt(qtyMatch[1], 10));
      const card = resolveDeckLineCard(qtyMatch[2]);
      // Keep the entry under the resolved id when known, otherwise under the raw
      // number - so a card the pool can't resolve yet is preserved, not dropped.
      const key = card ? (card.id || card.cardNumber) : qtyMatch[2].trim();
      result.deck[key] = (result.deck[key] || 0) + qty;
      if (!card) result.missing.push(qtyMatch[2].trim());
      return;
    }

    // A bare card number with no quantity = 1 copy.
    const bare = resolveDeckLineCard(line);
    const key = bare ? (bare.id || bare.cardNumber) : line;
    result.deck[key] = (result.deck[key] || 0) + 1;
    if (!bare) result.missing.push(line);
  });

  return result;
}

function importDeckFromText(text) {
  // Importing while the shared library is still loading would fail to resolve
  // most cards and then overwrite+save the broken result. Block until the pool
  // is ready so cards can't silently go missing.
  if (state.cardsLoading || !state.cards.length) {
    toast("Cards are still loading — wait a moment, then import again");
    return false;
  }

  const parsed = parseDeckShareText(text);

  const cardCount = Object.values(parsed.deck).reduce((sum, qty) => sum + qty, 0);
  if (!parsed.leaderId && !cardCount && !parsed.tokens.length) {
    toast("Nothing to import — paste a decklist first");
    return false;
  }

  state.leaderId = parsed.leaderId || "";
  state.deck = parsed.deck;
  state.tokens = parsed.tokens;
  state.deckName = parsed.name || state.deckName;
  if (el.deckName) el.deckName.value = state.deckName;

  saveDeck(); // persist as the working draft (not to the named list)

  if (parsed.missing.length) {
    const shown = parsed.missing.slice(0, 4).join(", ");
    toast(`Imported. ${parsed.missing.length} card${parsed.missing.length === 1 ? "" : "s"} not in your pool: ${shown}${parsed.missing.length > 4 ? "…" : ""}`);
  } else {
    toast(`Imported ${cardCount} card${cardCount === 1 ? "" : "s"}`);
  }
  return true;
}

// Open the share panel in EXPORT mode: fill it with this deck's text and copy.
function openDeckExport() {
  if (state.cardsLoading) {
    toast("Cards are still loading — wait a moment, then export");
    return;
  }
  closeDeckSharePanels();
  const text = buildDeckText();
  if (el.deckShareTitle) el.deckShareTitle.textContent = "Export deck — copy and share this";
  if (el.deckShareText) { el.deckShareText.value = text; el.deckShareText.readOnly = true; }
  el.deckShareCopy?.removeAttribute("hidden");
  el.deckShareLoad?.setAttribute("hidden", "");
  el.deckSharePanel?.removeAttribute("hidden");
  el.deckShareText?.focus();
  el.deckShareText?.select();
}

// Open the share panel in IMPORT mode: empty, ready to paste.
function openDeckImport() {
  closeDeckSharePanels();
  if (el.deckShareTitle) el.deckShareTitle.textContent = "Import deck — paste a decklist, then Import";
  if (el.deckShareText) { el.deckShareText.value = ""; el.deckShareText.readOnly = false; }
  el.deckShareCopy?.setAttribute("hidden", "");
  el.deckShareLoad?.removeAttribute("hidden");
  el.deckSharePanel?.removeAttribute("hidden");
  el.deckShareText?.focus();
}

function closeDeckSharePanels() {
  el.deckSharePanel?.setAttribute("hidden", "");
}

async function copyDeckShareText() {
  const text = el.deckShareText?.value || "";
  try {
    await navigator.clipboard.writeText(text);
    toast("Decklist copied");
  } catch {
    // Clipboard API can be blocked; the text is already selected to copy manually.
    el.deckShareText?.select();
    toast("Press Ctrl+C to copy");
  }
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

// Deck list ordering: group by card type (characters, then events, then
// stages), and within each group sort by cost ascending. Tokens render after
// all of these (see renderBuilder), so the full visible order is
// characters -> events -> stages -> tokens, each cheapest-first.
const DECK_CATEGORY_ORDER = { character: 0, event: 1, stage: 2 };

function deckSortComparator(a, b) {
  const catA = DECK_CATEGORY_ORDER[a.category] ?? 3;
  const catB = DECK_CATEGORY_ORDER[b.category] ?? 3;
  if (catA !== catB) return catA - catB;
  const costDiff = Number(a.cost || 0) - Number(b.cost || 0);
  return costDiff || String(a.name || "").localeCompare(String(b.name || ""));
}

function deckEntries() {
  return Object.entries(state.deck)
    .map(([id, qty]) => ({ card: getCard(id), qty }))
    .filter(entry => entry.card)
    .sort((a, b) => deckSortComparator(a.card, b.card));
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

  // Does the open collection contain any leaders? Leader-first browsing only
  // makes sense when it does - a set with no leaders must still show its cards.
  const collectionHasLeader = state.activeCollection
    ? state.cards.some(card =>
        (card.collection || COLLECTION_DEFAULT) === state.activeCollection &&
        card.category === "leader")
    : false;

  return state.cards.filter(card => {
    // DON!! cards live in their own screen and must never appear in the normal
    // deck-building pool.
    if (card.donCard) return false;

    // Collections gate everything: the grid only ever shows the collection the
    // user opened from the picker. With no collection chosen nothing shows (the
    // picker screen is displayed in its place).
    if (!state.activeCollection || (card.collection || COLLECTION_DEFAULT) !== state.activeCollection) {
      return false;
    }

    // Leader-first browsing: with no leader picked the grid shows ONLY leaders,
    // so you choose who to build around first; once a leader is chosen it drops
    // out and the grid shows just that leader's colours. Skipped for collections
    // that have no leaders (otherwise they'd look empty), and skipped entirely
    // when "View all" is on.
    if (!category && collectionHasLeader && !state.viewAll) {
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
      // you see is what you can actually play. Leaders and tokens are exempt, and
      // "View all" lifts the restriction entirely.
      && (state.viewAll
        || !leader
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
  // Tokens come last, also cheapest-first.
  const tokenCards = state.tokens
    .map(id => getCard(id))
    .filter(Boolean)
    .sort(deckSortComparator);

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
  // The leader has no quantity, so it only gets a remove button. Everything else
  // gets +/- so copies can be adjusted without hunting for the card in the
  // library again.
  const controls = isLeader
    ? `<button class="deck-icon-btn remove-card-btn" type="button" data-clear-leader aria-label="Remove leader" title="Remove"><span aria-hidden="true">-</span></button>`
    : `<button class="deck-icon-btn add-card-btn" type="button" data-add="${escapeAttr(card.id)}" aria-label="Add one ${escapeAttr(card.name)}" title="Add one"><span aria-hidden="true">+</span></button>
       <button class="deck-icon-btn remove-card-btn" type="button" data-remove="${escapeAttr(card.id)}" aria-label="Remove one ${escapeAttr(card.name)}" title="Remove one"><span aria-hidden="true">-</span></button>`;

  return `
    <div class="deck-row" data-card-id="${escapeAttr(card.id)}">
      <div class="mini-card-art">${cardVisual(card)}</div>
      <span class="qty">${qty}</span>
      <div class="deck-row-actions">
        ${controls}
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

// Card count per collection, so the picker tiles show how much is in each.
function collectionCounts() {
  const counts = {};
  CARD_COLLECTIONS.forEach(entry => { counts[entry.slug] = 0; });
  state.cards.forEach(card => {
    const slug = normalizeCollectionSlug(card.collection);
    counts[slug] = (counts[slug] || 0) + 1;
  });
  return counts;
}

// The collection picker: one tile per group. Shown until a collection is opened.
function renderCollectionPicker() {
  if (!el.collectionPicker) return;
  const counts = collectionCounts();
  el.collectionPicker.innerHTML = "";

  // While the shared library is still downloading in the background, uploaded
  // collections may show a low/zero count for a moment. Say so, so it doesn't
  // read as "my cards are gone".
  if (state.sharedSyncing) {
    const note = document.createElement("div");
    note.className = "collection-sync-note";
    note.innerHTML = `<span class="collection-loading-spinner"></span>Syncing uploaded cards…`;
    el.collectionPicker.appendChild(note);
  }

  CARD_COLLECTIONS.forEach(entry => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "collection-tile" + (entry.image ? " has-art" : "");
    tile.dataset.collection = entry.slug;
    // Optional cover art per collection - set `image` on the CARD_COLLECTIONS
    // entry (a path under images/). Rendered behind a dark scrim so the name and
    // count stay readable.
    if (entry.image) {
      tile.style.backgroundImage =
        `linear-gradient(180deg, rgba(0,0,0,.15), rgba(0,0,0,.75)), url("${escapeAttr(entry.image)}")`;
    }
    tile.innerHTML = `
      <span class="collection-tile-name">${escapeHtml(entry.name)}</span>
      <span class="collection-tile-count">${counts[entry.slug] || 0} cards</span>
    `;
    tile.addEventListener("click", () => openCollection(entry.slug));
    el.collectionPicker.appendChild(tile);
  });

  // "New collection" tile - anyone can add their own set.
  const addTile = document.createElement("button");
  addTile.type = "button";
  addTile.className = "collection-tile collection-tile-add";
  addTile.innerHTML = `<span class="collection-add-plus">+</span><span class="collection-tile-name">New collection</span>`;
  addTile.addEventListener("click", () => openCollectionEditor(null));
  el.collectionPicker.appendChild(addTile);
}

function openCollection(slug) {
  state.activeCollection = normalizeCollectionSlug(slug);
  renderCardGrid();
  // The official list is big, so it's only fetched the first time you open it.
  if (state.activeCollection === OFFICIAL_COLLECTION) ensureOfficialCardsLoaded();
}

function closeCollection() {
  state.activeCollection = null;
  renderCardGrid();
}

function renderCardGrid() {
  clearTimeout(state.searchRenderTimer);

  // Still fetching the shared library: show a friendly loading state instead of
  // an empty grid and "0 cards".
  if (state.cardsLoading) {
    if (el.collectionBack) el.collectionBack.hidden = true;
    if (el.collectionEdit) el.collectionEdit.hidden = true;
    if (el.collectionCountPill) el.collectionCountPill.hidden = true;
    if (el.collectionHeading) el.collectionHeading.textContent = "Collections";
    if (el.cardGrid) el.cardGrid.style.display = "none";
    if (el.collectionPicker) {
      el.collectionPicker.style.display = "grid";
      el.collectionPicker.innerHTML = `<div class="collection-loading"><span class="collection-loading-spinner"></span>Loading cards…</div>`;
    }
    return;
  }

  // No collection open: show the picker in place of the card grid. Toggle with
  // inline display (not the [hidden] attribute) - the .collection-picker /
  // .card-grid CSS sets `display`, which overrides [hidden], so relying on the
  // attribute left both panels stuck until a full page reload.
  const browsing = Boolean(state.activeCollection);
  if (el.collectionPicker) el.collectionPicker.style.display = browsing ? "none" : "grid";
  if (el.cardGrid) el.cardGrid.style.display = browsing ? "" : "none";
  if (el.collectionBack) el.collectionBack.hidden = !browsing;
  if (el.collectionEdit) el.collectionEdit.hidden = !browsing;
  if (el.viewAllToggle) {
    el.viewAllToggle.hidden = !browsing;
    el.viewAllToggle.classList.toggle("active", Boolean(state.viewAll));
    el.viewAllToggle.setAttribute("aria-pressed", state.viewAll ? "true" : "false");
    el.viewAllToggle.textContent = state.viewAll ? "Leader-First" : "View All";
  }
  if (el.collectionCountPill) el.collectionCountPill.hidden = !browsing;
  if (el.collectionHeading) {
    el.collectionHeading.textContent = browsing
      ? collectionName(state.activeCollection)
      : "Collections";
  }

  if (!browsing) {
    renderCollectionPicker();
    if (el.collectionHint) el.collectionHint.textContent = "";
    return;
  }

  // The official collection fetches its ~2500 cards the first time it's opened.
  if (state.officialLoading && state.activeCollection === OFFICIAL_COLLECTION) {
    el.filteredCount.textContent = "…";
    if (el.collectionHint) el.collectionHint.textContent = "";
    el.cardGrid.innerHTML = `<div class="collection-loading"><span class="collection-loading-spinner"></span>Loading the official card list…</div>`;
    return;
  }

  const cards = filteredCards();
  el.filteredCount.textContent = String(cards.length);
  el.cardGrid.innerHTML = "";

  // Explain the leader-first filter, so a small count reads as "filtered"
  // rather than "my cards are missing".
  if (el.collectionHint) {
    const leader = getCard(state.leaderId);
    const total = state.cards.length;
    el.collectionHint.textContent = (el.categoryFilter.value || state.viewAll)
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

    // Alt-art cycle - only shown for cards that actually have extra art.
    // Cycles which art THIS player sees/plays with (stored per device).
    const artList = cardArtList(card);
    if (artList.length > 1) {
      const idx = altArtIndexFor(card);
      const altBtn = document.createElement("button");
      altBtn.type = "button";
      altBtn.className = "card-alt-btn" + (idx > 0 ? " active" : "");
      altBtn.textContent = `${idx > 0 ? "★" : "☆"} Art ${idx + 1}/${artList.length}`;
      altBtn.title = "Cycle this card's artwork (default + alt arts)";
      altBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        cycleAltArtPref(card);
        renderCardGrid();
      });
      (image || article).appendChild(altBtn);
    }

    el.cardGrid.appendChild(node);
  });
}

function scheduleCardGridRender() {
  clearTimeout(state.searchRenderTimer);
  state.searchRenderTimer = setTimeout(renderCardGrid, 160);
}

function cardVisual(card) {
  const src = preferredCardImageUrl(card);
  if (src) {
    return `
      <img
        alt="${escapeAttr(card.name)}"
        src="${escapeAttr(src)}"
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

  // Hovering a card in the collection shows a large preview on the left,
  // so you don't have to click Inspect to read it. Delegated so it covers
  // every tile without per-card listeners.
  const showHoverPreview = (article, pointerX) => {
    if (!el.builderHoverPreview || !article) return;
    const card = getCard(article.dataset.id);
    if (!card?.imageUrl) { hideHoverPreview(); return; }
    el.builderHoverPreviewImg.src = card.imageUrl;
    el.builderHoverPreviewImg.alt = card.name || "";
    // Show the big preview on the side AWAY from the card you're hovering, so it
    // never sits on top of that card's Edit / + buttons. Left-side cards -> preview
    // on the right; right-side cards -> preview on the left.
    const cardX = pointerX ?? article.getBoundingClientRect().left;
    const onLeftHalf = cardX < window.innerWidth / 2;
    el.builderHoverPreview.style.left = onLeftHalf ? "auto" : "16px";
    el.builderHoverPreview.style.right = onLeftHalf ? "16px" : "auto";
    el.builderHoverPreview.hidden = false;
  };
  function hideHoverPreview() {
    if (el.builderHoverPreview) el.builderHoverPreview.hidden = true;
  }
  el.cardGrid.addEventListener("mouseover", event => {
    showHoverPreview(event.target.closest(".card-tile"), event.clientX);
  });
  el.cardGrid.addEventListener("mouseleave", hideHoverPreview);
  // Hide it when the deck grid (deck list) is hovered too, and on view change.
  el.deckList?.addEventListener("mouseover", hideHoverPreview);

  el.deckList.addEventListener("click", event => {
    const addId = event.target.closest("[data-add]")?.dataset.add;
    if (addId) { addToDeck(addId); return; }
    const removeId = event.target.closest("[data-remove]")?.dataset.remove;
    if (removeId) { removeFromDeck(removeId); return; }
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
  el.exportDeck?.addEventListener("click", openDeckExport);
  el.importDeck?.addEventListener("click", openDeckImport);
  el.deckShareCopy?.addEventListener("click", copyDeckShareText);
  el.deckShareLoad?.addEventListener("click", () => {
    if (importDeckFromText(el.deckShareText?.value || "")) closeDeckSharePanels();
  });
  el.closeDeckShare?.addEventListener("click", closeDeckSharePanels);
  el.collectionBack?.addEventListener("click", closeCollection);
  el.collectionEdit?.addEventListener("click", () => openCollectionEditor(state.activeCollection));
  // "View All" lifts the leader-first / leader-colour restriction so every card
  // in the collection shows, even before (or regardless of) a chosen leader.
  el.viewAllToggle?.addEventListener("click", () => {
    state.viewAll = !state.viewAll;
    renderCardGrid();
  });
  setupCollectionManagement();
  setupCustomImages();
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
    // If you're browsing a collection, new cards default into it.
    preselectCreationCollection();
  });
  el.closeCardCreation?.addEventListener("click", () => {
    el.cardCreationPanel.hidden = true;
    // Panel closed but still in Deck Builder view - restore its tab highlight.
    el.navTabs.forEach(tab => tab.classList.toggle("active", tab.dataset.view === "builder"));
  });

  // DON!! decks tab
  el.donDeckTab?.addEventListener("click", () => {
    if (el.savedDecksPanel) el.savedDecksPanel.hidden = true;
    if (el.cardCreationPanel) el.cardCreationPanel.hidden = true;
    if (el.donDeckPanel) el.donDeckPanel.hidden = false;
    openDonDeckScreen();
  });
  el.closeDonDeck?.addEventListener("click", () => {
    if (el.donDeckPanel) el.donDeckPanel.hidden = true;
  });
  // Add a DON!! card to the shared pool.
  el.addDonCardBtn?.addEventListener("click", showAddDonCardForm);
  el.cancelAddDonCard?.addEventListener("click", hideAddDonCardForm);
  el.addDonCardForm?.addEventListener("submit", saveDonCard);
  // Pool: add a card to the deck being built, or delete it from the pool.
  el.donCardPool?.addEventListener("click", event => {
    const addId = event.target.closest("[data-add-donpool]")?.dataset.addDonpool;
    if (addId) { addDonCardToBuild(addId); return; }
    const delId = event.target.closest("[data-del-donpool]")?.dataset.delDonpool;
    if (delId) { deleteDonCard(delId); return; }
  });
  // Current build: remove a card by its slot index.
  el.donDeckCurrent?.addEventListener("click", event => {
    const idx = event.target.closest("[data-remove-donbuild]")?.dataset.removeDonbuild;
    if (idx !== undefined) removeDonCardFromBuild(Number(idx));
  });
  el.saveDonDeck?.addEventListener("click", saveDonDeck);
  el.clearDonDeckBuild?.addEventListener("click", clearDonBuild);
  el.cancelDonDeckEdit?.addEventListener("click", resetDonBuild);
  el.importDonDeck?.addEventListener("click", importDonDeckFromText);
  el.donDeckList?.addEventListener("click", event => {
    const useId = event.target.closest("[data-use-don]")?.dataset.useDon;
    if (useId !== undefined) { useDonDeck(useId); return; }
    const editId = event.target.closest("[data-edit-don]")?.dataset.editDon;
    if (editId) { editDonDeck(editId); return; }
    const exportId = event.target.closest("[data-export-don]")?.dataset.exportDon;
    if (exportId) { exportDonDeck(exportId); return; }
    const deleteId = event.target.closest("[data-delete-don]")?.dataset.deleteDon;
    if (deleteId) { deleteDonDeck(deleteId); return; }
  });
  el.cardCreationForm?.addEventListener("submit", saveCreatedCard);
  el.creationImage?.addEventListener("change", previewCreationImage);
  el.creationImageUrl?.addEventListener("change", previewCreationImageUrl);
  el.creationAddAltArt?.addEventListener("click", () => addAltArtRow());

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

// Fill every collection <select> (card creation, JSON import) with the fixed
// set of collections. Called once at startup.
function populateCollectionSelects() {
  const options = CARD_COLLECTIONS
    .map(entry => `<option value="${entry.slug}">${escapeHtml(entry.name)}</option>`)
    .join("");
  [
    el.creationCollection,
    document.querySelector("#untapBatchCollection")
  ].forEach(select => {
    if (select) select.innerHTML = options;
  });
}

// =====================================================================
// Untap custom-card JSON importer
// =====================================================================
// Reads an "untap-custom-card-import" export, maps each card in `cards[]`
// into this sim's card schema, and lets the user review/edit/deselect before
// anything is saved. The original Untap object is preserved verbatim under
// importSource so no field is ever lost, and the Untap `id` is kept as a stable
// external id (untapId) used for duplicate detection.

const untapEl = {};
let untapReview = { meta: null, entries: [] };

function cacheUntapEls() {
  [
    "untapImportDialog", "openUntapImport", "closeUntapImport",
    "untapPickStep", "untapReviewStep", "untapSummaryStep",
    "untapFileInput", "untapPickError",
    "untapSourceInfo", "untapSelCount", "untapBatchCollection",
    "untapSelectAll", "untapSelectNone", "untapReviewList",
    "untapBackToPick", "untapDoImport", "untapSummaryList", "untapSummaryDone"
  ].forEach(id => { untapEl[id] = document.getElementById(id); });
}

// A readable, deterministic card number derived from the Untap id, so a
// re-import of the same card yields the same number (which is what makes the
// Replace path actually overwrite rather than duplicate).
function makeUntapCardNumber(setCode, untapId) {
  const prefix = String(setCode || "CUS").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "CUS";
  const short = String(untapId || "").replace(/[^a-fA-F0-9]/g, "").slice(0, 5).toUpperCase() || "00000";
  return `${prefix}-${short}`;
}

function untapNumeric(value) {
  if (value === "" || value == null) return "";
  const n = Number(value);
  return Number.isFinite(n) ? n : "";
}

function untapIsoDate(ms) {
  const n = Number(ms);
  if (!n) return "";
  try { return new Date(n).toISOString(); } catch { return ""; }
}

// Map ONE raw Untap card into this sim's card shape (pre-normalizeCard).
function mapUntapCardToSim(raw, sourceMeta) {
  const fields = raw.fields || {};
  const meta = raw.meta || {};
  const images = raw.images || {};
  const text = raw.text || {};

  const untapId = String(raw.id || (crypto.randomUUID ? crypto.randomUUID() : Date.now()));
  const setCode = String(raw.set || fields.setName || "").trim();
  const category = normalizeCategory(meta.type || fields.cardType || raw.type);
  // Prefer the stable Untap-rendered image. The Discord `front` URLs carry
  // expiry params (ex/is/hm) and stop loading after a while, so they're only a
  // fallback. Some exports put the image at the top level (imageUrl/front_image)
  // instead of an images{} object, so read those too.
  const imageCandidates = [
    images.untapRendered, images.preferred, images.front, images.back,
    raw.imageUrl, raw.front_image, raw.image
  ];
  // The importer embeds permanent `data:` copies of images (they can't expire).
  // Always prefer one if present, regardless of which field it landed in, so a
  // stale remote URL in an earlier-listed field can never shadow it.
  const image = imageCandidates.find(url => typeof url === "string" && url.startsWith("data:"))
    || imageCandidates.find(url => typeof url === "string" && url) || "";
  const effect = String(text.front || fields.effect || "").trim();
  // meta.attribute is an array; fields.attribute is a single string.
  const attribute = Array.isArray(meta.attribute)
    ? meta.attribute.filter(Boolean).join(", ")
    : String(fields.attribute || "");
  const cardNumber = String(fields.cardNumber || "").trim() || makeUntapCardNumber(setCode, untapId);

  // Preserve the source card for re-import/debugging, but drop any embedded
  // `data:` image bytes from the copy - the canonical image already lives in
  // `image`, and keeping a second full-size copy here would double the stored
  // size of every imported card.
  const preservedRaw = stripDataUrlsFromImport(raw);

  return {
    // Use the CARD NUMBER as the id (like built-in cards) so the game's
    // getCardById(cardNumber) resolves it. The Untap uuid is kept as untapId.
    id: cardNumber,
    cardNumber,
    // Stable external id from Untap - used to detect duplicates on re-import.
    untapId,
    name: raw.name || "Unnamed Card",
    category,
    cardType: category,
    // OPTCG "type" line is the subtype(s); Untap stores it in fields.subtype
    // (fields.cardType is the GAME, "opcg", not the card's type).
    type: String(fields.subtype || "").trim(),
    subtype: String(fields.subtype || "").trim(),
    color: String(fields.color || "").trim(),
    cost: category === "leader" ? "" : untapNumeric(fields.cost),
    life: category === "leader" ? untapNumeric(fields.life) : "",
    power: untapNumeric(fields.power),
    counter: untapNumeric(fields.counter),
    attribute,
    rarity: String(raw.rarity || fields.rarity || "").trim(),
    effect,
    trigger: String(fields.trigger || "").trim(),
    donEffect: String(fields.donEffect || "").trim(),
    artist: String(fields.artist || "").trim(),
    creator: String(raw.creator || sourceMeta?.creator || "").trim(),
    setName: String(fields.setName || setCode).trim(),
    setCodeHint: setCode,
    printType: String(raw.printType || "").trim(),
    image,
    imported: true,
    importedAt: new Date().toISOString(),
    addedAt: untapIsoDate(raw.timestamps?.added),
    lastEditedAt: untapIsoDate(raw.timestamps?.lastEdited),
    // Preserve EVERYTHING from the source so no unknown field is ever lost.
    importSource: {
      format: sourceMeta?.format || null,
      formatVersion: sourceMeta?.formatVersion || null,
      source: sourceMeta?.source || null,
      exportedAt: sourceMeta?.exportedAt || null,
      card: preservedRaw
    }
  };
}

// Return a shallow clone of an imported card record with any embedded `data:`
// image URLs blanked out, so preserving the source doesn't store a second copy
// of every (potentially large) inlined image.
function stripDataUrlsFromImport(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const isData = value => typeof value === "string" && value.startsWith("data:");
  const clone = { ...raw };
  if (clone.images && typeof clone.images === "object") {
    const images = { ...clone.images };
    for (const key of Object.keys(images)) {
      if (isData(images[key])) images[key] = "";
    }
    if (Array.isArray(clone.images.candidates)) {
      images.candidates = clone.images.candidates.filter(url => !isData(url));
    }
    clone.images = images;
  }
  ["imageUrl", "front_image", "image", "imageDataUrl", "preferredImageUrl"].forEach(key => {
    if (isData(clone[key])) clone[key] = "";
  });
  return clone;
}

// Parse the file text into { meta, cards[] }, tolerating a few shapes: the
// documented { cards: [...] }, a bare array, or a single card object.
function parseUntapFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error("That file isn't valid JSON.");
  }

  let cards;
  let meta = null;
  if (Array.isArray(data)) {
    cards = data;
  } else if (Array.isArray(data.cards)) {
    cards = data.cards;
    meta = {
      format: data.format,
      formatVersion: data.formatVersion,
      exportedAt: data.exportedAt,
      source: data.source,
      creator: data.source?.creator
    };
  } else if (data && (data.id || data.name || data.fields)) {
    cards = [data];
  } else {
    throw new Error("No cards found in that file (expected a \"cards\" array).");
  }

  if (!cards.length) throw new Error("That file has an empty cards list.");
  return { meta, cards };
}

// Does this mapped card already exist in the pool *in the same collection*? A
// card is a duplicate only when its number AND collection match, so importing a
// number that also exists in another collection is NOT a clash - both are kept.
// The Untap id match is likewise scoped to the same collection.
function findExistingCardForImport(card) {
  const untapId = card.untapId;
  const number = String(card.cardNumber || card.id || "").trim().toLowerCase();
  const collection = String(card.collection || "").trim().toLowerCase();
  return state.cards.find(existing => {
    if (String(existing.collection || "").trim().toLowerCase() !== collection) return false;
    if (untapId && existing.untapId && existing.untapId === untapId) return true;
    return String(existing.cardNumber || existing.id || "").trim().toLowerCase() === number;
  }) || null;
}

// Recompute whether every review entry clashes with the pool and reset its
// default action. Called after a collection change, since the clash depends on
// which collection each card is going into.
function refreshUntapDupFlags() {
  untapReview.entries.forEach(entry => {
    const dup = findExistingCardForImport(entry.card);
    entry.dup = dup;
    // Keep an explicit user choice; otherwise default new clashes to "skip" and
    // clear a stale "skip/replace" once a card no longer clashes.
    if (!dup) { if (entry.action === "skip" || entry.action === "replace") entry.action = "add"; }
    else if (entry.action === "add") entry.action = "skip";
  });
}

function untapEntryInvalid(entry) {
  return !String(entry.card.name || "").trim() || !String(entry.card.image || "").trim();
}

function openUntapImport() {
  cacheUntapEls();
  if (!untapEl.untapImportDialog) return;
  untapReview = { meta: null, entries: [] };
  showUntapStep("pick");
  if (untapEl.untapFileInput) untapEl.untapFileInput.value = "";
  if (untapEl.untapPickError) untapEl.untapPickError.hidden = true;
  // Default the batch collection to whatever the browser is currently showing.
  if (untapEl.untapBatchCollection) {
    untapEl.untapBatchCollection.value = state.activeCollection || COLLECTION_DEFAULT;
  }
  untapEl.untapImportDialog.showModal();
}

function showUntapStep(step) {
  if (untapEl.untapPickStep) untapEl.untapPickStep.hidden = step !== "pick";
  if (untapEl.untapReviewStep) untapEl.untapReviewStep.hidden = step !== "review";
  if (untapEl.untapSummaryStep) untapEl.untapSummaryStep.hidden = step !== "summary";
}

async function handleUntapFile(file) {
  if (!file) return;
  if (untapEl.untapPickError) untapEl.untapPickError.hidden = true;

  let parsed;
  try {
    const text = await file.text();
    parsed = parseUntapFile(text);
  } catch (error) {
    if (untapEl.untapPickError) {
      untapEl.untapPickError.textContent = error.message;
      untapEl.untapPickError.hidden = false;
    }
    return;
  }

  const batchCollection = untapEl.untapBatchCollection?.value || state.activeCollection || COLLECTION_DEFAULT;
  untapReview.meta = parsed.meta;
  untapReview.entries = parsed.cards.map(raw => {
    const card = mapUntapCardToSim(raw, parsed.meta);
    card.collection = normalizeCollectionSlug(batchCollection);
    const dup = findExistingCardForImport(card);
    return { card, include: true, dup, action: dup ? "skip" : "add", editing: false };
  });

  if (untapEl.untapSourceInfo) {
    const creator = parsed.meta?.creator || untapReview.entries[0]?.card.creator || "";
    untapEl.untapSourceInfo.textContent =
      `${parsed.cards.length} card${parsed.cards.length === 1 ? "" : "s"}` +
      (creator ? ` from ${creator}` : "");
  }
  showUntapStep("review");
  renderUntapReview();
}

function untapStatChips(card) {
  const chips = [];
  chips.push(card.category);
  if (card.category === "leader") {
    if (card.life !== "") chips.push(`${card.life} life`);
  } else if (card.cost !== "") {
    chips.push(`${card.cost} cost`);
  }
  if (card.power !== "") chips.push(`${card.power} power`);
  if (card.counter !== "") chips.push(`+${card.counter}`);
  if (card.color) chips.push(card.color);
  return chips.filter(Boolean);
}

function renderUntapReview() {
  const list = untapEl.untapReviewList;
  if (!list) return;
  list.innerHTML = "";

  const collectionOptions = CARD_COLLECTIONS
    .map(entry => `<option value="${entry.slug}">${escapeHtml(entry.name)}</option>`)
    .join("");

  untapReview.entries.forEach((entry, index) => {
    const card = entry.card;
    const invalid = untapEntryInvalid(entry);
    const row = document.createElement("div");
    row.className = "untap-card" + (entry.include ? "" : " is-excluded") + (invalid ? " is-invalid" : "");
    row.dataset.index = String(index);

    const setLabel = card.setName || card.setCodeHint || "—";
    const chips = untapStatChips(card).map(chip => `<span class="untap-chip">${escapeHtml(String(chip))}</span>`).join("");

    const dupBadge = entry.dup
      ? `<div class="untap-dup">
           <span class="untap-dup-tag">Already in pool</span>
           <label><input type="radio" name="untap-dup-${index}" value="skip" ${entry.action === "skip" ? "checked" : ""}> Skip</label>
           <label><input type="radio" name="untap-dup-${index}" value="replace" ${entry.action === "replace" ? "checked" : ""}> Replace</label>
         </div>`
      : "";

    row.innerHTML = `
      <label class="untap-include">
        <input type="checkbox" class="untap-include-box" ${entry.include ? "checked" : ""} ${invalid ? "disabled" : ""}>
      </label>
      <div class="untap-thumb">
        ${card.image
          ? `<img src="${escapeAttr(card.image)}" alt="" loading="lazy" onerror="this.classList.add('untap-thumb-fail')">`
          : `<span class="untap-thumb-none">No image</span>`}
      </div>
      <div class="untap-info">
        <strong class="untap-name">${escapeHtml(card.name || "Unnamed Card")}</strong>
        <span class="untap-set">${escapeHtml(setLabel)} · ${escapeHtml(card.cardNumber)}</span>
        <div class="untap-chips">${chips}</div>
        ${invalid ? `<span class="untap-invalid-note">Missing name or image — can't import</span>` : ""}
        ${dupBadge}
      </div>
      <div class="untap-row-actions">
        <label class="untap-col-select">Collection
          <select class="untap-col">${collectionOptions}</select>
        </label>
        <button type="button" class="ghost untap-edit-btn">${entry.editing ? "Done" : "Edit"}</button>
        <button type="button" class="ghost untap-del-btn" title="Remove from this import">✕</button>
      </div>
      <div class="untap-edit-panel" ${entry.editing ? "" : "hidden"}></div>
    `;

    row.querySelector(".untap-col").value = card.collection;
    if (entry.editing) row.querySelector(".untap-edit-panel").innerHTML = untapEditFields(card);

    list.appendChild(row);
  });

  updateUntapSelCount();
}

function untapEditFields(card) {
  const field = (label, key, type = "text") =>
    `<label>${label}<input data-edit="${key}" type="${type}" value="${escapeAttr(card[key] ?? "")}"></label>`;
  return `
    <div class="untap-edit-grid">
      ${field("Name", "name")}
      ${field("Card #", "cardNumber")}
      <label>Type
        <select data-edit="category">
          ${["leader", "character", "event", "stage", "token"]
            .map(cat => `<option value="${cat}" ${card.category === cat ? "selected" : ""}>${cat}</option>`).join("")}
        </select>
      </label>
      ${field("Colors", "color")}
      ${field(card.category === "leader" ? "Life" : "Cost", card.category === "leader" ? "life" : "cost", "number")}
      ${field("Power", "power", "number")}
      ${field("Counter", "counter", "number")}
      ${field("Attribute", "attribute")}
      ${field("Subtype", "subtype")}
      ${field("Rarity", "rarity")}
    </div>
    <label class="untap-edit-effect">Effect<textarea data-edit="effect" rows="2">${escapeHtml(card.effect || "")}</textarea></label>
  `;
}

function updateUntapSelCount() {
  const selected = untapReview.entries.filter(e => e.include && !untapEntryInvalid(e)).length;
  if (untapEl.untapSelCount) untapEl.untapSelCount.textContent = `${selected} selected`;
}

// One delegated handler for the whole review list (checkboxes, edits, buttons).
function handleUntapReviewEvent(event) {
  const row = event.target.closest(".untap-card");
  if (!row) return;
  const index = Number(row.dataset.index);
  const entry = untapReview.entries[index];
  if (!entry) return;

  if (event.target.matches(".untap-include-box")) {
    entry.include = event.target.checked;
    row.classList.toggle("is-excluded", !entry.include);
    updateUntapSelCount();
  } else if (event.target.matches('input[type="radio"]')) {
    entry.action = event.target.value;
  } else if (event.target.matches(".untap-col")) {
    entry.card.collection = normalizeCollectionSlug(event.target.value);
    // The clash check is per-collection, so re-evaluate this row and refresh the
    // badge/skip-replace controls.
    refreshUntapDupFlags();
    renderUntapReview();
  } else if (event.target.matches("[data-edit]")) {
    applyUntapEdit(entry, event.target);
  }
}

function applyUntapEdit(entry, input) {
  const key = input.dataset.edit;
  let value = input.value;
  if (["cost", "life", "power", "counter"].includes(key)) {
    value = value === "" ? "" : untapNumeric(value);
  }
  if (key === "category") {
    entry.card.category = normalizeCategory(value);
    entry.card.cardType = entry.card.category;
    return;
  }
  entry.card[key] = value;
}

function handleUntapReviewClick(event) {
  const row = event.target.closest(".untap-card");
  if (!row) return;
  const index = Number(row.dataset.index);
  const entry = untapReview.entries[index];
  if (!entry) return;

  if (event.target.matches(".untap-edit-btn")) {
    entry.editing = !entry.editing;
    renderUntapReview();
  } else if (event.target.matches(".untap-del-btn")) {
    untapReview.entries.splice(index, 1);
    renderUntapReview();
  }
}

function setAllUntapIncluded(included) {
  untapReview.entries.forEach(entry => {
    entry.include = included && !untapEntryInvalid(entry);
  });
  renderUntapReview();
}

async function runUntapImport() {
  const summary = { imported: 0, replaced: 0, skipped: 0, invalid: 0, failed: 0, deviceOnly: 0 };
  const toImport = [];

  untapReview.entries.forEach(entry => {
    if (untapEntryInvalid(entry)) { summary.invalid++; return; }
    if (!entry.include) { summary.skipped++; return; }
    if (entry.dup && entry.action === "skip") { summary.skipped++; return; }
    toImport.push(entry);
  });

  if (untapEl.untapDoImport) {
    untapEl.untapDoImport.disabled = true;
    untapEl.untapDoImport.textContent = "Importing…";
  }

  summary.imageStored = 0;
  summary.imageKept = 0;
  let done = 0;
  for (const entry of toImport) {
    done++;
    if (untapEl.untapDoImport) {
      untapEl.untapDoImport.textContent = `Saving image ${done}/${toImport.length}…`;
    }

    // Store a PERMANENT copy of the image now, while any expiring token is still
    // valid, so the card never goes blank later. Falls back to the original URL
    // if the proxy can't reach it.
    let card = entry.card;
    if (!String(card.image || "").startsWith("data:")) {
      const stored = await fetchRemoteImageAsDataUrl(card.image);
      if (stored) { card = { ...card, image: stored }; summary.imageStored++; }
      else summary.imageKept++;
    }

    [card] = await compressImportedCardImages([card]);
    const ok = await publishSingleCard(card);
    if (!ok) { summary.failed++; continue; }
    // "local" means the shared library couldn't be reached - the card is on THIS
    // device only, so it won't work in multiplayer or for anyone else.
    if (ok === "local") summary.deviceOnly++;
    if (entry.dup && entry.action === "replace") summary.replaced++;
    else summary.imported++;
  }

  if (untapEl.untapDoImport) {
    untapEl.untapDoImport.disabled = false;
    untapEl.untapDoImport.textContent = "Import selected";
  }

  await loadCardPool();
  showUntapSummary(summary);
}

function showUntapSummary(summary) {
  const list = untapEl.untapSummaryList;
  if (list) {
    const rows = [
      ["Imported", summary.imported],
      ["Replaced", summary.replaced],
      ["Skipped", summary.skipped],
      ["Invalid", summary.invalid]
    ];
    if (summary.imageStored) rows.push(["Images saved permanently", summary.imageStored]);
    if (summary.failed) rows.push(["Failed to save", summary.failed]);
    list.innerHTML = rows
      .map(([label, count]) => `<li><span>${label}</span><strong>${count}</strong></li>`)
      .join("");
    // Warn if some images couldn't be permanently stored - those still rely on an
    // external link that may expire.
    if (summary.imageKept) {
      const note = document.createElement("li");
      note.className = "untap-summary-warn";
      note.innerHTML = `<span>⚠ ${summary.imageKept} image${summary.imageKept === 1 ? "" : "s"} couldn't be saved permanently ` +
        `(the source couldn't be reached) — those still use a link that may expire. Try importing those again.</span>`;
      list.appendChild(note);
    }
    // Loud warning if the shared library couldn't be reached - those cards won't
    // work in multiplayer. Tells the user to check their connection and re-import.
    if (summary.deviceOnly) {
      const warn = document.createElement("li");
      warn.className = "untap-summary-warn";
      warn.innerHTML = `<span>⚠ ${summary.deviceOnly} saved to THIS DEVICE ONLY — the shared library was unreachable. ` +
        `They won't work in multiplayer. Check your connection and import again.</span>`;
      list.appendChild(warn);
    }
  }
  showUntapStep("summary");
}

function initUntapImporter() {
  cacheUntapEls();
  untapEl.openUntapImport?.addEventListener("click", openUntapImport);
  untapEl.closeUntapImport?.addEventListener("click", () => untapEl.untapImportDialog?.close());
  untapEl.untapSummaryDone?.addEventListener("click", () => untapEl.untapImportDialog?.close());
  untapEl.untapFileInput?.addEventListener("change", event => handleUntapFile(event.target.files?.[0]));
  untapEl.untapBackToPick?.addEventListener("click", () => showUntapStep("pick"));
  untapEl.untapDoImport?.addEventListener("click", runUntapImport);
  untapEl.untapSelectAll?.addEventListener("click", () => setAllUntapIncluded(true));
  untapEl.untapSelectNone?.addEventListener("click", () => setAllUntapIncluded(false));
  untapEl.untapBatchCollection?.addEventListener("change", () => {
    const slug = normalizeCollectionSlug(untapEl.untapBatchCollection.value);
    untapReview.entries.forEach(entry => { entry.card.collection = slug; });
    // Clash detection is per-collection - re-evaluate the whole batch.
    refreshUntapDupFlags();
    renderUntapReview();
  });
  untapEl.untapReviewList?.addEventListener("input", handleUntapReviewEvent);
  untapEl.untapReviewList?.addEventListener("change", handleUntapReviewEvent);
  untapEl.untapReviewList?.addEventListener("click", handleUntapReviewClick);
}

loadSavedDeck();
bindEvents();
initializeCardCreation();
populateCollectionSelects();
initUntapImporter();
// Paint the current view + the "Loading cards…" state right away so the builder
// never shows an empty "0 cards" grid while the shared library downloads.
showView(state.activeView);
renderCardGrid();
// Load custom collections first so a card's collection slug resolves against the
// full list, then the pool. Falls straight through to loadCardPool if it fails.
loadCollections()
  .then(() => { populateCollectionSelects(); })
  .catch(() => {})
  .finally(() => { loadCardPool(); });
// Report shared-library connectivity in Settings without blocking startup.
refreshLibraryStatus();
refreshRestoreHint();
window.addEventListener("resize", () => {
  if (state.activeView === "builder") queueDeckTableResize();
});
