const crypto = require("node:crypto");

function sortAndFormatParams(params) {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b));

  return entries.map(([key, value]) => `${key}=${String(value)}`).join("&");
}

function md5Lower(text) {
  return crypto.createHash("md5").update(text).digest("hex").toLowerCase();
}

function buildSignature(params, secret) {
  const stringA = sortAndFormatParams(params);
  const toHash = `${stringA}&key=${secret}`;
  return md5Lower(toHash);
}

function generateNonce() {
  return crypto.randomBytes(8).toString("hex");
}

module.exports = {
  buildSignature,
  generateNonce,
};
