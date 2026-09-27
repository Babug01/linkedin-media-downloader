const form = document.querySelector("#form");
const input = document.querySelector("#url");
const submit = document.querySelector("#submit");
const statusEl = document.querySelector("#status");
const results = document.querySelector("#results");
const summary = document.querySelector("#summary");
const grid = document.querySelector("#grid");
const downloadAllButton = document.querySelector("#download-all");

const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4" };
let items = [];

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

async function download(item) {
  try {
    const response = await fetch(item.url, { credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = `${item.name}.${EXTENSIONS[blob.type] ?? item.fallbackExt}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  } catch {
    // CDN refused a cross-origin read; opening it lets the user save it manually.
    window.open(item.url, "_blank", "noopener,noreferrer");
  }
}

function card(item) {
  const figure = document.createElement("figure");
  figure.className = "card";

  const preview = document.createElement(item.kind === "video" ? "video" : "img");
  preview.src = item.url;
  preview.referrerPolicy = "no-referrer";
  if (item.kind === "video") {
    preview.controls = true;
    preview.preload = "metadata";
  } else {
    preview.alt = item.label;
    preview.loading = "lazy";
  }

  const caption = document.createElement("figcaption");
  const label = document.createElement("span");
  label.textContent = item.label;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Download";
  button.addEventListener("click", async () => {
    button.disabled = true;
    await download(item);
    button.disabled = false;
  });

  caption.append(label, button);
  figure.append(preview, caption);
  return figure;
}

function render(data) {
  const base = `linkedin-${data.post.id}`;
  items = [
    ...data.videos.map((v, i) => ({
      kind: "video", url: v.url, fallbackExt: "mp4",
      name: `${base}-video-${i + 1}`, label: `Video ${i + 1}${v.variant ? ` · ${v.variant.split("-")[1]}` : ""}`,
    })),
    ...data.images.map((img, i) => ({
      kind: "image", url: img.url, fallbackExt: "jpg",
      name: `${base}-image-${i + 1}`, label: `Image ${i + 1}`,
    })),
  ];

  const parts = [];
  if (data.images.length) parts.push(plural(data.images.length, "image"));
  if (data.videos.length) parts.push(plural(data.videos.length, "video"));
  summary.textContent = `Found ${parts.join(" and ")}`;
  downloadAllButton.hidden = items.length < 2;
  grid.replaceChildren(...items.map(card));
  results.hidden = false;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = input.value.trim();
  if (!value) return setStatus("Paste a LinkedIn post URL first.", true);

  results.hidden = true;
  grid.replaceChildren();
  submit.disabled = true;
  setStatus("Fetching post…");
  try {
    const response = await fetch(`/api/extract?url=${encodeURIComponent(value)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return setStatus(data.error ?? `Request failed (HTTP ${response.status}).`, true);
    setStatus("");
    render(data);
  } catch {
    setStatus("Network error. Check your connection and try again.", true);
  } finally {
    submit.disabled = false;
  }
});

downloadAllButton.addEventListener("click", async () => {
  downloadAllButton.disabled = true;
  for (const item of items) {
    await download(item);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  downloadAllButton.disabled = false;
});
