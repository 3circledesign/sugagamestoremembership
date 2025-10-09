// ===== Helpers =====
const $ = id => document.getElementById(id);

// ONLINE filter toggle
let ONLINE_ONLY = false;
let selectedRid = null;

/** robust check for 1-year entitlement */
function hasOnlineEntitlement(st){
  if (!st || typeof st !== "object") return false;
  const plan = String(st.plan || "").trim().toLowerCase();
  // Accept 1-year AND lifetime style plans
  // tolerates: "1y", "1-year", "12m", "yearly", plus "lifetime", "life time", "permanent", "forever"
  return /\b(1\s*y|1-?year|12\s*m|12-?months|year|yearly|life\s*-?\s*time|lifetime|permanent|forever)\b/.test(plan);
}


// GitHub fallback cover (main branch, <appid>.jpg at repo root)
const GH_COVER = (appid) =>
  `https://raw.githubusercontent.com/barryhamsy/gamelist/main/${encodeURIComponent(appid)}.jpg`;

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
const BTN_LOGIN = $("btnLogin"); // NEW

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

// Code UI helper (works with new or old markup)
function setCodeUI(code){
  if (typeof window.setCodeDigits === "function"){
    window.setCodeDigits(code || "");
  } else {
    const el = $("code");
    if (el) el.textContent = code ? code : "— — — — —";
  }
}

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

/** return array after applying license gating + search + online toggle */
function applyFilters(){
  const q = ($("search")?.value || "").trim().toLowerCase();

  // start from all items
  let base = ALL.slice();

  // text search
  if (q){
    base = base.filter(g =>
      (g.name || "").toLowerCase().includes(q) ||
      String(g.appid || "").includes(q)
    );
  }

  // "Online" button toggle → show only online
  if (ONLINE_ONLY){
    base = base.filter(g => !!g.online_supported);
  }

  return base;
}

