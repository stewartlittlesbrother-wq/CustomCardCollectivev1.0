// Manual Gameplay System - Works with existing game rendering
// This enhances the existing rendered DOM with manual controls

const NOTE_COLORS = ["#ffd93d", "#4fc3f7", "#81c784", "#ff8a65", "#ba68c8"];

// The stage zone holds a single card. Playing/dropping a card onto it DISPLACES
// whatever's already there - and the displaced card goes to the TRASH, it isn't
// silently destroyed (that was the "the stage under it just disappears" bug).
function placeCardOnStage(player, card) {
    if (!player) return;
    if (player.stage && player.stage !== card) {
        (player.trash = player.trash || []).push(player.stage);
        window.renderTrash?.();
    }
    player.stage = card;
    window.renderStages?.();
}

const manualPlay = {
    state: {
        life: 0,
        currentPlayer: "player1",
        settings: {
            autoDon: false,
            autoLife: false
        },
        notes: {}, // annotation key (see getAnnotationTargetKey) -> { text, color }
        arrows: [], // { from: annotation key, to: annotation key }
        // The opponent's annotations in an online match. Kept separate from our
        // own so a state push from them can never clobber what we've drawn, and
        // so they can be rendered in a distinct style.
        remoteNotes: {},
        remoteArrows: [],
        restState: {}, // cardId -> boolean
        arrowMode: false,
        noteMode: false,
        arrowFirstKey: null // annotation key of the first card picked while drawing an arrow
    },

    init() {
        console.log("Initializing manual gameplay...");
        this.loadSettings();
        this.setupEventListeners();
        this.setupCardInteractions();
    },

    loadSettings() {
        const saved = localStorage.getItem("manualPlaySettings");
        if (saved) {
            try {
                this.state.settings = JSON.parse(saved);
                const autoDonToggle = document.getElementById("autoDonToggle");
                if (autoDonToggle) autoDonToggle.checked = this.state.settings.autoDon;
                const autoLifeToggle = document.getElementById("autoLifeToggle");
                if (autoLifeToggle) autoLifeToggle.checked = this.state.settings.autoLife;
            } catch (e) {
                console.error("Failed to load settings", e);
            }
        }
    },

    saveSettings() {
        localStorage.setItem("manualPlaySettings", JSON.stringify(this.state.settings));
    },

    setupEventListeners() {
        console.log("Setting up event listeners...");
        
        // Settings toggles
        const autoDonToggle = document.getElementById("autoDonToggle");
        console.log("autoDonToggle:", autoDonToggle);
        autoDonToggle?.addEventListener("change", (e) => {
            console.log("autoDonToggle changed:", e.target.checked);
            this.state.settings.autoDon = e.target.checked;
            this.saveSettings();
        });

        const autoLifeToggle = document.getElementById("autoLifeToggle");
        console.log("autoLifeToggle:", autoLifeToggle);
        autoLifeToggle?.addEventListener("change", (e) => {
            console.log("autoLifeToggle changed:", e.target.checked);
            this.state.settings.autoLife = e.target.checked;
            this.saveSettings();
        });

        // Tools
        const drawArrowTool = document.getElementById("drawArrowTool");
        console.log("drawArrowTool:", drawArrowTool);
        drawArrowTool?.addEventListener("click", () => this.toggleArrowMode());
        
        
        const resetArrowsTool = document.getElementById("resetArrowsTool");
        console.log("resetArrowsTool:", resetArrowsTool);
        resetArrowsTool?.addEventListener("click", () => this.resetArrows());
        
        const restandAllTool = document.getElementById("restandAllTool");
        console.log("restandAllTool:", restandAllTool);
        restandAllTool?.addEventListener("click", () => this.restandAllCards());
        
        const addNoteTool = document.getElementById("addNoteTool");
        console.log("addNoteTool:", addNoteTool);
        addNoteTool?.addEventListener("click", () => this.toggleNoteMode());
        
        const clearNotesTool = document.getElementById("clearNotesTool");
        console.log("clearNotesTool:", clearNotesTool);
        clearNotesTool?.addEventListener("click", () => this.clearAllNotes());
        
        const undoTool = document.getElementById("undoTool");
        console.log("undoTool:", undoTool);
        undoTool?.addEventListener("click", () => this.undo());

        // Life controls
        const lifeMinus1 = document.getElementById("lifeMinus1");
        console.log("lifeMinus1:", lifeMinus1);
        lifeMinus1?.addEventListener("click", () => this.adjustLife(-1));
        
        const lifePlus1 = document.getElementById("lifePlus1");
        console.log("lifePlus1:", lifePlus1);
        lifePlus1?.addEventListener("click", () => this.adjustLife(1));
        
        const lifeMinus5 = document.getElementById("lifeMinus5");
        console.log("lifeMinus5:", lifeMinus5);
        lifeMinus5?.addEventListener("click", () => this.adjustLife(-5));
        
        const lifePlus5 = document.getElementById("lifePlus5");
        console.log("lifePlus5:", lifePlus5);
        lifePlus5?.addEventListener("click", () => this.adjustLife(5));
        
        const lifeDisplay = document.getElementById("lifeDisplay");
        console.log("lifeDisplay:", lifeDisplay);
        lifeDisplay?.addEventListener("click", () => this.promptLife());

        // Turn control
        const nextTurnBtn = document.getElementById("nextTurnBtn");
        console.log("nextTurnBtn:", nextTurnBtn);
        nextTurnBtn?.addEventListener("click", () => this.nextTurn());

        // Concede (online only - self.js hides it in local play).
        document.getElementById("concedeBtn")
            ?.addEventListener("click", () => window.handleOnlineConcede?.());


        console.log("Event listeners setup complete");
    },

    setupCardInteractions() {
        console.log("=== setupCardInteractions called ===");
        
        const highlightClass = "drop-zone-highlight";
        
        // Helper to highlight all zones
        const highlightAllZones = () => {
            document.querySelectorAll(".character-area, .stage-area, .trash-area, .hand, .life-area, .deck-area, .extra-faceup-area, .extra-facedown-area, .extra-slot-area").forEach(zone => {
                zone.classList.add(highlightClass);
                zone.style.background = "#4a90e2";
                zone.style.border = "3px solid #2563eb";
                zone.style.boxShadow = "0 0 20px rgba(74, 144, 226, 0.8) inset";
                zone.style.borderRadius = "8px";
            });
        };
        
        // Helper to clear all highlights
        const clearAllHighlights = () => {
            document.querySelectorAll(`.${highlightClass}`).forEach(zone => {
                zone.classList.remove(highlightClass);
                zone.style.background = "";
                zone.style.border = "";
                zone.style.boxShadow = "";
            });
            // Also clear top/bottom split indicators (life + deck)
            document.querySelectorAll(".split-drop-zone").forEach(z => z.remove());
        };

        // Helper to show TOP/BOTTOM split drop indicators over a pile (life or deck)
        const showSplitDropZone = (zone) => {
            if (zone.querySelectorAll(".split-drop-zone").length > 0) return;
            const rect = zone.getBoundingClientRect();

            const topZone = document.createElement("div");
            topZone.className = "split-drop-zone split-top-zone";
            topZone.textContent = "TOP";
            Object.assign(topZone.style, {
                position: "fixed",
                top: rect.top + "px",
                left: rect.left + "px",
                width: rect.width + "px",
                height: (rect.height / 2) + "px",
                border: "2px dashed rgba(255, 255, 0, 0.8)",
                backgroundColor: "rgba(255, 255, 0, 0.1)",
                pointerEvents: "none",
                zIndex: "999",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "white",
                fontSize: "14px",
                fontWeight: "bold",
                textShadow: "1px 1px 3px rgba(0, 0, 0, 0.8)"
            });

            const bottomZone = document.createElement("div");
            bottomZone.className = "split-drop-zone split-bottom-zone";
            bottomZone.textContent = "BOTTOM";
            Object.assign(bottomZone.style, {
                position: "fixed",
                top: (rect.top + rect.height / 2) + "px",
                left: rect.left + "px",
                width: rect.width + "px",
                height: (rect.height / 2) + "px",
                border: "2px dashed rgba(255, 100, 100, 0.8)",
                backgroundColor: "rgba(255, 100, 100, 0.1)",
                pointerEvents: "none",
                zIndex: "999",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "white",
                fontSize: "12px",
                fontWeight: "bold"
            });

            document.body.appendChild(topZone);
            document.body.appendChild(bottomZone);
        };

        // Resolve which character slot a drop should land in: the exact slot the
        // cursor is over if it's empty, otherwise the first empty slot as a fallback.
        const resolveCharacterSlot = (player, charSlotEl) => {
            if (!player.characters) player.characters = [];
            while (player.characters.length < 5) player.characters.push(null);

            const targetedIndex = charSlotEl ? Number(charSlotEl.getAttribute("data-slot")) : -1;
            if (Number.isInteger(targetedIndex) && targetedIndex >= 0 && !player.characters[targetedIndex]) {
                return targetedIndex;
            }
            return player.characters.findIndex(c => !c);
        };

        // Drag and drop - cards from deck to board/hand/life
        document.addEventListener("dragstart", (e) => {
            if (!e.target || typeof e.target.closest !== "function") return;
            const deckCard = e.target.closest("[data-card-source='deck']");
            if (deckCard) {
                const playerKey = deckCard.getAttribute("data-player");
                const player = gameState[playerKey];
                if (!player || player.deck.length === 0) return;
                
                const topCard = player.deck[player.deck.length - 1];
                console.log("✓ DECK CARD DRAG START:", topCard.name);
                
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("cardInstanceId", topCard.instanceId);
                e.dataTransfer.setData("playerKey", playerKey);
                e.dataTransfer.setData("fromDeck", "true");
                e.dataTransfer.setData("text/html", deckCard.innerHTML);
                deckCard.style.opacity = "0.5";
                
                highlightAllZones();
            }
        }, true);

        document.addEventListener("dragend", (e) => {
            if (!e.target || typeof e.target.closest !== "function") return;
            const deckCard = e.target.closest("[data-card-source='deck']");
            if (deckCard) {
                console.log("✓ DECK CARD DRAG END");
                deckCard.style.opacity = "1";
                clearAllHighlights();
            }
        }, true);

        // Drag the top card off an extra pile (face-up / face-down)
        document.addEventListener("dragstart", (e) => {
            if (!e.target || typeof e.target.closest !== "function") return;
            const extraCard = e.target.closest("[data-card-source='extra']");
            if (extraCard) {
                const playerKey = extraCard.getAttribute("data-player");
                const pileKey = extraCard.getAttribute("data-pile");
                const player = gameState[playerKey];
                const pile = player?.[pileKey];
                if (!pile || pile.length === 0) return;

                const topCard = pile[pile.length - 1];
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("cardInstanceId", topCard.instanceId);
                e.dataTransfer.setData("playerKey", playerKey);
                e.dataTransfer.setData("fromExtra", "true");
                e.dataTransfer.setData("extraPile", pileKey);
                extraCard.style.opacity = "0.5";
                highlightAllZones();
            }
        }, true);

        document.addEventListener("dragend", (e) => {
            if (!e.target || typeof e.target.closest !== "function") return;
            const extraCard = e.target.closest("[data-card-source='extra']");
            if (extraCard) {
                extraCard.style.opacity = "1";
                clearAllHighlights();
            }
        }, true);

        // Drag and drop - cards from hand to board (only visible selectable cards)
        document.addEventListener("dragstart", (e) => {
            if (!e.target || typeof e.target.closest !== "function") return;
            console.log("DRAGSTART event fired on:", e.target);
            const handCard = e.target.closest(".hand-card.selectable-card");
            if (handCard) {
                console.log("✓ HAND CARD DRAG START:", handCard.getAttribute("data-card-instance-id"));
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("cardInstanceId", handCard.getAttribute("data-card-instance-id") || "");
                e.dataTransfer.setData("playerKey", handCard.getAttribute("data-player") || "");
                e.dataTransfer.setData("fromHand", "true");
                e.dataTransfer.setData("text/html", handCard.innerHTML);
                handCard.style.opacity = "0.5";
                handCard.style.cursor = "grabbing";
                
                // Highlight ALL drop zones when dragging starts
                console.log("Highlighting all drop zones");
                highlightAllZones();
            }
        }, true); // Use capture phase

        document.addEventListener("dragend", (e) => {
            if (!e.target || typeof e.target.closest !== "function") return;
            const handCard = e.target.closest(".hand-card.selectable-card");
            if (handCard) {
                console.log("✓ HAND CARD DRAG END");
                handCard.style.opacity = "1";
                handCard.style.cursor = "grab";
                
                // Remove highlights from all zones
                console.log("Removing highlights from all drop zones");
                clearAllHighlights();
            }
        }, true); // Use capture phase
        
        // Drag board cards back to other zones/hand
        document.addEventListener("dragstart", (e) => {
            // Only process if hand card handler didn't already handle it
            if (!e.target || typeof e.target.closest !== "function") return;
            const handCard = e.target.closest(".hand-card.selectable-card");
            if (handCard) return; // Let hand card handler take it
            
            const boardCard = e.target.closest(".board-card-img");
            console.log("BOARD CARD DRAGSTART check:", boardCard ? "found" : "not found");
            
            if (boardCard) {
                const slot = boardCard.closest(".character-slot");
                const stageArea = boardCard.closest(".stage-area");
                const trashArea = boardCard.closest(".trash-area");
                
                console.log("Board card locations:", {slot: !!slot, stage: !!stageArea, trash: !!trashArea});
                
                if (slot || stageArea || trashArea) {
                    const playerKey = boardCard.getAttribute("data-player");
                    const player = gameState[playerKey];
                    console.log("Board card playerKey:", playerKey, "player exists:", !!player);
                    if (!player) return;
                    
                    let card = null;
                    if (slot) {
                        const slotIndex = parseInt(slot.getAttribute("data-slot"));
                        card = player.characters[slotIndex];
                        console.log("✓ BOARD CARD DRAG from character slot", slotIndex, "card:", card?.name);
                    } else if (stageArea) {
                        card = player.stage;
                        console.log("✓ BOARD CARD DRAG from stage, card:", card?.name);
                    } else if (trashArea) {
                        // Get the TOP card from trash (last in array)
                        card = player.trash?.length > 0 ? player.trash[player.trash.length - 1] : null;
                        console.log("✓ BOARD CARD DRAG from trash, card:", card?.name);
                    }
                    
                    if (card) {
                        console.log("✓ Setting drag data for board card");
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("cardInstanceId", card.instanceId);
                        e.dataTransfer.setData("playerKey", playerKey);
                        e.dataTransfer.setData("fromHand", "false");
                        boardCard.style.opacity = "0.5";
                        
                        // Highlight ALL drop zones when dragging board card
                        console.log("Highlighting all drop zones for board card");
                        highlightAllZones();
                    } else {
                        console.log("✗ Card not found in zone");
                    }
                }
            }
        }, true);
        
        document.addEventListener("dragend", (e) => {
            const boardCard = e.target.closest(".board-card-img");
            if (boardCard) {
                boardCard.style.opacity = "1";
                
                // Remove highlights from all zones
                console.log("Removing highlights on board card dragend");
                clearAllHighlights();
            }
        }, true);

        // Drag life cards to other zones
        document.addEventListener("dragstart", (e) => {
            // Check for a life card FIRST. Life card images also carry the
            // .board-card-img class, so bailing on that class earlier meant a
            // life drag set no drag data at all and every drop was rejected -
            // which is why cards could go into Life but never come out.
            const lifeCard = e.target.closest("[data-card-source='life']");
            if (!lifeCard) return;

            {
                const playerKey = lifeCard.getAttribute("data-player");
                const lifeIndex = parseInt(lifeCard.getAttribute("data-life-index"));
                const player = gameState[playerKey];
                
                if (!player || !player.life[lifeIndex]) return;
                
                const card = player.life[lifeIndex];
                console.log("✓ LIFE CARD DRAG START:", card.name || "Life Card", "index:", lifeIndex);
                
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("cardInstanceId", card.instanceId);
                e.dataTransfer.setData("playerKey", playerKey);
                e.dataTransfer.setData("fromLife", "true");
                e.dataTransfer.setData("lifeIndex", String(lifeIndex));
                lifeCard.style.opacity = "0.5";
                
                highlightAllZones();
            }
        }, true);

        document.addEventListener("dragend", (e) => {
            const lifeCard = e.target.closest("[data-card-source='life']");
            if (lifeCard) {
                console.log("✓ LIFE CARD DRAG END");
                lifeCard.style.opacity = "1";
                clearAllHighlights();
            }
        }, true);

        // DON attachment system - select one or more active DON!!, then click a
        // Character/Leader/Stage to attach them all at once.
        let selectedDonCards = [];   // DOM elements currently selected
        let selectedDonPlayer = null;

        const clearDonSelection = () => {
            selectedDonCards.forEach(card => card.classList.remove("selected-don"));
            selectedDonCards = [];
            selectedDonPlayer = null;
        };
        // Exposed so other flows (e.g. re-renders) can drop a stale selection.
        this.clearDonSelection = clearDonSelection;
        // The currently highlighted DON as {player, slot}, so double-clicking a
        // DON can rest the whole selection at once.
        this.getSelectedDonSlots = () => selectedDonCards.map(card => ({
            player: card.dataset.player,
            slot: Number(card.dataset.donSlot)
        }));

        // Click a DON card to add/remove it from the selection
        document.addEventListener("click", (e) => {
            if (!e.target || typeof e.target.closest !== "function") return;
            const donCard = e.target.closest(".don-card-img.selectable-don");
            if (!donCard) return;

            const playerKey = donCard.getAttribute("data-player");

            // Selecting a different player's DON starts a fresh selection.
            if (selectedDonPlayer && selectedDonPlayer !== playerKey) {
                clearDonSelection();
            }

            const index = selectedDonCards.indexOf(donCard);
            if (index !== -1) {
                // Clicking an already-selected DON removes it from the selection
                donCard.classList.remove("selected-don");
                selectedDonCards.splice(index, 1);
                if (!selectedDonCards.length) selectedDonPlayer = null;
            } else {
                donCard.classList.add("selected-don");
                selectedDonCards.push(donCard);
                selectedDonPlayer = playerKey;
            }
            console.log(`✓ ${selectedDonCards.length} DON selected`);
        }, true);

        // Click a character/leader/stage to attach ALL selected DON at once
        document.addEventListener("click", (e) => {
            if (!selectedDonCards.length || !selectedDonPlayer) return;
            if (!e.target || typeof e.target.closest !== "function") return;

            const charSlot = e.target.closest(".character-slot");
            const leaderArea = e.target.closest(".leader-area");
            const stageArea = e.target.closest(".stage-area");

            if (!charSlot && !leaderArea && !stageArea) return;

            const player = gameState[selectedDonPlayer];
            if (!player) return;

            let targetCard = null;
            let rerender = null;

            if (charSlot) {
                targetCard = player.characters[parseInt(charSlot.getAttribute("data-slot"))];
                rerender = window.renderCharacters;
            } else if (leaderArea) {
                targetCard = player.leader;
                rerender = window.renderLeaders;
            } else if (stageArea) {
                targetCard = player.stage;
                rerender = window.renderStages;
            }

            if (targetCard) {
                // Never attach more DON than the player actually has active.
                const amount = Math.min(selectedDonCards.length, player.don || 0);
                if (amount > 0) {
                    targetCard.attachedDon = (targetCard.attachedDon || 0) + amount;
                    player.don -= amount;
                    window.updateDonDisplay?.();
                    rerender?.();
                    console.log(`✓ Attached ${amount} DON`);
                }
            }

            clearDonSelection();

            // DON attach changes attachedDon + active DON count - sync it
            window.scheduleOnlineBoardSync?.();
        }, true);

        // Clicking anywhere that isn't a DON card or a valid attach target clears
        // the selection, so it never lingers unexpectedly.
        document.addEventListener("click", (e) => {
            if (!selectedDonCards.length) return;
            if (!e.target || typeof e.target.closest !== "function") return;

            const isDon = e.target.closest(".don-card-img.selectable-don");
            const isTarget = e.target.closest(".character-slot, .leader-area, .stage-area");
            if (!isDon && !isTarget) {
                clearDonSelection();
                console.log("✓ DON selection cleared");
            }
        }, true);

        // Draw Arrow mode: first click picks a card, second click (a different card)
        // draws an arrow between them and turns arrow mode back off.
        document.addEventListener("click", (e) => {
            if (!this.state.arrowMode) return;
            if (!e.target || typeof e.target.closest !== "function") return;

            const el = e.target.closest(".character-slot, .board-leader-card, .board-stage-card, .hand-card[data-card-instance-id]");
            if (!el) return;

            const key = getAnnotationTargetKey(el);
            if (!key) return;

            if (!this.state.arrowFirstKey) {
                this.state.arrowFirstKey = key;
                resolveAnnotationTargetElement(key)?.classList.add("arrow-selected-first");
                console.log("✓ Arrow: first card selected", key);
                return;
            }

            if (key === this.state.arrowFirstKey) {
                // Clicked the same card again - cancel the selection
                resolveAnnotationTargetElement(key)?.classList.remove("arrow-selected-first");
                this.state.arrowFirstKey = null;
                return;
            }

            resolveAnnotationTargetElement(this.state.arrowFirstKey)?.classList.remove("arrow-selected-first");
            this.state.arrows.push({ from: this.state.arrowFirstKey, to: key });
            this.state.arrowFirstKey = null;
            console.log("✓ Arrow drawn", this.state.arrows[this.state.arrows.length - 1]);

            this.toggleArrowMode(); // one arrow per activation, matching the DON select/attach flow
            this.reapplyAnnotations();
            this.pushAnnotations();
        }, true);

        // Add Note mode: click any card to attach a short colored note to it
        document.addEventListener("click", (e) => {
            if (!this.state.noteMode) return;
            if (!e.target || typeof e.target.closest !== "function") return;

            const el = e.target.closest(".character-slot, .board-leader-card, .board-stage-card, .hand-card[data-card-instance-id]");
            if (!el) return;

            const key = getAnnotationTargetKey(el);
            if (!key) return;

            const existing = this.state.notes[key];
            const defaultColor = existing ? existing.color : NOTE_COLORS[Object.keys(this.state.notes).length % NOTE_COLORS.length];
            showNoteDialog({
                text: existing ? existing.text : "",
                color: defaultColor,
                fontSize: existing ? existing.fontSize : 12
            }, (result) => {
                if (result.text.trim() === "") {
                    delete this.state.notes[key];
                } else {
                    this.state.notes[key] = {
                        text: result.text.trim(),
                        color: result.color,
                        fontSize: result.fontSize
                    };
                }

                console.log("✓ Note updated for", key);
                this.reapplyAnnotations();
                this.pushAnnotations();
            });

            // Auto-exit note mode after placing a note (matches Draw Arrow behavior)
            if (this.state.noteMode) this.toggleNoteMode();
        }, true);

        // dragover - allow zones for regular cards and show top/bottom split for piles
        document.addEventListener("dragover", (e) => {
            if (!e.target || typeof e.target.closest !== "function") return;
            const zone = e.target.closest(".character-area, .stage-area, .trash-area, .hand, .don-area, .life-area, .deck-area, .extra-faceup-area, .extra-facedown-area, .extra-slot-area");
            if (zone) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";

                // Life and deck piles support dropping on the top or bottom half
                if (zone.classList.contains("life-area") || zone.classList.contains("deck-area")) {
                    showSplitDropZone(zone);
                }
            }
        }, false);
        
        // Global dragleave - do nothing, keep highlights until dragend
        document.addEventListener("dragleave", (e) => {
            // Don't clear highlights - they stay until dragend
        }, false);
        
        // Which extra pile (if any) a drop landed on.
        const getExtraDropTarget = (e) => {
            if (!e.target || typeof e.target.closest !== "function") return null;
            const el = e.target.closest(".extra-faceup-area, .extra-facedown-area, .extra-slot-area");
            if (!el) return null;
            const playerKey = el.getAttribute("data-player");
            const player = gameState[playerKey];
            const pileKey = el.getAttribute("data-pile");
            // Extra slots act like the stage: they hold ONE card. Reject the drop
            // (return null) when the slot is already occupied so a second card
            // can't stack on top of it.
            if (el.classList.contains("extra-slot-area") &&
                Array.isArray(player?.[pileKey]) && player[pileKey].length > 0) {
                return null;
            }
            return {
                player,
                pileKey,
                // Slots show their card face-up, like the stage.
                faceUp: el.classList.contains("extra-faceup-area") || el.classList.contains("extra-slot-area")
            };
        };

        // UNIFIED drop handler for all zones
        document.addEventListener("drop", (e) => {
            const cardInstanceId = e.dataTransfer.getData("cardInstanceId");
            const playerKey = e.dataTransfer.getData("playerKey");
            const fromHand = e.dataTransfer.getData("fromHand");
            const fromDonArea = e.dataTransfer.getData("fromDonArea");
            const fromDeck = e.dataTransfer.getData("fromDeck");
            const fromLife = e.dataTransfer.getData("fromLife");
            const fromExtra = e.dataTransfer.getData("fromExtra");
            const extraPile = e.dataTransfer.getData("extraPile");
            const lifeIndex = parseInt(e.dataTransfer.getData("lifeIndex") || "-1");

            console.log("DROP fired:", {cardInstanceId, playerKey, fromHand, fromDonArea, fromDeck, fromLife, fromExtra});

            if (!cardInstanceId || !playerKey) {
                console.log("✗ No card data");
                return;
            }

            if (fromDonArea === "true") {
                console.log("DON card drop ignored - handled by mouse system");
                return;
            }

            e.preventDefault();
            e.stopPropagation();
            clearAllHighlights();

            const extraTarget = getExtraDropTarget(e);
            const flags = { fromDeck, fromLife, fromHand, fromExtra, extraPile };

            if (extraTarget) {
                // Any card -> an extra pile.
                handleDropIntoExtra(e, cardInstanceId, playerKey, extraTarget, flags);
            } else if (fromExtra === "true") {
                // Extra pile -> any other zone.
                handleExtraCardDrop(e, cardInstanceId, playerKey, extraPile);
            } else if (fromDeck === "true") {
                handleDeckCardDrop(e, cardInstanceId, playerKey);
            } else if (fromLife === "true") {
                handleLifeCardDrop(e, cardInstanceId, playerKey, lifeIndex);
            } else if (fromHand === "true") {
                handleHandCardDrop(e, cardInstanceId, playerKey);
            } else if (fromHand === "false") {
                handleBoardCardDrop(e, cardInstanceId, playerKey);
            }

            // A card was handled - play the "moving a card" click.
            window.playCardSound?.();

            // Propagate the resulting state to the opponent (no-op in local play).
            window.scheduleOnlineBoardSync?.();
        }, false);

        // Remove a card by identity from whichever zone the drag started in.
        const removeSourceCardByIdentity = (player, cardInstanceId, flags) => {
            const takeFrom = (arr) => {
                if (!Array.isArray(arr)) return null;
                const i = arr.findIndex(c => c && c.instanceId === cardInstanceId);
                return i === -1 ? null : arr.splice(i, 1)[0];
            };
            if (flags.fromExtra === "true") return takeFrom(player[flags.extraPile]);
            if (flags.fromDeck === "true") return takeFrom(player.deck);
            if (flags.fromLife === "true") return takeFrom(player.life);
            if (flags.fromHand === "true") return takeFrom(player.hand);
            if (flags.fromHand === "false") {
                for (let i = 0; i < (player.characters || []).length; i++) {
                    if (player.characters[i]?.instanceId === cardInstanceId) {
                        const c = player.characters[i];
                        player.characters[i] = null;
                        window.detachDonToRested?.(player, c); // DON falls off, rested
                        return c;
                    }
                }
                if (player.stage?.instanceId === cardInstanceId) {
                    const c = player.stage;
                    player.stage = null;
                    window.detachDonToRested?.(player, c);
                    return c;
                }
                return takeFrom(player.trash);
            }
            return null;
        };

        const renderAllSourceZones = () => {
            window.renderHands?.();
            window.renderDecks?.();
            window.renderLifeCards?.();
            window.renderCharacters?.();
            window.renderStages?.();
            window.renderTrash?.();
            window.renderExtraPiles?.();
            window.renderExtraSlots?.();
        };

        // Place a card into whatever standard zone the drop event points at.
        // Returns true if placed. Used only by the extra-pile "drag out" flow.
        const placeCardInStandardZone = (e, player, card) => {
            if (!e.target || typeof e.target.closest !== "function") return false;
            const topOrBottom = (el) => {
                const r = el.getBoundingClientRect();
                return e.clientY < r.top + r.height / 2 ? "top" : "bottom";
            };
            const charSlot = e.target.closest(".character-slot");
            if (charSlot || e.target.closest(".character-area")) {
                const slot = resolveCharacterSlot(player, charSlot);
                if (slot === -1) return false;
                player.characters[slot] = card;
                window.renderCharacters?.();
                return true;
            }
            if (e.target.closest(".stage-area")) {
                placeCardOnStage(player, card);
                return true;
            }
            if (e.target.closest(".trash-area")) {
                (player.trash ||= []).push(card);
                window.renderTrash?.();
                return true;
            }
            if (e.target.closest(".hand")) {
                player.hand.push(card);
                window.renderHands?.();
                return true;
            }
            const deckArea = e.target.closest(".deck-area");
            if (deckArea) {
                if (topOrBottom(deckArea) === "top") player.deck.push(card);
                else player.deck.unshift(card);
                window.renderDecks?.();
                return true;
            }
            const lifeArea = e.target.closest(".life-area");
            if (lifeArea) {
                const lifeCard = { ...card, faceUp: card.faceUp === true };
                if (topOrBottom(lifeArea) === "top") player.life.unshift(lifeCard);
                else player.life.push(lifeCard);
                window.renderLifeCards?.();
                return true;
            }
            return false;
        };

        // Any card (from any zone) -> an extra pile. Removes from source, adds
        // to the target pile with the pile's face-up/face-down orientation.
        const handleDropIntoExtra = (e, cardInstanceId, playerKey, extraTarget, flags) => {
            const sourcePlayer = gameState[playerKey];
            if (!sourcePlayer || !extraTarget.player || !extraTarget.pileKey) return;

            const card = removeSourceCardByIdentity(sourcePlayer, cardInstanceId, flags);
            if (!card) return;

            if (!Array.isArray(extraTarget.player[extraTarget.pileKey])) {
                extraTarget.player[extraTarget.pileKey] = [];
            }
            extraTarget.player[extraTarget.pileKey].push({ ...card, faceUp: extraTarget.faceUp });
            renderAllSourceZones();
        };

        // Extra pile -> any standard zone. Removes the top/identity card from the
        // pile and places it; restores it to the pile if there's no valid target.
        const handleExtraCardDrop = (e, cardInstanceId, playerKey, extraPile) => {
            const player = gameState[playerKey];
            const pile = player?.[extraPile];
            if (!player || !Array.isArray(pile)) return;

            const idx = pile.findIndex(c => c && c.instanceId === cardInstanceId);
            if (idx === -1) return;
            const card = pile.splice(idx, 1)[0];

            if (!placeCardInStandardZone(e, player, card)) {
                pile.push(card); // no valid drop target - put it back
            }
            window.renderExtraPiles?.();
            window.renderExtraSlots?.();
        };

        // Handler for deck card drops
        const handleDeckCardDrop = (e, cardInstanceId, playerKey) => {
            if (!e.target || typeof e.target.closest !== "function") return;
            const player = gameState[playerKey];
            if (!player || player.deck.length === 0) {
                console.log("✗ Deck is empty or player not found");
                return;
            }
            
            // Find the card in deck (should be top card)
            const deckIndex = player.deck.findIndex(c => c.instanceId === cardInstanceId);
            if (deckIndex === -1) {
                console.log("✗ Card not found in deck");
                return;
            }
            
            const card = player.deck[deckIndex];
            
            // Check drop zone
            const lifeArea = e.target.closest(".life-area");
            const handArea = e.target.closest(".hand");
            const charSlot = e.target.closest(".character-slot");
            const charArea = e.target.closest(".character-area");
            const stageArea = e.target.closest(".stage-area");
            const trashArea = e.target.closest(".trash-area");

            // Remove from deck
            player.deck.splice(deckIndex, 1);
            console.log("✓ Removed from deck:", card.name);
            
            if (lifeArea) {
                // Determine if top or bottom based on mouse Y position
                const rect = lifeArea.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                const isTop = e.clientY < midY;
                
                // Create life card object (always face-down)
                const lifeCard = {
                    ...card,
                    faceUp: false,
                    instanceId: card.instanceId
                };
                
                if (isTop) {
                    player.life.unshift(lifeCard);  // Top of life pile = front of array
                    console.log("✓ Added to TOP of life");
                } else {
                    player.life.push(lifeCard);  // Bottom of life pile = end of array
                    console.log("✓ Added to BOTTOM of life");
                }
                
                window.renderLifeCards?.();
                window.renderDecks?.();
            } else if (handArea) {
                player.hand.push(card);
                console.log("✓ Added to hand");
                window.renderHands?.();
                window.renderDecks?.();
            } else if (charArea) {
                const slotIndex = resolveCharacterSlot(player, charSlot);
                if (slotIndex === -1) {
                    console.log("✗ No empty character slots");
                    player.deck.push(card);
                    window.renderDecks?.();
                    return;
                }
                player.characters[slotIndex] = card;
                console.log("✓ Added to character slot", slotIndex);
                window.renderCharacters?.();
                window.renderDecks?.();
            } else if (stageArea) {
                placeCardOnStage(player, card);
                console.log("✓ Added to stage");
                window.renderDecks?.();
            } else if (trashArea) {
                if (!player.trash) player.trash = [];
                player.trash.push(card);
                console.log("✓ Added to trash");
                window.renderTrash?.();
                window.renderDecks?.();
            } else {
                // No valid zone, put card back
                player.deck.push(card);
                console.log("✗ No valid drop zone, card returned to deck");
                window.renderDecks?.();
            }
        };
        
        // Handler for life card drops
        const handleLifeCardDrop = (e, cardInstanceId, playerKey, lifeIndex) => {
            if (!e.target || typeof e.target.closest !== "function") return;
            const player = gameState[playerKey];
            if (!player) return;

            // Resolve the card by IDENTITY, not by the index captured when the
            // element was rendered. A stale index silently removes a DIFFERENT
            // card - which looked like cards duplicating in hand while others
            // vanished from life. Index is only a last-resort fallback.
            let index = player.life.findIndex(c => c && c.instanceId === cardInstanceId);
            if (index === -1 && lifeIndex >= 0 && player.life[lifeIndex]) {
                index = lifeIndex;
            }
            if (index === -1) {
                console.log("✗ Life card not found");
                return;
            }
            lifeIndex = index;

            const card = player.life[lifeIndex];
            console.log("✓ Dragging life card:", card.name || "Life Card");
            
            // Check drop zones
            const lifeArea = e.target.closest(".life-area");
            const handArea = e.target.closest(".hand");
            const charSlot = e.target.closest(".character-slot");
            const charArea = e.target.closest(".character-area");
            const stageArea = e.target.closest(".stage-area");
            const trashArea = e.target.closest(".trash-area");
            const deckArea = e.target.closest(".deck-area");

            // Remove from life
            player.life.splice(lifeIndex, 1);
            console.log("✓ Removed from life at index", lifeIndex);
            
            if (lifeArea) {
                // Moving to another life area (self or opponent) or reordering
                const rect = lifeArea.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                const isTop = e.clientY < midY;
                
                if (isTop) {
                    player.life.unshift(card);  // Top of life pile = front of array
                    console.log("✓ Added to TOP of life");
                } else {
                    player.life.push(card);  // Bottom of life pile = end of array
                    console.log("✓ Added to BOTTOM of life");
                }
                
                window.renderLifeCards?.();
            } else if (handArea) {
                // Only the newest life grab stays highlighted - clear the rest.
                (player.hand || []).forEach(c => { if (c) delete c.fromLife; });
                card.fromLife = true; // highlight it in hand (both players see it)
                player.hand.push(card);
                console.log("✓ Added to hand");
                window.renderHands?.();
                window.renderLifeCards?.();
            } else if (charArea) {
                const slotIndex = resolveCharacterSlot(player, charSlot);
                if (slotIndex === -1) {
                    console.log("✗ No empty character slots");
                    player.life.push(card);
                    window.renderLifeCards?.();
                    return;
                }
                player.characters[slotIndex] = card;
                console.log("✓ Added to character slot", slotIndex);
                window.renderCharacters?.();
                window.renderLifeCards?.();
            } else if (stageArea) {
                placeCardOnStage(player, card);
                console.log("✓ Added to stage");
                window.renderLifeCards?.();
            } else if (trashArea) {
                if (!player.trash) player.trash = [];
                player.trash.push(card);
                console.log("✓ Added to trash");
                window.renderTrash?.();
                window.renderLifeCards?.();
            } else if (deckArea) {
                // Determine if top or bottom based on mouse Y position
                const rect = deckArea.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                const isTop = e.clientY < midY;

                if (isTop) {
                    player.deck.push(card);  // Top of deck = end of array (drawn first)
                    console.log("✓ Added to TOP of deck");
                } else {
                    player.deck.unshift(card);  // Bottom of deck = front of array
                    console.log("✓ Added to BOTTOM of deck");
                }
                
                window.renderDecks?.();
                window.renderLifeCards?.();
            } else {
                // No valid zone, put card back
                player.life.push(card);
                console.log("✗ No valid drop zone, card returned to life");
                window.renderLifeCards?.();
            }
        };
        
        // Handler for DON card drops
        const handleDonCardDrop = (e, cardInstanceId, playerKey) => {
            if (!e.target || typeof e.target.closest !== "function") return;
            const player = gameState[playerKey];
            if (!player) return;
            
            // Initialize floating DON array if needed
            if (!player.floatingDon) player.floatingDon = [];
            
            // Check if dropping back on don-area
            const donArea = e.target.closest(".don-area");
            if (donArea) {
                console.log("✓ DON dropped back to don-area");
                // Put the DON back in the count
                player.don++;
                window.updateDonDisplay?.();
                return;
            }
            
            // DON is being placed as a floater on the board
            // Decrement don count (only if it's a new placement)
            if (player.don > 0) {
                player.don--;
                console.log("✓ Decremented DON count to", player.don);
                window.updateDonDisplay?.();
            }
            
            // Get board-relative coordinates
            const gameBoard = document.querySelector(".game-board");
            const boardRect = gameBoard ? gameBoard.getBoundingClientRect() : { left: 0, top: 0 };
            
            // Create a floating DON card object
            const floatingDon = {
                instanceId: "DON!!" + Math.random(),
                name: "DON!!",
                image: donImage || "/images/cards/don.png",
                state: "active",
                x: e.clientX - boardRect.left - 40,  // Board-relative, centered on cursor
                y: e.clientY - boardRect.top - 55
            };
            
            player.floatingDon.push(floatingDon);
            console.log("✓ Created floating DON at", floatingDon.x, floatingDon.y);
            
            // Render the floating DON cards
            window.renderFloatingDon?.();
        };
        
        // Handler for hand card drops to board
        const handleHandCardDrop = (e, cardInstanceId, playerKey) => {
            if (!e.target || typeof e.target.closest !== "function") return;
            let zone = null;
            const charSlot = e.target.closest(".character-slot");
            if (charSlot) zone = charSlot.parentElement;
            
            if (!zone) {
                zone = e.target.closest(".character-area, .stage-area, .trash-area, .deck-area, .life-area");
            }

            if (!zone) {
                console.log("✗ No zone for hand card drop");
                return;
            }
            
            const player = gameState[playerKey];
            if (!player) return;
            
            // Find and remove from hand
            const cardIndex = player.hand.findIndex(c => c.instanceId === cardInstanceId);
            if (cardIndex === -1) {
                console.log("✗ Card not in hand");
                return;
            }
            const card = player.hand[cardIndex];
            player.hand.splice(cardIndex, 1);
            // A card that leaves the hand loses its "from Life" highlight.
            delete card.fromLife;
            console.log("✓ Removed from hand:", card.name);
            
            // Add to target zone
            let needsHandRender = false;
            if (zone.classList.contains("character-area")) {
                const slotIndex = resolveCharacterSlot(player, charSlot);
                if (slotIndex === -1) {
                    console.log("✗ No empty slots");
                    player.hand.push(card);
                    window.renderHands?.();
                    return;
                }
                player.characters[slotIndex] = card;
                console.log("✓ Added to character slot", slotIndex);
                window.renderCharacters?.();
                needsHandRender = true;
            } else if (zone.classList.contains("stage-area")) {
                placeCardOnStage(player, card);
                console.log("✓ Added to stage");
                needsHandRender = true;
            } else if (zone.classList.contains("trash-area")) {
                if (!player.trash) player.trash = [];
                player.trash.push(card);
                console.log("✓ Added to trash");
                window.renderTrash?.();
                needsHandRender = true;
            } else if (zone.classList.contains("deck-area")) {
                const rect = zone.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                const isTop = e.clientY < midY;

                if (isTop) {
                    player.deck.push(card);  // Top of deck = end of array (drawn first)
                    console.log("✓ Added to TOP of deck");
                } else {
                    player.deck.unshift(card);  // Bottom of deck = front of array
                    console.log("✓ Added to BOTTOM of deck");
                }

                window.renderDecks?.();
                needsHandRender = true;
            } else if (zone.classList.contains("life-area")) {
                const rect = zone.getBoundingClientRect();
                const isTop = e.clientY < rect.top + rect.height / 2;
                const lifeCard = { ...card, faceUp: card.faceUp === true };
                if (isTop) {
                    player.life.unshift(lifeCard);
                    console.log("✓ Added to TOP of life");
                } else {
                    player.life.push(lifeCard);
                    console.log("✓ Added to BOTTOM of life");
                }
                window.renderLifeCards?.();
                needsHandRender = true;
            }

            if (needsHandRender) {
                console.log("Rendering hands after card move");
                window.renderHands?.();
            }
        };
        
        // Handler for board card drops
        const handleBoardCardDrop = (e, cardInstanceId, playerKey) => {
            if (!e.target || typeof e.target.closest !== "function") return;
            const handContainer = e.target.closest(".hand");
            if (handContainer) {
                // Card returning to hand
                const player = gameState[playerKey];
                if (!player) return;
                
                let card = null;
                
                // Check character slots
                for (let i = 0; i < player.characters.length; i++) {
                    if (player.characters[i]?.instanceId === cardInstanceId) {
                        card = player.characters[i];
                        player.characters[i] = null;
                        window.detachDonToRested?.(player, card); // DON falls off, rested
                        console.log("✓ Removed from character slot", i);
                        break;
                    }
                }

                // Check stage
                if (!card && player.stage?.instanceId === cardInstanceId) {
                    card = player.stage;
                    player.stage = null;
                    window.detachDonToRested?.(player, card);
                    console.log("✓ Removed from stage");
                }
                
                // Check trash
                if (!card && player.trash) {
                    const idx = player.trash.findIndex(c => c.instanceId === cardInstanceId);
                    if (idx !== -1) {
                        card = player.trash[idx];
                        player.trash.splice(idx, 1);
                        console.log("✓ Removed from trash at index", idx);
                    }
                }
                
                if (!card) {
                    console.log("✗ Card not found in any zone");
                    return;
                }
                
                player.hand.push(card);
                console.log("✓ Added to hand, hand length:", player.hand.length);
                
                window.renderHands?.();
                window.renderCharacters?.();
                window.renderStages?.();
                window.renderTrash?.();
                console.log("✓ Card returned to hand - renders called");
                return;
            }
            
            // Card moving between board zones
            let zone = null;
            const charSlot = e.target.closest(".character-slot");
            if (charSlot) zone = charSlot.parentElement;
            
            if (!zone) {
                zone = e.target.closest(".character-area, .stage-area, .trash-area, .deck-area, .life-area");
            }

            if (!zone) {
                console.log("✗ No zone for board card move");
                return;
            }
            
            const player = gameState[playerKey];
            if (!player) return;
            
            let card = null;
            let fromZoneType = null; // Track where card came from
            
            // Find card from board zones. DON detaching is decided AFTER we know
            // the destination (below), because a character dragged to another
            // character slot has not left the field and keeps its DON.
            for (let i = 0; i < player.characters.length; i++) {
                if (player.characters[i]?.instanceId === cardInstanceId) {
                    card = player.characters[i];
                    player.characters[i] = null;
                    fromZoneType = "characters";
                    console.log("✓ Removed from character slot", i);
                    break;
                }
            }
            if (!card && player.stage?.instanceId === cardInstanceId) {
                card = player.stage;
                player.stage = null;
                fromZoneType = "stage";
                console.log("✓ Removed from stage");
            }
            if (!card && player.trash) {
                const idx = player.trash.findIndex(c => c.instanceId === cardInstanceId);
                if (idx !== -1) {
                    card = player.trash[idx];
                    player.trash.splice(idx, 1);
                    fromZoneType = "trash";
                    console.log("✓ Removed from trash");
                }
            }
            
            if (!card) {
                console.log("✗ Card not found");
                return;
            }

            // If a character (or stage) with DON!! attached is moving to a
            // DIFFERENT field, its DON falls off and returns rested. Staying in
            // the same field (e.g. shuffling character slots) keeps the DON.
            const stayedInField =
                (fromZoneType === "characters" && zone.classList.contains("character-area")) ||
                (fromZoneType === "stage" && zone.classList.contains("stage-area"));
            if ((fromZoneType === "characters" || fromZoneType === "stage") && !stayedInField) {
                window.detachDonToRested?.(player, card);
            }

            // Add to target zone
            if (zone.classList.contains("character-area")) {
                const slotIndex = resolveCharacterSlot(player, charSlot);
                if (slotIndex === -1) {
                    console.log("✗ No empty slots");
                    // Put card back where it came from - not implemented, just lose it
                    return;
                }
                player.characters[slotIndex] = card;
                console.log("✓ Added to character slot", slotIndex);
                window.renderCharacters?.();

                // Also render the old zone to clear it
                if (fromZoneType === "stage") window.renderStages?.();
                if (fromZoneType === "trash") window.renderTrash?.();
            } else if (zone.classList.contains("stage-area")) {
                placeCardOnStage(player, card);
                console.log("✓ Added to stage");

                // Also render the old zone to clear it
                if (fromZoneType === "characters") window.renderCharacters?.();
                if (fromZoneType === "trash") window.renderTrash?.();
            } else if (zone.classList.contains("trash-area")) {
                if (!player.trash) player.trash = [];
                player.trash.push(card);
                console.log("✓ Added to trash");
                window.renderTrash?.();

                // Also render the old zone to clear it
                if (fromZoneType === "characters") window.renderCharacters?.();
                if (fromZoneType === "stage") window.renderStages?.();
            } else if (zone.classList.contains("deck-area")) {
                const rect = zone.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                const isTop = e.clientY < midY;

                if (isTop) {
                    player.deck.push(card);  // Top of deck = end of array (drawn first)
                    console.log("✓ Added to TOP of deck");
                } else {
                    player.deck.unshift(card);  // Bottom of deck = front of array
                    console.log("✓ Added to BOTTOM of deck");
                }

                window.renderDecks?.();

                // Also render the old zone to clear it
                if (fromZoneType === "characters") window.renderCharacters?.();
                if (fromZoneType === "stage") window.renderStages?.();
                if (fromZoneType === "trash") window.renderTrash?.();
            } else if (zone.classList.contains("life-area")) {
                const rect = zone.getBoundingClientRect();
                const isTop = e.clientY < rect.top + rect.height / 2;
                const lifeCard = { ...card, faceUp: card.faceUp === true };
                if (isTop) {
                    player.life.unshift(lifeCard);
                    console.log("✓ Added to TOP of life");
                } else {
                    player.life.push(lifeCard);
                    console.log("✓ Added to BOTTOM of life");
                }
                window.renderLifeCards?.();

                // Also render the old zone to clear it
                if (fromZoneType === "characters") window.renderCharacters?.();
                if (fromZoneType === "stage") window.renderStages?.();
                if (fromZoneType === "trash") window.renderTrash?.();
            }
        };

        // The native dblclick event is unreliable here: a single click can
        // trigger a re-render (selection highlights, DON attach, online state
        // arriving), and self.js rebuilds zones with innerHTML - so the second
        // click lands on a BRAND NEW element and the browser never sees a
        // double-click at all. That is the main reason resting "sometimes
        // doesn't fire".
        //
        // So detect it ourselves from two clicks on the same LOGICAL card within
        // the double-click window, keyed by position rather than element
        // identity. Survives any number of re-renders in between.
        const DOUBLE_CLICK_MS = 400;
        let lastRestClick = { key: null, at: 0 };

        const restTargetKey = (el) => {
            const donCard = el.closest(".don-card-img");
            if (donCard) return `don:${donCard.dataset.player}:${donCard.dataset.donSlot}`;
            return getAnnotationTargetKey(el);
        };

        document.addEventListener("click", (e) => {
            if (!e.target || typeof e.target.closest !== "function") return;

            const key = restTargetKey(e.target);
            if (!key || key.startsWith("hand:")) return;

            const now = Date.now();
            const isDouble = key === lastRestClick.key && (now - lastRestClick.at) < DOUBLE_CLICK_MS;

            if (!isDouble) {
                lastRestClick = { key, at: now };
                return;
            }

            lastRestClick = { key: null, at: 0 };
            toggleRestForKey(key, e.target);
        }, true);

        // Toggle rest for a logical card key, re-resolving the element each time
        // so a stale reference can't be used.
        const toggleRestForKey = (key, sourceEl) => {
            if (key.startsWith("don:")) {
                const [, playerKey, slotText] = key.split(":");
                const player = gameState?.[playerKey];
                if (!player) return;

                // Rest EVERY highlighted DON of this player (plus the one being
                // double-clicked). With nothing highlighted this is just the
                // one DON, toggling it like before.
                const highlighted = (window.manualPlay?.getSelectedDonSlots?.() || [])
                    .filter(s => s.player === playerKey)
                    .map(s => s.slot);

                if (highlighted.length) {
                    const slots = new Set(highlighted);
                    slots.add(Number(slotText));
                    window.restDonSlots?.(player, [...slots]);
                } else if (window.toggleDonSlot?.(player, Number(slotText))) {
                    window.updateDonDisplay?.();
                    window.scheduleOnlineBoardSync?.();
                    console.log("DON rested toggled at slot", slotText);
                }

                // clearDonSelection is scoped to setupCardInteractions; reach it
                // through the exposed object rather than closing over it.
                window.manualPlay?.clearDonSelection?.();
                return;
            }

            const el = resolveAnnotationTargetElement(key) || sourceEl;
            const resolved = resolveBoardCard(el);
            if (!resolved?.card) return;

            const nowRested = (resolved.card.state || "active") !== "rested";
            resolved.card.state = nowRested ? "rested" : "active";

            // Reflect it immediately, then let the zone re-render persist it.
            const boardCard = el.closest(".board-leader-card, .board-character-card, .board-stage-card, .character-card")
                || el.querySelector?.(".board-leader-card, .board-character-card, .board-stage-card, .character-card");
            boardCard?.classList.toggle("board-card-rested", nowRested);

            window.renderLeaders?.();
            window.renderCharacters?.();
            window.renderStages?.();
            window.scheduleOnlineBoardSync?.();
            console.log("Card rested toggled ->", nowRested ? "rested" : "active");
        };

        // Suppress the browser's own dblclick for cards: resting is driven by
        // the click-pair detector above, and letting both run would toggle
        // twice (a visible no-op).
        document.addEventListener("dblclick", (e) => {
            if (!e.target || typeof e.target.closest !== "function") return;
            if (e.target.closest(".don-card-img, .character-slot, .board-leader-card, .board-stage-card")) {
                e.preventDefault();
            }
        }, true);
        
        // Prevent text selection on hand cards without blocking drag
        document.addEventListener("selectstart", (e) => {
            const handCard = e.target.closest(".hand-card");
            if (handCard) {
                e.preventDefault();
            }
        });
    },

    adjustLife(amount) {
        this.state.life += amount;
        const display = document.getElementById("lifeDisplay");
        if (display) display.textContent = this.state.life;
    },

    promptLife() {
        const value = prompt("Enter counter value:", this.state.life);
        if (value !== null && !isNaN(value)) {
            this.state.life = parseInt(value, 10);
            const display = document.getElementById("lifeDisplay");
            if (display) display.textContent = this.state.life;
        }
    },

    nextTurn() {
        // In an online match the turn is ONE shared value living in the match
        // document, not something each client tracks for itself. Running the
        // local switch below would only advance this player's own board - which
        // is exactly why both players used to have independent turn counters and
        // DON!! progression that the other side never saw. Hand off to the online
        // path instead: it flips the shared pointer, and each client then runs
        // its own start-of-turn (restand + DON) when that pointer lands on them.
        if (window.isOnlineMatchActive?.()) {
            if (!window.isOwnOnlineTurn?.()) {
                window.addGameLog?.("It's not your turn yet.");
                return;
            }
            window.handleOnlinePassTurn?.();
            return;
        }

        // Local (vs self) play keeps driving both sides from this one client.
        const nextPlayer = this.state.currentPlayer === "player1" ? gameState.player2 : gameState.player1;

        // Start the next player's turn (which gives them DON)
        window.startPlayerTurn?.(nextPlayer);

        // Update sidebar state
        this.state.currentPlayer = nextPlayer === gameState.player1 ? "player1" : "player2";
        const phase = document.getElementById("phaseDisplay");
        if (phase) {
            phase.textContent = this.state.currentPlayer === "player1" ? "Your Turn" : "Opponent's Turn";
        }
    },

    toggleArrowMode() {
        this.state.arrowMode = !this.state.arrowMode;
        const btn = document.getElementById("drawArrowTool");
        if (btn) {
            btn.style.background = this.state.arrowMode ? "#4a90e2" : "#f5a623";
        }
        document.querySelectorAll(".character-slot, .board-leader-card, .board-stage-card, .hand-card[data-card-instance-id]")
            .forEach(el => el.classList.toggle("arrow-selectable", this.state.arrowMode));
        if (!this.state.arrowMode) {
            resolveAnnotationTargetElement(this.state.arrowFirstKey)?.classList.remove("arrow-selected-first");
            this.state.arrowFirstKey = null;
        }
        console.log("Arrow mode:", this.state.arrowMode);
    },

    resetArrows() {
        this.state.arrows = [];
        this.reapplyAnnotations(); // previously only cleared the data, not the drawn lines
        this.pushAnnotations();    // clear them on the opponent's screen too
        console.log("Arrows reset");
    },

    restandAllCards() {
        // Restand all board cards (leaders, characters, etc)
        document.querySelectorAll(".board-card-rested").forEach(card => {
            card.classList.remove("board-card-rested");
        });

        // Also update the underlying card state - the CSS class alone doesn't
        // survive re-renders and is what gets synced to the opponent online.
        [gameState.player1, gameState.player2].forEach(player => {
            [player.leader, player.stage, ...(player.characters || [])]
                .filter(Boolean)
                .forEach(card => { card.state = "active"; });
        });

        // Detach all DON from cards
        [gameState.player1, gameState.player2].forEach(player => {
            // Leaders
            if (player.leader && player.leader.attachedDon) {
                player.don += player.leader.attachedDon;
                player.leader.attachedDon = 0;
            }
            
            // Characters
            if (player.characters) {
                player.characters.forEach(char => {
                    if (char && char.attachedDon) {
                        player.don += char.attachedDon;
                        char.attachedDon = 0;
                    }
                });
            }
            
            // Stage
            if (player.stage && player.stage.attachedDon) {
                player.don += player.stage.attachedDon;
                player.stage.attachedDon = 0;
            }
        });
        
        // Re-render everything
        window.updateDonDisplay?.();
        window.renderCharacters?.();
        window.renderLeaders?.();
        window.renderStages?.();
        window.scheduleOnlineBoardSync?.();

        console.log("All cards rested and DON detached");
    },

    toggleNoteMode() {
        this.state.noteMode = !this.state.noteMode;
        const btn = document.getElementById("addNoteTool");
        if (btn) {
            btn.style.background = this.state.noteMode ? "#4a90e2" : "#f5a623";
        }
        console.log("Note mode:", this.state.noteMode);
    },

    clearAllNotes() {
        this.state.notes = {};
        document.querySelectorAll(".card-note").forEach(note => note.remove());
        // Redraw so the opponent's notes survive clearing our own, and push the
        // change so they disappear on their screen too.
        this.reapplyAnnotations();
        this.pushAnnotations();
        console.log("All notes cleared");
    },

    // Re-render notes and arrows against wherever their target cards currently are.
    // self.js rebuilds a zone's DOM from scratch (innerHTML/appendChild) on every card
    // move, which would otherwise silently wipe out any note/arrow element we'd added -
    // this is called both right after a note/arrow is created and from self.js's render
    // functions so annotations survive those rebuilds.
    reapplyAnnotations() {
        document.querySelectorAll(".card-note").forEach(n => n.remove());

        const drawNote = (key, note, isRemote) => {
            const el = resolveAnnotationTargetElement(key);
            if (!el) return;
            const host = el.matches(".hand-card") ? el : el.parentElement;
            if (!host) return;
            if (getComputedStyle(host).position === "static") host.style.position = "relative";

            const fontSize = Number(note.fontSize) || 12;
            const label = document.createElement("div");
            label.className = `card-note${isRemote ? " card-note-remote" : ""}`;
            label.textContent = note.text;
            // Centered on the card (both axes) rather than pinned to the bottom.
            // The opponent's notes get a dashed outline so it's obvious whose is whose.
            label.style.cssText = `position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:94%;padding:2px 4px;border-radius:3px;background:rgba(0,0,0,0.8);color:${note.color};font-size:${fontSize}px;font-weight:bold;line-height:1.15;text-align:center;pointer-events:none;z-index:6;word-break:break-word;`
                + (isRemote ? "border:1px dashed rgba(255,255,255,.55);" : "");
            host.appendChild(label);
        };

        Object.entries(this.state.notes).forEach(([key, note]) => drawNote(key, note, false));
        Object.entries(this.state.remoteNotes || {}).forEach(([key, note]) => drawNote(key, note, true));

        const svg = getAnnotationOverlaySvg();
        svg.querySelectorAll(".manual-play-arrow").forEach(l => l.remove());

        const drawArrow = (arrow, isRemote) => {
            const fromEl = resolveAnnotationTargetElement(arrow.from);
            const toEl = resolveAnnotationTargetElement(arrow.to);
            if (!fromEl || !toEl) return;

            const r1 = fromEl.getBoundingClientRect();
            const r2 = toEl.getBoundingClientRect();
            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("class", "manual-play-arrow");
            line.setAttribute("x1", r1.left + r1.width / 2);
            line.setAttribute("y1", r1.top + r1.height / 2);
            line.setAttribute("x2", r2.left + r2.width / 2);
            line.setAttribute("y2", r2.top + r2.height / 2);
            // Opponent arrows are drawn in blue and dashed to tell them apart.
            line.setAttribute("stroke", isRemote ? "#4da3ff" : "#ff4d4d");
            line.setAttribute("stroke-width", "3");
            if (isRemote) line.setAttribute("stroke-dasharray", "8 5");
            line.setAttribute("marker-end", "url(#manualPlayArrowHead)");
            svg.appendChild(line);
        };

        this.state.arrows.forEach(arrow => drawArrow(arrow, false));
        (this.state.remoteArrows || []).forEach(arrow => drawArrow(arrow, true));
    },

    // ── Online annotation sharing ────────────────────────
    // Notes and arrows used to live only in this client's memory, so the other
    // player never saw anything you drew. Annotation keys are position-based
    // (e.g. "player1:character:2") and both clients use the same player1/player2
    // vocabulary, so the same key points at the same card on both screens.

    getLocalAnnotations() {
        return { notes: this.state.notes, arrows: this.state.arrows };
    },

    setRemoteAnnotations(data) {
        const notes = (data && typeof data.notes === "object" && data.notes) || {};
        const arrows = Array.isArray(data?.arrows) ? data.arrows : [];

        // Skip the re-render when nothing actually changed - this is called on
        // every incoming state push.
        const next = JSON.stringify({ notes, arrows });
        if (next === this._lastRemoteAnnotations) return;
        this._lastRemoteAnnotations = next;

        this.state.remoteNotes = notes;
        this.state.remoteArrows = arrows;
        this.reapplyAnnotations();
    },

    // Called after any local annotation change so it reaches the opponent.
    pushAnnotations() {
        window.scheduleOnlineBoardSync?.();
    },

    undo() {
        console.log("Undo (not yet implemented)");
    }
};

