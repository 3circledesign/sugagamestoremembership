// ===== Helpers =====
const $ = id => document.getElementById(id);

// Accept multiple possible key field names from backend
function getServerCdKey(st){
  if (!st || typeof st !== "object") return "";
  if (st.cd_key && String(st.cd_key).trim() !== "") return st.cd_key;
  if (st.cdkey  && String(st.cdkey).trim()  !== "") return st.cdkey;
  if (st.key    && String(st.key).trim()    !== "") return st.key;
  const lic = (st.license && typeof st.license === "object") ? st.license : null;
  if (lic){
    if (lic.cd_key && String(lic.cd_key).trim() !== "") return lic.cd_key;
    if (lic.cdkey  && String(lic.cdkey).trim()  !== "") return lic.cdkey;
    if (lic.key    && String(lic.key).trim()    !== "") return lic.key;
  }
  return "";
}

// Global state
let CURRENT_LICENSE = null;          // {status, plan, expiry_date, days_left, steamid, online, cd_key?}
const LAST_KEY_STORAGE = "last_cd_key";

let ALL = [];
let FILTERED = [];
let page = 1;
let selectedAppId = null;

// Steam users (from loginusers.vdf)
let STEAM_USERS = [];

let GRID_LOCKED = false;
function setGridLocked(lock) {
  GRID_LOCKED = !!lock;
  GRID.classList.toggle('locked', GRID_LOCKED);
}

// UI refs
const GRID = $("grid");
const EMPTY = $("emptyNote");
const HERO_WRAP = $("heroWrap");
const HERO_IMG = $("heroCover");
const HERO_PH = $("heroPlaceholder");
const BTN_FETCH = $("btnFetch");
const BTN_ACTIVATE = $("btnActivate");

// Modal refs
const MODAL_BACKDROP = $("actBackdrop");
const MODAL_TITLE = $("actTitle");
const MODAL_NOTE = document.querySelector(".modal .note");
const MODAL_MSG  = $("actMsg");
const MODAL_WARN = $("actExpired");
const INP_KEY    = $("actKey");
const INP_STEAM  = $("actSteam");       // hidden fallback (kept for compatibility)
const SEL_STEAM  = $("actSteamSel");    // main dropdown
const BTN_ACT_DO = $("btnActDo");
const BTN_ACT_CANCEL = $("btnActCancel");

// To avoid repeated modal pops and grid flicker on background checks
let LAST_STATUS = null;

// Utilities
function show(el){ el.style.display = el.classList.contains('modal-backdrop') ? 'flex' : 'block'; }
function hide(el){ el.style.display = 'none'; }
function daysWord(d){ if (d == null) return ''; return d === 1 ? '1 day' : (d + ' days'); }
function setStatus(s){ $("status").textContent = s || ""; }

// ----- Steam users helpers -----
async function loadSteamUsers(){
  try{
    const r = await fetch("/api/steam-users", { cache: "no-store" });
    const j = await r.json();
    STEAM_USERS = Array.isArray(j.items) ? j.items : [];
  }catch{ STEAM_USERS = []; }
}

function populateSteamSelect(currentSteamId){
  if (!SEL_STEAM) return;

  // clear
  while (SEL_STEAM.firstChild) SEL_STEAM.removeChild(SEL_STEAM.firstChild);

  if (!STEAM_USERS.length){
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No local Steam users found";
    SEL_STEAM.appendChild(opt);
    SEL_STEAM.disabled = true;
    return;
  }
  SEL_STEAM.disabled = false;

  // Label: AccountName – 7656...
  STEAM_USERS.forEach(u => {
    const labelName = u.account_name ? u.account_name : "(unknown)";
    const label = `${labelName} – ${u.steamid}`;
    const opt = document.createElement("option");
    opt.value = u.steamid;
    opt.textContent = label;
    SEL_STEAM.appendChild(opt);
  });

  // Default: current steamid -> most_recent -> first
  let target = currentSteamId || "";
  if (!target){
    const most = STEAM_USERS.find(u => u.most_recent);
    target = most ? most.steamid : STEAM_USERS[0].steamid;
  }
  SEL_STEAM.value = target;
}

