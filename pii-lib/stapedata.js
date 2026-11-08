// Stape Data Client: the Stape Data Tag posts events in its own JSON format to a
// server container. A transport format, not a service — only flagged, never parsed.
//
// Fingerprint: ?v=2&event=<name> plus a JSON object body repeating event_name. The
// path is configurable in the client (default /data), so it is not part of the check.

function bodyText(postData) {
  if (typeof postData === 'string') return postData;
  return postData && typeof postData.text === 'string' ? postData.text : null;
}

// Returns { host, path, event } or null.
export function parseStapeDataClient(url, postData) {
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  const event = u.searchParams.get('event');
  if (!event || u.searchParams.get('v') !== '2') return null;
  const text = bodyText(postData);
  if (!text) return null;
  let obj = null;
  try { obj = JSON.parse(text); } catch (e) { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj.event_name !== event) return null;
  return { host: u.hostname, path: u.pathname, event };
}
