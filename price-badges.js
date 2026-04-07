(() => {
  "use strict";

  const PRICE_URL =
    "https://raw.githubusercontent.com/komimsp/msp2_json_ids/main/prices/id_cena.json";

  const CARD_SELECTOR = ".item-card";

  let pricesPromise = null;
  const processedCards = new WeakSet();

  injectStyles();

  function injectStyles() {
    if (document.getElementById("price-badge-styles")) return;

    const style = document.createElement("style");
    style.id = "price-badge-styles";
    style.textContent = `
      .price-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 78px;
        height: 26px;
        padding: 0 10px;
        border-radius: 10px;
        color: #fff;
        font-size: 0.72rem;
        font-weight: 800;
        letter-spacing: 0.02em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        box-shadow: 0 6px 16px rgba(0,0,0,.18);
        background: linear-gradient(135deg, #9a9a9a, #6f6f6f);
        margin-left: 8px;
      }

      .price-badge.sc {
        background: linear-gradient(135deg, #ffd84d, #f0b400);
      }

      .price-badge.dia {
        background: linear-gradient(135deg, #79c7ff, #3c8ef5);
      }

      .price-badge.unknown {
        background: linear-gradient(135deg, #9a9a9a, #6f6f6f);
      }

      .price-badge.error {
        background: linear-gradient(135deg, #8b5e5e, #6a4040);
      }
    `;
    document.head.appendChild(style);
  }

  async function loadPrices() {
    if (!pricesPromise) {
      pricesPromise = (async () => {
        const res = await fetch(PRICE_URL, { cache: "no-cache" });

        if (!res.ok) {
          throw new Error(`Nie udało się pobrać cennika: HTTP ${res.status}`);
        }

        const data = await res.json();

        if (!data || typeof data !== "object") {
          throw new Error("Cennik nie jest poprawnym JSON obiektem.");
        }

        return data;
      })();
    }

    return pricesPromise;
  }

  function normalizeCurrency(value) {
    const raw = String(value ?? "").trim().toLowerCase();

    if (!raw) return null;
    if (raw.includes("star") || raw === "sc") return "SC";
    if (raw.includes("diamond") || raw === "dia") return "DIA";

    return String(value).trim().toUpperCase();
  }

  function formatPriceValue(value) {
    if (value == null) return null;

    const num = Number(value);
    if (!Number.isFinite(num)) return String(value);
    if (Number.isInteger(num)) return String(num);

    return String(Number(num.toFixed(2)));
  }

  function formatPriceLabel(entry) {
    const price =
      entry?.price ??
      entry?.salesPrice ??
      entry?.salesPriceRaw ??
      null;

    const currency = normalizeCurrency(
      entry?.currency ??
      entry?.currencyCode ??
      null
    );

    const formattedPrice = formatPriceValue(price);

    if (formattedPrice == null) return "Brak ceny";
    if (currency === "SC") return `${formattedPrice} SC`;
    if (currency === "DIA") return `${formattedPrice} DIA`;
    if (currency) return `${formattedPrice} ${currency}`;

    return formattedPrice;
  }

  function getBadgeClass(entry) {
    const currency = normalizeCurrency(
      entry?.currency ??
      entry?.currencyCode ??
      null
    );

    if (currency === "SC") return "sc";
    if (currency === "DIA") return "dia";
    return "unknown";
  }

  function findFirstTextMatch(root, selectors, pattern) {
    for (const selector of selectors) {
      const nodes = root.querySelectorAll(selector);
      for (const node of nodes) {
        const text = node.textContent?.trim() || "";
        const match = text.match(pattern);
        if (match) return match[1] || match[0];
      }
    }
    return null;
  }

  function getItemIdFromCard(card) {
    const directId = findFirstTextMatch(
      card,
      [".meta-id", ".item-badge", "[data-id]", ".tile-meta", ".meta-value", "a", "span", "div"],
      /\b(\d{3,})\b/
    );
    if (directId) return directId;

    const jsonLink = Array.from(card.querySelectorAll("a")).find((a) =>
      /\/\d+\.json(?:$|\?)/i.test(a.getAttribute("href") || "")
    );
    if (jsonLink) {
      const href = jsonLink.getAttribute("href") || "";
      const match = href.match(/\/(\d+)\.json(?:$|\?)/i);
      if (match) return match[1];
    }

    const wholeCardText = card.textContent || "";
    const idLabelMatch = wholeCardText.match(/ID\s+(\d{3,})/i);
    if (idLabelMatch) return idLabelMatch[1];

    return null;
  }

  function getBadgeContainer(card) {
    return (
      card.querySelector(".tile-badge-row") ||
      card.querySelector(".tile-footer") ||
      card.querySelector(".item-card__footer") ||
      card.querySelector(".item-card footer") ||
      card
    );
  }

  function getOrCreatePriceBadge(card) {
    const container = getBadgeContainer(card);
    if (!container) return null;

    let badge = container.querySelector(".price-badge");
    if (badge) return badge;

    badge = document.createElement("span");
    badge.className = "price-badge unknown";
    badge.textContent = "Cena...";
    container.appendChild(badge);

    return badge;
  }

  function setBadge(badge, text, typeClass = "unknown") {
    badge.className = "price-badge";
    badge.classList.add(typeClass);
    badge.textContent = text;
  }

  async function enrichCard(card) {
    if (!card) return;

    const badge = getOrCreatePriceBadge(card);
    if (!badge) return;

    const itemId = getItemIdFromCard(card);
    if (!itemId) {
      setBadge(badge, "Brak ID", "error");
      return;
    }

    try {
      const prices = await loadPrices();
      const entry = prices[itemId];

      if (!entry) {
        setBadge(badge, "Brak ceny", "unknown");
        return;
      }

      setBadge(badge, formatPriceLabel(entry), getBadgeClass(entry));
      processedCards.add(card);
    } catch (error) {
      console.error("price-badges.js:", error);
      setBadge(badge, "Błąd ceny", "error");
    }
  }

  async function scan(root = document) {
    const cards = Array.from(root.querySelectorAll(CARD_SELECTOR));
    for (const card of cards) {
      if (!processedCards.has(card)) {
        await enrichCard(card);
      }
    }
  }

  function observe() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;

          if (node.matches?.(CARD_SELECTOR)) {
            enrichCard(node);
          } else {
            scan(node);
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  async function init() {
    await scan(document);
    observe();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
