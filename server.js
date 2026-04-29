const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function loadLocalEnv() {
  if (!fs.existsSync(".env")) {
    return;
  }

  const env = fs.readFileSync(".env", "utf8");

  for (const line of env.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadLocalEnv();

const PORT = Number(process.env.PORT || 3000);
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;
const BINANCE_FUTURES_BASE_URL =
  process.env.BINANCE_FUTURES_BASE_URL || "https://fapi.binance.com";
const BINANCE_PORTFOLIO_BASE_URL =
  process.env.BINANCE_PORTFOLIO_BASE_URL || "https://papi.binance.com";
const BINANCE_FUTURES_PRICE_URL =
  `${BINANCE_FUTURES_BASE_URL}/fapi/v1/ticker/price?symbol=BTCUSDT`;
const SYMBOL = "BTCUSDT";

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

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(content);
  });
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

function getUtcDayStartTime() {
  const now = new Date();
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
}

async function getBtcUsdtMarketStats() {
  const utcDayStartTime = getUtcDayStartTime();
  const [price, klinesResponse, premiumResponse] = await Promise.all([
    getBtcUsdtFuturesPrice(),
    fetch(
      `${BINANCE_FUTURES_BASE_URL}/fapi/v1/klines?symbol=${SYMBOL}&interval=1d&startTime=${utcDayStartTime}&limit=1`,
      { headers: { Accept: "application/json" } },
    ),
    fetch(`${BINANCE_FUTURES_BASE_URL}/fapi/v1/premiumIndex?symbol=${SYMBOL}`, {
      headers: { Accept: "application/json" },
    }),
  ]);

  if (!klinesResponse.ok) {
    throw new Error(`Binance klines returned ${klinesResponse.status}`);
  }

  if (!premiumResponse.ok) {
    throw new Error(`Binance funding returned ${premiumResponse.status}`);
  }

  const klines = await klinesResponse.json();
  const premium = await premiumResponse.json();
  const dayOpenPrice = Number(klines[0]?.[1]);
  const currentPrice = Number(price.price);
  const lastFundingRate = Number(premium.lastFundingRate);

  return {
    ...price,
    utcDayOpenPrice: dayOpenPrice,
    utcDayChangePercent:
      dayOpenPrice > 0
        ? ((currentPrice - dayOpenPrice) / dayOpenPrice) * 100
        : null,
    fundingRate: premium.lastFundingRate,
    fundingAnnualizedPercent: Number.isFinite(lastFundingRate)
      ? lastFundingRate * 3 * 365 * 100
      : null,
    nextFundingTime: premium.nextFundingTime,
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

async function signedBinanceRequest(baseUrl, path, params = {}) {
  const apiKey = BINANCE_API_KEY;
  const apiSecret = BINANCE_API_SECRET;

  assertBinanceCredentials(apiKey, apiSecret);

  const searchParams = new URLSearchParams({
    ...params,
    recvWindow: params.recvWindow || "5000",
    timestamp: Date.now().toString(),
  });
  const queryString = searchParams.toString();
  const signature = signQuery(queryString, apiSecret);
  const url = `${baseUrl}${path}?${queryString}&signature=${signature}`;

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
    totalWalletBalance: balance.totalWalletBalance,
    availableBalance: balance.availableBalance,
    crossWalletBalance: balance.crossWalletBalance,
    crossUnPnl: balance.crossUnPnl,
    crossMarginAsset: balance.crossMarginAsset,
    crossMarginFree: balance.crossMarginFree,
    umWalletBalance: balance.umWalletBalance,
    umUnrealizedPNL: balance.umUnrealizedPNL,
    cmWalletBalance: balance.cmWalletBalance,
    cmUnrealizedPNL: balance.cmUnrealizedPNL,
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
    marginAsset: position.marginAsset || "USDT",
    breakEvenPrice: position.breakEvenPrice,
    leverage: position.leverage,
    updateTime: position.updateTime,
  };
}

async function getBinanceAccountInfo(symbol) {
  const balanceParams = symbol ? { asset: "USDT" } : {};
  const [balanceResponse, positions] = await Promise.all([
    signedBinanceRequest(
      BINANCE_PORTFOLIO_BASE_URL,
      "/papi/v1/balance",
      balanceParams,
    ),
    signedBinanceRequest(
      BINANCE_PORTFOLIO_BASE_URL,
      "/papi/v1/um/positionRisk",
      symbol ? { symbol } : {},
    ),
  ]);
  const balances = Array.isArray(balanceResponse)
    ? balanceResponse
    : [balanceResponse];

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

  if (req.method === "GET" && url.pathname === "/") {
    sendFile(
      res,
      path.join(__dirname, "index.html"),
      "text/html; charset=utf-8",
    );
    return;
  }

  if (req.method === "GET" && url.pathname === "/styles.css") {
    sendFile(
      res,
      path.join(__dirname, "styles.css"),
      "text/css; charset=utf-8",
    );
    return;
  }

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

  if (req.method === "GET" && url.pathname === "/api/market/btcusdt") {
    try {
      const marketStats = await getBtcUsdtMarketStats();
      sendJson(res, 200, marketStats);
    } catch (error) {
      sendJson(res, 502, {
        error: "failed_to_fetch_binance_market_stats",
        message: error.message,
      });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/binance/account") {
    try {
      const symbol = url.searchParams.get("symbol");
      const accountInfo = await getBinanceAccountInfo(
        symbol ? symbol.toUpperCase() : undefined,
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