// Exposed on window (const declarations don't auto-attach like function declarations
// do) so self.js's render functions can call window.manualPlay?.reapplyAnnotations?.()
// the same way they already call window.renderCharacters?.() and friends.
window.manualPlay = manualPlay;

// Map a board card DOM element to its underlying { player, card } in gameState,
// so interactions like rest/unrest can update the real card object (not just CSS).
function resolveBoardCard(el) {
    if (typeof gameState === "undefined" || !gameState) return null;

    const charSlot = el.closest(".character-slot");
    if (charSlot) {
        const player = gameState[charSlot.getAttribute("data-player")];
        const idx = parseInt(charSlot.getAttribute("data-slot"));
        return player ? { player, card: player.characters?.[idx] } : null;
    }
    const leaderCard = el.closest(".board-leader-card");
    if (leaderCard) {
        const player = gameState[leaderCard.getAttribute("data-player")];
        return player ? { player, card: player.leader } : null;
    }
    const stageCard = el.closest(".board-stage-card");
    if (stageCard) {
        const player = gameState[stageCard.getAttribute("data-player")];
        return player ? { player, card: player.stage } : null;
    }
    return null;
}

// Identify the CARD a note/arrow is attached to by its instanceId - "card:<id>".
// Binding to the card (not the board slot/zone) means the note/arrow FOLLOWS the
// card when it moves slots, gets replaced, or changes zones, instead of sticking
// to the empty slot behind it.
function getAnnotationTargetKey(el) {
    // Hand cards carry their instance id directly on the element.
    const handCard = el.closest(".hand-card[data-card-instance-id]");
    if (handCard) {
        const id = handCard.getAttribute("data-card-instance-id");
        return id ? `card:${id}` : null;
    }
    // Board cards (character / leader / stage): look up the real card object.
    const info = resolveBoardCard(el);
    if (info?.card?.instanceId) return `card:${info.card.instanceId}`;
    return null;
}

