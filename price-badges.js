(async () => {
  const PRICE_URL =
    "https://raw.githubusercontent.com/komimsp/msp2_json_ids/main/prices/id_cena.json";

  const prices = await fetch(PRICE_URL).then((r) => r.json());

  function addPrice(card) {
    const idEl =
      card.querySelector(".meta-id") ||
      card.querySelector(".item-badge");

    if (!idEl) return;

    const id = idEl.textContent.match(/\d+/)?.[0];
    if (!id) return;

    const data = prices[id];
    if (!data) return;

    const row = card.querySelector(".tile-badge-row");
    if (!row) return;

    let badge = row.querySelector(".price-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "price-badge";
      row.appendChild(badge);
    }

    const price = data.price ?? data.salesPrice ?? data.salesPriceRaw ?? null;
    const currency = data.currency ?? "";

    if (price == null) {
      badge.textContent = "Brak ceny";
      return;
    }

    badge.textContent = `${price} ${currency}`.trim();
  }

  function scan() {
    document.querySelectorAll(".item-card").forEach(addPrice);
  }

  scan();

  const observer = new MutationObserver(scan);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
})();
