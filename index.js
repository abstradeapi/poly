import WebSocket from "ws";
import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

// CORS (open by default; restrict with CORS_ORIGINS if you want)
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // allow curl/server-to-server
      if (ALLOWED_ORIGINS.length === 0) return cb(null, true); // allow all by default
      return cb(null, ALLOWED_ORIGINS.includes(origin));
    },
  })
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastBtcPrice = null;
let lastBtcPriceUpdatedAt = null;

function startPolymarketChainlinkStream() {
  const ws = new WebSocket("wss://ws-live-data.polymarket.com");

  ws.on("open", () => {
    const sub = {
      action: "subscribe",
      subscriptions: [
        {
          topic: "crypto_prices_chainlink",
          type: "*",
          filters: JSON.stringify({ symbol: "btc/usd" }),
        },
      ],
    };
    ws.send(JSON.stringify(sub));
  });

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.topic !== "crypto_prices_chainlink") return;
      if (!data.payload) return;
      if (data.payload.symbol !== "btc/usd") return;

      const value = Number(data.payload.value);
      if (!Number.isFinite(value)) return;

      lastBtcPrice = value;
      lastBtcPriceUpdatedAt = new Date().toISOString();
    } catch {
      // ignore parse errors
    }
  });

  ws.on("close", () => {
    setTimeout(startPolymarketChainlinkStream, 3000);
  });

  ws.on("error", () => {
    try {
      ws.close();
    } catch {}
  });
}

function getCurrent5mTimestamp() {
  const nowSec = Math.floor(Date.now() / 1000);
  const fiveMin = 5 * 60;
  return Math.floor(nowSec / fiveMin) * fiveMin;
}

async function fetchBtc5mByTimestamp(ts) {
  const url = `https://api.vatic.trading/api/v1/targets/timestamp?asset=btc&type=5min&timestamp=${ts}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

async function getLivePolymarketSlug() {
  const url =
    "https://gamma-api.polymarket.com/markets?tag_id=102892&closed=false&limit=500";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const events = await res.json();

  const btcMarkets = events
    .filter((e) => e.slug && e.slug.startsWith("btc-updown-5m-"))
    .sort((a, b) => new Date(a.eventStartTime) - new Date(b.eventStartTime));

  const now = new Date();

  for (let i = 0; i < btcMarkets.length - 1; i++) {
    const start = new Date(btcMarkets[i].eventStartTime);
    const nextStart = new Date(btcMarkets[i + 1].eventStartTime);
    if (start <= now && now < nextStart) {
      return btcMarkets[i].slug;
    }
  }

  if (btcMarkets.length > 0) {
    const last = btcMarkets[btcMarkets.length - 1];
    const lastStart = new Date(last.eventStartTime);
    if (lastStart <= now) return last.slug;
  }

  return null;
}

async function getMarketDetailsBySlug(slug) {
  const url = `https://gamma-api.polymarket.com/markets/slug/${slug}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (typeof data.clobTokenIds === "string") {
    data.clobTokenIds = JSON.parse(data.clobTokenIds);
  }
  return data;
}

async function getPolymarketPrice(tokenId, side = "BUY") {
  const url = `https://clob.polymarket.com/price?token_id=${tokenId}&side=${side}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.price;
    if (raw == null) return null;
    return parseFloat(raw);
  } catch {
    return null;
  }
}

// ---- caching (so your API isn't hammering external endpoints per request)
let tokenIdYes = null;
let tokenIdNo = null;
let currentSlug = null;
let lastSlugFetchTs = 0;

let vaticData = null;
let targetPrice = null;
let lastVaticTs = null;

// background updater (optional but recommended)
async function backgroundLoop() {
  while (true) {
    const ts = getCurrent5mTimestamp();

    // update Vatic once per 5m bucket
    if (ts !== lastVaticTs) {
      try {
        vaticData = await fetchBtc5mByTimestamp(ts);
        targetPrice =
          vaticData.target_price ?? vaticData.target ?? vaticData.price ?? null;
        lastVaticTs = ts;
      } catch {
        // keep previous cache
      }
    }

    // update slug/token ids every 30s
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec - lastSlugFetchTs > 30) {
      try {
        const slug = await getLivePolymarketSlug();
        if (slug && slug !== currentSlug) {
          currentSlug = slug;
          const market = await getMarketDetailsBySlug(slug);
          const ids = market.clobTokenIds;
          tokenIdYes = ids?.[0] ?? null;
          tokenIdNo = ids?.[1] ?? null;
        }
        lastSlugFetchTs = nowSec;
      } catch {
        lastSlugFetchTs = nowSec;
      }
    }

    await sleep(1000);
  }
}

// API endpoint
app.get("/api/btc-5m", async (req, res) => {
  const ts = getCurrent5mTimestamp();
  const tsIso = new Date(ts * 1000).toISOString();

  let yesBuy = null;
  let noBuy = null;

  if (tokenIdYes && tokenIdNo) {
    [yesBuy, noBuy] = await Promise.all([
      getPolymarketPrice(tokenIdYes, "BUY"),
      getPolymarketPrice(tokenIdNo, "BUY"),
    ]);
  }

  res.json({
    timestamp: ts,
    timestampIso: tsIso,
    vaticAsset: "BTC",
    slug: currentSlug,
    targetPrice5mUsd: targetPrice,
    liveBtcPriceUsd: lastBtcPrice,
    yes: yesBuy,
    no: noBuy,
    meta: {
      liveBtcPriceUpdatedAt: lastBtcPriceUpdatedAt,
      tokenIds: { yes: tokenIdYes, no: tokenIdNo },
    },
  });
});

app.get("/health", (req, res) => res.json({ ok: true }));

// start
startPolymarketChainlinkStream();
backgroundLoop().catch((e) => console.error("backgroundLoop fatal:", e));

app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