// ----- License strip + state -----
function renderLicenseStrip(st){
  const strip = $("licStrip");
  const icon = $("licIcon");
  const txt  = $("licText");

  strip.classList.remove("hidden");
  BTN_ACTIVATE.textContent = (st.status === "active") ? "Show Details" : "Activate";

  if (st.status === "active"){
    icon.textContent = "ACTIVE";
    icon.className = "badge";
    const details = [];
    if (st.plan) details.push("Plan: " + st.plan);
    if (st.expiry_date) details.push("Expires: " + st.expiry_date);
    if (st.days_left != null) details.push(daysWord(st.days_left) + " left");
    if (st.online === false) details.push("(offline check)");
    txt.textContent = details.join(" • ");
  } else if (st.status === "expired"){
    icon.textContent = "EXPIRED";
    icon.className = "badge err";
    txt.textContent = "Your license expired" + (st.expiry_date ? (" on " + st.expiry_date) : "") + ".";
  } else if (st.status === "revoked"){
    icon.textContent = "REVOKED";
    icon.className = "badge err";
    txt.textContent = "Your CD-Key is no longer valid on the server.";
  } else {
    icon.textContent = "NOT ACTIVATED";
    icon.className = "badge warn";
    txt.textContent = "Please activate to use Steam Guard fetcher.";
  }
}

/** Only toggle elements that depend on active/inactive; avoid rebuilding grid. */
function updateActivationDependentUI(st){
  const active = st && st.status === "active";

  if (BTN_FETCH) BTN_FETCH.disabled = !active;
  if (BTN_ACTIVATE) BTN_ACTIVATE.textContent = active ? "Show Details" : "Activate";

  document.querySelectorAll(".card").forEach(card => {
    const appid = card.dataset.appid;
    if (active) {
      if (card.classList.contains("disabled")) {
        card.classList.remove("disabled");
        card.title = "";
        card.onclick = () => { if (GRID_LOCKED) return; selectGame(appid, card); };
      }
    } else {
      if (!card.classList.contains("disabled")) {
        card.classList.add("disabled");
        card.title = "Activate your license to view details";
      }
      card.onclick = () => openActivate({
        expired: CURRENT_LICENSE && CURRENT_LICENSE.status === "expired",
        revoked: CURRENT_LICENSE && CURRENT_LICENSE.status === "revoked",
        expiry_date: CURRENT_LICENSE && CURRENT_LICENSE.expiry_date
      });
    }
  });
}

/** Load license, update UI, avoid grid flicker */
async function loadLicense(){
  const prevActive = (CURRENT_LICENSE && CURRENT_LICENSE.status === "active");

  let st;
  try{
    const r = await fetch("/api/license/check", { cache: "no-store" });
    st = await r.json();
  }catch(e){
    st = CURRENT_LICENSE || { status: "not_activated" };
  }

  CURRENT_LICENSE = st;
  renderLicenseStrip(st);
  updateActivationDependentUI(st);

  const nowActive = st.status === "active";
  if (prevActive !== nowActive) render();

  if (st.status !== "active" && LAST_STATUS !== st.status) {
    openActivate({
      expired: st.status === "expired",
      revoked: st.status === "revoked",
      expiry_date: st.expiry_date
    });
  }
  LAST_STATUS = st.status;

  return st;
}

/** Try to refresh license once more if cd_key is missing */
async function ensureLicenseHasKey(){
  if (!CURRENT_LICENSE || !getServerCdKey(CURRENT_LICENSE)){
    try{
      const r = await fetch("/api/license/check", { cache: "no-store" });
      const s = await r.json();
      CURRENT_LICENSE = s;
      renderLicenseStrip(s);
      updateActivationDependentUI(s);
    } catch(e){
      // ignore; fallback will handle
    }
  }
}

