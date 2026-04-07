(() => {
  "use strict";

  const OWNER = "komimsp";
  const REPO = "msp2_json_ids";
  const REF = "79a698417ec7da9321a11744f91f315449e4b1c9";

  const SHOP_IDS_TO_CHECK = [
    6, 1, 2, 3, 4, 5, 7, 8, 9, 11, 12, 13, 15, 17, 22,
    34, 35, 44, 45, 55, 56, 62, 67, 68, 69, 70, 71, 89
  ];

  const PAGE_SIZE = 100;
  const MAX_PAGES_PER_SHOP = 5;
  const CONCURRENCY = 3;

  const itemJsonCache = new Map();
  const listingCache = new Map();
  const priceCache = new Map();
  const processedCards = new WeakSet();
  const waitingCards = new WeakSet();

  injectStyles();

  function injectStyles() {
    if (document.getElementById("price-badge-inline-styles")) return;

    const style = document.createElement("style");
    style.id = "price-badge-inline-styles";
    style.textContent = `
      .price-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 86px;
        max-width: 100%;
        height: 26px;
        padding: 0 12px;
        border-top-right-radius: 12px;
        color: #ffffff;
        font-size: 0.72rem;
        font-weight: 800;
        letter-spacing: 0.02em;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        box-shadow: 0 6px 16px rgba(0, 0, 0, 0.18);
      }

      .price-badge.sc {
        background: linear-gradient(135deg, #ffd84d, #f0b400);
      }

      .price-badge.dia {
        background: linear-gradient(135deg, #79c7ff, #3c8ef5);
      }

      .price-badge.loading {
        background: linear-gradient(135deg, #808080, #5e5e5e);
      }

      .price-badge.error,
      .price-badge.not-found {
        background: linear-gradient(135deg, #6e6e6e, #565656);
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
    const res = await fetch(url, { mode: "cors" });

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
    if (raw.includes("star") || raw === "sc" || raw === "starcoins" || raw === "starcoin") return "SC";
    if (raw.includes("diamond") || raw === "dia" || raw === "diamonds" || raw === "diamond") return "DIA";

    return String(value).trim().toUpperCase();
  }

  function extractPriceData(listingItem) {
    if (!listingItem || typeof listingItem !== "object") {
      return { salesPrice: null, currency: null };
    }

    const salesPriceCandidates = [
      listingItem.salesPrice,
      listingItem.price?.salesPrice,
      listingItem.pricing?.salesPrice,
      listingItem.cost?.salesPrice,
      listingItem.salePrice,
      listingItem.price?.amount,
      listingItem.pricing?.amount
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

    return {
      salesPrice,
      currency: normalizeCurrency(rawCurrency)
    };
  }

  function formatPrice(priceInfo) {
    if (!priceInfo || priceInfo.salesPrice == null) {
      return "Brak ceny";
    }

    const amount = String(priceInfo.salesPrice);
    const currency = normalizeCurrency(priceInfo.currency);

    if (currency === "SC") return `${amount} SC`;
    if (currency === "DIA") return `${amount} DIA`;
    if (currency) return `${amount} ${currency}`;

    return amount;
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
          reason: "To nie jest ubranie/beauty.",
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
          reason: "Brak tagów do listingu.",
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
                currency: priceData.currency
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
        reason: "Nie znaleziono ceny.",
        priceInfo: null
      };
    })();

    priceCache.set(cacheKey, promise);
    return promise;
  }

  function getItemIdFromCard(card) {
    const metaId = card.querySelector(".meta-id")?.textContent?.trim();
    if (/^\d+$/.test(metaId || "")) return metaId;

    const badgeText = card.querySelector(".item-badge")?.textContent?.trim() || "";
    const badgeMatch = badgeText.match(/(\d+)/);
    if (badgeMatch) return badgeMatch[1];

    const jsonHref = card.querySelector(".meta-json-link")?.getAttribute("href") || "";
    const jsonMatch = jsonHref.match(/\/(\d+)\.json(?:$|\?)/);
    if (jsonMatch) return jsonMatch[1];

    return null;
  }

  function getOrCreatePriceBadge(card) {
    const row = card.querySelector(".tile-badge-row");
    if (!row) return null;

    let badge = row.querySelector(".price-badge");
    if (badge) return badge;

    badge = document.createElement("span");
    badge.className = "price-badge loading";
    badge.textContent = "Cena...";
    row.appendChild(badge);

    return badge;
  }

  function setBadgeState(badge, state, text) {
    badge.classList.remove("loading", "error", "not-found", "sc", "dia");

    if (state) badge.classList.add(state);
    badge.textContent = text;
  }

  function applyCurrencyClass(badge, currency) {
    const normalized = normalizeCurrency(currency);
    if (normalized === "SC") badge.classList.add("sc");
    else if (normalized === "DIA") badge.classList.add("dia");
  }

  async function enrichCard(card) {
    if (!card || processedCards.has(card)) return;

    const badge = getOrCreatePriceBadge(card);
    if (!badge) return;

    const itemId = getItemIdFromCard(card);

    if (!itemId) {
      if (!waitingCards.has(card)) {
        waitingCards.add(card);
        setBadgeState(badge, "loading", "Cena...");
        setTimeout(() => {
          waitingCards.delete(card);
          enrichCard(card);
        }, 800);
      }
      return;
    }

    processedCards.add(card);

    try {
      setBadgeState(badge, "loading", "Cena...");

      const { item } = await getItemById(itemId);
      const result = await findPriceForItemId(itemId, item);

      if (!result.found || !result.priceInfo || result.priceInfo.salesPrice == null) {
        setBadgeState(badge, "not-found", "Brak ceny");
        return;
      }

      setBadgeState(badge, "", formatPrice(result.priceInfo));
      applyCurrencyClass(badge, result.priceInfo.currency);
      badge.title = `shopId ${result.priceInfo.shopId}, page ${result.priceInfo.page}`;
    } catch (error) {
      console.error("Price badge error for ID", itemId, error);
      setBadgeState(badge, "error", "Błąd ceny");
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

    const runners = Array.from(
      { length: Math.min(concurrency, Math.max(items.length, 1)) },
      () => runner()
    );

    await Promise.all(runners);
  }

  async function scan(root = document) {
    const cards = Array.from(root.querySelectorAll(".item-card"))
      .filter(card => !processedCards.has(card));

    if (!cards.length) return;
    await runWithConcurrency(cards, enrichCard, CONCURRENCY);
  }

  function observe() {
    const observer = new MutationObserver((mutations) => {
      const roots = [];

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          roots.push(node);
        }

        if (mutation.target instanceof HTMLElement) {
          const card = mutation.target.closest?.(".item-card");
          if (card && !processedCards.has(card)) {
            enrichCard(card);
          }
        }
      }

      for (const root of roots) {
        if (root.matches?.(".item-card")) {
          enrichCard(root);
        } else {
          scan(root);
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
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
