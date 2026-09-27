const POST_HOSTS = new Set(["linkedin.com", "www.linkedin.com", "m.linkedin.com"]);
const MEDIA_HOSTS = new Set(["media.licdn.com", "dms.licdn.com"]);
const URN_TYPES = { activity: "activity", share: "share", ugcpost: "ugcPost" };

const URN_PATTERN = /urn(?::|%3A)li(?::|%3A)(activity|share|ugcPost)(?::|%3A)(\d{15,25})/i;
const SLUG_PATTERN = /-(activity|share|ugcPost)-(\d{15,25})(?:[-/]|$)/i;
const IMAGE_PATTERN = /https:\/\/media\.licdn\.com\/dms\/image\/[^"'\s<>\\]+/g;
const VIDEO_PATTERN = /https:\/\/dms\.licdn\.com\/playlist\/vid\/[^"'\s<>\\]+/g;

export function parsePostUrl(input) {
  let url;
  try {
    url = new URL(String(input ?? "").trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !POST_HOSTS.has(url.hostname.toLowerCase())) return null;

  const match = (url.pathname + url.search).match(URN_PATTERN) ?? url.pathname.match(SLUG_PATTERN);
  if (!match) return null;
  return { type: URN_TYPES[match[1].toLowerCase()], id: match[2] };
}

export function embedUrl({ type, id }) {
  return `https://www.linkedin.com/embed/feed/update/urn:li:${type}:${id}`;
}

function decodeHtml(text) {
  return text
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function mediaUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && MEDIA_HOSTS.has(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

function sizeRank(variant) {
  if (/high-res/i.test(variant)) return Number.MAX_SAFE_INTEGER;
  return Number(variant.match(/(\d{3,4})/)?.[1] ?? 0);
}

// Keeps first-seen order per asset while upgrading to its largest variant.
function collect(html, pattern, pathPattern, accept) {
  const assets = new Map();
  for (const [raw] of html.matchAll(pattern)) {
    const url = mediaUrl(raw);
    const parts = url?.pathname.match(pathPattern);
    if (!parts || !accept(parts[2])) continue;
    const [, asset, variant] = parts;
    const current = assets.get(asset);
    if (!current || sizeRank(variant) > sizeRank(current.variant)) {
      assets.set(asset, { url: url.href, variant });
    }
  }
  return [...assets.values()];
}

export function extractMedia(html) {
  const text = decodeHtml(String(html ?? ""));
  return {
    images: collect(text, IMAGE_PATTERN, /^\/dms\/image\/v2\/([^/]+)\/([^/]+)\//, (v) => v.startsWith("feedshare-")),
    videos: collect(text, VIDEO_PATTERN, /^\/playlist\/vid\/(?:v2\/)?([^/]+)\/([^/]+)\//, (v) => v.startsWith("mp4-")),
  };
}