/** Open modal in details mode (active) or activation mode (else) */
async function openActivate(opts={}){
  // If we intend to show details, ensure we have the freshest license (esp. cd_key)
  const st0 = CURRENT_LICENSE || {};
  const wantsDetails = st0.status === "active" && !(opts && (opts.expired || opts.revoked));
  if (wantsDetails && !getServerCdKey(st0)){
    await ensureLicenseHasKey();
  }

  const st = CURRENT_LICENSE || {};
  const prevKeyLocal = localStorage.getItem(LAST_KEY_STORAGE) || "";
  const expired = !!opts.expired;
  const revoked = !!opts.revoked;
  const expDate = opts.expiry_date;

  const isActive = st.status === "active";
  const isDetailsMode = isActive && !expired && !revoked;

  // Load Steam users and populate dropdown before showing
  await loadSteamUsers();
  populateSteamSelect((st && st.steamid) || "");

  // reset base state
  INP_KEY.disabled = false;
  INP_KEY.readOnly = false;
  INP_KEY.classList.remove("readonly");

  if (INP_STEAM) { INP_STEAM.disabled = false; INP_STEAM.readOnly = false; INP_STEAM.classList.remove("readonly"); }
  if (SEL_STEAM) { SEL_STEAM.disabled = false; SEL_STEAM.classList.remove("readonly"); }

  BTN_ACT_DO.style.display = "";
  BTN_ACT_DO.disabled = false;
  MODAL_NOTE.style.display = "";
  MODAL_MSG.textContent = "";
  MODAL_WARN.classList.add("hidden");
  MODAL_WARN.textContent = "";

  if (isDetailsMode) {
    MODAL_TITLE.textContent = "License Details";
    MODAL_BACKDROP.classList.add("details-mode");
    MODAL_WARN.classList.remove("hidden");
    MODAL_WARN.textContent =
      `Plan: ${st.plan || "-"}${st.expiry_date ? " • Expires: " + st.expiry_date : ""}` +
      `${(st.days_left != null) ? " • " + daysWord(st.days_left) + " left" : ""}`;

    // Prefer server-provided key; fallback to saved local copy
    let shownKey = getServerCdKey(st);
    if (!shownKey && prevKeyLocal) shownKey = prevKeyLocal;

    INP_KEY.placeholder = "";
    INP_KEY.value   = shownKey || "";
    INP_KEY.disabled = true;           // fully non-editable
    INP_KEY.readOnly = true;           // belt & suspenders
    INP_KEY.classList.add("readonly"); // greyed styling

    // Lock Steam account dropdown to bound SteamID
    if (SEL_STEAM){
      if (st.steamid) SEL_STEAM.value = st.steamid;
      SEL_STEAM.disabled = true;
      SEL_STEAM.classList.add("readonly");
    }
    if (INP_STEAM){
      INP_STEAM.value = st.steamid || "";
      INP_STEAM.disabled = true;
      INP_STEAM.readOnly = true;
      INP_STEAM.classList.add("readonly");
    }

    MODAL_NOTE.style.display = "none";
    BTN_ACT_DO.style.display = "none";   // hide Activate
    BTN_ACT_CANCEL.textContent = "Close";
  } else {
    MODAL_TITLE.textContent = "Activate License";
    MODAL_BACKDROP.classList.remove("details-mode");
    if (revoked) {
      MODAL_WARN.classList.remove("hidden");
      MODAL_WARN.textContent = `Your previous key ${prevKeyLocal ? `(${prevKeyLocal}) ` : ""}is no longer valid on the server. Please enter a new key.`;
    } else if (expired) {
      MODAL_WARN.classList.remove("hidden");
      MODAL_WARN.textContent = `Your previous key ${prevKeyLocal ? `(${prevKeyLocal}) ` : ""}has expired${expDate ? ` on ${expDate}` : ""}. Please enter a new key.`;
    }

    INP_KEY.value   = prevKeyLocal || "";
    BTN_ACT_CANCEL.textContent = "Cancel";
  }

  show(MODAL_BACKDROP);
}

