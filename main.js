/* ══════════════════════════════════════════════════════════
   CONFIG — safe to commit; no secrets
   ══════════════════════════════════════════════════════════ */
const CFG = {
  configEndpoint: "https://n8n.intelechia.com/webhook/site/config",
  readEndpoint: "https://n8n.intelechia.com/webhook/site/read",
  writeEndpoint: "https://n8n.intelechia.com/webhook/site/write",
  logEndpoint: "https://n8n.intelechia.com/webhook/site/log",

  matrixServer: "https://hyphae.social",
  matrixDomain: "hyphae.social",
  matrixConfigState: "community.ncsn.config",
  matrixKeyState: "community.ncsn.key",
  matrixAdminState: "community.ncsn.admin",

  eoSite: "page",
};

/* ══════════════════════════════════════════════════════════
   SOURCE TYPES — visual taxonomy for articles
   Phosphor icon (regular weight) + label + accent color.
   Edit in the Article modal; auto-detected on import by URL.
   ══════════════════════════════════════════════════════════ */
const SOURCE_TYPES = {
  media: { icon: "ph-newspaper", label: "News outlet" },
  substack: { icon: "ph-pen-nib", label: "Newsletter / Substack" },
  analysis: { icon: "ph-magnifying-glass", label: "Long-form analysis" },
  podcast: { icon: "ph-microphone", label: "Podcast" },
  social: { icon: "ph-share-network", label: "Social media" },
  community: { icon: "ph-hand-heart", label: "Community" },
  other: { icon: "ph-link-simple", label: "Other link" },
};

// Auto-detect source type from a URL when one isn't supplied.
// Order matters: news outlets are checked FIRST so an outlet that happens to
// publish on Substack (or a .org domain) is still tagged as "media", not as a
// generic newsletter or community site.
function detectSourceType(url) {
  const u = String(url || "").toLowerCase();
  if (!u) return "other";
  // Known news outlets + generic news wire domains (checked first so outlets
  // take precedence over Substack / .org / newsletter detection below).
  if (
    u.includes("nashvillescene.com") ||
    u.includes("nashvillebanner.com") ||
    u.includes("newschannel5.com") ||
    u.includes("wkrn.com") ||
    u.includes("wsmv.com") ||
    u.includes("wpln.org") ||
    u.includes("wtvf.com") ||
    u.includes("fox17.com") ||
    u.includes("tennessean.com") ||
    u.includes("tennesseelookout.com") ||
    u.includes("npr.org") ||
    u.includes("apnews.com") ||
    u.includes("reuters.com") ||
    u.includes("nytimes.com") ||
    u.includes("washingtonpost.com") ||
    u.includes("wsj.com") ||
    u.includes("bloomberg.com") ||
    u.includes("cnn.com") ||
    u.includes("nbcnews.com") ||
    u.includes("cbsnews.com") ||
    u.includes("abcnews.go.com") ||
    u.includes("propublica.org") ||
    u.includes("axios.com")
  )
    return "media";
  if (u.includes("substack.com")) return "substack";
  if (
    u.includes("truthout.org") ||
    u.includes("liberationnews.org") ||
    u.includes("theintercept.com") ||
    u.includes("jacobin")
  )
    return "analysis";
  if (
    u.includes("citycast.fm") ||
    u.includes("/podcast") ||
    u.includes("podcasts.") ||
    u.includes("apple.com/podcast") ||
    u.includes("spotify.com")
  )
    return "podcast";
  if (
    u.includes("twitter.com") ||
    u.includes("x.com") ||
    u.includes("bsky.app") ||
    u.includes("mastodon") ||
    u.includes("hyphae.social") ||
    u.includes("instagram.com") ||
    u.includes("facebook.com") ||
    u.includes("tiktok.com") ||
    u.includes("threads.net")
  )
    return "social";
  if (
    u.includes("opentablenashville") ||
    u.includes("mutualaid") ||
    u.includes(".org/")
  )
    return "community";
  return "other";
}

function normalizeSourceType(t) {
  return Object.prototype.hasOwnProperty.call(SOURCE_TYPES, t) ? t : "other";
}

/* ══════════════════════════════════════════════════════════
   SESSION STATE
   ══════════════════════════════════════════════════════════ */
// Boot-time — fetched from GCS config on load, with localStorage fallback.
// roomId is not a secret; we cache it so the site survives a flaky config
// endpoint and never asks an existing editor to re-run first-run setup.
let roomId = localStorage.getItem("ncsn_room") || null;
let isFirstRun = false;

// Per-session — all sessionStorage, cleared on tab close
let matrixToken = sessionStorage.getItem("ncsn_mx") || null;
let matrixUserId = sessionStorage.getItem("ncsn_mxu") || null;
let writeUrl = sessionStorage.getItem("ncsn_wh") || null;
let adminPass = sessionStorage.getItem("ncsn_ap") || null;
let encKeyB64 = sessionStorage.getItem("ncsn_key") || null;

let admin = !!(matrixToken && writeUrl && adminPass && encKeyB64);

// Content state
let S = { articles: [], ctas: [], lastUpdated: null };

/* ══════════════════════════════════════════════════════════
   ESC × 3
   ══════════════════════════════════════════════════════════ */
let ec = 0,
  et;
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") {
    ec = 0;
    return;
  }
  ec++;
  clearTimeout(et);
  et = setTimeout(() => (ec = 0), 800);
  if (ec >= 3) {
    ec = 0;
    if (document.querySelector(".modal-bg.on")) {
      closeAllModals();
      return;
    }
    admin ? logout() : openLogin();
  }
});

/* ══════════════════════════════════════════════════════════
   BOOT — load config then content
   ══════════════════════════════════════════════════════════ */
