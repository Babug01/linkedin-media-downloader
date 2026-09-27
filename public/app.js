import { createZip } from "./zip.js";

const $ = (selector) => document.querySelector(selector);
const form = $("#form");
const input = $("#url");
const submit = $("#submit");
const pasteButton = $("#paste");
const skeleton = $("#skeleton");
const results = $("#results");
const grid = $("#grid");
const zipButton = $("#download-all");
const progress = $("#progress");
const progressBar = $("#progress-bar");
const progressText = $("#progress-text");
const lightbox = $("#lightbox");
const stage = lightbox.querySelector(".lb-stage");
const lbCaption = $("#lb-caption");

const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4" };
const ZIP_CONCURRENCY = 4;
let items = [];
let postId = "";
let current = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toast(message, kind = "info") {
  const node = el("div", `toast ${kind}`, message);
  $("#toasts").append(node);
  setTimeout(() => node.classList.add("leaving"), 4200);
  setTimeout(() => node.remove(), 4700);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function fetchMedia(item) {
  const response = await fetch(item.url, { credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  return { blob, filename: `${item.name}.${EXTENSIONS[blob.type] ?? item.fallbackExt}` };
}

function saveBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const link = el("a");
  link.href = href;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

async function downloadOne(item, button) {
  button?.classList.add("busy");
  try {
    const { blob, filename } = await fetchMedia(item);
    saveBlob(blob, filename);
    button?.classList.add("done");
    setTimeout(() => button?.classList.remove("done"), 1600);
  } catch {
    // CDN refused a cross-origin read; opening it lets the user save it manually.
    window.open(item.url, "_blank", "noopener,noreferrer");
  } finally {
    button?.classList.remove("busy");
  }
}

function setProgress(done, total, label) {
  progressBar.style.setProperty("--value", total ? done / total : 0);
  progressText.textContent = label ?? `${done} / ${total}`;
}

async function downloadZip() {
  zipButton.disabled = true;
  progress.hidden = false;
  setProgress(0, items.length, `Fetching 0 / ${items.length}`);

  const files = new Array(items.length);
  let next = 0;
  let finished = 0;
  let failed = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        const { blob, filename } = await fetchMedia(items[index]);
        files[index] = { name: filename, data: new Uint8Array(await blob.arrayBuffer()) };
      } catch {
        failed++;
      }
      finished++;
      setProgress(finished, items.length, `Fetching ${finished} / ${items.length}`);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(ZIP_CONCURRENCY, items.length) }, worker));
    const ok = files.filter(Boolean);
    if (!ok.length) throw new Error("none");
    setProgress(1, 1, "Building ZIP…");
    saveBlob(createZip(ok), `linkedin-${postId}-media.zip`);
    setProgress(1, 1, `Saved ${plural(ok.length, "file")}`);
    toast(failed ? `ZIP saved with ${ok.length} of ${items.length} files (${failed} failed).` : `ZIP saved — ${plural(ok.length, "file")}.`, failed ? "warn" : "success");
  } catch {
    toast("Couldn't build the ZIP. Try downloading files individually.", "error");
    progress.hidden = true;
  } finally {
    zipButton.disabled = false;
    setTimeout(() => (progress.hidden = true), 3500);
  }
}

function previewNode(item, full = false) {
  const node = el(item.kind === "video" ? "video" : "img");
  node.src = item.url;
  node.referrerPolicy = "no-referrer";
  if (item.kind === "video") {
    node.controls = full;
    node.muted = !full;
    node.playsInline = true;
    node.preload = "metadata";
  } else {
    node.alt = item.label;
    node.decoding = "async";
    if (!full) node.loading = "lazy";
  }
  return node;
}

function card(item, index) {
  const figure = el("figure", "card");
  figure.style.setProperty("--i", index);

  const open = el("button", "card-media");
  open.type = "button";
  open.setAttribute("aria-label", `Preview ${item.label}`);
  const media = previewNode(item);
  media.addEventListener(item.kind === "video" ? "loadeddata" : "load", () => figure.classList.add("loaded"), { once: true });
  open.append(media, el("span", "card-index", String(index + 1)));
  if (item.kind === "video") open.append(el("span", "play", "▶"));
  open.addEventListener("click", () => openLightbox(index));

  const caption = el("figcaption");
  caption.append(el("span", "card-label", item.label));
  const button = el("button", "icon-btn download");
  button.type = "button";
  button.setAttribute("aria-label", `Download ${item.label}`);
  button.append($("#download-icon").content.cloneNode(true));
  button.addEventListener("click", () => downloadOne(item, button));
  caption.append(button);

  figure.append(open, caption);
  return figure;
}

function formatDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.valueOf()) ? date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
}

function render(data) {
  postId = data.post.id;
  const base = `linkedin-${postId}`;
  items = [
    ...data.videos.map((v, i) => ({
      kind: "video", url: v.url, fallbackExt: "mp4", name: `${base}-video-${i + 1}`,
      label: `Video ${i + 1}${v.variant ? ` · ${v.variant.split("-")[1]}` : ""}`,
    })),
    ...data.images.map((img, i) => ({
      kind: "image", url: img.url, fallbackExt: "jpg", name: `${base}-image-${String(i + 1).padStart(2, "0")}`,
      label: `Image ${i + 1}`,
    })),
  ];

  const meta = data.meta ?? {};
  $("#author").textContent = [meta.author, formatDate(meta.published)].filter(Boolean).join(" · ") || "LinkedIn post";
  $("#headline").textContent = meta.headline ?? "";
  const chips = $("#chips");
  chips.replaceChildren();
  if (data.images.length) chips.append(el("span", "chip", plural(data.images.length, "image")));
  if (data.videos.length) chips.append(el("span", "chip", plural(data.videos.length, "video")));

  if (data.missing) {
    toast(`LinkedIn only returned ${plural(data.images.length, "image")} (${data.missing} more hidden). Try again in a moment for the full set.`, "warn");
  }

  grid.replaceChildren(...items.map(card));
  results.hidden = false;
  results.classList.remove("reveal");
  void results.offsetWidth;
  results.classList.add("reveal");
}

function showSkeleton(show) {
  skeleton.hidden = !show;
  if (show && !skeleton.childElementCount) {
    skeleton.append(...Array.from({ length: 6 }, (_, i) => {
      const node = el("div", "card skeleton-card");
      node.style.setProperty("--i", i);
      return node;
    }));
  }
}

function openLightbox(index) {
  current = (index + items.length) % items.length;
  const item = items[current];
  const media = previewNode(item, true);
  stage.replaceChildren(media);
  lbCaption.textContent = `${item.label} · ${current + 1} of ${items.length}`;
  lightbox.classList.toggle("single", items.length < 2);
  if (!lightbox.open) lightbox.showModal();
}

lightbox.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "close" || event.target === lightbox) lightbox.close();
  else if (action === "prev") openLightbox(current - 1);
  else if (action === "next") openLightbox(current + 1);
  else if (action === "download") downloadOne(items[current], event.target);
});

lightbox.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") openLightbox(current - 1);
  if (event.key === "ArrowRight") openLightbox(current + 1);
  if (event.key === "Escape") lightbox.close();
});

lightbox.addEventListener("close", () => stage.replaceChildren());

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = input.value.trim();
  if (!value) {
    form.classList.remove("shake");
    void form.offsetWidth;
    form.classList.add("shake");
    return toast("Paste a LinkedIn post URL first.", "error");
  }
  if (submit.classList.contains("loading")) return;

  results.hidden = true;
  submit.classList.add("loading");
  submit.disabled = true;
  showSkeleton(true);
  try {
    const response = await fetch(`/api/extract?url=${encodeURIComponent(value)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return toast(data.error ?? `Request failed (HTTP ${response.status}).`, "error");
    render(data);
  } catch {
    toast("Network error. Check your connection and try again.", "error");
  } finally {
    showSkeleton(false);
    submit.classList.remove("loading");
    submit.disabled = false;
  }
});

pasteButton.addEventListener("click", async () => {
  try {
    input.value = (await navigator.clipboard.readText()).trim();
    input.focus();
    if (input.value) form.requestSubmit();
  } catch {
    toast("Clipboard access was blocked — paste with Ctrl+V instead.", "warn");
  }
});

zipButton.addEventListener("click", downloadZip);

document.addEventListener("pointermove", (event) => {
  document.documentElement.style.setProperty("--mx", `${event.clientX}px`);
  document.documentElement.style.setProperty("--my", `${event.clientY}px`);
}, { passive: true });