// Find the DOM element for an annotation key, wherever that card currently is.
function resolveAnnotationTargetElement(key) {
    if (!key) return null;

    // Card-bound keys: locate the card by instance id across hand and board.
    if (key.startsWith("card:")) {
        const instanceId = key.slice(5);
        const handEl = document.querySelector(`.hand-card[data-card-instance-id="${instanceId}"]`);
        if (handEl) return handEl;
        if (typeof gameState !== "undefined" && gameState) {
            for (const pk of ["player1", "player2"]) {
                const player = gameState[pk];
                if (!player) continue;
                if (player.leader?.instanceId === instanceId)
                    return document.querySelector(`.board-leader-card[data-player="${pk}"]`);
                if (player.stage?.instanceId === instanceId)
                    return document.querySelector(`.board-stage-card[data-player="${pk}"]`);
                const idx = (player.characters || []).findIndex(c => c?.instanceId === instanceId);
                if (idx !== -1) {
                    const slot = document.querySelector(`.character-slot[data-player="${pk}"][data-slot="${idx}"]`);
                    return slot ? slot.querySelector("img") : null;
                }
            }
        }
        return null;
    }

    // Legacy position-based keys, kept so a mid-rollout version mismatch (one
    // client still sending old keys) degrades gracefully instead of erroring.
    const parts = key.split(":");
    if (parts[0] === "hand") {
        return document.querySelector(`.hand-card[data-card-instance-id="${parts[1]}"]`);
    }
    const [playerKey, kind, slotIndex] = parts;
    if (kind === "leader") return document.querySelector(`.board-leader-card[data-player="${playerKey}"]`);
    if (kind === "character") {
        const slot = document.querySelector(`.character-slot[data-player="${playerKey}"][data-slot="${slotIndex}"]`);
        return slot ? slot.querySelector("img") : null;
    }
    if (kind === "stage") return document.querySelector(`.board-stage-card[data-player="${playerKey}"]`);
    return null;
}

