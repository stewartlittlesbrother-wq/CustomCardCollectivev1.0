// Shared collection catalog — the single source of truth for the built-in card
// collections (slug + display name) and the default collection that cards with
// no explicit collection fall under.
//
// Loaded as a plain <script> BEFORE app.js on the home page and on any other
// page that needs to list collections (e.g. the multiplayer draft pool picker),
// so both use the exact same list instead of drifting copies.
(function () {
    const BUILTIN_COLLECTIONS = [
        // The full official One Piece TCG card list, pulled live from a public API
        // and hotlinked (no Firebase storage used). Read-only: not editable.
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

    window.BUILTIN_COLLECTIONS = BUILTIN_COLLECTIONS;
    window.COLLECTION_DEFAULT = "golds-bleach";
})();
