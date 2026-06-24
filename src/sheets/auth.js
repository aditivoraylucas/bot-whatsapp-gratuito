// ─── AUTH OAUTH — Google Service Account JWT ─────────────────────────────────
// Responsabilidade: gerar e cachear o access token OAuth2 para a API do Sheets.
// Sem dependência de utils nem de config de planilha — apenas crypto e config.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const { GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY } = require('../config');

let _tokenCache  = null;
let _tokenExpiry = 0;

async function getAccessToken() {
  const now = Date.now();
  if (_tokenCache && now < _tokenExpiry) return _tokenCache;

  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss:   GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud:   'https://oauth2.googleapis.com/token',
    iat,
    exp,
  })).toString('base64url');

  const signingInput = `${header}.${payload}`;

  console.log('[auth] getAccessToken — email:', GOOGLE_SERVICE_ACCOUNT_EMAIL);
  console.log('[auth] getAccessToken — key inicia com:', GOOGLE_PRIVATE_KEY?.slice(0, 40));

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(GOOGLE_PRIVATE_KEY, 'base64url');
  const jwt = `${signingInput}.${signature}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`OAuth token error ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  console.log('[auth] OAuth OK — expires_in:', data.expires_in);
  _tokenCache  = data.access_token;
  _tokenExpiry = now + (data.expires_in - 300) * 1000;
  return _tokenCache;
}

module.exports = { getAccessToken };