const BTN_ONLINE = document.getElementById("btnOnline");
if (BTN_ONLINE){
  BTN_ONLINE.addEventListener("click", () => {
    ONLINE_ONLY = !ONLINE_ONLY;
    BTN_ONLINE.classList.toggle("active", ONLINE_ONLY);
    // reset to first page when switching filter
    page = 1;
    // re-render with new filter
    render();
  });
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
  const has1Y  = hasOnlineEntitlement(st);

  if (BTN_FETCH)    BTN_FETCH.disabled = !active;
  if (BTN_LOGIN)    BTN_LOGIN.disabled = !active;
  if (BTN_ACTIVATE) BTN_ACTIVATE.textContent = active ? "Show Details" : "Activate";

  document.querySelectorAll(".card").forEach(card => {
    const rid      = card.dataset.rid;
    const isOnline = card.dataset.online === "1";

    if (!active){
      card.classList.add("disabled");
      card.classList.remove("online-locked");
      card.title = "Activate your license to view details";
      card.onclick = () => openActivate({
        expired: CURRENT_LICENSE && CURRENT_LICENSE.status === "expired",
        revoked: CURRENT_LICENSE && CURRENT_LICENSE.status === "revoked",
        expiry_date: CURRENT_LICENSE && CURRENT_LICENSE.expiry_date
      });
      return;
    }

    if (isOnline && !has1Y){
      card.classList.add("disabled","online-locked");
      card.title = "ONLINE feature requires a 1-Year plan";
      card.onclick = () => setStatus("ONLINE feature requires a 1-Year plan.");
    } else {
      card.classList.remove("disabled","online-locked");
      card.title = "";
      card.onclick = () => { if (GRID_LOCKED) return; selectGame(rid, card); };
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
  } else if (INP_STEAM) {
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

function showHeroImage(url, alt, fallbackUrl){
  HERO_IMG.onload = () => {
    HERO_PH.style.display = "none";
    HERO_IMG.style.display = "block";
    HERO_WRAP.classList.remove("empty");
  };
  HERO_IMG.onerror = () => {
    // try one fallback URL, then give up to placeholder
    if (fallbackUrl && !HERO_IMG.dataset.fallbackTried){
      HERO_IMG.dataset.fallbackTried = "1";
      HERO_IMG.src = fallbackUrl;
      return;
    }
    showHeroPlaceholder("Game cover not available");
  };
  HERO_IMG.alt = alt || "";
  HERO_IMG.style.display = "none";
  HERO_PH.style.display = "grid";
  HERO_WRAP.classList.remove("empty");
  HERO_IMG.removeAttribute("data-fallback-tried"); // reset flag each time
  HERO_IMG.referrerPolicy = "no-referrer";
  HERO_IMG.src = url;
}


function setPanelPlaceholder(){
  showHeroPlaceholder("Please select a game to show details");
  $("gameTitle").textContent = "Select a game";
  $("gameSub").textContent = "";
  if ($("username")) $("username").value = "";
  if ($("password")) $("password").value = ""; // stub-safe
  if ($("notes")) $("notes").textContent = "";
  if ($("notesWrap")) $("notesWrap").classList.add("hidden");
  setCodeUI(null);
  setStatus("");
  selectedAppId = null;
  setNotesContent("");
}

// Force a fixed page size (set to null/0 to disable)
window.FORCE_PAGE_SIZE = 20;

function computeAutoPageSize(){
  if (window.FORCE_PAGE_SIZE && Number.isInteger(window.FORCE_PAGE_SIZE) && window.FORCE_PAGE_SIZE > 0) {
    return window.FORCE_PAGE_SIZE;   // <- fixed count per page
  }

  // fallback to your existing auto logic if FORCE_PAGE_SIZE is not set
  const gridW = GRID.clientWidth || 800;
  const gap = 12, minCardW = 150;
  const cols = Math.max(1, Math.floor((gridW + gap) / (minCardW + gap)));
  const cardW = (gridW - (cols - 1) * gap) / cols;

  // SQUARE thumbs now
  const ratio = 1.0;
  const metaH = 60;
  const cardH = Math.round(cardW * ratio + metaH);

  const headerH = document.querySelector('.app-header')?.offsetHeight || 56;
  const pagerH  = document.getElementById('pager')?.offsetHeight || 48;
  const vPad    = 48;
  const availH  = Math.max(260, window.innerHeight - headerH - pagerH - vPad);

  const rows = Math.max(1, Math.floor((availH + gap) / (cardH + gap)));
  return Math.max(1, cols * rows);
}

function pageCount(){
  const ps = computeAutoPageSize();
  const total = applyFilters().length;
  return Math.max(1, Math.ceil(total / ps));
}

function makeCard(g){
  const d = document.createElement("div");
  d.className = "card";
  d.dataset.appid  = g.appid;
  d.dataset.rid    = String(g.rid);           // <-- store RID
  d.dataset.online = g.online_supported ? "1" : "0";
  if (String(selectedRid) === String(g.rid)) d.classList.add("selected");

  // cover
  const img = document.createElement("img");
  img.className = "cover";
  img.loading = "lazy";
  const primary  = `https://steamcdn-a.akamaihd.net/steam/apps/${g.appid}/library_600x900.jpg`;
  const fallback = GH_COVER(g.appid);
  img.src = primary;
  img.alt = g.name || "";
  img.onerror = () => {
    if (!img.dataset.fallbackTried){ img.dataset.fallbackTried = "1"; img.src = fallback; return; }
    const ph = document.createElement("div"); ph.className = "placeholder"; ph.textContent = "Cover not available";
    img.replaceWith(ph);
  };
  img.referrerPolicy = "no-referrer";

  // ONLINE pill over cover
  if (g.online_supported){
    const tag = document.createElement("span");
    tag.className = "tag tag-online";
    tag.textContent = "ONLINE";
    d.appendChild(tag);
  }

  // meta
  const meta  = document.createElement("div"); meta.className = "meta";
  const name  = document.createElement("div"); name.className = "gname";  name.textContent  = g.name || "(Untitled)";
  const appid = document.createElement("div"); appid.className = "appid"; appid.textContent = "AppID " + g.appid;
  meta.appendChild(name); meta.appendChild(appid);
  d.appendChild(img); d.appendChild(meta);

  // click behavior / disabled state
  const active = (CURRENT_LICENSE && CURRENT_LICENSE.status === "active");
  const has1Y  = hasOnlineEntitlement(CURRENT_LICENSE);
  const onlineLocked = g.online_supported && !has1Y;

  if (!active){
    d.classList.add("disabled");
    d.title = "Activate your license to view details";
    d.onclick = () => openActivate({
      expired: CURRENT_LICENSE && CURRENT_LICENSE.status === "expired",
      revoked: CURRENT_LICENSE && CURRENT_LICENSE.status === "revoked",
      expiry_date: CURRENT_LICENSE && CURRENT_LICENSE.expiry_date
    });
  } else if (onlineLocked){
    d.classList.add("disabled","online-locked");
    d.title = "ONLINE feature requires a 1-Year plan";
    d.onclick = () => setStatus("ONLINE feature requires a 1-Year plan.");
  } else {
    d.onclick = () => {
      if (GRID_LOCKED) return;
      selectGame(String(g.rid), d);   // <-- pass RID only
    };
  }

  return d;
}


function render(){
  const ps = computeAutoPageSize();
  const list = applyFilters();     // <— always filtered here
  const totalPages = Math.max(1, Math.ceil(list.length / ps));
  if (page > totalPages) page = totalPages;

  const start = (page - 1) * ps;
  const chunk = list.slice(start, start + ps);

  GRID.innerHTML = "";
  chunk.forEach(g => GRID.appendChild(makeCard(g)));
  EMPTY.classList.toggle("hidden", !!list.length);

  $("pageInfo").textContent = `Page ${totalPages ? page : 1} / ${totalPages}`;
  $("prevBtn").disabled = page <= 1;
  $("nextBtn").disabled = page >= totalPages;

  updateActivationDependentUI(CURRENT_LICENSE || {});
}

function goPrev(){ if(page > 1){ page--; render(); window.scrollTo({top:0, behavior:"smooth"}); } }
function goNext(){ const t = pageCount(); if(page < t){ page++; render(); window.scrollTo({top:0, behavior:"smooth"}); } }

const debounce = (fn, wait=200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); }; };
const doSearch = debounce(() => {
  page = 1;
  setPanelPlaceholder();
  render(); // filtering is handled inside render() via applyFilters()
}, 200);

async function loadGames(){
  const r = await fetch("/api/games");
  const j = await r.json();
  ALL = j.items || [];
  setPanelPlaceholder();
  render();             // applyFilters() will use the search text + online toggle + plan
}

async function refreshGameList(){
  const btn = document.getElementById("btnRefresh");
  try{
    setStatus("Refreshing game list…");
    setGridLocked(true);
    if (btn) { btn.disabled = true; btn.textContent = "Refreshing…"; }

    // POST to backend
    const r = await fetch("/api/games/refresh", { method: "POST" });
    const j = await r.json().catch(()=> ({}));

    if (!r.ok || !j.ok){
      const msg = (j && (j.message || j.error)) || ("HTTP " + r.status);
      setStatus("Refresh failed: " + msg);
      return;
    }

    // success → reload UI
    // reset to first page, hide the side panel, reload games
    page = 1;
    if (typeof hidePanel === "function") hidePanel();
    await loadGames();
    setStatus(`Game list updated (${j.count ?? "?"} items).`);
  }catch(e){
    setStatus("Refresh error: " + e);
  }finally{
    setGridLocked(false);
    if (btn) { btn.disabled = false; btn.textContent = "Refresh"; }
  }
}


async function selectGame(rid, cardEl){
  // highlight
  document.querySelectorAll(".card.selected").forEach(el => el.classList.remove("selected"));
  if (cardEl) cardEl.classList.add("selected");

  selectedRid  = String(rid);
  selectedAppId = null; // will set after fetch

  try{
    const url = "/api/game/byid/" + encodeURIComponent(selectedRid); // <-- exact backend route
    const r   = await fetch(url, { cache: "no-store" });
    if (!r.ok){ setPanelPlaceholder(); return; }
    const j   = await r.json();
    if (j.error){ setPanelPlaceholder(); return; }

    selectedAppId = j.appid || null;

    const primaryHero = `https://steamcdn-a.akamaihd.net/steam/apps/${j.appid}/header.jpg`;
    const ghFallback  = GH_COVER(j.appid);
    showHeroImage(primaryHero, j.name || "", ghFallback);

    $("gameTitle").textContent = j.name || "(Untitled)";
    $("gameSub").textContent   = "AppID " + j.appid;

    if ($("username")) $("username").value = j.username || "";
    if ($("password")) $("password").value = "";

    if ($("tpPlatform")) $("tpPlatform").value = j.third_platform || "";
    if ($("tpUser"))     $("tpUser").value     = j.third_username || "";
    if ($("tpPass"))     $("tpPass").value     = j.third_password ? String(j.third_password) : "";
    setNotesContent(j.notes || j.instructions || j.note || "");
    if ($("notes")) {
        const t = (j.notes || "").trim();
        $("notes").textContent = t;
        const wrap = $("notesWrap");
        if (wrap) wrap.classList.toggle("hidden", !t);
    }
    setCodeUI(null);
    setStatus("Ready.");
  }catch(e){
    console.error(e);
    setPanelPlaceholder();
  }
}


// ----- Actions -----
function togglePw(){
  // keep for compatibility if stubs exist; UI shouldn't expose password anyway
  const pw = $("password"), btn = $("btnShow");
  if(!pw || !btn) return;
  if(pw.type === "password"){ pw.type = "text"; btn.textContent = "Hide"; }
  else { pw.type = "password"; btn.textContent = "Show"; }
}

async function fetchCode(){
  const uname = ($("username")?.value || "").trim();
  if(!uname){
    setCodeUI(null);
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
  if (BTN_FETCH) BTN_FETCH.disabled = true;

  try {
    const r = await fetch("/api/latest-code?username=" + encodeURIComponent(uname));
    const j = await r.json();

    if(j.status === "ok"){
      setCodeUI(j.code);
      setStatus("Latest code loaded.");
    } else if (j.status === "too_old" || j.status === "no_match"){
      setCodeUI(null);
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
    setCodeUI(null);
    setStatus("Request failed.");
  } finally {
    // 🔓 always unlock the grid & re-enable button
    if (BTN_FETCH) BTN_FETCH.disabled = false;
    setGridLocked(false);
  }
}

// NEW: Login to Steam (password is read by backend from game_list.dat)
async function loginToSteam(){
  if(!CURRENT_LICENSE || CURRENT_LICENSE.status!=="active"){
    setStatus("Activate your license first.");
    openActivate({
      expired: CURRENT_LICENSE && CURRENT_LICENSE.status === "expired",
      revoked: CURRENT_LICENSE && CURRENT_LICENSE.status === "revoked",
      expiry_date: CURRENT_LICENSE && CURRENT_LICENSE.expiry_date
    });
    return;
  }
  if(!selectedRid){
    setStatus("Select a game first.");
    return;
  }

  setStatus("Launching Steam and submitting login…");
  setGridLocked(true);
  if (BTN_LOGIN) BTN_LOGIN.disabled = true;
  if (BTN_FETCH) BTN_FETCH.disabled = true;

  try{
    const r = await fetch("/api/steam/login", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ rid: Number(selectedRid) })  // <-- RID to backend
    });
    const j = await r.json().catch(()=> ({}));

    if (r.ok && (j.status === "ok")){
      setStatus("Login submitted. If Steam Guard appears, click Fetch Steam Guard Code.");
    } else if (r.ok && j.status === "guard_wait"){
      setStatus("Steam Guard required. Click Fetch Steam Guard Code.");
    } else if (j && j.error){
      const map = {
        deps_missing: "Missing desktop automation libraries (pywinauto/pyautogui).",
        steam_not_found: "Steam not found (registry/InstallPath missing).",
        appid_required: "No AppID/RID was provided.",
        credentials_not_found: "No credentials for this record.",
        login_window_control_failed: "Could not control Steam login window."
      };
      setStatus(map[j.error] || (j.message || "Login failed."));
    } else {
      setStatus("Login failed.");
    }
  }catch(e){
    setStatus("Request failed.");
  } finally {
    setGridLocked(false);
    if (BTN_LOGIN) BTN_LOGIN.disabled = false;
    if (BTN_FETCH) BTN_FETCH.disabled = false;
  }
}

// ===== Bindings =====
document.addEventListener("DOMContentLoaded", async () => {
  // Guard these in case stubs are missing
  const btnShow = $("btnShow");
  const btnRefresh = document.getElementById("btnRefresh");

  const btnCopyNotes = document.getElementById("btnCopyNotes");
  if (btnCopyNotes) btnCopyNotes.addEventListener("click", copyNotes);

// Optional: allow double-click on the notes box to copy (no extra HTML needed)
  const notesBox = document.getElementById("notes");
  if (notesBox) {
    notesBox.addEventListener("dblclick", (e) => {
        const sel = window.getSelection && window.getSelection().toString();
        if (sel && sel.trim()) return;  // user is selecting text — don't auto-copy
        copyNotes();                    // otherwise, quick copy
    });
  }
  if (btnRefresh) btnRefresh.addEventListener("click", refreshGameList);
  if (btnShow) btnShow.addEventListener("click", togglePw);

  if (BTN_FETCH) BTN_FETCH.addEventListener("click", fetchCode);
  if ($("prevBtn")) $("prevBtn").addEventListener("click", goPrev);
  if ($("nextBtn")) $("nextBtn").addEventListener("click", goNext);
  if ($("search")) $("search").addEventListener("input", doSearch);
  if ($("clearBtn")) $("clearBtn").addEventListener("click", () => { $("search").value = ""; doSearch(); });
    if (BTN_ADD) BTN_ADD.addEventListener("click", addGameToAccount);
  // Top button: async open so we can ensure fresh cd_key first
  if (BTN_ACTIVATE) BTN_ACTIVATE.addEventListener("click", async () => { await openActivate({}); });

  // Modal actions
  if (BTN_ACT_CANCEL) BTN_ACT_CANCEL.addEventListener("click", () => hide(MODAL_BACKDROP));
  if (BTN_ACT_DO) BTN_ACT_DO.addEventListener("click", doActivate);
  if (INP_KEY) INP_KEY.addEventListener("keydown", (e)=>{ if(e.key==="Enter"&&BTN_ACT_DO&&BTN_ACT_DO.style.display!=="none"){e.preventDefault();doActivate();} });
  if (INP_STEAM) INP_STEAM.addEventListener("keydown", (e)=>{ if(e.key==="Enter"&&BTN_ACT_DO&&BTN_ACT_DO.style.display!=="none"){e.preventDefault();doActivate();} });

  // NEW: Login button
  if (BTN_LOGIN) BTN_LOGIN.addEventListener("click", loginToSteam);

  if (BTN_FETCH) BTN_FETCH.disabled = true;
  if (BTN_LOGIN) BTN_LOGIN.disabled = true;

  await loadLicense();
  await loadGames();

  setInterval(loadLicense, 15_000);
  window.addEventListener("resize", (()=>{ let t; return ()=>{ clearTimeout(t); t=setTimeout(render,120); }; })());
});
// --- Right panel alignment with header/logo ---
function updatePanelPullUp() {
  const lic = document.getElementById('licStrip');
  const sb  = document.querySelector('.searchbar');

  const fullOuterH = el => {
    if (!el) return 0;
    const cs = getComputedStyle(el);
    return el.offsetHeight
         + parseFloat(cs.marginTop || 0)
         + parseFloat(cs.marginBottom || 0);
  };

  let h = 0;
  // only count license strip if it is visible
  if (lic && !lic.classList.contains('hidden')) h += fullOuterH(lic);
  h += fullOuterH(sb);

  // write to CSS variable
  document.documentElement.style.setProperty('--affix-stack-h', `${h}px`);
}
document.addEventListener('DOMContentLoaded', () => {
  updatePanelPullUp();
  window.addEventListener('resize', () => {
    // debounce a little to avoid layout thrash
    clearTimeout(updatePanelPullUp._t);
    updatePanelPullUp._t = setTimeout(updatePanelPullUp, 80);
  });
});

// ensure recalculation when license bar toggles/changes
const _renderLicenseStrip = renderLicenseStrip;  // keep a ref if you want to patch
renderLicenseStrip = function(st){
  _renderLicenseStrip(st);
  updatePanelPullUp();
};

(function(){
  function setAffixHeights(){
    const h = document.querySelector('.app-header');
    const l = document.getElementById('licStrip');
    const s = document.querySelector('.searchbar');
    const root = document.documentElement;
    root.style.setProperty('--header-h', `${(h?.offsetHeight||0)}px`);
    root.style.setProperty('--lic-h',    `${(l?.offsetHeight||0)}px`);
    root.style.setProperty('--search-h', `${(s?.offsetHeight||0)}px`);
  }
  setAffixHeights();
  window.addEventListener('resize', () => { clearTimeout(setAffixHeights._t); setAffixHeights._t = setTimeout(setAffixHeights, 120); });
})();

const BTN_ADD = document.getElementById("btnAddGame");
const BTN_REMOVE = document.getElementById("btnRemoveGame");

function clearStatusAfter(ms=2000){
  const el = document.getElementById("status");
  if (!el) return;
  clearTimeout(clearStatusAfter._tid);
  clearStatusAfter._tid = setTimeout(() => { el.textContent = ""; }, ms);
}

async function addGameToAccount(){
  if (!CURRENT_LICENSE || CURRENT_LICENSE.status !== "active"){
    setStatus("Activate your license first.");
    openActivate({
      expired: CURRENT_LICENSE && CURRENT_LICENSE.status === "expired",
      revoked: CURRENT_LICENSE && CURRENT_LICENSE.status === "revoked",
      expiry_date: CURRENT_LICENSE && CURRENT_LICENSE.expiry_date
    });
    return;
  }
  if (selectedRid == null){
    setStatus("Select a game first.");
    return;
  }

  setGridLocked(true);
  if (BTN_ADD) BTN_ADD.disabled = true;
  setStatus("Checking install & preparing Steam…");

  try{
    const r = await fetch("/api/steam/add-game", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rid: Number(selectedRid) })
    });
    const j = await r.json().catch(()=> ({}));

    if (r.ok && j.status === "ok"){
      setStatus(`Done. AppID ${j.appid} added. Steam restarting…`);
      clearStatusAfter(2000);
    } else {
      // Friendly error mapping
      const code = (j && j.error) || (`HTTP_${r.status}`);
      let msg = (j && (j.message || j.error)) || `HTTP ${r.status}`;

      if (code === "app_not_installed"){
        const libs = (j.libraries || []).join(", ");
        msg = `Game not yet installed. Launch/install it in Steam, then try again.`;
      } else if (code === "state_not_ready"){
        msg = `Game not yet installed. Launch/install it in Steam, then try again.`;
      } else if (code === "download_failed"){
        msg = "Failed to download hid.dll. Check your connection and try again.";
      } else if (code === "steam_not_found"){
        msg = "Steam not found on this PC.";
      }

      setStatus("Add failed: " + msg);
    }
  }catch(e){
    setStatus("Request failed: " + e);
  }finally{
    setGridLocked(false);
    if (BTN_ADD) BTN_ADD.disabled = false;
  }
}

