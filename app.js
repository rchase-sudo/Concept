// app.js — Drafted concept generator, front end for the Forma concept pipeline
// Backend: Supabase edge function `pipeline` (start / approve_parcel / approve_zoning / approve_layout / rerun / status / list / delete)
// Flow: paste listing -> confirm parcel -> confirm zoning, setbacks, program -> review layout -> approve.
(() => {
  const root = document.getElementById("root");

  const state = {
    session: null,
    authMode: "signin", authError: "", authNotice: "", authBusy: false,
    jobs: [], jobsLoading: true,
    view: "new",              // "new" | "job"
    jobId: null,
    job: null,                // full status payload
    listingText: "",
    busy: false,
    error: "",
    sel: new Set(),           // selected parcel candidate indexes
    edit: null,               // zoning/program editor values for the open job
    editKey: null,
    showZoningEditor: false,  // re-open zoning editor from the layout screen
    lightbox: null,
  };
  let pollTimer = null, listTimer = null, map = null, mapLayers = [];

  const WORKING = new Set(["queued", "parsing", "parcel_approved", "building_ec", "ec_ready", "researching_zoning", "zoning_approved", "building_layout"]);
  const STEPS = ["Parcel", "Existing conditions", "Zoning & program", "Layout", "Approved"];
  const STEP_OF = { queued: 0, parsing: 0, awaiting_parcel: 0, parcel_approved: 1, building_ec: 1, ec_ready: 2, researching_zoning: 2,
    awaiting_zoning: 2, zoning_approved: 3, building_layout: 3, awaiting_layout: 3, layout_approved: 4 };
  const ERR_STEP_IDX = { parse: 0, ec: 1, zoning: 2, layout: 3 };
  const LABEL = { queued: "Queued", parsing: "Reading listing", awaiting_parcel: "Confirm parcel", parcel_approved: "Starting site survey",
    building_ec: "Existing conditions", ec_ready: "Existing conditions ready", researching_zoning: "Researching zoning",
    awaiting_zoning: "Confirm zoning & program", zoning_approved: "Starting layout", building_layout: "Laying out the site",
    awaiting_layout: "Review layout", layout_approved: "Approved", error: "Error" };

  // ------------------------------------------------------------- helpers
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v, d = 0) => (v === null || v === undefined || v === "" || isNaN(+v)) ? "—" : (+v).toLocaleString(undefined, { maximumFractionDigits: d });
  const when = (iso) => { if (!iso) return ""; const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); };
  const dotClass = (st) => st === "error" ? "err" : st === "layout_approved" ? "ok" : (st || "").startsWith("awaiting") ? "wait" : "run";
  function jobTitle(j) {
    const L = j?.listing || j || {};
    const street = L.street_address ? `${L.lot ? L.lot + ", " : ""}${L.street_address}` : null;
    return street || [L.city, L.state].filter(Boolean).join(", ") || "New listing";
  }
  function jobPlace(j) { const L = j?.listing || j || {}; return [L.city, L.state].filter(Boolean).join(", "); }
  function fileName(j, kind, ext) {
    const base = jobTitle(j).replace(/[\\/:*?"<>|]+/g, " ").trim();
    return `${base} - ${kind}.${ext}`;
  }
  function dlUrl(url, name) { return url ? url + (url.includes("?") ? "&" : "?") + "download=" + encodeURIComponent(name) : null; }

  async function api(body) {
    const { data: s } = await sb.auth.getSession();
    let token = s?.session?.access_token;
    const call = (t) => sb.functions.invoke("pipeline", { body, headers: t ? { Authorization: `Bearer ${t}` } : undefined });
    let res = await call(token);
    if (res.error && /401|auth/i.test(res.error.message || "")) {
      const { data: r } = await sb.auth.refreshSession();
      res = await call(r?.session?.access_token);
    }
    if (res.error) {
      let msg = res.error.message || "Request failed";
      try { const j = await res.error.context?.json?.(); if (j?.error) msg = j.error; } catch (_) {}
      throw new Error(msg);
    }
    if (res.data?.error) throw new Error(res.data.error);
    return res.data;
  }

  // ------------------------------------------------------------- data
  async function loadJobs() {
    try { state.jobs = (await api({ action: "list", limit: 50 })).jobs || []; }
    catch (e) { console.warn(e); }
    state.jobsLoading = false;
    renderSide();
  }

  async function openJob(id, { quiet = false } = {}) {
    if (state.jobId !== id) { state.sel = new Set(); state.edit = null; state.editKey = null; state.showZoningEditor = false; state.job = null; }
    state.view = "job"; state.jobId = id; state.error = "";
    if (!quiet) render();
    await refreshJob(true);
    history.replaceState(null, "", `#job=${id}`);
  }

  async function refreshJob(force = false) {
    if (!state.jobId) return;
    try {
      const j = await api({ action: "status", job_id: state.jobId });
      const prev = state.job;
      const changed = force || !prev || prev.status !== j.status || prev.progress !== j.progress || prev.updated_at !== j.updated_at ||
        prev.render_status !== j.render_status;
      state.job = j;
      if (j.status === "awaiting_parcel" && state.sel.size === 0 && j.candidates?.length) state.sel = new Set([0]);
      if (changed) { renderMain(); if (prev?.status !== j.status) loadJobs(); }
      schedulePoll();
    } catch (e) {
      state.error = e.message; renderMain();
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    const j = state.job;
    const renderPending = j && j.status === "layout_approved" && ["queued", "modeling", "rendering", "nanobanana"].includes(j.render_status);
    if (state.view === "job" && j && (WORKING.has(j.status) || renderPending)) pollTimer = setTimeout(() => refreshJob(), renderPending ? 6000 : 4000);
  }

  // ------------------------------------------------------------- actions
  async function startJob() {
    const text = state.listingText.trim();
    if (text.length < 40) { state.error = "Paste the full listing page (Ctrl+A, Ctrl+C on the listing, then paste here)."; renderMain(); return; }
    state.busy = true; state.error = ""; renderMain();
    try {
      const { job_id } = await api({ action: "start", listing_text: text, source: "tool" });
      state.listingText = "";
      await loadJobs();
      await openJob(job_id);
    } catch (e) { state.error = e.message; }
    state.busy = false; renderMain();
  }

  async function approveParcel() {
    const idx = [...state.sel].sort((a, b) => a - b);
    if (!idx.length) { state.error = "Select the parcel (or parcels) that make up the listing."; renderMain(); return; }
    await act({ action: "approve_parcel", job_id: state.jobId, indexes: idx });
  }

  async function approveZoning() {
    const e = state.edit;
    const n = (v) => (v === "" || v === null || isNaN(+v)) ? null : +v;
    const setbacks = { front: n(e.sb.front), side: n(e.sb.side), rear: n(e.sb.rear) };
    const pave = { front: n(e.pv.front), side: n(e.pv.side), rear: n(e.pv.rear) };
    if (Object.values(setbacks).some((v) => v === null) || Object.values(pave).some((v) => v === null)) {
      state.error = "Fill in every building and pavement setback."; renderMain(); return;
    }
    const buildings = e.buildings.filter((b) => n(b.footprint_sf) > 0).map((b, i) => ({
      name: b.name || `Building ${String.fromCharCode(65 + i)}`, use: b.use || b.label, label: b.label || b.use,
      footprint_sf: n(b.footprint_sf), depth_ft: n(b.depth_ft) || 60, stories: n(b.stories) || 1, drive_thru: !!b.drive_thru }));
    if (!buildings.length) { state.error = "Add at least one building."; renderMain(); return; }
    const program = { ...(state.job.program || {}), use: e.use, buildings, parking: { ...(state.job.program?.parking || {}), required: n(e.required), calc: e.calc } };
    state.showZoningEditor = false;
    await act({ action: "approve_zoning", job_id: state.jobId, setbacks, parking_setbacks: pave, program });
  }

  async function act(body) {
    state.busy = true; state.error = ""; renderMain();
    try { await api(body); await refreshJob(true); loadJobs(); }
    catch (e) { state.error = e.message; }
    state.busy = false; renderMain();
  }

  async function deleteJob() {
    if (!confirm("Delete this concept and its files?")) return;
    try { await api({ action: "delete", job_id: state.jobId }); } catch (e) { alert(e.message); return; }
    state.view = "new"; state.jobId = null; state.job = null; history.replaceState(null, "", "#");
    await loadJobs(); render();
  }

  // ------------------------------------------------------------- zoning editor model
  function ensureEditor(j) {
    const key = j.id + "|" + (j.zoning?.researched_at || "") + "|" + JSON.stringify(j.program?.buildings || []).length;
    if (state.edit && state.editKey === key) return;
    const z = j.zoning || {}, sb = j.setbacks || z.setbacks_ft || {}, pv = z.pavement_setbacks_ft || {};
    const prog = j.program || {};
    state.edit = {
      sb: { front: sb.front ?? "", side: sb.side ?? "", rear: sb.rear ?? "" },
      pv: { front: pv.front ?? "", side: pv.side ?? "", rear: pv.rear ?? "" },
      pvSrc: pv.source || {},
      use: prog.use || "",
      buildings: (prog.buildings || []).map((b) => ({ name: b.name || "", use: b.use || "", label: b.label || "", footprint_sf: b.footprint_sf ?? "",
        depth_ft: b.depth_ft ?? "", stories: b.stories ?? 1, drive_thru: !!b.drive_thru })),
      required: prog.parking?.required ?? "",
      calc: prog.parking?.calc || prog.parking?.ratio_text || "",
    };
    state.editKey = key;
  }

  // ------------------------------------------------------------- render: shell
  function render() {
    if (!state.session) { renderAuth(); return; }
    if (!root.querySelector(".shell")) {
      root.innerHTML = `
        <header class="topbar">
          <div class="brand"><span class="mark"></span> Drafted <small>Concept plans</small></div>
          <div class="topbar-right"><span>${esc(state.session.user.email)}</span><button class="btn sm ghost" data-a="signout">Sign out</button></div>
        </header>
        <div class="shell"><aside class="side" id="side"></aside><main id="main"></main></div>`;
    }
    renderSide(); renderMain();
  }

  function renderSide() {
    const side = root.querySelector("#side");
    if (!side) return;
    const items = state.jobs.map((j) => `
      <button class="job-item ${j.id === state.jobId && state.view === "job" ? "active" : ""}" data-a="open" data-id="${j.id}">
        <div class="t">${esc(jobTitle(j))}</div>
        <div class="s"><span class="dot ${dotClass(j.status)}"></span>${esc(LABEL[j.status] || j.status)} · ${esc(when(j.created_at))}</div>
      </button>`).join("");
    side.innerHTML = `
      <button class="btn primary" data-a="new" style="justify-content:center">+ New concept</button>
      <h4>Concepts</h4>
      ${state.jobsLoading ? `<div class="note" style="padding:6px">Loading…</div>` : items || `<div class="note" style="padding:6px">No concepts yet.</div>`}`;
  }

  function renderMain() {
    const main = root.querySelector("#main");
    if (!main) return;
    if (map) { try { map.off(); map.remove(); } catch (_) {} map = null; }
    if (state.view === "new") { main.innerHTML = viewNew(); bindNew(main); return; }
    const j = state.job;
    if (!j) { main.innerHTML = `<div class="card working"><div class="spin"></div><div><div class="w1">Loading…</div></div></div>`; return; }
    main.innerHTML = viewJob(j);
    bindJob(main, j);
  }

  // ------------------------------------------------------------- views
  function viewNew() {
    return `
      <div class="eyebrow">New concept</div>
      <h1 class="title">Paste the listing</h1>
      <p class="sub">Open the listing (LoopNet, Crexi, MLS…), press <b>Ctrl+A</b> then <b>Ctrl+C</b>, and paste it below. The pipeline finds the parcel,
        draws existing conditions on the aerial, researches zoning and setbacks, proposes a program and lays out the site. You confirm the parcel,
        the zoning and the layout along the way.</p>
      <div class="card" style="margin-top:22px">
        <textarea class="listing" id="listing" placeholder="Paste the whole listing page here…">${esc(state.listingText)}</textarea>
        ${state.error ? `<div class="err-box" style="margin-top:12px">${esc(state.error)}</div>` : ""}
        <div class="row" style="margin-top:14px">
          <span class="note">Tip: include the parcel ID / APN if the listing shows it — it pins the parcel instantly.</span>
          <span class="spacer"></span>
          <button class="btn primary" data-a="start" ${state.busy ? "disabled" : ""}>${state.busy ? "Starting…" : "Generate concept"}</button>
        </div>
      </div>`;
  }

  function stepper(j) {
    const cur = j.status === "error" ? (ERR_STEP_IDX[j.step] ?? 0) : (STEP_OF[j.status] ?? 0);
    return `<div class="stepper">${STEPS.map((s, i) => {
      const cls = j.status === "layout_approved" || i < cur ? "done" : i === cur ? "now" : "";
      return `<div class="step ${cls}"><span class="n">${String(i + 1).padStart(2, "0")}</span>${s}</div>`; }).join("")}</div>`;
  }

  function viewJob(j) {
    const L = j.listing || {};
    const facts = [L.acres && `${L.acres} ac`, L.zoning && `Zoned ${L.zoning}`, L.price && `$${num(L.price)}`].filter(Boolean).join(" · ");
    let body = "";
    if (j.status === "error") body = viewError(j);
    else if (j.status === "awaiting_parcel") body = viewParcel(j);
    else if (j.status === "awaiting_zoning" || (state.showZoningEditor && ["awaiting_layout", "layout_approved"].includes(j.status))) body = viewZoning(j);
    else if (j.status === "awaiting_layout" || j.status === "layout_approved") body = viewLayout(j);
    else body = viewWorking(j);
    return `
      <div class="row"><div class="eyebrow">${esc(LABEL[j.status] || j.status)}</div><span class="spacer"></span>
        <button class="btn sm danger" data-a="delete">Delete</button></div>
      <h1 class="title">${esc(jobTitle(j))}</h1>
      <div class="sub">${esc([jobPlace(j), facts].filter(Boolean).join(" — "))}</div>
      ${stepper(j)}
      ${state.error ? `<div class="err-box" style="margin-bottom:14px">${esc(state.error)}</div>` : ""}
      ${body}`;
  }

  function viewWorking(j) {
    const ec = j.files?.ec?.["existing_conditions.png"];
    const msg = {
      queued: "Queued — starting the worker", parsing: "Reading the listing and searching parcel records",
      parcel_approved: "Pulling aerial imagery, wetlands, flood zones and roads", building_ec: "Building the existing-conditions drawing",
      ec_ready: "Existing conditions done — starting zoning research", researching_zoning: "Researching the zoning ordinance and choosing a program",
      zoning_approved: "Starting the layout", building_layout: "Laying out buildings, parking, landscaping and the plan sheet",
    }[j.status] || j.progress;
    return `
      <div class="card working"><div class="spin"></div><div><div class="w1">${esc(msg)}</div>
        <div class="w2">${esc(j.progress || "")} · usually 1–5 minutes · this page updates on its own</div></div></div>
      ${ec ? `<div class="card"><h3>Existing conditions</h3><img class="plan" src="${ec}" data-a="zoom" data-src="${ec}" alt="Existing conditions"></div>` : ""}`;
  }

  function viewError(j) {
    return `
      <div class="card">
        <h3>Something went wrong ${j.step ? `<span class="tag">step: ${esc(j.step)}</span>` : ""}</h3>
        <div class="err-box">${esc(j.error || "Unknown error")}</div>
        <div class="row" style="margin-top:14px">
          <button class="btn primary" data-a="retry" ${state.busy ? "disabled" : ""}>Retry this step</button>
          ${j.step === "layout" && j.zoning ? `<button class="btn" data-a="editzoning">Adjust zoning / program</button>` : ""}
          ${j.candidates?.length && j.step !== "parse" ? `<button class="btn" data-a="repick">Pick a different parcel</button>` : ""}
        </div>
      </div>`;
  }

  function viewParcel(j) {
    const c = j.candidates || [];
    const list = c.map((p, i) => `
      <label class="cand ${state.sel.has(i) ? "sel" : ""}" data-i="${i}" style="border-left:4px solid ${state.sel.has(i) ? "#ff2b2b" : "#ffd400"}">
        <input type="checkbox" ${state.sel.has(i) ? "checked" : ""} data-a="pick" data-i="${i}">
        <div>
          <div class="a">${num(p.acres, 2)} ac ${i === 0 ? `<span class="tag g">best match</span>` : ""}${p.assemblage ? `<span class="tag y">${p.parts || ""} parcels combined</span>` : ""}</div>
          <div class="b">${esc(p.address || "No site address")}${p.dist_m === 0 ? ` <span class="tag g">at the address</span>` : p.dist_m != null ? ` · ${num(p.dist_m)} m from the address` : ""}<br>${p.apn ? "APN " + esc(p.apn) : ""}${p.owner ? " · " + esc(p.owner) : ""}${p.zoning ? " · " + esc(p.zoning) : ""}</div>
        </div>
      </label>`).join("");
    return `
      <div class="grid2">
        <div class="card" style="padding:12px"><div id="map"></div>
          <div class="row note" style="margin-top:10px;gap:16px">
            <span><span style="display:inline-block;width:12px;height:12px;border:2px solid #ff2b2b;background:rgba(255,43,43,.25);vertical-align:-2px"></span> Selected</span>
            <span><span style="display:inline-block;width:12px;height:12px;border:2px dashed #ffd400;background:rgba(255,212,0,.12);vertical-align:-2px"></span> Other candidates</span>
            <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#2f7bff;border:2px solid #fff;vertical-align:-1px"></span> Address location</span>
            <span class="spacer"></span><span>Click a parcel to select it</span>
          </div></div>
        <div class="card">
          <h3>Which parcel is the listing?</h3>
          <p class="note" style="margin:-6px 0 14px">Ranked by acreage, parcel ID, address and road frontage. Select more than one to combine
            tax parcels into one site. ${L_acres(j)}</p>
          ${list || `<div class="note">No candidates found.</div>`}
          <div class="row" style="margin-top:10px"><span class="spacer"></span>
            <button class="btn primary" data-a="approveparcel" ${state.busy || !state.sel.size ? "disabled" : ""}>Confirm parcel${state.sel.size > 1 ? "s" : ""}</button></div>
        </div>
      </div>`;
  }
  const L_acres = (j) => j.listing?.acres ? `Listing says <b>${esc(j.listing.acres)} ac</b>.` : "";

  function viewZoning(j) {
    ensureEditor(j);
    const e = state.edit, z = j.zoning || {}, s = j.summary || {};
    const ec = j.files?.ec?.["existing_conditions.png"];
    const conf = z.confidence ? `<span class="tag ${z.confidence === "high" ? "g" : "y"}">${esc(z.confidence)} confidence</span>` : "";
    const src = (k) => e.pvSrc?.[k] ? `<span class="tag ${e.pvSrc[k] === "ordinance" ? "g" : "y"}">${esc(e.pvSrc[k])}</span>` : "";
    const sbRow = (lab, key, obj) => `<div>${lab}</div>` + ["front", "side", "rear"].map((k) =>
      `<input class="fld" inputmode="decimal" data-bind="${obj}.${k}" value="${esc(e[obj][k])}">`).join("");
    const bRows = e.buildings.map((b, i) => `
      <tr>
        <td><input class="fld" data-bind="buildings.${i}.label" value="${esc(b.label || b.use)}" placeholder="RETAIL"></td>
        <td><input class="fld num" inputmode="numeric" data-bind="buildings.${i}.footprint_sf" value="${esc(b.footprint_sf)}"></td>
        <td><input class="fld num" inputmode="numeric" data-bind="buildings.${i}.depth_ft" value="${esc(b.depth_ft)}"></td>
        <td><input class="fld num" inputmode="numeric" data-bind="buildings.${i}.stories" value="${esc(b.stories)}" style="max-width:60px"></td>
        <td style="text-align:center"><input type="checkbox" data-bind="buildings.${i}.drive_thru" ${b.drive_thru ? "checked" : ""} style="accent-color:var(--accent)"></td>
        <td><button class="btn sm ghost" data-a="rmb" data-i="${i}" title="Remove">✕</button></td>
      </tr>`).join("");
    const uses = (z.uses || []).filter((u) => u.status === "permitted").slice(0, 14).map((u) => esc(u.use)).join(", ");
    return `
      <div class="grid2">
        <div>
          ${ec ? `<div class="card" style="padding:12px"><img class="plan" src="${ec}" data-a="zoom" data-src="${ec}" alt="Existing conditions"></div>` : ""}
          <div class="card">
            <h3>Site</h3>
            <div class="kv">
              <div><span>Parcel</span><b>${num(s.parcel_acres, 2)} ac</b></div>
              <div><span>Buildable</span><b>${num(s.buildable_acres, 2)} ac</b></div>
              <div><span>Usable from road</span><b>${num(s.frontage_buildable_acres, 2)} ac</b></div>
              <div><span>Frontage</span><b>${num(s.frontage_ft)} ft</b></div>
              <div><span>Wetlands</span><b>${num(s.wetland_acres, 2)} ac</b></div>
              <div><span>Flood (SFHA)</span><b>${num(s.flood_sfha_acres, 2)} ac</b></div>
            </div>
          </div>
        </div>
        <div>
          <div class="card">
            <h3>Zoning ${conf}</h3>
            <div class="kv">
              <div><span>District</span><b>${esc(z.district || "—")}</b></div>
              <div><span>Jurisdiction</span><b style="font-size:13px">${esc((z.jurisdiction || "—").slice(0, 60))}</b></div>
              <div><span>Max height</span><b>${z.max_height_ft ? num(z.max_height_ft) + " ft" : "—"}</b></div>
              <div><span>Max coverage</span><b>${z.max_lot_coverage_pct ? num(z.max_lot_coverage_pct) + "%" : "—"}</b></div>
            </div>
            <div style="margin-top:16px" class="sb-grid">
              <div></div><div class="h">Front</div><div class="h">Side</div><div class="h">Rear</div>
              ${sbRow("Building", "sb", "sb")}
              ${sbRow("Pavement", "pv", "pv")}
              <div></div><div>${src("front")}</div><div>${src("side")}</div><div>${src("rear")}</div>
            </div>
            <p class="note" style="margin:10px 0 0">Pavement = closest parking or drive aisle to the property line (the driveway may cross it).</p>
            ${uses ? `<details><summary>Permitted uses</summary><div class="notes">${uses}</div></details>` : ""}
            ${z.notes || z.parking_setback_note ? `<details><summary>Research notes</summary><div class="notes">${esc([z.notes, z.parking_setback_note].filter(Boolean).join("\n\n"))}</div></details>` : ""}
            ${(z.sources || []).length ? `<details><summary>Sources (${z.sources.length})</summary><div class="srcs">${z.sources.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`).join("")}</div></details>` : ""}
          </div>
          <div class="card">
            <h3>Program</h3>
            <input class="fld" data-bind="use" value="${esc(e.use)}" placeholder="Concept title (e.g. Retail / QSR)" style="margin-bottom:12px">
            ${j.program?.rationale ? `<p class="note" style="margin:0 0 12px">${esc(j.program.rationale)}</p>` : ""}
            <table class="ed"><thead><tr><th>Label</th><th>Footprint SF</th><th>Depth ft</th><th>Stories</th><th>Drive-thru</th><th></th></tr></thead>
              <tbody>${bRows}</tbody></table>
            <button class="btn sm" data-a="addb" style="margin-top:8px">+ Building</button>
            <div class="row" style="margin-top:16px">
              <div style="width:140px"><div class="note" style="margin-bottom:6px">Parking required</div>
                <input class="fld num" inputmode="numeric" data-bind="required" value="${esc(e.required)}"></div>
              <div style="flex:1;min-width:200px"><div class="note" style="margin-bottom:6px">Calculation</div>
                <input class="fld" data-bind="calc" value="${esc(e.calc)}"></div>
            </div>
            <div class="row" style="margin-top:18px"><span class="spacer"></span>
              ${state.showZoningEditor ? `<button class="btn ghost" data-a="canceledit">Cancel</button>` : ""}
              <button class="btn primary" data-a="approvezoning" ${state.busy ? "disabled" : ""}>Generate layout</button></div>
          </div>
        </div>
      </div>`;
  }

  function viewLayout(j) {
    const m = j.layout || {}, f = j.files || {};
    const png = f.layout?.["concept_plan.png"];
    const dls = [
      ["Concept plan (PDF)", f.layout?.["concept_plan.pdf"], fileName(j, "Concept Plan", "pdf")],
      ["Concept plan (DXF)", f.layout?.["concept_layout.dxf"], fileName(j, "Concept Plan", "dxf")],
      ["Existing conditions (PDF)", f.ec?.["existing_conditions.pdf"], fileName(j, "Existing Conditions", "pdf")],
      ["Existing conditions (DXF)", f.ec?.["existing_conditions.dxf"], fileName(j, "Existing Conditions", "dxf")],
      ["Aerial (JPG + JGW)", f.ec?.["aerial.jpg"], fileName(j, "Aerial", "jpg")],
    ].filter((d) => d[1]);
    const approved = j.status === "layout_approved";
    const R = f.render || {};
    const renderImg = R["render.png"] || R["render.jpg"];
    const model = R["model_front.png"];
    const RS = { queued: "Queued", modeling: "Building the 3D model", rendering: "Rendering the 3D model",
      nanobanana: "Nano Banana is rendering the photoreal view", failed: "Render failed", completed: "Render ready" }[j.render_status] || "";
    if (renderImg) dls.unshift(["Render (photoreal)", renderImg, fileName(j, "Render", R["render.jpg"] ? "jpg" : "png")]);
    if (model) dls.push(["3D model view", model, fileName(j, "3D Model", "png")]);
    const renderCard = !approved ? "" : `
      <div class="card" style="padding:12px;margin-bottom:16px">
        ${renderImg ? `<img class="plan" src="${renderImg}" data-a="zoom" data-src="${renderImg}" alt="Render">` :
          j.render_status === "failed" ? `<div class="err-box">Render failed: ${esc(j.render_error || "unknown error")}</div>` :
          `<div class="working" style="padding:14px"><div class="spin"></div><div><div class="w1">${esc(RS || "Starting the render")}</div>
            <div class="w2">3D model in Blender, then the Nano Banana photoreal pass · about 3–8 minutes</div></div></div>
           ${model ? `<img class="plan" src="${model}" data-a="zoom" data-src="${model}" alt="3D model" style="margin-top:10px">` : ""}`}
        ${renderImg || j.render_status === "failed" ? `<div class="row" style="margin-top:10px"><span class="note">${renderImg ? "Photoreal render (Nano Banana) of the 3D model" : ""}</span><span class="spacer"></span>
          <button class="btn sm" data-a="rerender" ${state.busy ? "disabled" : ""}>Re-render</button></div>` : ""}
      </div>`;
    return `${renderCard}
      <div class="card" style="padding:12px">${png ? `<img class="plan" src="${png}" data-a="zoom" data-src="${png}" alt="Concept plan">` : `<div class="note">Plan image missing.</div>`}</div>
      <div class="grid2" style="margin-top:16px">
        <div class="card">
          <h3>${esc(m.concept || j.program?.use || "Concept")}</h3>
          <div class="kv">
            <div><span>Building area</span><b>${num(m.gfa_sf)} SF</b></div>
            <div><span>Parking</span><b>${num(m.stalls)} / ${num(m.stalls_required)} req.</b></div>
            <div><span>Impervious</span><b>${num(m.impervious_pct, 1)}%</b></div>
            <div><span>Lot coverage</span><b>${num(m.lot_coverage_pct, 1)}%</b></div>
            <div><span>Development</span><b>${num(m.development_acres, 2)} ac</b></div>
            <div><span>Remaining land</span><b>${num(m.remaining_developable_acres, 2)} ac</b></div>
          </div>
          ${(m.buildings || []).length ? `<div class="notes" style="margin-top:14px">${m.buildings.map((b) => `${esc((b.use || b.name || "").toString())} — ${num(b.w_ft)}' × ${num(b.d_ft)}' · ${num(b.footprint_sf)} SF${b.drive_thru ? " · drive-thru" : ""}`).join("\n")}</div>` : ""}
          ${(m.warnings || []).length ? `<div class="warnings">${m.warnings.map((w) => `<div>⚠ ${esc(w)}</div>`).join("")}</div>` : ""}
        </div>
        <div class="card">
          <h3>Downloads</h3>
          <div class="dl">${dls.map(([lab, url, name]) => `<a class="btn sm" href="${dlUrl(url, name)}" target="_blank" rel="noopener">${esc(lab)}</a>`).join("")}</div>
          <p class="note" style="margin-top:12px">Sheets are ANSI D (34×22). DXFs are in state-plane feet with Forma layers.</p>
          <div class="row" style="margin-top:18px">
            <button class="btn" data-a="editzoning">Adjust zoning / program</button>
            <span class="spacer"></span>
            ${approved ? `<span class="tag g">Approved</span>` : `<button class="btn primary" data-a="approvelayout" ${state.busy ? "disabled" : ""}>Approve layout &amp; render</button>`}
          </div>
        </div>
      </div>`;
  }

  // ------------------------------------------------------------- bindings
  function bindNew(main) {
    const ta = main.querySelector("#listing");
    ta.addEventListener("input", () => { state.listingText = ta.value; });
    ta.focus();
  }

  function bindJob(main, j) {
    main.querySelectorAll("[data-bind]").forEach((el) => {
      el.addEventListener(el.type === "checkbox" ? "change" : "input", () => {
        const path = el.dataset.bind.split(".");
        let o = state.edit;
        for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
        o[path[path.length - 1]] = el.type === "checkbox" ? el.checked : el.value;
      });
    });
    if (j.status === "awaiting_parcel") drawMap(j);
  }

  function drawMap(j) {
    const el = document.getElementById("map");
    if (!el || !window.L) return;
    if (el._leaflet_id) return;
    map = L.map(el, { zoomControl: true, attributionControl: true, fadeAnimation: false, zoomAnimation: false });
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 20, maxNativeZoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" }).addTo(map);
    mapLayers = [];
    const group = L.featureGroup().addTo(map);
    (j.candidates || []).forEach((c, i) => {
      const lyr = L.geoJSON(c.geometry, { style: () => styleFor(i) });
      lyr.on("click", () => togglePick(i));
      lyr.bindTooltip(`${num(c.acres, 2)} ac${c.address ? " · " + esc(c.address) : ""}`, { sticky: true });
      lyr.on("mouseover", () => lyr.setStyle({ weight: 4 }));
      lyr.on("mouseout", () => lyr.setStyle(styleFor(i)));
      lyr.addTo(group);
      mapLayers[i] = lyr;
    });
    if (j.geocode?.lat) L.circleMarker([j.geocode.lat, j.geocode.lon], { radius: 6, color: "#fff", weight: 2, fillColor: "#2f7bff", fillOpacity: 1 })
      .bindTooltip(`Address location: ${esc(j.geocode.label || "")}`).addTo(map);
    const sel = [...state.sel].map((i) => mapLayers[i]).filter(Boolean);
    const target = sel.length ? L.featureGroup(sel) : group;
    try { map.fitBounds(target.getBounds().pad(0.6)); } catch (_) { map.setView([j.geocode?.lat || 37, j.geocode?.lon || -78], 16); }
  }
  function styleFor(i) {
    // selected parcels red, the other candidates yellow, so you can see where every option sits on the aerial
    const on = state.sel.has(i);
    return on ? { color: "#ff2b2b", weight: 3, fillColor: "#ff2b2b", fillOpacity: 0.22 }
              : { color: "#ffd400", weight: 2, fillColor: "#ffd400", fillOpacity: 0.10, dashArray: "6 4" };
  }
  function togglePick(i) {
    state.sel.has(i) ? state.sel.delete(i) : state.sel.add(i);
    mapLayers.forEach((l, k) => l && l.setStyle(styleFor(k)));
    root.querySelectorAll(".cand").forEach((el) => {
      const k = +el.dataset.i; el.classList.toggle("sel", state.sel.has(k)); el.querySelector("input").checked = state.sel.has(k);
      el.style.borderLeft = `4px solid ${state.sel.has(k) ? "#ff2b2b" : "#ffd400"}`; });
    const b = root.querySelector('[data-a="approveparcel"]');
    if (b) { b.disabled = !state.sel.size; b.textContent = `Confirm parcel${state.sel.size > 1 ? "s" : ""}`; }
  }

  // one delegated click handler
  root.addEventListener("click", async (ev) => {
    const t = ev.target.closest("[data-a]");
    if (!t) return;
    const a = t.dataset.a;
    if (a === "pick") { ev.preventDefault(); togglePick(+t.dataset.i); return; }
    if (t.classList.contains("cand")) return;
    switch (a) {
      case "signout": await sb.auth.signOut(); break;
      case "new": state.view = "new"; state.jobId = null; state.job = null; state.error = ""; history.replaceState(null, "", "#"); clearTimeout(pollTimer); render(); break;
      case "open": openJob(t.dataset.id); renderSide(); break;
      case "start": startJob(); break;
      case "approveparcel": approveParcel(); break;
      case "approvezoning": approveZoning(); break;
      case "approvelayout": act({ action: "approve_layout", job_id: state.jobId }); break;
      case "rerender": act({ action: "render", job_id: state.jobId }); break;
      case "retry": act({ action: "rerun", job_id: state.jobId, step: state.job.step || "parse" }); break;
      case "repick": state.error = ""; state.job.status = "awaiting_parcel"; renderMain(); break;
      case "editzoning": state.showZoningEditor = true; state.edit = null; if (state.job.status === "error") state.job.status = "awaiting_zoning"; renderMain(); break;
      case "canceledit": state.showZoningEditor = false; renderMain(); break;
      case "delete": deleteJob(); break;
      case "addb": state.edit.buildings.push({ label: "", use: "", footprint_sf: "", depth_ft: 60, stories: 1, drive_thru: false }); renderMain(); break;
      case "rmb": state.edit.buildings.splice(+t.dataset.i, 1); renderMain(); break;
      case "zoom": openLightbox(t.dataset.src); break;
    }
  });
  root.addEventListener("click", (ev) => {
    const c = ev.target.closest(".cand");
    if (c && !ev.target.closest("input")) { ev.preventDefault(); togglePick(+c.dataset.i); }
  });

  function openLightbox(src) {
    const d = document.createElement("div");
    d.className = "lightbox";
    d.innerHTML = `<img src="${src}" alt="">`;
    d.addEventListener("click", () => d.remove());
    document.addEventListener("keydown", function k(e) { if (e.key === "Escape") { d.remove(); document.removeEventListener("keydown", k); } });
    document.body.appendChild(d);
  }

  // ------------------------------------------------------------- auth
  function renderAuth() {
    const up = state.authMode === "signup";
    root.innerHTML = `
      <header class="topbar"><div class="brand"><span class="mark"></span> Drafted <small>Concept plans</small></div></header>
      <div class="auth-wrap"><form class="auth-card" id="authf">
        <div class="eyebrow">${up ? "Create account" : "Welcome back"}</div>
        <h2>${up ? "Sign up" : "Sign in"}</h2>
        <div class="note">Listing in, concept plan out.</div>
        <label>Email</label><input class="fld" id="ae" type="email" autocomplete="email" required>
        <label>Password</label><input class="fld" id="ap" type="password" autocomplete="${up ? "new-password" : "current-password"}" required minlength="6">
        ${state.authError ? `<div class="err-box" style="margin-top:14px">${esc(state.authError)}</div>` : ""}
        ${state.authNotice ? `<div class="note" style="margin-top:14px;color:var(--accent)">${esc(state.authNotice)}</div>` : ""}
        <button class="btn primary" style="width:100%;justify-content:center;margin-top:18px" ${state.authBusy ? "disabled" : ""}>${state.authBusy ? "…" : up ? "Create account" : "Sign in"}</button>
        <div class="auth-toggle">${up ? "Have an account?" : "New here?"} <button type="button" id="atg">${up ? "Sign in" : "Create one"}</button></div>
      </form></div>`;
    root.querySelector("#atg").onclick = () => { state.authMode = up ? "signin" : "signup"; state.authError = ""; renderAuth(); };
    root.querySelector("#authf").onsubmit = async (e) => {
      e.preventDefault();
      const email = root.querySelector("#ae").value.trim(), password = root.querySelector("#ap").value;
      state.authBusy = true; state.authError = ""; state.authNotice = ""; renderAuth();
      try {
        if (up) {
          const { data, error } = await sb.auth.signUp({ email, password });
          if (error) throw error;
          if (!data.session) { state.authNotice = "Check your email to confirm, then sign in."; state.authMode = "signin"; }
        } else {
          const { error } = await sb.auth.signInWithPassword({ email, password });
          if (error) throw error;
        }
      } catch (err) { state.authError = err.message || "Something went wrong."; }
      state.authBusy = false;
      if (!state.session) renderAuth();
    };
  }

  // ------------------------------------------------------------- boot
  async function boot() {
    const { data } = await sb.auth.getSession();
    state.session = data.session;
    sb.auth.onAuthStateChange((_ev, session) => {
      const was = !!state.session;
      state.session = session;
      if (!!session !== was) {
        root.innerHTML = "";
        if (session) { loadJobs(); render(); routeFromHash(); } else { clearTimeout(pollTimer); render(); }
      }
    });
    render();
    if (state.session) { await loadJobs(); routeFromHash(); }
    clearInterval(listTimer);
    listTimer = setInterval(() => { if (state.session && state.jobs.some((j) => WORKING.has(j.status))) loadJobs(); }, 15000);
  }
  function routeFromHash() {
    const m = location.hash.match(/job=([0-9a-f-]{36})/);
    if (m) openJob(m[1]);
  }
  boot();
})();