async function boot() {
  await loadConfig();
  await loadContent();
}

async function loadConfig() {
  // Prefer the GCS config file as the source of truth, but only treat
  // "no roomId anywhere" as first-run. A cached localStorage value (or a
  // post-login joined-rooms discovery) is enough to keep using the existing
  // room when the GCS write is broken.
  try {
    const r = await fetch(CFG.configEndpoint);
    if (r.ok) {
      const d = await r.json();
      if (d && d.roomId) {
        roomId = d.roomId;
        localStorage.setItem("ncsn_room", d.roomId);
      }
    }
  } catch {
    /* ignore — fall through to cache + discovery */
  }
  isFirstRun = !roomId;
}

// Walk the editor's joined Matrix rooms looking for one that carries our
// site config state event. Used as a fallback when neither the GCS config
// nor localStorage has a roomId — prevents repeated first-run setup.
async function discoverRoomFromJoined(tok) {
  try {
    const r = await fetch(
      CFG.matrixServer + "/_matrix/client/v3/joined_rooms",
      {
        headers: { Authorization: "Bearer " + tok },
      },
    );
    if (!r.ok) return null;
    const d = await r.json();
    for (const rid of d.joined_rooms || []) {
      const cfg = await matrixGetState(tok, rid, CFG.matrixConfigState);
      if (cfg && cfg.writeWebhook) return rid;
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function loadContent() {
  // 1) Apply the hardcoded seed baked into the page (<script id="ncsn-seed">)
  //    and render immediately. No network call, so the site is interactive
  //    the moment the script runs even if the webhook is slow or down.
  try {
    const seed = loadSeedContent();
    if (seed) S = seed;
  } catch (err) {
    S._err = err.message;
  }
  render();

  // 2) Then consult the webhook-published page (GCS index.html with embedded
  //    <script id="ncsn-data">{...}<\/script>) — that's what Save writes to.
  //    If its content actually differs from the seed, replace and re-render.
  //    Otherwise stay on the seed so we don't churn the DOM.
  try {
    const r = await fetch(CFG.readEndpoint, { cache: "no-store" });
    if (!r.ok) return;
    const html = await r.text();
    const raw = parseEmbeddedState(html);
    if (!raw || (!raw.articles?.length && !raw.ctas?.length)) return;
    const remote = normalizeState(raw);
    if (canonicalContent(remote) !== canonicalContent(S)) {
      S = remote;
      delete S._err;
      render();
    }
  } catch (err) {
    // Only surface an error if the seed failed too — otherwise the page is
    // already showing valid content.
    if (!S.articles.length && !S.ctas.length) {
      S._err = err.message;
      render();
    }
  }
}

// Read the inline <script type="application/json" id="ncsn-seed"> block and
// coerce into the runtime shape (articles[] / ctas[] with stable ids).
function loadSeedContent() {
  const el = document.getElementById("ncsn-seed");
  if (!el) return null;
  return normalizeState(JSON.parse(el.textContent));
}

// Shared normalizer for seed JSON and webhook state. Assigns ids when
// missing, trims strings, and drops unknown sourceType values so render()
// always gets a consistent shape.
function normalizeState(data) {
  const inArts = Array.isArray(data.articles) ? data.articles : [];
  const inCTAs = Array.isArray(data.ctas) ? data.ctas : [];

  const articles = inArts
    .map((a) => ({
      id: a.id || uid(),
      title: String(a.title || "").trim(),
      url: String(a.url || "").trim(),
      date: String(a.date || "").trim(),
      summary: String(a.summary || "").trim(),
      tags: Array.isArray(a.tags)
        ? a.tags.map((t) => String(t).trim()).filter(Boolean)
        : [],
      sourceType:
        a.sourceType &&
        Object.prototype.hasOwnProperty.call(SOURCE_TYPES, a.sourceType)
          ? a.sourceType
          : "",
    }))
    .filter((a) => a.title);

  const ctas = inCTAs
    .map((c) => ({
      id: c.id || uid(),
      title: String(c.title || "").trim(),
      description: String(c.description || "").trim(),
      url: String(c.url || "").trim(),
      linkLabel: String(c.linkLabel || "").trim(),
      urgency: ["high", "medium", "low"].includes(c.urgency)
        ? c.urgency
        : "medium",
    }))
    .filter((c) => c.title);

  return { articles, ctas, lastUpdated: data.lastUpdated || null };
}

// Canonical content string for diffing seed vs. webhook. Strips volatile
// fields (id, lastUpdated) and sorts so identical content from different
// sources compares equal regardless of ordering or id assignment.
function canonicalContent(state) {
  const arts = [...(state.articles || [])]
    .map((a) => ({
      title: a.title || "",
      url: a.url || "",
      date: a.date || "",
      summary: a.summary || "",
      tags: [...(a.tags || [])].map((t) => String(t).trim()).sort(),
      sourceType: a.sourceType || "",
    }))
    .sort((x, y) =>
      ((x.url || x.title) + "").localeCompare((y.url || y.title) + ""),
    );
  const ctas = [...(state.ctas || [])]
    .map((c) => ({
      title: c.title || "",
      description: c.description || "",
      url: c.url || "",
      linkLabel: c.linkLabel || "",
      urgency: c.urgency || "medium",
    }))
    .sort((x, y) => x.title.localeCompare(y.title));
  return JSON.stringify({ arts, ctas });
}

function parseEmbeddedState(html) {
  try {
    const m = html.match(
      /<script[^>]+id="ncsn-data"[^>]*>([\s\S]*?)<\/script>/,
    );
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
}

/* ══════════════════════════════════════════════════════════
   RENDER
   ══════════════════════════════════════════════════════════ */
function render() {
  renderMeta();
  renderCTAs();
  renderArts();
  document.getElementById("admin-bar").classList.toggle("on", admin);
}

function renderMeta() {
  const d = S.lastUpdated
    ? new Date(S.lastUpdated).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";
  document.getElementById("footer-date").textContent = "Updated " + d;
}

function renderCTAs() {
  const el = document.getElementById("cta-container");
  if (S._err) {
    el.innerHTML = `<p class="msg err">Could not load: ${x(S._err)}</p>`;
    return;
  }
  if (!S.ctas.length) {
    el.innerHTML = `<p class="msg">No active calls to action.</p>`;
    return;
  }
  const ord = { high: 0, medium: 1, low: 2 };
  el.innerHTML = [...S.ctas]
    .sort((a, b) => (ord[a.urgency] ?? 1) - (ord[b.urgency] ?? 1))
    .map(
      (c) => `
      <div class="cta-item ${x(c.urgency || "medium")}">
        <div class="cta-title">${x(c.title)}</div>
        ${c.description ? `<div class="cta-desc">${x(c.description)}</div>` : ""}
        ${c.url ? `<a class="cta-link" href="${x(c.url)}" target="_blank" rel="noopener">${x(c.linkLabel || "Take action")} →</a>` : ""}
        <div class="edit-row${admin ? " on" : ""}">
          <button class="ebtn" onclick="openEditCTA('${x(c.id)}')">Edit</button>
          <button class="ebtn del" onclick="delCTA('${x(c.id)}')">Delete</button>
        </div>
      </div>`,
    )
    .join("");
}

function renderArts() {
  const el = document.getElementById("articles-container");
  if (!S.articles.length) {
    el.innerHTML = `<p class="msg">No articles yet.</p>`;
    return;
  }
  el.innerHTML = [...S.articles]
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .map((a) => {
      const st = normalizeSourceType(a.sourceType || detectSourceType(a.url));
      const meta = SOURCE_TYPES[st];
      return `
      <div class="article-item">
        <div class="art-meta">
          <i class="ph ${meta.icon} art-icon ${st}" title="${x(meta.label)}" aria-label="${x(meta.label)}"></i>
          <div class="art-date">${fmtDate(a.date)}</div>
          <div class="art-source-label">${x(meta.label)}</div>
        </div>
        <div>
          <div class="art-title">${
            a.url
              ? `<a href="${x(a.url)}" target="_blank" rel="noopener">${x(a.title)}</a>`
              : x(a.title)
          }</div>
          ${a.summary ? `<div class="art-summary">${x(a.summary)}</div>` : ""}
          ${a.tags?.length ? `<div class="art-tags">${a.tags.map((t) => `<span class="art-tag">${x(t.trim())}</span>`).join("")}</div>` : ""}
          <div class="edit-row${admin ? " on" : ""}">
            <button class="ebtn" onclick="openEditArt('${x(a.id)}')">Edit</button>
            <button class="ebtn del" onclick="delArt('${x(a.id)}')">Delete</button>
          </div>
        </div>
      </div>`;
    })
    .join("");
}

/* ══════════════════════════════════════════════════════════
   CRYPTO — Web Crypto API (AES-256-GCM)
   ══════════════════════════════════════════════════════════ */
async function generateKey() {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const raw = await crypto.subtle.exportKey("raw", key);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

async function encryptData(obj, keyB64) {
  const keyBytes = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(obj)),
  );
  return (
    btoa(String.fromCharCode(...iv)) +
    "." +
    btoa(String.fromCharCode(...new Uint8Array(enc)))
  );
}

async function decryptData(blob, keyB64) {
  const [ivB64, encB64] = blob.split(".");
  const keyBytes = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const enc = Uint8Array.from(atob(encB64), (c) => c.charCodeAt(0));
  const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, enc);
  return JSON.parse(new TextDecoder().decode(dec));
}

/* ══════════════════════════════════════════════════════════
   MATRIX HELPERS
   ══════════════════════════════════════════════════════════ */
async function matrixPost(path, token, body) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  const r = await fetch(CFG.matrixServer + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, data: await r.json() };
}

async function matrixPutState(token, rid, type, content) {
  const url = `${CFG.matrixServer}/_matrix/client/v3/rooms/${encodeURIComponent(rid)}/state/${encodeURIComponent(type)}/`;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify(content),
  });
  return { ok: r.ok, data: await r.json() };
}