/** Submit activation */
async function doActivate(){
  if (BTN_ACT_DO.style.display === "none" || BTN_ACT_DO.disabled) return;

  const cd_key  = INP_KEY.value.trim();
  // Prefer dropdown; if disabled or empty, fallback to hidden input (edge-case)
  let steamid = "";
  if (SEL_STEAM && !SEL_STEAM.disabled){
    steamid = (SEL_STEAM.value || "").trim();
  } else {
    steamid = (INP_STEAM.value || "").trim();
  }

  if (!cd_key || !steamid){
    MODAL_MSG.textContent = "Please enter both CD-Key and SteamID.";
    return;
  }

  BTN_ACT_DO.disabled = true;
  MODAL_MSG.textContent = "Activating…";

  try{
    const r = await fetch("/api/license/activate", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ cd_key, steamid })
    });

    const j = await r.json().catch(() => ({}));

    if (r.ok && j && (j.ok === true || j.status === "ok" || j.status === "success")) {
      localStorage.setItem(LAST_KEY_STORAGE, cd_key);
      MODAL_MSG.textContent = "Activated.";
      hide(MODAL_BACKDROP);
      await loadLicense();
    } else {
      MODAL_MSG.textContent = (j && (j.detail?.message || j.message || j.error)) || "Activation failed.";
      BTN_ACT_DO.disabled = false;
    }
  }catch(e){
    MODAL_MSG.textContent = "Activation error: " + e;
    BTN_ACT_DO.disabled = false;
  }
}

// Enter to submit (only when Activate button is visible)
function keySubmitHandler(ev){
  if (ev.key === "Enter"){
    if (BTN_ACT_DO && BTN_ACT_DO.style.display !== "none"){
      ev.preventDefault();
      doActivate();
    }
  }
}

// ----- Grid, panel, pagination -----
function showHeroPlaceholder(text){
  HERO_IMG.style.display = "none";
  try { HERO_IMG.removeAttribute("src"); } catch (e) {}
  HERO_PH.textContent = text || "Please select a game to show details";
  HERO_PH.style.display = "grid";
  HERO_WRAP.classList.add("empty");
}

function showHeroImage(url, alt){
  HERO_IMG.onload = () => { HERO_PH.style.display = "none"; HERO_IMG.style.display = "block"; HERO_WRAP.classList.remove("empty"); };
  HERO_IMG.onerror = () => { showHeroPlaceholder("Game cover not available"); };
  HERO_IMG.alt = alt || "";
  HERO_IMG.style.display = "none"; HERO_PH.style.display = "grid"; HERO_WRAP.classList.remove("empty");
  HERO_IMG.src = url;
}

function setPanelPlaceholder(){
  showHeroPlaceholder("Please select a game to show details");
  $("gameTitle").textContent = "Select a game";
  $("gameSub").textContent = "";
  $("username").value = "";
  $("password").value = "";
  $("code").textContent = "— — — — —";
  setStatus("");
  selectedAppId = null;
}

function computeAutoPageSize(){
  const gridW = GRID.clientWidth || 800;
  const gap = 12, minCardW = 150;
  const cols = Math.max(1, Math.floor((gridW + gap) / (minCardW + gap)));
  const cardW = (gridW - (cols - 1) * gap) / cols;
  const cardH = cardW * 3/2 + 60;
  const headerH = document.querySelector('.app-header')?.offsetHeight || 56;
  const margin = 180;
  const availH = Math.max(280, window.innerHeight - headerH - margin);
  const rows = Math.max(1, Math.floor(availH / (cardH + gap)));
  return Math.max(cols * rows, cols);
}
function pageCount(){ const ps = computeAutoPageSize(); return Math.max(1, Math.ceil(FILTERED.length / ps)); }

