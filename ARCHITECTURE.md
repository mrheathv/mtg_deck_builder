# MTG Deck Builder — Architecture Diagram

## System Overview

```mermaid
flowchart TD
    subgraph Browser["🖥️ Browser (Client-Side)"]
        HTML["index.html\nUI / Layout"]
        CSS["styles.css\nMTG Dark Theme"]
        JS["app.js\nApplication Logic"]

        HTML <--> JS
        CSS --> HTML

        subgraph State["In-Memory State"]
            cardNames["cardNames[]"]
            cardDataMap["cardDataMap{}"]
            cardIdMap["cardIdMap{}\n(C1 → Card Name)"]
            history["conversationHistory[]"]
            deckText["currentDeckText"]
        end

        JS <--> State
    end

    subgraph Cloudflare["☁️ Cloudflare Pages (Deployment)"]
        Fn["functions/api/chat.js\nAPI Proxy Function"]
    end

    subgraph R2["🗄️ Cloudflare R2 (CDN)"]
        STD["cards-standard.json"]
        HIS["cards-historic.json"]
        EXP["cards-explorer.json"]
        PIO["cards-pioneer.json"]
    end

    subgraph OpenAI["🤖 OpenAI API"]
        GPT["gpt-5.4\n/v1/chat/completions"]
    end

    subgraph CI["🔄 GitHub Actions (Monthly)"]
        WF["update-cards.yml\nScheduled Workflow"]
        PY["scripts/build_cards.py\nCard Data Processor"]
    end

    subgraph Scryfall["📦 Scryfall API"]
        Bulk["Bulk Card Data\n(bulk-data endpoint)"]
    end

    %% Client fetches card data on load
    JS -- "1. loadCardsForFormat()\nHTTP GET cards-{format}.json" --> R2
    R2 -- "JSON card array" --> JS

    %% Client sends chat request through proxy
    JS -- "2. callChatGPT()\nPOST /api/chat\n(system prompt + history)" --> Fn
    Fn -- "Bearer OPENAI_API_KEY\nPOST /v1/chat/completions" --> GPT
    GPT -- "Deck list using\nshort IDs (C1, C42...)" --> Fn
    Fn -- "streamed response" --> JS

    %% CI/CD updates card data
    WF -- "runs" --> PY
    PY -- "bulk-data download" --> Scryfall
    Scryfall -- "default_cards.json" --> PY
    PY -- "upload JSON per format" --> R2
```

---

## Deck Generation Data Flow

```mermaid
sequenceDiagram
    actor User
    participant UI as index.html
    participant App as app.js
    participant R2 as Cloudflare R2
    participant Proxy as /api/chat
    participant AI as OpenAI GPT

    User->>UI: Select format, colors, archetype
    UI->>App: generateDeck()

    App->>R2: GET cards-{format}.json (on first load)
    R2-->>App: Array of card objects

    Note over App: getFilteredCardList()<br/>Filter by color identity

    Note over App: buildCardListText()<br/>Assign short IDs: C1, C2 … Cn<br/>Group by type (Creatures / Spells / Lands)

    App->>Proxy: POST /api/chat<br/>{system prompt + card list (IDs)}
    Proxy->>AI: POST /v1/chat/completions<br/>{Bearer OPENAI_API_KEY}
    AI-->>Proxy: "Deck\n4 C42\n3 C107\n..."
    Proxy-->>App: streamed text

    Note over App: parseDeckList()<br/>Resolve C-IDs → card names

    App->>UI: displayDeck() + mana curve stats
    UI-->>User: Rendered deck + copy button

    loop Refinement
        User->>UI: Chat message ("swap lands", "add removal")
        UI->>App: sendChatMessage()
        Note over App: Append to conversationHistory[]<br/>condenseHistory() if needed
        App->>Proxy: POST /api/chat (full history)
        Proxy->>AI: POST /v1/chat/completions
        AI-->>App: Updated deck
        App->>UI: Re-render deck
    end
```

---

## Component Responsibilities

| Component | Layer | Responsibility |
|-----------|-------|----------------|
| `index.html` | Frontend | UI layout, color pickers, deck output panels |
| `styles.css` | Frontend | MTG-themed dark styling, mana color variables |
| `app.js` | Frontend | State management, card filtering, prompt building, deck parsing, stats |
| `functions/api/chat.js` | Serverless (Cloudflare) | Proxy to OpenAI — hides API key from client |
| `scripts/build_cards.py` | Build / CI | Downloads Scryfall bulk data, filters by format legality, exports JSON to R2 |
| `.github/workflows/update-cards.yml` | CI/CD | Monthly automated card database refresh |
| Cloudflare R2 | Storage | CDN-hosted card JSON per format (Standard, Historic, Explorer, Pioneer) |
| OpenAI GPT-5.4 | External AI | Generates and refines deck lists using short card IDs |
| Scryfall API | External Data | Source of truth for legal card lists and metadata |

---

## Key Design Decisions

- **Serverless / stateless:** No backend database. All card data loaded into browser memory at startup.
- **Short ID compression:** Cards are mapped to IDs (`C1`–`Cn`) before being sent to the AI to minimize token usage on large card lists.
- **History condensing:** After a deck is generated, `condenseHistory()` replaces the verbose card list in the chat history with a compact deck summary, keeping subsequent turns cheap.
- **Cloudflare Pages Function as proxy:** The OpenAI API key never reaches the browser; all AI calls go through `/api/chat`.
- **Monthly CI refresh:** Card legality changes are automatically pulled from Scryfall and re-uploaded to R2 on the 1st of each month.
