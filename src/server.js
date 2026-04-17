require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");
const { buildSignature, generateNonce } = require("./signer");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const port = Number(process.env.PORT || 4050);
function resolveRiverpeBaseUrl(rawValue) {
  const fallback = "http://localhost:4000/api/v1";
  const candidate = String(rawValue || fallback).trim();
  const withoutTrailingSlash = candidate.replace(/\/+$/, "");

  if (/\/api\/v1$/i.test(withoutTrailingSlash)) {
    return withoutTrailingSlash;
  }

  return `${withoutTrailingSlash}/api/v1`;
}

const baseUrl = resolveRiverpeBaseUrl(process.env.RIVERPE_BASE_URL);
const merchantDashboardBaseUrl = process.env.MERCHANT_DASHBOARD_BASE_URL || "http://localhost:3000";
const apiKey = process.env.CLIENT_KEY_ID || process.env.MERCHANT_API_KEY || "";
const apiSecret = process.env.CLIENT_SECRET || process.env.MERCHANT_API_SECRET || "";
const useBackendEnvCredentials = String(process.env.USE_BACKEND_ENV_CREDENTIALS || "false").toLowerCase() === "true";
const includeGetDataInSignature = String(process.env.INCLUDE_GET_DATA_IN_SIGNATURE || "false").toLowerCase() === "true";
const verifyPspCallbackSignature = String(process.env.VERIFY_PSP_CALLBACK_SIGNATURE || "false").toLowerCase() === "true";

const lastOrders = {
  payment: null,
  payout: null,
};

const state = {
  payment: null,
  payout: null,
  notices: [],
  merchantCallbacks: [],
};

function generatePayoutOrderId() {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 10).toUpperCase();
  return `PO-${stamp}-${rand}`;
}

function assertConfig() {
  if (useBackendEnvCredentials) {
    return;
  }

  if (!apiKey || !apiSecret) {
    const error = new Error("Missing CLIENT_KEY_ID/CLIENT_SECRET (or legacy MERCHANT_API_KEY/MERCHANT_API_SECRET) in .env");
    error.status = 500;
    throw error;
  }
}

function buildSignedHeaders({ payload = {}, includePayloadInSign = true }) {
  if (useBackendEnvCredentials) {
    return {
      "Content-Type": "application/json",
    };
  }

  const requestApiKey = payload.clientKeyId || apiKey;
  const requestApiSecret = payload.clientSecret || apiSecret;
  const { clientKeyId, clientSecret, ...forwardPayload } = payload || {};
  const nonce = generateNonce();

  const signParams = includePayloadInSign
    ? { ...forwardPayload, parter: requestApiKey, nonce }
    : { parter: requestApiKey, nonce };

  const signature = buildSignature(signParams, requestApiSecret);

  return {
    "x-api-key": requestApiKey,
    "x-client-key-id": requestApiKey,
    "x-nonce": nonce,
    "x-signature": signature,
    "Content-Type": "application/json",
  };
}

async function callRiverpe(method, path, payload = {}, opts = {}) {
  assertConfig();

  const includePayloadInSign = opts.includePayloadInSign !== undefined
    ? opts.includePayloadInSign
    : method.toUpperCase() !== "GET";

  const headers = buildSignedHeaders({ payload, includePayloadInSign });
  const config = {
    method,
    url: `${baseUrl}${path}`,
    headers,
    validateStatus: () => true,
  };

  const { clientKeyId, clientSecret, ...forwardPayload } = payload || {};

  if (method.toUpperCase() === "GET") {
    if (opts.sendQuery) {
      config.params = forwardPayload;
    }
  } else {
    config.data = forwardPayload;
  }

  const response = await axios(config);

  return {
    request: {
      method,
      path,
      payload: forwardPayload,
      signIncludesPayload: includePayloadInSign,
    },
    status: response.status,
    data: response.data,
  };
}