function makeCard(g){
  const d = document.createElement("div");
  d.className = "card";
  if (String(selectedAppId) === String(g.appid)) d.classList.add("selected");
  d.dataset.appid = g.appid;

  const img = document.createElement("img");
  img.className = "cover"; img.loading = "lazy";
  img.src = `https://steamcdn-a.akamaihd.net/steam/apps/${g.appid}/library_600x900.jpg`;
  img.alt = g.name || "";
  img.onerror = () => {
    const ph = document.createElement("div");
    ph.className = "placeholder";
    ph.textContent = "Game cover not available";
    img.replaceWith(ph);
  };

  const meta = document.createElement("div"); meta.className = "meta";
  const name = document.createElement("div"); name.className = "gname"; name.textContent = g.name || "(Untitled)";
  const appid = document.createElement("div"); appid.className = "appid"; appid.textContent = "AppID " + g.appid;

  meta.appendChild(name); meta.appendChild(appid);
  d.appendChild(img); d.appendChild(meta);

  const active = (CURRENT_LICENSE && CURRENT_LICENSE.status === "active");
  if (!active) {
    d.classList.add("disabled");
    d.title = "Activate your license to view details";
    d.onclick = () => openActivate({
      expired: CURRENT_LICENSE && CURRENT_LICENSE.status === "expired",
      revoked: CURRENT_LICENSE && CURRENT_LICENSE.status === "revoked",
      expiry_date: CURRENT_LICENSE && CURRENT_LICENSE.expiry_date
    });
  } else {
    d.onclick = () => { if (GRID_LOCKED) return; selectGame(g.appid, d); };
  }
  return d;
}

function render(){
  const ps = computeAutoPageSize();
  const totalPages = pageCount();
  if(page > totalPages) page = totalPages;
  const start = (page - 1) * ps;
  const chunk = FILTERED.slice(start, start + ps);

  GRID.innerHTML = "";
  chunk.forEach(g => GRID.appendChild(makeCard(g)));
  EMPTY.classList.toggle("hidden", !!FILTERED.length);

  $("pageInfo").textContent = `Page ${totalPages ? page : 1} / ${totalPages}`;
  $("prevBtn").disabled = page <= 1;
  $("nextBtn").disabled = page >= totalPages;

  updateActivationDependentUI(CURRENT_LICENSE || {});
}

function goPrev(){ if(page > 1){ page--; render(); window.scrollTo({top:0, behavior:"smooth"}); } }
function goNext(){ const t = pageCount(); if(page < t){ page++; render(); window.scrollTo({top:0, behavior:"smooth"}); } }

const debounce = (fn, wait=200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); }; };
const doSearch = debounce(() => {
  const q = $("search").value.trim().toLowerCase();
  FILTERED = !q ? ALL.slice() : ALL.filter(g => (g.name || "").toLowerCase().includes(q) || String(g.appid).includes(q));
  page = 1; setPanelPlaceholder(); render();
}, 200);

async function loadGames(){
  const r = await fetch("/api/games");
  const j = await r.json();
  ALL = j.items || [];
  FILTERED = ALL.slice();
  setPanelPlaceholder();
  render();
}

async function selectGame(appid, cardEl){
  document.querySelectorAll(".card.selected").forEach(el => el.classList.remove("selected"));
  cardEl?.classList.add("selected");
  selectedAppId = appid;
  try{
    const r = await fetch("/api/game/" + encodeURIComponent(appid));
    const j = await r.json();
    if(j.error){ setPanelPlaceholder(); return; }
    const coverUrl = `https://steamcdn-a.akamaihd.net/steam/apps/${j.appid}/header.jpg`;
    showHeroImage(coverUrl, j.name || "");
    $("gameTitle").textContent = j.name || "(Untitled)";
    $("gameSub").textContent   = "AppID " + j.appid;
    $("username").value = j.username || "";
    $("password").value = j.password || "";
    $("code").textContent = "— — — — —";
    setStatus("Ready.");
  }catch(e){ setPanelPlaceholder(); }
}