async function matrixGetState(token, rid, type) {
  const url = `${CFG.matrixServer}/_matrix/client/v3/rooms/${encodeURIComponent(rid)}/state/${encodeURIComponent(type)}/`;
  const r = await fetch(url, {
    headers: { Authorization: "Bearer " + token },
  });
  if (!r.ok) return null;
  return r.json();
}

/* ══════════════════════════════════════════════════════════
   LOGIN FLOW — STEP 1: Matrix
   ══════════════════════════════════════════════════════════ */
function openLogin() {
  document.getElementById("matrix-user").value = "";
  document.getElementById("matrix-pw").value = "";
  setMsg("matrix-msg", "", "");
  setDisabled("matrix-btn", false);
  openModal("modal-matrix");
  setTimeout(() => document.getElementById("matrix-user").focus(), 60);
}

// Accept either a bare localpart ("alice") or a full MXID ("@alice:hyphae.social").
// Only hyphae.social accounts are allowed.
function normalizeMxid(input) {
  let u = (input || "").trim();
  if (!u) return null;
  if (u.startsWith("@")) {
    if (!u.toLowerCase().endsWith(":" + CFG.matrixDomain)) return null;
    return u;
  }
  if (u.includes(":") || u.includes("@")) return null;
  return "@" + u + ":" + CFG.matrixDomain;
}

