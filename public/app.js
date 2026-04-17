async function postJson(url, data) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data || {}),
  });

  return response.json();
}

const memory = {
  lastPaymentOrderId: null,
  lastPayoutOrderId: null,
  clientKeyId: '',
  clientSecret: '',
};

function formDataToObject(form) {
  const fd = new FormData(form);
  const obj = {};
  for (const [key, value] of fd.entries()) {
    obj[key] = value;
  }

  if (obj.amount !== undefined) {
    obj.amount = Number(obj.amount);
  }

  if (obj.value !== undefined) {
    obj.value = Number(obj.value);
  }

  if (obj.method !== undefined && obj.type === undefined) {
    obj.type = obj.method;
    delete obj.method;
  }

  if (obj.clientKeyId !== undefined) {
    obj.clientKeyId = String(obj.clientKeyId);
  }

  if (obj.clientSecret !== undefined) {
    obj.clientSecret = String(obj.clientSecret);
  }

  return obj;
}

function showResult(result) {
  const el = document.getElementById("result");
  el.textContent = JSON.stringify(result, null, 2);

  const createdOrderId = result?.data?.data?.order_id;
  if (typeof createdOrderId === "string") {
    if (createdOrderId.startsWith("ORD-")) {
      memory.lastPaymentOrderId = createdOrderId;
    }

    if (createdOrderId.startsWith("PO-")) {
      memory.lastPayoutOrderId = createdOrderId;
    }
  }
}

async function loadConfig() {
  const response = await fetch("/api/config");
  const config = await response.json();
  document.getElementById("config").textContent =
    `Base URL: ${config.baseUrl} | API key set: ${config.hasApiKey} | API secret set: ${config.hasApiSecret} | INCLUDE_GET_DATA_IN_SIGNATURE: ${config.includeGetDataInSignature}`;
}

function applyMerchantAuthOverride(payload) {
  if (memory.clientKeyId) {
    payload.clientKeyId = memory.clientKeyId;
  }

  if (memory.clientSecret) {
    payload.clientSecret = memory.clientSecret;
  }

  return payload;
}

function bindMerchantAuthForm() {
  const form = document.getElementById('form-merchant-auth');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = formDataToObject(form);
    memory.clientKeyId = String(payload.clientKeyId || '').trim();
    memory.clientSecret = String(payload.clientSecret || '').trim();

    showResult({
      message: memory.clientKeyId || memory.clientSecret
        ? 'Merchant auth override saved for this tester session.'
        : 'Merchant auth override cleared; backend-managed mode will be used.',
      clientKeyId: memory.clientKeyId || null,
      clientSecret: memory.clientSecret ? '[SET]' : null,
    });
  });
}

function bindForm(formId, endpoint) {
  const form = document.getElementById(formId);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    let payload = formDataToObject(form);
      payload = applyMerchantAuthOverride(payload);

    if (endpoint === "/api/test/get-payment") {
      if (!memory.lastPaymentOrderId) {
        showResult({ message: "No payment order found yet. Run Create Payment first." });
        return;
      }
      payload = { order_id: memory.lastPaymentOrderId };
    }

    if (endpoint === "/api/test/query-payment-v1") {
      const inputOrderId = String(payload.order_id || '').trim();
      if (!inputOrderId && !memory.lastPaymentOrderId) {
        showResult({ message: "No payment order found yet. Run Create Payment first or provide order_id." });
        return;
      }
      payload = { order_id: inputOrderId || memory.lastPaymentOrderId };
    }

    if (endpoint === "/api/test/get-payout" || endpoint === "/api/test/get-voucher") {
      if (!memory.lastPayoutOrderId) {
        showResult({ message: "No payout order found yet. Run Create Payout first." });
        return;
      }
      payload = { order_id: memory.lastPayoutOrderId };
    }

    if (endpoint === "/api/test/query-payout-v1" || endpoint === "/api/test/query-payout-v2") {
      const inputOrderNo = String(payload.order_no || payload.order_id || '').trim();
      if (!inputOrderNo && !memory.lastPayoutOrderId) {
        showResult({ message: "No payout order found yet. Run Create Payout first or provide order_no." });
        return;
      }
      payload = { order_no: inputOrderNo || memory.lastPayoutOrderId };
    }

    try {
      const result = await postJson(endpoint, payload);
      showResult(result);
    } catch (error) {
      showResult({ message: error.message || "Request failed" });
    }
  });
}

bindForm("form-create-payment", "/api/test/create-payment");
bindForm("form-get-payment", "/api/test/get-payment");
bindForm("form-query-payment-v1", "/api/test/query-payment-v1");
bindForm("form-create-payout", "/api/test/create-payout");
bindForm("form-get-payout", "/api/test/get-payout");
bindForm("form-query-payout-v1", "/api/test/query-payout-v1");
bindForm("form-query-payout-v2", "/api/test/query-payout-v2");
bindForm("form-get-voucher", "/api/test/get-voucher");
bindForm("form-get-balance", "/api/test/get-balance");
  bindMerchantAuthForm();

loadConfig().catch((error) => {
  showResult({ message: error.message || "Failed to load config" });
});