function getAnnotationOverlaySvg() {
    let svg = document.getElementById("manualPlayAnnotationOverlay");
    if (!svg) {
        svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.id = "manualPlayAnnotationOverlay";
        svg.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:500;";
        svg.innerHTML = '<defs><marker id="manualPlayArrowHead" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#ff4d4d"></path></marker></defs>';
        document.body.appendChild(svg);
    }
    return svg;
}

// Themed replacement for window.prompt(): the native dialog throws/is blocked
// in embedded webview contexts (e.g. Replit's preview iframe, which is how this
// app is served per .replit), so nothing using prompt() ever actually showed
// anything there. onSubmit is only called when the user confirms; cancelling
// (Escape, clicking outside, or the Cancel button) just closes the dialog.
function showCustomPrompt(message, defaultValue, onSubmit) {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:20000;";

    const box = document.createElement("div");
    box.style.cssText = "background:#1e1e1e;border:2px solid #888;border-radius:8px;padding:16px;min-width:280px;max-width:90vw;display:flex;flex-direction:column;gap:10px;box-shadow:0 8px 24px rgba(0,0,0,0.5);";

    const label = document.createElement("div");
    label.textContent = message;
    label.style.cssText = "color:#fff;font-size:13px;";

    const input = document.createElement("input");
    input.type = "text";
    input.value = defaultValue ?? "";
    input.style.cssText = "padding:6px 8px;border-radius:4px;border:1px solid #555;background:#111;color:#fff;font-size:13px;";

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = "padding:5px 12px;background:#555;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;";

    const okBtn = document.createElement("button");
    okBtn.textContent = "OK";
    okBtn.style.cssText = "padding:5px 12px;background:#4a90e2;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;";

    const close = () => overlay.remove();
    const submit = () => { const value = input.value; close(); onSubmit(value); };

    cancelBtn.onclick = close;
    okBtn.onclick = submit;
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
        if (e.key === "Escape") close();
    });
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    box.appendChild(label);
    box.appendChild(input);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    input.focus();
    input.select();
}
window.showCustomPrompt = showCustomPrompt;

