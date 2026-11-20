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
    mode: "single",           // new-concept form: "single" | "batch"
    tier: "full",             // package research: "full" | "lite"
    unattended: false,        // single project: skip the approval checkpoints
    batchId: null, batchJobs: [], batchParent: null,
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
  const LABEL = { batch_done: "Batch done", batch_running: "Batch running", queued: "Queued", parsing: "Reading listing", awaiting_parcel: "Confirm parcel", parcel_approved: "Starting site survey",
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
    // a job row has its own `error` column; only an API-level error response has `error` without a job id
    if (res.data?.error && !res.data?.id) throw new Error(res.data.error);
    return res.data;
  }

  // ------------------------------------------------------------- data
  async function loadJobs() {
    try { state.jobs = (await api({ action: "list", limit: 100 })).jobs || []; }
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
        prev.render_status !== j.render_status || prev.package_status !== j.package_status || prev.design_status !== j.design_status || prev.summary?.preview?.status !== j.summary?.preview?.status;
      state.job = j;
      if (j.status === "awaiting_parcel" && state.sel.size === 0 && j.candidates?.length) state.sel = new Set([0]);
      if (changed) { renderMain(); if (prev?.status !== j.status) loadJobs(); }
      schedulePoll();
    } catch (e) {
      state.error = e.message; renderMain();
    }
  }

  // ------------------------------------------------------------- batches
  async function openBatch(id) {
    state.view = "batch"; state.batchId = id; state.jobId = null; state.job = null; state.error = "";
    history.replaceState(null, "", `#batch=${id}`);
    clearTimeout(pollTimer);
    render();
    await refreshBatch();
  }

  async function refreshBatch() {
    if (state.view !== "batch" || !state.batchId) return;
    try {
      const rows = (await api({ action: "list", batch: state.batchId, limit: 100 })).jobs || [];
      state.batchParent = rows.find((r) => r.id === state.batchId) || state.batchParent;
      state.batchJobs = rows.filter((r) => r.id !== state.batchId).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      renderMain(); renderSide();
    } catch (e) { state.error = e.message; renderMain(); }
    const open = !state.batchJobs.length || state.batchJobs.some((k) => batchState(k).phase === "running") || state.batchParent?.status === "queued" || state.batchParent?.status === "batch_running" && !state.batchJobs.length;
    clearTimeout(pollTimer);
    if (state.view === "batch" && open) pollTimer = setTimeout(refreshBatch, 6000);
  }

  // one line per child: where it is, and whether it is finished
  function batchState(k) {
    if (k.status === "error") return { phase: "error", text: "Error", detail: k.error || "" };
    if (k.options?.lite && k.preview_status === "built") return { phase: "done", text: "Preview page ready" };
    if (k.options?.lite && k.preview_status === "error") return { phase: "error", text: "Preview page failed" };
    if (k.status === "awaiting_parcel" && String(k.progress || "").startsWith("Needs parcel confirmation")) return { phase: "error", text: "Needs attention", detail: k.progress };
    if (k.package_status === "completed") return { phase: "done", text: "Package ready" };
    if (k.package_status === "failed") return { phase: "error", text: "Package failed" };
    if (k.package_status) return { phase: "running", text: "Writing the package" };
    if (k.status === "layout_approved") return { phase: "running", text: k.render_status === "failed" ? "Render failed" : "Rendering" };
    return { phase: k.render_status === "failed" ? "error" : "running", text: LABEL[k.status] || k.status };
  }

  function viewBatch() {
    const kids = state.batchJobs, p = state.batchParent;
    const done = kids.filter((k) => batchState(k).phase === "done").length, bad = kids.filter((k) => batchState(k).phase === "error").length;
    const rows = kids.map((k) => { const b = batchState(k); return `
      <button class="job-item" data-a="open" data-id="${k.id}" style="width:100%;margin-bottom:6px">
        <div class="t">${esc(jobTitle(k))}${jobPlace(k) ? ` <span class="note">· ${esc(jobPlace(k))}</span>` : ""}</div>
        <div class="s"><span class="dot ${b.phase === "done" ? "ok" : b.phase === "error" ? "err" : "run"}"></span>${esc(b.text)}${b.detail ? ` — ${esc(String(b.detail).slice(0, 140))}` : ""}</div>
      </button>`; }).join("");
    return `
      <div class="row"><div class="eyebrow">Batch · ${p?.options?.lite ? "Lite" : "Full"} packages</div><span class="spacer"></span>
        <button class="btn sm danger" data-a="deletebatch">Delete batch</button></div>
      <h1 class="title">${kids.length ? `${done} of ${kids.length} ${p?.options?.lite ? "preview pages" : "packages"} ready` : "Starting the batch"}</h1>
      <div class="sub">${esc(p?.progress || "")}${bad ? ` · ${bad} need attention` : ""}. Each listing runs on its own with no approval steps, so you can leave this page.
        Finished concepts are in your Concepts list, and Claude can pull them from the batch.</div>
      ${state.error ? `<div class="err-box" style="margin-bottom:14px">${esc(state.error)}</div>` : ""}
      <div style="margin-top:18px">${rows || `<div class="card working"><div class="spin"></div><div><div class="w1">${esc(p?.progress || "Splitting the listings")}</div></div></div>`}</div>`;
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    const j = state.job;
    if (j && state.tfWaitOpen === j.id && j.summary?.testfit_status === "ready" && j.files?.testfit?.["base.json"]) { state.tfWaitOpen = null; setTimeout(openTestFit, 0); }
    const renderPending = j && j.status === "layout_approved" && ["queued", "modeling", "rendering", "nanobanana", "compositing"].includes(j.render_status);
    const pkgPending = j && (["queued", "researching", "writing", "typesetting"].includes(j.package_status) || ["queued", "designing"].includes(j.design_status) || ["queued", "building"].includes(j.summary?.preview?.status) || j.summary?.testfit_status === "building" || j.design?.c3d_status === "building");
    if (state.view === "job" && j && (WORKING.has(j.status) || renderPending || pkgPending)) pollTimer = setTimeout(() => refreshJob(), renderPending || pkgPending ? 6000 : 4000);
  }

  // ------------------------------------------------------------- actions
  async function startJob() {
    const text = state.listingText.trim();
    if (text.length < 20) { state.error = "Add the property: an address or parcel ID, and the town and state."; renderMain(); return; }
    state.busy = true; state.error = ""; renderMain();
    try {
      if (state.mode === "batch") {
        const { job_id } = await api({ action: "start_batch", text, lite: state.tier === "lite" });
        state.listingText = "";
        await loadJobs();
        await openBatch(job_id);
      } else {
        const { job_id } = await api({ action: "start", listing_text: text, source: "tool", options: { lite: state.tier === "lite", auto: state.unattended } });
        state.listingText = "";
        await loadJobs();
        await openJob(job_id);
      }
    } catch (e) { state.error = e.message; }
    state.busy = false; renderMain();
  }

  async function approveParcel() {
    const idx = [...state.sel].sort((a, b) => a - b);
    if (!idx.length) { state.error = "Select the parcel (or parcels) that make up the listing."; renderMain(); return; }
    await act({ action: "approve_parcel", job_id: state.jobId, indexes: idx });
  }

  async function approveZoning(manual = false) {
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
    if (!buildings.length && !manual) { state.error = "Add at least one building."; renderMain(); return; }
    const j0 = state.job;
    const program = { ...(state.job.program || {}), use: e.use, buildings, parking: { ...(state.job.program?.parking || {}), required: n(e.required), calc: e.calc } };
    if (String(e.minrlv ?? "").trim() === "") delete program.min_rlv; else program.min_rlv = n(e.minrlv);
    if (e.denseok) program.dense_ok = true; else { delete program.dense_ok; delete program.dense_layout; }
    state.showZoningEditor = false;
    await act({ action: "approve_zoning", job_id: state.jobId, setbacks, parking_setbacks: pave, program, drive_road: e.drive || null, manual: !!manual,
      zoning: { max_slope_pct: +e.slope || 0, building_actions: Object.fromEntries((j0.summary?.existing_buildings || []).map((b) => [b.id, e.bact[b.id] === "demo" ? "demo" : "keep"])),
        pavement_actions: Object.fromEntries((j0.summary?.existing_pavement || []).map((p) => [p.id, e.pact[p.id] === "remove" ? "remove" : "reuse"])),
        shared_stalls: Math.max(0, parseInt(e.sstalls, 10) || 0), tie_existing: e.tie !== false } });
  }

  async function act(body) {
    state.busy = true; state.error = ""; renderMain();
    try {
      await api(body);
      if (state.job && body.action === "approve_zoning") { state.job.status = "zoning_approved"; state.job.progress = "Starting the layout"; }
      if (state.job && body.action === "approve_parcel") { state.job.status = "parcel_approved"; }
      if (state.job && body.action === "package") { state.job.package_status = "queued"; }
      if (state.job && body.action === "design") { state.job.design_status = "queued"; }
      if (state.job && body.action === "preview") { state.job.summary = { ...(state.job.summary || {}), preview: { ...(state.job.summary?.preview || {}), status: "queued", reason: null } }; }
      if (state.job && body.action === "rerun") { state.job.status = { parse: "parsing", ec: "building_ec", zoning: "researching_zoning", layout: "building_layout" }[body.step] || state.job.status; }
      state.busy = false; renderMain(); window.scrollTo({ top: 0, behavior: "smooth" });
      await refreshJob(true); loadJobs();
    } catch (e) {
      // the job moved on while this screen was open (e.g. still researching): reload it and say so
      state.error = /Job is /.test(e.message) ? `This concept changed while the page was open (${e.message}). It has been reloaded — try again.` : e.message;
      await refreshJob(true).catch(() => {});
    }
    state.busy = false; renderMain();
  }

  async function deleteBatch() {
    const ids = [...state.batchJobs.map((k) => k.id), state.batchId].filter(Boolean);
    if (!confirm(`Delete this batch and its ${state.batchJobs.length} listing${state.batchJobs.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
    try { for (const id of ids) await api({ action: "delete", job_id: id }); } catch (e) { alert(e.message); return; }
    state.view = "new"; state.batchId = null; state.batchJobs = []; state.batchParent = null;
    clearTimeout(pollTimer); history.replaceState(null, "", "#");
    await loadJobs(); render();
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
      minrlv: prog.min_rlv ?? "",     // minimum residual land value ($); blank = no minimum
      denseok: !!prog.dense_ok,       // dense row-and-aisle layout allowed when the standard layout cannot reach the minimum
      calc: prog.parking?.calc || prog.parking?.ratio_text || "",
      drive: z.drive_road || "",   // "" = automatic (longest frontage)
      slope: z.max_slope_pct === undefined ? "15" : (z.max_slope_pct ? String(z.max_slope_pct) : "0"),   // max slope (%) for building / parking; "0" = ignore slope
      bact: { ...(z.building_actions || {}) },   // existing building id -> "keep" | "demo" (default keep)
      pact: { ...(z.pavement_actions || {}) },   // existing pavement id -> "reuse" | "remove" (default reuse)
      tie: z.tie_existing !== false,             // tie the new development into kept pavement (default) instead of the public road
      sstalls: z.shared_stalls || 0,             // existing stalls the new program may count toward its parking
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
          <div class="topbar-right"><button class="btn sm ghost" data-a="cad">Civil 3D template</button><span>${esc(state.session.user.email)}</span><button class="btn sm ghost" data-a="signout">Sign out</button></div>
        </header>
        <div class="shell"><aside class="side" id="side"></aside><main id="main"></main></div>`;
    }
    renderSide(); renderMain();
  }

  function renderSide() {
    const side = root.querySelector("#side");
    if (!side) return;
    const batches = state.jobs.filter((j) => j.options?.batch_parent).map((j) => `
      <button class="job-item ${j.id === state.batchId && state.view === "batch" ? "active" : ""}" data-a="openbatch" data-id="${j.id}">
        <div class="t">Batch${j.options?.lite ? " · Lite" : ""}</div>
        <div class="s"><span class="dot ${j.status === "error" ? "err" : "run"}"></span>${esc(j.progress || j.status)} · ${esc(when(j.created_at))}</div>
      </button>`).join("");
    const items = state.jobs.filter((j) => !j.options?.batch_parent).map((j) => `
      <button class="job-item ${j.id === state.jobId && state.view === "job" ? "active" : ""}" data-a="open" data-id="${j.id}">
        <div class="t">${esc(jobTitle(j))}${j.options?.lite ? ` <span class="note">· Lite</span>` : ""}</div>
        <div class="s"><span class="dot ${dotClass(j.status)}"></span>${esc(LABEL[j.status] || j.status)} · ${esc(when(j.created_at))}</div>
      </button>`).join("");
    side.innerHTML = `
      <button class="btn primary" data-a="new" style="justify-content:center">+ New concept</button>
      ${batches ? `<h4>Batches</h4>${batches}` : ""}
      <h4>Concepts</h4>
      ${state.jobsLoading ? `<div class="note" style="padding:6px">Loading…</div>` : items || `<div class="note" style="padding:6px">No concepts yet.</div>`}`;
  }

  function renderMain() {
    const main = root.querySelector("#main");
    if (!main) return;
    if (map) { try { map.off(); map.remove(); } catch (_) {} map = null; }
    if (state.view === "new") { main.innerHTML = viewNew(); bindNew(main); return; }
    if (state.view === "batch") { main.innerHTML = viewBatch(); return; }
    if (state.view === "cad") { main.innerHTML = viewCad(); bindCad(main); return; }
    const j = state.job;
    if (!j) {
      main.innerHTML = state.error
        ? `<div class="err-box">${esc(state.error)}</div><div class="row" style="margin-top:12px"><button class="btn" data-a="open" data-id="${esc(state.jobId)}">Try again</button></div>`
        : `<div class="card working"><div class="spin"></div><div><div class="w1">Loading…</div></div></div>`;
      return;
    }
    main.innerHTML = viewJob(j);
    bindJob(main, j);
  }


  // ------------------------------------------------------------- Civil 3D template (account level)
  // The firm's .dwt / .dwg / .dxf (or the DRAFTEDSTANDARDS .json from the Civil 3D plugin): its layers are matched to Drafted's,
  // and every plan set's Civil 3D package (DXF linework + the plugin's import) comes out on those layers.
  const C3D_ROLES = [
    ["V-PROP-LINE", "Property line", "PROP BNDY BOUNDARY PL LOT PARCEL", 1], ["V-PROP-SBCK", "Setback lines", "SBCK SETBACK SETB BSL ESMT", 1],
    ["V-TOPO-MINR", "Existing minor contours", "TOPO CONT MINR MINOR", 1], ["V-TOPO-MAJR", "Existing major contours", "TOPO CONT MAJR MAJOR INDX", 1],
    ["V-TOPO-TEXT", "Existing contour labels", "TOPO CONT TEXT LABL ANNO", 1], ["V-ROAD-EDGE", "Existing road edge", "ROAD EOP PVMT EDGE CURB", 1],
    ["V-BLDG", "Existing buildings", "BLDG BUILDING STRC", 1], ["V-TOPO", "Existing surface (EG)", "SURF TOPO EG EXIST TIN", 1],
    ["C-TOPO", "Proposed surface (FG)", "SURF TOPO FG FINISH GRAD TIN", 0], ["C-TOPO-MINR", "Proposed minor contours", "TOPO CONT GRAD MINR MINOR", 0],
    ["C-TOPO-MAJR", "Proposed major contours", "TOPO CONT GRAD MAJR MAJOR INDX", 0], ["C-TOPO-TEXT", "Proposed contour labels", "TOPO CONT GRAD TEXT LABL ANNO", 0],
    ["C-TOPO-SPOT", "Spot grades / COGO points", "SPOT ELEV POINT PNTS COGO GRAD", 0], ["C-GRAD-FEAT", "Grading feature lines", "FEAT FTLN GRAD BRKL BREAK", 0],
    ["C-BLDG", "Proposed buildings", "BLDG BUILDING STRC FTPT", 0], ["C-PVMT-EDGE", "Pavement edge / curb", "PVMT PAVE CURB EOP EDGE ASPH", 0],
    ["C-PKNG-STRP", "Parking striping", "STRP STRIPE PKNG PARK PAINT MRKG", 0], ["C-WALK", "Sidewalks", "WALK SDWK SIDEWALK CONC", 0],
    ["C-ROAD-CNTR", "Drive centerline (alignment)", "CNTR CL CENTER ALIGN ALGN", 0], ["C-ROAD-STAN", "Stationing text", "STAN STA STATION ALIGN", 0],
    ["C-STRM-PIPE", "Storm pipes", "STRM STORM SD DRAN DRAIN PIPE", 0], ["C-STRM-STRC", "Storm structures", "STRM STORM SD DRAN STRC STRUCT CB MH", 0],
    ["C-STRM-TEXT", "Storm labels", "STRM STORM SD TEXT LABL ANNO", 0], ["C-STRM-POND", "Detention pond", "POND BASN BASIN DETN SWM STRM", 0],
    ["C-SSWR-PIPE", "Sanitary pipes", "SSWR SAN SANI SEWR SEWER SS PIPE", 0], ["C-SSWR-FMAN", "Force main (polyline)", "FMAN FM FORCE SSWR SAN", 0],
    ["C-SSWR-STRC", "Sanitary manholes", "SSWR SAN SEWR STRC MH SMH", 0], ["C-SSWR-TEXT", "Sanitary labels", "SSWR SAN SEWR TEXT LABL ANNO", 0],
    ["C-SSWR-LATL", "Sanitary laterals", "LATL LAT SERV SVC SSWR SAN", 0], ["C-WATR-PIPE", "Water main (polyline)", "WATR WATER WTR WM DOM", 0],
    ["C-WATR-LATL", "Water services", "WATR WATER WTR LATL SERV SVC", 0], ["C-WATR-STRC", "Hydrants and valves", "WATR WATER HYDR HYD VALV VALVE FH", 0],
    ["C-POWR-UGND", "Underground electric", "POWR ELEC ELECTRIC UGND UE", 0], ["C-NGAS-UGND", "Gas", "NGAS GAS", 0],
    ["C-EROS-LOD", "Limit of disturbance", "LOD LIMIT DIST EROS ESC", 0], ["C-EROS-SILT", "Silt fence", "SILT SF EROS ESC FENC", 0],
  ];
  const C3D_GENERIC = new Set("PIPE TEXT LABL ANNO STRC STRUCT EDGE LAT LATL SERV SVC CONC ELEV POINT MH SD SS SF CL PL FM UE FH".split(" "));
  const toks = (n) => String(n).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  function c3dAutoMap(layers) {
    const names = layers.map((l) => l.name), out = {};
    for (const [std, , w, existing] of C3D_ROLES) {
      const exact = names.find((n) => n.toUpperCase() === std); if (exact) { out[std] = exact; continue; }
      const words = w.split(" "), sw = new Set(toks(std)); let best = null, bs = 0;
      for (const n of names) {
        const ts = toks(n), set = new Set(ts);
        if (!words.filter((x) => !C3D_GENERIC.has(x)).some((x) => set.has(x) || (x.length > 2 && ts.some((t) => t.includes(x))))) continue;
        let s = words.reduce((a, x) => a + (set.has(x) ? 2 : 0) + (x.length > 2 && ts.some((t) => t !== x && t.includes(x)) ? 0.5 : 0), 0) + 0.5 * ts.filter((t) => sw.has(t)).length;
        const ex = /^(EX|EXIST|EXST|V-|EXT)/i.test(n) || /EXIST/i.test(n);
        s += existing ? (ex ? 1.5 : -1) : (ex ? -2.5 : 0);
        if (s > bs) { bs = s; best = n; }
      }
      if (best && bs >= 2) out[std] = best;
    }
    return out;
  }
  async function readDxfLayers(file) {
    const head = await file.slice(0, 22).text();
    if (/AutoCAD Binary DXF/i.test(head)) throw new Error("That is a binary DXF. Save it as an ASCII DXF, or upload the .dwt and run DRAFTEDSTANDARDS in Civil 3D.");
    const text = await file.slice(0, 40e6).text();
    const lines = text.split(/\r?\n/);
    const layers = []; let inLayer = false, cur = null;
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const code = lines[i].trim(), val = lines[i + 1].trim();
      if (code === "0" && val === "TABLE" && lines[i + 2]?.trim() === "2" && lines[i + 3]?.trim() === "LAYER") { inLayer = true; continue; }
      if (!inLayer) { if (code === "0" && val === "ENTITIES") break; continue; }
      if (code === "0") { if (cur?.name) layers.push(cur); cur = val === "LAYER" ? { name: "", color: 7, linetype: "" } : null; if (val === "ENDTAB") break; continue; }
      if (!cur) continue;
      if (code === "2") cur.name = val; else if (code === "62") cur.color = Math.abs(+val) || 7; else if (code === "6") cur.linetype = val;
    }
    if (cur?.name) layers.push(cur);
    return layers.filter((l) => !l.name.includes("|"));
  }
  async function loadCadTemplate() {
    try { const r = await api({ action: "cad_template_get" }); state.cad = { tpl: r.template, url: r.file_url }; }
    catch (e) { state.cad = { tpl: null, error: e.message }; }
    if (state.view === "cad") renderMain();
  }
  function viewCad() {
    const C = state.cad;
    if (!C) { loadCadTemplate(); return `<div class="card working"><div class="spin"></div><div><div class="w1">Loading…</div></div></div>`; }
    const t = C.tpl || {}, layers = t.layers || [], map = { ...(t.mapping || {}) };
    const opts = (sel) => `<option value="">(Drafted layer)</option>` + layers.map((l) => `<option${l.name === sel ? " selected" : ""}>${esc(l.name)}</option>`).join("");
    return `
      <div class="eyebrow">Account</div>
      <h1 class="title">Civil 3D template</h1>
      <p class="sub">Your firm's template sets the layers every plan set's CAD export uses. In Civil 3D, the Drafted plugin builds the design as native objects (surfaces, storm and sanitary pipe networks on your parts lists, ponds, feature lines, alignment and profiles, COGO points) with your template's styles.</p>
      ${C.error ? `<div class="err-box">${esc(C.error)}</div>` : ""}${state.cadMsg ? `<div class="note" style="margin-bottom:10px">${esc(state.cadMsg)}</div>` : ""}
      <div class="card" style="padding:14px 16px;margin-bottom:16px">
        <div class="row"><div><h3 style="margin:0">Template file</h3>
          <div class="note">${t.file_name ? `${esc(t.file_name)} · ${layers.length} layers${t.updated_at ? " · updated " + esc(new Date(t.updated_at).toLocaleDateString()) : ""}` : "None yet."}
          Upload a <b>.dxf</b> of your template (Save As DXF) or the <b>.json</b> from the plugin's DRAFTEDSTANDARDS command to read its layers. A <b>.dwt</b> / <b>.dwg</b> is kept for reference; the plugin matches layers itself when you import.</div></div>
          <span class="spacer"></span>
          ${C.url ? `<a class="btn sm" href="${C.url}" target="_blank" rel="noopener">Download</a>` : ""}
          ${t.file_name ? `<button class="btn sm ghost" data-a="caddelete" ${state.busy ? "disabled" : ""}>Remove</button>` : ""}
          <label class="btn primary sm" style="cursor:pointer">${state.busy ? "Uploading…" : t.file_name ? "Replace" : "Upload template"}<input type="file" id="cadFile" accept=".dwt,.dwg,.dxf,.json" style="display:none"></label></div>
      </div>
      ${layers.length ? `<div class="card" style="padding:14px 16px;margin-bottom:16px">
        <div class="row"><div><h3 style="margin:0">Layer matching</h3><div class="note">Drafted's layer on the left, yours on the right. Unmatched layers keep Drafted's name. Exports built after you save use these; use “Rebuild Civil 3D package” on a plan set to update an existing one.</div></div>
          <span class="spacer"></span><button class="btn sm ghost" data-a="cadauto">Auto-match again</button><button class="btn primary sm" data-a="cadsave" ${state.busy ? "disabled" : ""}>Save matching</button></div>
        <table class="cadmap" style="width:100%;margin-top:10px;border-collapse:collapse;font-size:13px">
          ${C3D_ROLES.map(([std, desc]) => `<tr style="border-top:1px solid var(--line,#e5e5e5)"><td style="padding:5px 6px;font-family:ui-monospace,monospace">${std}</td><td style="padding:5px 6px;color:var(--muted,#777)">${esc(desc)}</td>
            <td style="padding:5px 6px"><select data-std="${std}" style="width:100%">${opts(map[std])}</select></td></tr>`).join("")}
        </table></div>` : ""}
      <div class="card" style="padding:14px 16px">
        <div class="row"><div><h3 style="margin:0">Drafted plugin for Civil 3D 2027</h3>
          <div class="note">Unzip into <code>%APPDATA%\Autodesk\ApplicationPlugins\</code> and restart Civil 3D. Start a drawing from your template, run <b>DRAFTEDIMPORT</b> and pick a plan set's Civil 3D package (.zip). <b>DRAFTEDSTANDARDS</b> exports your template's layers and styles for upload here.</div></div>
          <span class="spacer"></span><button class="btn sm" data-a="plugin">Download plugin</button></div>
      </div>`;
  }
  function bindCad(main) {
    const inp = main.querySelector("#cadFile");
    if (inp) inp.addEventListener("change", () => inp.files[0] && uploadCad(inp.files[0]));
  }
  function cadMapping() {
    const m = {}; root.querySelectorAll("select[data-std]").forEach((s) => { if (s.value) m[s.dataset.std] = s.value; }); return m;
  }
  async function uploadCad(file) {
    state.busy = true; state.cadMsg = ""; renderMain();
    try {
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      let layers = null, styles = null;
      if (ext === "dxf") layers = await readDxfLayers(file);
      else if (ext === "json") {
        const j = JSON.parse(await file.text());
        if (j.format !== "drafted-standards") throw new Error("That .json is not from DRAFTEDSTANDARDS.");
        layers = j.layers || []; styles = j.styles || {};
      }
      if (file.size > 200e6) throw new Error("That file is over 200 MB.");
      const up = await api({ action: "cad_template_upload", file_name: file.name });
      const { error } = await sb.storage.from("pipeline").uploadToSignedUrl(up.path, up.token, file);
      if (error) throw error;
      const body = { action: "cad_template_save", file_name: file.name, file_path: up.path, file_kind: ext };
      if (layers) { body.layers = layers; body.mapping = c3dAutoMap(layers); }
      if (styles) body.styles = styles;
      if (!layers && state.cad?.tpl?.layers?.length) { body.layers = []; body.mapping = {}; }
      await api(body);
      state.cadMsg = layers ? `Read ${layers.length} layers from ${file.name} and matched ${Object.keys(body.mapping).length} of Drafted's ${C3D_ROLES.length}. Check the matches below and save.`
                            : `${file.name} saved. Layers are matched inside Civil 3D when you import (or upload a .dxf / DRAFTEDSTANDARDS .json to match them here).`;
    } catch (e) { state.cadMsg = ""; state.cad = { ...(state.cad || {}), error: e.message }; }
    state.busy = false; await loadCadTemplate();
  }
  async function saveCad(auto) {
    state.busy = true; renderMain();
    try {
      const layers = state.cad?.tpl?.layers || [];
      const mapping = auto ? c3dAutoMap(layers) : cadMapping();
      await api({ action: "cad_template_save", mapping });
      state.cadMsg = auto ? "Matched again from the layer names. Saved." : "Layer matching saved.";
    } catch (e) { state.cadMsg = e.message; }
    state.busy = false; await loadCadTemplate();
  }
  async function downloadPlugin() {
    try { const r = await api({ action: "plugin_url" }); window.open(r.url, "_blank", "noopener"); }
    catch (e) { state.error = e.message; renderMain(); }
  }

  // ------------------------------------------------------------- views
  function viewNew() {
    const batch = state.mode === "batch", lite = state.tier === "lite";
    const seg = (key, val, label) => `<button type="button" class="btn sm ${state[key] === val ? "primary" : "ghost"}" data-a="set" data-k="${key}" data-v="${val}">${label}</button>`;
    return `
      <div class="eyebrow">${batch ? "New batch" : "New concept"}</div>
      <h1 class="title">${batch ? "Paste the listings" : "Describe the site"}</h1>
      <p class="sub">${batch
        ? "Paste any number of listing descriptions into the one field (up to 40). Drafted splits them, then runs every listing on its own, with no approval steps: parcel, existing conditions, zoning, layout, render and package."
        : `Give Drafted the property and, if you like, what you want on it: an address or parcel ID, the acreage, and a short prompt.
        A full listing page pasted in works too. Drafted finds the parcel, maps existing conditions, researches zoning and setbacks,
        and lays out the site. You confirm the parcel, the zoning and the layout along the way.`}</p>
      <div class="card" style="margin-top:22px">
        <div class="row" style="margin-bottom:14px;gap:18px;flex-wrap:wrap">
          <span class="note">Start</span><span class="row" style="gap:6px">${seg("mode", "single", "One project")}${seg("mode", "batch", "Batch")}</span>
          <span class="note">Package</span><span class="row" style="gap:6px">${seg("tier", "full", "Full")}${seg("tier", "lite", "Lite")}</span>
        </div>
        <div class="note" style="margin-bottom:12px">${lite
          ? "Lite: same plan, same render. Zoning gets a short search and the package pricing comes from regional benchmarks instead of local research (about a third of the cost). Rents, costs and fees are estimates."
          : "Full: researched zoning and locally researched costs, rents and fees."}</div>
        <textarea class="listing" id="listing" placeholder="${batch ? "Paste all the listings here, one after another.&#10;A blank line or a heading between them is enough: Drafted works out where each one starts." : "2839 US 70 Hwy, Durham, NC 27703 · about 4 acres&#10;Retail strip with a sit-down restaurant, parking in front."}">${esc(state.listingText)}</textarea>
        ${state.error ? `<div class="err-box" style="margin-top:12px">${esc(state.error)}</div>` : ""}
        <div class="row" style="margin-top:14px">
          ${batch ? `<span class="note">Each listing becomes its own concept. Nothing waits for you.</span>`
                  : `<label class="note" style="display:flex;gap:8px;align-items:center;cursor:pointer"><input type="checkbox" id="unatt" ${state.unattended ? "checked" : ""}> Run unattended (skip the approval steps)</label>`}
          <span class="spacer"></span>
          <button class="btn primary" data-a="start" ${state.busy ? "disabled" : ""}>${state.busy ? "Starting…" : batch ? "Run batch" : "Generate concept"}</button>
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
      ${body}
      ${usageCard(j)}`;
  }

  // Cost log for this project: every billable call (Anthropic, Google geocoding + Nano Banana, Modal compute)
  function usageCard(j) {
    const U = Array.isArray(j.usage) ? j.usage : [];
    if (!U.length) return "";
    const g = new Map(), prov = new Map();
    for (const u of U) {
      const p = u.provider || "Anthropic", key = p + "|" + (u.call || "Call");
      const r = g.get(key) || { p, n: u.call || "Call", calls: 0, inp: 0, out: 0, s: 0, sec: 0, usd: 0 };
      r.calls++; r.inp += +u.input_tokens || 0; r.out += +u.output_tokens || 0; r.s += +u.searches || 0; r.sec += +u.seconds || 0; r.usd += +u.cost_usd || 0;
      g.set(key, r); prov.set(p, (prov.get(p) || 0) + (+u.cost_usd || 0));
    }
    const total = [...prov.values()].reduce((a, v) => a + v, 0);
    const usd = (v) => "$" + v.toFixed(v < 1 ? 3 : 2);
    const k = (v) => v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(v);
    const order = ["Anthropic", "Google", "Modal"];
    const rows = [...g.values()].sort((a, b) => (order.indexOf(a.p) - order.indexOf(b.p)));
    const detail = (r) => r.p === "Modal" ? `${Math.round(r.sec)} s compute` :
      (r.inp || r.out) ? `${k(r.inp)} in / ${k(r.out)} out${r.s ? ` · ${r.s} searches` : ""}` : "";
    return `
      <details class="card usage" style="margin-top:16px">
        <summary><b>Project cost</b> <span class="note">· ${usd(total)} · ${[...prov.entries()].map(([p, v]) => `${esc(p)} ${usd(v)}`).join(" · ")}</span></summary>
        <table class="utab"><thead><tr><th>Process</th><th>Provider</th><th>Calls</th><th>Usage</th><th>Cost</th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td>${esc(r.n)}</td><td>${esc(r.p)}</td><td>${r.calls}</td><td>${esc(detail(r))}</td><td>${usd(r.usd)}</td></tr>`).join("")}
        <tr class="t"><td>Total</td><td></td><td>${U.length}</td><td></td><td>${usd(total)}</td></tr>
        </tbody></table>
        <p class="note" style="margin-top:8px">List prices. Not included: Supabase and Regrid (flat plans).</p>
      </details>`;
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
          ${j.step === "layout" && j.zoning?.layout_mode === "manual" ? `<button class="btn" data-a="testfit">Back to the test fit</button>` : ""}
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
            <button class="btn primary" data-a="approveparcel" ${state.busy || !state.sel.size ? "disabled" : ""}>${state.busy ? "Starting…" : `Confirm parcel${state.sel.size > 1 ? "s" : ""}`}</button></div>
          ${state.error ? `<div class="err-box" style="margin-top:12px">${esc(state.error)}</div>` : ""}
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
          ${driveCard(j)}
          ${topoCard(j)}
          ${bldgCard(j)}
          ${paveCard(j)}
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
            <div class="row" style="margin-top:16px">
              <div style="width:220px"><div class="note" style="margin-bottom:6px">Minimum residual land value ($, excludes the land price)</div>
                <input class="fld num" inputmode="numeric" data-bind="minrlv" placeholder="blank = no minimum" value="${esc(e.minrlv)}"></div>
              <div class="note" style="flex:1;min-width:200px;align-self:flex-end">Value (net sale proceeds for condos and for-sale homes, NOI at the market cap rate for rentals) less all development costs, land excluded. The program is grown (floors first where height allows, then building size) until the layout meets it, up to what the site can hold. Open space and wide building gaps give way first if that is what it takes. Adds a market research pass to the layout. For the strongest residual land value use self-storage where the zoning permits it.</div>
            </div>
            <label class="note" style="display:block;margin-top:10px"><input type="checkbox" data-bind="denseok" ${e.denseok ? "checked" : ""} style="accent-color:var(--accent)"> Dense layout if needed: when the standard layout cannot reach the minimum, pack the buildings in rows with drive aisles (more building area, less pavement and open space)</label>
            <div class="row" style="margin-top:18px"><span class="spacer"></span>
              ${state.showZoningEditor ? `<button class="btn ghost" data-a="canceledit">Cancel</button>` : ""}
              <button class="btn" data-a="approvezoningmanual" ${state.busy ? "disabled" : ""} title="Skip the automatic layout and lay the site out yourself over the existing conditions, setbacks and constraints">Lay out manually (test fit)</button>
              <button class="btn primary" data-a="approvezoning" ${state.busy ? "disabled" : ""}>${state.busy ? `<span class="spin" style="width:14px;height:14px"></span> Starting layout…` : "Generate layout"}</button></div>
            ${state.error ? `<div class="err-box" style="margin-top:12px">${esc(state.error)}</div>` : ""}
          </div>
        </div>
      </div>`;
  }

  // Driveway road picker: the roads the parcel fronts, drawn on the aerial; the layout faces and connects to the pick
  function driveCard(j) {
    const R = j.summary?.front_roads || [];
    if (!R.length) return "";
    const e = state.edit, auto = R[0];
    const opt = (key, label, sub) => `<label class="droad ${e.drive === key ? "on" : ""}">
        <input type="radio" name="drive" value="${esc(key)}" ${e.drive === key ? "checked" : ""}>
        <span><b>${esc(label)}</b><span class="note">${esc(sub)}</span></span></label>`;
    return `
      <div class="card">
        <h3>Driveway</h3>
        ${R.length > 1 ? `<div id="rmap" class="rmap"></div>` : ""}
        <div class="droads">
          ${opt("", "Automatic", `longest frontage · ${auto.name}`)}
          ${R.map((r) => opt(r.key, r.name, `${r.class} · ${num(r.frontage_ft)} ft frontage`)).join("")}
        </div>
        <p class="note" style="margin:8px 0 0">${R.length > 1 ? "The layout faces this road and the driveway connects to its centerline. Click a road on the map or pick it here." : "Only one road touches the parcel, so the driveway connects to it."}</p>
      </div>`;
  }

  // Topography: USGS 3DEP slope on the parcel; ground steeper than the chosen limit is kept out of buildings and parking
  function topoCard(j) {
    const t = j.summary?.topo, e = state.edit;
    if (!t || t.available === false) {
      return `<div class="card"><h3>Topography</h3>
        <p class="note" style="margin:0">${t ? "Elevation data was unavailable for this site, so slope was not considered." : "Not checked yet for this concept."}</p>
        <button class="btn sm" data-a="findt" ${state.busy ? "disabled" : ""} style="margin-top:8px">${t ? "Check again" : "Read elevation data"}</button></div>`;
    }
    const col = ["#4caf50", "#c8d94a", "#ffb02e", "#ff5a3c", "#b0102a"];
    const bars = (t.classes || []).map((c, i) => `<div class="tb"><span style="width:${Math.max(c.pct, 0.8)}%;background:${col[i]}"></span><em>${esc(c.label)} · ${num(c.pct, 0)}%</em></div>`).join("");
    const opt = (v, l) => `<option value="${v}" ${e.slope === v ? "selected" : ""}>${l}</option>`;
    return `
      <div class="card">
        <h3>Topography</h3>
        <div class="kv">
          <div><span>Relief</span><b>${num(t.relief_ft, 0)} ft</b></div>
          <div><span>Average slope</span><b>${num(t.avg_slope_pct, 1)}%</b></div>
          <div><span>Steepest 10%</span><b>over ${num(t.p90_slope_pct, 0)}%</b></div>
          <div><span>Over ${esc(String(t.threshold_pct || e.slope))}%</span><b>${num(t.steep_pct, 0)}% of parcel</b></div>
        </div>
        <div class="tbars">${bars}</div>
        <div class="row" style="margin-top:12px;align-items:center"><div class="note" style="flex:1">Keep buildings and parking off ground steeper than</div>
          <select class="fld" data-bind="slope" style="width:130px">${opt("10", "10%")}${opt("15", "15% (default)")}${opt("20", "20%")}${opt("25", "25%")}${opt("0", "No limit")}</select></div>
        <p class="note" style="margin:8px 0 0">Slope shading and contours are on the existing-conditions sheet. Data: USGS 3DEP (about 10 m, planning grade, not a survey).</p>
      </div>`;
  }

  // Existing buildings on the parcel: keep (the layout builds around it) or demolish (the layout ignores it)
  function bldgCard(j) {
    const B = j.summary?.existing_buildings || [], e = state.edit;
    if (!B.length) {
      const ck = j.summary?.buildings_checked;
      const btn = `<button class="btn sm" data-a="findb" ${state.busy ? "disabled" : ""} style="margin-top:8px">${ck === undefined ? "Find existing buildings" : "Check again"}</button>`;
      return `<div class="card"><h3>Existing buildings</h3>
        <p class="note" style="margin:0">${ck === undefined ? "Not checked yet for this concept." : ck === false ? "Building data was unavailable for this site, so it was planned as vacant land." : "No existing buildings were found on this parcel."}</p>${ck === true ? "" : btn}</div>`;
    }
    const seg = (b, v, lab) => `<button class="seg ${(e.bact[b.id] || "keep") === v ? "on " + v : ""}" data-a="bact" data-id="${esc(b.id)}" data-v="${v}">${lab}</button>`;
    return `
      <div class="card">
        <h3>Existing buildings</h3>
        <div id="bmap" class="rmap"></div>
        <div class="bl">${B.map((b) => `<div class="brow"><span class="bid">${esc(b.id)}</span>
            <span class="bnm"><b>${esc(b.label)}</b><span class="note">${num(b.area_sf)} SF · ${esc(b.src)}${b.pct_on_site < 0.95 ? " · partly off the parcel" : ""}</span></span>
            <span class="segs">${seg(b, "keep", "Keep")}${seg(b, "demo", "Demolish")}</span></div>`).join("")}</div>
        <div class="row" style="margin-top:8px"><button class="btn sm" data-a="ball" data-v="demo">Demolish all</button><button class="btn sm" data-a="ball" data-v="keep">Keep all</button></div>
        <p class="note" style="margin:8px 0 0">Kept buildings stay on the plan and the layout builds around them with clearance. Demolished ones are marked on the plan and cleared from the render. Footprints come from OpenStreetMap and USA Structures, so check them against the aerial.</p>
      </div>`;
  }

  // Existing pavement (parking lots, drives): reuse it (new work builds off it) or remove it (paved from scratch)
  function paveCard(j) {
    const P = j.summary?.existing_pavement || [], e = state.edit;
    if (!P.length) return "";
    const seg = (p, v, lab) => `<button class="seg ${(e.pact[p.id] || "reuse") === v ? "on " + (v === "reuse" ? "keep" : "demo") : ""}" data-a="pact" data-id="${esc(p.id)}" data-v="${v}">${lab}</button>`;
    return `
      <div class="card">
        <h3>Existing pavement</h3>
        <div class="bl">${P.map((p) => `<div class="brow"><span class="bid">${esc(p.id)}</span>
            <span class="bnm"><b>${p.kind === "parking" ? "Parking area" : "Drive"}</b><span class="note">${num(p.area_sf)} SF${p.est_stalls ? " · about " + p.est_stalls + " stalls" : ""} · ${esc(p.src || "aerial")}</span></span>
            <span class="segs">${seg(p, "reuse", "Reuse")}${seg(p, "remove", "Remove")}</span></div>`).join("")}</div>
        <label class="note" style="display:block;margin-top:8px">Existing stalls the new buildings can count toward their parking
          <input type="number" min="0" step="1" data-k="sstalls" value="${esc(String(e.sstalls || 0))}" style="width:80px;margin-left:6px"></label>
        <label class="note" style="display:block;margin-top:8px"><input type="checkbox" data-k="tie" ${e.tie !== false ? "checked" : ""}> Tie the new development into the existing pavement (instead of a new drive from the public road)</label>
        <p class="note" style="margin:8px 0 0">Reused pavement stays on the plan; new buildings and parking are placed around it and the access road follows existing drives where it can. Removed pavement is marked for demolition and the site is paved from scratch there. Detected from OpenStreetMap and the aerial, so check against the photo.</p>
      </div>`;
  }

  function setPave(id, v) {
    state.edit.pact[id] = v;
    root.querySelectorAll(`.seg[data-a="pact"][data-id="${id}"]`).forEach((b) => { b.classList.remove("on", "keep", "demo"); if (b.dataset.v === v) b.classList.add("on", v === "reuse" ? "keep" : "demo"); });
  }

  function drawBldgMap(j) {
    const el = document.getElementById("bmap");
    const B = j.summary?.existing_buildings || [];
    if (!el || !window.L || el._leaflet_id || !B.length) return;
    const bm = L.map(el, { zoomControl: false, attributionControl: true, fadeAnimation: false, zoomAnimation: false });
    const pg = j.parcel?.geometry;
    let bounds = null;
    try { if (pg) bounds = L.geoJSON(pg).getBounds(); } catch (_) {}
    if (!bounds) bounds = L.latLngBounds(B.flatMap((b) => b.ring));
    bm.fitBounds(bounds.pad(0.2));
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 20, maxNativeZoom: 19, attribution: "Imagery © Esri" }).addTo(bm);
    if (pg) L.geoJSON(pg, { style: () => ({ color: "#ff2b2b", weight: 2.5, fillOpacity: 0 }) }).addTo(bm);
    const col = (id) => (state.edit.bact[id] === "demo" ? "#ff3b30" : "#2bff88");
    const lyr = {};
    B.forEach((b) => {
      const l = L.polygon(b.ring, { color: col(b.id), weight: 2.5, fillColor: col(b.id), fillOpacity: 0.35 }).addTo(bm);
      l.bindTooltip(`${b.id} · ${b.label} · ${num(b.area_sf)} SF`, { sticky: true });
      l.on("click", () => setBldg(b.id, state.edit.bact[b.id] === "demo" ? "keep" : "demo"));
      lyr[b.id] = l;
    });
    (j.summary?.existing_pavement || []).forEach((p) => {
      L.polygon(p.ring, { color: "#9aa4b2", weight: 1.5, dashArray: "5 4", fillColor: "#c8ced6", fillOpacity: 0.35 }).addTo(bm).bindTooltip(`${p.id} · ${p.kind === "parking" ? "parking" : "drive"} · ${num(p.area_sf)} SF`, { sticky: true });
    });
    window._bldgLayers = lyr;
    setTimeout(() => { bm.invalidateSize(); bm.fitBounds(bounds.pad(0.12)); }, 50);
  }

  function setBldg(id, v) {
    state.edit.bact[id] = v;
    const l = window._bldgLayers && window._bldgLayers[id];
    if (l) { const c = v === "demo" ? "#ff3b30" : "#2bff88"; l.setStyle({ color: c, fillColor: c }); }
    root.querySelectorAll(`.seg[data-id="${id}"]`).forEach((b) => { b.classList.remove("on", "keep", "demo"); if (b.dataset.v === v) b.classList.add("on", v); });
  }

  function drawRoadMap(j) {
    const el = document.getElementById("rmap");
    const R = j.summary?.front_roads || [];
    if (!el || !window.L || el._leaflet_id || R.length < 2) return;
    const rm = L.map(el, { zoomControl: false, attributionControl: true, fadeAnimation: false, zoomAnimation: false });
    const pg = j.parcel?.geometry;
    let bounds = null;
    try { if (pg) bounds = L.geoJSON(pg).getBounds(); } catch (_) {}
    if (!bounds) bounds = L.latLngBounds(R.flatMap((r) => r.lines.flat()));
    rm.fitBounds(bounds.pad(0.9));
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 20, maxNativeZoom: 19, attribution: "Imagery © Esri" }).addTo(rm);
    if (pg) L.geoJSON(pg, { style: () => ({ color: "#ff2b2b", weight: 2.5, fillColor: "#ff2b2b", fillOpacity: 0.12 }) }).addTo(rm);
    const chosen = () => state.edit.drive || R[0].key;
    const style = (k) => k === chosen() ? { color: "#2bff88", weight: 7, opacity: 0.95 } : { color: "#ffd400", weight: 4, opacity: 0.85, dashArray: "8 6" };
    const lyrs = R.map((r) => {
      const l = L.polyline(r.lines, style(r.key)).addTo(rm);
      l.bindTooltip(`${esc(r.name)} · ${num(r.frontage_ft)} ft frontage`, { sticky: true });
      l.on("click", () => pick(r.key));
      return [r.key, l];
    });
    function pick(key) {
      state.edit.drive = key;
      lyrs.forEach(([k, l]) => { l.setStyle(style(k)); if (k === chosen()) l.bringToFront(); });
      root.querySelectorAll(".droad").forEach((lab) => {
        const inp = lab.querySelector("input"); inp.checked = inp.value === key; lab.classList.toggle("on", inp.checked); });
    }
    root.querySelectorAll('.droad input').forEach((inp) => inp.addEventListener("change", () => pick(inp.value)));
    lyrs.forEach(([k, l]) => { if (k === chosen()) l.bringToFront(); });
    setTimeout(() => { rm.invalidateSize(); rm.fitBounds(bounds.pad(0.45)); }, 50);   // card is laid out by now
  }

  function testfitButton(j, primary) {
    const st = j.summary?.testfit_status;
    if (st === "building") return `<span class="note" style="display:inline-flex;gap:8px;align-items:center"><span class="spin" style="width:14px;height:14px"></span> Preparing the test fit…</span>`;
    const label = j.layout?.manual ? "Edit test fit" : primary ? "Open the test-fit editor" : "Edit in test fit";
    return `<button class="btn ${primary ? "primary" : ""}" data-a="testfit" ${state.busy ? "disabled" : ""} title="Lay out or adjust the site by hand">${label}</button>
      ${st === "failed" ? `<div class="err-box" style="margin-top:10px">Preparing the test fit failed: ${esc(j.summary?.testfit_error || "unknown error")}</div>` : ""}`;
  }

  async function openTestFit() {
    const j = state.job;
    if (!j || !window.TestFit) return;
    const url = j.files?.testfit?.["base.json"];
    if (!url || state.tfPrepared === j.id + ":retry") {
      // jobs laid out before the editor existed: the worker prepares the site data first (about a minute)
      state.tfPrepared = j.id;
      await act({ action: "testfit_base", job_id: j.id });
      state.tfWaitOpen = j.id;
      return;
    }
    state.busy = true; renderMain();
    let base;
    try { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); base = await r.json(); }
    catch (e) { state.busy = false; state.error = "Could not load the test-fit site data: " + e.message; renderMain(); return; }
    state.busy = false; renderMain();
    const L = j.listing || {};
    window.TestFit.open({
      base, jobId: j.id, aerialUrl: j.files?.ec?.["aerial.jpg"], design: j.summary?.testfit_design,
      title: [L.street_address, L.city, L.state].filter(Boolean).join(", "),
      onSave: async (design) => { await api({ action: "testfit_save", job_id: j.id, design }); state.job.summary = { ...(state.job.summary || {}), testfit_design: { ...design, saved_at: new Date().toISOString() } }; },
      onSubmit: async (design) => {
        await api({ action: "testfit_submit", job_id: j.id, design });
        state.job.status = "building_layout"; state.job.progress = "Drawing your test fit"; renderMain(); await refreshJob(true); loadJobs();
      },
      onClose: () => renderMain(),
    });
  }

  function viewLayout(j) {
    const m = j.layout || {}, f = j.files || {};
    if (m.manual_pending) return `
      <div class="card" style="padding:22px">
        <div class="eyebrow">Manual layout</div>
        <h3 style="margin:6px 0 6px">Lay out the site in the test fit</h3>
        <p class="note" style="margin:0 0 14px">The existing conditions, setbacks, wetlands, flood zones, steep ground and roads are ready. Place buildings, parking fields, drives and ponds; parking, coverage, FAR and impervious update as you go. Send it to the concept plan when it works, and the job continues as usual (render, package, plan set).</p>
        ${testfitButton(j, true)}
        ${state.error ? `<div class="err-box" style="margin-top:12px">${esc(state.error)}</div>` : ""}
      </div>
      ${f.ec?.["existing_conditions.png"] ? `<div class="card" style="padding:12px;margin-top:16px"><img class="plan" src="${f.ec["existing_conditions.png"]}" data-a="zoom" data-src="${f.ec["existing_conditions.png"]}" alt="Existing conditions"></div>` : ""}`;
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
      nanobanana: "Nano Banana is rendering the photoreal view", compositing: "Keeping the photoreal pass to your lot", failed: "Render failed", completed: "Render ready" }[j.render_status] || "";
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
    const pkg = f.package?.["package.pdf"];
    const PS = { queued: "Queued", researching: "Researching costs, rents, fees and permits", writing: "Running the proforma and writing the package",
      typesetting: "Typesetting the PDF" }[j.package_status] || "";
    const pkgName = (j.summary?.package_name) || fileName(j, "Package", "pdf");
    if (pkg) dls.unshift(["Due diligence package (PDF)", pkg, pkgName]);
    const pkgCard = !(approved && j.render_status === "completed") ? "" : `
      <div class="card" style="padding:14px 16px;margin-bottom:16px">
        <div class="row"><div><h3 style="margin:0">Due diligence package</h3>
          <div class="note">Plan sheet (Exhibit A) + photoreal render (Exhibit B1), zoning, permitting roadmap, proforma, returns and residual land value.</div></div>
          <span class="spacer"></span>
          ${PS ? "" : pkg ? `<a class="btn primary sm" href="${pkg}" download="${esc(pkgName)}" target="_blank" rel="noopener">Download PDF</a>
            <button class="btn sm" data-a="package" ${state.busy ? "disabled" : ""}>Rebuild</button>` :
            `<button class="btn primary" data-a="package" ${state.busy ? "disabled" : ""}>${state.busy ? "Starting…" : "Build due diligence package"}</button>`}</div>
        ${PS ? `<div class="working" style="padding:12px 0 0"><div class="spin"></div><div><div class="w1">${esc(PS)}</div>
          <div class="w2">Web research, proforma and typesetting · about 4–8 minutes</div></div></div>` : ""}
        ${j.package_status === "failed" ? `<div class="err-box" style="margin-top:10px">Package failed: ${esc(j.package_error || "unknown error")}</div>` : ""}
      </div>`;
    const pv = j.summary?.preview || {};
    const PVP = ["queued", "building"].includes(pv.status);
    const pvReady = j.package_status === "completed" || j.options?.lite;
    const pvCard = !(approved && j.render_status === "completed" && pvReady) ? "" : `
      <div class="card" style="padding:14px 16px;margin-bottom:16px">
        <div class="row"><div><h3 style="margin:0">Preview site</h3>
          <div class="note">The same watermarked preview page the lite pipeline publishes (render, plan, investor numbers from this package, booking button), at its own link.</div></div>
          <span class="spacer"></span>
          ${PVP ? "" : pv.status === "built" ? `<a class="btn primary sm" href="${esc(pv.url)}" target="_blank" rel="noopener">Open preview site</a>
            <button class="btn sm" data-a="preview" ${state.busy ? "disabled" : ""}>Rebuild</button>` :
            `<span style="display:flex;gap:6px;align-items:center;margin-right:10px;font-size:13px"><label style="display:flex;gap:6px;align-items:center;cursor:pointer" title="Uses the agent email and name from the listing text (searches the web if missing) and adds them to the Instantly Free Preview campaign + the CRM, same as the lite pipeline. Unticked: only the page is built."><input type="checkbox" id="pvPush" checked> Add agent to Instantly + CRM</label></span>
            <button class="btn primary" data-a="preview" ${state.busy ? "disabled" : ""}>${state.busy ? "Starting…" : "Make preview site"}</button>`}</div>
        ${PVP ? `<div class="working" style="padding:12px 0 0"><div class="spin"></div><div><div class="w1">Building the preview page</div><div class="w2">About 1–2 minutes</div></div></div>` : ""}
        ${pv.status === "built" && !PVP ? `<div class="note" style="margin-top:10px"><a href="${esc(pv.url)}" target="_blank" rel="noopener">${esc(pv.display || pv.url)}</a>${pv.outreach?.instantly ? ` · Instantly: ${esc(pv.outreach.instantly)}` : ""}${pv.outreach?.crm ? ` · CRM: ${esc(pv.outreach.crm)}` : ""}</div>` : ""}
        ${pv.status === "error" ? `<div class="err-box" style="margin-top:10px">Preview failed: ${esc(pv.reason || "unknown error")}</div>` : ""}
      </div>`;
    const dsg = f.design?.["plan_set.pdf"];
    const DSP = ["queued", "designing"].includes(j.design_status);
    const ds = j.design || {};
    const designCard = !approved ? "" : `
      <div class="card" style="padding:14px 16px;margin-bottom:16px">
        <div class="row"><div><h3 style="margin:0">Full design: preliminary plan set</h3>
          <div class="note">Title sheet, existing conditions, site, erosion control and demolition, grading, drainage, utilities, landscape and lighting (no detail sheets). Not sealed. Municipal sewer and water (if checked) run from the road selected as the main road, inside the property; an unchecked service gets a private septic system or well.</div></div>
          <span class="spacer"></span>
          ${DSP ? "" : (() => { const z = j.zoning || {}; const leg = z.design_utilities; const sw = "design_sewer" in z ? !!z.design_sewer : leg !== "onsite"; const wt = "design_water" in z ? !!z.design_water : leg !== "onsite";
            return `<span style="display:flex;gap:14px;align-items:center;margin-right:10px;font-size:13px" title="Utilities for the plan set. Unchecked means a private septic system (sewer) or a private well (water)."><label style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" id="dsgSewer"${sw ? " checked" : ""}> Municipal sewer</label><label style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" id="dsgWater"${wt ? " checked" : ""}> Municipal water</label></span>`; })()}
          ${DSP ? "" : dsg ? `<a class="btn primary sm" href="${dsg}" download="${esc(fileName(j, "Plan Set", "pdf"))}" target="_blank" rel="noopener">Download plan set (PDF)</a>
            <button class="btn sm" data-a="design" ${state.busy ? "disabled" : ""}>Rebuild</button>` :
            `<button class="btn primary" data-a="design" ${state.busy ? "disabled" : ""}>${state.busy ? "Starting…" : "Build full plan set"}</button>`}</div>
        ${DSP ? `<div class="working" style="padding:12px 0 0"><div class="spin"></div><div><div class="w1">${esc(j.progress || "Designing grading, drainage and utilities")}</div>
          <div class="w2">Grading, storm, utilities and sheets · about 2–4 minutes</div></div></div>` : ""}
        ${ds.exports_only && !DSP && j.design_status === "completed" ? `<div class="note" style="margin-top:10px">From an Apollo Redline sketch: CAD exports only (no plan sheets). “Build full plan set” draws the sheets too.</div>` : ""}
        ${(dsg || (ds.exports_only && j.design_status === "completed")) && !DSP ? `<div class="kv" style="margin-top:10px"><div><span>Pond</span><b>${num(ds.pond_cf)} CF</b></div><div><span>Cut / fill</span><b>${num(ds.cut_cy)} / ${num(ds.fill_cy)} CY</b></div><div><span>Disturbed</span><b>${num(ds.disturbed_ac, 2)} ac</b></div></div>
          ${(ds.warnings || []).length ? `<div class="note" style="margin-top:8px">${(ds.warnings || []).map(esc).join("<br>")}</div>` : ""}
          <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:6px">${Object.keys(f.design || {}).map(k => (k.match(/^sheet_(.+)\.png$/) || [])[1]).filter(Boolean).sort((a, b) => { const o = ["T1","C1","C2","C3","C4","C5","C5A","C6","C7","C8","C9"]; const ka = a.split(".")[0], kb = b.split(".")[0]; return (o.indexOf(ka) - o.indexOf(kb)) || a.localeCompare(b, undefined, { numeric: true }); }).map(n => `<a class="btn sm" href="${f.design[`sheet_${n}.png`]}" target="_blank" rel="noopener">${n}</a>`).join("")}</div>
          ${f.design?.["design.dxf"] || f.design?.["surfaces_pipes.xml"] ? `<div class="row" style="margin-top:8px;flex-wrap:wrap;gap:6px">
            ${f.design?.["design.dxf"] ? `<a class="btn sm" href="${f.design["design.dxf"]}" download="${esc(fileName(j, "Design", "dxf"))}" target="_blank" rel="noopener">Design DXF</a>` : ""}
            ${f.design?.["surfaces_pipes.xml"] ? `<a class="btn sm" href="${f.design["surfaces_pipes.xml"]}" download="${esc(fileName(j, "Surfaces and Pipes LandXML", "xml"))}" target="_blank" rel="noopener">LandXML (surfaces + pipes)</a>` : ""}</div>` : ""}
          <div class="row" style="margin-top:8px;flex-wrap:wrap;gap:6px;align-items:center">
            ${f.design?.["drafted_c3d.zip"] && ds.c3d_status !== "building" ? `<a class="btn sm primary" href="${f.design["drafted_c3d.zip"]}" download="${esc(fileName(j, "Civil 3D", "zip"))}" target="_blank" rel="noopener" title="Run DRAFTEDIMPORT in Civil 3D 2027 and pick this zip">Civil 3D package (.zip)</a>` : ""}
            ${ds.c3d_status === "building" ? `<span class="note">Rebuilding the Civil 3D package…</span>` : f.design?.["design_x.pkl"] ? `<button class="btn sm ghost" data-a="c3dexport" ${state.busy ? "disabled" : ""} title="Rebuild only the CAD files with your current Civil 3D template">Rebuild Civil 3D package</button>` : ""}
            <span class="note">${ds.c3d_template ? "Layers: " + esc(ds.c3d_template) : `Drafted layers · <a href="#" data-a="cad">set your Civil 3D template</a>`}</span>
            ${ds.c3d_status === "failed" ? `<span class="note" style="color:#c33">CAD package failed${ds.c3d_error ? ": " + esc(ds.c3d_error) : ""}</span>` : ""}</div>` : ""}
        ${j.design_status === "failed" ? `<div class="err-box" style="margin-top:10px">Plan set failed: ${esc(j.design_error || "unknown error")}</div>` : ""}
      </div>`;
    return `${pkgCard}${pvCard}${designCard}${renderCard}
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
            ${m.rlv ? `<div><span>Residual land value</span><b style="color:${m.rlv.ok ? "inherit" : "#e8a317"}">$${num(m.rlv.residual)} ${m.rlv.ok ? "≥" : "<"} $${num(m.rlv.min)} needed</b></div>` : ""}
            ${m.rlv && m.rlv.sized ? `<div><span>Sized to minimum</span><b>${num(m.rlv.base_gfa_sf)} → ${num(m.rlv.gfa_sf)} SF</b></div>` : ""}
            ${m.rlv && m.rlv.open_space_reduced ? `<div><span>Open space</span><b>reduced for value</b></div>` : ""}
          </div>
          ${(m.buildings || []).length ? `<div class="notes" style="margin-top:14px">${m.buildings.map((b) => `${esc((b.use || b.name || "").toString())} — ${num(b.w_ft)}' × ${num(b.d_ft)}' · ${num(b.footprint_sf)} SF${b.drive_thru ? " · drive-thru" : ""}`).join("\n")}</div>` : ""}
          ${(m.existing || []).filter((x) => x.action !== "demo").length ? `<div class="notes" style="margin-top:10px">${m.existing.filter((x) => x.action !== "demo").map((x) => x.kind === "pavement" ? `Existing pavement ${esc(x.id)} (${esc(x.label || "pavement")}, ${num(x.sf)} SF) — ${x.action === "demo" ? "removed" : "reused"}` : `Existing ${esc(x.id)} (${esc(x.label || "building")}, ${num(x.sf)} SF) — ${x.action === "demo" ? "demolished" : "remains"}`).join("\n")}</div>` : ""}
          ${m.earthwork ? `<div class="notes" style="margin-top:10px">Grading (rough): ${num(m.earthwork.cut_cy)} CY cut / ${num(m.earthwork.fill_cy)} CY fill · pad about ${num(m.earthwork.pad_ft, 0)} ft · ${num(m.earthwork.avg_slope_pct, 1)}% average slope</div>` : ""}
          ${(m.warnings || []).length ? `<div class="warnings">${m.warnings.map((w) => `<div>⚠ ${esc(w)}</div>`).join("")}</div>` : ""}
        </div>
        <div class="card">
          <h3>Downloads</h3>
          <div class="dl">${dls.map(([lab, url, name]) => `<a class="btn sm" href="${dlUrl(url, name)}" target="_blank" rel="noopener">${esc(lab)}</a>`).join("")}</div>
          <p class="note" style="margin-top:12px">Sheets are ANSI D (34×22). DXFs are in state-plane feet with Forma layers.</p>
          <div class="row" style="margin-top:18px">
            <button class="btn" data-a="editzoning">Adjust zoning / program</button>
            ${testfitButton(j, false)}
            <span class="spacer"></span>
            ${approved ? `<span class="tag g">Approved</span>` : `<button class="btn primary" data-a="approvelayout" ${state.busy ? "disabled" : ""}>${state.busy ? "Starting render…" : "Approve layout &amp; render"}</button>`}
          </div>
        </div>
      </div>`;
  }

  // ------------------------------------------------------------- bindings
  function bindNew(main) {
    const ta = main.querySelector("#listing");
    ta.addEventListener("input", () => { state.listingText = ta.value; });
    const u = main.querySelector("#unatt");
    if (u) u.addEventListener("change", () => { state.unattended = u.checked; });
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
    drawBldgMap(j);
    main.querySelectorAll("[data-a=pact]").forEach((b) => b.addEventListener("click", () => setPave(b.dataset.id, b.dataset.v)));
    main.querySelectorAll("[data-k=tie]").forEach((i) => i.addEventListener("change", () => { state.edit.tie = i.checked; }));
    main.querySelectorAll("[data-k=sstalls]").forEach((i) => i.addEventListener("input", () => { state.edit.sstalls = i.value; }));
    main.querySelectorAll("[data-a=bact]").forEach((b) => b.addEventListener("click", () => setBldg(b.dataset.id, b.dataset.v)));
    main.querySelectorAll("[data-a=ball]").forEach((b) => b.addEventListener("click", () => (j.summary?.existing_buildings || []).forEach((x) => setBldg(x.id, b.dataset.v))));
    if (main.querySelector(".droads")) {
      drawRoadMap(j);
      // single-road (no map) case: radios still update the choice
      main.querySelectorAll(".droad input").forEach((inp) => inp.addEventListener("change", () => {
        state.edit.drive = inp.value;
        main.querySelectorAll(".droad").forEach((lab) => lab.classList.toggle("on", lab.querySelector("input").checked)); }));
    }
  }

  function drawMap(j) {
    const el = document.getElementById("map");
    if (!el || !window.L) return;
    if (el._leaflet_id) return;
    map = L.map(el, { zoomControl: true, attributionControl: true, fadeAnimation: false, zoomAnimation: false });
    // set the view BEFORE adding any vector layer: Leaflet's SVG renderer needs map bounds when a path is added
    const cands = j.candidates || [];
    const selIdx = [...state.sel].filter((i) => cands[i]);
    const fitTo = L.geoJSON({ type: "FeatureCollection", features: (selIdx.length ? selIdx.map((i) => cands[i]) : cands)
      .map((c) => ({ type: "Feature", properties: {}, geometry: c.geometry })) });
    try { map.fitBounds(fitTo.getBounds().pad(0.6)); }
    catch (_) { map.setView([j.geocode?.lat || 37, j.geocode?.lon || -78], 17); }
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 20, maxNativeZoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" }).addTo(map);
    mapLayers = [];
    // unselected first so the selected (red) parcels draw on top
    const order = cands.map((_, i) => i).sort((a, b) => (state.sel.has(a) ? 1 : 0) - (state.sel.has(b) ? 1 : 0));
    order.forEach((i) => {
      const c = cands[i];
      try {
        const lyr = L.geoJSON(c.geometry, { style: () => styleFor(i) });
        lyr.on("click", () => togglePick(i));
        lyr.bindTooltip(`${num(c.acres, 2)} ac${c.address ? " · " + esc(c.address) : ""}`, { sticky: true });
        lyr.on("mouseover", () => lyr.setStyle({ weight: 4 }));
        lyr.on("mouseout", () => lyr.setStyle(styleFor(i)));
        lyr.addTo(map);
        mapLayers[i] = lyr;
      } catch (e) { console.error("parcel layer", i, e); }
    });
    if (j.geocode?.lat) L.circleMarker([j.geocode.lat, j.geocode.lon], { radius: 6, color: "#fff", weight: 2, fillColor: "#2f7bff", fillOpacity: 1 })
      .bindTooltip(`Address location: ${esc(j.geocode.label || "")}`).addTo(map);
  }
  function styleFor(i) {
    // selected parcels red, the other candidates yellow, so you can see where every option sits on the aerial
    const on = state.sel.has(i);
    return on ? { color: "#ff2b2b", weight: 3, fillColor: "#ff2b2b", fillOpacity: 0.22 }
              : { color: "#ffd400", weight: 2, fillColor: "#ffd400", fillOpacity: 0.10, dashArray: "6 4" };
  }
  function togglePick(i) {
    state.sel.has(i) ? state.sel.delete(i) : state.sel.add(i);
    mapLayers.forEach((l, k) => { if (!l) return; l.setStyle(styleFor(k)); if (state.sel.has(k)) l.bringToFront(); });
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
      case "cad": state.view = "cad"; state.jobId = null; state.job = null; state.batchId = null; state.error = ""; state.cadMsg = ""; state.cad = null; clearTimeout(pollTimer); history.replaceState(null, "", "#"); renderSide(); renderMain(); break;
      case "cadsave": saveCad(false); break;
      case "cadauto": saveCad(true); break;
      case "caddelete": if (confirm("Remove the Civil 3D template? Exports go back to Drafted's layer names.")) { state.busy = true; renderMain(); try { await api({ action: "cad_template_delete" }); state.cadMsg = "Template removed."; } catch (e) { state.cadMsg = e.message; } state.busy = false; await loadCadTemplate(); } break;
      case "plugin": downloadPlugin(); break;
      case "c3dexport": act({ action: "c3d_export", job_id: state.jobId }); break;
      case "new": state.view = "new"; state.batchId = null; state.jobId = null; state.job = null; state.error = ""; history.replaceState(null, "", "#"); clearTimeout(pollTimer); render(); break;
      case "open": openJob(t.dataset.id); renderSide(); break;
      case "openbatch": openBatch(t.dataset.id); break;
      case "set": state[t.dataset.k] = t.dataset.v; renderMain(); break;
      case "start": startJob(); break;
      case "approveparcel": approveParcel(); break;
      case "approvezoning": approveZoning(); break;
      case "approvezoningmanual": approveZoning(true); break;
      case "testfit": openTestFit(); break;
      case "approvelayout": act({ action: "approve_layout", job_id: state.jobId }); break;
      case "rerender": act({ action: "render", job_id: state.jobId }); break;
      case "findt": act({ action: "rerun", job_id: state.jobId, step: "topo" }); break;
      case "findb": act({ action: "rerun", job_id: state.jobId, step: "buildings" }); break;
      case "package": act({ action: "package", job_id: state.jobId }); break;
      case "preview": act({ action: "preview", job_id: state.jobId, push: document.getElementById("pvPush") ? document.getElementById("pvPush").checked : true }); break;
      case "design": act({ action: "design", job_id: state.jobId, sewer: document.getElementById("dsgSewer") ? document.getElementById("dsgSewer").checked : true, water: document.getElementById("dsgWater") ? document.getElementById("dsgWater").checked : true }); break;
      case "retry": act({ action: "rerun", job_id: state.jobId, step: state.job.step || "parse" }); break;
      case "repick": state.error = ""; state.job.status = "awaiting_parcel"; renderMain(); break;
      case "editzoning": state.showZoningEditor = true; state.edit = null; if (state.job.status === "error") state.job.status = "awaiting_zoning"; renderMain(); break;
      case "canceledit": state.showZoningEditor = false; renderMain(); break;
      case "delete": deleteJob(); break;
      case "deletebatch": deleteBatch(); break;
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
    listTimer = setInterval(() => { if (state.session && (state.jobs.some((j) => WORKING.has(j.status)) || state.jobs.some((j) => j.options?.batch_parent))) loadJobs(); }, 15000);
  }
  function routeFromHash() {
    const m = location.hash.match(/job=([0-9a-f-]{36})/);
    if (m) { openJob(m[1]); return; }
    const b = location.hash.match(/batch=([0-9a-f-]{36})/);
    if (b) openBatch(b[1]);
  }
  boot();
})();
