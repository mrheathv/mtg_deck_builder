// ============================================================
// MTG Arena Deck Builder — App Logic
// ============================================================

const API_PROXY_URL = '/api/chat';

const FORMAT_CONFIG = {
  standard: { legalityField: 'standard', arenaOnly: true,  displayName: 'Standard'  },
  historic: { legalityField: 'historic', arenaOnly: true,  displayName: 'Historic'  },
  explorer: { legalityField: 'explorer', arenaOnly: true,  displayName: 'Explorer'  },
  pioneer:  { legalityField: 'pioneer',  arenaOnly: false, displayName: 'Pioneer'   },
};

function buildSystemPrompt(formatName) {
  return `You are an expert Magic: The Gathering deck builder specializing in MTG ${formatName} format.

IMPORTANT RULES:
1. You MUST ONLY use cards from the provided card list. Do NOT invent or hallucinate card names.
2. Every card you include MUST appear exactly as named in the provided list.
3. A ${formatName} deck must contain exactly 60 cards in the main deck.
4. For Best-of-3, include a 15-card sideboard.
5. You may include up to 4 copies of any non-basic-land card.
6. Basic lands (Plains, Island, Swamp, Mountain, Forest) have no copy limit.

OUTPUT FORMAT — you MUST output the deck list in this exact MTG Arena import format and nothing else outside of it for the deck portion:

Deck
4 Card Name
3 Another Card
...

Sideboard
2 Sideboard Card
...

After the deck list, you may include a brief explanation of the deck strategy and card choices.

When the user asks you to modify the deck, output the COMPLETE updated deck list in the same format (not just the changes).
When the user asks general questions about the deck or strategy, answer concisely without re-outputting the full deck list.`;
}

// ============================================================
// State
// ============================================================
let cardNames = [];
let cardDataMap = {};
let selectedColors = new Set();
let selectedCardPool = 'standard';
let conversationHistory = [];
let currentDeckText = '';
let cardIdMap = {}; // Maps C1, C2, … IDs back to real card names; rebuilt each generation

// ============================================================
// DOM Elements
// ============================================================
const $ = (sel) => document.querySelector(sel);
const generateBtn = $('#generate-btn');
const generateError = $('#generate-error');
const chatMessages = $('#chat-messages');
const chatInput = $('#chat-input');
const chatSendBtn = $('#chat-send');
const deckOutput = $('#deck-output');
const sideboardOutput = $('#sideboard-output');
const sideboardContainer = $('#sideboard-container');
const copyDeckBtn = $('#copy-deck');
const copyStatus = $('#copy-status');
const deckStats = $('#deck-stats');
const statsContent = $('#stats-content');
const loadingOverlay = $('#loading-overlay');
const loadingText = $('#loading-text');
const cardPoolSelect = $('#card-pool');
const formatSelect = $('#format');

// ============================================================
// Init
// ============================================================
document.addEventListener('DOMContentLoaded', init);

async function init() {
  showLoading('Channeling the card database...');
  await loadDatabase();
  hideLoading();
  setupEventListeners();
}

const R2_BASE = 'https://pub-9c2e386e89c24c7aa6cf29cc251d7a69.r2.dev';

// ============================================================
// Card Loading
// ============================================================
async function loadDatabase() {
  await loadCardsForFormat(selectedCardPool);
}

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
        typeLine: card.type_line,
        manaCost: card.mana_cost,
        cmc: card.cmc,
        rarity: card.rarity,
        oracleText: card.oracle_text,
        keywords: card.keywords,
        setName: card.set_name,
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

  // Card pool format change — reload card list from DB
  cardPoolSelect.addEventListener('change', async () => {
    selectedCardPool = cardPoolSelect.value;
    const pioneerNotice = $('#pioneer-notice');
    if (selectedCardPool === 'pioneer') {
      pioneerNotice.classList.remove('hidden');
    } else {
      pioneerNotice.classList.add('hidden');
    }
    showLoading(`Loading ${FORMAT_CONFIG[selectedCardPool].displayName} card pool...`);
    await loadCardsForFormat(selectedCardPool);
    hideLoading();
  });

  // Generate
  generateBtn.addEventListener('click', generateDeck);

  // Chat send
  chatSendBtn.addEventListener('click', sendChatMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
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

  // If colorless is selected, include cards with empty color identity
  const wantColorless = colors.includes('C');
  const wubrg = colors.filter(c => c !== 'C');

  const filtered = cardNames.filter(name => {
    const card = cardDataMap[name];
    const ci = card.colorIdentity;

    // Always include basic lands
    if (card.typeLine.includes('Basic Land')) return true;

    if (wubrg.length === 0 && !wantColorless) {
      // No colors selected — include everything
      return true;
    }

    if (ci.length === 0) {
      // Colorless card — include if colorless selected OR no specific filter
      return wantColorless || wubrg.length === 0;
    }

    // Card's color identity must be a subset of selected colors
    return ci.every(c => wubrg.includes(c));
  });

  return filtered;
}