// Note editor dialog: text + color swatch picker + font-size selector.
// initial = { text, color, fontSize }; onSubmit receives the same shape.
// Submitting empty text is how a note is removed (handled by the caller).
function showNoteDialog(initial, onSubmit) {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:20000;";

    const box = document.createElement("div");
    box.style.cssText = "background:#1e1e1e;border:2px solid #888;border-radius:8px;padding:16px;min-width:300px;max-width:90vw;display:flex;flex-direction:column;gap:12px;box-shadow:0 8px 24px rgba(0,0,0,0.5);";

    const heading = document.createElement("div");
    heading.textContent = "Card Note";
    heading.style.cssText = "color:#fff;font-size:14px;font-weight:bold;";

    const input = document.createElement("input");
    input.type = "text";
    input.value = initial.text ?? "";
    input.placeholder = "Note text (leave blank to remove)";
    input.style.cssText = "padding:6px 8px;border-radius:4px;border:1px solid #555;background:#111;color:#fff;font-size:13px;";

    let selectedColor = initial.color || NOTE_COLORS[0];

    // Color swatches
    const colorRow = document.createElement("div");
    colorRow.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
    const colorLabel = document.createElement("span");
    colorLabel.textContent = "Color:";
    colorLabel.style.cssText = "color:#aaa;font-size:12px;";
    colorRow.appendChild(colorLabel);

    const swatches = [];
    NOTE_COLORS.forEach(c => {
        const sw = document.createElement("button");
        sw.type = "button";
        sw.style.cssText = `width:22px;height:22px;border-radius:50%;background:${c};cursor:pointer;border:2px solid ${c === selectedColor ? "#fff" : "transparent"};`;
        sw.onclick = () => {
            selectedColor = c;
            swatches.forEach(s => s.style.borderColor = s._color === c ? "#fff" : "transparent");
        };
        sw._color = c;
        swatches.push(sw);
        colorRow.appendChild(sw);
    });

    // Font-size selector
    const sizeRow = document.createElement("div");
    sizeRow.style.cssText = "display:flex;align-items:center;gap:8px;";
    const sizeLabel = document.createElement("span");
    sizeLabel.textContent = "Font size:";
    sizeLabel.style.cssText = "color:#aaa;font-size:12px;";
    const sizeSelect = document.createElement("select");
    sizeSelect.style.cssText = "padding:4px 6px;border-radius:4px;border:1px solid #555;background:#111;color:#fff;font-size:13px;";
    [
        { label: "Small", value: 10 },
        { label: "Medium", value: 12 },
        { label: "Large", value: 16 },
        { label: "Extra Large", value: 22 }
    ].forEach(opt => {
        const o = document.createElement("option");
        o.value = String(opt.value);
        o.textContent = opt.label;
        if (Number(initial.fontSize || 12) === opt.value) o.selected = true;
        sizeSelect.appendChild(o);
    });
    sizeRow.appendChild(sizeLabel);
    sizeRow.appendChild(sizeSelect);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = "padding:5px 12px;background:#555;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;";
    const okBtn = document.createElement("button");
    okBtn.textContent = "OK";
    okBtn.style.cssText = "padding:5px 12px;background:#4a90e2;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;";

    const close = () => overlay.remove();
    const submit = () => {
        const result = { text: input.value, color: selectedColor, fontSize: Number(sizeSelect.value) };
        close();
        onSubmit(result);
    };

    cancelBtn.onclick = close;
    okBtn.onclick = submit;
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
        if (e.key === "Escape") close();
    });
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    box.appendChild(heading);
    box.appendChild(input);
    box.appendChild(colorRow);
    box.appendChild(sizeRow);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    input.focus();
    input.select();
}
window.showNoteDialog = showNoteDialog;

