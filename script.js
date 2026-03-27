const BATCH_SIZE = 60;
const STATIC_CATALOG_URL = "./data/catalog.json";
const JSON_REPO_BASE_URL = "https://github.com/komimsp/msp2_json_ids/blob/main/ids";

const state = {
  renderedCount: 0,
  totalAvailable: 0,
  searchQuery: "",
  selectedCollectionType: "",
  selectedSortOrder: "desc",
  isRendering: false,
  cachedItemsCount: -1,
  imageRotationById: new Map(),
  lastRenderedGroupKey: null,
  catalog: null,
};

const elements = {
  repoStats: document.getElementById("repo-stats"),
  resultsLabel: document.getElementById("results-label"),
  statusMessage: document.getElementById("status-message"),
  search: document.getElementById("search"),
  showId: document.getElementById("show-id"),
  collectionType: document.getElementById("collection-type"),
  sortOrder: document.getElementById("sort-order"),
  clearSearch: document.getElementById("clear-search"),
  items: document.getElementById("items"),
  emptyState: document.getElementById("empty-state"),
  loadMore: document.getElementById("load-more"),
  sentinel: document.getElementById("sentinel"),
  template: document.getElementById("item-template"),
  scanState: document.getElementById("scan-state"),
  scanRange: document.getElementById("scan-range"),
  scanProgress: document.getElementById("scan-progress"),
  scanNextRun: document.getElementById("scan-next-run"),
  resultsHint: document.getElementById("results-hint"),
  imageModal: document.getElementById("image-modal"),
  imageModalImg: document.getElementById("image-modal-img"),
  imageModalId: document.getElementById("image-modal-id"),
  imageModalLink: document.getElementById("image-modal-link"),
  imageModalClose: document.getElementById("image-modal-close"),
};

function formatNumber(value) {
  return new Intl.NumberFormat("pl-PL").format(value);
}

function formatDate(value) {
  if (!value) return "—";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("pl-PL");
}

function setStatus(message, isError = false) {
  elements.statusMessage.textContent = message;
  elements.statusMessage.style.color = isError ? "#8d2b1d" : "";
}

function setTemporaryStatus(message, isError = false, timeoutMs = 2600) {
  setStatus(message, isError);
  window.setTimeout(() => {
    if (elements.statusMessage.textContent === message) {
      elements.statusMessage.style.color = "";
      refreshStatus().catch(() => {});
    }
  }, timeoutMs);
}

function normalizeIdQuery(rawValue) {
  return String(rawValue || "")
    .replace(/[^\d]+/g, "")
    .trim();
}

function formatCollectionTypeLabel(collectionType) {
  if (!collectionType) {
    return "wszystkie collection";
  }

  return collectionType.startsWith("collection.")
    ? collectionType.slice("collection.".length)
    : collectionType;
}

function formatSortOrderLabel(sortOrder) {
  return sortOrder === "asc"
    ? "ID od najmniejszych do największych"
    : "ID od największych do najmniejszych";
}

function updateResultsHint() {
  const sortText = formatSortOrderLabel(state.selectedSortOrder);

  if (state.searchQuery) {
    elements.resultsHint.textContent =
      `Pokazuję dokładnie ID ${state.searchQuery}. Filtr collection jest pomijany. ${sortText}.`;
    return;
  }

  if (state.selectedCollectionType) {
    elements.resultsHint.textContent =
      `Pokazuję grupy tylko dla ${state.selectedCollectionType}. ${sortText}.`;
    return;
  }

  elements.resultsHint.textContent = `Najpierw grupy z tagów collection, potem reszta ID. ${sortText}.`;
}

function getConnectionHelp() {
  if (window.location.protocol === "file:") {
    return "Ta strona nie działa bezpośrednio z pliku `index.html`. Otwórz ją przez GitHub Pages albo lokalny serwer HTTP.";
  }

  return "Nie udało się wczytać katalogu statycznego z repozytorium.";
}

function getStaticCollectionTypes(items) {
  const counts = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    const type = item?.collectionGroup?.type;
    if (!type) continue;
    counts.set(type, (counts.get(type) || 0) + 1);
  }

  return [...counts.entries()]
    .map(([type, count]) => ({
      type,
      suffix: formatCollectionTypeLabel(type),
      count,
    }))
    .sort((left, right) => left.suffix.localeCompare(right.suffix, "pl"));
}

