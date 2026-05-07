// ============================================================
// MTG Arena Deck Builder — App Logic
// ============================================================

const API_PROXY_URL = '/api/chat';

const FORMAT_CONFIG = {
  standard: { displayName: 'Standard'  },
  historic:  { displayName: 'Historic'  },
  explorer:  { displayName: 'Explorer'  },
  alchemy:   { displayName: 'Alchemy'   },
};

function buildSystemPrompt(formatName) {
  return `You are an expert Magic: The Gathering deck builder specializing in MTG Arena ${formatName} format.

IMPORTANT RULES:
1. You MUST ONLY use cards from the provided card list. Do NOT invent or hallucinate card names.
2. Every card you include MUST appear exactly as named in the provided list.
3. A ${formatName} deck must contain exactly 60 cards in the main deck.
4. For Best-of-3, include a 15-card sideboard.
5. You may include up to 4 copies of any non-basic-land card.
6. Basic lands (Plains, Island, Swamp, Mountain, Forest) have no copy limit.

OUTPUT FORMAT — output the deck list in this exact MTG Arena import format with nothing else outside of it for the deck portion:

Deck
4 Card Name
3 Another Card
...

Sideboard
2 Sideboard Card
...

After the deck list, include a brief explanation of the deck strategy and key card choices.`;
}

// ============================================================
// State
// ============================================================
let cardNames = [];
let cardDataMap = {};
let selectedColors = new Set();
let selectedCardPool = 'standard';
let currentDeckText = '';
let cardIdMap = {};

// ============================================================
// DOM Elements
// ============================================================
const $ = (sel) => document.querySelector(sel);
const generateBtn    = $('#generate-btn');
const generateError  = $('#generate-error');
const strategyDisplay = $('#strategy-display');
const redoInput      = $('#redo-input');
const redoBtn        = $('#redo-btn');
const redoSection    = $('#redo-section');
const deckOutput     = $('#deck-output');
const sideboardOutput    = $('#sideboard-output');
const sideboardContainer = $('#sideboard-container');
const copyDeckBtn    = $('#copy-deck');
const copyStatus     = $('#copy-status');
const deckStats      = $('#deck-stats');
const statsContent   = $('#stats-content');
const loadingOverlay = $('#loading-overlay');
const loadingText    = $('#loading-text');
const cardPoolSelect = $('#card-pool');
const formatSelect   = $('#format');

// ============================================================
// Init
// ============================================================
document.addEventListener('DOMContentLoaded', init);

async function init() {
  showLoading('Channeling the card database...');
  await loadCardsForFormat(selectedCardPool);
  hideLoading();
  setupEventListeners();
}

const R2_BASE = 'https://pub-9c2e386e89c24c7aa6cf29cc251d7a69.r2.dev';

