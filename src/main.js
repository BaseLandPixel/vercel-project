import { ethers } from "ethers";
import { attachContract } from "./lib/attachContract.js";
import { mintTile } from "./ui/buyHandler.js";
import { handleGlobalError } from "./utils/globalErrorHandlers.js";
import { CHAIN, makeFallbackProvider } from "./config/contractConfig.js";
import { fetchNFTsForAddress } from "./services/nftService.js";
import { MapController } from "./controllers/MapController.js";

function getMiniSdk() {
  try {
    return (
      (window?.farcaster?.mini && window.farcaster.mini.sdk) ||
      window?.farcaster?.sdk ||
      window?.miniapp?.sdk ||
      window?.sdk ||
      null
    );
  } catch {
    return null;
  }
}

let __miniReadySent = false;
async function miniReady() {
  if (__miniReadySent) return;
  __miniReadySent = true;
  try {
    const s = getMiniSdk();
    if (s && s.actions && typeof s.actions.ready === "function") {
      try {
        const r = s.actions.ready();
        if (r && typeof r.then === "function") await r;
      } catch {}
    }
  } catch {}
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "FARCASTER_MINIAPP_READY" }, "*");
      window.parent.postMessage({ type: "FC_MINIAPP_READY" }, "*");
      window.parent.postMessage({ type: "warpcast_miniapp_ready" }, "*");
      window.parent.postMessage({ type: "miniapp_ready" }, "*");
      window.parent.postMessage("ready", "*");
    }
  } catch {}
}

const IS_TOUCH = (("ontouchstart" in window) || matchMedia("(pointer: coarse)").matches);

const CONTRACT_ADDRESS = "0xdD7bEC58d509C5F42DeA2b05684e0bE2e1b3C12a";
const ABI = [
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function mintPrice() view returns (uint256)",
  "event Minted(address indexed to, uint256 indexed tokenId, uint16 x, uint16 y, uint256 seed)"
];

const publicProvider = makeFallbackProvider();
const readOnly = new ethers.Contract(CONTRACT_ADDRESS, ABI, publicProvider);

const SOLD_IMG_URL = "https://rosebud.ai/assets/Base_Logo_1.png?WWz6";
let soldImg = null;
let soldImgReady = false;
let logoTiles = new Set();
function tileId(x, y) { return x * 100 + y; }
function preloadSoldImage() {
  return new Promise((resolve) => {
    if (soldImgReady && soldImg) return resolve(soldImg);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = SOLD_IMG_URL + (SOLD_IMG_URL.includes("?") ? "&" : "?") + "v=" + Date.now();
    img.onload = () => { soldImg = img; soldImgReady = true; resolve(img); };
    img.onerror = () => resolve(null);
  });
}

const IMAGE_CACHE_KEY = "baseland_image_cache_v1";
let imageCachePersist = {};
try { imageCachePersist = JSON.parse(localStorage.getItem(IMAGE_CACHE_KEY) || "{}"); } catch {}
function setCachedImage(tokenId, url) {
  imageCachePersist[tokenId] = url || null;
  try { localStorage.setItem(IMAGE_CACHE_KEY, JSON.stringify(imageCachePersist)); } catch {}
}
function getCachedImage(tokenId) {
  return imageCachePersist?.[tokenId] || null;
}
function hydrateFromCache() {
  for (const [idStr, url] of Object.entries(imageCachePersist)) {
    const id = Number(idStr);
    const x = Math.floor(id / GRID_SIZE), y = id % GRID_SIZE;
    ownedSet.add(id);
    if (url) {
      loadImage(url).then((img) => {
        if (img) tileImages.set(id, img);
        drawGrid();
      });
    } else {
      logoTiles.add(id);
    }
  }
}

const PLACEHOLDER_HINTS = ["placeholder", "unrevealed", "pre-reveal", "prereveal"];
function isPlaceholderUrl(u) {
  if (!u) return true;
  const s = String(u).toLowerCase();
  return PLACEHOLDER_HINTS.some(h => s.includes(h));
}
async function refreshPendingReveals() {
  const pending = [...ownedSet].filter((id) => {
    const cachedUrl = getCachedImage(id);
    return !tileImages.has(id) || !cachedUrl || isPlaceholderUrl(cachedUrl);
  });
  if (!pending.length) return;
  const limit = pLimit(6);
  await Promise.allSettled(
    pending.map(id => limit(async () => {
      const meta = await fetchTokenMetadata(id).catch(() => null);
      const newUrl = meta?.imageUrl || null;
      if (newUrl && !isPlaceholderUrl(newUrl) && newUrl !== getCachedImage(id)) {
        setCachedImage(id, newUrl);
        const img = await loadImage(newUrl);
        if (img) {
          tileImages.set(id, img);
          logoTiles.delete(id);
          drawGrid();
        }
      }
    }))
  );
}

const tileImages = new Map();
const imageCache = new Map();
async function loadImage(url) {
  if (!url) return null;
  const cachedImg = imageCache.get(url);
  if (cachedImg) return cachedImg;
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.src = url;
    img.onload = () => { imageCache.set(url, img); resolve(img); };
    img.onerror = () => resolve(null);
  });
}

