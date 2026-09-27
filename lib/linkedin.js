const POST_HOSTS = new Set(["linkedin.com", "www.linkedin.com", "m.linkedin.com"]);
const MEDIA_HOSTS = new Set(["media.licdn.com", "dms.licdn.com"]);
const URN_TYPES = { activity: "activity", share: "share", ugcpost: "ugcPost" };
const POST_LD_TYPES = new Set(["SocialMediaPosting", "DiscussionForumPosting"]);

const URN_PATTERN = /urn(?::|%3A)li(?::|%3A)(activity|share|ugcPost)(?::|%3A)(\d{15,25})/i;
const SLUG_PATTERN = /-(activity|share|ugcPost)-(\d{15,25})(?:[-/]|$)/i;
const IMAGE_URL_PATTERN = /https:\/\/media\.licdn\.com\/dms\/image\/[^"'\s<>\\]+/g;
const VIDEO_URL_PATTERN = /https:\/\/dms\.licdn\.com\/playlist\/vid\/[^"'\s<>\\]+/g;
const IMAGE_PATH = /^\/dms\/image\/v2\/([^/]+)\/([^/]+)\//;
const VIDEO_PATH = /^\/playlist\/vid\/(?:v2\/)?([^/]+)\/([^/]+)\//;
const LD_JSON_PATTERN = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;

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

export function postPageUrl({ type, id }) {
  return `https://www.linkedin.com/feed/update/urn:li:${type}:${id}/`;
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
function collect(rawUrls, pathPattern, accept) {
  const assets = new Map();
  for (const raw of rawUrls) {
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

const pickImages = (urls) => collect(urls, IMAGE_PATH, (v) => v.startsWith("feedshare-"));
const pickVideos = (urls) => collect(urls, VIDEO_PATH, (v) => v.startsWith("mp4-"));

// The embed page shows the first few images and a "+N" overlay for the rest.
export function hiddenImageCount(html) {
  return Number(String(html ?? "").match(/>\s*\+(\d{1,3})\s*</)?.[1] ?? 0);
}

export function extractMedia(html) {
  const text = decodeHtml(String(html ?? ""));
  const all = (pattern) => [...text.matchAll(pattern)].map((m) => m[0]);
  return { images: pickImages(all(IMAGE_URL_PATTERN)), videos: pickVideos(all(VIDEO_URL_PATTERN)) };
}

function urlsOf(value) {
  return []
    .concat(value ?? [])
    .map((v) => (typeof v === "string" ? v : v?.contentUrl ?? v?.url))
    .filter((v) => typeof v === "string");
}

function clip(value, max) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

// The post page's JSON-LD lists every image; the embed page only renders the first few.
export function extractPostJsonLd(html) {
  const imageUrls = [];
  const videoUrls = [];
  let meta = {};
  for (const [, body] of String(html ?? "").matchAll(LD_JSON_PATTERN)) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      continue;
    }
    const nodes = [data].flat().flatMap((d) => [d, ...[].concat(d?.["@graph"] ?? [])]);
    for (const node of nodes) {
      const type = node?.["@type"];
      if (type === "VideoObject") {
        videoUrls.push(...urlsOf(node));
      } else if (POST_LD_TYPES.has(type)) {
        imageUrls.push(...urlsOf(node.image));
        videoUrls.push(...urlsOf(node.video));
        meta = {
          author: clip(node.author?.name, 120),
          headline: clip(node.headline, 300),
          published: clip(node.datePublished, 40),
        };
      }
    }
  }
  return { images: pickImages(imageUrls), videos: pickVideos(videoUrls), meta };
}
