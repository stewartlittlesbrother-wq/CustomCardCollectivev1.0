// phases.js

// =========================
// Core card operations
// =========================
// These four helpers are called all through this module but were defined
// NOWHERE, so every phase wrapper below threw a ReferenceError the moment it
// ran. That is exactly what broke online play - the multiplayer turn start
// called runRefreshPhase/runDrawPhase/runDonPhase and died before granting any
// restand, draw or DON!!, which is why multiplayer behaved nothing like
// vs-self. The live turn logic now lives in self.js (applyTurnStartToPlayer),
// so nothing here is on a hot path any more; these exist so that a call into
// this module can never blow up the same way again.

function refreshPlayerCards(player) {
    let refreshedLeader = 0;
    let refreshedCharacters = 0;
    let refreshedStage = 0;
    let returnedAttachedDon = 0;

    const restand = (card) => {
        if (!card) return false;
        const wasRested = (card.state || "active") === "rested";
        card.state = "active";
        if (card.attachedDon) {
            returnedAttachedDon += card.attachedDon;
            card.attachedDon = 0;
        }
        return wasRested;
    };

    if (restand(player.leader)) refreshedLeader = 1;
    if (restand(player.stage)) refreshedStage = 1;
    (player.characters || []).forEach(card => {
        if (restand(card)) refreshedCharacters++;
    });

    const refreshedDon = Number(player.restedDon || 0);
    if (refreshedDon > 0) {
        player.don = (player.don || 0) + refreshedDon;
        player.restedDon = 0;
    }
    if (returnedAttachedDon > 0) {
        player.don = Math.min((player.don || 0) + returnedAttachedDon, 10);
    }
    // The per-DON rested order is rebuilt from the counts (see getDonSlots).
    player.donOrder = null;

    return {
        skippedLeaderRefresh: false,
        refreshedDon,
        returnedAttachedDon,
        refreshedLeader,
        refreshedCharacters,
        refreshedStage
    };
}

function drawCard(player) {
    if (!player?.deck?.length) return { deckOut: true, drawn: 0 };
    player.hand.push(player.deck.pop());
    return { deckOut: false, drawn: 1 };
}

function drawCards(player, count) {
    let drawn = 0;
    for (let i = 0; i < count; i++) {
        if (!player?.deck?.length) return { deckOut: true, drawn };
        player.hand.push(player.deck.pop());
        drawn++;
    }
    return { deckOut: false, drawn };
}

function addDon(player, amount) {
    const before = Number(player.don || 0);
    player.don = Math.min(before + Number(amount || 0), 10);
    player.donOrder = null;
    return player.don - before;
}

// =========================
// Dice Roll Phase
// =========================

function runDiceRollPhase(phaseButton, phaseInfo) {
    let player1Roll;
    let player2Roll;

    addGameLog("Players rolled the dice...");

    do {
        player1Roll = rollD20();
        player2Roll = rollD20();

        phaseInfo.innerHTML = `
            Player 1 rolled: ${player1Roll}<br>
            Player 2 rolled: ${player2Roll}
        `;

        if (player1Roll === player2Roll) {
            phaseInfo.innerHTML += `<br><br>Tie! Rolling again...`;
        }
    } while (player1Roll === player2Roll);

    gameState.diceWinner = player1Roll > player2Roll
        ? gameState.player1
        : gameState.player2;

    phaseInfo.innerHTML += `
        <br><br>
        ${gameState.diceWinner.name} wins the dice roll.<br>
        Choose turn order:
    `;

    if (typeof window.showDiceRollAnimation === "function") {
        window.showDiceRollAnimation(player1Roll, player2Roll, gameState.diceWinner);
    }

    phaseButton.disabled = true;

    createTurnOrderButtons(phaseButton, phaseInfo);
}

function selectTurnOrder(choice, phaseButton, phaseInfo) {
    const winner = gameState.diceWinner;
    const loser = winner === gameState.player1
        ? gameState.player2
        : gameState.player1;

    if (choice === "first") {
        gameState.firstPlayer = winner;
        gameState.secondPlayer = loser;
    } else {
        gameState.firstPlayer = loser;
        gameState.secondPlayer = winner;
    }

    gameState.currentPlayer = gameState.firstPlayer;
    gameState.currentPhase = "mulligan";

    drawStartingHand(gameState.player1);
    drawStartingHand(gameState.player2);

    removeChoiceButtons();

    if (typeof window.removeDiceRollDisplay === "function") {
        window.removeDiceRollDisplay();
    }

    phaseInfo.innerHTML = `
        ${winner.name} chose to go ${choice}.<br><br>
        ${gameState.firstPlayer.name} will go first.<br>
        ${gameState.secondPlayer.name} will go second.<br><br>
        ${gameState.player1.name}: Keep hand or mulligan?
    `;

    phaseButton.style.display = "none";

    createMulliganButtons(gameState.player1, phaseButton, phaseInfo);
}