function resolveIPFS(u) {
  if (!u) return u;
  if (u.startsWith("ipfs://")) {
    const path = u.replace("ipfs://", "");
    return `https://ipfs.io/ipfs/${path}`;
  }
  return String(u).trim().replace(/^"+|"+$/g, "");
}
function toERC1155Hex(tokenId) {
  let hex = BigInt(tokenId).toString(16);
  if (hex.length < 64) hex = hex.padStart(64, "0");
  return hex.toLowerCase();
}
function parseMaybeBase64Json(uri) {
  try {
    if (typeof uri !== "string") return null;
    if (uri.startsWith("data:application/json")) {
      const base64 = uri.split(",")[1] || "";
      const jsonStr = atob(base64);
      return JSON.parse(jsonStr);
    }
  } catch (_) {}
  return null;
}
async function fetchJson(url) {
  const inline = parseMaybeBase64Json(url);
  if (inline) return inline;
  const res = await fetch(url, { cache: "no-store" });
  return await res.json();
}

async function fetchTokenMetadata(tokenId) {
  try {
    if (cached.contract && typeof cached.contract.tokenURI === "function") {
      const uri = await cached.contract.tokenURI(tokenId);
      const url = resolveIPFS(uri);
      const json = await fetchJson(url).catch(() => null);
      if (json) {
        const imageUrl = resolveIPFS(json.image || json.image_url);
        return { imageUrl, raw: json, source: "erc721:tokenURI" };
      }
    }
  } catch (_) {}
  try {
    if (cached.contract && typeof cached.contract.uri === "function") {
      let uri = await cached.contract.uri(tokenId);
      if (uri && uri.includes("{id}")) uri = uri.replace("{id}", toERC1155Hex(tokenId));
      const url = resolveIPFS(uri);
      const json = await fetchJson(url).catch(() => null);
      if (json) {
        const imageUrl = resolveIPFS(json.image || json.image_url);
        return { imageUrl, raw: json, source: "erc1155:uri" };
      }
    }
  } catch (_) {}
  try {
    const uri = await readOnly.tokenURI(tokenId);
    const url = resolveIPFS(uri);
    const json = await fetchJson(url).catch(() => null);
    if (json) {
      const imageUrl = resolveIPFS(json.image || json.image_url);
      return { imageUrl, raw: json, source: "readonly:tokenURI" };
    }
  } catch (_) {}
  try {
    if (cached.address) {
      const list = await fetchNFTsForAddress(cached.address);
      const hit = (list || []).find(n => String(n.tokenId) === String(tokenId));
      if (hit?.imageUrl) return { imageUrl: resolveIPFS(hit.imageUrl), raw: hit, source: "wallet:list" };
    }
  } catch (_) {}
  return { imageUrl: null, raw: null, source: "none" };
}

const GRID_SIZE = 100;
const PALETTE = { owned: "#1652F0", empty: "#111111", line: "#FFFFFF" };

let bgCanvas, bgCtx;
let canvas, ctx;
let width = 800, height = 800;
let scale = 1;
let originX = 0, originY = 0;
let tilePx = 8;
let ownedSet = new Set();
let selected = null;
let hoverTile = null;
let hasCentered = false;
let initialZoomApplied = false;
let mapController = null;

const AUTOPAN_ENABLED = true;
let AUTOPAN_FACTOR = 0.015;

let walletBtn, buyModal, buyBtn, closeModalBtn, coordLabel, priceLabel, statusEl;
let cached = { provider: null, signer: null, contract: null, address: null, chainId: null, mintPrice: null };

let audioBtn, audioEl;
const AUDIO_STORAGE_KEY = "baseland_audio_on";
let audioOn = true;
let audioFading = false;

let walletContainerEl, walletDropdownEl, collectionsBtnEl, collectionsPanelEl, collectionsContentEl, closeCollectionsEl;
let dropdownOpen = false;
let dropdownCloseTimer = null;
const DROPDOWN_CLOSE_DELAY = 250;

function isMiniAppLaunch() {
  try {
    const url = new URL(window.location.href);
    const host = window?.parent !== window ? document.referrer : "";
    return (
      url.pathname.startsWith("/mini") ||
      url.searchParams.get("miniApp") === "true" ||
      /farcaster|warpcast|miniapp/i.test(host)
    );
  } catch {
    return false;
  }
}

(function earlyMiniReadyKick() {
  try {
    const url = new URL(window.location.href);
    const inIframe = window.self !== window.top;
    const isDevMini = inIframe || url.searchParams.get("miniApp") === "true" || url.searchParams.has("launchFrameUrl");
    if (!isDevMini) return;
    function sendAllReadySignals() {
      try {
        const sdk = getMiniSdk();
        if (sdk?.actions?.ready) {
          try {
            const r = sdk.actions.ready();
            if (r && typeof r.then === "function") {
              r.then(() => {}).catch(() => {});
            }
          } catch {}
        }
      } catch {}
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: "FARCASTER_MINIAPP_READY" }, "*");
          window.parent.postMessage({ type: "FC_MINIAPP_READY" }, "*");
          window.parent.postMessage({ type: "warpcast_miniapp_ready" }, "*");
          window.parent.postMessage({ type: "miniapp_ready" }, "*");
          window.parent.postMessage("ready", "*");
        }
      } catch {}
    }
    sendAllReadySignals();
    setTimeout(sendAllReadySignals, 60);
    setTimeout(sendAllReadySignals, 300);
    setTimeout(sendAllReadySignals, 1200);
  } catch (_) {}
})();