document.getElementById("matrix-user").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    document.getElementById("matrix-pw").focus();
  }
});
document.getElementById("matrix-pw").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") doMatrixLogin();
});

async function doMatrixLogin() {
  const userInput = document.getElementById("matrix-user").value;
  const pw = document.getElementById("matrix-pw").value;
  if (!pw) return;

  const mxid = normalizeMxid(userInput);
  if (!mxid) {
    setMsg("matrix-msg", "Enter a valid " + CFG.matrixDomain + " user.", "err");
    return;
  }

  setDisabled("matrix-btn", true);
  setMsg("matrix-msg", "Authenticating…", "status");

  const res = await matrixPost("/_matrix/client/v3/login", null, {
    type: "m.login.password",
    identifier: { type: "m.id.user", user: mxid },
    password: pw,
  });
  if (!res.ok) {
    setMsg("matrix-msg", res.data.error || "Login failed.", "err");
    setDisabled("matrix-btn", false);
    return;
  }

  const tok = res.data.access_token;
  const serverMxid = res.data.user_id || mxid;
  sessionStorage.setItem("ncsn_mx", tok);
  sessionStorage.setItem("ncsn_mxu", serverMxid);
  matrixToken = tok;
  matrixUserId = serverMxid;

  closeAllModals();

  // Belt-and-suspenders: even if loadConfig didn't find a roomId, the editor
  // may already be a member of an existing site config room. Scan their
  // joined rooms for one that carries our config state before assuming this
  // is a first run. This prevents the setup wizard from running twice when
  // the GCS config write is failing.
  if (!roomId) {
    const found = await discoverRoomFromJoined(tok);
    if (found) {
      roomId = found;
      localStorage.setItem("ncsn_room", found);
      isFirstRun = false;
    }
  }

  // Branch: first run vs existing room
  if (isFirstRun || !roomId) {
    openModal("modal-setup");
    setTimeout(() => document.getElementById("setup-admin-pw").focus(), 60);
  } else {
    await fetchRoomSession(tok);
  }
}

// After Matrix login on a normal run: fetch write URL + key + admin pw from room state.
// If the admin password is present in state (shared via room membership), auto-unlock.
async function fetchRoomSession(tok) {
  const cfgState = await matrixGetState(tok, roomId, CFG.matrixConfigState);
  const keyState = await matrixGetState(tok, roomId, CFG.matrixKeyState);
  const admState = await matrixGetState(tok, roomId, CFG.matrixAdminState);

  if (!cfgState?.writeWebhook || !keyState?.k) {
    openModal("modal-admin");
    setMsg(
      "admin-msg",
      "Could not read room state. You may not be a member of this site's Matrix room — ask an existing editor to invite you.",
      "err",
    );
    setDisabled("admin-btn", true);
    return;
  }

  sessionStorage.setItem("ncsn_wh", cfgState.writeWebhook);
  sessionStorage.setItem("ncsn_key", keyState.k);
  writeUrl = cfgState.writeWebhook;
  encKeyB64 = keyState.k;

  // Shared admin password — any invited room member auto-unlocks with it.
  if (admState?.adminPw) {
    sessionStorage.setItem("ncsn_ap", admState.adminPw);
    adminPass = admState.adminPw;
    admin = true;
    render();
    return;
  }

  // Legacy fallback: prompt the user manually.
  openModal("modal-admin");
  setMsg(
    "admin-msg",
    "Admin password not in room state — enter it manually.",
    "status",
  );
  document.getElementById("admin-pw").value = "";
  setDisabled("admin-btn", false);
  setTimeout(() => document.getElementById("admin-pw").focus(), 60);
}

/* ══════════════════════════════════════════════════════════
   LOGIN FLOW — FIRST RUN SETUP
   ══════════════════════════════════════════════════════════ */
