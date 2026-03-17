require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");
const crypto  = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const STORE         = process.env.SHOPIFY_STORE;
const APP_URL       = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
const PORT          = process.env.PORT || 3000;
const VELOCITY_DAYS = parseInt(process.env.VELOCITY_DAYS || "90", 10);
const DB_PATH       = path.join(__dirname, "db.json");
const SCOPES        = "read_products,read_orders,read_inventory";

// ── DB ────────────────────────────────────────────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const init = {
      accessToken: null,
      suppliers: [
        { id:1, name:"Fujian Mills",      leadDays:45, safetyDays:14, moq:50,  currency:"CNY" },
        { id:2, name:"Guangzhou Partner", leadDays:30, safetyDays:10, moq:100, currency:"CNY" }
      ],
      skuSettings: {},
      purchaseOrders: [],
      settings: { velocityDays: VELOCITY_DAYS, forecastMethod: "average" }
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}
function saveDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
function getToken() { return loadDB().accessToken; }

// ── OAuth ─────────────────────────────────────────────────────────────────────
const stateStore = new Map();

app.get("/auth", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  stateStore.set(state, Date.now());
  const redirectUri = `${APP_URL}/auth/callback`;
  const authUrl = `https://${STORE}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=${SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  res.redirect(authUrl);
});

app.get("/auth/callback", async (req, res) => {
  const { code, state, hmac, shop } = req.query;
  if (!stateStore.has(state)) return res.status(403).send("Invalid state");
  stateStore.delete(state);

  // Exchange code for token
  try {
    const r = await fetch(`https://${STORE}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code })
    });
    const data = await r.json();
    if (!data.access_token) return res.status(400).send(`Token error: ${JSON.stringify(data)}`);
    const db = loadDB();
    db.accessToken = data.access_token;
    saveDB(db);
    res.redirect("/");
  } catch(e) {
    res.status(500).send(`OAuth error: ${e.message}`);
  }
});

// ── Shopify API ───────────────────────────────────────────────────────────────
async function shopifyGet(url) {
  const token = getToken();
  if (!token) throw new Error("NO_TOKEN");
  const res = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
  if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);
  return { data: await res.json(), linkHeader: res.headers.get("Link") || "" };
}

async function paginatedGet(endpoint, key) {
  const BASE = `https://${STORE}/admin/api/2024-01`;
  let items = [], url = `${BASE}${endpoint}`;
  while (url) {
    const { data, linkHeader } = await shopifyGet(url);
    items = items.concat(data[key] || []);
    const next = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return items;
}

async function fetchOrders(days) {
  const since = new Date(); since.setDate(since.getDate() - days);
  return paginatedGet(`/orders.json?limit=250&status=any&created_at_min=${since.toISOString()}&fields=id,created_at,line_items`, "orders");
}
async function fetchProducts() {
  return paginatedGet("/products.json?limit=250&fields=id,title,vendor,variants", "products");
}

function calcVelocity(orders, days) {
  const totals = {};
  for (const o of orders) for (const i of o.line_items||[]) totals[String(i.variant_id)] = (totals[String(i.variant_id)]||0) + i.quantity;
  const v = {};
  for (const [id, qty] of Object.entries(totals)) v[id] = Math.round(qty/days*1000)/1000;
  return v;
}

async function buildInventory(db) {
  const { suppliers, skuSettings, purchaseOrders, settings } = db;
  const days = settings.velocityDays || VELOCITY_DAYS;
  const [products, orders] = await Promise.all([fetchProducts(), fetchOrders(days)]);
  const velocity = calcVelocity(orders, days);
  const inTransit = {};
  for (const po of purchaseOrders.filter(p=>p.status==="ordered")) for (const i of po.items||[]) inTransit[i.sku]=(inTransit[i.sku]||0)+i.qty;

  const skus = [];
  for (const p of products) {
    for (const v of p.variants||[]) {
      if (!v.sku) continue;
      const vid = String(v.id);
      const sup = suppliers.find(s=>s.name===p.vendor)||suppliers[0]||{leadDays:30,safetyDays:7,moq:1};
      const cfg = skuSettings[v.sku]||{};
      const avgDaily = velocity[vid]||0;
      const stock = v.inventory_quantity||0;
      const transit = inTransit[v.sku]||0;
      const available = stock+transit;
      const daysLeft = avgDaily>0?available/avgDaily:9999;
      const reorderAt = Math.round(avgDaily*(sup.leadDays+sup.safetyDays));
      const stockClass = cfg.stockClass||"A";
      const moq = cfg.moq||sup.moq||1;
      const suggestQty = stockClass==="B"?0:Math.max(moq,Math.ceil(avgDaily*(sup.leadDays*2+sup.safetyDays)-available));
      const status = stockClass==="B"?"b-stock":daysLeft<=sup.leadDays?"critical":daysLeft<=sup.leadDays+sup.safetyDays?"warning":"ok";
      skus.push({id:vid,sku:v.sku,name:p.title,variant:v.title,supplier:p.vendor||"Onbekend",stock,transit,available,avgDaily,unitsSold:Math.round(avgDaily*days),daysLeft:Math.min(daysLeft,9999),reorderAt,suggestQty,status,stockClass,costPrice:cfg.costPrice||0,moq,notes:cfg.notes||"",tags:cfg.tags||[]});
    }
  }
  return { skus, meta:{ ordersAnalyzed:orders.length, velocityDays:days, fetchedAt:new Date().toISOString(), totalSkus:skus.length, critical:skus.filter(s=>s.status==="critical").length, warning:skus.filter(s=>s.status==="warning").length } };
}

// ── Auth check middleware ──────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!getToken()) return res.status(401).json({ error: "NO_TOKEN", authUrl: "/auth" });
  next();
}