function setAudioButtonIcon() {
  if (!audioBtn) return;
  audioBtn.textContent = audioOn ? "🔊" : "🔈";
}

function fadeAudio(to, duration = 400) {
  if (!audioEl) return Promise.resolve();
  audioFading = true;
  const from = audioEl.volume;
  const start = performance.now();
  return new Promise((resolve) => {
    function step(t) {
      const k = Math.min(1, (t - start) / duration);
      audioEl.volume = from + (to - from) * k;
      if (k < 1) requestAnimationFrame(step);
      else {
        audioFading = false;
        resolve();
      }
    }
    requestAnimationFrame(step);
  });
}

async function startAudio() {
  if (!audioEl) return;
  try {
    if (!audioFading) audioEl.volume = 0.15;
    await audioEl.play();
  } catch (_) {}
}

async function stopAudio() {
  if (!audioEl) return;
  await fadeAudio(0.0, 250);
  audioEl.pause();
}

async function toggleAudio() {
  audioOn = !audioOn;
  localStorage.setItem(AUDIO_STORAGE_KEY, audioOn ? "1" : "0");
  setAudioButtonIcon();
  if (audioOn) {
    if (audioEl.paused) {
      audioEl.muted = false;
      audioEl.volume = 0.15;
      await startAudio();
    }
    await fadeAudio(0.15, 300);
  } else {
    await stopAudio();
  }
}

async function tryAutoplayOnLoad() {
  if (!audioEl) return;
  if (localStorage.getItem(AUDIO_STORAGE_KEY) === null) {
    audioOn = true;
  } else {
    audioOn = localStorage.getItem(AUDIO_STORAGE_KEY) !== "0";
  }
  setAudioButtonIcon();
  if (!audioOn) return;
  audioEl.muted = false;
  audioEl.volume = 0.15;
  const playPromise = audioEl.play();
  if (playPromise && typeof playPromise.then === "function") {
    playPromise.catch(() => {});
  }
}

async function ensureAudioUnlocked() {
  if (!audioEl || !audioOn) return;
  if (audioEl.paused) {
    try {
      audioEl.muted = false;
      audioEl.volume = 0.15;
      await startAudio();
      await fadeAudio(0.15, 250);
    } catch (_) {}
  }
}

async function hardAutoplay() {
  if (!audioEl) return;
  audioEl.autoplay = true;
  audioEl.loop = true;
  audioEl.muted = false;
  audioEl.volume = 0.15;
  try { await audioEl.play(); } catch (_) {}
}

const GALAXY = {
  layers: [
    { speed: 0.08, density: 0.00012, size: 2 },
    { speed: 0.14, density: 0.00009, size: 2 },
    { speed: 0.20, density: 0.00006, size: 3 }
  ],
  stars: [],
  drift: { x: 0, y: 0 },
  lastTime: 0
};

function seedStars() {
  GALAXY.stars = GALAXY.layers.map((layer) => {
    const area = (width * height) * 3;
    const count = Math.max(50, Math.floor(area * layer.density));
    const arr = [];
    for (let i = 0; i < count; i++) {
      const x = Math.random() * width * 3 - width;
      const y = Math.random() * height * 3 - height;
      const palettePick = Math.random();
      const c = palettePick < 0.75 ? "#FFFFFF" : (palettePick < 0.9 ? "#CCCCCC" : "#1652F0");
      arr.push({ x, y, c, size: layer.size });
    }
    return arr;
  });
}

function drawGalaxy(t) {
  if (!bgCtx) return;
  bgCtx.clearRect(0, 0, width, height);
  const dt = GALAXY.lastTime ? (t - GALAXY.lastTime) / 1000 : 0;
  GALAXY.lastTime = t;
  GALAXY.drift.x += dt * 5;
  GALAXY.drift.y += dt * 2;
  bgCtx.fillStyle = "#111111";
  bgCtx.fillRect(0, 0, width, height);
  GALAXY.layers.forEach((layer, li) => {
    const stars = GALAXY.stars[li] || [];
    const parX = originX * layer.speed + GALAXY.drift.x * layer.speed;
    const parY = originY * layer.speed + GALAXY.drift.y * layer.speed;
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      const sx = ((s.x + parX) % (width * 3) + (width * 3)) % (width * 3) - width;
      const sy = ((s.y + parY) % (height * 3) + (height * 3)) % (height * 3) - height;
      bgCtx.fillStyle = s.c;
      const px = Math.floor(sx);
      const py = Math.floor(sy);
      const size = s.size;
      bgCtx.fillRect(px, py, size, size);
    }
  });
}

function showToast(msg, type = "info") {
  if (!statusEl) return;
  statusEl.textContent = msg || "";
  statusEl.dataset.type = type;
}
function short(addr) {
  return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "";
}
function setModal(open) {
  if (!buyModal) return;
  buyModal.style.display = open ? "flex" : "none";
}

function markTileAsOwned(x, y, imageUrl = null) {
  const id = tileId(x, y);
  ownedSet.add(id);
  if (imageUrl) {
    setCachedImage(id, imageUrl);
    loadImage(imageUrl).then((img) => {
      if (img) tileImages.set(id, img);
      drawGrid();
    });
  } else {
    setCachedImage(id, null);
    logoTiles.add(id);
    preloadSoldImage().then(() => drawGrid());
  }
}