async function doFirstRunSetup() {
  const wh = document.getElementById("setup-write-url").value.trim();
  const apw = document.getElementById("setup-admin-pw").value;
  if (!wh || !apw) {
    setMsg("setup-msg", "Both fields are required.", "err");
    return;
  }

  setDisabled("setup-btn", true);
  setMsg("setup-msg", "", "");

  try {
    // 1. Create Matrix room
    stepState("ss-room", "active");
    const roomRes = await matrixPost(
      "/_matrix/client/v3/createRoom",
      matrixToken,
      {
        visibility: "private",
        name: "NCSN Site Config",
        topic:
          "Nashville Community Safety Network — site config and encryption key",
        preset: "private_chat",
      },
    );
    if (!roomRes.ok)
      throw new Error(
        "Room creation failed: " + (roomRes.data.error || roomRes.status),
      );
    const rid = roomRes.data.room_id;
    stepState("ss-room", "done");

    // 2. Generate encryption key
    stepState("ss-key", "active");
    const keyB64 = await generateKey();
    stepState("ss-key", "done");

    // 3. Store config, key, and admin password in Matrix room state.
    //    Anyone invited to this room will later read the admin password from
    //    state and automatically gain upload access.
    stepState("ss-state", "active");
    const cfgPut = await matrixPutState(
      matrixToken,
      rid,
      CFG.matrixConfigState,
      { writeWebhook: wh },
    );
    if (!cfgPut.ok)
      throw new Error(
        "Failed to set config state: " + JSON.stringify(cfgPut.data),
      );
    const keyPut = await matrixPutState(matrixToken, rid, CFG.matrixKeyState, {
      k: keyB64,
    });
    if (!keyPut.ok)
      throw new Error(
        "Failed to set key state: " + JSON.stringify(keyPut.data),
      );
    const admPut = await matrixPutState(
      matrixToken,
      rid,
      CFG.matrixAdminState,
      { adminPw: apw },
    );
    if (!admPut.ok)
      throw new Error(
        "Failed to set admin state: " + JSON.stringify(admPut.data),
      );
    stepState("ss-state", "done");

    // 4. Write site config to GCS via n8n. The roomId already lives in
    //    Matrix room state (and we cache it locally), so a GCS failure here
    //    is recoverable — log it but don't lose the freshly-created room.
    stepState("ss-gcs", "active");
    let gcsOk = false;
    try {
      const gcsCfg = await fetch(CFG.configEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apw,
        },
        body: JSON.stringify({
          roomId: rid,
          createdAt: new Date().toISOString(),
          version: 1,
        }),
      });
      if (gcsCfg.status === 401) throw new Error("Wrong admin password.");
      if (!gcsCfg.ok)
        throw new Error("Config write failed: HTTP " + gcsCfg.status);
      gcsOk = true;
      stepState("ss-gcs", "done");
    } catch (gcsErr) {
      // Hard-fail only on auth — a 500 from GCS shouldn't strand the editor.
      if (/wrong admin password/i.test(gcsErr.message)) throw gcsErr;
      console.warn(
        "GCS config write failed, falling back to local cache:",
        gcsErr,
      );
      stepState("ss-gcs", "error");
      // Defer the alert until after the modal closes so it isn't hidden.
      setTimeout(
        () =>
          alert(
            "Site is set up, but the GCS config write failed (" +
              gcsErr.message +
              ").\n\n" +
              "The room id has been cached locally and is also stored in Matrix room state, " +
              "so editors who join the room will still find it on next login. " +
              "You can fix the n8n config webhook later without redoing setup.",
          ),
        100,
      );
    }

    // Commit session state. Cache the roomId persistently so even a wiped
    // GCS config file can never trigger a duplicate first-run setup.
    roomId = rid;
    writeUrl = wh;
    encKeyB64 = keyB64;
    adminPass = apw;
    isFirstRun = false;
    localStorage.setItem("ncsn_room", rid);
    sessionStorage.setItem("ncsn_wh", wh);
    sessionStorage.setItem("ncsn_key", keyB64);
    sessionStorage.setItem("ncsn_ap", apw);
    admin = true;

    closeAllModals();
    render();
  } catch (err) {
    setMsg("setup-msg", err.message, "err");
    // Mark last active step as error
    document.querySelectorAll(".setup-step.active").forEach((el) => {
      el.classList.remove("active");
      el.classList.add("error");
    });
    setDisabled("setup-btn", false);
  }
}

function stepState(id, state) {
  const el = document.getElementById(id);
  el.className = "setup-step " + state;
}

/* ══════════════════════════════════════════════════════════
   LOGIN FLOW — STEP 2: Admin password
   ══════════════════════════════════════════════════════════ */
document.getElementById("admin-pw").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") doAdminLogin();
});

async function doAdminLogin() {
  const pw = document.getElementById("admin-pw").value;
  if (!pw) return;
  setDisabled("admin-btn", true);
  setMsg("admin-msg", "Verifying…", "status");

  try {
    const r = await fetch(writeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + pw,
      },
      body: JSON.stringify({
        _probe: true,
        op: "NUL",
        site: "probe",
        resolution: "probe",
        author: matrixUserId || "",
        meta: {},
        payload: {},
        content: "",
      }),
    });
    if (r.status === 401) {
      setMsg("admin-msg", "Wrong password.", "err");
      setDisabled("admin-btn", false);
      return;
    }
  } catch {
    setMsg("admin-msg", "Could not reach write endpoint.", "err");
    setDisabled("admin-btn", false);
    return;
  }

  sessionStorage.setItem("ncsn_ap", pw);
  adminPass = pw;
  admin = true;
  closeAllModals();
  render();
}

/* ══════════════════════════════════════════════════════════
   LOGOUT
   ══════════════════════════════════════════════════════════ */
function logout() {
  ["ncsn_mx", "ncsn_mxu", "ncsn_wh", "ncsn_ap", "ncsn_key"].forEach((k) =>
    sessionStorage.removeItem(k),
  );
  matrixToken = null;
  matrixUserId = null;
  writeUrl = null;
  adminPass = null;
  encKeyB64 = null;
  admin = false;
  document.getElementById("admin-bar").classList.remove("on");
  render();
}

/* ══════════════════════════════════════════════════════════
   INVITE — grant another hyphae.social user upload access
   by inviting them to the site's Matrix room. Upon joining
   they read the admin password from room state automatically.
   ══════════════════════════════════════════════════════════ */
function openInvite() {
  if (!admin || !matrixToken || !roomId) return;
  document.getElementById("invite-user").value = "";
  setMsg("invite-msg", "", "");
  setDisabled("invite-btn", false);
  openModal("invite-modal");
  setTimeout(() => document.getElementById("invite-user").focus(), 60);
}

async function doInvite() {
  const mxid = normalizeMxid(document.getElementById("invite-user").value);
  if (!mxid) {
    setMsg("invite-msg", "Enter a valid " + CFG.matrixDomain + " user.", "err");
    return;
  }
  setDisabled("invite-btn", true);
  setMsg("invite-msg", "Sending invite…", "status");
  try {
    const url =
      CFG.matrixServer +
      "/_matrix/client/v3/rooms/" +
      encodeURIComponent(roomId) +
      "/invite";
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + matrixToken,
      },
      body: JSON.stringify({ user_id: mxid }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || "HTTP " + r.status);
    }
    setMsg(
      "invite-msg",
      "Invited " +
        mxid +
        ". Once they accept and log in they'll have upload access.",
      "status",
    );
    setDisabled("invite-btn", false);
  } catch (err) {
    setMsg("invite-msg", err.message, "err");
    setDisabled("invite-btn", false);
  }
}

