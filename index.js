import WebSocket from "ws";
import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// --------------------
// Shared in-memory state (always "latest")
// --------------------
const state = {
  timestamp: null, // current 5m bucket
  liveBtcPriceUsd: null, // from websocket
  targetPriceUsd: null, // from Vatic
  lastTargetFetchTs: null,
  lastTargetFetchAt: 0,
  wsConnected: false,
  wsLastMessageAt: 0,
};

// --------------------
// Websocket runs in background continuously
// --------------------
function startPolymarketChainlinkStream() {
  const ws = new WebSocket("wss://ws-live-data.polymarket.com");

  ws.on("open", () => {
    state.wsConnected = true;
    ws.send(
      JSON.stringify({
        action: "subscribe",
        subscriptions: [
          {
            topic: "crypto_prices_chainlink",
            type: "*",
            filters: JSON.stringify({ symbol: "btc/usd" }),
          },
        ],
      })
    );
  });

  ws.on("message", (msg) => {
    state.wsLastMessageAt = Date.now();
    try {
      const data = JSON.parse(msg.toString());
      if (data.topic !== "crypto_prices_chainlink") return;
      if (!data.payload) return;
      if (data.payload.symbol !== "btc/usd") return;

      const v = Number(data.payload.value);
      if (!Number.isFinite(v)) return;

      state.liveBtcPriceUsd = v; // update instantly
    } catch {
      // ignore parse errors
    }
  });

  ws.on("close", () => {
    state.wsConnected = false;
    setTimeout(startPolymarketChainlinkStream, 3000);
  });

  ws.on("error", () => {
    state.wsConnected = false;
    try {
      ws.close();
    } catch {}
  });
}

// --------------------
// Vatic target updater runs in background too
// (so API requests return immediately)
// --------------------
function getCurrent5mTimestamp() {
  const nowSec = Math.floor(Date.now() / 1000);
  const fiveMin = 5 * 60;
  return Math.floor(nowSec / fiveMin) * fiveMin;
}

async function fetchTargetPriceByTimestamp(ts) {
  const url = `https://api.vatic.trading/api/v1/targets/timestamp?asset=btc&type=5min&timestamp=${ts}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  return json.target_price ?? json.target ?? json.price ?? null;
}

async function startVaticBackgroundLoop() {
  while (true) {
    const ts = getCurrent5mTimestamp();
    state.timestamp = ts;

    // only fetch when we enter a new 5m bucket
    if (state.lastTargetFetchTs !== ts) {
      try {
        const target = await fetchTargetPriceByTimestamp(ts);
        state.targetPriceUsd = target;
        state.lastTargetFetchTs = ts;
        state.lastTargetFetchAt = Date.now();
      } catch {
        // keep previous targetPriceUsd if fetch fails
      }
    }

    // keep loop tight but not busy
    await new Promise((r) => setTimeout(r, 250));
  }
}

// --------------------
// API returns latest cached values immediately (no await)
// --------------------
app.get("/api/btc-5m", (req, res) => {
  // ensure timestamp is always up-to-date even if loop hasn't ticked yet
  const ts = getCurrent5mTimestamp();
  state.timestamp = ts;

  res.json({
    timestamp: state.timestamp,
    liveBtcPriceUsd: state.liveBtcPriceUsd,
    targetPriceUsd: state.targetPriceUsd,
  });
});

app.get("/health", (req, res) =>
  res.json({
    ok: true,
    wsConnected: state.wsConnected,
    wsLastMessageAt: state.wsLastMessageAt
      ? new Date(state.wsLastMessageAt).toISOString()
      : null,
    lastTargetFetchTs: state.lastTargetFetchTs,
    lastTargetFetchAt: state.lastTargetFetchAt
      ? new Date(state.lastTargetFetchAt).toISOString()
      : null,
  })
);

// start background workers
startPolymarketChainlinkStream();
startVaticBackgroundLoop().catch((e) => {
  console.error("Vatic loop fatal:", e);
  process.exit(1);
});

app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
});