function openLink(url) {
  try { window.open(url, "_blank", "noopener,noreferrer"); } catch {}
}

function centerGrid() {
  const worldW = GRID_SIZE * tilePx;
  const worldH = GRID_SIZE * tilePx;
  originX = Math.floor((width  - worldW) / 2);
  originY = Math.floor((height - worldH) / 2);
}

function applyInitialZoom(desiredTiles = 30) {
  const pxPerTileFitW = width / desiredTiles;
  const pxPerTileFitH = height / desiredTiles;
  const targetPxPerTile = Math.min(pxPerTileFitW, pxPerTileFitH);
  const targetScale = Math.min(6, Math.max(0.5, targetPxPerTile / 8));
  scale = targetScale;
  tilePx = Math.max(4, Math.floor(8 * scale));
  centerGrid();
}
function initMapController() {
  if (mapController) {
    mapController.unbind();
  }
  mapController = new MapController(canvas, {
    scale,
    originX,
    originY,
    onPan: (x, y) => {
      originX = x;
      originY = y;
      clampPan();
      drawGrid();
    },
    onZoom: (s, x, y) => {
      scale = s;
      originX = x;
      originY = y;
      tilePx = Math.max(4, Math.floor(8 * scale));
      clampPan();
      drawGrid();
      mapController.updateState(scale, originX, originY);
    },
    onTap: (sx, sy) => {
      const { x, y } = screenToTile(sx, sy);
      if (x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE) {
        selected = { x, y };
        drawGrid();
        openBuyModal(x, y);
      }
    }
  });
}
function resizeCanvas() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  width  = (rect.width  && rect.width  > 10) ? rect.width  : (window.innerWidth  || 800);
  height = (rect.height && rect.height > 10) ? rect.height : (window.innerHeight || 800);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  bgCanvas.width = Math.floor(width * dpr);
  bgCanvas.height = Math.floor(height * dpr);
  bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  tilePx = Math.max(4, Math.floor(8 * scale));
  if (!initialZoomApplied) {
    applyInitialZoom(30);
    initialZoomApplied = true;
    hasCentered = true;
    seedStars();
  } else if (!hasCentered) {
    centerGrid();
    hasCentered = true;
  } else {
    clampPan();
  }
  drawGrid();
  drawGalaxy(performance.now());
}

function drawGrid() {
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = PALETTE.empty;
  ctx.fillRect(0, 0, width, height);
  tilePx = Math.max(4, Math.floor(8 * scale));
  const startX = Math.max(0, Math.floor(-originX / tilePx));
  const startY = Math.max(0, Math.floor(-originY / tilePx));
  const endX = Math.min(GRID_SIZE - 1, Math.ceil((width - originX) / tilePx));
  const endY = Math.min(GRID_SIZE - 1, Math.ceil((height - originY) / tilePx));

  ctx.save();
  for (let x = startX; x <= endX; x++) {
    for (let y = startY; y <= endY; y++) {
      const id = x * 100 + y;
      if (ownedSet.has(id)) {
        const px = originX + x * tilePx;
        const py = originY + y * tilePx;

        const nftImg = tileImages.get(id);
        if (nftImg) {
          const ratio = Math.min(tilePx / nftImg.width, tilePx / nftImg.height);
          const dw = Math.max(1, Math.floor(nftImg.width * ratio));
          const dh = Math.max(1, Math.floor(nftImg.height * ratio));
          const dx = px + Math.floor((tilePx - dw) / 2);
          const dy = py + Math.floor((tilePx - dh) / 2);
          ctx.fillStyle = "#000000";
          ctx.fillRect(px, py, tilePx, tilePx);
          ctx.drawImage(nftImg, dx, dy, dw, dh);
        } else if (logoTiles.has(id) && soldImgReady && soldImg) {
          ctx.fillStyle = "#000000";
          ctx.fillRect(px, py, tilePx, tilePx);
          const ratio = Math.min(tilePx / soldImg.width, tilePx / soldImg.height);
          const dw = Math.max(1, Math.floor(soldImg.width * ratio));
          const dh = Math.max(1, Math.floor(soldImg.height * ratio));
          const dx = px + Math.floor((tilePx - dw) / 2);
          const dy = py + Math.floor((tilePx - dh) / 2);
          ctx.drawImage(soldImg, dx, dy, dw, dh);
        } else {
          ctx.fillStyle = PALETTE.owned;
          ctx.fillRect(px, py, tilePx, tilePx);
        }
      }
    }
  }
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.25;
  for (let x = startX; x <= endX; x++) {
    for (let y = startY; y <= endY; y++) {
      const id = x * 100 + y;
      if (ownedSet.has(id)) {
        ctx.fillStyle = PALETTE.owned;
        ctx.fillRect(originX + x * tilePx - 1, originY + y * tilePx - 1, tilePx + 2, tilePx + 2);
      }
    }
  }
  ctx.restore();

  ctx.strokeStyle = PALETTE.line;
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (let x = startX; x <= endX; x++) {
    const sx = Math.floor(originX + x * tilePx) + 0.5;
    ctx.moveTo(sx, originY + startY * tilePx);
    ctx.lineTo(sx, originY + (endY + 1) * tilePx);
  }
  for (let y = startY; y <= endY; y++) {
    const sy = Math.floor(originY + y * tilePx) + 0.5;
    ctx.moveTo(originX + startX * tilePx, sy);
    ctx.lineTo(originX + (endX + 1) * tilePx, sy);
  }
  ctx.stroke();

  if (hoverTile) {
    ctx.strokeStyle = "rgba(255,255,255,.75)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(
      originX + hoverTile.x * tilePx + 0.5,
      originY + hoverTile.y * tilePx + 0.5,
      tilePx - 1,
      tilePx - 1
    );
  }
  if (selected) {
    ctx.strokeStyle = "#FFFFFF";
    ctx.lineWidth = 2;
    ctx.strokeRect(
      originX + selected.x * tilePx + 1,
      originY + selected.y * tilePx + 1,
      tilePx - 2,
      tilePx - 2
    );
  }
}

