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

function webUrl(raw, hostCheck = () => true) {
  try {
    const url = new URL(String(raw ?? ""));
    return /^https?:$/.test(url.protocol) && hostCheck(url.hostname.toLowerCase()) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const isLinkedInHost = (host) => host === "linkedin.com" || host.endsWith(".linkedin.com");

function interactionCount(node, action) {
  const stat = [].concat(node?.interactionStatistic ?? []).find((s) => String(s?.interactionType).endsWith(action));
  const count = Number(stat?.userInteractionCount);
  return Number.isFinite(count) ? count : undefined;
}

function postMeta(node) {
  const comments = interactionCount(node, "CommentAction") ?? (Number.isFinite(node.commentCount) ? node.commentCount : undefined);
  return {
    author: clip(node.author?.name, 120),
    authorUrl: webUrl(node.author?.url, isLinkedInHost),
    avatar: mediaUrl(node.author?.image?.url ?? "")?.href,
    headline: clip(node.headline, 300),
    text: clip(node.articleBody, 20_000),
    published: clip(node.datePublished, 40),
    url: webUrl(node["@id"] ?? node.url, isLinkedInHost),
    likes: interactionCount(node, "LikeAction"),
    comments,
  };
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
        meta = postMeta(node);
      }
    }
  }
  return { images: pickImages(imageUrls), videos: pickVideos(videoUrls), meta };
}

const COMMENTARY_MARKER = 'data-test-id="main-feed-activity-card__commentary"';
const ANCHOR_PATTERN = /<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
const TEXT_URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
const MAX_LINKS = 20;

function stripTrailingPunctuation(url) {
  return url.replace(/[.,;:!?)\]}'"’”]+$/, "");
}

const TRACKING_PARAMS = ["trk", "trkInfo", "lipi", "midToken", "midSig"];

/** Normalised http(s) URL without LinkedIn tracking parameters, or undefined. */
export function cleanLink(raw) {
  const href = webUrl(raw);
  if (!href) return undefined;
  const url = new URL(href);
  for (const param of TRACKING_PARAMS) url.searchParams.delete(param);
  return url.href;
}

// LinkedIn wraps outbound post links as /redir/redirect?url=<target>.
function unwrapRedirect(href) {
  try {
    const url = new URL(href);
    if (isLinkedInHost(url.hostname) && url.pathname.startsWith("/redir/redirect")) {
      return cleanLink(url.searchParams.get("url"));
    }
    return isLinkedInHost(url.hostname) ? undefined : cleanLink(href);
  } catch {
    return undefined;
  }
}

export function linkKey(url) {
  return url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "").toLowerCase();
}

/** Outbound links from the post text: commentary anchors first, then bare URLs in the text. */
export function extractPostLinks(html, text = "") {
  const links = new Map();
  const add = (url, label) => {
    if (!url || links.size >= MAX_LINKS) return;
    const key = linkKey(url);
    if (!links.has(key)) links.set(key, { url, label: clip(label, 200) ?? url });
  };

  const source = String(html ?? "");
  const start = source.indexOf(COMMENTARY_MARKER);
  if (start >= 0) {
    const end = source.indexOf("</p>", start);
    const block = source.slice(start, end > start ? end : start + 50_000);
    for (const [, href, inner] of block.matchAll(ANCHOR_PATTERN)) {
      add(unwrapRedirect(decodeHtml(href)), decodeHtml(inner.replace(/<[^>]+>/g, "")).trim());
    }
  }
  for (const [raw] of String(text ?? "").matchAll(TEXT_URL_PATTERN)) {
    const url = cleanLink(stripTrailingPunctuation(raw));
    if (url && !isLinkedInHost(new URL(url).hostname)) add(url, url);
  }
  return [...links.values()];
}

const SHORT_LINK_PATH = /^\/([A-Za-z0-9_-]{4,20})\/?$/;

/** Returns the lnkd.in short code, or null when the URL is not a LinkedIn short link. */
export function shortLinkCode(raw) {
  try {
    const url = new URL(raw);
    return url.hostname.toLowerCase() === "lnkd.in" ? url.pathname.match(SHORT_LINK_PATH)?.[1] ?? null : null;
  } catch {
    return null;
  }
}

/** Destination from a lnkd.in interstitial page: the first outbound, non-LinkedIn link. */
export function shortLinkTarget(html) {
  for (const [, href] of String(html ?? "").matchAll(ANCHOR_PATTERN)) {
    const url = webUrl(decodeHtml(href));
    const host = url && new URL(url).hostname.toLowerCase();
    if (url && !isLinkedInHost(host) && host !== "lnkd.in") return url;
  }
  return undefined;
}
