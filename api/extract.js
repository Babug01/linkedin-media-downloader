import { embedUrl, extractMedia, extractPostJsonLd, hiddenImageCount, parsePostUrl, postPageUrl } from "../lib/linkedin.js";

const MAX_HTML_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const PAGE_ATTEMPTS = 3;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

function send(res, status, body, cache = "no-store") {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cache);
  res.end(JSON.stringify(body));
}

async function readLimited(response, limit) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error("LinkedIn response was larger than expected.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(res, 405, { error: "Method not allowed." });
  }

  const input = new URL(req.url, "http://localhost").searchParams.get("url");
  const post = parsePostUrl(input);
  if (!post) {
    return send(res, 400, {
      error: "Paste a full LinkedIn post URL, e.g. https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456789/",
    });
  }

  // Both URLs are rebuilt from the parsed numeric ID, so user input never picks the fetched host.
  const [page, embed] = await Promise.allSettled([fetchWithRetry(postPageUrl(post)), fetchHtml(embedUrl(post))]);
  if (page.status === "rejected" && embed.status === "rejected") {
    const err = page.reason;
    if (err?.name === "TimeoutError") return send(res, 504, { error: "LinkedIn took too long to respond." });
    if (err?.status) {
      return send(res, 502, {
        error: `LinkedIn returned HTTP ${err.status}. The post may be private, deleted, or temporarily unavailable.`,
      });
    }
    return send(res, 502, { error: "Could not reach LinkedIn." });
  }

  const empty = { images: [], videos: [], meta: {} };
  const embedHtml = embed.status === "fulfilled" ? embed.value : "";
  const embedMedia = embedHtml ? extractMedia(embedHtml) : empty;
  const expected = embedMedia.images.length + hiddenImageCount(embedHtml);

  let pageHtml = page.status === "fulfilled" ? page.value : "";
  let ld = pageHtml ? extractPostJsonLd(pageHtml) : empty;
  // LinkedIn intermittently serves a post page without the full JSON-LD image list.
  for (let attempt = 1; attempt < PAGE_ATTEMPTS && ld.images.length < expected; attempt++) {
    await sleep(400);
    try {
      const html = await fetchHtml(postPageUrl(post));
      const next = extractPostJsonLd(html);
      if (next.images.length > ld.images.length) [pageHtml, ld] = [html, next];
    } catch {
      // Keep the best result so far.
    }
  }
  const pageMedia = pageHtml ? extractMedia(pageHtml) : empty;

  const images = ld.images.length >= embedMedia.images.length ? ld.images : embedMedia.images;
  const videos = [ld.videos, embedMedia.videos, pageMedia.videos].find((v) => v.length) ?? [];
  const missing = Math.max(0, expected - images.length);
  if (!images.length && !videos.length) {
    return send(res, 404, {
      error: "No downloadable images or videos found. The post may be private, text-only, or use unsupported media (documents, articles, links).",
    });
  }

  // Partial results must not be cached, so a retry can get the full set.
  const cache = missing ? "no-store" : "public, s-maxage=600, stale-while-revalidate=3600";
  return send(res, 200, { post, meta: ld.meta, images, videos, missing }, cache);
}

async function fetchWithRetry(url) {
  try {
    return await fetchHtml(url);
  } catch (err) {
    if (err?.status === 404 || err?.status === 410) throw err;
    await sleep(600);
    return fetchHtml(url);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
  }
  return readLimited(response, MAX_HTML_BYTES);
}