// Initialize immediately and also on DOMContentLoaded as backup
function initManualPlay() {
    console.log("manualPlay init called");
    manualPlay.init();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initManualPlay);
} else {
    // DOM already loaded
    setTimeout(initManualPlay, 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// Touch drag-and-drop
//
// HTML5 drag events (dragstart/dragover/drop) NEVER fire from a touchscreen, so
// on a phone the board is completely dead - you can't move a single card. This
// shim watches touches on any [draggable="true"] card and replays the exact
// DragEvents the existing handlers already listen for, sharing ONE DataTransfer
// between the synthetic dragstart (which the source handler fills in) and the
// synthetic drop (which the document handler reads back). A finger-following
// ghost shows what you're carrying. Taps (no real movement) are left alone so
// click / double-tap / DON-attach still work.
// ─────────────────────────────────────────────────────────────────────────────
(function installTouchDragSupport() {
    const isTouch = ("ontouchstart" in window)
        || navigator.maxTouchPoints > 0
        || (window.matchMedia && matchMedia("(pointer: coarse)").matches);
    if (!isTouch) return;

    // Bail out cleanly on ancient browsers that can't build these objects.
    try { new DataTransfer(); new DragEvent("drag"); }
    catch (_) { return; }

    const MOVE_THRESHOLD = 8;      // px of finger travel before it counts as a drag
    const LONG_PRESS_MS = 500;     // hold this long (no move) to open the card menu
    let pending = null;            // { el, startX, startY } - touch down, not yet a drag
    let drag = null;               // { el, dt, ghost, w, h } - a drag is in progress
    let longPressTimer = null;
    let suppressNextClick = false; // eat the release-click after a long press

    // The real drag sources on the board. Card <img>s are draggable-BY-DEFAULT
    // (no explicit draggable="true" attribute), so the old attribute selector
    // missed every board card - they were "glued" to the board on touch. Match
    // them by their actual classes instead: hand cards, board characters / stage
    // / trash (.board-card-img), and life / deck / extra piles ([data-card-source]).
    const DRAG_SOURCE_SELECTOR =
        ".hand-card.selectable-card, .board-card-img, [data-card-source]";
    const draggableFrom = (target) =>
        (target && target.closest) ? target.closest(DRAG_SOURCE_SELECTOR) : null;

    const clearLongPress = () => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    };

    // Touch has no right-click, so a long press stands in for it. Every card menu
    // (hand card -> trash/deck/life, the board move menu, deck/pile menus) listens
    // for `contextmenu`, positioned at clientX/clientY - so fire one at the finger.
    const fireContextMenu = (el, x, y) => {
        try {
            el.dispatchEvent(new MouseEvent("contextmenu", {
                bubbles: true, cancelable: true, view: window,
                clientX: x, clientY: y, button: 2
            }));
        } catch (_) {}
    };

    function makeDragEvent(type, x, y, dt) {
        return new DragEvent(type, {
            bubbles: true, cancelable: true, dataTransfer: dt,
            clientX: x, clientY: y
        });
    }

    function startDrag(sourceEl, x, y) {
        const dt = new DataTransfer();
        // Let the element's own dragstart handler populate the DataTransfer.
        sourceEl.dispatchEvent(makeDragEvent("dragstart", x, y, dt));

        const rect = sourceEl.getBoundingClientRect();
        const ghost = sourceEl.cloneNode(true);
        ghost.classList.add("touch-drag-ghost");
        ghost.setAttribute("aria-hidden", "true");
        ghost.style.cssText =
            "position:fixed;left:0;top:0;margin:0;pointer-events:none;" +
            "opacity:.85;z-index:2147483000;box-shadow:0 8px 24px rgba(0,0,0,.5);" +
            "width:" + rect.width + "px;height:" + rect.height + "px;";
        document.body.appendChild(ghost);

        drag = { el: sourceEl, dt, ghost, w: rect.width, h: rect.height };
        moveGhost(x, y);
    }

    function moveGhost(x, y) {
        drag.ghost.style.transform =
            "translate(" + (x - drag.w / 2) + "px," + (y - drag.h / 2) + "px)";
    }

    function elementUnder(x, y) {
        drag.ghost.style.display = "none";
        const under = document.elementFromPoint(x, y);
        drag.ghost.style.display = "";
        return under;
    }

    document.addEventListener("touchstart", (e) => {
        // A new gesture clears any stale suppression left by a long press whose
        // release never produced a click.
        suppressNextClick = false;
        if (drag || e.touches.length !== 1) return;
        const el = draggableFrom(e.target);
        // The leader isn't draggable but still has a long-press menu (Change Art,
        // Detach DON), so arm it for long-press only - it's never dragged.
        const ctxOnlyEl = el ? null
            : (e.target.closest ? e.target.closest(".board-leader-card") : null);
        if (!el && !ctxOnlyEl) return;
        // On-card buttons / inputs should still tap normally.
        if (e.target.closest("button, input, select, textarea, a")) return;
        const t = e.touches[0];
        pending = { el: el || ctxOnlyEl, startX: t.clientX, startY: t.clientY, longPressOnly: !el };

        // Hold still (no drag) for LONG_PRESS_MS -> open the card's menu.
        clearLongPress();
        longPressTimer = setTimeout(() => {
            longPressTimer = null;
            if (!pending || drag) return;      // moved into a drag, or lifted early
            fireContextMenu(pending.el, pending.startX, pending.startY);
            suppressNextClick = true;          // don't also "tap" the card on release
            pending = null;
        }, LONG_PRESS_MS);
    }, { passive: true });

    document.addEventListener("touchmove", (e) => {
        if (!pending && !drag) return;
        const t = e.touches[0];
        if (!t) return;

        if (pending && !drag) {
            const dx = t.clientX - pending.startX;
            const dy = t.clientY - pending.startY;
            if (Math.hypot(dx, dy) < MOVE_THRESHOLD) return;   // still a tap / hold
            clearLongPress();                                  // moved: it's not a press
            // Context-only targets (the leader) don't drag - just let the move be.
            if (pending.longPressOnly) { pending = null; return; }
            startDrag(pending.el, t.clientX, t.clientY);
            pending = null;
        }

        if (drag) {
            e.preventDefault();   // stop the page scrolling while dragging a card
            moveGhost(t.clientX, t.clientY);
            const under = elementUnder(t.clientX, t.clientY);
            if (under) {
                try { under.dispatchEvent(makeDragEvent("dragover", t.clientX, t.clientY, drag.dt)); }
                catch (_) {}
            }
        }
    }, { passive: false });

    function endDrag(e) {
        clearLongPress();
        pending = null;
        if (!drag) return;
        const t = (e.changedTouches && e.changedTouches[0]) || null;
        if (t) {
            const under = elementUnder(t.clientX, t.clientY);
            if (under) {
                try { under.dispatchEvent(makeDragEvent("drop", t.clientX, t.clientY, drag.dt)); }
                catch (_) {}
            }
        }
        try { drag.el.dispatchEvent(makeDragEvent("dragend", t ? t.clientX : 0, t ? t.clientY : 0, drag.dt)); }
        catch (_) {}
        drag.ghost.remove();
        drag = null;
    }

    document.addEventListener("touchend", endDrag, { passive: true });
    document.addEventListener("touchcancel", endDrag, { passive: true });

    // After a long press opens a menu, the browser still fires a click on release
    // (landing on whatever is under the finger - often the menu itself). Swallow
    // that one click so the press only opens the menu; real taps are untouched.
    document.addEventListener("click", (e) => {
        if (!suppressNextClick) return;
        suppressNextClick = false;
        e.stopImmediatePropagation();   // also stop the same-node rest-detector
        e.preventDefault();
    }, true);
})();