async function removeGameFromAccount(){
  if (selectedRid == null){
    setStatus("Select a game first.");
    return;
  }
  setGridLocked(true);
  if (BTN_REMOVE) BTN_REMOVE.disabled = true;
  setStatus("Removing from Steam…");

  try{
    const r = await fetch("/api/steam/remove-game", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rid: Number(selectedRid) })
    });
    const j = await r.json().catch(()=> ({}));

    if (r.ok && j.status === "ok"){
      setStatus(`Removed AppID ${j.appid} from your Steam list.`);
      clearStatusAfter(2000);
    } else {
      const msg = (j && (j.message || j.error)) || `HTTP ${r.status}`;
      setStatus("Remove failed: " + msg);
    }
  }catch(e){
    setStatus("Request failed: " + e);
  }finally{
    setGridLocked(false);
    if (BTN_REMOVE) BTN_REMOVE.disabled = false;
  }
}

// Bind the remove button somewhere in your DOMContentLoaded:
document.addEventListener("DOMContentLoaded", () => {
  if (BTN_ADD)    BTN_ADD.addEventListener("click", addGameToAccount);
  if (BTN_REMOVE) BTN_REMOVE.addEventListener("click", removeGameFromAccount);
});

function escapeHtml(s = "") {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function linkifyNotes(text = "") {
  // escape HTML, then make links, then keep line breaks
  let html = escapeHtml(text);

  // linkify: http(s)://…, steam://…, and bare www.
  html = html
    .replace(/(https?:\/\/[^\s<]+)/gi, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(steam:\/\/[^\s<]+)/gi,  '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\b(www\.[^\s<]+)/gi,     '<a href="http://$1" target="_blank" rel="noopener noreferrer">$1</a>');

  // preserve newlines
  html = html.replace(/\r?\n/g, "<br>");
  return html;
}

function setNotesContent(text) {
  const wrap = document.getElementById("notesWrap");
  const el   = document.getElementById("notes");
  if (!el || !wrap) return;

  const t = (text || "").trim();
  if (!t) {
    el.innerHTML = '<span class="muted">—</span>';
    wrap.classList.add("hidden");
  } else {
    el.innerHTML = linkifyNotes(t);
    wrap.classList.remove("hidden");
  }
}

// Copy handlers
function copyNotes() {
  const el = document.getElementById("notes");
  if (!el) return;
  const txt = el.innerText.trim();
  if (!txt) return;
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(txt).then(showToast);
  } else {
    const ta = document.createElement("textarea");
    ta.value = txt;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    showToast();
  }
}

// or just call it at the end of loadLicense():
// await loadLicense();  -> already in your code
// After CURRENT_LICENSE is set:

updatePanelPullUp();
