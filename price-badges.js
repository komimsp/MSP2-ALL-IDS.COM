(() => {
  "use strict";

  const PRICE_URL =
    "https://raw.githubusercontent.com/komimsp/msp2_json_ids/main/prices/id_cena.json";
  const JSON_REPO_BASE_URL =
    "https://raw.githubusercontent.com/komimsp/msp2_json_ids/main/ids";
  const SHOP_IDS = [
    6, 1, 2, 3, 4, 5, 7, 8, 9, 11, 12, 13, 15, 17, 22, 34, 35, 44, 45, 55, 56,
    62, 67, 68, 69, 70, 71, 89,
  ];
  const PAGE_SIZE = 100;
  const MAX_PAGES = 0;
  const LIVE_LOOKUP_CONCURRENCY = 2;
  const LIVE_PRICE_CACHE_PREFIX = "msp2-live-price:";
  const LIVE_PRICE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

  const CARD_SELECTOR = ".item-card";
  const BADGE_ROW_SELECTOR = ".tile-badge-row";
  const META_ID_SELECTOR = ".meta-id";
  const ITEM_BADGE_SELECTOR = ".item-badge";

  let pricesPromise = null;
  let activeLiveLookups = 0;

  const listingPromiseByUrl = new Map();
  const livePricePromiseById = new Map();
  const liveLookupWaiters = [];

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
    if (raw.includes("star") || raw === "sc" || raw === "soft") return "SC";
    if (raw.includes("diamond") || raw === "dia" || raw === "hard") return "DIA";

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

  function extractPrice(entry) {
    if (!entry || typeof entry !== "object") {
      return null;
    }

    const price =
      entry.salesPrice ??
      entry.price?.salesPrice ??
      entry.pricing?.salesPrice ??
      entry.salePrice ??
      entry.price?.amount ??
      null;

    const currency =
      entry.currency ??
      entry.price?.currency ??
      entry.pricing?.currency ??
      entry.currencyType ??
      entry.priceType ??
      null;

    if (price == null) {
      return null;
    }

    return {
      price,
      currency: normalizeCurrency(currency),
    };
  }

  async function fetchJsonResource(url) {
    const response = await fetch(url, {
      cache: "no-cache",
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  }

  function parseLastPageHeader(linkHeader) {
    if (!linkHeader) {
      return null;
    }

    const parts = String(linkHeader).split(",");
    for (const part of parts) {
      if (!part.includes('rel="last"')) {
        continue;
      }

      const match = part.match(/<([^>]+)>/);
      if (!match) {
        continue;
      }

      try {
        const parsed = new URL(match[1], "https://eu.mspapis.com/");
        const page = Number.parseInt(parsed.searchParams.get("page") || "", 10);
        if (Number.isInteger(page) && page > 0) {
          return page;
        }
      } catch {}
    }

    return null;
  }

  async function fetchListingPage(url) {
    const response = await fetch(url, {
      cache: "no-cache",
      headers: {
        accept: "application/json",
      },
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const totalCount = Number.parseInt(response.headers.get("x-total-count") || "", 10);
    const lastPageFromHeader = parseLastPageHeader(response.headers.get("link"));
    const calculatedLastPage =
      Number.isInteger(totalCount) && totalCount > 0
        ? Math.ceil(totalCount / PAGE_SIZE)
        : null;

    let lastPage = lastPageFromHeader ?? calculatedLastPage;
    if (Number.isInteger(MAX_PAGES) && MAX_PAGES > 0) {
      lastPage = Number.isInteger(lastPage) ? Math.min(lastPage, MAX_PAGES) : MAX_PAGES;
    }

    return {
      data,
      totalCount: Number.isInteger(totalCount) ? totalCount : null,
      lastPage: Number.isInteger(lastPage) && lastPage > 0 ? lastPage : null,
    };
  }

  function getJsonBucketName(id) {
    const numericId = Number.parseInt(id, 10);
    const start = Math.floor(numericId / 1000) * 1000;
    const end = start + 999;
    return `${start}-${end}`;
  }

  function buildItemJsonUrl(id) {
    return `${JSON_REPO_BASE_URL}/${getJsonBucketName(id)}/${id}.json`;
  }

  function getStoredLivePrice(id) {
    try {
      const raw = localStorage.getItem(`${LIVE_PRICE_CACHE_PREFIX}${id}`);
      if (!raw) return null;

      const payload = JSON.parse(raw);
      if (!payload || typeof payload !== "object") {
        return null;
      }

      const cachedAt = Number(payload.cachedAt || 0);
      if (cachedAt && Date.now() - cachedAt > LIVE_PRICE_CACHE_TTL_MS) {
        localStorage.removeItem(`${LIVE_PRICE_CACHE_PREFIX}${id}`);
        return null;
      }

      return payload;
    } catch {
      return null;
    }
  }

  function storeLivePrice(id, entry) {
    try {
      localStorage.setItem(
        `${LIVE_PRICE_CACHE_PREFIX}${id}`,
        JSON.stringify({
          ...entry,
          cachedAt: Date.now(),
        })
      );
    } catch {}
  }

  async function acquireLiveLookupSlot() {
    if (activeLiveLookups < LIVE_LOOKUP_CONCURRENCY) {
      activeLiveLookups += 1;
      return;
    }

    await new Promise((resolve) => {
      liveLookupWaiters.push(resolve);
    });
    activeLiveLookups += 1;
  }

  function releaseLiveLookupSlot() {
    activeLiveLookups = Math.max(0, activeLiveLookups - 1);
    const next = liveLookupWaiters.shift();
    if (next) {
      next();
    }
  }

  function extractBestTagsForListing(item) {
    const tags = Array.isArray(item?.tags) ? item.tags : [];
    const buckets = {
      rootCategory: [],
      gender: [],
      category: [],
      subcategory: [],
      collection: [],
      meta: [],
      other: [],
    };

    for (const tag of tags) {
      const tagId = String(tag?.id ?? "").trim();
      const tagType = String(tag?.type ?? "").trim();

      if (!tagId) {
        continue;
      }

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
          .filter((entry) => entry?.type === "label" && entry?.key)
          .map((entry) => String(entry.key).toLowerCase());

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
    const pushUnique = (values) => {
      for (const value of values) {
        if (!finalTags.includes(value)) {
          finalTags.push(value);
        }
      }
    };

    pushUnique(buckets.rootCategory);
    pushUnique(buckets.gender);
    pushUnique(buckets.category);
    pushUnique(buckets.subcategory);
    pushUnique(buckets.collection);

    return finalTags;
  }

  function buildTagStrategies(item) {
    const baseBuckets = {
      rootCategory: [],
      gender: [],
      category: [],
      subcategory: [],
      collection: [],
      meta: [],
    };

    const tags = Array.isArray(item?.tags) ? item.tags : [];
    for (const tag of tags) {
      const tagId = String(tag?.id ?? "").trim();
      const tagType = String(tag?.type ?? "").trim();

      if (!tagId) {
        continue;
      }

      if (tagType === "gender") {
        baseBuckets.gender.push(tagId);
        continue;
      }

      if (tagType.startsWith("collection.")) {
        baseBuckets.collection.push(tagId);
        continue;
      }

      if (tagType === "meta") {
        baseBuckets.meta.push(tagId);
        continue;
      }

      if (tagType.startsWith("subcategory.")) {
        baseBuckets.subcategory.push(tagId);
        continue;
      }

      if (tagType.startsWith("category.")) {
        const lookUpId = String(tag?.lookUpId ?? "").toLowerCase();
        const labelKeys = (tag?.resourceIdentifiers || [])
          .filter((entry) => entry?.type === "label" && entry?.key)
          .map((entry) => String(entry.key).toLowerCase());

        const isRootClothes =
          tagType === "category.clothes" &&
          (lookUpId === "tag_clothes" ||
            lookUpId === "tag_beauty" ||
            labelKeys.includes("tag_clothes") ||
            labelKeys.includes("tag_beauty"));

        if (isRootClothes) {
          baseBuckets.rootCategory.push(tagId);
        } else {
          baseBuckets.category.push(tagId);
        }
      }
    }

    for (const key of Object.keys(baseBuckets)) {
      baseBuckets[key] = [...new Set(baseBuckets[key])];
    }

    const strategies = [];
    const strategyKeys = new Set();

    function pushStrategy(values) {
      const unique = [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
      if (!unique.length) {
        return;
      }

      const key = unique.join(",");
      if (strategyKeys.has(key)) {
        return;
      }

      strategyKeys.add(key);
      strategies.push(unique);
    }

    const collectionOptions = [[], ...baseBuckets.collection.map((id) => [id])];
    const metaOptions = [[], ...baseBuckets.meta.map((id) => [id])];

    for (const collection of collectionOptions) {
      pushStrategy([
        ...baseBuckets.rootCategory,
        ...baseBuckets.gender,
        ...baseBuckets.category,
        ...baseBuckets.subcategory,
        ...collection,
      ]);
      pushStrategy([
        ...baseBuckets.rootCategory,
        ...baseBuckets.gender,
        ...baseBuckets.category,
        ...collection,
      ]);
      pushStrategy([
        ...baseBuckets.rootCategory,
        ...baseBuckets.gender,
        ...baseBuckets.subcategory,
        ...collection,
      ]);
      pushStrategy([
        ...baseBuckets.gender,
        ...baseBuckets.category,
        ...baseBuckets.subcategory,
        ...collection,
      ]);
      pushStrategy([
        ...baseBuckets.rootCategory,
        ...baseBuckets.category,
        ...baseBuckets.subcategory,
        ...collection,
      ]);
      pushStrategy([
        ...baseBuckets.rootCategory,
        ...baseBuckets.gender,
        ...collection,
      ]);
      pushStrategy([
        ...baseBuckets.category,
        ...baseBuckets.subcategory,
        ...collection,
      ]);
      pushStrategy([
        ...baseBuckets.category,
        ...collection,
      ]);
      pushStrategy([
        ...baseBuckets.subcategory,
        ...collection,
      ]);
      pushStrategy(collection);
    }

    for (const meta of metaOptions) {
      pushStrategy([
        ...baseBuckets.rootCategory,
        ...baseBuckets.gender,
        ...baseBuckets.category,
        ...baseBuckets.subcategory,
        ...meta,
      ]);
      pushStrategy([
        ...baseBuckets.rootCategory,
        ...baseBuckets.gender,
        ...baseBuckets.category,
        ...meta,
      ]);
      pushStrategy([
        ...baseBuckets.rootCategory,
        ...baseBuckets.gender,
        ...meta,
      ]);
      pushStrategy(meta);
    }

    pushStrategy(extractBestTagsForListing(item));

    return strategies;
  }

  function buildListingUrl(tagIds, shopId, page) {
    const url = new URL(`https://eu.mspapis.com/shopinventory/v1/shops/${shopId}/listings`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("pageSize", String(PAGE_SIZE));

    for (const tagId of tagIds) {
      url.searchParams.append("tag", tagId);
    }

    return url.toString();
  }

  function extractListingItemId(entry) {
    const candidates = [
      entry?.item?.objectId,
      entry?.item?.id,
      entry?.objectId,
      entry?.id,
    ];

    for (const candidate of candidates) {
      const value = Number.parseInt(String(candidate ?? "").trim(), 10);
      if (Number.isInteger(value)) {
        return value;
      }
    }

    return null;
  }

  async function loadListing(url) {
    if (!listingPromiseByUrl.has(url)) {
      listingPromiseByUrl.set(
        url,
        fetchListingPage(url).catch((error) => {
          listingPromiseByUrl.delete(url);
          throw error;
        })
      );
    }

    return listingPromiseByUrl.get(url);
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

  function getOrCreateMetaPriceRow(card) {
    const metaGrid = card.querySelector(".meta-grid");
    if (!metaGrid) return null;

    let row = metaGrid.querySelector(".meta-row.meta-price-row");
    if (!row) {
      row = document.createElement("div");
      row.className = "meta-row meta-price-row";

      const key = document.createElement("span");
      key.className = "meta-key";
      key.textContent = "Cena";

      const value = document.createElement("span");
      value.className = "meta-price";
      value.textContent = "—";

      row.append(key, value);
      metaGrid.append(row);
    }

    return row.querySelector(".meta-price");
  }

  function setBadgeState(badge, text, className) {
    badge.hidden = false;
    badge.className = "price-badge";
    if (className) {
      badge.classList.add(className);
    }
    badge.textContent = text;
  }

  function setMetaPriceState(metaPrice, text) {
    if (metaPrice) {
      metaPrice.textContent = text;
    }
  }

  function hideBadge(badge) {
    badge.hidden = true;
  }

  function applyDisplayToCard(badge, metaPrice, entry, fallbackText = "Brak ceny") {
    const display = extractDisplayData(entry);
    if (!display || display.text === "Brak ceny") {
      hideBadge(badge);
      setMetaPriceState(metaPrice, fallbackText);
      return;
    }

    setBadgeState(badge, display.text, display.className);
    setMetaPriceState(metaPrice, display.text);
  }

  async function findLivePriceForId(id) {
    const stored = getStoredLivePrice(id);
    if (stored) {
      return stored;
    }

    if (livePricePromiseById.has(id)) {
      return livePricePromiseById.get(id);
    }

    const promise = (async () => {
      await acquireLiveLookupSlot();

      try {
        const item = await fetchJsonResource(buildItemJsonUrl(id));
        if (!item) {
          const result = { notFound: true };
          storeLivePrice(id, result);
          return result;
        }

        const tagStrategies = buildTagStrategies(item);
        if (!tagStrategies.length) {
          const result = { notFound: true };
          storeLivePrice(id, result);
          return result;
        }

        for (const tagIds of tagStrategies) {
          for (const shopId of SHOP_IDS) {
            let lastPage = Number.isInteger(MAX_PAGES) && MAX_PAGES > 0 ? MAX_PAGES : 1;

            for (let page = 1; page <= lastPage; page += 1) {
              const listingPage = await loadListing(buildListingUrl(tagIds, shopId, page));
              if (!listingPage || !Array.isArray(listingPage.data)) {
                continue;
              }

              if (Number.isInteger(listingPage.lastPage) && listingPage.lastPage > lastPage) {
                lastPage = listingPage.lastPage;
              }

              const found = listingPage.data.find(
                (entry) => String(extractListingItemId(entry)) === String(id)
              );
              if (found) {
                const parsedPrice = extractDisplayData(extractPrice(found));
                const result = {
                  price:
                    found?.salesPrice ??
                    found?.price?.salesPrice ??
                    found?.pricing?.salesPrice ??
                    found?.salePrice ??
                    found?.price?.amount ??
                    null,
                  currency: normalizeCurrency(
                    found?.currency ??
                      found?.price?.currency ??
                      found?.pricing?.currency ??
                      found?.currencyType ??
                      found?.priceType ??
                      null
                  ),
                  shop: shopId,
                  page,
                  foundButNoPrice: !parsedPrice,
                };
                storeLivePrice(id, result);
                return result;
              }

              if (listingPage.data.length < PAGE_SIZE) {
                break;
              }
            }
          }
        }

        const result = { notFound: true };
        storeLivePrice(id, result);
        return result;
      } finally {
        releaseLiveLookupSlot();
        livePricePromiseById.delete(id);
      }
    })();

    livePricePromiseById.set(id, promise);
    return promise;
  }

  async function applyPriceToCard(card) {
    const badge = getOrCreateBadge(card);
    const metaPrice = getOrCreateMetaPriceRow(card);
    if (!badge) return;

    const id = getItemIdFromCard(card);
    if (!id) {
      setBadgeState(badge, "Brak ID", "is-runtime-error");
      if (metaPrice) metaPrice.textContent = "Brak ID";
      return;
    }

    try {
      const prices = await loadPrices();
      const entry = getPriceEntry(prices, id) || getStoredLivePrice(id);

      if (entry) {
        applyDisplayToCard(badge, metaPrice, entry);
        return;
      }

      setBadgeState(badge, "Szukam ceny...", "is-runtime-loading");
      setMetaPriceState(metaPrice, "Szukam ceny...");

      const liveEntry = await findLivePriceForId(id);
      if (getItemIdFromCard(card) !== id) {
        return;
      }

      if (!liveEntry || liveEntry.notFound) {
        hideBadge(badge);
        setMetaPriceState(metaPrice, "Brak ceny");
        return;
      }

      applyDisplayToCard(badge, metaPrice, liveEntry);
    } catch (error) {
      console.error("price-badges.js:", error);
      setBadgeState(badge, "Błąd ceny", "is-runtime-error");
      setMetaPriceState(metaPrice, "Błąd ceny");
    }
  }

  function scan(root = document) {
    const cards = Array.from(root.querySelectorAll(CARD_SELECTOR));
    for (const card of cards) {
      applyPriceToCard(card);
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

  function init() {
    scan(document);
    observe();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
