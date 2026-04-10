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
  const MAX_PAGES = 3;
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

  function buildListingUrl(tagIds, shopId, page) {
    const url = new URL(`https://eu.mspapis.com/shopinventory/v1/shops/${shopId}/listings`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("pageSize", String(PAGE_SIZE));

    for (const tagId of tagIds) {
      url.searchParams.append("tag", tagId);
    }

    return url.toString();
  }

  async function loadListing(url) {
    if (!listingPromiseByUrl.has(url)) {
      listingPromiseByUrl.set(
        url,
        fetchJsonResource(url).catch((error) => {
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

        const tagIds = extractBestTagsForListing(item);
        if (!tagIds.length) {
          const result = { notFound: true };
          storeLivePrice(id, result);
          return result;
        }

        for (const shopId of SHOP_IDS) {
          for (let page = 1; page <= MAX_PAGES; page += 1) {
            const listing = await loadListing(buildListingUrl(tagIds, shopId, page));
            if (!Array.isArray(listing)) {
              continue;
            }

            const found = listing.find((entry) => String(entry?.id) === String(id));
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

            if (listing.length < PAGE_SIZE) {
              break;
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