document.getElementById("invite-user").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") doInvite();
});

/* ══════════════════════════════════════════════════════════
   SAVE — encrypted payload, rendered content HTML
   ══════════════════════════════════════════════════════════ */
async function saveAll() {
  if (!admin || !writeUrl || !adminPass || !encKeyB64) return;
  const btn = document.getElementById("save-btn");
  btn.textContent = "Saving…";
  btn.disabled = true;

  // First-fill × Making: if no prior save has ever landed against this site
  // (no lastUpdated was loaded from the remote), this save is the initial
  // authoring act and carries the Making stance. Subsequent saves are
  // replace. Capture before we overwrite lastUpdated below.
  const isFirstFill = !S.lastUpdated;
  S.lastUpdated = new Date().toISOString();

  // Encrypt the content payload before it leaves the browser
  let encPayload;
  try {
    encPayload = await encryptData(
      { articles: S.articles, ctas: S.ctas, ts: S.lastUpdated },
      encKeyB64,
    );
  } catch (err) {
    btn.textContent = "Crypto error";
    btn.disabled = false;
    alert("Encryption failed: " + err.message);
    return;
  }

  const body = {
    op: "INS",
    site: CFG.eoSite,
    resolution: isFirstFill ? "Making" : "replace",
    author: matrixUserId || "",
    meta: {
      title: "Nashville Community Safety Network",
      description: "Accountability. Transparency.",
    },
    // n8n stores whatever is in payload verbatim in the JSONL event
    payload: { encrypted: encPayload },
    // content = inner HTML saved to GCS index.html
    content: buildContentHTML(),
  };

  const MAX_RETRIES = 2;
  const jsonBody = JSON.stringify(body);

  try {
    let r,
      attempt = 0,
      lastErr;
    while (attempt <= MAX_RETRIES) {
      if (attempt > 0) {
        btn.textContent = `Retry ${attempt}/${MAX_RETRIES}…`;
        await new Promise((ok) => setTimeout(ok, 1000 * Math.pow(2, attempt)));
      }
      try {
        r = await fetch(writeUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + adminPass,
          },
          body: jsonBody,
        });
      } catch (netErr) {
        lastErr = netErr;
        attempt++;
        continue;
      }
      if (r.status === 401) {
        btn.textContent = "Auth error";
        btn.disabled = false;
        return;
      }
      if (r.status >= 500 && attempt < MAX_RETRIES) {
        attempt++;
        continue;
      }
      if (!r.ok) {
        let detail = "";
        try {
          detail = (await r.text()).slice(0, 200);
        } catch {}
        throw new Error("HTTP " + r.status + (detail ? " — " + detail : ""));
      }
      break;
    }
    if (!r || !r.ok) throw lastErr || new Error("Save failed after retries");
    renderMeta();
    btn.textContent = "Saved";
    setTimeout(() => {
      btn.textContent = "Save";
      btn.disabled = false;
    }, 2200);
  } catch (err) {
    btn.textContent = "Error";
    btn.disabled = false;
    alert("Save failed: " + err.message);
  }
}

function buildContentHTML() {
  const ord = { high: 0, medium: 1, low: 2 };
  const sCTAs = [...S.ctas].sort(
    (a, b) => (ord[a.urgency] ?? 1) - (ord[b.urgency] ?? 1),
  );
  const sArts = [...S.articles].sort((a, b) =>
    (b.date || "").localeCompare(a.date || ""),
  );

  const ctaHtml = sCTAs
    .map(
      (c) => `
    <div class="cta-item ${x(c.urgency || "medium")}">
      <div class="cta-title">${x(c.title)}</div>
      ${c.description ? `<div class="cta-desc">${x(c.description)}</div>` : ""}
      ${c.url ? `<a class="cta-link" href="${x(c.url)}">${x(c.linkLabel || "Take action")} →</a>` : ""}
    </div>`,
    )
    .join("");

  const artHtml = sArts
    .map((a) => {
      const st = normalizeSourceType(a.sourceType || detectSourceType(a.url));
      const meta = SOURCE_TYPES[st];
      return `
    <div class="article-item">
      <div class="art-meta">
        <i class="ph ${meta.icon} art-icon ${st}" title="${x(meta.label)}" aria-label="${x(meta.label)}"></i>
        <div class="art-date">${fmtDate(a.date)}</div>
        <div class="art-source-label">${x(meta.label)}</div>
      </div>
      <div>
        <div class="art-title">${a.url ? `<a href="${x(a.url)}">${x(a.title)}</a>` : x(a.title)}</div>
        ${a.summary ? `<div class="art-summary">${x(a.summary)}</div>` : ""}
        ${a.tags?.length ? `<div class="art-tags">${a.tags.map((t) => `<span class="art-tag">${x(t.trim())}</span>`).join("")}</div>` : ""}
      </div>
    </div>`;
    })
    .join("");

  const stateJson = JSON.stringify({
    articles: S.articles,
    ctas: S.ctas,
    lastUpdated: S.lastUpdated,
  }).replace(/<\//g, "<\\/");

  return `<script type="application/json" id="ncsn-data">${stateJson}<\/script>
<section><div class="section-label">Calls to action</div>
<div id="cta-container">${ctaHtml}</div></section>
<section><div class="section-label">News &amp; articles</div>
<hr class="article-rule"><div id="articles-container">${artHtml}</div></section>`;
}

/* ══════════════════════════════════════════════════════════
   CHANGELOG — fetch JSONL, decrypt payloads
   Requires GET /webhook/site/log in n8n (see ncsn-n8n-additions.json)
   ══════════════════════════════════════════════════════════ */
async function openChangelog() {
  openModal("log-modal");
  const el = document.getElementById("log-container");
  el.innerHTML = '<p class="msg">Loading...</p>';

  if (!adminPass) {
    el.innerHTML = '<p class="msg err">Admin session required.</p>';
    return;
  }

  let text;
  try {
    const r = await fetch(CFG.logEndpoint, {
      headers: { Authorization: "Bearer " + adminPass },
    });
    if (r.status === 404) {
      el.innerHTML = `<p class="msg">Log endpoint not yet configured.<br>
        Import <code>ncsn-n8n-additions.json</code> into n8n and activate it.</p>`;
      return;
    }
    if (r.status === 401) {
      el.innerHTML = '<p class="msg err">Unauthorized.</p>';
      return;
    }
    if (!r.ok) throw new Error("HTTP " + r.status);
    text = await r.text();
  } catch (err) {
    el.innerHTML = `<p class="msg err">Could not load log: ${x(err.message)}</p>`;
    return;
  }

  const lines = text.trim().split("\n").filter(Boolean).reverse();
  if (!lines.length) {
    el.innerHTML = '<p class="msg">No log entries yet.</p>';
    return;
  }

  const rows = await Promise.all(
    lines.map(async (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return "";
      }
      const ts = ev.ts
        ? new Date(ev.ts).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "—";

      let detail = "";
      if (ev.payload?.encrypted && encKeyB64) {
        try {
          const dec = await decryptData(ev.payload.encrypted, encKeyB64);
          const na = dec.articles?.length ?? "?";
          const nc = dec.ctas?.length ?? "?";
          detail = `${na} articles, ${nc} actions`;
        } catch {
          detail = '<span class="log-enc">encrypted</span>';
        }
      } else if (ev.payload?._probe) {
        detail = '<span class="log-enc">probe</span>';
      }

      return `<div class="log-entry">
      <div class="log-ts">${ts}</div>
      <div class="log-op">${x(ev.op || "—")}</div>
      <div class="log-detail">${detail || x(ev.site || "")}</div>
    </div>`;
    }),
  );

  el.innerHTML = rows.join("");
}

