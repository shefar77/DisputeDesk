/**
 * G0 sandbox spike — proves the PayPal integration against the real Sandbox API.
 *
 * Reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET from .env, then:
 *   1. POST /v1/oauth2/token          (client credentials)
 *   2. GET  /v1/customer/disputes     (the list the queue is built from)
 *   3. GET  /v1/customer/disputes/{id} for the first dispute, if any
 *
 * Prints status codes and shapes. Never prints the secret or the access token.
 * Run:  node scripts-spike-g0.mjs
 */
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const id = env.PAYPAL_CLIENT_ID;
const secret = env.PAYPAL_CLIENT_SECRET;
const BASE = 'https://api-m.sandbox.paypal.com';

if (!id || !secret) {
  console.log('FAIL: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are empty in .env');
  process.exit(1);
}
console.log(`client id length: ${id.length}, secret length: ${secret.length}`);
console.log(`base: ${BASE}\n`);

// --- 1. OAuth2 -------------------------------------------------------------
const t0 = Date.now();
const tokenRes = await fetch(`${BASE}/v1/oauth2/token`, {
  method: 'POST',
  headers: {
    authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
    'content-type': 'application/x-www-form-urlencoded',
  },
  body: 'grant_type=client_credentials',
});
const tokenBody = await tokenRes.json().catch(() => ({}));
console.log(`1. POST /v1/oauth2/token            -> ${tokenRes.status} in ${Date.now() - t0}ms`);
if (!tokenRes.ok) {
  console.log('   error:', JSON.stringify(tokenBody).slice(0, 400));
  process.exit(1);
}
console.log(`   token type: ${tokenBody.token_type}, expires_in: ${tokenBody.expires_in}s`);
console.log(`   scopes include disputes: ${String(tokenBody.scope || '').includes('disputes')}\n`);
const token = tokenBody.access_token;

// --- 2. List disputes ------------------------------------------------------
const t1 = Date.now();
const listRes = await fetch(`${BASE}/v1/customer/disputes?page_size=10`, {
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
});
const list = await listRes.json().catch(() => ({}));
console.log(`2. GET  /v1/customer/disputes       -> ${listRes.status} in ${Date.now() - t1}ms`);
if (!listRes.ok) {
  console.log('   error:', JSON.stringify(list).slice(0, 600));
  process.exit(1);
}
const items = list.items || [];
console.log(`   disputes returned: ${items.length}`);
if (listRes.headers.get('paypal-debug-id')) {
  console.log(`   paypal-debug-id: ${listRes.headers.get('paypal-debug-id')}`);
}
for (const d of items.slice(0, 5)) {
  console.log(`     ${d.dispute_id}  ${d.reason}  ${d.status}  due=${d.seller_response_due_date ?? '-'}`);
}

// --- 3. Detail + HATEOAS links --------------------------------------------
if (items.length) {
  const did = items[0].dispute_id;
  const t2 = Date.now();
  const detRes = await fetch(`${BASE}/v1/customer/disputes/${did}`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  const det = await detRes.json().catch(() => ({}));
  console.log(`\n3. GET  /v1/customer/disputes/${did} -> ${detRes.status} in ${Date.now() - t2}ms`);
  if (detRes.ok) {
    console.log(`   stage: ${det.dispute_state}, status: ${det.status}`);
    console.log('   HATEOAS links offered:');
    for (const l of det.links || []) console.log(`     ${l.rel}  (${l.method})`);
  } else {
    console.log('   error:', JSON.stringify(det).slice(0, 400));
  }
} else {
  console.log('\n3. Skipped detail call — no disputes exist on this sandbox account yet.');
  console.log('   The list endpoint answering 200 with an empty set is still a real,');
  console.log('   authenticated Sandbox call. See the note the script prints below.');
}

console.log('\nDone. Nothing above was written to PayPal; all three calls are reads.');
