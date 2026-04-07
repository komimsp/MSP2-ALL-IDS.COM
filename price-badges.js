(() => {
  "use strict";

  const PRICE_URL =
    "https://raw.githubusercontent.com/komimsp/msp2_json_ids/main/prices/id_cena.json";

  const CARD_SELECTOR = ".item-card";
  const BADGE_ROW_SELECTOR = ".tile-badge-row";
  const META_ID_SELECTOR = ".meta-id";
  const ITEM_BADGE_SELECTOR = ".item-badge";

  let pricesPromise = null;

  injectStyles();

  function injectStyles() {
    if (document.getElementById("price-badge-runtime-styles")) return;

    const style = document.createElement("style");
    style.id = "price-badge-runtime-styles";
    style.textContent = `
      .price-badge.is-runtime-loading {
        background: #777777 !important;
      }

      .price-badge.is-runtime-error {
        background: #666666 !important;
      }

      .price-badge.is-runtime-unknown {
        background: linear-gradient(135deg, #9a9a9a, #6f6f6f) !important;
      }
    `;
    document.head.appendChild(style);
  }

  async function loadPrices() {
    if (!pricesPromise) {
      pricesPromise = (async () => {
        const response = await fetch(PRICE_URL, {
          cache: "no-cache"
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} przy pobieraniu id_cena.json`);
        }

        const json = await response.json();

        if (!json || typeof json !== "object" || Array.isArray(json)) {
          throw new Error("id_cena.json nie jest obiektem JSON");
        }

        return json;
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

  function normalizePrice(value) {
    if (value == null) return null;

    const num = Number(value);
    if (!Number.isFinite(num)) return String(value);

    if (Number.isInteger(num)) {
      return String(num);
    }

    return String(Number(num.toFixed(2)));
  }

  function getPriceEntry(prices, id) {
    return prices[id] ?? prices[String(id)] ?? null;
  }

  function extractDisplayData(entry) {
    if (!entry || typeof entry !== "object") {
      return null;
    }

    const price =
      entry.price ??
      entry.salesPrice ??
      entry.salesPriceRaw ??
      null;

    const currency = normalizeCurrency(
      entry.currency ??
      entry.currencyCode ??
      entry.priceType ??
      null
    );

    const normalizedPrice = normalizePrice(price);

    if (normalizedPrice == null) {
      return {
        text: "Brak ceny",
        className: "is-runtime-unknown"
      };
    }

    if (currency === "SC") {
      return {
        text: `${normalizedPrice} SC`,
        className: "sc"
      };
    }

    if (currency === "DIA") {
      return {
        text: `${normalizedPrice} DIA`,
        className: "dia"
      };
    }

    if (currency) {
      return {
        text: `${normalizedPrice} ${currency}`,
        className: "is-runtime-unknown"
      };
    }

    return {
      text: `${normalizedPrice}`,
      className: "is-runtime-unknown"
    };
  }

  function getItemIdFromCard(card) {
    const metaId = card.querySelector(META_ID_SELECTOR)?.textContent?.trim();
    if (/^\d+$/.test(metaId || "")) {
      return metaId;
    }

    const badgeText = card.querySelector(ITEM_BADGE_SELECTOR)?.textContent?.trim() || "";
    const badgeMatch = badgeText.match(/\b(\d{3,})\b/);
    if (badgeMatch) {
      return badgeMatch[1];
    }

    const allLinks = Array.from(card.querySelectorAll("a[href]"));
    for (const link of allLinks) {
      const href = link.getAttribute("href") || "";
      const match = href.match(/\/(\d+)\.json(?:$|\?)/i);
      if (match) {
        return match[1];
      }
    }

    return null;
  }

  function getOrCreateBadge(card) {
    const row = card.querySelector(BADGE_ROW_SELECTOR);
    if (!row) return null;

    let badge = row.querySelector(".price-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "price-badge is-runtime-loading";
      badge.textContent = "Cena...";
      row.appendChild(badge);
    }

    return badge;
  }

  function setBadgeState(badge, text, className) {
    badge.className = "price-badge";
    if (className) {
      badge.classList.add(className);
    }
    badge.textContent = text;
  }

  async function applyPriceToCard(card) {
    const badge = getOrCreateBadge(card);
    if (!badge) return;

    const id = getItemIdFromCard(card);
    if (!id) {
      setBadgeState(badge, "Brak ID", "is-runtime-error");
      return;
    }

    try {
      const prices = await loadPrices();
      const entry = getPriceEntry(prices, id);

      if (!entry) {
        setBadgeState(badge, "Brak ceny", "is-runtime-unknown");
        return;
      }

      const display = extractDisplayData(entry);
      if (!display) {
        setBadgeState(badge, "Brak ceny", "is-runtime-unknown");
        return;
      }

      setBadgeState(badge, display.text, display.className);
    } catch (error) {
      console.error("price-badges.js:", error);
      setBadgeState(badge, "Błąd ceny", "is-runtime-error");
    }
  }

  async function scan(root = document) {
    const cards = Array.from(root.querySelectorAll(CARD_SELECTOR));
    for (const card of cards) {
      await applyPriceToCard(card);
    }
  }

  function observe() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;

          if (node.matches?.(CARD_SELECTOR)) {
            applyPriceToCard(node);
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