/* ══════════════════════════════════════════════════════════
   CTA CRUD
   ══════════════════════════════════════════════════════════ */
function openAddCTA() {
  document.getElementById("cta-modal-h").textContent = "Add call to action";
  ["cta-id", "cta-title", "cta-desc", "cta-url", "cta-lbl"].forEach(
    (i) => (document.getElementById(i).value = ""),
  );
  document.getElementById("cta-urgency").value = "medium";
  openModal("cta-modal");
}
function openEditCTA(id) {
  const c = S.ctas.find((c) => c.id === id);
  if (!c) return;
  document.getElementById("cta-modal-h").textContent = "Edit call to action";
  document.getElementById("cta-id").value = id;
  document.getElementById("cta-title").value = c.title || "";
  document.getElementById("cta-desc").value = c.description || "";
  document.getElementById("cta-url").value = c.url || "";
  document.getElementById("cta-lbl").value = c.linkLabel || "";
  document.getElementById("cta-urgency").value = c.urgency || "medium";
  openModal("cta-modal");
}
function saveCTA() {
  const id = document.getElementById("cta-id").value;
  const c = {
    id: id || uid(),
    title: document.getElementById("cta-title").value.trim(),
    description: document.getElementById("cta-desc").value.trim(),
    url: document.getElementById("cta-url").value.trim(),
    linkLabel: document.getElementById("cta-lbl").value.trim(),
    urgency: document.getElementById("cta-urgency").value,
  };
  if (!c.title) return;
  S.ctas = id ? S.ctas.map((v) => (v.id === id ? c : v)) : [...S.ctas, c];
  closeAllModals();
  renderCTAs();
}
function delCTA(id) {
  if (!confirm("Delete?")) return;
  S.ctas = S.ctas.filter((c) => c.id !== id);
  renderCTAs();
}

/* ══════════════════════════════════════════════════════════
   ARTICLE CRUD
   ══════════════════════════════════════════════════════════ */
function openAddArticle() {
  document.getElementById("art-modal-h").textContent = "Add article";
  ["art-id", "art-title", "art-url", "art-summary", "art-tags"].forEach(
    (i) => (document.getElementById(i).value = ""),
  );
  document.getElementById("art-date").value = today();
  document.getElementById("art-source-type").value = "";
  openModal("art-modal");
}
function openEditArt(id) {
  const a = S.articles.find((a) => a.id === id);
  if (!a) return;
  document.getElementById("art-modal-h").textContent = "Edit article";
  document.getElementById("art-id").value = id;
  document.getElementById("art-title").value = a.title || "";
  document.getElementById("art-url").value = a.url || "";
  document.getElementById("art-date").value = a.date || today();
  document.getElementById("art-summary").value = a.summary || "";
  document.getElementById("art-tags").value = (a.tags || []).join(", ");
  document.getElementById("art-source-type").value = a.sourceType || "";
  openModal("art-modal");
}
function saveArt() {
  const id = document.getElementById("art-id").value;
  const url = document.getElementById("art-url").value.trim();
  const stChoice = document.getElementById("art-source-type").value;
  const a = {
    id: id || uid(),
    title: document.getElementById("art-title").value.trim(),
    url,
    date: document.getElementById("art-date").value,
    summary: document.getElementById("art-summary").value.trim(),
    tags: document
      .getElementById("art-tags")
      .value.split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    // Empty value = auto-detect: store only when the editor explicitly picked one,
    // so future URL changes can keep auto-detecting.
    sourceType: stChoice ? normalizeSourceType(stChoice) : "",
  };
  if (!a.title) return;
  S.articles = id
    ? S.articles.map((v) => (v.id === id ? a : v))
    : [...S.articles, a];
  closeAllModals();
  renderArts();
}
function delArt(id) {
  if (!confirm("Delete?")) return;
  S.articles = S.articles.filter((a) => a.id !== id);
  renderArts();
}

