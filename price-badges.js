(async () => {

const PRICE_URL =
"https://raw.githubusercontent.com/komimsp/msp2_json_ids/main/prices/id_cena.json"

const prices = await fetch(PRICE_URL).then(r=>r.json())

function addPrice(card){

 const idEl =
 card.querySelector(".meta-id") ||
 card.querySelector(".item-badge")

 if(!idEl) return

 const id = idEl.textContent.match(/\d+/)?.[0]

 if(!id) return

 const data = prices[id]

 if(!data) return

 const badge = document.createElement("span")

 badge.className = "price-badge"

 badge.textContent =
 `${data.price} ${data.currency}`

 const row = card.querySelector(".tile-badge-row")

 if(row) row.appendChild(badge)

}

function scan(){

 document
 .querySelectorAll(".item-card")
 .forEach(addPrice)

}

scan()

const observer = new MutationObserver(scan)

observer.observe(document.body,{
 childList:true,
 subtree:true
})

})()
