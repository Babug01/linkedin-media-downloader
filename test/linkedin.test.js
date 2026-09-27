import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanLink,
  embedUrl,
  extractMedia,
  extractPostJsonLd,
  extractPostLinks,
  hiddenImageCount,
  parsePostUrl,
  postPageUrl,
  shortLinkCode,
  shortLinkTarget,
} from "../lib/linkedin.js";

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
  assert.equal(postPageUrl({ type: "activity", id: ID }), `https://www.linkedin.com/feed/update/urn:li:activity:${ID}/`);
});

test("reads every post image and metadata from JSON-LD, ignoring comment avatars", () => {
  const img = (asset) => `https://media.licdn.com/dms/image/v2/${asset}/feedshare-shrink_1280/B/0/1?e=2147483647&v=beta&t=x`;
  const post = {
    "@context": "http://schema.org",
    "@type": "SocialMediaPosting",
    headline: "Linux permissions cheat sheet",
    datePublished: "2026-09-20T10:00:00.000Z",
    author: { "@type": "Person", name: "Jane Doe", image: { url: img("AUTHOR").replace("feedshare", "profile") } },
    image: Array.from({ length: 12 }, (_, i) => ({ "@type": "ImageObject", url: img(`A${i}`) })),
    comment: [{ "@type": "Comment", author: { image: { url: img("COMMENTER") } } }],
  };
  const html = `<script type="application/ld+json">${JSON.stringify(post)}</script><script type="application/ld+json">{bad json</script>`;

  const { images, videos, meta } = extractPostJsonLd(html);
  assert.equal(images.length, 12);
  assert.ok(images[0].url.includes("/A0/") && images[11].url.includes("/A11/"));
  assert.ok(!images.some((i) => i.url.includes("COMMENTER")));
  assert.equal(videos.length, 0);
  assert.equal(meta.author, "Jane Doe");
  assert.equal(meta.headline, "Linux permissions cheat sheet");
  assert.equal(meta.published, "2026-09-20T10:00:00.000Z");
});

test("reads post text, author profile, avatar, stats and canonical URL", () => {
  const post = {
    "@type": "SocialMediaPosting",
    "@id": "https://www.linkedin.com/posts/jane_topic-activity-1-AbC",
    articleBody: "Line one\nLine two https://lnkd.in/abcDEF12",
    author: {
      name: "Jane Doe",
      url: "https://in.linkedin.com/in/jane",
      image: { url: "https://media.licdn.com/dms/image/v2/X/profile-displayphoto-scale_200_200/B/0/1" },
    },
    interactionStatistic: [
      { interactionType: "http://schema.org/LikeAction", userInteractionCount: 901 },
      { interactionType: "https://schema.org/CommentAction", userInteractionCount: 17 },
    ],
  };
  const { meta } = extractPostJsonLd(`<script type="application/ld+json">${JSON.stringify(post)}</script>`);
  assert.equal(meta.text, "Line one\nLine two https://lnkd.in/abcDEF12");
  assert.equal(meta.authorUrl, "https://in.linkedin.com/in/jane");
  assert.match(meta.avatar, /^https:\/\/media\.licdn\.com\//);
  assert.equal(meta.likes, 901);
  assert.equal(meta.comments, 17);
  assert.equal(meta.url, post["@id"]);
});

test("drops author, avatar and post URLs that are not on LinkedIn hosts", () => {
  const post = {
    "@type": "SocialMediaPosting",
    "@id": "javascript:alert(1)",
    author: { name: "X", url: "https://evil.example/in/x", image: { url: "https://evil.example/a.jpg" } },
  };
  const { meta } = extractPostJsonLd(`<script type="application/ld+json">${JSON.stringify(post)}</script>`);
  assert.equal(meta.url, undefined);
  assert.equal(meta.authorUrl, undefined);
  assert.equal(meta.avatar, undefined);
});

test("extracts outbound links from the commentary, unwrapping LinkedIn redirects", () => {
  const redir = (u) => `https://www.linkedin.com/redir/redirect?url=${encodeURIComponent(u)}&amp;urlhash=x&amp;trk=public_post-text`;
  const html = `
    <a href="${redir("https://unrelated.example")}">before commentary</a>
    <p class="x" data-test-id="main-feed-activity-card__commentary">
      Shop: <a href="${redir("http://devopsstore.online")}">devopsstore.online</a>
      Guide: <a href="${redir("https://lnkd.in/dfsCPgBE")}">https://lnkd.in/dfsCPgBE</a>
      <a href="https://www.linkedin.com/signup/cold-join?session_redirect=x">#Linux</a>
      <a href="${redir("javascript:alert(1)")}">bad</a>
    </p>
    <a href="${redir("https://more-posts.example")}">after</a>`;
  const text = "Guide: https://lnkd.in/dfsCPgBE. Docs (https://docs.example.com/path).";

  assert.deepEqual(extractPostLinks(html, text), [
    { url: "http://devopsstore.online/", label: "devopsstore.online" },
    { url: "https://lnkd.in/dfsCPgBE", label: "https://lnkd.in/dfsCPgBE" },
    { url: "https://docs.example.com/path", label: "https://docs.example.com/path" },
  ]);
});

test("recognises lnkd.in short links and reads their destination", () => {
  assert.equal(cleanLink("https://lnkd.in/abcd?trk=public_post-text"), "https://lnkd.in/abcd");
  assert.equal(cleanLink("http://shop.example/?q=1&trk=x"), "http://shop.example/?q=1");
  assert.equal(cleanLink("javascript:alert(1)"), undefined);
  assert.equal(shortLinkCode("https://lnkd.in/dfsCPgBE"), "dfsCPgBE");
  assert.equal(shortLinkCode("https://lnkd.in/a/b"), null);
  assert.equal(shortLinkCode("https://lnkd.in.evil.example/abcd"), null);
  assert.equal(shortLinkCode("https://example.com/abcd"), null);

  const page = `<a href="https://www.linkedin.com/help/x">help</a><a href="https://www.instagram.com/devops?x=1&amp;y=2">go</a>`;
  assert.equal(shortLinkTarget(page), "https://www.instagram.com/devops?x=1&y=2");
  assert.equal(shortLinkTarget(`<a href="javascript:alert(1)">x</a>`), undefined);
});

test("reads videos from JSON-LD VideoObject nodes", () => {
  const video = {
    "@type": "VideoObject",
    contentUrl: "https://dms.licdn.com/playlist/vid/v2/VID1/mp4-720p-30fp-crf28/B/0/1?e=1&t=y",
  };
  const { videos } = extractPostJsonLd(`<script type="application/ld+json">${JSON.stringify(video)}</script>`);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].variant, "mp4-720p-30fp-crf28");
});

test("reads the embed page's hidden-image overlay count", () => {
  assert.equal(hiddenImageCount('<span class="overlay">\n  +7\n  </span>'), 7);
  assert.equal(hiddenImageCount("<p>C++ 20</p>"), 0);
});

test("returns nothing when the page has no JSON-LD", () => {
  assert.deepEqual(extractPostJsonLd("<html></html>"), { images: [], videos: [], meta: {} });
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