// ============================================================
// Card Loading
// ============================================================
async function loadCardsForFormat(format) {
  const cfg = FORMAT_CONFIG[format];
  try {
    const response = await fetch(`${R2_BASE}/cards-${format}.json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const cards = await response.json();

    cardNames = [];
    cardDataMap = {};
    for (const card of cards) {
      cardNames.push(card.name);
      cardDataMap[card.name] = {
        colorIdentity: card.color_identity,
        typeLine:      card.type_line,
        manaCost:      card.mana_cost,
        cmc:           card.cmc,
        rarity:        card.rarity,
        oracleText:    card.oracle_text,
        keywords:      card.keywords,
        setName:       card.set_name,
      };
    }
    console.log(`Loaded ${cardNames.length} cards for ${cfg.displayName}`);
  } catch (err) {
    console.error('Card load error:', err);
    alert(`Failed to load the ${cfg.displayName} card pool. Check your connection and try again.`);
  }
}

// ============================================================
// Event Listeners
// ============================================================
function setupEventListeners() {
  // Color buttons
  document.querySelectorAll('.color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const color = btn.dataset.color;
      if (selectedColors.has(color)) {
        selectedColors.delete(color);
        btn.classList.remove('selected');
      } else {
        selectedColors.add(color);
        btn.classList.add('selected');
      }
    });
  });

  // Arena format change — reload card list
  cardPoolSelect.addEventListener('change', async () => {
    selectedCardPool = cardPoolSelect.value;
    showLoading(`Loading ${FORMAT_CONFIG[selectedCardPool].displayName} card pool...`);
    await loadCardsForFormat(selectedCardPool);
    hideLoading();
  });

  // Model toggle
  document.querySelectorAll('.model-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.model-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Generate
  generateBtn.addEventListener('click', () => generateDeck());

  // Redo
  redoBtn.addEventListener('click', redoDeck);
  redoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      redoDeck();
    }
  });

  // Copy deck
  copyDeckBtn.addEventListener('click', copyDeckToClipboard);
}

// ============================================================
// Build card list for the prompt — filtered by selected colors
// ============================================================
function getFilteredCardList() {
  const colors = Array.from(selectedColors);
  const wantColorless = colors.includes('C');
  const wubrg = colors.filter(c => c !== 'C');

  return cardNames.filter(name => {
    const card = cardDataMap[name];
    const ci = card.colorIdentity;

    if (card.typeLine.includes('Basic Land')) return true;
    if (wubrg.length === 0 && !wantColorless) return true;
    if (ci.length === 0) return wantColorless || wubrg.length === 0;
    return ci.every(c => wubrg.includes(c));
  });
}

function buildCardListText(filteredNames) {
  cardIdMap = {};
  const nameToId = {};
  filteredNames.forEach((name, i) => {
    const id = `C${i + 1}`;
    cardIdMap[id] = name;
    nameToId[name] = id;
  });

  const groups = {};
  for (const name of filteredNames) {
    const card = cardDataMap[name];
    let baseType = 'Other';
    const tl = card.typeLine;
    if (tl.includes('Creature'))      baseType = 'Creature';
    else if (tl.includes('Instant'))  baseType = 'Instant';
    else if (tl.includes('Sorcery'))  baseType = 'Sorcery';
    else if (tl.includes('Enchantment')) baseType = 'Enchantment';
    else if (tl.includes('Artifact')) baseType = 'Artifact';
    else if (tl.includes('Planeswalker')) baseType = 'Planeswalker';
    else if (tl.includes('Land'))     baseType = 'Land';
    else if (tl.includes('Battle'))   baseType = 'Battle';

    if (!groups[baseType]) groups[baseType] = [];
    groups[baseType].push(name);
  }

  const typeOrder = ['Creature', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Planeswalker', 'Battle', 'Land', 'Other'];
  let text = '';
  for (const type of typeOrder) {
    if (!groups[type]?.length) continue;
    text += `\n--- ${type}s (${groups[type].length}) ---\n`;
    for (const name of groups[type]) {
      const c = cardDataMap[name];
      const oracle = c.oracleText ? ` | ${c.oracleText.replace(/\n/g, ' ')}` : '';
      text += `${nameToId[name]} | ${c.manaCost} | ${c.typeLine}${oracle}\n`;
    }
  }
  return text;
}

// ============================================================
// Generate Deck
// ============================================================
async function generateDeck(redoNote = '') {
  if (selectedColors.size === 0) {
    showError('Please select at least one color.');
    return;
  }
  hideError();

  const archetype   = $('#archetype').value;
  const matchFormat = formatSelect.value;
  const cfg         = FORMAT_CONFIG[selectedCardPool];
  const extraInstructions = $('#extra-instructions').value.trim();
  const colorNames  = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless' };
  const colorStr    = Array.from(selectedColors).map(c => colorNames[c]).join(', ');

  const filteredNames = getFilteredCardList();
  const cardListText  = buildCardListText(filteredNames);

  let combinedInstructions = extraInstructions;
  if (redoNote) {
    combinedInstructions = combinedInstructions
      ? `${combinedInstructions}\n\nMODIFICATION: ${redoNote}`
      : `MODIFICATION: ${redoNote}`;
  }

  const userPrompt = `Build me a ${cfg.displayName}-legal MTG Arena ${archetype} deck in ${colorStr}.
Match Format: ${matchFormat === 'bo1' ? 'Best of 1 (no sideboard needed)' : 'Best of 3 (include a 15-card sideboard)'}.

Here are ALL the legal ${cfg.displayName} cards you may choose from (you MUST only use cards from this list):
${cardListText}

${combinedInstructions ? `Additional instructions: ${combinedInstructions}` : ''}

Remember: each card above is identified by an ID (e.g., C42). Use those IDs — not card names — in the deck list output. Format:

Deck
4 C42
3 C107
...

After the deck list, explain the strategy using the card names (which you know from the oracle text context).`;

  await callChatGPT([
    { role: 'system', content: buildSystemPrompt(cfg.displayName) },
    { role: 'user',   content: userPrompt },
  ]);
}

// ============================================================
// Redo — re-runs the full generation with a modification note
// ============================================================
async function redoDeck() {
  const note = redoInput.value.trim();
  redoInput.value = '';
  await generateDeck(note);
}

// ============================================================
// API Call
// ============================================================
async function callChatGPT(messages) {
  generateBtn.disabled = true;
  redoBtn.disabled = true;
  redoInput.disabled = true;
  showLoading('The Oracle is conjuring your deck...');

  try {
    const response = await fetch(API_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: document.querySelector('.model-btn.active')?.dataset.model || 'gpt-5.4',
        messages,
        temperature: 0.7,
        max_completion_tokens: 4000,
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error?.message || `API error: ${response.status}`);
    }

    const data = await response.json();
    const assistantMessage = data.choices[0].message.content;

    const parsed = parseDeckList(assistantMessage);
    if (parsed.deck) {
      displayDeck(parsed);
      displayStrategy(parsed.explanation || 'Deck generated! Check the Deck Manifest panel.');
      redoSection.classList.remove('hidden');
    } else {
      displayStrategy(assistantMessage);
    }
  } catch (err) {
    displayStrategy(`Error: ${err.message}`);
    console.error('API error:', err);
  } finally {
    hideLoading();
    generateBtn.disabled = false;
    redoBtn.disabled = false;
    redoInput.disabled = false;
    redoInput.focus();
  }
}

// ============================================================
// Parse deck list from response
// ============================================================
function parseDeckList(text) {
  const lines = text.split('\n');
  let deck = [], sideboard = [];
  let currentSection = null;
  let explanation = [];
  let pastDeck = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^deck$/i.test(trimmed))      { currentSection = 'deck';      continue; }
    if (/^sideboard$/i.test(trimmed)) { currentSection = 'sideboard'; continue; }

    const match = trimmed.match(/^(\d+)x?\s+(.+)$/);
    if (match && currentSection) {
      const count = parseInt(match[1], 10);
      const name  = cardIdMap[match[2].trim()] || match[2].trim();
      if (currentSection === 'deck') deck.push({ count, name });
      else sideboard.push({ count, name });
      continue;
    }

    if (deck.length > 0 && !match && trimmed && currentSection !== 'sideboard') {
      if (!/^[-=]+$/.test(trimmed)) pastDeck = true;
    }
    if (pastDeck && trimmed) explanation.push(trimmed);
  }

  if (deck.length === 0) return { deck: null };
  return { deck, sideboard: sideboard.length > 0 ? sideboard : null, explanation: explanation.join('\n') };
}

// ============================================================
// Display deck
// ============================================================
function displayDeck(parsed) {
  let text = 'Deck\n';
  for (const entry of parsed.deck) text += `${entry.count} ${entry.name}\n`;

  if (parsed.sideboard?.length) {
    text += '\nSideboard\n';
    for (const entry of parsed.sideboard) text += `${entry.count} ${entry.name}\n`;
    sideboardOutput.textContent = parsed.sideboard.map(e => `${e.count} ${e.name}`).join('\n');
    sideboardContainer.classList.remove('hidden');
  } else {
    sideboardContainer.classList.add('hidden');
  }

  currentDeckText = text.trim();
  deckOutput.textContent = parsed.deck.map(e => `${e.count} ${e.name}`).join('\n');
  copyDeckBtn.disabled = false;
  computeAndDisplayStats(parsed);
}

function computeAndDisplayStats(parsed) {
  let totalCards = 0, totalCreatures = 0, totalLands = 0, totalSpells = 0;
  const manaCurve = {};

  for (const entry of parsed.deck) {
    totalCards += entry.count;
    const data = cardDataMap[entry.name];
    if (!data) continue;
    const tl = data.typeLine;
    if (tl.includes('Land'))         totalLands    += entry.count;
    else if (tl.includes('Creature')) totalCreatures += entry.count;
    else                              totalSpells    += entry.count;

    if (!tl.includes('Land')) {
      const bucket = Math.min(Math.floor(data.cmc), 7);
      const label = bucket >= 7 ? '7+' : String(bucket);
      manaCurve[label] = (manaCurve[label] || 0) + entry.count;
    }
  }

  statsContent.innerHTML = '';
  for (const s of [
    { label: 'Total Cards', value: totalCards    },
    { label: 'Creatures',   value: totalCreatures },
    { label: 'Spells',      value: totalSpells    },
    { label: 'Lands',       value: totalLands     },
  ]) {
    const div = document.createElement('div');
    div.className = 'stat-item';
    div.innerHTML = `<div class="stat-label">${s.label}</div><div class="stat-value">${s.value}</div>`;
    statsContent.appendChild(div);
  }

  const curveDiv = document.createElement('div');
  curveDiv.className = 'stat-item';
  curveDiv.style.gridColumn = '1 / -1';
  curveDiv.innerHTML = `<div class="stat-label">Mana Curve</div><div class="stat-value">${
    ['0','1','2','3','4','5','6','7+'].map(k => `${k}:${manaCurve[k] || 0}`).join('  ')
  }</div>`;
  statsContent.appendChild(curveDiv);

  const unrecognized = parsed.deck.filter(e => !cardDataMap[e.name]);
  if (unrecognized.length > 0) {
    const warnDiv = document.createElement('div');
    warnDiv.className = 'stat-item';
    warnDiv.style.gridColumn = '1 / -1';
    warnDiv.style.borderLeft = '3px solid var(--error)';
    warnDiv.innerHTML = `<div class="stat-label" style="color:var(--error)">Unrecognized Cards</div><div class="stat-value" style="color:var(--error);font-size:0.8rem">${unrecognized.map(e => e.name).join(', ')}</div>`;
    statsContent.appendChild(warnDiv);
  }

  deckStats.classList.remove('hidden');
}

// ============================================================
// Strategy display
// ============================================================
function displayStrategy(text) {
  strategyDisplay.innerHTML = '';
  if (!text) return;
  const div = document.createElement('div');
  div.className = 'strategy-text';
  div.textContent = text;
  strategyDisplay.appendChild(div);
}

// ============================================================
// Copy to clipboard
// ============================================================
async function copyDeckToClipboard() {
  if (!currentDeckText) return;
  try {
    await navigator.clipboard.writeText(currentDeckText);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = currentDeckText;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  copyStatus.classList.remove('hidden');
  setTimeout(() => copyStatus.classList.add('hidden'), 2000);
}

// ============================================================
// UI Utilities
// ============================================================
function showLoading(text) {
  loadingText.textContent = text;
  loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
  loadingOverlay.classList.add('hidden');
}

function showError(msg) {
  generateError.textContent = msg;
  generateError.classList.remove('hidden');
}

function hideError() {
  generateError.classList.add('hidden');
}
