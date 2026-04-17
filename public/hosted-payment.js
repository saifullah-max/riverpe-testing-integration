async function postJson(url, data) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data || {}),
  });

  return response.json();
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = text;
  }
}

function setLink(id, url, fallback) {
  const el = document.getElementById(id);
  if (!el) {
    return;
  }

  if (url) {
    el.href = url;
    el.textContent = url;
  } else {
    el.href = '#';
    el.textContent = fallback;
  }
}

async function loadConfig() {
  const response = await fetch('/api/config');
  const config = await response.json();
  setText(
    'config',
    `Base URL: ${config.baseUrl} | API key set: ${config.hasApiKey} | API secret set: ${config.hasApiSecret} | INCLUDE_GET_DATA_IN_SIGNATURE: ${config.includeGetDataInSignature}`
  );
}

function bindHostedForm() {
  const form = document.getElementById('form-hosted-payment');
  const resultEl = document.getElementById('result');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const orderId = String(formData.get('order_id') || '').trim();

    try {
      const result = await postJson('/api/test/hosted-payment', {
        order_id: orderId || undefined,
      });

      resultEl.textContent = JSON.stringify(result, null, 2);

      const data = result?.data || {};
      setLink('hosted-url-link', data.hosted_payment_url, 'Hosted payment URL not available');
      setLink('psp-url-link', data.payment_url, 'PSP payment URL not available');
    } catch (error) {
      resultEl.textContent = JSON.stringify(
        { message: error.message || 'Request failed' },
        null,
        2
      );
    }
  });
}

loadConfig().catch((error) => {
  setText('result', JSON.stringify({ message: error.message || 'Failed to load config' }, null, 2));
});

bindHostedForm();
