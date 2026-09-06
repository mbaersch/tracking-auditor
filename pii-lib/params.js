// Shared HTTP-parameter extraction for all provider parsers (GA4, Meta, …).
// Pure functions, no DOM / chrome APIs, so they run both in the panel and under
// `node --test`.

// Extract query params (from the URL) and body params (from the HAR postData,
// which is either a string or a { text } object). Body is parsed as JSON when it
// looks like a JSON object, otherwise as urlencoded form data.
export function extractParams(url, postData) {
  const queryParams = {};
  try {
    const u = new URL(url);
    for (const [k, v] of u.searchParams.entries()) {
      if (!(k in queryParams)) queryParams[k] = v;
    }
  } catch (e) { /* leave empty */ }

  let bodyParams = null;
  let bodyJson = null;
  const text = typeof postData === 'string' ? postData : (postData && postData.text) || '';
  if (text) {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        bodyJson = obj;
        bodyParams = {};
        for (const k of Object.keys(obj)) {
          const v = obj[k];
          bodyParams[k] = (v !== null && typeof v === 'object') ? JSON.stringify(v) : String(v);
        }
      }
    } catch (e) {
      bodyParams = {};
      for (const [k, v] of new URLSearchParams(text).entries()) {
        if (!(k in bodyParams)) bodyParams[k] = v;
      }
    }
  }
  return { queryParams, bodyParams, bodyJson };
}

// The standard "read a param, query first then body, null when absent" accessor
// shared by every provider that merges URL and POST-body params.
export function makeGetter(queryParams, bodyParams) {
  return (k) => queryParams[k] ?? (bodyParams && bodyParams[k]) ?? null;
}

// ---------------------------------------------------------------------------
// PII / user-data helpers — shared across all providers. We only READ what a
// request carries: translate raw parameters to plain-language categories and
// name the hash form by its shape. No plaintext comparison, no normalization,
// no hash validation — that stays the EC-Validator's job.
// ---------------------------------------------------------------------------

// Human-readable category per identifier bucket, so every provider's PII block
// speaks the same language ("Email", "Phone", …).
export const BUCKET_LABEL = {
  email: 'Email', phone: 'Phone', firstName: 'First name', lastName: 'Last name',
  name: 'Name', street: 'Street address', city: 'City', region: 'Region',
  postal: 'Postal code', country: 'Country', gender: 'Gender', dob: 'Date of birth',
  age: 'Age', geo: 'Geo', externalId: 'External ID', maid: 'Mobile ad ID',
};

// Detect the hash form of a value by shape alone: SHA-256 = 64 hex or a 43/44-
// char base64url blob (32 bytes, as Google Ads / GA4 ship em form-data), SHA-1 =
// 40 hex, MD5 = 32 hex. Returns null when nothing is hash-shaped — i.e. a
// plaintext value — which callers render neutrally, never as a warning.
export function hashAlgo(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return 'sha256';
  if (/^[0-9a-f]{40}$/i.test(s)) return 'sha1';
  if (/^[0-9a-f]{32}$/i.test(s)) return 'md5';
  if (/^[A-Za-z0-9_-]{43}={0,1}$/.test(s)) return 'sha256'; // base64url SHA-256
  return null;
}

// Convenience for the many parsers that only need a boolean "does this look
// hashed at all". Supersedes the per-provider copies of this test.
export function looksHashed(v) {
  return hashAlgo(v) !== null;
}

// The standard user-data field descriptor every provider builds: the identifier
// bucket, its plain-language label, and the hash form detected from the value's
// shape. hashed and algo are derived from the SAME value, so they can never
// contradict each other.
export function piiField(bucket, label, value) {
  return { bucket, label, hashed: looksHashed(value), algo: hashAlgo(value) };
}

// The hash algorithm(s) each provider actually requires — a static, published
// fact, so no comparison value is needed. Everyone mandates SHA-256 except
// Pinterest, which accepts MD5 / SHA-1 / SHA-256.
export const EXPECTED_ALGO = {
  ga4: ['sha256'], meta: ['sha256'], uet: ['sha256'], tiktok: ['sha256'],
  pinterest: ['md5', 'sha1', 'sha256'], googleads: ['sha256'],
  linkedin: ['sha256'], reddit: ['sha256'], snapchat: ['sha256'],
  openai: ['sha256'],
};

// Display label for a detected algo. null (plaintext) is stated plainly, not
// flagged.
export function algoLabel(algo) {
  return algo === 'sha256' ? 'SHA-256'
    : algo === 'sha1' ? 'SHA-1'
      : algo === 'md5' ? 'MD5'
        : 'not hashed';
}

// A terse note when the DETECTED algo contradicts what the provider requires —
// the one format warning we can make honestly. Plaintext (algo null) returns ''
// by design: an un-hashed value is not a wrong-algo case, and we don't do leak
// alarms. Returns '' when we have no expectation or the algo is accepted.
export function algoNote(provider, algo) {
  if (!algo) return '';
  const expected = EXPECTED_ALGO[provider];
  if (!expected || expected.includes(algo)) return '';
  return `expects ${expected.map(algoLabel).join(' / ')}`;
}