// =========================
// Mulligan Phase
// =========================

function handleMulliganChoice(player, tookMulligan, phaseButton, phaseInfo) {
    player.hasMulliganed = tookMulligan;

    if (tookMulligan) {
        mulliganHand(player);
    }

    setupLifeCards(player);

    const actionText = tookMulligan
        ? `${player.name} took a mulligan and placed life cards.`
        : `${player.name} kept their starting hand and placed life cards.`;

    if (player === gameState.player1) {
        phaseInfo.innerHTML = `
            ${actionText}<br><br>
            ${gameState.player2.name}: Keep hand or mulligan?
        `;

        createMulliganButtons(gameState.player2, phaseButton, phaseInfo);
        return;
    }

    phaseInfo.innerHTML = `
        ${actionText}<br><br>
        Both players are ready.<br>
        Starting Turn 1.
    `;

    removeChoiceButtons();
    startTurnOne(phaseButton, phaseInfo);
}

function drawStartingHand(player) {
    drawCards(player, 5, ui);
}

function mulliganHand(player) {
    player.deck.push(...player.hand);
    player.hand = [];

    shuffleDeck(player.deck);

    drawCards(player, 5, ui);
}

function setupLifeCards(player) {
    player.life = [];

    const lifeAmount = player.leader.life;

    for (let i = 0; i < lifeAmount; i++) {
        const card = player.deck.shift();

        if (card) {
            const lifeCard = assignCardInstance(card);

            player.life.push(
                typeof setLifeCardFaceUpIfNeeded === "function"
                    ? setLifeCardFaceUpIfNeeded(lifeCard)
                    : lifeCard
            );
        }
    }

    renderLifeCards();
    renderDecks();
}

// =========================
// Turn Start
// =========================

function startTurnOne(phaseButton, phaseInfo) {
    gameState.currentPlayer = gameState.firstPlayer;
    gameState.turnNumber = 1;

    gameState.currentPlayer.turns++;
    gameState.currentPlayer.leaderAttacksThisTurn = 0;

    phaseInfo.innerHTML += `<br><br>`;

    runRefreshPhase(gameState.currentPlayer, phaseInfo);
    runDonPhase(gameState.currentPlayer, 1, phaseInfo);

    gameState.currentPhase = "main";

    const nextPlayer = getNextPlayer(gameState.currentPlayer);

    phaseButton.style.display = "block";
    phaseButton.disabled = false;
    phaseButton.textContent = `Pass to ${nextPlayer.name}`;

    if (typeof window.showTurnBanner === "function") {
        window.showTurnBanner(
            gameState.currentPlayer === gameState.player1 ? "You Go First" : "You Go Second",
            `${gameState.currentPlayer.name} starts the game`,
            "start"
        );
    }
}

// =========================
// Refresh Phase
// =========================

function runRefreshPhase(player, phaseInfo) {
    const refreshResult = refreshPlayerCards(player, ui);
    const skippedLeaderText = refreshResult.skippedLeaderRefresh
        ? "1 leader stayed rested due to an effect.<br>"
        : "";

    phaseInfo.innerHTML += `
        ${player.name}'s Refresh Phase:<br>
        ${refreshResult.refreshedDon} rested DON!! became active.<br>
        ${refreshResult.returnedAttachedDon || 0} attached DON!! returned to the cost area.<br>
        ${refreshResult.refreshedLeader} leader became active.<br>
        ${skippedLeaderText}${refreshResult.refreshedCharacters} character${refreshResult.refreshedCharacters === 1 ? "" : "s"} became active.<br>
        ${refreshResult.refreshedStage} stage became active.
    `;

    return refreshResult;
}

// =========================
// Draw Phase
// =========================

function runDrawPhase(player, phaseInfo) {
    if (typeof resolveRimuruTurnStartSearch === "function") {
        const rimuruResult = resolveRimuruTurnStartSearch(player, ui);

        if (rimuruResult?.activated) {
            phaseInfo.innerHTML += `
                <br><br>
                ${player.name}'s Draw Phase:<br>
                ${rimuruResult.message}<br>
                ${player.name} did not draw because ${player.leader.name}'s effect was activated.
            `;

            return { deckOut: false, skippedDraw: true };
        }

        if (rimuruResult?.message) {
            addGameLog(rimuruResult.message);
        }
    }

    const drawResult = drawCard(player, ui);

    if (drawResult?.deckOut) {
        phaseInfo.innerHTML += `
            <br><br>
            ${player.name}'s Draw Phase:<br>
            ${player.name} lost by deck out.
        `;

        return drawResult;
    }

    phaseInfo.innerHTML += `
        <br><br>
        ${player.name}'s Draw Phase:<br>
        ${player.name} drew 1 card.
    `;

    return drawResult;
}

