(() => {
  "use strict";

  const OWNER = "komimsp";
  const REPO = "msp2_json_ids";
  const REF = "79a698417ec7da9321a11744f91f315449e4b1c9";

  const SHOP_IDS_TO_CHECK = [
    6, 1, 2, 3, 4, 5, 7, 8, 9, 11, 12, 13, 15, 17, 22,
    34, 35, 44, 45, 55, 56, 62, 67, 68, 69, 70, 71, 89
  ];

  const MAX_PAGES_PER_SHOP = 3;
  const PAGE_SIZE = 100;
  const CARD_SELECTOR = ".item-card";
  const ID_TEXT_REGEX = /\bID\s*(\d+)\b/i;
  const CONCURRENCY = 4;

  const itemJsonCache = new Map();
  const listingCache = new Map();
  const priceCache = new Map();
  const processedCards = new WeakSet();

  injectPriceBadgeStyles();

  function injectPriceBadgeStyles() {
    if (document.getElementById("price-badges-style")) return;

    const style = document.createElement("style");
    style.id = "price-badges-style";
    style.textContent = `
      .msp2-badge-row {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }

      .msp2-price-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 44px;
        padding: 0 16px;
        border-radius: 14px;
        font-weight: 800;
        font-size: 18px;
        letter-spacing: 0.2px;
        color: #ffffff;
        background: linear-gradient(135deg, #f7c948 0%, #e0a800 100%);
        box-shadow: 0 6px 16px rgba(224, 168, 0, 0.28);
        white-space: nowrap;
      }

      .msp2-price-badge.is-loading {
        background: linear-gradient(135deg, #d4af37 0%, #b8860b 100%);
        opacity: 0.92;
      }

      .msp2-price-badge.is-not-found,
      .msp2-price-badge.is-error {
        background: linear-gradient(135deg, #6f6f6f 0%, #565656 100%);
        box-shadow: 0 6px 16px rgba(0, 0, 0, 0.22);
      }
    `;
    document.head.appendChild(style);
  }

  function getRawItemUrl(itemId) {
    const idNum = Number(itemId);

    if (!Number.isInteger(idNum) || idNum < 0) {
      throw new Error(`Nieprawidłowe ID: ${itemId}`);
    }

    const start = Math.floor(idNum / 1000) * 1000;
    const end = start + 999;

    return `https://raw.githubusercontent.com/${OWNER}/${REPO}/${REF}/ids/${start}-${end}/${idNum}.json`;
  }

  async function fetchJson(url) {
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }

    return res.json();
  }

  async function getItemById(itemId) {
    const key = String(itemId);
    if (itemJsonCache.has(key)) {
      return itemJsonCache.get(key);
    }

    const promise = (async () => {
      const rawUrl = getRawItemUrl(itemId);
      const item = await fetchJson(rawUrl);
      return { item, rawUrl };
    })();

    itemJsonCache.set(key, promise);
    return promise;
  }

  function extractBestTagsForListing(item, options = {}) {
    const {
      includeCollection = true,
      includeMeta = false
    } = options;

    const tags = Array.isArray(item?.tags) ? item.tags : [];

    const buckets = {
      rootCategory: [],
      gender: [],
      category: [],
      subcategory: [],
      collection: [],
      meta: [],
      other: []
    };

    for (const tag of tags) {
      const tagId = String(tag?.id ?? "").trim();
      const tagType = String(tag?.type ?? "").trim();

      if (!tagId) continue;

      if (tagType === "gender") {
        buckets.gender.push(tagId);
        continue;
      }

      if (tagType === "collection.theme" || tagType.startsWith("collection.")) {
        buckets.collection.push(tagId);
        continue;
      }

      if (tagType === "meta") {
        buckets.meta.push(tagId);
        continue;
      }

      if (tagType.startsWith("subcategory.clothes.")) {
        buckets.subcategory.push(tagId);
        continue;
      }

      if (tagType === "category.clothes") {
        const lookUpId = String(tag?.lookUpId ?? "").toLowerCase();
        const labelKeys = (tag?.resourceIdentifiers || [])
          .filter(x => x?.type === "label" && x?.key)
          .map(x => String(x.key).toLowerCase());

        const isRoot =
          lookUpId === "tag_clothes" ||
          lookUpId === "tag_beauty" ||
          labelKeys.includes("tag_clothes") ||
          labelKeys.includes("tag_beauty");

        if (isRoot) {
          buckets.rootCategory.push(tagId);
        } else {
          buckets.category.push(tagId);
        }
        continue;
      }

      buckets.other.push(tagId);
    }

    const finalTags = [];
    const pushUnique = (arr) => {
      for (const x of arr) {
        if (!finalTags.includes(x)) {
          finalTags.push(x);
        }
      }
    };

    pushUnique(buckets.rootCategory);
    pushUnique(buckets.gender);
    pushUnique(buckets.category);
    pushUnique(buckets.subcategory);

    if (includeCollection) {
      pushUnique(buckets.collection);
    }

    if (includeMeta) {
      pushUnique(buckets.meta);
    }

    return {
      finalTags,
      buckets
    };
  }

  function buildListingUrl(tagIds, shopId = 6, page = 1, pageSize = 100) {
    const url = new URL(`https://eu.mspapis.com/shopinventory/v1/shops/${shopId}/listings`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("pageSize", String(pageSize));

    for (const tagId of tagIds) {
      url.searchParams.append("tag", tagId);
    }

    return url.toString();
  }

  function isClothingLikeItem(itemJson) {
    const tags = Array.isArray(itemJson?.tags) ? itemJson.tags : [];

    return tags.some(tag => {
      const type = String(tag?.type ?? "").toLowerCase();
      const lookUpId = String(tag?.lookUpId ?? "").toLowerCase();
      const labelKeys = (tag?.resourceIdentifiers || [])
        .filter(x => x?.type === "label" && x?.key)
        .map(x => String(x.key).toLowerCase());

      return (
        type === "category.clothes" ||
        type.startsWith("subcategory.clothes.") ||
        lookUpId === "tag_clothes" ||
        lookUpId === "tag_beauty" ||
        labelKeys.includes("tag_clothes") ||
        labelKeys.includes("tag_beauty")
      );
    });
  }

  async function getListingData(url) {
    if (listingCache.has(url)) {
      return listingCache.get(url);
    }

    const promise = fetchJson(url);
    listingCache.set(url, promise);
    return promise;
  }

  async function doesListingContainItemId(url, itemId) {
    try {
      const data = await getListingData(url);
      const wantedId = String(itemId);

      if (!Array.isArray(data)) {
        return {
          found: false,
          error: "Odpowiedź nie jest tablicą.",
          data: null,
          matchedItem: null
        };
      }

      const foundItem = data.find(entry => String(entry?.id) === wantedId);

      return {
        found: Boolean(foundItem),
        error: null,
        data,
        matchedItem: foundItem || null
      };
    } catch (error) {
      return {
        found: false,
        error: String(error.message || error),
        data: null,
        matchedItem: null
      };
    }
  }

  function normalizeCurrency(value) {
    const raw = String(value ?? "").trim().toLowerCase();

    if (!raw) return null;

    if (
      raw.includes("star") ||
      raw === "sc" ||
      raw === "starcoins" ||
      raw === "starcoin"
    ) {
      return "SC";
    }

    if (
      raw.includes("diamond") ||
      raw === "dia" ||
      raw === "diamonds" ||
      raw === "diamond"
    ) {
      return "DIA";
    }

    return String(value).trim();
  }

  function extractPriceData(listingItem) {
    if (!listingItem || typeof listingItem !== "object") {
      return {
        salesPrice: null,
        currency: null
      };
    }

    const salesPriceCandidates = [
      listingItem.salesPrice,
      listingItem.price?.salesPrice,
      listingItem.pricing?.salesPrice,
      listingItem.cost?.salesPrice,
      listingItem.salePrice
    ];

    const currencyCandidates = [
      listingItem.currency,
      listingItem.price?.currency,
      listingItem.pricing?.currency,
      listingItem.cost?.currency,
      listingItem.currencyType,
      listingItem.priceType,
      listingItem.price?.type,
      listingItem.pricing?.type
    ];

    const salesPrice = salesPriceCandidates.find(v => v !== undefined && v !== null) ?? null;
    const rawCurrency = currencyCandidates.find(v => v !== undefined && v !== null) ?? null;
    const currency = normalizeCurrency(rawCurrency);

    return { salesPrice, currency };
  }

  function formatPriceBadgeText(priceInfo) {
    if (!priceInfo || priceInfo.salesPrice == null) {
      return "Brak ceny";
    }

    const amount = String(priceInfo.salesPrice);
    const currency = normalizeCurrency(priceInfo.currency);

    if (currency === "SC") return `${amount} SC`;
    if (currency === "DIA") return `${amount} DIA`;
    if (currency) return `${amount} ${currency}`;

    return `${amount}`;
  }

  async function findPriceForItemId(itemId, itemJson) {
    const cacheKey = String(itemId);
    if (priceCache.has(cacheKey)) {
      return priceCache.get(cacheKey);
    }

    const promise = (async () => {
      if (!isClothingLikeItem(itemJson)) {
        return {
          found: false,
          reason: "To nie wygląda na ubranie/beauty.",
          priceInfo: null
        };
      }

      const extracted = extractBestTagsForListing(itemJson, {
        includeCollection: true,
        includeMeta: false
      });

      const tagIds = extracted.finalTags;

      if (!tagIds.length) {
        return {
          found: false,
          reason: "Brak tagów do zbudowania listing URL.",
          priceInfo: null
        };
      }

      for (const shopId of SHOP_IDS_TO_CHECK) {
        for (let page = 1; page <= MAX_PAGES_PER_SHOP; page++) {
          const url = buildListingUrl(tagIds, shopId, page, PAGE_SIZE);
          const result = await doesListingContainItemId(url, itemId);

          if (result.found && result.matchedItem) {
            const priceData = extractPriceData(result.matchedItem);

            return {
              found: true,
              reason: null,
              priceInfo: {
                shopId,
                page,
                listingUrl: url,
                salesPrice: priceData.salesPrice,
                currency: priceData.currency,
                rawListingItem: result.matchedItem
              }
            };
          }

          if (Array.isArray(result.data) && result.data.length < PAGE_SIZE) {
            break;
          }
        }
      }

      return {
        found: false,
        reason: "Nie znaleziono ceny w żadnym shopId.",
        priceInfo: null
      };
    })();

    priceCache.set(cacheKey, promise);
    return promise;
  }

  function extractItemIdFromText(text) {
    const match = String(text ?? "").match(ID_TEXT_REGEX);
    return match ? match[1] : null;
  }

  function findIdBadgeInCard(card) {
    const candidates = card.querySelectorAll("div, span, p, strong, b");

    for (const el of candidates) {
      const text = (el.textContent || "").trim();
      if (ID_TEXT_REGEX.test(text)) {
        return el;
      }
    }

    return null;
  }

  function getCardItemId(card) {
    const badge = findIdBadgeInCard(card);
    if (badge) {
      const extracted = extractItemIdFromText(badge.textContent);
      if (extracted) return extracted;
    }

    const extractedFromWholeCard = extractItemIdFromText(card.textContent);
    if (extractedFromWholeCard) return extractedFromWholeCard;

    return null;
  }

  function ensureBadgeRow(idBadge) {
    const parent = idBadge.parentElement;
    if (!parent) return null;

    if (parent.classList.contains("msp2-badge-row")) {
      return parent;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "msp2-badge-row";

    parent.insertBefore(wrapper, idBadge);
    wrapper.appendChild(idBadge);

    return wrapper;
  }

  function getOrCreatePriceBadge(card, idBadge) {
    let badge = card.querySelector(".msp2-price-badge");
    if (badge) return badge;

    const row = ensureBadgeRow(idBadge);
    if (!row) return null;

    badge = document.createElement("div");
    badge.className = "msp2-price-badge is-loading";
    badge.textContent = "Cena...";
    row.appendChild(badge);

    return badge;
  }

  function setBadgeState(badge, type, text) {
    badge.classList.remove("is-loading", "is-not-found", "is-error");

    if (type === "loading") badge.classList.add("is-loading");
    if (type === "not-found") badge.classList.add("is-not-found");
    if (type === "error") badge.classList.add("is-error");

    badge.textContent = text;
  }

  async function enrichCardWithPrice(card) {
    if (!card || processedCards.has(card)) return;
    processedCards.add(card);

    const idBadge = findIdBadgeInCard(card);
    if (!idBadge) return;

    const itemId = getCardItemId(card);
    if (!itemId) return;

    const priceBadge = getOrCreatePriceBadge(card, idBadge);
    if (!priceBadge) return;

    try {
      setBadgeState(priceBadge, "loading", "Cena...");

      const { item } = await getItemById(itemId);
      const result = await findPriceForItemId(itemId, item);

      if (!result.found || !result.priceInfo || result.priceInfo.salesPrice == null) {
        setBadgeState(priceBadge, "not-found", "Brak ceny");
        return;
      }

      const text = formatPriceBadgeText(result.priceInfo);
      setBadgeState(priceBadge, "ok", text);

      priceBadge.title =
        `shopId: ${result.priceInfo.shopId}, page: ${result.priceInfo.page}`;
    } catch (error) {
      console.error("Błąd ceny dla ID", itemId, error);
      setBadgeState(priceBadge, "error", "Błąd ceny");
    }
  }

  async function runWithConcurrency(items, worker, concurrency) {
    let index = 0;

    async function runner() {
      while (index < items.length) {
        const current = items[index++];
        await worker(current);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length || 1) }, () => runner())
    );
  }

  async function scanAndEnrichAllCards(root = document) {
    const cards = Array.from(root.querySelectorAll(CARD_SELECTOR))
      .filter(card => !processedCards.has(card));

    if (!cards.length) return;

    await runWithConcurrency(cards, enrichCardWithPrice, CONCURRENCY);
  }

  function setupMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      const addedNodes = [];

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          addedNodes.push(node);
        }
      }

      if (!addedNodes.length) return;

      for (const node of addedNodes) {
        if (node.matches?.(CARD_SELECTOR)) {
          enrichCardWithPrice(node);
        } else {
          scanAndEnrichAllCards(node);
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  async function initPriceBadges() {
    await scanAndEnrichAllCards(document);
    setupMutationObserver();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPriceBadges, { once: true });
  } else {
    initPriceBadges();
  }
})();
