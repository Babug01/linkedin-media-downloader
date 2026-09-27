import assert from "node:assert/strict";
import { test } from "node:test";
import { embedUrl, extractMedia, parsePostUrl } from "../lib/linkedin.js";

const ID = "7433575342675722240";

test("parses supported LinkedIn post URL shapes", () => {
  const cases = [
    [`https://www.linkedin.com/feed/update/urn:li:activity:${ID}/`, "activity"],
    [`https://linkedin.com/feed/update/urn:li:share:${ID}?utm_source=share`, "share"],
    [`https://www.linkedin.com/feed/update/urn%3Ali%3AugcPost%3A${ID}/`, "ugcPost"],
    [`https://www.linkedin.com/posts/jane-doe_devops-activity-${ID}-AbCd?utm_source=x`, "activity"],
    [`https://m.linkedin.com/posts/jane-doe_topic-ugcPost-${ID}-XyZ`, "ugcPost"],
    [`https://www.linkedin.com/embed/feed/update/urn:li:activity:${ID}`, "activity"],
  ];
  for (const [url, type] of cases) {
    assert.deepEqual(parsePostUrl(url), { type, id: ID }, url);
  }
});

test("rejects non-LinkedIn, non-HTTPS, and malformed input", () => {
  for (const url of [
    "",
    "not a url",
    `http://www.linkedin.com/feed/update/urn:li:activity:${ID}/`,
    `https://linkedin.com.evil.example/feed/update/urn:li:activity:${ID}/`,
    `https://evil.example/?u=https://www.linkedin.com/feed/update/urn:li:activity:${ID}`,
    "https://www.linkedin.com/in/jane-doe/",
    "https://www.linkedin.com/feed/update/urn:li:activity:123/",
  ]) {
    assert.equal(parsePostUrl(url), null, url);
  }
});

test("builds the embed URL from parsed parts only", () => {
  assert.equal(embedUrl({ type: "ugcPost", id: ID }), `https://www.linkedin.com/embed/feed/update/urn:li:ugcPost:${ID}`);
});

test("extracts post images, keeps order, picks the largest variant, skips avatars", () => {
  const img = (asset, variant) =>
    `https://media.licdn.com/dms/image/v2/${asset}/${variant}/B/0/1?e=2147483647&amp;v=beta&amp;t=x`;
  const html = `
    <img data-delayed-url="${img("AVATAR", "profile-displayphoto-shrink_100_100")}">
    <img data-delayed-url="${img("ASSET2", "feedshare-shrink_800")}">
    <img data-delayed-url="${img("ASSET1", "feedshare-shrink_800")}">
    <img data-delayed-url="${img("ASSET2", "feedshare-shrink_2048_1536")}">
    <img data-delayed-url="${img("ASSET1", "feedshare-image-high-res")}">
    <img data-delayed-url="https://static.licdn.com/aero-v1/sc/h/reaction">`;

  const { images, videos } = extractMedia(html);
  assert.deepEqual(
    images.map((i) => i.variant),
    ["feedshare-shrink_2048_1536", "feedshare-image-high-res"],
  );
  assert.ok(images[0].url.includes("/ASSET2/") && images[0].url.includes("&v=beta"));
  assert.equal(videos.length, 0);
});

test("extracts the highest-resolution MP4 from escaped data-sources JSON", () => {
  const src = (variant) => `https:\\/\\/dms.licdn.com\\/playlist\\/vid\\/v2\\/VID1\\/${variant}\\/B\\/0\\/1?e=1\\u0026t=y`;
  const html = `<video data-sources="[{&quot;src&quot;:&quot;${src("mp4-360p-30fp-crf28")}&quot;},{&quot;src&quot;:&quot;${src("mp4-720p-30fp-crf28")}&quot;}]" data-poster-url="x"></video>`;

  const { videos } = extractMedia(html);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].variant, "mp4-720p-30fp-crf28");
  assert.equal(videos[0].url, "https://dms.licdn.com/playlist/vid/v2/VID1/mp4-720p-30fp-crf28/B/0/1?e=1&t=y");
});

test("ignores media URLs on other hosts", () => {
  const html = `<img src="https://media.licdn.com.evil.example/dms/image/v2/A/feedshare-shrink_800/B/0/1">`;
  assert.deepEqual(extractMedia(html), { images: [], videos: [] });
});
