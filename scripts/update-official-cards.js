#!/usr/bin/env node
/**
 * Pulls the official One Piece TCG card list from cardkaizoku's public data file
 * and writes a trimmed copy into data/official-cards.json.
 *
 * Run server-side (locally or in the daily GitHub Action) - NOT from the browser:
 * cardkaizoku's CDN only allows CORS from its own site, so the site can't fetch
 * it directly. Committing the trimmed file into the repo lets the site load it
 * same-origin with no CORS and no external runtime dependency. Images are still
 * hotlinked from cardkaizoku's CDN (image tags don't need CORS), so nothing is
 * copied into Firebase.
 *
 * Usage: node scripts/update-official-cards.js
 */
const fs = require("fs");
const path = require("path");

const SOURCE_URL = "https://cdn.cardkaizoku.com/card_data.json";
const OUT_FILE = path.join(__dirname, "..", "data", "official-cards.json");

// cardkaizoku cardType -> our category. DON!!/LIFE aren't playable main-deck
// cards, so they're dropped (DON art lives in the DON!! deck screen).
const CATEGORY = { LEADER: "leader", CHARACTER: "character", EVENT: "event", STAGE: "stage" };

function toCard(c) {
  const category = CATEGORY[String(c.cardType || "").toUpperCase()] || null;
  if (!category || !c.cardNumber) return null;
  const colors = String(c.color || "").trim().split(/[\s,/]+/).filter(Boolean).join(",").toLowerCase();
  // cardkaizoku stores a leader's LIFE in the `cost` field (leaders have no cost).
  const isLeader = category === "leader";
  return {
    cardNumber: c.cardNumber,
    name: c.cardName || "",
    category,
    color: colors,
    cost: isLeader ? "" : (c.cost ?? ""),
    life: isLeader ? (c.cost ?? "") : "",
    power: c.power ?? "",
    counter: c.counter ?? "",
    attribute: c.attribute || "",
    type: c.feature || "",
    rarity: c.rarity || "",
    effect: c.text || "",
    trigger: c.trigger || "",
    setName: c.cardSet || "",
    image: c.bucketImg || (c.cardImg ? `https://cdn.cardkaizoku.com${c.cardImg}` : "")
  };
}

async function main() {
  const res = await fetch(SOURCE_URL, { headers: { "user-agent": "custom-cards-sim-updater" } });
  if (!res.ok) throw new Error(`Source returned HTTP ${res.status}`);
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error("Unexpected data shape (expected an array)");

  const seen = new Set();
  const cards = [];
  for (const entry of raw) {
    const card = toCard(entry);
    if (!card) continue;
    if (seen.has(card.cardNumber)) continue; // one entry per card number
    seen.add(card.cardNumber);
    cards.push(card);
  }
  cards.sort((a, b) => a.cardNumber.localeCompare(b.cardNumber));

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({ source: "cardkaizoku", updatedAt: new Date().toISOString(), cards }));
  console.log(`Wrote ${cards.length} official cards to ${path.relative(process.cwd(), OUT_FILE)}`);
}

main().catch(err => { console.error("Update failed:", err.message); process.exit(1); });
