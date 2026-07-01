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
