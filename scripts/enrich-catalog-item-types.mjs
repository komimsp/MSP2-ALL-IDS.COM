import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const catalogPath = path.join(repoRoot, "data", "catalog.json");
const jsonRepoRoot =
  process.env.MSP2_JSON_IDS_DIR || path.resolve(repoRoot, "..", "msp2_json_ids", "ids");

const SPECIAL_TYPE_LABELS = {
  tag_beauty: "TAG_BEAUTY",
  tag_clothes: "tag_clothes",
};

function getJsonBucketName(id) {
  const numericId = Number(id);
  const start = Math.floor(numericId / 1000) * 1000;
  const end = start + 999;
  return `${start}-${end}`;
}

function getItemTypeTokens(rawValue) {
  return [...new Set(
    String(rawValue || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  )];
}

function hasTagClothes(tags) {
  return tags.some((tag) =>
    String(tag?.type || "").toLowerCase() === "category.clothes" &&
    String(tag?.lookUpId || "").toLowerCase() === "tag_clothes"
  );
}

function hasTagBeauty(tags) {
  return tags.some((tag) => {
    const resources = Array.isArray(tag?.resourceIdentifiers) ? tag.resourceIdentifiers : [];
    const firstResource = resources[0] || null;
    return (
      String(tag?.type || "").toLowerCase() === "category.clothes" &&
      String(tag?.lookUpId || "").toLowerCase() === "tag_beauty" &&
      String(firstResource?.key || "").toUpperCase() === "TAG_BEAUTY" &&
      String(firstResource?.type || "").toLowerCase() === "label"
    );
  });
}

function buildFilterTypes(rawJson, fallbackItemType) {
  const filterTypes = new Set(
    getItemTypeTokens(rawJson?.additionalData?.MSP2Data?.Type || fallbackItemType)
  );
  const tags = Array.isArray(rawJson?.tags) ? rawJson.tags : [];

  if (hasTagClothes(tags)) {
    filterTypes.add("tag_clothes");
  }

  if (hasTagBeauty(tags)) {
    filterTypes.add("tag_beauty");
  }

  return [...filterTypes];
}

function buildAvailableItemTypes(items) {
  const counts = new Map();

  for (const item of items) {
    const filterTypes = Array.isArray(item?.metadata?.filterTypes) ? item.metadata.filterTypes : [];
    for (const filterType of filterTypes) {
      const normalizedType = String(filterType || "").trim().toLowerCase();
      if (!normalizedType) continue;
      counts.set(normalizedType, (counts.get(normalizedType) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([type, count]) => ({
      type,
      label: SPECIAL_TYPE_LABELS[type] || type,
      count,
    }))
    .sort((left, right) =>
      (left.label || left.type).localeCompare(right.label || right.type, "pl", {
        sensitivity: "base",
      }) || right.count - left.count
    );
}

if (!fs.existsSync(catalogPath)) {
  throw new Error(`Brak pliku katalogu: ${catalogPath}`);
}

if (!fs.existsSync(jsonRepoRoot)) {
  throw new Error(`Brak repo JSON: ${jsonRepoRoot}`);
}

const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const items = Array.isArray(catalog?.items) ? catalog.items : [];

let resolvedJsonCount = 0;
let missingJsonCount = 0;

for (const item of items) {
  const id = String(item?.id || "").trim();
  const jsonPath = path.join(jsonRepoRoot, getJsonBucketName(id), `${id}.json`);

  let filterTypes = getItemTypeTokens(item?.metadata?.itemType);

  if (fs.existsSync(jsonPath)) {
    try {
      const rawJson = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      filterTypes = buildFilterTypes(rawJson, item?.metadata?.itemType);
      resolvedJsonCount += 1;
    } catch {
      missingJsonCount += 1;
    }
  } else {
    missingJsonCount += 1;
  }

  item.metadata = {
    ...(item.metadata || {}),
    filterTypes,
  };
}

catalog.availableItemTypes = buildAvailableItemTypes(items);

fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      catalogPath,
      jsonRepoRoot,
      items: items.length,
      resolvedJsonCount,
      missingJsonCount,
      availableItemTypes: catalog.availableItemTypes.length,
    },
    null,
    2
  )
);