// ── API routes ────────────────────────────────────────────────────────────────
app.get("/api/status", (req, res) => res.json({ connected: !!getToken(), store: STORE }));
app.get("/api/inventory",     requireAuth, async(req,res)=>{ try{res.json(await buildInventory(loadDB()));}catch(e){res.status(500).json({error:e.message});} });
app.get("/api/replenishment", requireAuth, async(req,res)=>{ try{const{skus}=await buildInventory(loadDB());res.json(skus.filter(s=>s.status==="critical"||s.status==="warning"));}catch(e){res.status(500).json({error:e.message});} });
app.get("/api/analytics",     requireAuth, async(req,res)=>{ try{
  const{skus,meta}=await buildInventory(loadDB());
  const totalValue=skus.reduce((s,k)=>s+k.stock*k.costPrice,0);
  const overstockValue=skus.filter(s=>s.daysLeft>120).reduce((s,k)=>s+k.stock*k.costPrice,0);
  const bySupplier={};for(const s of skus){if(!bySupplier[s.supplier])bySupplier[s.supplier]={skus:0,value:0,units:0};bySupplier[s.supplier].skus++;bySupplier[s.supplier].value+=s.stock*s.costPrice;bySupplier[s.supplier].units+=s.stock;}
  const topSellers=[...skus].sort((a,b)=>b.avgDaily-a.avgDaily).slice(0,10).map(s=>({sku:s.sku,name:s.name,variant:s.variant,avgDaily:s.avgDaily,unitsSold:s.unitsSold}));
  const overstock=skus.filter(s=>s.daysLeft>120&&s.stock>0).map(s=>({sku:s.sku,name:s.name,variant:s.variant,stock:s.stock,daysLeft:Math.round(s.daysLeft),value:s.stock*s.costPrice}));
  res.json({...meta,totalValue,overstockValue,bySupplier,topSellers,overstock,aStock:skus.filter(s=>s.stockClass==="A").length,bStock:skus.filter(s=>s.stockClass==="B").length,deadSkus:skus.filter(s=>s.avgDaily===0&&s.stock>0).length});
}catch(e){res.status(500).json({error:e.message});}});

app.get("/api/suppliers",        (req,res)=>res.json(loadDB().suppliers));
app.post("/api/suppliers",       (req,res)=>{const db=loadDB();const s={...req.body,id:Date.now()};db.suppliers.push(s);saveDB(db);res.json(s);});
app.put("/api/suppliers/:id",    (req,res)=>{const db=loadDB();db.suppliers=db.suppliers.map(s=>s.id==req.params.id?{...s,...req.body}:s);saveDB(db);res.json({ok:true});});
app.delete("/api/suppliers/:id", (req,res)=>{const db=loadDB();db.suppliers=db.suppliers.filter(s=>s.id!=req.params.id);saveDB(db);res.json({ok:true});});
app.post("/api/sku-settings/:sku",(req,res)=>{const db=loadDB();db.skuSettings[req.params.sku]={...(db.skuSettings[req.params.sku]||{}),...req.body};saveDB(db);res.json({ok:true});});
app.get("/api/purchase-orders",        (req,res)=>res.json(loadDB().purchaseOrders));
app.post("/api/purchase-orders",       (req,res)=>{const db=loadDB();const po={id:`PO-${Date.now()}`,createdAt:new Date().toISOString(),status:"draft",...req.body};db.purchaseOrders.push(po);saveDB(db);res.json(po);});
app.put("/api/purchase-orders/:id",    (req,res)=>{const db=loadDB();db.purchaseOrders=db.purchaseOrders.map(p=>p.id===req.params.id?{...p,...req.body}:p);saveDB(db);res.json({ok:true});});
app.delete("/api/purchase-orders/:id", (req,res)=>{const db=loadDB();db.purchaseOrders=db.purchaseOrders.filter(p=>p.id!==req.params.id);saveDB(db);res.json({ok:true});});
app.get("/api/settings",  (req,res)=>res.json(loadDB().settings));
app.post("/api/settings", (req,res)=>{const db=loadDB();db.settings={...db.settings,...req.body};saveDB(db);res.json(db.settings);});

// ── Serve frontend ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`\nAntheiafit Inventory → http://localhost:${PORT}\nConnect Shopify: http://localhost:${PORT}/auth\n`));
