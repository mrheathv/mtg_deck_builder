// ============================================================
// MTG Arena Deck Builder — App Logic
// ============================================================

const SYSTEM_PROMPT = `You are an expert Magic: The Gathering deck builder specializing in MTG Arena Standard format.

IMPORTANT RULES:
1. You MUST ONLY use cards from the provided card list. Do NOT invent or hallucinate card names.
2. Every card you include MUST appear exactly as named in the provided list.
3. A Standard deck must contain exactly 60 cards in the main deck.
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

When the user asks you to modify the deck, output the COMPLETE updated deck list in the same format (not just the changes).`;

// ============================================================
// State
// ============================================================
let db = null;
let cardNames = [];
let cardDataMap = {};
let selectedColors = new Set();
let conversationHistory = [];
let currentDeckText = '';

// ============================================================
// DOM Elements
// ============================================================
const $ = (sel) => document.querySelector(sel);
const apiKeyInput = $('#api-key');
const apiStatus = $('#api-status');
const toggleKeyBtn = $('#toggle-key-visibility');
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

// ============================================================
// Database Loading
// ============================================================
async function loadDatabase() {
  try {
    const sqlPromise = initSqlJs({
      locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${file}`
    });

    const dataPromise = fetch('arena_standard_cards.sqlite').then(r => {
      if (!r.ok) throw new Error('Failed to load database file');
      return r.arrayBuffer();
    });

    const [SQL, buf] = await Promise.all([sqlPromise, dataPromise]);
    db = new SQL.Database(new Uint8Array(buf));

    // Load unique card names with their data (deduplicated by oracle_id)
    const results = db.exec(`
      SELECT name, color_identity, type_line, mana_cost, cmc, rarity, oracle_text, keywords
      FROM cards
      WHERE lang = 'en'
      GROUP BY oracle_id
      ORDER BY name
    `);

    if (results.length > 0) {
      const rows = results[0].values;
      cardNames = [];
      cardDataMap = {};

      for (const row of rows) {
        const [name, colorIdentity, typeLine, manaCost, cmc, rarity, oracleText, keywords] = row;
        cardNames.push(name);
        cardDataMap[name] = {
          colorIdentity: safeParseJSON(colorIdentity, []),
          typeLine: typeLine || '',
          manaCost: manaCost || '',
          cmc: cmc || 0,
          rarity: rarity || '',
          oracleText: oracleText || '',
          keywords: safeParseJSON(keywords, [])
        };
      }
    }

    console.log(`Loaded ${cardNames.length} unique cards`);
  } catch (err) {
    console.error('DB load error:', err);
    alert('Failed to load the card database. Make sure arena_standard_cards.sqlite is in the same directory.');
  }
}

function safeParseJSON(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); }
  catch { return fallback; }
}

// ============================================================
// Event Listeners
// ============================================================
function setupEventListeners() {
  // API Key
  apiKeyInput.addEventListener('input', onApiKeyChange);
  toggleKeyBtn.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
    const eyeIcon = $('#eye-icon');
    if (eyeIcon) {
      eyeIcon.innerHTML = isPassword
        ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'
        : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
    }
  });

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

function onApiKeyChange() {
  const key = apiKeyInput.value.trim();
  if (key.length > 10) {
    apiStatus.textContent = 'Key set';
    apiStatus.classList.add('active');
    generateBtn.disabled = false;
  } else {
    apiStatus.textContent = 'Not set';
    apiStatus.classList.remove('active');
    generateBtn.disabled = true;
  }
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
      text += `${name} | ${c.manaCost} | ${c.typeLine} | ${c.rarity}\n`;
    }
  }
  return text;
}

// ============================================================
// Generate Deck
// ============================================================
async function generateDeck() {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    showError('Please enter your OpenAI API key.');
    return;
  }

  if (selectedColors.size === 0) {
    showError('Please select at least one color.');
    return;
  }

  hideError();

  const archetype = $('#archetype').value;
  const format = formatSelect.value;
  const extraInstructions = $('#extra-instructions').value.trim();
  const colorNames = {W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless'};
  const colorStr = Array.from(selectedColors).map(c => colorNames[c]).join(', ');

  const filteredNames = getFilteredCardList();
  const cardListText = buildCardListText(filteredNames);

  let userPrompt = `Build me a Standard-legal MTG Arena ${archetype} deck in ${colorStr}.
Format: ${format === 'bo1' ? 'Best of 1 (no sideboard needed)' : 'Best of 3 (include a 15-card sideboard)'}.

Here are ALL the legal Standard cards you may choose from (you MUST only use cards from this list):
${cardListText}

${extraInstructions ? `Additional instructions: ${extraInstructions}` : ''}

Remember: output the deck in exact MTG Arena import format, then explain the strategy.`;

  // Reset conversation
  conversationHistory = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt }
  ];

  // Clear chat UI
  chatMessages.innerHTML = '';
  addChatMessage('user', `Generate a ${colorStr} ${archetype} deck (${format === 'bo1' ? 'BO1' : 'BO3'})${extraInstructions ? '\n' + extraInstructions : ''}`);

  // Call API
  await callChatGPT(apiKey);
}

// ============================================================
// Chat Message Sending
// ============================================================
async function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    showError('Please enter your OpenAI API key.');
    return;
  }

  chatInput.value = '';
  addChatMessage('user', text);

  conversationHistory.push({ role: 'user', content: text });

  await callChatGPT(apiKey);
}

// ============================================================
// ChatGPT API Call
// ============================================================
async function callChatGPT(apiKey) {
  generateBtn.disabled = true;
  chatSendBtn.disabled = true;
  chatInput.disabled = true;
  showLoading('The Oracle is conjuring your deck...');

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: conversationHistory,
        temperature: 0.7,
        max_tokens: 4000
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error?.message || `API error: ${response.status}`);
    }

    const data = await response.json();
    const assistantMessage = data.choices[0].message.content;

    conversationHistory.push({ role: 'assistant', content: assistantMessage });

    addChatMessage('assistant', assistantMessage);

    // Parse and display deck
    const parsed = parseDeckList(assistantMessage);
    if (parsed.deck) {
      displayDeck(parsed);
    }
  } catch (err) {
    addChatMessage('system', `Error: ${err.message}`);
    console.error('API error:', err);
  } finally {
    hideLoading();
    generateBtn.disabled = !apiKeyInput.value.trim();
    chatSendBtn.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
  }
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

    // Match "4 Card Name" or "4x Card Name"
    const match = trimmed.match(/^(\d+)x?\s+(.+)$/);
    if (match && currentSection) {
      const count = parseInt(match[1], 10);
      const name = match[2].trim();
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