function drawAll(t) {
  drawGalaxy(t);
  drawGrid();
}
function hookPointerEvents() {
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse") {
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      if (AUTOPAN_ENABLED) {
        const dxCenter = cx - width / 2;
        const dyCenter = cy - height / 2;
        originX -= dxCenter * AUTOPAN_FACTOR;
        originY -= dyCenter * AUTOPAN_FACTOR;
        clampPan();
      }
      const { x, y } = screenToTile(cx, cy);
      if (x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE) {
        if (!hoverTile || hoverTile.x !== x || hoverTile.y !== y) {
          hoverTile = { x, y };
          drawGrid();
        }
      } else if (hoverTile) {
        hoverTile = null;
        drawGrid();
      }
    }
  });
  canvas.addEventListener("pointerleave", () => {
    if (hoverTile) {
      hoverTile = null;
      drawGrid();
    }
  });
  canvas.addEventListener("pointerdown", async () => {
    await ensureAudioUnlocked();
  }, { once: true });
}
function clampPan() {
  const worldW = GRID_SIZE * tilePx;
  const worldH = GRID_SIZE * tilePx;
  if (worldW <= width) {
    originX = Math.floor((width - worldW) / 2);
  } else {
    originX = Math.min(0, Math.max(width - worldW, originX));
  }
  if (worldH <= height) {
    originY = Math.floor((height - worldH) / 2);
  } else {
    originY = Math.min(0, Math.max(height - worldH, originY));
  }
}

function screenToTile(sx, sy) {
  const x = Math.floor((sx - originX) / tilePx);
  const y = Math.floor((sy - originY) / tilePx);
  return { x, y };
}
function screenToWorld(sx, sy) { return { wx: originX + sx, wy: originY + sy }; }

async function openBuyModal(x, y) {
  coordLabel.textContent = `(${x}, ${y})`;
  if (cached.mintPrice) {
    priceLabel.textContent = `${ethers.formatEther(cached.mintPrice)} ETH`;
  }
  setModal(true);
}
async function onBuyConfirm() {
  if (!selected) return;
  const { x, y } = selected;
  const ui = {
    setProcessing: (state, msg) => {
      buyBtn.disabled = !!state;
      buyBtn.textContent = state ? "PROCESSING..." : "Buy Now";
      showToast(msg || (state ? "Processing..." : ""), "info");
    },
    success: ({ txHash }) => {
      markTileAsOwned(x, y);
      setModal(false);
      showToast(`Mint successful! (${x},${y})`, "success");
      openLink(`https://base.blockscout.com/tx/${txHash}`);
    },
    error: (m) => showToast(m, "error"),
    showToast
  };
  try {
    await mintTile(x, y, ui);
  } catch (err) {
    handleGlobalError(err, ui);
  }
}

const BASELAND_CONTRACT = "0xdD7bEC58d509C5F42DeA2b05684e0bE2e1b3C12a".toLowerCase();
function sameAddr(a, b) { return (a||"").toLowerCase() === (b||"").toLowerCase(); }

async function hydrateOwnedTilesFor(address) {
  try {
    const nfts = await fetchNFTsForAddress(address);
    const mine = (nfts || []).filter(n => sameAddr(n.contractAddress, BASELAND_CONTRACT));
    for (const n of mine) {
      const tId = Number(n.tokenId);
      const x = Math.floor(tId / GRID_SIZE);
      const y = tId % GRID_SIZE;
      let imgUrl = n.imageUrl || null;
      if (!imgUrl) {
        const meta = await fetchTokenMetadata(tId);
        imgUrl = meta?.imageUrl || null;
      }
      markTileAsOwned(x, y, imgUrl);
    }
    drawGrid();
  } catch (_) {}
}

