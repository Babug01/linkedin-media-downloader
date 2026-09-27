import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import handler from "../api/extract.js";

const ID = "7507996395447033856";
const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

const img = (n) => `https://media.licdn.com/dms/image/v2/A${n}/feedshare-shrink_1280/B/0/1?e=1&v=beta&t=x`;
const postPage = (count) =>
  `<script type="application/ld+json">${JSON.stringify({
    "@type": "SocialMediaPosting",
    author: { name: "Jane Doe" },
    image: Array.from({ length: count }, (_, i) => ({ url: img(i) })),
  })}</script>`;
const embedPage = `${[0, 1, 2, 3, 4].map((i) => `<img data-delayed-url="${img(i)}">`).join("")}<span>\n +7\n </span>`;

function mockLinkedIn(pageCounts) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = String(url).includes("/embed/") ? embedPage : postPage(pageCounts.shift() ?? 5);
    return new Response(body, { status: 200 });
  };
  return calls;
}

async function call(url) {
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = JSON.parse(b); } };
  await handler({ method: "GET", url: `/api/extract?url=${encodeURIComponent(url)}` }, res);
  return res;
}

test("retries the post page when JSON-LD has fewer images than the embed advertises", async () => {
  const calls = mockLinkedIn([5, 12]);
  const res = await call(`https://www.linkedin.com/feed/update/urn:li:activity:${ID}/`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.images.length, 12);
  assert.equal(res.body.missing, 0);
  assert.match(res.headers["Cache-Control"], /s-maxage/);
  assert.equal(calls.filter((u) => !u.includes("/embed/")).length, 2);
});

test("reports missing images and disables caching when LinkedIn keeps returning a partial list", async () => {
  mockLinkedIn([5, 5, 5]);
  const res = await call(`https://www.linkedin.com/feed/update/urn:li:activity:${ID}/`);
  assert.equal(res.body.images.length, 5);
  assert.equal(res.body.missing, 7);
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("only ever fetches linkedin.com URLs rebuilt from the post ID", async () => {
  const calls = mockLinkedIn([12]);
  await call(`https://www.linkedin.com/posts/jane_topic-activity-${ID}-AbC?redirect=https://evil.example`);
  assert.deepEqual(calls.sort(), [
    `https://www.linkedin.com/embed/feed/update/urn:li:activity:${ID}`,
    `https://www.linkedin.com/feed/update/urn:li:activity:${ID}/`,
  ]);
});
