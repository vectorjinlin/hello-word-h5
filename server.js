const http = require("node:http");

const PORT = Number(process.env.PORT || 3000);
const BINANCE_FUTURES_PRICE_URL =
  "https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT";

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);

  res.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function getBtcUsdtFuturesPrice() {
  const response = await fetch(BINANCE_FUTURES_PRICE_URL, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Binance returned ${response.status}`);
  }

  const data = await response.json();

  return {
    symbol: data.symbol,
    price: Number(data.price),
    rawPrice: data.price,
    source: "binance_usdt_futures",
    fetchedAt: new Date().toISOString(),
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/price/btcusdt") {
    try {
      const price = await getBtcUsdtFuturesPrice();
      sendJson(res, 200, price);
    } catch (error) {
      sendJson(res, 502, {
        error: "failed_to_fetch_binance_price",
        message: error.message,
      });
    }
    return;
  }

  sendJson(res, 404, { error: "not_found" });
});

server.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});