async function connectWallet() {
  try {
    walletBtn.disabled = true;
    walletBtn.textContent = "CONNECTING...";
    await ensureAudioUnlocked();
    const { provider, signer, contract, address, chainId } = await attachContract();
    if (chainId !== CHAIN.id) throw new Error(`Wrong network. Switch to ${CHAIN.name} (${CHAIN.id}).`);
    cached = { provider, signer, contract, address, chainId, mintPrice: null };
    walletBtn.textContent = short(address) || "Connected";
    walletBtn.disabled = false;
    const price = await contract.mintPrice();
    cached.mintPrice = price;
    priceLabel.textContent = `${ethers.formatEther(price)} ETH`;
    await hydrateOwnedTilesFor(address);
    setupRealtime();
    showToast(`Wallet: ${short(address)} | Network: ${CHAIN.name}`, "success");
    if (walletDropdownEl) walletDropdownEl.style.display = "block";
  } catch (e) {
    walletBtn.textContent = "Connect Wallet";
    walletBtn.disabled = false;
    showToast(e.message || "Wallet connection failed", "error");
  }
}

function setupRealtime() {
  if (!cached.contract) return;
  cached.contract.on("Minted", async (to, tokenId) => {
    await handleMintOrTransfer(to, tokenId);
  });
  try {
    cached.contract.on("Transfer", async (from, to, tokenId) => {
      if (String(from).toLowerCase() === "0x0000000000000000000000000000000000000000") {
        await handleMintOrTransfer(to, tokenId);
      }
    });
  } catch (_) {}
  try {
    cached.contract.on("TransferSingle", async (_op, from, to, id, value) => {
      if (String(from).toLowerCase() === "0x0000000000000000000000000000000000000000" && BigInt(value) > 0n) {
        await handleMintOrTransfer(to, id);
      }
    });
  } catch (_) {}
}

async function handleMintOrTransfer(to, tokenId) {
  try {
    const idNum = Number(tokenId);
    const x = Math.floor(idNum / GRID_SIZE);
    const y = idNum % GRID_SIZE;
    ownedSet.add(idNum);
    const meta = await fetchTokenMetadata(idNum);
    const imgUrl = meta?.imageUrl || null;
    if (imgUrl) {
      setCachedImage(idNum, imgUrl);
      const img = await loadImage(imgUrl);
      if (img) {
        tileImages.set(idNum, img);
      } else {
        logoTiles.add(idNum);
        await preloadSoldImage();
      }
    } else {
      setCachedImage(idNum, null);
      logoTiles.add(idNum);
      await preloadSoldImage();
    }
    drawGrid();
    showToast(`Minted (${x},${y}) → ${short(to)}`, "success");
  } catch (_) {
    const idNum = Number(tokenId);
    ownedSet.add(idNum);
    setCachedImage(idNum, null);
    logoTiles.add(idNum);
    preloadSoldImage().then(() => drawGrid());
    showToast(`Minted · image pending`, "info");
  }
}