// =========================
// DON!! Phase
// =========================

function runDonPhase(player, amount, phaseInfo) {
    const beforeDon = player.don;

    addDon(player, amount, ui);

    const gainedDon = player.don - beforeDon;

    phaseInfo.innerHTML += `
        <br><br>
        ${player.name}'s DON!! Phase:<br>
        ${player.name} gained ${gainedDon} DON!!.
    `;

    return gainedDon;
}

// =========================
// Main Phase
// =========================

function runMainPhase(player, phaseButton) {
    gameState.currentPhase = "main";

    const nextPlayer = getNextPlayer(player);

    phaseButton.textContent = `Pass to ${nextPlayer.name}`;
}

// =========================
// Turn Flow
// =========================

function passTurn(phaseButton, phaseInfo) {
    if (typeof window.canPassTurnNow === "function") {
        const passCheck = window.canPassTurnNow();

        if (!passCheck.canPass) {
            addGameLog(passCheck.reason || "Finish the current effect before passing turn.");

            if (phaseButton) {
                phaseButton.disabled = true;
                phaseButton.title = passCheck.reason || "Finish the current effect before passing turn.";
            }

            if (typeof window.updatePhaseButtonPassState === "function") {
                window.updatePhaseButtonPassState();
            }

            return;
        }
    }

    const previousPlayer = gameState.currentPlayer;
    const nextPlayer = getNextPlayer(previousPlayer);
    const endOfTurnResults = resolveEndOfTurnEffects(previousPlayer, ui);
    const endOfTurnText = endOfTurnResults.length > 0
        ? `<br><br>${endOfTurnResults.map(result => result.message).join("<br>")}`
        : "";

    if (gameState.currentPhase === "gameOver") {
        phaseInfo.innerHTML = `
            ${previousPlayer.name} ended their turn.${endOfTurnText}<br><br>
            Game Over.
        `;
        phaseButton.disabled = true;
        phaseButton.textContent = "Game Over";
        return;
    }

    previousPlayer.playLocks = [];
    gameState.currentPlayer = nextPlayer;
    gameState.turnNumber++;
    gameState.currentPlayer.turns++;
    gameState.currentPlayer.leaderAttacksThisTurn = 0;

    phaseInfo.innerHTML = `
        ${previousPlayer.name} ended their turn.${endOfTurnText}<br><br>
    `;

    runRefreshPhase(gameState.currentPlayer, phaseInfo);

    const drawResult = runDrawPhase(gameState.currentPlayer, phaseInfo);

    if (drawResult?.deckOut || gameState.currentPhase === "gameOver") {
        phaseButton.disabled = true;
        phaseButton.textContent = "Game Over";
        return;
    }

    runDonPhase(gameState.currentPlayer, 2, phaseInfo);
    runMainPhase(gameState.currentPlayer, phaseButton);

    if (typeof window.showTurnBanner === "function") {
        window.showTurnBanner(
            gameState.currentPlayer === gameState.player1 ? "Your Turn" : "Opponent's Turn",
            `Turn ${gameState.turnNumber}`,
            gameState.currentPlayer === gameState.player1 ? "your-turn" : "opponent-turn"
        );
    }
}

// =========================
// Counter Phase
// =========================

function startCounterPhase(defenderPlayerKey, onResolve) {
    const defenderPlayer = gameState[defenderPlayerKey];

    if (!defenderPlayer || !currentAttack) {
        if (typeof showResolveOnlyButton === "function") {
            showResolveOnlyButton(defenderPlayerKey, onResolve);
        }

        return;
    }

    gameState.currentPhase = "counterPhase";

    if (typeof currentAttack.targetPowerBonus !== "number") {
        currentAttack.targetPowerBonus = 0;
    }

    addGameLog(`${defenderPlayer.name} may use Counter cards or resolve the attack.`);

    if (typeof showCounterPhaseControls === "function") {
        showCounterPhaseControls(defenderPlayerKey, onResolve);
    }
}

// =========================
// Phase Helpers
// =========================

function getNextPlayer(player) {
    return player === gameState.player1
        ? gameState.player2
        : gameState.player1;
}

function canPlayerPlayCards(player) {
    if (gameState.currentPhase !== "main") {
        return false;
    }

    if (gameState.currentPlayer !== player) {
        return false;
    }

    return true;
}