async function ensureCatalogLoaded() {
  if (state.catalog) {
    return state.catalog;
  }

  let response;
  try {
    response = await fetch(STATIC_CATALOG_URL, {
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
    });
  } catch (error) {
    throw new Error(getConnectionHelp());
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  const payload = await response.json();
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const availableCollectionTypes =
    Array.isArray(payload?.availableCollectionTypes) && payload.availableCollectionTypes.length
      ? payload.availableCollectionTypes
      : getStaticCollectionTypes(items);
  const totalImages = items.filter((item) => item?.hasImage).length;
  const metadataCount = items.filter((item) => item?.metadata).length;

  state.catalog = {
    ...payload,
    items,
    total: payload?.total ?? items.length,
    minId: payload?.minId ?? Math.min(...items.map((item) => Number(item.id)).filter(Number.isFinite)),
    maxId: payload?.maxId ?? Math.max(...items.map((item) => Number(item.id)).filter(Number.isFinite)),
    totalImages,
    metadataCount,
    availableCollectionTypes,
  };
  state.cachedItemsCount = metadataCount;
  return state.catalog;
}

function compareItems(left, right, sortOrder, groupFirst = true) {
  const leftHasGroup = Boolean(left?.collectionGroup);
  const rightHasGroup = Boolean(right?.collectionGroup);

  if (groupFirst && leftHasGroup !== rightHasGroup) {
    return leftHasGroup ? -1 : 1;
  }

  if (leftHasGroup && rightHasGroup) {
    const groupCompare = String(left.collectionGroup?.sortKey || "").localeCompare(
      String(right.collectionGroup?.sortKey || ""),
      "pl"
    );

    if (groupCompare !== 0) {
      return groupCompare;
    }
  }

  return sortOrder === "asc" ? left.id - right.id : right.id - left.id;
}

function getFilteredItems({ ids = [], searchQuery = "", collectionType = "", sortOrder = "desc" } = {}) {
  const catalogItems = Array.isArray(state.catalog?.items) ? state.catalog.items : [];
  const normalizedSearch = normalizeIdQuery(searchQuery);

  if (ids.length) {
    const map = new Map(catalogItems.map((item) => [String(item.id), item]));
    return ids.map((id) => map.get(String(id))).filter(Boolean);
  }

  let items = catalogItems;

  if (normalizedSearch) {
    items = items.filter((item) => String(item.id) === normalizedSearch);
  } else if (collectionType) {
    items = items.filter((item) => item?.collectionGroup?.type === collectionType);
  }

  return [...items].sort((left, right) =>
    compareItems(left, right, sortOrder, !normalizedSearch && !collectionType)
  );
}

function buildStaticStatusPayload() {
  const catalog = state.catalog;
  return {
    totalImages: catalog?.totalImages ?? 0,
    totalItems: catalog?.total ?? 0,
    cachedItemsCount: catalog?.metadataCount ?? 0,
    minId: catalog?.minId ?? null,
    maxId: catalog?.maxId ?? null,
    availableCollectionTypes: catalog?.availableCollectionTypes ?? [],
    generatedAt: catalog?.generatedAt ?? null,
    source: catalog?.source ?? null,
    isCompleted: true,
    isScanning: false,
    coverageAuditEnabled: false,
    activeRange: null,
    nextRange: null,
    nextRunAt: null,
    completedRanges: 1,
    totalRanges: 1,
    rangeSize: catalog?.total ?? 0,
    scanIntervalMinutes: 0,
    lastError: null,
  };
}

async function fetchJson(url) {
  await ensureCatalogLoaded();

  if (url === "/api/status") {
    return buildStaticStatusPayload();
  }

  if (typeof url === "string" && url.startsWith("/api/items-by-ids")) {
    const requestUrl = new URL(url, window.location.origin);
    const ids = String(requestUrl.searchParams.get("ids") || "")
      .split(",")
      .map((value) => normalizeIdQuery(value))
      .filter(Boolean);

    return {
      items: getFilteredItems({ ids }),
    };
  }

  if (typeof url === "string" && url.startsWith("/api/items")) {
    const requestUrl = new URL(url, window.location.origin);
    const offset = Number.parseInt(requestUrl.searchParams.get("offset") || "0", 10);
    const limit = Number.parseInt(requestUrl.searchParams.get("limit") || String(BATCH_SIZE), 10);
    const collectionType = requestUrl.searchParams.get("collectionType") || "";
    const sortOrder = requestUrl.searchParams.get("sortOrder") === "asc" ? "asc" : "desc";
    const items = getFilteredItems({ collectionType, sortOrder });

    return {
      total: items.length,
      items: items.slice(Math.max(offset, 0), Math.max(offset, 0) + Math.max(limit, 0)),
    };
  }

  throw new Error(`Nieobsługiwany adres danych: ${url}`);
}

function ensureMetaCollection(container, emptyText) {
  container.replaceChildren();
  const fallback = document.createElement("span");
  fallback.className = "meta-empty";
  fallback.textContent = emptyText;
  container.appendChild(fallback);
}

function buildColorChip(color) {
  const chip = document.createElement("span");
  chip.className = "color-chip";

  const dot = document.createElement("span");
  dot.className = "color-dot";
  dot.style.background = color;

  const label = document.createElement("span");
  label.textContent = color;

  chip.append(dot, label);
  return chip;
}

function buildTagField(label, value) {
  const row = document.createElement("div");
  row.className = "tag-row";

  const key = document.createElement("span");
  key.className = "tag-row-key";
  key.textContent = label;

  const content = document.createElement("span");
  content.className = "tag-row-value";
  content.textContent = value ?? "—";

  row.append(key, content);
  return row;
}

function buildResourceIdentifier(resourceIdentifier, index) {
  const block = document.createElement("div");
  block.className = "resource-item";

  const title = document.createElement("p");
  title.className = "resource-title";
  title.textContent = `resourceIdentifier ${index + 1}`;

  block.append(
    title,
    buildTagField("key", resourceIdentifier?.key ?? "—"),
    buildTagField("type", resourceIdentifier?.type ?? "—")
  );

  return block;
}

function buildTagDetails(tag, index) {
  const details = document.createElement("details");
  details.className = "tag-details";

  const summary = document.createElement("summary");
  summary.className = "tag-summary";

  const summaryText = document.createElement("span");
  summaryText.className = "tag-summary-text";
  summaryText.textContent = [tag?.type || "tag", tag?.id ? `#${tag.id}` : null]
    .filter(Boolean)
    .join(" ");

  const summaryHint = document.createElement("span");
  summaryHint.className = "tag-summary-hint";
  summaryHint.textContent = `Tag ${index + 1}`;

  summary.append(summaryText, summaryHint);

  const body = document.createElement("div");
  body.className = "tag-body";
  body.append(
    buildTagField("gameId", tag?.gameId ?? "—"),
    buildTagField("hidden", String(Boolean(tag?.hidden))),
    buildTagField("id", tag?.id ?? "—"),
    buildTagField("type", tag?.type ?? "—"),
    buildTagField("lookUpId", tag?.lookUpId ?? "—")
  );

  const resources = Array.isArray(tag?.resourceIdentifiers) ? tag.resourceIdentifiers : [];
  const resourceSection = document.createElement("div");
  resourceSection.className = "resource-list";

  if (resources.length) {
    resourceSection.append(...resources.map((resourceIdentifier, resourceIndex) =>
      buildResourceIdentifier(resourceIdentifier, resourceIndex)
    ));
  } else {
    const empty = document.createElement("span");
    empty.className = "meta-empty";
    empty.textContent = "Brak resourceIdentifiers.";
    resourceSection.append(empty);
  }

  body.append(resourceSection);
  details.append(summary, body);
  return details;
}

function normalizeRuntimeTag(tag) {
  return {
    gameId: tag?.gameId ?? null,
    hidden: Boolean(tag?.hidden),
    id: tag?.id ?? null,
    lookUpId: tag?.lookUpId ?? null,
    type: tag?.type ?? null,
    resourceIdentifiers: Array.isArray(tag?.resourceIdentifiers)
      ? tag.resourceIdentifiers.map((resourceIdentifier) => ({
          key: resourceIdentifier?.key ?? null,
          type: resourceIdentifier?.type ?? null,
        }))
      : [],
  };
}

function isVipTag(tag) {
  const tagType = String(tag?.type || "").toLowerCase();
  const lookupId = String(tag?.lookUpId || "").toLowerCase();
  const firstResource = Array.isArray(tag?.resourceIdentifiers) ? tag.resourceIdentifiers[0] : null;
  const resourceKey = String(firstResource?.key || "").toUpperCase();
  const resourceType = String(firstResource?.type || "").toLowerCase();

  return (
    tagType === "meta" &&
    lookupId === "tag_vip_item" &&
    resourceKey === "TAG_VIP" &&
    resourceType === "label"
  );
}

function isVipMetadata(metadata) {
  if (metadata?.flags?.vip) {
    return true;
  }

  return Array.isArray(metadata?.tags) && metadata.tags.some((tag) => isVipTag(tag));
}

function isDiamondTag(tag) {
  const tagType = String(tag?.type || "").toLowerCase();
  const lookupId = String(tag?.lookUpId || "").toLowerCase();
  const resources = Array.isArray(tag?.resourceIdentifiers) ? tag.resourceIdentifiers : [];
  const firstResource = resources[0] ?? null;
  const secondResource = resources[1] ?? null;
  const firstResourceKey = String(firstResource?.key || "").toUpperCase();
  const firstResourceType = String(firstResource?.type || "").toLowerCase();
  const secondResourceKey = String(secondResource?.key || "").toLowerCase();

  return (
    tagType === "meta" &&
    lookupId === "tag_diamond_item" &&
    firstResourceKey === "TAG_DIAMOND" &&
    firstResourceType === "label" &&
    secondResourceKey === "diamond_item"
  );
}

function isDiamondMetadata(metadata) {
  if (metadata?.flags?.diamond) {
    return true;
  }

  return Array.isArray(metadata?.tags) && metadata.tags.some((tag) => isDiamondTag(tag));
}

function isLimitedTag(tag) {
  const tagType = String(tag?.type || "").toLowerCase();
  const lookupId = String(tag?.lookUpId || "").toUpperCase();
  const firstResource = Array.isArray(tag?.resourceIdentifiers) ? tag.resourceIdentifiers[0] : null;
  const resourceKey = String(firstResource?.key || "").toUpperCase();
  const resourceType = String(firstResource?.type || "").toLowerCase();

  return (
    tagType === "meta" &&
    lookupId === "TAG_LIMITED" &&
    resourceKey === "TAG_LIMITED" &&
    resourceType === "label"
  );
}

function isLimitedMetadata(metadata) {
  if (metadata?.flags?.limited) {
    return true;
  }

  return Array.isArray(metadata?.tags) && metadata.tags.some((tag) => isLimitedTag(tag));
}

function getGenderInfo(metadata) {
  const genders = {
    girl: Boolean(metadata?.flags?.girl),
    boy: Boolean(metadata?.flags?.boy),
  };

  if (!Array.isArray(metadata?.tags)) {
    return genders;
  }

  for (const tag of metadata.tags) {
    if (String(tag?.type || "").toLowerCase() !== "gender") {
      continue;
    }

    const resources = Array.isArray(tag?.resourceIdentifiers) ? tag.resourceIdentifiers : [];
    const keys = resources
      .map((resource) => String(resource?.key || "").toUpperCase())
      .filter(Boolean);
    const graphicsKeys = resources
      .map((resource) => String(resource?.key || "").toLowerCase())
      .filter(Boolean);

    if (keys.includes("TAG_GIRL") || graphicsKeys.includes("girl")) {
      genders.girl = true;
    }

    if (keys.includes("TAG_BOY") || graphicsKeys.includes("boy")) {
      genders.boy = true;
    }
  }

  return genders;
}

function buildGenderMarker(symbol, label, className) {
  const marker = document.createElement("span");
  marker.className = `gender-marker ${className}`;
  marker.textContent = symbol;
  marker.setAttribute("title", label);
  marker.setAttribute("aria-label", label);
  return marker;
}

function renderGenderMarkers(container, metadata) {
  container.replaceChildren();

  const genderInfo = getGenderInfo(metadata);
  const markers = [];

  if (genderInfo.boy) {
    markers.push(buildGenderMarker("♂", "Boy", "is-boy"));
  }

  if (genderInfo.girl) {
    markers.push(buildGenderMarker("♀", "Girl", "is-girl"));
  }

  if (markers.length) {
    container.append(...markers);
    container.hidden = false;
    return;
  }

  container.hidden = true;
}

function buildSpecialBadge(label, className) {
  const badge = document.createElement("span");
  badge.className = `special-badge ${className}`;
  badge.textContent = label;
  badge.setAttribute("title", label);
  badge.setAttribute("aria-label", label);
  return badge;
}

function renderSpecialBadges(container, metadata) {
  container.replaceChildren();

  const badges = [];
  if (isLimitedMetadata(metadata)) {
    badges.push(buildSpecialBadge("LIMITED", "is-limited"));
  }

  if (badges.length) {
    container.append(...badges);
    container.hidden = false;
    return;
  }

  container.hidden = true;
}

function populateCollectionTypes(collectionTypes) {
  const currentValue = state.selectedCollectionType;
  const normalizedTypes = Array.isArray(collectionTypes) ? collectionTypes : [];
  const availableValues = new Set([""]);

  elements.collectionType.replaceChildren();

  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = "Wszystkie collection";
  elements.collectionType.appendChild(allOption);

  for (const entry of normalizedTypes) {
    if (!entry?.type) continue;

    const option = document.createElement("option");
    option.value = entry.type;
    option.textContent = `${entry.suffix || formatCollectionTypeLabel(entry.type)} (${formatNumber(entry.count || 0)})`;
    option.title = entry.type;
    elements.collectionType.appendChild(option);
    availableValues.add(entry.type);
  }

  if (!availableValues.has(currentValue)) {
    state.selectedCollectionType = "";
  }

  elements.collectionType.value = state.selectedCollectionType;
}

function getCollectionGroupKey(item) {
  return item.collectionGroup?.sortKey || "__ungrouped__";
}

function buildGroupSeparator(item) {
  const group = item.collectionGroup;
  const separator = document.createElement("div");
  separator.className = "group-separator";

  const title = document.createElement("p");
  title.className = "group-separator-title";
  title.textContent = group ? group.label : "Pozostałe ID";

  const meta = document.createElement("p");
  meta.className = "group-separator-meta";

  if (group) {
    meta.textContent = [group.type, group.lookUpId, group.key]
      .filter(Boolean)
      .join(" · ");
  } else {
    meta.textContent = "Brak tagu collection albo dane tego ID nie są jeszcze zeskanowane.";
  }

  separator.append(title, meta);
  return separator;
}

function setCardImageState(card, status) {
  card.classList.toggle("is-image-ready", status === "ready");
  card.classList.toggle("is-image-loading", status === "loading");
  card.classList.toggle("is-broken", status === "broken");
}

function applyImageRotation(card, itemId) {
  const image = card.querySelector(".item-image");
  const rotation = state.imageRotationById.get(String(itemId)) ?? 0;
  image.style.setProperty("--image-rotation", `${rotation}deg`);
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Nie udało się załadować obrazu ${src}`));
    image.src = src;
  });
}

function getJsonBucketName(id) {
  const numericId = Number(id);
  const start = Math.floor(numericId / 1000) * 1000;
  const end = start + 999;
  return `${start}-${end}`;
}

function buildJsonRepoUrl(id) {
  return `${JSON_REPO_BASE_URL}/${getJsonBucketName(id)}/${id}.json`;
}

async function ensureFullItemMetadata(item, card = null) {
  if (!item?.metadata || item.metadata.fullJsonLoaded) {
    return item?.metadata ?? null;
  }

  const jsonUrl =
    item.jsonCdnUrl ||
    `https://cdn.jsdelivr.net/gh/komimsp/msp2_json_ids@main/ids/${getJsonBucketName(item.id)}/${item.id}.json`;

  let response;
  try {
    response = await fetch(jsonUrl, {
      headers: {
        Accept: "application/json",
      },
      cache: "force-cache",
    });
  } catch (error) {
    throw new Error(`Nie udało się pobrać JSON dla ID ${item.id}.`);
  }

  if (!response.ok) {
    throw new Error(`JSON ID ${item.id} zwrócił HTTP ${response.status}.`);
  }

  const payload = await response.json();
  item.metadata = {
    ...item.metadata,
    created: payload?.created ?? item.metadata?.created ?? null,
    modified: payload?.modified ?? item.metadata?.modified ?? null,
    itemType: payload?.additionalData?.MSP2Data?.Type ?? item.metadata?.itemType ?? null,
    nameResourceIdentifier:
      payload?.nameResourceIdentifier ?? item.metadata?.nameResourceIdentifier ?? null,
    graphicsResourceIdentifier:
      payload?.graphicsResourceIdentifier ?? item.metadata?.graphicsResourceIdentifier ?? null,
    defaultColors: String(payload?.additionalData?.NebulaData?.DefaultColors ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    tags: Array.isArray(payload?.tags) ? payload.tags.map((tag) => normalizeRuntimeTag(tag)) : [],
    fullJsonLoaded: true,
    flags: {
      girl: item.metadata?.flags?.girl ?? false,
      boy: item.metadata?.flags?.boy ?? false,
      vip: item.metadata?.flags?.vip ?? false,
      diamond: item.metadata?.flags?.diamond ?? false,
      limited: item.metadata?.flags?.limited ?? false,
    },
  };

  if (card?.isConnected) {
    applyItemToCard(card, item);
  }

  return item.metadata;
}

async function downloadRotatedImage(item, image) {
  const rotation = state.imageRotationById.get(String(item.id)) ?? 0;
  const previewUrl = item.imageUrl || item.url;
  const sourceImage =
    image && image.naturalWidth > 0 && (image.currentSrc || image.getAttribute("src"))
      ? image
      : await loadImageElement(previewUrl);

  const sourceWidth = sourceImage.naturalWidth || sourceImage.width;
  const sourceHeight = sourceImage.naturalHeight || sourceImage.height;

  if (!sourceWidth || !sourceHeight) {
    throw new Error(`Obraz ID ${item.id} nie ma poprawnych wymiarów.`);
  }

  const normalizedRotation = ((rotation % 360) + 360) % 360;
  const quarterTurn = normalizedRotation === 90 || normalizedRotation === 270;
  const canvas = document.createElement("canvas");
  canvas.width = quarterTurn ? sourceHeight : sourceWidth;
  canvas.height = quarterTurn ? sourceWidth : sourceHeight;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Przeglądarka nie udostępnia canvas 2D.");
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.save();
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((normalizedRotation * Math.PI) / 180);
  context.drawImage(sourceImage, -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);
  context.restore();

  const blob = await new Promise((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });

  if (!blob) {
    throw new Error("Nie udało się przygotować pliku PNG do pobrania.");
  }

  const objectUrl = URL.createObjectURL(blob);
  const downloadName =
    normalizedRotation === 0
      ? item.file
      : item.file.replace(/\.png$/i, `-rot${normalizedRotation}.png`);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = downloadName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 1000);
}

function openImageModal(item) {
  const rotation = state.imageRotationById.get(String(item.id)) ?? 0;
  const previewUrl = item.imageUrl || item.url;

  elements.imageModal.classList.add("is-open");
  elements.imageModal.setAttribute("aria-hidden", "false");
  elements.imageModalImg.src = previewUrl;
  elements.imageModalImg.alt = `Powiększony podgląd przedmiotu ${item.id}`;
  elements.imageModalImg.style.transform = `rotate(${rotation}deg)`;
  elements.imageModalId.textContent = `ID ${item.id} · ${item.file}`;
  elements.imageModalLink.href = item.url;
  elements.imageModalLink.textContent = `PNG ${item.file}`;
  elements.imageModalClose.focus();
}

function closeImageModal() {
  elements.imageModal.classList.remove("is-open");
  elements.imageModal.setAttribute("aria-hidden", "true");
  elements.imageModalImg.removeAttribute("src");
  elements.imageModalImg.style.transform = "";
}

function applyItemToCard(card, item) {
  const image = card.querySelector(".item-image");
  const badge = card.querySelector(".item-badge");
  const genderMarkers = card.querySelector(".item-gender-markers");
  const specialBadges = card.querySelector(".item-special-badges");
  const metaState = card.querySelector(".meta-state");
  const metaId = card.querySelector(".meta-id");
  const metaName = card.querySelector(".meta-name");
  const metaType = card.querySelector(".meta-type");
  const metaCreated = card.querySelector(".meta-created");
  const metaModified = card.querySelector(".meta-modified");
  const metaNameRi = card.querySelector(".meta-name-ri");
  const metaGraphicsRi = card.querySelector(".meta-graphics-ri");
  const metaCollectionKey = card.querySelector(".meta-collection-key");
  const metaCollectionLookup = card.querySelector(".meta-collection-lookup");
  const metaCollectionType = card.querySelector(".meta-collection-type");
  const metaColors = card.querySelector(".meta-colors");
  const metaTags = card.querySelector(".meta-tags");
  const metaLink = card.querySelector(".meta-link");
  const metaJsonLink = card.querySelector(".meta-json-link");
  const imageSrc = item.imageUrl || item.url;
  const jsonUrl = buildJsonRepoUrl(item.id);

  card.dataset.id = String(item.id);
  badge.textContent = `ID ${item.id}`;
  image.dataset.expectedSrc = imageSrc;
  image.dataset.remoteSrc = item.url || "";
  image.dataset.retryRemote = "";
  setCardImageState(card, "loading");
  image.alt = `Podgląd przedmiotu ${item.id}`;
  metaLink.href = item.url;
  metaLink.textContent = `PNG ${item.file}`;
  metaJsonLink.href = jsonUrl;
  metaJsonLink.textContent = `JSON ${item.id}.json`;
  applyImageRotation(card, item.id);

  if (image.getAttribute("src") !== imageSrc) {
    image.src = imageSrc;
  }

  const imageUrl = image.currentSrc || image.getAttribute("src") || "";
  if (image.complete && imageUrl.includes(item.file)) {
    setCardImageState(card, image.naturalWidth > 0 ? "ready" : "broken");
  }

  const metadata = item.metadata;
  const hasMetadata = Boolean(metadata);
  const scanNote = item.scanNote || "";

  card.classList.toggle("has-data", hasMetadata);
  card.classList.toggle("is-vip", isVipMetadata(metadata));
  card.classList.toggle("is-diamond", isDiamondMetadata(metadata));
  card.classList.toggle("is-limited", isLimitedMetadata(metadata));
  renderGenderMarkers(genderMarkers, metadata);
  renderSpecialBadges(specialBadges, metadata);

  metaState.textContent = hasMetadata
    ? metadata?.fullJsonLoaded
      ? "Pełny JSON tego ID został doładowany."
      : "Skrócone dane z katalogu. Rozwiń kartę, aby doładować pełny JSON."
    : scanNote || "Dane dla tego ID nie sa jeszcze pobrane.";

  metaId.textContent = String(item.id);
  metaName.textContent = metadata?.nameResourceIdentifier || "—";
  metaType.textContent = metadata?.itemType || "—";
  metaCreated.textContent = formatDate(metadata?.created);
  metaModified.textContent = formatDate(metadata?.modified);
  metaNameRi.textContent = metadata?.nameResourceIdentifier || "—";
  metaGraphicsRi.textContent = metadata?.graphicsResourceIdentifier || "—";
  metaCollectionKey.textContent = item.collectionGroup?.key || "—";
  metaCollectionLookup.textContent = item.collectionGroup?.lookUpId || "—";
  metaCollectionType.textContent = item.collectionGroup?.type || "—";

  if (metadata?.defaultColors?.length) {
    metaColors.replaceChildren(
      ...metadata.defaultColors.map((color) => buildColorChip(color))
    );
  } else {
    ensureMetaCollection(metaColors, "Brak kolorów.");
  }

  if (metadata?.tags?.length) {
    metaTags.replaceChildren(
      ...metadata.tags.map((tag, index) => buildTagDetails(tag, index))
    );
  } else if (hasMetadata) {
    ensureMetaCollection(metaTags, "Rozwiń kartę, aby doładować pełne tagi z JSON.");
  } else {
    ensureMetaCollection(metaTags, "Brak tagów.");
  }
}

function buildCard(item) {
  const fragment = elements.template.content.cloneNode(true);
  const card = fragment.querySelector(".item-card");
  const image = fragment.querySelector(".item-image");
  const downloadButton = fragment.querySelector(".item-download");
  const zoomButton = fragment.querySelector(".item-zoom");
  const rotateButton = fragment.querySelector(".item-rotate");

  downloadButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  downloadButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();

    try {
      await downloadRotatedImage(item, image);
      setTemporaryStatus(`Pobrano PNG dla ID ${item.id}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTemporaryStatus(`Nie udało się pobrać ID ${item.id}: ${message}`, true, 4200);
    }
  });

  zoomButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  zoomButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openImageModal(item);
  });

  rotateButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  rotateButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    const key = String(item.id);
    const currentRotation = state.imageRotationById.get(key) ?? 0;
    const nextRotation = (currentRotation + 90) % 360;

    state.imageRotationById.set(key, nextRotation);
    applyImageRotation(card, item.id);
  });

  image.addEventListener("load", () => {
    const expectedSrc = image.dataset.expectedSrc || "";
    const loadedSrc = image.currentSrc || image.getAttribute("src") || "";
    if (expectedSrc && loadedSrc && !loadedSrc.includes(expectedSrc.split("/").pop())) {
      return;
    }
    setCardImageState(card, "ready");
  });

  image.addEventListener("error", () => {
    const remoteSrc = image.dataset.remoteSrc || "";
    const currentSrc = image.currentSrc || image.getAttribute("src") || "";

    if (remoteSrc && currentSrc !== remoteSrc && image.dataset.retryRemote !== "1") {
      image.dataset.retryRemote = "1";
      image.dataset.expectedSrc = remoteSrc;
      setCardImageState(card, "loading");
      image.src = remoteSrc;
      return;
    }

    setCardImageState(card, "broken");
  });

  card.addEventListener("toggle", () => {
    if (!card.open || item?.metadata?.fullJsonLoaded || !item?.metadata) {
      return;
    }

    ensureFullItemMetadata(item, card).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setTemporaryStatus(message, true, 4200);
    });
  });

  applyItemToCard(card, item);

  return fragment;
}

function updateSummary() {
  const collectionText =
    !state.searchQuery && state.selectedCollectionType
      ? ` w ${state.selectedCollectionType}`
      : "";

  if (!state.totalAvailable) {
    elements.resultsLabel.textContent = state.searchQuery
      ? `Nie znaleziono ID ${state.searchQuery}.`
      : `Brak elementów do wyświetlenia${collectionText}.`;
    return;
  }

  const queryText = state.searchQuery
    ? ` dla dokładnego ID ${state.searchQuery}`
    : "";

  elements.resultsLabel.textContent =
    `Widoczne ${formatNumber(state.renderedCount)} z ${formatNumber(state.totalAvailable)} elementów${collectionText}${queryText}.`;
}

function syncLoadMoreButton() {
  const hasMore = state.renderedCount < state.totalAvailable;
  elements.loadMore.classList.toggle("is-visible", hasMore);
}

function syncEmptyState() {
  elements.emptyState.classList.toggle("hidden", state.totalAvailable > 0);
}

function maybeFillViewport() {
  if (
    state.renderedCount < state.totalAvailable &&
    document.documentElement.scrollHeight <= window.innerHeight * 1.2
  ) {
    renderNextBatch();
  }
}

async function reloadVisibleItems() {
  const targetCount = Math.max(state.renderedCount, BATCH_SIZE);

  state.renderedCount = 0;
  state.totalAvailable = 0;
  state.lastRenderedGroupKey = null;
  elements.items.innerHTML = "";
  syncEmptyState();
  updateSummary();
  syncLoadMoreButton();

  while (state.renderedCount < targetCount) {
    const before = state.renderedCount;
    await renderNextBatch();

    if (state.renderedCount === before || state.renderedCount >= state.totalAvailable) {
      break;
    }
  }
}

async function renderNextBatch(reset = false) {
  if (state.isRendering) return;

  if (reset) {
    state.renderedCount = 0;
    state.totalAvailable = 0;
    state.lastRenderedGroupKey = null;
    elements.items.innerHTML = "";
  }

  if (!reset && state.renderedCount >= state.totalAvailable && state.totalAvailable > 0) {
    syncLoadMoreButton();
    return;
  }

  state.isRendering = true;

  try {
    if (state.searchQuery) {
      if (!reset && state.renderedCount >= state.totalAvailable && state.totalAvailable > 0) {
        updateSummary();
        syncLoadMoreButton();
        return;
      }

      const payload = await fetchJson(`/api/items-by-ids?ids=${encodeURIComponent(state.searchQuery)}`);
      const items = Array.isArray(payload.items)
        ? payload.items.filter((item) => String(item.id) === state.searchQuery)
        : [];

      state.totalAvailable = items.length;
      syncEmptyState();

      if (!items.length) {
        updateSummary();
        syncLoadMoreButton();
        return;
      }

      const fragment = document.createDocumentFragment();
      for (const item of items) {
        const groupKey = getCollectionGroupKey(item);

        if (groupKey !== state.lastRenderedGroupKey) {
          fragment.appendChild(buildGroupSeparator(item));
          state.lastRenderedGroupKey = groupKey;
        }

        fragment.appendChild(buildCard(item));
      }

      elements.items.appendChild(fragment);
      state.renderedCount = items.length;
      updateSummary();
      syncLoadMoreButton();
      return;
    }

    const params = new URLSearchParams({
      offset: String(state.renderedCount),
      limit: String(BATCH_SIZE),
    });

    if (state.selectedCollectionType) {
      params.set("collectionType", state.selectedCollectionType);
    }
    params.set("sortOrder", state.selectedSortOrder);

    const payload = await fetchJson(`/api/items?${params.toString()}`);

    state.totalAvailable = payload.total;
    syncEmptyState();

    if (reset && !payload.items.length) {
      updateSummary();
      syncLoadMoreButton();
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const item of payload.items) {
      const groupKey = getCollectionGroupKey(item);

      if (groupKey !== state.lastRenderedGroupKey) {
        fragment.appendChild(buildGroupSeparator(item));
        state.lastRenderedGroupKey = groupKey;
      }

      fragment.appendChild(buildCard(item));
    }

    elements.items.appendChild(fragment);
    state.renderedCount += payload.items.length;

    updateSummary();
    syncLoadMoreButton();
    requestAnimationFrame(maybeFillViewport);
  } catch (error) {
    setStatus(`Nie udało się pobrać listy elementów: ${error.message}`, true);
    syncEmptyState();
  } finally {
    state.isRendering = false;
  }
}

async function refreshVisibleItems() {
  const cards = [...elements.items.querySelectorAll(".item-card[data-id]")];
  if (!cards.length) return;

  const ids = cards.map((card) => card.dataset.id).filter(Boolean);
  const payload = await fetchJson(`/api/items-by-ids?ids=${ids.join(",")}`);
  const map = new Map(payload.items.map((item) => [String(item.id), item]));

  for (const card of cards) {
    const item = map.get(card.dataset.id);
    if (item) {
      applyItemToCard(card, item);
    }
  }
}

async function refreshStatus() {
  try {
    const payload = await fetchJson("/api/status");
    elements.repoStats.textContent =
      `${formatNumber(payload.totalImages)} obrazów PNG, ${formatNumber(payload.cachedItemsCount)} JSON, zakres ID ${formatNumber(payload.minId)} -> ${formatNumber(payload.maxId)}.`;

    elements.scanState.textContent = "Katalog statyczny";
    elements.scanRange.textContent = `${formatNumber(payload.minId)} - ${formatNumber(payload.maxId)}`;
    elements.scanProgress.textContent =
      `${formatNumber(payload.cachedItemsCount)} / ${formatNumber(payload.totalItems)} rekordów z metadanymi`;
    elements.scanNextRun.textContent = payload.generatedAt ? formatDate(payload.generatedAt) : "—";

    populateCollectionTypes(payload.availableCollectionTypes);
    updateResultsHint();

    setStatus("Katalog statyczny gotowy. Strona działa bez backendu i nadaje się do hostowania na GitHub Pages.");
  } catch (error) {
    setStatus(`Nie udało się pobrać katalogu: ${error.message}`, true);
    elements.scanState.textContent = "Brak danych";
    elements.scanRange.textContent = "—";
    elements.scanProgress.textContent = "—";
    elements.scanNextRun.textContent = "—";
    elements.repoStats.textContent = "Nie udało się wczytać statycznego katalogu.";
  }
}

function applyFilter(rawQuery) {
  state.searchQuery = normalizeIdQuery(rawQuery);
  elements.search.value = state.searchQuery;
  updateResultsHint();
  renderNextBatch(true);
}

function wireEvents() {
  elements.search.addEventListener("input", (event) => {
    const normalized = normalizeIdQuery(event.target.value);
    if (event.target.value !== normalized) {
      event.target.value = normalized;
    }

    if (!normalized) {
      applyFilter("");
    }
  });

  elements.search.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    applyFilter(event.currentTarget.value);
  });

  elements.showId.addEventListener("click", () => {
    if (!normalizeIdQuery(elements.search.value)) {
      elements.search.focus();
      return;
    }

    applyFilter(elements.search.value);
  });

  elements.collectionType.addEventListener("change", (event) => {
    state.selectedCollectionType = event.target.value;
    updateResultsHint();
    renderNextBatch(true);
  });

  elements.sortOrder.addEventListener("change", (event) => {
    state.selectedSortOrder = event.target.value === "asc" ? "asc" : "desc";
    updateResultsHint();
    renderNextBatch(true);
  });

  elements.clearSearch.addEventListener("click", () => {
    elements.search.value = "";
    elements.collectionType.value = "";
    elements.sortOrder.value = "desc";
    state.selectedCollectionType = "";
    state.selectedSortOrder = "desc";
    applyFilter("");
    elements.search.focus();
  });

  elements.loadMore.addEventListener("click", () => {
    renderNextBatch();
  });

  elements.imageModal.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.dataset.closeModal === "true") {
      closeImageModal();
    }
  });

  elements.imageModalClose.addEventListener("click", () => {
    closeImageModal();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && elements.imageModal.classList.contains("is-open")) {
      closeImageModal();
    }
  });

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          renderNextBatch();
        }
      },
      { rootMargin: "900px 0px" }
    );

    observer.observe(elements.sentinel);
  }
}

async function bootstrap() {
  if (window.location.protocol === "file:") {
    const help = getConnectionHelp();
    setStatus(help, true);
    elements.scanState.textContent = "Tryb pliku";
    elements.scanRange.textContent = "—";
    elements.scanProgress.textContent = "—";
    elements.scanNextRun.textContent = "—";
    elements.repoStats.textContent = "Otwórz aplikację przez GitHub Pages albo lokalny serwer HTTP.";
    elements.resultsLabel.textContent = "Katalog statyczny nie może zostać wczytany z file://.";
    elements.emptyState.classList.remove("hidden");
    return;
  }

  wireEvents();
  await refreshStatus();
  await renderNextBatch(true);
}

bootstrap().catch((error) => {
  setStatus(`Nie udało się uruchomić strony: ${error.message}`, true);
});