/* ══════════════════════════════════════════════════════════
   IMPORT — upload a JSON file of migrated content
   Format: { version:1, articles:[...], ctas:[...] }
   Items without an id get one assigned. Merge mode dedupes
   articles by URL (fallback title) and CTAs by title.
   Nothing is published until the user clicks Save.
   ══════════════════════════════════════════════════════════ */
function openImport() {
  if (!admin) return;
  document.getElementById("import-file").value = "";
  document.getElementById("import-mode").value = "merge";
  setMsg("import-msg", "", "");
  setDisabled("import-btn", false);
  openModal("import-modal");
}

async function doImport() {
  const f = document.getElementById("import-file").files?.[0];
  const mode = document.getElementById("import-mode").value;
  if (!f) {
    setMsg("import-msg", "Choose a file.", "err");
    return;
  }

  setDisabled("import-btn", true);
  setMsg("import-msg", "Reading…", "status");

  let data;
  try {
    data = JSON.parse(await f.text());
  } catch (err) {
    setMsg("import-msg", "Not a valid JSON file: " + err.message, "err");
    setDisabled("import-btn", false);
    return;
  }

  const inArts = Array.isArray(data.articles) ? data.articles : [];
  const inCTAs = Array.isArray(data.ctas) ? data.ctas : [];
  if (!inArts.length && !inCTAs.length) {
    setMsg("import-msg", "File has no articles or ctas.", "err");
    setDisabled("import-btn", false);
    return;
  }

  const normArt = (a) => {
    const url = String(a.url || "").trim();
    // If the file supplies a known sourceType, keep it. Otherwise leave the
    // field empty so the renderer auto-detects from the URL — that way an
    // editor changing the URL later still gets a sensible default.
    let st = "";
    if (
      a.sourceType &&
      Object.prototype.hasOwnProperty.call(SOURCE_TYPES, a.sourceType)
    ) {
      st = a.sourceType;
    }
    return {
      id: a.id || uid(),
      title: String(a.title || "").trim(),
      url,
      date: String(a.date || "").trim(),
      summary: String(a.summary || "").trim(),
      tags: Array.isArray(a.tags)
        ? a.tags.map((t) => String(t).trim()).filter(Boolean)
        : [],
      sourceType: st,
    };
  };
  const normCTA = (c) => ({
    id: c.id || uid(),
    title: String(c.title || "").trim(),
    description: String(c.description || "").trim(),
    url: String(c.url || "").trim(),
    linkLabel: String(c.linkLabel || "").trim(),
    urgency: ["high", "medium", "low"].includes(c.urgency)
      ? c.urgency
      : "medium",
  });

  const arts = inArts.map(normArt).filter((a) => a.title);
  const ctas = inCTAs.map(normCTA).filter((c) => c.title);

  if (mode === "replace") {
    if (
      !confirm(
        `Replace all content with ${arts.length} articles and ${ctas.length} actions?`,
      )
    ) {
      setDisabled("import-btn", false);
      setMsg("import-msg", "", "");
      return;
    }
    S.articles = arts;
    S.ctas = ctas;
    setMsg(
      "import-msg",
      `Replaced. ${arts.length} articles, ${ctas.length} actions. Click Save in the top bar to publish.`,
      "status",
    );
  } else {
    const haveArtKey = new Set(
      S.articles.map((a) => (a.url || a.title).toLowerCase()),
    );
    const haveCTAKey = new Set(S.ctas.map((c) => c.title.toLowerCase()));
    let addedA = 0,
      addedC = 0;
    arts.forEach((a) => {
      const k = (a.url || a.title).toLowerCase();
      if (!haveArtKey.has(k)) {
        S.articles.push(a);
        haveArtKey.add(k);
        addedA++;
      }
    });
    ctas.forEach((c) => {
      const k = c.title.toLowerCase();
      if (!haveCTAKey.has(k)) {
        S.ctas.push(c);
        haveCTAKey.add(k);
        addedC++;
      }
    });
    setMsg(
      "import-msg",
      `Added ${addedA} articles, ${addedC} actions (duplicates skipped). Click Save in the top bar to publish.`,
      "status",
    );
  }

  setDisabled("import-btn", false);
  renderCTAs();
  renderArts();
}

/* ══════════════════════════════════════════════════════════
   MODAL / UI HELPERS
   ══════════════════════════════════════════════════════════ */
function openModal(id) {
  closeAllModals();
  document.getElementById(id).classList.add("on");
}
function closeAllModals() {
  document
    .querySelectorAll(".modal-bg.on")
    .forEach((m) => m.classList.remove("on"));
}
function setMsg(id, txt, type) {
  const el = document.getElementById(id);
  el.className = "modal-msg" + (txt ? " " + type : "");
  el.textContent = txt;
}
function setDisabled(id, v) {
  document.getElementById(id).disabled = v;
}

document.querySelectorAll(".modal-bg").forEach((bg) =>
  bg.addEventListener("click", (ev) => {
    if (ev.target === bg) closeAllModals();
  }),
);

/* ══════════════════════════════════════════════════════════
   UTILS
   ══════════════════════════════════════════════════════════ */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
function x(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso + "T12:00:00");
  if (isNaN(d)) return iso;
  return (
    d.toLocaleDateString("en-US", { month: "short" }) + "\n" + d.getFullYear()
  );
}

/* ══════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════ */
boot();
