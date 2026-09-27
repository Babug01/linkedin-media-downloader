import { embedUrl, extractMedia, parsePostUrl } from "../lib/linkedin.js";

const MAX_HTML_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
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

  let html;
  try {
    // The URL is rebuilt from the parsed numeric ID, so user input never picks the fetched host.
    const response = await fetch(embedUrl(post), {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      return send(res, 502, {
        error: `LinkedIn returned HTTP ${response.status}. The post may be private, deleted, or temporarily unavailable.`,
      });
    }
    html = await readLimited(response, MAX_HTML_BYTES);
  } catch (err) {
    const timedOut = err?.name === "TimeoutError";
    return send(res, 504, { error: timedOut ? "LinkedIn took too long to respond." : "Could not reach LinkedIn." });
  }

  const media = extractMedia(html);
  if (!media.images.length && !media.videos.length) {
    return send(res, 404, {
      error: "No downloadable images or videos found. The post may be private, text-only, or use unsupported media (documents, articles, links).",
    });
  }

  return send(res, 200, { post, ...media }, "public, s-maxage=600, stale-while-revalidate=3600");
}
