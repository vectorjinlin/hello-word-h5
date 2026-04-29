const http = require("node:http");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;
const BINANCE_FUTURES_BASE_URL =
  process.env.BINANCE_FUTURES_BASE_URL || "https://fapi.binance.com";
const BINANCE_FUTURES_PRICE_URL =
  `${BINANCE_FUTURES_BASE_URL}/fapi/v1/ticker/price?symbol=BTCUSDT`;

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);

  res.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Binance-API-Key, X-Binance-API-Secret",
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

function assertBinanceCredentials(apiKey, apiSecret) {
  if (!apiKey || !apiSecret) {
    const error = new Error(
      "Missing BINANCE_API_KEY or BINANCE_API_SECRET environment variable",
    );
    error.statusCode = 500;
    error.code = "missing_binance_credentials";
    throw error;
  }
}

function signQuery(queryString, apiSecret) {
  return crypto
    .createHmac("sha256", apiSecret)
    .update(queryString)
    .digest("hex");
}

async function signedBinanceRequest(path, params = {}, credentials = {}) {
  const apiKey = credentials.apiKey || BINANCE_API_KEY;
  const apiSecret = credentials.apiSecret || BINANCE_API_SECRET;

  assertBinanceCredentials(apiKey, apiSecret);

  const searchParams = new URLSearchParams({
    ...params,
    recvWindow: params.recvWindow || "5000",
    timestamp: Date.now().toString(),
  });
  const queryString = searchParams.toString();
  const signature = signQuery(queryString, apiSecret);
  const url = `${BINANCE_FUTURES_BASE_URL}${path}?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-MBX-APIKEY": apiKey,
    },
  });
  const data = await response.json();

  if (!response.ok) {
    const error = new Error(data.msg || `Binance returned ${response.status}`);
    error.statusCode = response.status;
    error.code = data.code || "binance_request_failed";
    throw error;
  }

  return data;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function mapBalance(balance) {
  return {
    asset: balance.asset,
    balance: balance.balance,
    availableBalance: balance.availableBalance,
    crossWalletBalance: balance.crossWalletBalance,
    crossUnPnl: balance.crossUnPnl,
    maxWithdrawAmount: balance.maxWithdrawAmount,
    updateTime: balance.updateTime,
  };
}

function mapPosition(position) {
  return {
    symbol: position.symbol,
    positionSide: position.positionSide,
    entryPrice: position.entryPrice,
    positionAmt: position.positionAmt,
    liquidationPrice: position.liquidationPrice,
    pnl: position.unRealizedProfit,
    markPrice: position.markPrice,
    notional: position.notional,
    marginAsset: position.marginAsset,
    updateTime: position.updateTime,
  };
}

async function getBinanceAccountInfo(symbol, credentials) {
  const [balances, positions] = await Promise.all([
    signedBinanceRequest("/fapi/v3/balance", {}, credentials),
    signedBinanceRequest(
      "/fapi/v3/positionRisk",
      symbol ? { symbol } : {},
      credentials,
    ),
  ]);

  const activePositions = positions.filter(
    (position) => toNumber(position.positionAmt) !== 0,
  );

  return {
    balances: balances.map(mapBalance),
    positions: activePositions.map(mapPosition),
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

  if (req.method === "GET" && url.pathname === "/api/binance/account") {
    try {
      const symbol = url.searchParams.get("symbol");
      const credentials = {
        apiKey: req.headers["x-binance-api-key"],
        apiSecret: req.headers["x-binance-api-secret"],
      };
      const accountInfo = await getBinanceAccountInfo(
        symbol ? symbol.toUpperCase() : undefined,
        credentials,
      );
      sendJson(res, 200, accountInfo);
    } catch (error) {
      sendJson(res, error.statusCode || 502, {
        error: error.code || "failed_to_fetch_binance_account",
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