function isHttpUrl(value) {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function sanitizeCreatePaymentPayload(payload = {}) {
  const next = { ...payload };

  ["notifyurl", "callbackurl", "ip", "remark"].forEach((key) => {
    if (typeof next[key] === "string" && next[key].trim() === "") {
      delete next[key];
    }
  });

  return next;
}

function buildCreatePaymentValidationHints(payload = {}) {
  const hints = [];

  const amount = Number(payload.value ?? payload.amount);
  if (!Number.isFinite(amount) || amount < 100 || amount > 50000) {
    hints.push("amount/value must be between 100 and 50000");
  }

  const method = String(payload.type ?? payload.method ?? "").trim();
  if (!method) {
    hints.push("type/method is required");
  }

  const orderId = String(payload.orderid ?? payload.order_id ?? "").trim();
  if (orderId && !/^[A-Za-z0-9_-]{1,128}$/.test(orderId)) {
    hints.push("orderid/order_id must be alphanumeric with _ or -");
  }

  const notifyUrl = String(payload.notifyurl ?? "").trim();
  if (notifyUrl && !isHttpUrl(notifyUrl)) {
    hints.push("notifyurl must be a valid http/https URL");
  }

  const callbackUrl = String(payload.callbackurl ?? "").trim();
  if (callbackUrl && !isHttpUrl(callbackUrl)) {
    hints.push("callbackurl must be a valid http/https URL");
  }

  return hints;
}

function mergeCallbackPayload(req) {
  return {
    ...(req.query || {}),
    ...(req.body || {}),
  };
}

function normalizePspNoticePayload(payload) {
  return {
    parter: String(payload.parter || payload.parties || payload.part || "").trim(),
    orderid: String(payload.orderid || payload.warrants || "").trim(),
    opstate: String(payload.opstate || payload.survive || "").trim(),
    ovalue: String(payload.ovalue || payload.value || "").trim(),
    remark: String(payload.remark || "").trim(),
    info: String(payload.info || "").trim(),
    sign: String(payload.sign || "").trim(),
  };
}

function normalizeMerchantCallbackPayload(payload) {
  return {
    orderId: String(payload.order_id || payload.orderId || payload.order_no || "").trim(),
    status: String(payload.status || payload.state || "").trim().toUpperCase(),
    amount: payload.amount !== undefined && payload.amount !== null && payload.amount !== ""
      ? Number(payload.amount)
      : null,
  };
}

function computePspCallbackSign(normalized, includeRemark) {
  const signInput = {
    opstate: normalized.opstate,
    orderid: normalized.orderid,
    ovalue: normalized.ovalue,
    parter: normalized.parter,
  };

  if (includeRemark && normalized.remark) {
    signInput.remark = normalized.remark;
  }

  const sortedKeys = Object.keys(signInput).sort();
  const signSource = sortedKeys
    .filter((key) => String(signInput[key]).length > 0)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(signInput[key]))}`)
    .join("&");

  return crypto.createHash("md5").update(`${decodeURIComponent(signSource)}&key=${apiSecret}`, "utf8").digest("hex");
}

function pushNotice(entry) {
  state.notices.unshift({
    ...entry,
    at: new Date().toISOString(),
  });
  state.notices = state.notices.slice(0, 25);
}

function pushMerchantCallback(entry) {
  state.merchantCallbacks.unshift({
    ...entry,
    at: new Date().toISOString(),
  });
  state.merchantCallbacks = state.merchantCallbacks.slice(0, 25);
}

function setOrderState(type, patch) {
  const current = type === "payout" ? state.payout : state.payment;
  const next = {
    ...(current || {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  if (type === "payout") {
    state.payout = next;
  } else {
    state.payment = next;
  }

  return next;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderDashboardPage() {
  const payment = escapeHtml(JSON.stringify(state.payment, null, 2));
  const payout = escapeHtml(JSON.stringify(state.payout, null, 2));
  const merchantCallbacks = escapeHtml(JSON.stringify(state.merchantCallbacks, null, 2));
  const notices = escapeHtml(JSON.stringify(state.notices, null, 2));

  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '    <title>Merchant Dashboard</title>',
    '    <style>',
    '      body { font-family: Segoe UI, Arial, sans-serif; margin: 0; background: #f4f6fb; color: #1f2937; }',
    '      .container { max-width: 1100px; margin: 0 auto; padding: 24px; }',
    '      .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }',
    '      .card { background: #fff; border: 1px solid #d1d5db; border-radius: 14px; padding: 16px; }',
    '      pre { background: #0b1020; color: #d1fae5; padding: 12px; border-radius: 10px; overflow: auto; }',
    '      h1, h2 { margin: 0 0 10px; }',
    '      p { color: #6b7280; }',
    '    </style>',
    '  </head>',
    '  <body>',
    '    <main class="container">',
    '      <h1>Merchant Dashboard</h1>',
    '      <p>Use /notify and /notify/payout for PSP notices. Use /callback and /callback/payout for Riverpe backend merchant callbacks.</p>',
    '      <div class="grid">',
    '        <section class="card">',
    '          <h2>Latest Pay-in</h2>',
    `          <pre>${payment}</pre>`,
    '        </section>',
    '        <section class="card">',
    '          <h2>Latest Payout</h2>',
    `          <pre>${payout}</pre>`,
    '        </section>',
    '        <section class="card">',
    '          <h2>Merchant Callback Log</h2>',
    `          <pre>${merchantCallbacks}</pre>`,
    '        </section>',
    '        <section class="card">',
    '          <h2>PSP Notice Log</h2>',
    `          <pre>${notices}</pre>`,
    '        </section>',
    '      </div>',
    '    </main>',
    '  </body>',
    '</html>',
  ].join('\n');
}

function handlePspNotice(label, route, req, res, options = {}) {
  const payload = mergeCallbackPayload(req);
  const normalized = normalizePspNoticePayload(payload);
  const shouldVerify = verifyPspCallbackSignature && !!apiSecret;
  const signValid = shouldVerify ? normalized.sign.toLowerCase() === computePspCallbackSign(normalized, Boolean(options.includeRemarkInSign)) : true;

  console.log(`\n=== ${label} ===`);
  console.log("Timestamp:", new Date().toISOString());
  console.log(`URL: ${req.method} ${route}`);
  console.log("Payload:", JSON.stringify(payload, null, 2));
  console.log("Normalized:", JSON.stringify(normalized, null, 2));
  console.log("Signature verification:", shouldVerify ? (signValid ? "valid" : "invalid") : "skipped");
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("============================================\n");

  pushNotice({ route, label, payload, normalized, signValid });

  const type = route.includes("payout") ? "payout" : "payment";
  setOrderState(type, {
    orderId: normalized.orderid || null,
    status: normalized.opstate === "1" ? "SUCCESS" : normalized.opstate === "2" ? "FAILED" : "PENDING",
    amount: normalized.ovalue ? Number(normalized.ovalue) : null,
    source: label,
    kind: "psp-notice",
  });

  if (shouldVerify && !signValid) {
    return res.type("text/plain").status(200).send("error");
  }

  return res.type("text/plain").send("success");
}

function handleMerchantCallback(label, route, req, res, type) {
  const payload = mergeCallbackPayload(req);
  const normalized = normalizeMerchantCallbackPayload(payload);

  console.log(`\n=== ${label} ===`);
  console.log("Timestamp:", new Date().toISOString());
  console.log(`URL: ${req.method} ${route}`);
  console.log("Payload:", JSON.stringify(payload, null, 2));
  console.log("============================================\n");

  pushMerchantCallback({ route, label, payload, normalized });
  setOrderState(type, {
    orderId: normalized.orderId || null,
    status: normalized.status || null,
    amount: normalized.amount,
    source: label,
    kind: "merchant-callback",
  });

  return res.type("text/plain").send("success");
}

function registerMethodRoutes(path, handler) {
  app.get(path, handler);
  app.post(path, handler);
}

function createApiState() {
  return {
    baseUrl,
    useBackendEnvCredentials,
    hasApiKey: Boolean(apiKey),
    hasApiSecret: Boolean(apiSecret),
    includeGetDataInSignature,
    verifyPspCallbackSignature,
    lastOrders: { ...lastOrders },
    state,
  };
}

app.get("/api/config", (_req, res) => {
  res.json(createApiState());
});

app.get("/api/state", (_req, res) => {
  res.json(state);
});

app.post("/api/test/create-payment", async (req, res, next) => {
  try {
    const payload = sanitizeCreatePaymentPayload(req.body);
    const result = await callRiverpe("POST", "/merchant/payments", payload);

    if (
      result.status === 400 &&
      result?.data?.error?.code === "VALIDATION_ERROR" &&
      !result?.data?.error?.details
    ) {
      const hints = buildCreatePaymentValidationHints(payload);
      if (hints.length > 0) {
        result.data.error.message = `Request validation failed: ${hints.join("; ")}`;
        result.data.error.details = {
          testerHints: hints,
        };
      }
    }

    const createdOrderId = result?.data?.data?.order_id;
    if (typeof createdOrderId === "string") {
      lastOrders.payment = createdOrderId;
    }
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/test/get-payment", async (req, res, next) => {
  try {
    const orderId = String(req.body.order_id || lastOrders.payment || "").trim();
    if (!orderId) {
      return res.status(400).json({ message: "No payment order found. Create a payment first." });
    }

    const payload = includeGetDataInSignature ? { order_id: orderId } : {};
    const result = await callRiverpe("GET", `/merchant/payments/${encodeURIComponent(orderId)}`, payload, {
      includePayloadInSign: includeGetDataInSignature,
    });

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/test/hosted-payment", async (req, res, next) => {
  try {
    const orderId = String(req.body.order_id || lastOrders.payment || "").trim();
    if (!orderId) {
      return res.status(400).json({ message: "No payment order found. Create a payment first or provide order_id." });
    }

    const payload = includeGetDataInSignature ? { order_id: orderId } : {};
    const paymentResult = await callRiverpe("GET", `/merchant/payments/${encodeURIComponent(orderId)}`, payload, {
      includePayloadInSign: includeGetDataInSignature,
    });

    const paymentData = paymentResult?.data?.data || {};
    const paymentUrl = paymentData.payment_url || null;
    const hostedPaymentUrl = `${merchantDashboardBaseUrl.replace(/\/$/, "")}/payments/${encodeURIComponent(orderId)}`;

    res.status(200).json({
      request: {
        method: "POST",
        path: "/api/test/hosted-payment",
        payload: { order_id: orderId },
      },
      status: paymentResult.status,
      data: {
        order_id: orderId,
        payment_status: paymentData.status || null,
        amount: paymentData.amount || null,
        payment_url: paymentUrl,
        hosted_payment_url: hostedPaymentUrl,
      },
      providerResponse: paymentResult.data,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/test/query-payment-v1", async (req, res, next) => {
  try {
    const orderId = String(req.body.order_id || req.body.orderid || lastOrders.payment || "").trim();
    if (!orderId) {
      return res.status(400).json({ message: "No payment order found. Create a payment first or provide order_id." });
    }

    const result = await callRiverpe("POST", "/merchant/payments/query", {
      ...req.body,
      order_id: orderId,
    });

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/test/create-payout", async (req, res, next) => {
  try {
    const payoutOrderId = String(req.body.order_no || req.body.order_id || "").trim() || generatePayoutOrderId();
    const result = await callRiverpe("POST", "/merchant/payouts", {
      ...req.body,
      order_no: payoutOrderId,
      order_id: payoutOrderId,
    });

    const createdOrderId = result?.data?.data?.order_id;
    lastOrders.payout = typeof createdOrderId === "string" ? createdOrderId : payoutOrderId;
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/test/get-payout", async (req, res, next) => {
  try {
    const orderId = String(req.body.order_id || lastOrders.payout || "").trim();
    if (!orderId) {
      return res.status(400).json({ message: "No payout order found. Create a payout first." });
    }

    const payload = includeGetDataInSignature ? { order_id: orderId } : {};
    const result = await callRiverpe("GET", `/merchant/payouts/${encodeURIComponent(orderId)}`, payload, {
      includePayloadInSign: includeGetDataInSignature,
    });

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/test/query-payout-v1", async (req, res, next) => {
  try {
    const orderId = String(req.body.order_no || req.body.order_id || lastOrders.payout || "").trim();
    if (!orderId) {
      return res.status(400).json({ message: "No payout order found. Create a payout first or provide order_no." });
    }

    const result = await callRiverpe("POST", "/merchant/payouts/query", {
      ...req.body,
      order_no: orderId,
      order_id: orderId,
    });

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/test/query-payout-v2", async (req, res, next) => {
  try {
    const orderId = String(req.body.order_no || req.body.order_id || lastOrders.payout || "").trim();
    if (!orderId) {
      return res.status(400).json({ message: "No payout order found. Create a payout first or provide order_no." });
    }

    const result = await callRiverpe("POST", "/merchant/payouts/query/detail", {
      ...req.body,
      order_no: orderId,
      order_id: orderId,
    });

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/test/get-voucher", async (req, res, next) => {
  try {
    const orderId = String(req.body.order_id || lastOrders.payout || "").trim();
    if (!orderId) {
      return res.status(400).json({ message: "No payout order found. Create a payout first." });
    }

    const payload = includeGetDataInSignature ? { order_id: orderId } : {};
    const result = await callRiverpe("GET", `/merchant/payouts/${encodeURIComponent(orderId)}/voucher`, payload, {
      includePayloadInSign: includeGetDataInSignature,
    });

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/test/get-balance", async (_req, res, next) => {
  try {
    const result = await callRiverpe("GET", "/merchant/balance", {}, {
      includePayloadInSign: includeGetDataInSignature,
    });

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

registerMethodRoutes("/notify", (req, res) => {
  handlePspNotice("PSP COLLECTION NOTICE (PAY-IN)", "/notify", req, res, { includeRemarkInSign: true });
});

registerMethodRoutes("/notify/payout", (req, res) => {
  handlePspNotice("PSP PAYMENT NOTICE (PAYOUT)", "/notify/payout", req, res, { includeRemarkInSign: false });
});

registerMethodRoutes("/callback", (req, res) => {
  handleMerchantCallback("MERCHANT CALLBACK (PAY-IN)", "/callback", req, res, "payment");
});

registerMethodRoutes("/callback/payout", (req, res) => {
  handleMerchantCallback("MERCHANT CALLBACK (PAYOUT)", "/callback/payout", req, res, "payout");
});

app.get("/dashboard", (_req, res) => {
  res.type("html").send(renderDashboardPage());
});

app.post("/dashboard", (req, res) => {
  handleMerchantCallback("MERCHANT CALLBACK (DASHBOARD ALIAS)", "/dashboard", req, res, "payment");
});

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({
    message: error.message || "Unexpected error",
  });
});

app.listen(port, () => {
  console.log(`merchant-endpoint-tester running on http://localhost:${port}`);
});