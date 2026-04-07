(() => {
  "use strict";

  const PRICE_JSON_URL =
    "https://raw.githubusercontent.com/komimsp/msp2_json_ids/main/prices/id_cena.json";

  const CARD_SELECTOR = ".item-card";
  const BADGE_ROW_SELECTOR = ".tile-badge-row";
  const ID_BADGE_SELECTOR = ".item-badge";
  const META_ID_SELECTOR = ".meta-id";
  const JSON_LINK_SELECTOR = ".meta-json-link";

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
        border-top-right-radius: 12px;
        color: #fff;
        font-size: 0.72rem;
        font-weight: 800;
        letter-spacing: 0.02em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        box-shadow: 0 6px 16px rgba(0,0,0,.18);
        background: linear-gradient(135deg, #9a9a9a, #6f6f6f);
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
        const res = await fetch(PRICE_JSON_URL, { cache: "no-cache" });
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
    if (!entry) return null;

    const price =
      entry.price ??
      entry.salesPrice ??
      entry.salesPriceRaw ??
      null;

    const currency = normalizeCurrency(
      entry.currency ?? entry.currencyCode ?? null
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
      entry?.currency ?? entry?.currencyCode ?? null
    );

    if (currency === "SC") return "sc";
    if (currency === "DIA") return "dia";

    return "unknown";
  }

  function getItemIdFromCard(card) {
    const metaId = card.querySelector(META_ID_SELECTOR)?.textContent?.trim();
    if (/^\d+$/.test(metaId || "")) return metaId;

    const badgeText = card.querySelector(ID_BADGE_SELECTOR)?.textContent?.trim() || "";
    const badgeMatch = badgeText.match(/(\d+)/);
    if (badgeMatch) return badgeMatch[1];

    const jsonHref = card.querySelector(JSON_LINK_SELECTOR)?.getAttribute("href") || "";
    const jsonMatch = jsonHref.match(/\/(\d+)\.json(?:$|\?)/);
    if (jsonMatch) return jsonMatch[1];

    return null;
  }

  function getOrCreatePriceBadge(card) {
    const row = card.querySelector(BADGE_ROW_SELECTOR);
    if (!row) return null;

    let badge = row.querySelector(".price-badge");
    if (badge) return badge;

    badge = document.createElement("span");
    badge.className = "price-badge";
    badge.textContent = "Brak ceny";
    row.appendChild(badge);

    return badge;
  }

  function setBadge(badge, text, typeClass) {
    badge.className = "price-badge";
    if (typeClass) badge.classList.add(typeClass);
    badge.textContent = text;
  }

  async function enrichCard(card) {
    if (!card || processedCards.has(card)) return;
    processedCards.add(card);

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

      const label = formatPriceLabel(entry);
      const cls = getBadgeClass(entry);

      setBadge(badge, label || "Brak ceny", cls);
    } catch (error) {
      console.error("price-badges.js:", error);
      setBadge(badge, "Błąd ceny", "error");
    }
  }

  async function scan(root = document) {
    const cards = Array.from(root.querySelectorAll(CARD_SELECTOR));
    for (const card of cards) {
      await enrichCard(card);
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