function buildCardListText(filteredNames) {
  // Assign short IDs and rebuild the id→name map for this generation
  cardIdMap = {};
  const nameToId = {};
  filteredNames.forEach((name, i) => {
    const id = `C${i + 1}`;
    cardIdMap[id] = name;
    nameToId[name] = id;
  });

  // Group by type for easier AI consumption
  const groups = {};
  for (const name of filteredNames) {
    const card = cardDataMap[name];
    let baseType = 'Other';
    const tl = card.typeLine;
    if (tl.includes('Creature')) baseType = 'Creature';
    else if (tl.includes('Instant')) baseType = 'Instant';
    else if (tl.includes('Sorcery')) baseType = 'Sorcery';
    else if (tl.includes('Enchantment')) baseType = 'Enchantment';
    else if (tl.includes('Artifact')) baseType = 'Artifact';
    else if (tl.includes('Planeswalker')) baseType = 'Planeswalker';
    else if (tl.includes('Land')) baseType = 'Land';
    else if (tl.includes('Battle')) baseType = 'Battle';

    if (!groups[baseType]) groups[baseType] = [];
    groups[baseType].push(name);
  }

  const typeOrder = ['Creature', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Planeswalker', 'Battle', 'Land', 'Other'];
  let text = '';
  for (const type of typeOrder) {
    if (!groups[type] || groups[type].length === 0) continue;
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
async function generateDeck() {
  if (selectedColors.size === 0) {
    showError('Please select at least one color.');
    return;
  }

  hideError();

  const archetype = $('#archetype').value;
  const matchFormat = formatSelect.value;
  const cfg = FORMAT_CONFIG[selectedCardPool];
  const extraInstructions = $('#extra-instructions').value.trim();
  const colorNames = {W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless'};
  const colorStr = Array.from(selectedColors).map(c => colorNames[c]).join(', ');

  const filteredNames = getFilteredCardList();
  const cardListText = buildCardListText(filteredNames);

  let userPrompt = `Build me a ${cfg.displayName}-legal MTG ${cfg.arenaOnly ? 'Arena ' : ''}${archetype} deck in ${colorStr}.
Match Format: ${matchFormat === 'bo1' ? 'Best of 1 (no sideboard needed)' : 'Best of 3 (include a 15-card sideboard)'}.

Here are ALL the legal ${cfg.displayName} cards you may choose from (you MUST only use cards from this list):
${cardListText}

${extraInstructions ? `Additional instructions: ${extraInstructions}` : ''}

Remember: each card above is identified by an ID (e.g., C42). Use those IDs — not card names — in the deck list output. Format:

Deck
4 C42
3 C107
...

After the deck list, explain the strategy using the card names (which you know from the oracle text context).`;

  // Reset conversation
  conversationHistory = [
    { role: 'system', content: buildSystemPrompt(cfg.displayName) },
    { role: 'user', content: userPrompt }
  ];

  // Clear chat UI
  chatMessages.innerHTML = '';
  addChatMessage('user', `Generate a ${colorStr} ${archetype} deck (${cfg.displayName} / ${matchFormat === 'bo1' ? 'BO1' : 'BO3'})${extraInstructions ? '\n' + extraInstructions : ''}`);

  // Call API
  await callChatGPT();
}

// ============================================================
// Chat Message Sending
// ============================================================
async function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = '';
  addChatMessage('user', text);

  conversationHistory.push({ role: 'user', content: text });

  await callChatGPT();
}

// ============================================================
// ChatGPT API Call
// ============================================================
async function callChatGPT() {
  generateBtn.disabled = true;
  chatSendBtn.disabled = true;
  chatInput.disabled = true;
  showLoading('The Oracle is conjuring your deck...');

  try {
    const response = await fetch(API_PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5.4-nano',
        messages: conversationHistory,
        temperature: 0.7,
        max_completion_tokens: 4000
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error?.message || `API error: ${response.status}`);
    }

    const data = await response.json();
    const assistantMessage = data.choices[0].message.content;

    conversationHistory.push({ role: 'assistant', content: assistantMessage });

    // Parse and display deck
    const parsed = parseDeckList(assistantMessage);
    if (parsed.deck) {
      displayDeck(parsed);
      // Show only the explanation in chat — deck list goes to the Deck Manifest panel
      const chatText = parsed.explanation || 'Deck generated! Check the Deck Manifest panel.';
      addChatMessage('assistant', chatText);

      // Condense history to avoid rate limits on follow-up messages.
      // Replace the verbose card-list prompt with a compact deck summary
      // so subsequent chat calls send far fewer tokens.
      condenseHistory(parsed);
    } else {
      addChatMessage('assistant', assistantMessage);
    }
  } catch (err) {
    addChatMessage('system', `Error: ${err.message}`);
    console.error('API error:', err);
  } finally {
    hideLoading();
    generateBtn.disabled = false;
    chatSendBtn.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
  }
}

// ============================================================
// Condense conversation history to reduce token usage
// ============================================================
function condenseHistory(parsed) {
  // Build a compact deck summary to replace the massive card-list prompt
  let deckSummary = 'Deck\n';
  for (const entry of parsed.deck) {
    deckSummary += `${entry.count} ${entry.name}\n`;
  }
  if (parsed.sideboard) {
    deckSummary += '\nSideboard\n';
    for (const entry of parsed.sideboard) {
      deckSummary += `${entry.count} ${entry.name}\n`;
    }
  }

  const condensedUser = `Here is the current deck list:\n\n${deckSummary}\n${parsed.explanation ? `Strategy: ${parsed.explanation}` : ''}`;
  const condensedAssistant = 'Got it. I have the full deck list and strategy above. How would you like to modify the deck?';

  // Replace history: keep system prompt, swap in condensed context
  conversationHistory = [
    conversationHistory[0], // system prompt
    { role: 'user', content: condensedUser },
    { role: 'assistant', content: condensedAssistant }
  ];
}

// ============================================================
// Parse deck list from ChatGPT response
// ============================================================
function parseDeckList(text) {
  const lines = text.split('\n');
  let deck = [];
  let sideboard = [];
  let currentSection = null;
  let explanation = [];
  let pastDeck = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^deck$/i.test(trimmed)) {
      currentSection = 'deck';
      continue;
    }
    if (/^sideboard$/i.test(trimmed)) {
      currentSection = 'sideboard';
      continue;
    }

    // Match "4 C42" (ID format) or "4 Card Name" (name format)
    const match = trimmed.match(/^(\d+)x?\s+(.+)$/);
    if (match && currentSection) {
      const count = parseInt(match[1], 10);
      const raw = match[2].trim();
      const name = cardIdMap[raw] || raw; // resolve ID → real name; fall back to raw
      if (currentSection === 'deck') {
        deck.push({ count, name });
      } else {
        sideboard.push({ count, name });
      }
      continue;
    }

    // If we had deck content and now encounter non-card lines, it's explanation
    if (deck.length > 0 && !match && trimmed && currentSection !== 'sideboard') {
      if (trimmed && !/^[-=]+$/.test(trimmed)) {
        pastDeck = true;
      }
    }
    if (pastDeck && trimmed) {
      explanation.push(trimmed);
    }
  }

  if (deck.length === 0) return { deck: null };

  return {
    deck,
    sideboard: sideboard.length > 0 ? sideboard : null,
    explanation: explanation.join('\n')
  };
}

