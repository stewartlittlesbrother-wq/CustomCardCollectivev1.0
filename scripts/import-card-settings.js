#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

require("../js/core/customEffectV2.js");

const repoRoot = path.resolve(__dirname, "..");
const dataFileByType = {
    leader: "data/cards/leaders.json",
    character: "data/cards/characters.json",
    stage: "data/cards/stages.json",
    event: "data/cards/events.json"
};

function parseArgs(argv) {
    const args = {
        dryRun: false,
        imageDir: "images/Imported Cards"
    };
    const positional = [];

    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === "--dry-run") {
            args.dryRun = true;
        } else if (value === "--settings") {
            args.settings = argv[++index];
        } else if (value === "--image") {
            args.image = argv[++index];
        } else if (value === "--image-dir") {
            args.imageDir = argv[++index];
        } else {
            positional.push(value);
        }
    }

    if (!args.settings && positional[0]) args.settings = positional[0];
    if (!args.image && positional[1]) args.image = positional[1];

    return args;
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeCardType(exported) {
    const raw = exported?.settings?.card_type || exported?.cardType || "";
    const value = String(raw).trim().toLowerCase();

    if (value.includes("leader")) return "leader";
    if (value.includes("character")) return "character";
    if (value.includes("stage")) return "stage";
    if (value.includes("event")) return "event";

    throw new Error(`Unsupported or missing card type: ${raw || "(blank)"}`);
}

function cleanText(value) {
    return String(value || "")
        .replace(/\*\*/g, "")
        .replace(/\r\n/g, "\n")
        .trim();
}

function numberValue(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function cardIdFromSettings(settings) {
    const series = String(settings.seriesInput || "").trim();
    const number = String(settings.cardNumberInput || "").trim();

    if (!series || !number) {
        throw new Error("Export is missing seriesInput or cardNumberInput.");
    }

    return `${series}-${number}`;
}

function colorData(settings) {
    const colors = Array.isArray(settings.selectedColors)
        ? settings.selectedColors.map(color => String(color).trim().toLowerCase()).filter(Boolean)
        : [];

    return {
        color: colors[0] || "",
        ...(colors.length > 1 ? { colors } : {})
    };
}

function attributeData(settings) {
    const attributes = Array.isArray(settings.selectedAttributes)
        ? settings.selectedAttributes.map(attribute => String(attribute).trim().toLowerCase()).filter(Boolean)
        : [];

    return attributes.join("/");
}

function imagePathForCard(cardId, imageArg, imageDir, dryRun) {
    if (!imageArg) {
        throw new Error("Settings exports do not include image data. Pass --image <card image path>.");
    }

    const source = path.resolve(imageArg);
    const extension = path.extname(source) || ".png";
    const relativeDir = imageDir.replace(/\\/g, "/").replace(/^\/+/, "");
    const targetDir = path.resolve(repoRoot, relativeDir);
    const target = path.join(targetDir, `${cardId}${extension}`);

    if (!dryRun) {
        fs.mkdirSync(targetDir, { recursive: true });
        if (path.resolve(source).toLowerCase() !== path.resolve(target).toLowerCase()) {
            fs.copyFileSync(source, target);
        }
    }

    return `../${relativeDir}/${cardId}${extension}`.replace(/\\/g, "/");
}

function makeBottomDeckReplacementEffect(cardId, text) {
    return {
        system: "customEffectV2",
        id: `${cardId}-bottom-deck-replacement`,
        automationStatus: "automated",
        sourceText: text,
        event: {
            type: "static",
            source: "thisCard",
            target: null,
            sourceType: null
        },
        optional: false,
        limit: null,
        costs: [],
        conditions: [],
        targets: [],
        actions: [
            {
                type: "replaceOwnCharacterBottomDeckWithTop"
            }
        ],
        generatedText: text,
        text,
        warnings: []
    };
}

function parseEffects(cardId, cardType, name, rawText) {
    const text = cleanText(rawText);
    if (!text) return [];

    if (/char(?:ac|c)?ters?.{0,80}(?:placed|sent|put).{0,80}bottom.{0,80}deck.{0,80}top.{0,80}deck.{0,80}instead/i.test(text)) {
        return [makeBottomDeckReplacementEffect(cardId, text)];
    }

    const parsed = globalThis.CustomEffectV2.parseAndValidate(text, {
        sourceCardName: name,
        cardType
    });

    return parsed.effects;
}

function cardFromExport(exported, options) {
    const settings = exported.settings || {};
    const cardType = normalizeCardType(exported);

    if (cardType === "event" && !settings.cardNameInput) {
        throw new Error("This export looks incomplete. Stage exports from the card site are currently unreliable, so add stages manually.");
    }

    const id = cardIdFromSettings(settings);
    const name = String(settings.cardNameInput || "").trim();
    if (!name) throw new Error("Export is missing cardNameInput.");

    const card = {
        id,
        cardNumber: id,
        name,
        cardType,
        type: String(settings.typeInput || "").trim(),
        ...colorData(settings),
        ...(attributeData(settings) ? { attribute: attributeData(settings) } : {}),
        rarity: String(settings.rarityInput || (cardType === "leader" ? "L" : "C")).trim() || "C",
        image: imagePathForCard(id, options.image, options.imageDir, options.dryRun),
        aliases: [],
        keywords: [],
        effects: parseEffects(id, cardType, name, settings.cardTextInput)
    };

    if (cardType === "leader") {
        card.power = numberValue(settings.powerInput);
        card.life = numberValue(settings.lifeInput);
    } else {
        card.cost = numberValue(settings.costInput);
        if (cardType === "character") {
            card.power = numberValue(settings.powerInput);
            card.counter = numberValue(settings.counterInput);
        }
    }

    return card;
}

function writeCard(card, dryRun) {
    const dataFile = dataFileByType[card.cardType];
    if (!dataFile) throw new Error(`No data file for card type ${card.cardType}.`);

    const absolute = path.resolve(repoRoot, dataFile);
    const data = readJson(absolute);
    data[card.cardNumber] = card;

    if (!dryRun) {
        fs.writeFileSync(absolute, `${JSON.stringify(data, null, 2)}\n`);
    }

    return absolute;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    if (!options.settings) {
        throw new Error("Usage: node scripts/import-card-settings.js --settings <export.json> --image <card.png> [--image-dir images/Set Name] [--dry-run]");
    }

    const exported = readJson(path.resolve(options.settings));
    const card = cardFromExport(exported, options);
    const targetFile = writeCard(card, options.dryRun);

    console.log(`${options.dryRun ? "Would import" : "Imported"} ${card.cardNumber} ${card.name} -> ${path.relative(repoRoot, targetFile)}`);
    console.log(`Effects: ${card.effects.length}`);
}

try {
    main();
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
