(async function () {

const OWNER="komimsp"
const REPO="msp2_json_ids"
const REF="79a698417ec7da9321a11744f91f315449e4b1c9"

const SHOPS=[6,1,2,3,4,5,7,8,9,11,12,13]

function sleep(ms){return new Promise(r=>setTimeout(r,ms))}

function getItemURL(id){
const start=Math.floor(id/1000)*1000
const end=start+999
return `https://raw.githubusercontent.com/${OWNER}/${REPO}/${REF}/ids/${start}-${end}/${id}.json`
}

async function getItem(id){
const res=await fetch(getItemURL(id))
if(!res.ok)return null
return res.json()
}

function extractTags(item){

const tags=[]

for(const t of item.tags||[]){
if(t.id)tags.push(t.id)
}

return tags
}

function buildURL(tags,shop,page=1){

const url=new URL(`https://eu.mspapis.com/shopinventory/v1/shops/${shop}/listings`)
url.searchParams.set("page",page)
url.searchParams.set("pageSize",100)

tags.forEach(t=>url.searchParams.append("tag",t))

return url.toString()
}

async function findPrice(id,item){

const tags=extractTags(item)

for(const shop of SHOPS){

for(let p=1;p<=3;p++){

const url=buildURL(tags,shop,p)

try{

const res=await fetch(url)
if(!res.ok)continue

const data=await res.json()

const match=data.find(x=>String(x.id)===String(id))

if(match){

return{
price:match.salesPrice,
currency:match.currency
}

}

}catch(e){}

}

}

return null
}

function createBadge(text,type){

const el=document.createElement("span")
el.className="price-badge"

if(type==="DIA")el.classList.add("dia")
else el.classList.add("sc")

el.textContent=text

return el
}

function injectCSS(){

if(document.getElementById("price-css"))return

const s=document.createElement("style")

s.id="price-css"

s.innerHTML=`
.price-badge{
margin-left:6px;
padding:2px 10px;
border-radius:10px;
font-weight:700;
font-size:12px;
color:#fff;
background:#ffbf00;
}

.price-badge.dia{
background:#4ea7ff;
}
`

document.head.appendChild(s)

}

injectCSS()

async function processCard(card){

const badge=card.querySelector(".item-badge")
if(!badge)return

const id=badge.textContent.replace(/\D/g,"")
if(!id)return

const row=card.querySelector(".tile-badge-row")
if(!row)return

const item=await getItem(id)
if(!item)return

const price=await findPrice(id,item)

if(!price)return

const label=price.currency==="Diamonds"
?`${price.price} DIA`
:`${price.price} SC`

row.appendChild(createBadge(label,price.currency==="Diamonds"?"DIA":"SC"))

}

async function run(){

const cards=[...document.querySelectorAll(".item-card")]

for(const c of cards){

processCard(c)

await sleep(100)

}

}

setTimeout(run,2000)

})()
