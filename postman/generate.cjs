/**
 * Generates the Postman collection and environments from code, so the collection
 * is reviewable in a diff and cannot drift silently from the API it tests.
 *   node postman/generate.cjs
 */
const fs = require('fs');
const path = require('path');

const test = (lines) => ({ listen: 'test', script: { type: 'text/javascript', exec: lines } });
const pre = (lines) => ({ listen: 'prerequest', script: { type: 'text/javascript', exec: lines } });

function url(base, p) {
  const [pathname, query] = p.split('?');
  return {
    raw: `${base}${p}`,
    host: [base],
    path: pathname.replace(/^\//, '').split('/'),
    ...(query ? { query: query.split('&').map((kv) => ({ key: kv.split('=')[0], value: kv.split('=')[1] })) } : {}),
  };
}

function api(name, method, p, opts = {}) {
  return {
    name,
    event: [...(opts.pre ? [pre(opts.pre)] : []), ...(opts.test ? [test(opts.test)] : [])],
    request: {
      method,
      header: [
        ...(method !== 'GET' ? [{ key: 'x-csrf-token', value: '{{csrf}}' }] : []),
        ...(opts.body ? [{ key: 'Content-Type', value: 'application/json' }] : []),
      ],
      url: url('{{baseUrl}}', p),
      ...(opts.body ? { body: { mode: 'raw', raw: JSON.stringify(opts.body, null, 2) } } : {}),
    },
  };
}

function paypal(name, method, p, opts = {}) {
  return {
    name,
    event: opts.test ? [test(opts.test)] : [],
    request: {
      method,
      auth: opts.basic
        ? { type: 'basic', basic: [{ key: 'username', value: '{{paypalClientId}}' }, { key: 'password', value: '{{paypalClientSecret}}' }] }
        : { type: 'bearer', bearer: [{ key: 'token', value: '{{paypalAccessToken}}' }] },
      header: opts.body !== undefined ? [{ key: 'Content-Type', value: 'application/json' }] : [],
      url: url('{{paypalBase}}', p),
      ...(opts.form
        ? { body: { mode: 'urlencoded', urlencoded: [{ key: 'grant_type', value: 'client_credentials' }] } }
        : opts.body !== undefined
          ? { body: { mode: 'raw', raw: JSON.stringify(opts.body, null, 2) } }
          : {}),
      description: opts.description || '',
    },
  };
}

const collection = {
  info: {
    name: 'DisputeDesk',
    _postman_id: '5b1e0c4e-7d1a-4c55-9a0e-0d15d0d35c01',
    description:
      'DisputeDesk internal API (run in CI against demo mode via Newman) and the PayPal sandbox Disputes calls ' +
      'used for the Day-1 spike. The PayPal folder needs sandbox credentials and is not run in CI.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: [
    {
      name: 'DisputeDesk API',
      description: 'npm run postman — the server must be running in demo mode on {{baseUrl}}.',
      item: [
        api('Session (CSRF token)', 'GET', '/api/session', {
          test: [
            "pm.test('200', () => pm.response.to.have.status(200));",
            'const j = pm.response.json();',
            "pm.environment.set('csrf', j.csrfToken);",
            "pm.test('demo mode', () => pm.expect(j.mode).to.eql('demo'));",
          ],
        }),
        api('Health', 'GET', '/api/health', {
          test: [
            "pm.test('200', () => pm.response.to.have.status(200));",
            "pm.test('dependencies list fallbacks', () => pm.response.json().dependencies.forEach((d) => pm.expect(d).to.have.property('fallback')));",
          ],
        }),
        api('Reset demo', 'POST', '/api/demo/reset', { body: {}, test: ["pm.test('200', () => pm.response.to.have.status(200));"] }),
        api('Queue (deadline-first)', 'GET', '/api/disputes', {
          test: [
            "pm.test('200', () => pm.response.to.have.status(200));",
            'const items = pm.response.json().items;',
            "pm.test('14 fixture disputes', () => pm.expect(items.length).to.eql(14));",
            "const open = items.filter((i) => i.status !== 'RESOLVED').map((i) => i.urgency.sortKey);",
            "pm.test('sorted by deadline', () => pm.expect(open).to.eql([...open].sort((a, b) => a - b)));",
            "pm.test('fixtures are labelled', () => items.forEach((i) => pm.expect(i.fixture).to.eql(true)));",
          ],
        }),
        api('Dispute detail', 'GET', '/api/disputes/PP-D-FIX-00001', {
          test: [
            "pm.test('200', () => pm.response.to.have.status(200));",
            'const d = pm.response.json();',
            "pm.test('rubric score present', () => pm.expect(d.plan.completeness).to.be.within(0, 100));",
            "pm.test('actions come from links', () => pm.expect(d.allowedActions).to.include('provide-evidence'));",
            'const ids = d.evidence.map((e) => e.id);',
            "pm.test('draft cites only existing evidence', () => d.draft.evidenceRefs.forEach((r) => pm.expect(ids).to.include(r)));",
          ],
        }),
        api('Write with a wrong CSRF token is refused', 'POST', '/api/disputes/PP-D-FIX-00001/preview', {
          body: { action: 'provide-evidence' },
          pre: ["pm.request.headers.upsert({ key: 'x-csrf-token', value: 'not-the-token' });"],
          test: ["pm.test('403', () => pm.response.to.have.status(403));"],
        }),
        api('Preview provide-evidence', 'POST', '/api/disputes/PP-D-FIX-00001/preview', {
          body: { action: 'provide-evidence' },
          test: [
            "pm.test('200', () => pm.response.to.have.status(200));",
            'const p = pm.response.json();',
            "pm.environment.set('payloadHash', p.payloadSha256);",
            "pm.test('sha256 hex', () => pm.expect(p.payloadSha256).to.match(/^[a-f0-9]{64}$/));",
            "pm.test('evidence_info only on PROOF_OF_FULFILLMENT', () => p.request.body.evidences.forEach((e) => { if (e.evidence_type !== 'PROOF_OF_FULFILLMENT') pm.expect(e).to.not.have.property('evidence_info'); }));",
          ],
        }),
        api('Approve with a wrong hash is refused', 'POST', '/api/disputes/PP-D-FIX-00001/approve', {
          body: { action: 'provide-evidence', payload_sha256: '0'.repeat(64) },
          test: [
            "pm.test('409', () => pm.response.to.have.status(409));",
            "pm.test('problem type', () => pm.expect(pm.response.json().type).to.include('hash-mismatch'));",
          ],
        }),
        api('Approve & submit', 'POST', '/api/disputes/PP-D-FIX-00001/approve', {
          body: { action: 'provide-evidence', payload_sha256: '{{payloadHash}}' },
          test: [
            "pm.test('200', () => pm.response.to.have.status(200));",
            'const r = pm.response.json();',
            "pm.test('recorded, not sent (demo)', () => pm.expect(r.simulated).to.eql(true));",
            "pm.test('status read back from PayPal', () => pm.expect(r.disputeStatus).to.eql('UNDER_REVIEW'));",
          ],
        }),
        api('Replaying the same approval is refused', 'POST', '/api/disputes/PP-D-FIX-00001/approve', {
          body: { action: 'provide-evidence', payload_sha256: '{{payloadHash}}' },
          test: ["pm.test('409', () => pm.response.to.have.status(409));"],
        }),
        api('Offer above the disputed amount is refused', 'POST', '/api/disputes/PP-D-FIX-00002/preview', {
          body: { action: 'make-offer', offer: { offer_type: 'REFUND', amount: '999.00', note: 'test' } },
          test: ["pm.test('422', () => pm.response.to.have.status(422));"],
        }),
        api('Audit log', 'GET', '/api/audit', {
          test: [
            "pm.test('200', () => pm.response.to.have.status(200));",
            'const ev = pm.response.json().entries.map((e) => e.event);',
            "pm.test('approval and write recorded', () => { pm.expect(ev).to.include('approval.granted'); pm.expect(ev).to.include('paypal.write'); });",
            "pm.test('no bearer tokens', () => pm.expect(pm.response.text()).to.not.match(/Bearer\\s+A21/));",
          ],
        }),
      ],
    },
    {
      name: 'PayPal sandbox (needs credentials; not run in CI)',
      description: 'Day-1 spike calls (PRD §12, gate G0). Fill in the sandbox environment, then run "OAuth token" first.',
      item: [
        paypal('OAuth token', 'POST', '/v1/oauth2/token', {
          basic: true,
          form: true,
          test: [
            'const j = pm.response.json();',
            "pm.environment.set('paypalAccessToken', j.access_token);",
            "pm.test('token issued', () => pm.expect(j.access_token).to.be.a('string'));",
          ],
        }),
        paypal('List disputes', 'GET', '/v1/customer/disputes?page_size=20', {
          test: [
            "pm.test('200', () => pm.response.to.have.status(200));",
            'const items = pm.response.json().items || [];',
            "if (items[0]) pm.environment.set('disputeId', items[0].dispute_id);",
          ],
        }),
        paypal('Show dispute (record the links)', 'GET', '/v1/customer/disputes/{{disputeId}}', {
          description: 'G0 step 2: record which HATEOAS rels appear.',
          test: [
            "pm.test('200', () => pm.response.to.have.status(200));",
            "console.log('rels:', (pm.response.json().links || []).map((l) => l.rel).join(', '));",
          ],
        }),
        paypal('Provide evidence (JSON with tracking)', 'POST', '/v1/customer/disputes/{{disputeId}}/provide-evidence', {
          description: 'Only when the provide-evidence link is present. Sandbox only.',
          body: {
            evidences: [
              {
                evidence_type: 'PROOF_OF_FULFILLMENT',
                evidence_info: { tracking_info: [{ carrier_name: 'UPS', tracking_number: '1Z999AA10123456784' }] },
                notes: 'Spike test from the DisputeDesk Postman collection (sandbox).',
              },
            ],
          },
        }),
        paypal('Send message', 'POST', '/v1/customer/disputes/{{disputeId}}/send-message', { body: { message: 'Spike test message (sandbox).' } }),
        paypal('List trackers for a transaction', 'GET', '/v1/shipping/trackers?transaction_id={{transactionId}}'),
      ],
    },
  ],
};

function env(name, values) {
  return {
    id: name.toLowerCase().replace(/\W+/g, '-'),
    name,
    values: Object.entries(values).map(([key, value]) => ({ key, value, type: /secret/i.test(key) ? 'secret' : 'default', enabled: true })),
    _postman_variable_scope: 'environment',
  };
}

const dir = __dirname;
fs.writeFileSync(path.join(dir, 'DisputeDesk.postman_collection.json'), JSON.stringify(collection, null, 2));
fs.writeFileSync(path.join(dir, 'local.postman_environment.json'), JSON.stringify(env('DisputeDesk local (demo)', { baseUrl: 'http://localhost:8787', csrf: '', payloadHash: '' }), null, 2));
fs.writeFileSync(
  path.join(dir, 'sandbox.postman_environment.json'),
  JSON.stringify(env('PayPal sandbox', { paypalBase: 'https://api-m.sandbox.paypal.com', paypalClientId: '', paypalClientSecret: '', paypalAccessToken: '', disputeId: '', transactionId: '' }), null, 2),
);
console.log('Postman collection and environments written.');
