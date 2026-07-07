/* =========================================================================
   SEQUENCE — script.js
   Vanilla JS game engine. No frameworks, no build step.
   Sections:
     1. Constants
     2. Game state
     3. Board layout + deck generation
     4. Game lifecycle (new game / turn flow / move execution)
     5. Sequence (win) detection
     6. AI (easy / medium / heuristic "hard")
     7. Sound engine (synthesized via WebAudio — no external audio files needed)
     8. Rendering
     9. UI wiring / event listeners
   ========================================================================= */
(function () {
  'use strict';

  /* ======================================================================
     1. CONSTANTS
     ====================================================================== */
  const SUITS = ['S', 'D', 'C', 'H'];
  const SUIT_SYMBOLS = { S: '\u2660', H: '\u2665', D: '\u2666', C: '\u2663' };
  const RED_SUITS = ['H', 'D'];
  const FULL_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const BOARD_RANKS = FULL_RANKS.filter((r) => r !== 'J'); // 12 ranks appear on the board
  const TWO_EYED_JACKS = ['JD', 'JC']; // wild — place anywhere
  const ONE_EYED_JACKS = ['JH', 'JS']; // removes an opponent chip
  const BOARD_N = 10;
  const SEQ_LEN = 5;
  const HAND_SIZE = 7;
  const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [1, -1]];

  /* ======================================================================
     2. GAME STATE
     ====================================================================== */
  const state = {
    boardLayout: null, // fixed 10x10 grid of card codes / 'FREE' (built once)
    boardOwner: null,  // 10x10 grid of null | 1 | 2 | 'FREE'
    deck: [],
    discard: [],
    hands: { 1: [], 2: [] },
    currentPlayer: 1,
    selectedCardIndex: null,
    opponentMode: 'human', // 'human' | 'easy' | 'medium' | 'hard'
    winner: null,
    winningCells: [],
    scores: { 1: { wins: 0, losses: 0 }, 2: { wins: 0, losses: 0 }, gamesPlayed: 0 },
    soundOn: true,
    volume: 0.6,
    locked: false, // true while AI "thinks" or after a win, blocks input
  };

  let toastTimer = null;

  /* ======================================================================
     3. BOARD LAYOUT + DECK
     ====================================================================== */

  // Build the fixed 10x10 card layout. Four corners are free spaces; the
  // remaining 96 cells hold each of the 48 non-jack cards exactly twice —
  // matching the two non-jack cards of each rank/suit dealt from the deck.
  function buildBoardLayout() {
    const layout = Array.from({ length: BOARD_N }, () => Array(BOARD_N).fill(null));
    const unique = [];
    for (const s of SUITS) for (const r of BOARD_RANKS) unique.push(r + s);
    const doubled = unique.concat(unique.slice().reverse()); // 96 entries, each card twice
    let i = 0;
    for (let r = 0; r < BOARD_N; r++) {
      for (let c = 0; c < BOARD_N; c++) {
        if (isCorner(r, c)) layout[r][c] = 'FREE';
        else layout[r][c] = doubled[i++];
      }
    }
    return layout;
  }

  function isCorner(r, c) {
    return (r === 0 || r === BOARD_N - 1) && (c === 0 || c === BOARD_N - 1);
  }

  // Two full 52-card decks (104 cards total), including all 8 jacks.
  function buildDeck() {
    const deck = [];
    for (let d = 0; d < 2; d++) {
      for (const s of SUITS) for (const r of FULL_RANKS) deck.push(r + s);
    }
    return deck;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function getCardType(code) {
    const rank = code.slice(0, -1);
    if (rank !== 'J') return 'normal';
    return TWO_EYED_JACKS.includes(code) ? 'two-eyed' : 'one-eyed';
  }

  function isAIPlayer(p) {
    return p === 2 && state.opponentMode !== 'human';
  }

  /* ======================================================================
     4. GAME LIFECYCLE
     ====================================================================== */

  function newGame(keepScores) {
    if (!state.boardLayout) state.boardLayout = buildBoardLayout();

    state.boardOwner = Array.from({ length: BOARD_N }, (_, r) =>
      Array.from({ length: BOARD_N }, (_, c) => (isCorner(r, c) ? 'FREE' : null))
    );

    state.deck = shuffle(buildDeck());
    state.discard = [];
    state.hands[1] = state.deck.splice(0, HAND_SIZE);
    state.hands[2] = state.deck.splice(0, HAND_SIZE);
    state.currentPlayer = 1;
    state.selectedCardIndex = null;
    state.winner = null;
    state.winningCells = [];
    state.locked = false;

    if (!keepScores) {
      state.scores = { 1: { wins: 0, losses: 0 }, 2: { wins: 0, losses: 0 }, gamesPlayed: 0 };
    }

    closeWinnerModal();
    renderAll();
    afterTurnSwitch(); // in case player 1 somehow starts with a dead hand (won't normally happen)
  }

  // Collect every legal {row,col} target for a given card code.
  function collectValidCellsForCard(code, player) {
    const type = getCardType(code);
    const list = [];
    for (let r = 0; r < BOARD_N; r++) {
      for (let c = 0; c < BOARD_N; c++) {
        const owner = state.boardOwner[r][c];
        if (type === 'two-eyed') {
          if (owner === null) list.push({ row: r, col: c });
        } else if (type === 'one-eyed') {
          if (owner !== null && owner !== 'FREE' && owner !== player) list.push({ row: r, col: c });
        } else {
          if (owner === null && state.boardLayout[r][c] === code) list.push({ row: r, col: c });
        }
      }
    }
    return list;
  }

  function hasAnyValidMove(player) {
    return state.hands[player].some((card) => collectValidCellsForCard(card, player).length > 0);
  }

  // Executes a validated move: place or remove a chip, discard the played
  // card, check for a win, draw a replacement, then hand off the turn.
  function performMove(cardIndex, row, col) {
    const player = state.currentPlayer;
    const card = state.hands[player][cardIndex];
    const type = getCardType(card);

    if (type === 'one-eyed') {
      state.boardOwner[row][col] = null;
      Sound.play('remove');
    } else {
      state.boardOwner[row][col] = player;
      Sound.play('place');
    }

    state.hands[player].splice(cardIndex, 1);
    state.discard.push(card);
    state.selectedCardIndex = null;

    // Only a placement (never a removal) can complete a sequence.
    const winLine = type !== 'one-eyed' ? findWinningLine(player) : null;
    if (winLine) {
      declareWinner(player, winLine);
      return;
    }

    if (state.deck.length > 0) {
      state.hands[player].push(state.deck.pop());
    }

    switchPlayer();
    renderAll();
    afterTurnSwitch();
  }

  function switchPlayer() {
    state.currentPlayer = state.currentPlayer === 1 ? 2 : 1;
  }

  // After a turn hand-off: if the new player has zero legal moves in their
  // entire hand (a "dead hand"), auto-swap one card for a fresh draw and
  // pass the turn again — a simplified version of Sequence's dead-card rule,
  // which prevents the game from ever getting stuck.
  function afterTurnSwitch() {
    if (state.winner) return;
    const p = state.currentPlayer;
    if (state.hands[p].length > 0 && !hasAnyValidMove(p)) {
      setTimeout(() => autoSkipDeadHand(p), 500);
      return;
    }
    if (isAIPlayer(p)) {
      state.locked = true;
      renderTurnIndicator();
      setTimeout(aiTakeTurn, 650 + Math.random() * 500);
    } else {
      state.locked = false;
      renderBoard();
    }
  }

  function autoSkipDeadHand(player) {
    if (state.winner) return;
    const card = state.hands[player][0];
    state.hands[player].splice(0, 1);
    state.discard.push(card);
    if (state.deck.length > 0) state.hands[player].push(state.deck.pop());
    showToast(`Player ${player} had no playable cards — swapped one and passed.`);
    switchPlayer();
    renderAll();
    afterTurnSwitch();
  }

  function declareWinner(player, winLine) {
    state.winner = player;
    state.winningCells = winLine;
    state.locked = true;
    state.scores[player].wins++;
    state.scores[player === 1 ? 2 : 1].losses++;
    state.scores.gamesPlayed++;
    renderAll();
    Sound.play('win');
    showWinnerModal(player);
  }

  /* ======================================================================
     5. SEQUENCE (WIN) DETECTION
     ====================================================================== */

  function belongsTo(r, c, player) {
    const owner = state.boardOwner[r][c];
    return owner === player || owner === 'FREE';
  }

  // Scans the whole board for 5-in-a-row (any of 4 axes) belonging to player.
  function findWinningLine(player) {
    for (let r = 0; r < BOARD_N; r++) {
      for (let c = 0; c < BOARD_N; c++) {
        for (const [dr, dc] of DIRECTIONS) {
          const cells = [];
          let ok = true;
          for (let k = 0; k < SEQ_LEN; k++) {
            const rr = r + dr * k, cc = c + dc * k;
            if (rr < 0 || rr >= BOARD_N || cc < 0 || cc >= BOARD_N || !belongsTo(rr, cc, player)) {
              ok = false;
              break;
            }
            cells.push([rr, cc]);
          }
          if (ok) return cells;
        }
      }
    }
    return null;
  }

  // Longest contiguous run of `player`-owned (or free) cells passing through
  // (row,col), across all 4 axes. Used by the AI heuristics below.
  function maxRunThrough(row, col, player) {
    let best = 1;
    for (const [dr, dc] of DIRECTIONS) {
      let count = 1;
      let rr = row + dr, cc = col + dc;
      while (rr >= 0 && rr < BOARD_N && cc >= 0 && cc < BOARD_N && belongsTo(rr, cc, player)) {
        count++; rr += dr; cc += dc;
      }
      rr = row - dr; cc = col - dc;
      while (rr >= 0 && rr < BOARD_N && cc >= 0 && cc < BOARD_N && belongsTo(rr, cc, player)) {
        count++; rr -= dr; cc -= dc;
      }
      if (count > best) best = count;
    }
    return best;
  }

  /* ======================================================================
     6. AI
     ====================================================================== */

  function getAllValidMoves(player) {
    const moves = [];
    state.hands[player].forEach((card, idx) => {
      collectValidCellsForCard(card, player).forEach(({ row, col }) => {
        moves.push({ cardIndex: idx, card, row, col, type: getCardType(card) });
      });
    });
    return moves;
  }

  function wouldWin(move, player) {
    if (move.type === 'one-eyed') return false;
    const prev = state.boardOwner[move.row][move.col];
    state.boardOwner[move.row][move.col] = player;
    const win = !!findWinningLine(player);
    state.boardOwner[move.row][move.col] = prev;
    return win;
  }

  // Heuristic score for "medium": own resulting run length, or (for jacks)
  // the size of the opponent threat removed.
  function scoreMoveMedium(move, player) {
    const opponent = player === 1 ? 2 : 1;
    if (move.type === 'one-eyed') return maxRunThrough(move.row, move.col, opponent) * 10;
    const prev = state.boardOwner[move.row][move.col];
    state.boardOwner[move.row][move.col] = player;
    const run = maxRunThrough(move.row, move.col, player);
    state.boardOwner[move.row][move.col] = prev;
    return run;
  }

  // "Hard" AI: a 1-ply heuristic evaluator (full minimax is intractable for
  // Sequence's branching factor, so this scores each candidate move by
  // simulating it and weighing offense, defense, and board position).
  function scoreMoveHard(move, player) {
    const opponent = player === 1 ? 2 : 1;
    let score = 0;
    if (move.type === 'one-eyed') {
      score = maxRunThrough(move.row, move.col, opponent) * 12;
    } else {
      const prev = state.boardOwner[move.row][move.col];
      state.boardOwner[move.row][move.col] = player;
      score += maxRunThrough(move.row, move.col, player) * 10;
      if (findWinningLine(player)) score += 1000;
      state.boardOwner[move.row][move.col] = prev;
    }
    const centerDist = Math.abs(move.row - 4.5) + Math.abs(move.col - 4.5);
    score += (9 - centerDist) * 0.3;
    return score;
  }

  function pickAIMove(moves, player, difficulty) {
    if (difficulty === 'easy') {
      return moves[Math.floor(Math.random() * moves.length)];
    }
    if (difficulty === 'medium') {
      const winning = moves.find((m) => m.type !== 'one-eyed' && wouldWin(m, player));
      if (winning) return winning;
      moves.sort((a, b) => scoreMoveMedium(b, player) - scoreMoveMedium(a, player));
      // small randomness among top choices so medium isn't fully deterministic
      const top = moves.slice(0, Math.max(1, Math.ceil(moves.length * 0.2)));
      return top[Math.floor(Math.random() * top.length)];
    }
    // hard
    let best = null, bestScore = -Infinity;
    for (const m of moves) {
      const s = scoreMoveHard(m, player);
      if (s > bestScore) { bestScore = s; best = m; }
    }
    return best;
  }

  function aiTakeTurn() {
    if (state.winner) return;
    const player = state.currentPlayer;
    const moves = getAllValidMoves(player);
    if (moves.length === 0) {
      autoSkipDeadHand(player);
      return;
    }
    const chosen = pickAIMove(moves, player, state.opponentMode);
    performMove(chosen.cardIndex, chosen.row, chosen.col);
  }

  /* ======================================================================
     7. SOUND ENGINE (Web Audio API — no external audio files required)
     ====================================================================== */
  const Sound = (function () {
    let ctx = null;
    function ensure() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC();
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function tone(freq, duration, type, gainStart, delay) {
      if (!state.soundOn) return;
      const c = ensure();
      const start = c.currentTime + (delay || 0);
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      const g = (gainStart != null ? gainStart : 0.25) * state.volume;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(g, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(start);
      osc.stop(start + duration + 0.02);
    }
    return {
      play(name) {
        switch (name) {
          case 'click': tone(680, 0.07, 'triangle', 0.3); break;
          case 'place': tone(360, 0.1, 'sine', 0.35); tone(720, 0.08, 'sine', 0.2, 0.05); break;
          case 'remove': tone(200, 0.16, 'sawtooth', 0.25); break;
          case 'error': tone(130, 0.18, 'square', 0.22); break;
          case 'draw': tone(520, 0.06, 'triangle', 0.2); break;
          case 'win':
            [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, 0.35, 'sine', 0.3, i * 0.14));
            break;
        }
      },
    };
  })();

  /* ======================================================================
     8. RENDERING
     ====================================================================== */
  const el = {}; // cached DOM refs, populated in initUI()

  function renderAll() {
    renderBoard();
    renderHands();
    renderScoreboard();
    renderTurnIndicator();
    renderDeckCount();
  }

  function renderBoard() {
    el.board.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let r = 0; r < BOARD_N; r++) {
      for (let c = 0; c < BOARD_N; c++) {
        const code = state.boardLayout[r][c];
        const owner = state.boardOwner[r][c];
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.row = r;
        cell.dataset.col = c;

        if (code === 'FREE') {
          cell.classList.add('free');
          cell.innerHTML = '<span class="cell-icon">&#9733;</span>';
        } else {
          const rank = code.slice(0, -1);
          const suit = code.slice(-1);
          const isRed = RED_SUITS.includes(suit);
          cell.innerHTML =
            '<div class="card-label ' + (isRed ? 'red' : '') + '">' +
            '<span class="rank">' + rank + '</span>' +
            '<span class="suit">' + SUIT_SYMBOLS[suit] + '</span></div>';
        }
        if (owner === 1 || owner === 2) {
          const chip = document.createElement('div');
          chip.className = 'chip ' + (owner === 1 ? 'red' : 'blue');
          cell.appendChild(chip);
        }
        if (state.winner && state.winningCells.some(([wr, wc]) => wr === r && wc === c)) {
          cell.classList.add('win-cell');
        }
        cell.addEventListener('click', () => onCellClick(r, c));
        frag.appendChild(cell);
      }
    }
    el.board.appendChild(frag);
    if (!state.winner) highlightForSelectedCard();
  }

  function highlightForSelectedCard() {
    if (state.selectedCardIndex === null) return;
    const player = state.currentPlayer;
    const card = state.hands[player][state.selectedCardIndex];
    if (!card) return;
    const type = getCardType(card);
    const cells = collectValidCellsForCard(card, player);
    cells.forEach(({ row, col }) => {
      const cellEl = el.board.querySelector('.cell[data-row="' + row + '"][data-col="' + col + '"]');
      if (!cellEl) return;
      cellEl.classList.add(type === 'one-eyed' ? 'removable' : 'playable');
    });
  }

  function buildCardFace(code) {
    const rank = code.slice(0, -1);
    const suit = code.slice(-1);
    const isRed = RED_SUITS.includes(suit);
    const wrap = document.createElement('div');
    wrap.className = 'hand-card ' + (isRed ? 'red-suit' : 'black-suit');
    wrap.innerHTML =
      '<span class="rank">' + rank + '</span><span class="suit">' + SUIT_SYMBOLS[suit] + '</span>';
    return wrap;
  }

  function renderHands() {
    const cur = state.currentPlayer;
    const other = cur === 1 ? 2 : 1;

    el.handOwnerLabel.textContent = 'Player ' + cur + "'s Hand" + (isAIPlayer(cur) ? ' (AI)' : '');
    el.handHint.textContent = state.winner
      ? 'Game over'
      : isAIPlayer(cur)
      ? 'AI is thinking…'
      : 'Select a card, then tap a highlighted board space';

    el.playerHand.innerHTML = '';
    state.hands[cur].forEach((code, i) => {
      const cardEl = buildCardFace(code);
      cardEl.style.animationDelay = i * 0.04 + 's';
      if (i === state.selectedCardIndex) cardEl.classList.add('selected');
      if (state.locked || isAIPlayer(cur)) cardEl.classList.add('disabled');
      cardEl.addEventListener('click', () => onCardClick(i));
      el.playerHand.appendChild(cardEl);
    });

    el.opponentHandLabelHost.textContent = 'Player ' + other + "'s Hand (" + state.hands[other].length + ')';
    el.opponentHand.innerHTML = '';
    for (let i = 0; i < state.hands[other].length; i++) {
      const back = document.createElement('div');
      back.className = 'hand-card card-back';
      el.opponentHand.appendChild(back);
    }
  }

  function renderScoreboard() {
    el.p1Wins.textContent = state.scores[1].wins;
    el.p1Losses.textContent = state.scores[1].losses;
    el.p2Wins.textContent = state.scores[2].wins;
    el.p2Losses.textContent = state.scores[2].losses;
    el.gamesPlayed.textContent = state.scores.gamesPlayed;
    el.p2NameLabel.textContent =
      state.opponentMode === 'human' ? 'Player 2' : 'AI (' + capitalize(state.opponentMode) + ')';
  }

  function renderTurnIndicator() {
    const p = state.currentPlayer;
    el.turnChipDot.classList.toggle('p2', p === 2);
    if (state.winner) {
      el.turnPlayerName.textContent = 'Player ' + state.winner + ' won!';
    } else {
      el.turnPlayerName.textContent =
        'Player ' + p + (isAIPlayer(p) ? (state.locked ? ' (AI thinking…)' : ' (AI)') : '');
    }
  }

  function renderDeckCount() {
    el.deckCount.textContent = state.deck.length;
    el.deckFloatCount.textContent = state.deck.length;
  }

  function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /* ---- Toast ---- */
  function showToast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
  }

  /* ---- Winner modal + confetti ---- */
  function showWinnerModal(player) {
    el.winnerBadge.textContent = player === 1 ? '\u265A' : '\u265B';
    el.winnerTitle.textContent = 'Player ' + player + ' Wins!';
    el.winnerSub.textContent = 'Completed a Sequence of five in a row.';
    spawnConfetti();
    el.winnerOverlay.classList.add('open');
  }
  function closeWinnerModal() {
    el.winnerOverlay.classList.remove('open');
    el.confettiField.innerHTML = '';
  }
  function spawnConfetti() {
    el.confettiField.innerHTML = '';
    const colors = ['#e0b155', '#e14f63', '#3f7fef', '#f3d998', '#eef1f7'];
    for (let i = 0; i < 70; i++) {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.style.left = Math.random() * 100 + '%';
      piece.style.background = colors[Math.floor(Math.random() * colors.length)];
      piece.style.animationDuration = 2 + Math.random() * 2 + 's';
      piece.style.animationDelay = Math.random() * 0.6 + 's';
      piece.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
      el.confettiField.appendChild(piece);
    }
  }

  /* ======================================================================
     INTERACTION HANDLERS
     ====================================================================== */
  function onCardClick(idx) {
    if (state.locked || state.winner) return;
    if (isAIPlayer(state.currentPlayer)) return;
    Sound.play('click');
    state.selectedCardIndex = state.selectedCardIndex === idx ? null : idx;
    renderHands();
    renderBoard();
  }

  function onCellClick(row, col) {
    if (state.locked || state.winner) return;
    if (isAIPlayer(state.currentPlayer)) return;
    if (state.selectedCardIndex === null) {
      showToast('Select a card from your hand first.');
      return;
    }
    const player = state.currentPlayer;
    const card = state.hands[player][state.selectedCardIndex];
    const valid = collectValidCellsForCard(card, player).some((p) => p.row === row && p.col === col);
    if (!valid) {
      Sound.play('error');
      showToast('Illegal move — try a highlighted space.');
      const cellEl = el.board.querySelector('.cell[data-row="' + row + '"][data-col="' + col + '"]');
      if (cellEl) {
        cellEl.classList.add('invalid-shake');
        setTimeout(() => cellEl.classList.remove('invalid-shake'), 400);
      }
      return;
    }
    performMove(state.selectedCardIndex, row, col);
  }

  /* ======================================================================
     9. UI WIRING
     ====================================================================== */
  function initUI() {
    el.board = document.getElementById('board');
    el.playerHand = document.getElementById('playerHand');
    el.opponentHand = document.getElementById('opponentHand');
    el.handOwnerLabel = document.getElementById('handOwnerLabel');
    el.handHint = document.getElementById('handHint');
    el.opponentHandLabelHost = document.querySelector('#opponentStrip .hand-label');
    el.turnChipDot = document.getElementById('turnChipDot');
    el.turnPlayerName = document.getElementById('turnPlayerName');
    el.deckCount = document.getElementById('deckCount');
    el.deckFloatCount = document.getElementById('deckFloatCount');
    el.deckVisual = document.getElementById('deckVisual');
    el.p1Wins = document.getElementById('p1Wins');
    el.p1Losses = document.getElementById('p1Losses');
    el.p2Wins = document.getElementById('p2Wins');
    el.p2Losses = document.getElementById('p2Losses');
    el.p2NameLabel = document.getElementById('p2NameLabel');
    el.gamesPlayed = document.getElementById('gamesPlayed');
    el.toast = document.getElementById('toast');
    el.winnerOverlay = document.getElementById('winnerOverlay');
    el.winnerBadge = document.getElementById('winnerBadge');
    el.winnerTitle = document.getElementById('winnerTitle');
    el.winnerSub = document.getElementById('winnerSub');
    el.confettiField = document.getElementById('confettiField');

    // Settings drawer
    const drawerOverlay = document.getElementById('drawerOverlay');
    document.getElementById('settingsBtn').addEventListener('click', () => {
      Sound.play('click');
      drawerOverlay.classList.add('open');
    });
    document.getElementById('closeSettingsBtn').addEventListener('click', () => {
      drawerOverlay.classList.remove('open');
    });
    drawerOverlay.addEventListener('click', (e) => {
      if (e.target === drawerOverlay) drawerOverlay.classList.remove('open');
    });

    // Sound toggle (topbar icon)
    const soundOnIcon = document.getElementById('soundOnIcon');
    const soundOffIcon = document.getElementById('soundOffIcon');
    const soundDrawerToggle = document.getElementById('soundDrawerToggle');
    function syncSoundUI() {
      soundOnIcon.style.display = state.soundOn ? 'block' : 'none';
      soundOffIcon.style.display = state.soundOn ? 'none' : 'block';
      soundDrawerToggle.textContent = state.soundOn ? 'On' : 'Off';
      soundDrawerToggle.classList.toggle('on', state.soundOn);
    }
    function toggleSound() {
      state.soundOn = !state.soundOn;
      syncSoundUI();
      if (state.soundOn) Sound.play('click');
    }
    document.getElementById('soundToggleBtn').addEventListener('click', toggleSound);
    soundDrawerToggle.addEventListener('click', toggleSound);
    syncSoundUI();

    // Volume
    document.getElementById('volumeSlider').addEventListener('input', (e) => {
      state.volume = Number(e.target.value) / 100;
    });

    // Theme
    const themeBtn = document.getElementById('themeToggleBtn');
    themeBtn.addEventListener('click', () => {
      const isLight = document.body.classList.toggle('theme-light');
      themeBtn.textContent = isLight ? 'Light' : 'Dark';
      Sound.play('click');
    });

    // Restart / New match / Reset scores
    document.getElementById('restartBtn').addEventListener('click', () => {
      Sound.play('click');
      newGame(true);
      drawerOverlay.classList.remove('open');
      showToast('Game restarted.');
    });
    document.getElementById('newMatchBtn').addEventListener('click', () => {
      Sound.play('click');
      newGame(false);
      drawerOverlay.classList.remove('open');
      showToast('New match started — scores reset.');
    });
    document.getElementById('resetScoresBtn').addEventListener('click', () => {
      Sound.play('click');
      state.scores = { 1: { wins: 0, losses: 0 }, 2: { wins: 0, losses: 0 }, gamesPlayed: 0 };
      renderScoreboard();
      showToast('Scores reset.');
    });

    // Opponent mode select
    document.getElementById('opponentMode').addEventListener('change', (e) => {
      state.opponentMode = e.target.value;
      newGame(true);
      showToast('Opponent set to ' + (state.opponentMode === 'human' ? 'Human' : 'AI (' + capitalize(state.opponentMode) + ')'));
    });

    // Winner modal
    document.getElementById('playAgainBtn').addEventListener('click', () => {
      Sound.play('click');
      closeWinnerModal();
      newGame(true);
    });
  }

  /* ======================================================================
     BOOT
     ====================================================================== */
  document.addEventListener('DOMContentLoaded', () => {
    initUI();
    newGame(false);
  });
})();