// ----- Actions -----
function togglePw(){
  const pw = $("password"), btn = $("btnShow");
  if(pw.type === "password"){ pw.type = "text"; btn.textContent = "Hide"; }
  else { pw.type = "password"; btn.textContent = "Show"; }
}

async function fetchCode(){
  const uname = $("username").value.trim();
  if(!uname){
    $("code").textContent = "— — — — —";
    setStatus("Please enter username.");
    return;
  }

  if(!CURRENT_LICENSE || CURRENT_LICENSE.status !== "active"){
    openActivate({
      expired: CURRENT_LICENSE && CURRENT_LICENSE.status === "expired",
      revoked: CURRENT_LICENSE && CURRENT_LICENSE.status === "revoked",
      expiry_date: CURRENT_LICENSE && CURRENT_LICENSE.expiry_date
    });
    return;
  }

  setStatus("Fetching code…");

  // 🔒 lock the grid & disable button
  setGridLocked(true);
  BTN_FETCH.disabled = true;

  try {
    const r = await fetch("/api/latest-code?username=" + encodeURIComponent(uname));
    const j = await r.json();

    if(j.status === "ok"){
      $("code").textContent = j.code;
      setStatus("Latest code loaded.");
    } else if (j.status === "too_old" || j.status === "no_match"){
      $("code").textContent = "— — — — —";
      setStatus("No New Code found, please try login again.");
    } else if (j.error === "license_expired"){
      openActivate({ expired: true, expiry_date: CURRENT_LICENSE && CURRENT_LICENSE.expiry_date });
    } else if (j.error === "license_not_activated"){
      openActivate({ expired: false });
    } else if (j.error === "license_revoked"){
      openActivate({ revoked: true });
    } else if (j.error){
      setStatus("Error: " + j.error);
    } else {
      setStatus("Unknown response.");
    }
  } catch(e) {
    $("code").textContent = "— — — — —";
    setStatus("Request failed.");
  } finally {
    // 🔓 always unlock the grid & re-enable button
    BTN_FETCH.disabled = false;
    setGridLocked(false);
  }
}

// ===== Bindings =====
document.addEventListener("DOMContentLoaded", async () => {
  $("btnShow").addEventListener("click", togglePw);
  BTN_FETCH.addEventListener("click", fetchCode);
  $("prevBtn").addEventListener("click", goPrev);
  $("nextBtn").addEventListener("click", goNext);
  $("search").addEventListener("input", doSearch);
  $("clearBtn").addEventListener("click", () => { $("search").value = ""; doSearch(); });

  // Top button: async open so we can ensure fresh cd_key first
  BTN_ACTIVATE.addEventListener("click", async () => { await openActivate({}); });

  // Modal actions
  BTN_ACT_CANCEL.addEventListener("click", () => hide(MODAL_BACKDROP));
  BTN_ACT_DO.addEventListener("click", doActivate);
  INP_KEY.addEventListener("keydown", (e)=>{ if(e.key==="Enter"&&BTN_ACT_DO.style.display!=="none"){e.preventDefault();doActivate();} });
  if (INP_STEAM) INP_STEAM.addEventListener("keydown", (e)=>{ if(e.key==="Enter"&&BTN_ACT_DO.style.display!=="none"){e.preventDefault();doActivate();} });

  BTN_FETCH.disabled = true;

  await loadLicense();
  await loadGames();

  setInterval(loadLicense, 15_000);
  window.addEventListener("resize", (()=>{ let t; return ()=>{ clearTimeout(t); t=setTimeout(render,120); }; })());
});