function openCollectionsPanel() {
  if (!collectionsPanelEl || !collectionsContentEl) return;
  if (!cached.address) {
    showToast("Please connect your wallet first", "error");
    return;
  }
  collectionsPanelEl.style.transform = "translateX(0)";
  collectionsPanelEl.setAttribute("aria-hidden", "false");
  collectionsContentEl.innerHTML = `<div class="loading-state">Loading NFTs…</div>`;
  fetchNFTsForAddress(cached.address)
    .then((nfts) => renderNFTsIntoPanel(nfts || []))
    .catch(() => { collectionsContentEl.innerHTML = `<div class="error-state">No NFTs found for this wallet.</div>`; });
}
function closeCollectionsPanel() {
  if (!collectionsPanelEl) return;
  collectionsPanelEl.style.transform = "translateX(100%)";
  collectionsPanelEl.setAttribute("aria-hidden", "true");
}
function renderNFTsIntoPanel(nfts) {
  if (!collectionsContentEl) return;
  if (!nfts.length) {
    collectionsContentEl.innerHTML = `<div class="empty-state">No NFTs found for this wallet</div>`;
    return;
  }
  const html = `
    <div class="nft-grid">
      ${nfts.map(nft => {
        const img = nft.imageUrl
          ? `<img src="${nft.imageUrl}" alt="${escapeHtml(nft.tokenName || "NFT")}" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.textContent='🖼️'"/>`
          : `🖼️`;
        const scan = nft.explorerUrl ? `<a href="${nft.explorerUrl}" target="_blank" rel="noopener noreferrer" title="View on BaseScan">🔍 Scan</a>` : "";
        const os   = nft.openseaUrl  ? `<a href="${nft.openseaUrl}"  target="_blank" rel="noopener noreferrer" title="View on OpenSea">🌊 OpenSea</a>` : "";
        return `
          <div class="nft-card">
            <div class="nft-image">${img}</div>
            <div class="nft-info">
              <div class="nft-name" title="${escapeHtml(nft.tokenName || "")}">${escapeHtml(nft.tokenName || "NFT")}</div>
              <div class="nft-collection" title="${escapeHtml(nft.collectionName || "")}">${escapeHtml(nft.collectionName || "")}</div>
              <div class="nft-meta">
                <span title="${nft.contractAddress || ""}">${short(nft.contractAddress || "")}</span>
                <span>#${escapeHtml(String(nft.tokenId ?? ""))}</span>
              </div>
              <div class="nft-links">
                ${scan}${os}
              </div>
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;
  collectionsContentEl.innerHTML = html;
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[s]));
}

function openWalletDropdown() {
  if (!walletDropdownEl) return;
  dropdownOpen = true;
  clearTimeout(dropdownCloseTimer);
  walletDropdownEl.style.display = "block";
  walletDropdownEl.style.opacity = "1";
  walletDropdownEl.style.pointerEvents = "all";
  walletDropdownEl.style.transform = "translateY(0)";
}
function scheduleCloseWalletDropdown() {
  clearTimeout(dropdownCloseTimer);
  dropdownCloseTimer = setTimeout(() => closeWalletDropdown(), DROPDOWN_CLOSE_DELAY);
}
function closeWalletDropdown() {
  if (!walletDropdownEl) return;
  dropdownOpen = false;
  clearTimeout(dropdownCloseTimer);
  walletDropdownEl.style.opacity = "0";
  walletDropdownEl.style.pointerEvents = "none";
  walletDropdownEl.style.transform = "translateY(-4px)";
}

function pLimit(concurrency = 10) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (!queue.length || active >= concurrency) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then((v) => { active--; resolve(v); next(); })
      .catch((e) => { active--; reject(e); next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

async function rpcCallWithRetry(fn, { retries = 4, baseDelay = 400 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > retries) throw err;
      const delay = baseDelay * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 150);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function getLogsBatched(filter, fromBlock, toBlock, step = 200_000n) {
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += step) {
    const end = start + step - 1n > toBlock ? toBlock : start + step - 1n;
    const batchLogs = await rpcCallWithRetry(
      () => publicProvider.getLogs({ ...filter, fromBlock: start, toBlock: end })
    );
    logs.push(...batchLogs);
  }
  return logs;
}

async function loadMintedTilesOnStartup() {
  try {
    const topic = ethers.id("Minted(address,uint256,uint16,uint16,uint256)");
    const filter = { address: CONTRACT_ADDRESS, topics: [topic] };
    const latest = await rpcCallWithRetry(() => publicProvider.getBlockNumber());
    const logs = await getLogsBatched(filter, 0n, BigInt(latest), 200_000n);
    if (!logs.length) return;
    const iface = new ethers.Interface(ABI);
    const limit = pLimit(12);
    const tasks = logs.map((l) => limit(async () => {
      const parsed = iface.parseLog(l);
      const tokenId = Number(parsed.args.tokenId);
      const x = Number(parsed.args.x);
      const y = Number(parsed.args.y);
      const meta = await fetchTokenMetadata(tokenId);
      const imgUrl = meta?.imageUrl || null;
      markTileAsOwned(x, y, imgUrl);
    }));
    await Promise.allSettled(tasks);
    drawGrid();
  } catch (_) {}
}

function bindDOM() {
  function fixIOSVh() {
    const vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty("--vh", `${vh}px`);
  }
  fixIOSVh();
  window.addEventListener("resize", fixIOSVh);

  const bg = document.getElementById("bg");
  const gr = document.getElementById("grid");
  if (bg) {
    bg.style.width = "100vw";
    bg.style.height = "calc(var(--vh, 1vh) * 100)";
  }
  if (gr) {
    gr.style.width = "100vw";
    gr.style.height = "calc(var(--vh, 1vh) * 100)";
  }

  const ensureNonZeroSize = () => {
    const bgr = bg?.getBoundingClientRect?.() || { width: 0, height: 0 };
    const grr = gr?.getBoundingClientRect?.() || { width: 0, height: 0 };
    if (bg && (bgr.width < 10 || bgr.height < 10)) {
      bg.style.width = "100vw";
      bg.style.height = (window.innerHeight || 800) + "px";
    }
    if (gr && (grr.width < 10 || grr.height < 10)) {
      gr.style.width = "100vw";
      gr.style.height = (window.innerHeight || 800) + "px";
    }
  };
  ensureNonZeroSize();
  setTimeout(ensureNonZeroSize, 50);
  setTimeout(ensureNonZeroSize, 300);

  if (isMiniAppLaunch()) {
    document.documentElement.classList.add("miniapp");
    AUTOPAN_FACTOR = 0.008;

    function callMiniReadySafe() {
      try {
        const sdk = getMiniSdk();
        if (sdk?.actions?.ready) {
          try {
            const r = sdk.actions.ready();
            if (r && typeof r.then === "function") {
              r.then(() => {}).catch(() => {});
            }
            return true;
          } catch {
            return false;
          }
        }
      } catch {}
      return false;
    }

    function loadMiniSdkAndReady() {
      const urls = [
        "https://cdn.jsdelivr.net/npm/@farcaster/miniapp-sdk/dist/index.umd.min.js",
        "https://unpkg.com/@farcaster/miniapp-sdk/dist/index.umd.min.js"
      ];
      let i = 0;
      const tryNext = () => {
        if (i >= urls.length) {
          callMiniReadySafe();
          return;
        }
        const s = document.createElement("script");
        s.src = urls[i++];
        s.async = true;
        s.onload = () => { callMiniReadySafe(); };
        s.onerror = () => { tryNext(); };
        document.head.appendChild(s);
      };
      if (!callMiniReadySafe()) tryNext();
    }

    callMiniReadySafe();
    loadMiniSdkAndReady();
    setTimeout(callMiniReadySafe, 80);
    setTimeout(callMiniReadySafe, 300);
    setTimeout(callMiniReadySafe, 1200);
  }

  bgCanvas = document.getElementById("bg");
  bgCtx = bgCanvas.getContext("2d");
  canvas = document.getElementById("grid");
  ctx = canvas.getContext("2d");
  if (canvas) canvas.style.touchAction = "none";
  if (bgCanvas) bgCanvas.style.touchAction = "none";

  walletBtn = document.getElementById("wallet-btn");
  buyModal = document.getElementById("buy-modal");
  buyBtn = document.getElementById("buy-btn");
  closeModalBtn = document.getElementById("close-modal");
  coordLabel = document.getElementById("coord-label");
  priceLabel = document.getElementById("price-label");
  statusEl = document.getElementById("status");

  audioBtn = document.getElementById("audio-btn");
  audioEl = document.getElementById("bg-audio");
  if (audioBtn) audioBtn.addEventListener("click", toggleAudio);
  walletContainerEl = document.getElementById("wallet-container");
  walletDropdownEl = document.getElementById("wallet-dropdown");
  collectionsBtnEl = document.getElementById("collections-btn");
  collectionsPanelEl = document.getElementById("collections-panel");
  collectionsContentEl = document.getElementById("collections-content");
  closeCollectionsEl = document.getElementById("close-collections");

  canvas.classList.add("cursor-crosshair");

  if (localStorage.getItem(AUDIO_STORAGE_KEY) === null) {
    localStorage.setItem(AUDIO_STORAGE_KEY, "1");
    audioOn = true;
  } else {
    audioOn = localStorage.getItem(AUDIO_STORAGE_KEY) !== "0";
  }
  setAudioButtonIcon();
  hardAutoplay();

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && audioOn && audioEl && audioEl.paused) {
      tryAutoplayOnLoad();
    }
  });

  if (walletContainerEl) {
    walletContainerEl.addEventListener("mouseenter", () => {
      if (!cached.address) return;
      openWalletDropdown();
    });
    walletContainerEl.addEventListener("mouseleave", () => {
      scheduleCloseWalletDropdown();
    });
  }
  if (walletDropdownEl) {
    walletDropdownEl.addEventListener("mouseenter", () => {
      clearTimeout(dropdownCloseTimer);
      if (dropdownOpen) openWalletDropdown();
    });
    walletDropdownEl.addEventListener("mouseleave", () => {
      scheduleCloseWalletDropdown();
    });
  }
  if (walletBtn) {
    walletBtn.addEventListener("click", async () => {
      if (!cached.address) {
        await connectWallet();
        if (!cached.address) return;
      }
      if (dropdownOpen) closeWalletDropdown();
      else openWalletDropdown();
    });
  }
  document.addEventListener("click", (e) => {
    if (!walletContainerEl) return;
    if (!walletContainerEl.contains(e.target)) {
      closeWalletDropdown();
    }
  });

  if (collectionsBtnEl) {
    collectionsBtnEl.addEventListener("click", () => {
      if (!cached.address) {
        showToast("Please connect your wallet first", "error");
        return;
      }
      closeWalletDropdown();
      openCollectionsPanel();
    });
  }
  if (closeCollectionsEl) {
    closeCollectionsEl.addEventListener("click", closeCollectionsPanel);
  }
  
  document.body.addEventListener('touchmove', (e) => {
    if (e.target === canvas || canvas.contains(e.target)) {
      e.preventDefault();
    }
  }, { passive: false });
  resizeCanvas();
  window.addEventListener("resize", () => { resizeCanvas(); drawGrid(); drawGalaxy(performance.now()); });
  window.addEventListener("orientationchange", () => setTimeout(() => { resizeCanvas(); drawGrid(); drawGalaxy(performance.now()); }, 300));
  hookPointerEvents();
  initMapController();
  walletBtn?.addEventListener("click", connectWallet);
  buyBtn?.addEventListener("click", onBuyConfirm);
  closeModalBtn?.addEventListener("click", () => setModal(false));
  drawGrid();
  drawGalaxy(performance.now());

  miniReady();
  requestAnimationFrame(() => miniReady());
  window.addEventListener("load", () => setTimeout(miniReady, 0));

  hydrateFromCache();

  setTimeout(() => {
    loadMintedTilesOnStartup()
      .finally(async () => {
        try {
          const p = await readOnly.mintPrice();
          cached.mintPrice = p;
          if (priceLabel) priceLabel.textContent = `${ethers.formatEther(p)} ETH`;
        } catch (_) {}
        refreshPendingReveals();
      });
  }, 0);

  setInterval(refreshPendingReveals, 15000);

  let galaxyTimer = null;
  function startGalaxyLoop() {
    if (galaxyTimer) return;
    galaxyTimer = setInterval(() => {
      drawGalaxy(performance.now());
    }, IS_TOUCH ? 50 : 33);
  }
  startGalaxyLoop();

  setTimeout(() => {
    resizeCanvas();
    drawGrid();
    drawGalaxy(performance.now());
  }, 250);

  window.addEventListener("error", e => {
    const s = document.getElementById("status");
    if (s) {
      s.textContent = e.message || "Error";
      s.dataset.type = "error";
    }
  });
  window.addEventListener("unhandledrejection", e => {
    const s = document.getElementById("status");
    if (s) {
      s.textContent = (e.reason && e.reason.message) || "Promise error";
      s.dataset.type = "error";
    }
  });
}

window.addEventListener("DOMContentLoaded", bindDOM);
export { showToast, markTileAsOwned, openLink };