// ============================================================
// Display deck
// ============================================================
function displayDeck(parsed) {
  // Build Arena-format text
  let text = 'Deck\n';
  for (const entry of parsed.deck) {
    text += `${entry.count} ${entry.name}\n`;
  }

  if (parsed.sideboard && parsed.sideboard.length > 0) {
    text += '\nSideboard\n';
    for (const entry of parsed.sideboard) {
      text += `${entry.count} ${entry.name}\n`;
    }
    sideboardOutput.textContent = parsed.sideboard.map(e => `${e.count} ${e.name}`).join('\n');
    sideboardContainer.classList.remove('hidden');
  } else {
    sideboardContainer.classList.add('hidden');
  }

  currentDeckText = text.trim();
  deckOutput.textContent = parsed.deck.map(e => `${e.count} ${e.name}`).join('\n');
  copyDeckBtn.disabled = false;

  // Calculate stats
  computeAndDisplayStats(parsed);
}

function computeAndDisplayStats(parsed) {
  const allCards = parsed.deck;
  let totalCards = 0;
  let totalCreatures = 0;
  let totalLands = 0;
  let totalSpells = 0;
  let manaCurve = {};

  for (const entry of allCards) {
    totalCards += entry.count;
    const data = cardDataMap[entry.name];
    if (!data) continue;

    const tl = data.typeLine;
    if (tl.includes('Land')) {
      totalLands += entry.count;
    } else if (tl.includes('Creature')) {
      totalCreatures += entry.count;
    } else {
      totalSpells += entry.count;
    }

    if (!tl.includes('Land')) {
      const cmcBucket = Math.min(Math.floor(data.cmc), 7);
      const label = cmcBucket >= 7 ? '7+' : String(cmcBucket);
      manaCurve[label] = (manaCurve[label] || 0) + entry.count;
    }
  }

  const unrecognized = allCards.filter(e => !cardDataMap[e.name]);

  statsContent.innerHTML = '';
  const stats = [
    { label: 'Total Cards', value: totalCards },
    { label: 'Creatures', value: totalCreatures },
    { label: 'Spells', value: totalSpells },
    { label: 'Lands', value: totalLands },
  ];

  for (const s of stats) {
    const div = document.createElement('div');
    div.className = 'stat-item';
    div.innerHTML = `<div class="stat-label">${s.label}</div><div class="stat-value">${s.value}</div>`;
    statsContent.appendChild(div);
  }

  // Mana curve
  const curveDiv = document.createElement('div');
  curveDiv.className = 'stat-item';
  curveDiv.style.gridColumn = '1 / -1';
  const curveStr = ['0','1','2','3','4','5','6','7+']
    .map(k => `${k}:${manaCurve[k] || 0}`)
    .join('  ');
  curveDiv.innerHTML = `<div class="stat-label">Mana Curve</div><div class="stat-value">${curveStr}</div>`;
  statsContent.appendChild(curveDiv);

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
// Copy to clipboard
// ============================================================
async function copyDeckToClipboard() {
  if (!currentDeckText) return;

  try {
    await navigator.clipboard.writeText(currentDeckText);
    copyStatus.classList.remove('hidden');
    setTimeout(() => copyStatus.classList.add('hidden'), 2000);
  } catch (err) {
    // Fallback
    const textarea = document.createElement('textarea');
    textarea.value = currentDeckText;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    copyStatus.classList.remove('hidden');
    setTimeout(() => copyStatus.classList.add('hidden'), 2000);
  }
}

// ============================================================
// Chat UI helpers
// ============================================================
function addChatMessage(role, content) {
  // Remove placeholder
  const placeholder = chatMessages.querySelector('.chat-placeholder');
  if (placeholder) placeholder.remove();

  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;

  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = role === 'user' ? 'Planeswalker' : role === 'assistant' ? 'Oracle' : 'System';
  div.appendChild(label);

  const body = document.createElement('div');
  body.textContent = content;
  div.appendChild(body);

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
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
