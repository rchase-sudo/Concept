// Drafted test fit: lay out a site by hand over the confirmed existing conditions (parcel, setbacks, wetlands, flood,
// steep ground, existing buildings, roads, aerial), with parking that fills itself in, then send it down the pipeline.
//
// Coordinates are the layout frame the worker uses: feet, x along the main frontage, y into the site (base.json from the
// worker). The SVG draws y downward, so every y is negated when drawn.
//
// window.TestFit.open({ base, aerialUrl, design, title, onSave(design), onSubmit(design), onClose() })
(function () {
  "use strict";
  const SW = 9, SD = 18, AIS = 24, WALK = 6, ISL = 10;
  const ADA = [[25, 1], [50, 2], [75, 3], [100, 4], [150, 5], [200, 6], [300, 7], [400, 8], [500, 9]];
  const adaReq = (n) => { for (const [lim, r] of ADA) if (n <= lim) return r; return n <= 1000 ? Math.ceil(n * 0.02) : 20 + Math.ceil((n - 1000) / 100); };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v, d = 0) => (v == null || isNaN(v)) ? "–" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
  const rad = (d) => d * Math.PI / 180;
  const R2 = (x) => Math.round(x * 10) / 10;

  // ---------------------------------------------------------------- geometry
  const rot = (x, y, a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
  function corners(o) {            // rectangle object {cx, cy, w, d, rot}
    const a = rad(o.rot || 0), hw = o.w / 2, hd = o.d / 2;
    return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, y]) => { const [u, v] = rot(x, y, a); return [o.cx + u, o.cy + v]; });
  }
  const toLocal = (o, p) => rot(p[0] - o.cx, p[1] - o.cy, -rad(o.rot || 0));
  const toWorld = (o, u, v) => { const [x, y] = rot(u, v, rad(o.rot || 0)); return [o.cx + x, o.cy + y]; };
  function inRing(p, r) {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) c = !c;
    }
    return c;
  }
  const inPoly = (p, rings) => inRing(p, rings[0]) && !rings.slice(1).some((h) => inRing(p, h));
  const inAny = (p, polys) => polys.some((rs) => inPoly(p, rs));
  function segX(a, b, c, d) {
    const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
    return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
  }
  function polyEdgesCross(pts, polys) {     // any edge of the convex shape pts crosses a boundary of polys
    for (const rs of polys) for (const r of rs) for (let i = 0; i < r.length - 1; i++)
      for (let k = 0; k < pts.length; k++) if (segX(pts[k], pts[(k + 1) % pts.length], r[i], r[i + 1])) return true;
    return false;
  }
  const insideAll = (pts, polys) => pts.every((p) => inAny(p, polys)) && !polyEdgesCross(pts, polys);
  function satOverlap(A, B) {               // convex polygons
    for (const P of [A, B]) for (let i = 0; i < P.length; i++) {
      const [x1, y1] = P[i], [x2, y2] = P[(i + 1) % P.length];
      const nx = y1 - y2, ny = x2 - x1;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [x, y] of A) { const t = x * nx + y * ny; a0 = Math.min(a0, t); a1 = Math.max(a1, t); }
      for (const [x, y] of B) { const t = x * nx + y * ny; b0 = Math.min(b0, t); b1 = Math.max(b1, t); }
      if (a1 <= b0 + 1e-6 || b1 <= a0 + 1e-6) return false;
    }
    return true;
  }
  const area = (pts) => { let s = 0; for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; s += x1 * y2 - x2 * y1; } return Math.abs(s) / 2; };
  const plen = (pts) => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return s; };
  const grow = (o, g) => ({ ...o, w: o.w + 2 * g, d: o.d + 2 * g });
  function distSeg(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }

  // parking field: double-loaded 60 ft bays (18 + 24 + 18) across the field, a single-loaded bay in what is left,
  // 9 ft stalls along each aisle with a landscape island every 10 stalls; stalls are dropped where they leave the
  // pavement setback line or touch a building (plus its walk)
  function fieldLayout(f, pz, blockers) {
    const flip = !!f.flip;
    const W = flip ? f.d : f.w, D = flip ? f.w : f.d;
    const F = (u, v) => (flip ? toWorld(f, v, u) : toWorld(f, u, v));
    const rect = (u0, v0, u1, v1) => [F(u0, v0), F(u1, v0), F(u1, v1), F(u0, v1)];
    const rows = [];
    let v = -D / 2;
    while (v + 2 * SD + AIS <= D / 2 + 0.01) { rows.push(["s", v, v + SD, "up"], ["a", v + SD, v + SD + AIS], ["s", v + SD + AIS, v + 2 * SD + AIS, "dn"]); v += 2 * SD + AIS; }
    if (v + SD + AIS <= D / 2 + 0.01) { rows.push(["s", v, v + SD, "up"], ["a", v + SD, v + SD + AIS]); v += SD + AIS; }
    const stalls = [], aisles = [], dropped = [];
    const every = f.islands === 0 ? 1e9 : (f.islands || ISL);
    const span = rows.map(() => [Infinity, -Infinity]);          // along-aisle extent of the stalls kept in each row
    rows.forEach(([k, v0, v1], ri) => {
      if (k === "a") return;
      let u = -W / 2, n = 0;
      while (u + SW <= W / 2 + 0.01) {
        if (n > 0 && n % (every + 1) === every) { u += SW; n++; continue; }
        const s = rect(u, v0, u + SW, v1);
        if (insideAll(s, pz) && !blockers.some((b) => satOverlap(s, b))) { stalls.push(s); span[ri][0] = Math.min(span[ri][0], u); span[ri][1] = Math.max(span[ri][1], u + SW); }
        else dropped.push(s);
        u += SW; n++;
      }
    });
    // each aisle runs only as far as the stalls it serves (rows either side), never out over dropped stalls
    rows.forEach(([k, v0, v1], ri) => {
      if (k !== "a") return;
      const a0 = Math.min(span[ri - 1]?.[0] ?? Infinity, span[ri + 1]?.[0] ?? Infinity), a1 = Math.max(span[ri - 1]?.[1] ?? -Infinity, span[ri + 1]?.[1] ?? -Infinity);
      if (a1 > a0) aisles.push(rect(a0, v0, a1, v1));
    });
    return { stalls, aisles, dropped, unused: D / 2 - v };
  }

  // ---------------------------------------------------------------- editor
  function open(opts) {
    const base = opts.base;
    const parcelSF = base.parcel_sf || 1;
    const pz = base.pz || [], bz = base.bz || [];
    const constraints = [...(base.wet || []), ...(base.flood || []), ...(base.steep || []), ...(base.keep_bldgs || []).flatMap((b) => b.rings)];
    const prog = base.program || {};
    let uid = 1;
    const nid = (p) => p + (uid++);
    const S = {
      objs: [], sel: null, tool: "select", ratio: base.parking_ratio ?? 4, autoPond: true, layers: { aerial: true, setbacks: true, constraints: true },
      hist: [], fut: [], dirty: false, drawPts: null, mouse: null, view: null, busy: false, msg: "",
    };

    // ---- load: a saved design (moved into this base's frame if the frame changed), else the automatic layout's buildings
    function fromFrame(fr0, pts) {
      const f1 = base.frame;
      if (!fr0 || (Math.abs(fr0.a - f1.a) < 1e-9 && Math.abs(fr0.o[0] - f1.o[0]) < 1e-6 && Math.abs(fr0.o[1] - f1.o[1]) < 1e-6)) return pts;
      return pts.map(([x, y]) => {
        const [u, v] = rot(x / fr0.k, y / fr0.k, fr0.a);
        const sx = fr0.o[0] + u - f1.o[0], sy = fr0.o[1] + v - f1.o[1];
        const [a, b] = rot(sx, sy, -f1.a);
        return [a * f1.k, b * f1.k];
      });
    }
    function load(design, seed) {
      S.objs = [];
      if (design) {
        const fr0 = design.frame, da = fr0 ? (fr0.a - base.frame.a) * 180 / Math.PI : 0;
        const mvRect = (o) => { const [[cx, cy]] = fromFrame(fr0, [[o.cx, o.cy]]); return { ...o, cx, cy, rot: (o.rot || 0) + da }; };
        for (const b of design.buildings || []) S.objs.push({ t: "b", ...mvRect(b), id: nid("b") });
        for (const f of design.parking || []) if (f.params) S.objs.push({ t: "p", ...mvRect(f.params), id: nid("p") });
        for (const d of design.drives || []) S.objs.push({ t: "d", id: nid("d"), width: d.width || 24, pts: fromFrame(fr0, d.pts) });
        for (const o of design.ponds || []) S.objs.push({ t: "o", id: nid("o"), pts: fromFrame(fr0, o.pts) });
        for (const o of design.pavement || []) S.objs.push({ t: "v", id: nid("v"), pts: fromFrame(fr0, o.pts) });
        if (design.parking_ratio != null) S.ratio = design.parking_ratio;
        if (design.auto_pond != null) S.autoPond = design.auto_pond;
      } else if (seed) {
        for (const b of seed.buildings || []) S.objs.push({ t: "b", ...b, id: nid("b") });
      }
    }
    load(opts.design, base.seed);

    // ---- DOM
    const root = document.createElement("div");
    root.className = "tf-root";
    root.innerHTML = `
      <div class="tf-top">
        <div class="tf-title"><b>Test fit</b><span>${esc(opts.title || "")}</span></div>
        <div class="tf-tools" id="tfTools"></div>
        <span class="tf-sp"></span>
        <button class="btn sm" data-tf="undo" title="Undo (Ctrl+Z)">Undo</button>
        <button class="btn sm" data-tf="redo" title="Redo (Ctrl+Shift+Z)">Redo</button>
        <button class="btn sm" data-tf="save">Save draft</button>
        <button class="btn sm primary" data-tf="submit">Send to concept plan</button>
        <button class="btn sm" data-tf="close" title="Close (keeps the draft in this browser)">Close</button>
      </div>
      <div class="tf-body">
        <div class="tf-canvas" id="tfCanvas"><svg id="tfSvg" xmlns="http://www.w3.org/2000/svg"></svg>
          <div class="tf-hint" id="tfHint"></div><div class="tf-scale" id="tfScale"></div>
          <div class="tf-north" style="transform:rotate(${base.frame.a}rad)" title="North"><svg viewBox="-12 -16 24 32" width="22" height="30"><path d="M0,-14 L8,10 L0,5 L-8,10 Z" fill="currentColor"/></svg><b>N</b></div></div>
        <aside class="tf-panel" id="tfPanel"></aside>
      </div>`;
    document.body.appendChild(root);
    document.body.style.overflow = "hidden";
    const svg = root.querySelector("#tfSvg"), panel = root.querySelector("#tfPanel"), canvas = root.querySelector("#tfCanvas");

    const TOOLS = [["select", "Select", "V"], ["b", "Building", "B"], ["p", "Parking", "P"], ["d", "Drive", "D"], ["o", "Pond", "O"], ["v", "Pavement", "A"], ["pan", "Pan", "H"]];
    function drawTools() {
      root.querySelector("#tfTools").innerHTML = TOOLS.map(([k, n, key]) => `<button class="btn sm ${S.tool === k ? "tf-on" : ""}" data-tool="${k}" title="${n} (${key})">${n}<kbd>${key}</kbd></button>`).join("");
    }
    const HINTS = {
      select: "Click to select · drag to move · corner handles resize · round handle rotates · Del deletes · Ctrl+D duplicates · R turns 90° · [ ] turn 5° · arrows nudge (Shift ×10)",
      b: "Click to place the next program building · drag to draw any footprint",
      p: "Drag a parking field: stalls, aisles and islands fill in · Flip in the panel turns the aisles",
      d: "Click points from the road into the site · double-click or Enter to finish · Esc cancels · 24 ft wide, curb returns added at the road",
      o: "Drag a pond · drag its corners to shape it · none drawn = one is placed automatically",
      v: "Drag extra pavement (loading, plaza, turnaround)", pan: "Drag to pan · wheel zooms",
    };

    // ---- view
    function fit() {
      const r = canvas.getBoundingClientRect();
      const xs = base.parcel.flatMap((p) => p[0].map((q) => q[0])), ys = base.parcel.flatMap((p) => p[0].map((q) => q[1]));
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const sc = Math.min((r.width - 60) / Math.max(x1 - x0, 50), (r.height - 60) / Math.max(y1 - y0, 50));
      S.view = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, sc: Math.max(sc, 0.05) };
    }
    const toSvg = (p) => `${R2(p[0])},${R2(-p[1])}`;
    const pathOf = (rings) => rings.map((r) => "M" + r.map(toSvg).join("L") + "Z").join("");
    function eventPt(e) {
      const r = svg.getBoundingClientRect();
      const x = (e.clientX - r.left - r.width / 2) / S.view.sc + S.view.cx;
      const y = -((e.clientY - r.top - r.height / 2) / S.view.sc) + S.view.cy;
      return [x, y];
    }
    const snap = (v, e) => (e && e.altKey) ? v : Math.round(v);

    // ---- derived numbers (recomputed on every change)
    function derive() {
      const blds = S.objs.filter((o) => o.t === "b");
      const blockers = blds.map((b) => corners(grow(b, WALK)));
      let stalls = 0, aisleSF = 0;
      for (const o of S.objs) if (o.t === "p") {
        o._L = fieldLayout(o, pz, blockers);
        stalls += o._L.stalls.length;
        aisleSF += o._L.aisles.length ? o._L.aisles.reduce((s, a) => s + area(a), 0) : 0;
      }
      for (const b of blds) {
        const c = corners(b);
        b._bad = !insideAll(c, bz) ? "Outside the building setbacks" : constraints.some((rs) => c.some((p) => inPoly(p, rs)) || polyEdgesCross(c, [rs])) ? "On a constraint" : "";
        b._over = blds.some((o) => o !== b && satOverlap(c, corners(o)));
      }
      const fp = blds.reduce((s, b) => s + b.w * b.d, 0);
      const gfa = blds.reduce((s, b) => s + b.w * b.d * (+b.stories || 1), 0);
      const driveSF = S.objs.filter((o) => o.t === "d").reduce((s, d) => s + plen(d.pts) * (d.width || 24), 0);
      const paveSF = S.objs.filter((o) => o.t === "v").reduce((s, v) => s + area(v.pts), 0);
      const walkSF = blds.reduce((s, b) => s + 2 * (b.w + b.d) * WALK, 0);
      const imperv = fp + stalls * SW * SD + aisleSF + driveSF + paveSF + walkSF;
      const pondSF = S.objs.filter((o) => o.t === "o").reduce((s, o) => s + area(o.pts), 0);
      const req = Math.ceil(gfa / 1000 * (+S.ratio || 0));
      const L = base.limits || {};
      const warn = [];
      for (const b of blds) { if (b._bad) warn.push(`${b.name}: ${b._bad.toLowerCase()}`); if (b._over) warn.push(`${b.name} overlaps another building`); }
      if (stalls < req) warn.push(`Parking short by ${req - stalls} (${stalls} of ${req})`);
      if (!S.objs.some((o) => o.t === "d")) warn.push("No driveway yet: draw one from the road");
      for (const d of S.objs.filter((o) => o.t === "d")) {
        const segs = d.pts.slice(1).map((q, i) => [d.pts[i], q]);
        const hits = (polys) => polys.some((rs) => segs.some(([a, b]) => inPoly(a, rs) || inPoly(b, rs) || polyEdgesCross([a, b], [rs])));
        if (hits((base.keep_bldgs || []).flatMap((b) => b.rings))) warn.push("A drive runs through an existing building that stays");
        else if (hits([...(base.wet || []), ...(base.flood || [])])) warn.push("A drive crosses a wetland or flood zone");
        if (blds.some((b) => segs.some(([a, c]) => inRing(a, corners(b)) || inRing(c, corners(b)) || polyEdgesCross([a, c], [[[...corners(b), corners(b)[0]]]])))) warn.push("A drive runs through a proposed building");
      }
      const cov = 100 * fp / parcelSF, imp = 100 * imperv / parcelSF, far = gfa / parcelSF;
      if (L.max_lot_coverage_pct && cov > L.max_lot_coverage_pct) warn.push(`Lot coverage ${cov.toFixed(1)}% over the ${L.max_lot_coverage_pct}% maximum`);
      if (L.max_impervious_pct && imp > L.max_impervious_pct) warn.push(`Impervious ${imp.toFixed(1)}% over the ${L.max_impervious_pct}% maximum`);
      if (L.max_far && far > L.max_far) warn.push(`FAR ${far.toFixed(2)} over the ${L.max_far} maximum`);
      const pondNeed = Math.max(3000, 0.08 * imperv);
      S.D = { blds, fp, gfa, stalls, req, ada: stalls ? adaReq(stalls) : 0, imperv, imp, cov, far, pondSF, pondNeed, warn };
    }

    // ---- drawing
    let raf = 0;
    const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
    function draw() {
      derive();
      const r = canvas.getBoundingClientRect();
      const { cx, cy, sc } = S.view;
      const vw = r.width / sc, vh = r.height / sc;
      svg.setAttribute("viewBox", `${cx - vw / 2} ${-cy - vh / 2} ${vw} ${vh}`);
      const px = 1 / sc, fs = 11 * px;
      const out = [];
      // aerial (state plane -> local -> svg)
      if (S.layers.aerial && opts.aerialUrl && base.aerial?.extent?.length === 4) {
        const [ex0, ey0, ex1, ey1] = base.aerial.extent, { o, a, k } = base.frame;
        const [p0x, p0y] = rot((ex0 - o[0]) * k, (ey1 - o[1]) * k, -a);
        const ca = Math.cos(a) * k, sa = Math.sin(a) * k;
        // local = k R(-a)(p - o); image x -> state +x, image y -> state -y; svg flips y
        out.push(`<image href="${esc(opts.aerialUrl)}" x="0" y="0" width="${ex1 - ex0}" height="${ey1 - ey0}" preserveAspectRatio="none" opacity="0.92"
          transform="matrix(${ca},${sa},${-sa},${ca},${p0x},${-p0y})"/>`);
      }
      out.push(`<path d="${pathOf(base.parcel.flat())}" fill="${S.layers.aerial ? "rgba(255,255,255,0.10)" : "var(--surface)"}" stroke="#e5368f" stroke-width="${2.2 * px}"/>`);
      for (const rd of base.roads || []) for (const p of rd.pave) out.push(`<path d="${pathOf(p)}" fill="rgba(70,70,70,${S.layers.aerial ? 0.25 : 0.55})" stroke="none"/>`);
      if (sc > 0.18) for (const rd of base.roads || []) {          // road names
        if (!rd.name || !rd.cl?.length) continue;
        const ln = rd.cl.reduce((a, b) => (plen(b) > plen(a) ? b : a));
        if (plen(ln) < 120) continue;
        let acc = 0, half = plen(ln) / 2, at = ln[0], ang = 0;
        for (let i = 1; i < ln.length; i++) { const sl = Math.hypot(ln[i][0] - ln[i - 1][0], ln[i][1] - ln[i - 1][1]); if (acc + sl >= half) { const t = (half - acc) / (sl || 1); at = [ln[i - 1][0] + t * (ln[i][0] - ln[i - 1][0]), ln[i - 1][1] + t * (ln[i][1] - ln[i - 1][1])]; ang = Math.atan2(ln[i][1] - ln[i - 1][1], ln[i][0] - ln[i - 1][0]) * 180 / Math.PI; break; } acc += sl; }
        if (ang > 90 || ang < -90) ang += 180;
        out.push(`<text x="${R2(at[0])}" y="${R2(-at[1])}" font-size="${fs * 1.05}" text-anchor="middle" class="tf-lbl tf-road" transform="rotate(${R2(-ang)} ${R2(at[0])} ${R2(-at[1])})" pointer-events="none">${esc(rd.name.toUpperCase())}</text>`);
      }
      if (S.layers.constraints) {
        for (const p of base.wet || []) out.push(`<path d="${pathOf(p)}" fill="rgba(40,170,90,0.28)" stroke="#2a9d5a" stroke-width="${1.2 * px}" stroke-dasharray="${6 * px} ${4 * px}"/>`);
        for (const p of base.flood || []) out.push(`<path d="${pathOf(p)}" fill="rgba(40,110,220,0.18)" stroke="#2a6fd8" stroke-width="${1 * px}"/>`);
        for (const p of base.steep || []) out.push(`<path d="${pathOf(p)}" fill="rgba(230,140,30,0.25)" stroke="none"/>`);
        for (const b of base.keep_bldgs || []) for (const p of b.rings) out.push(`<path d="${pathOf(p)}" fill="rgba(60,60,60,0.75)" stroke="#222" stroke-width="${px}"/>`);
        for (const b of base.demo_bldgs || []) for (const p of b.rings) out.push(`<path d="${pathOf(p)}" fill="none" stroke="#c4352b" stroke-width="${px}" stroke-dasharray="${4 * px} ${3 * px}"/>`);
        for (const b of base.reuse_pave || []) for (const p of b.rings) out.push(`<path d="${pathOf(p)}" fill="rgba(120,120,120,0.35)" stroke="#888" stroke-width="${px}"/>`);
      }
      if (S.layers.setbacks) {
        for (const p of bz) out.push(`<path d="${pathOf(p)}" fill="none" stroke="#f2c230" stroke-width="${1.6 * px}" stroke-dasharray="${9 * px} ${5 * px}"/>`);
        for (const p of pz) out.push(`<path d="${pathOf(p)}" fill="none" stroke="#9b6be0" stroke-width="${1.2 * px}" stroke-dasharray="${3 * px} ${4 * px}"/>`);
      }
      // ponds, extra pavement, drives
      for (const o of S.objs.filter((o) => o.t === "o")) out.push(`<path d="${pathOf([[...o.pts, o.pts[0]]])}" fill="rgba(70,140,220,0.55)" stroke="#2a6fd8" stroke-width="${1.4 * px}" data-id="${o.id}" class="tf-hit"/>`);
      for (const o of S.objs.filter((o) => o.t === "v")) out.push(`<path d="${pathOf([[...o.pts, o.pts[0]]])}" fill="#5d6166" stroke="#3b3e42" stroke-width="${px}" data-id="${o.id}" class="tf-hit"/>`);
      for (const o of S.objs.filter((o) => o.t === "d")) {
        const d = "M" + o.pts.map(toSvg).join("L");
        out.push(`<path d="${d}" fill="none" stroke="#5d6166" stroke-width="${o.width || 24}" stroke-linejoin="round" stroke-linecap="butt" data-id="${o.id}" class="tf-hit"/>`);
        out.push(`<path d="${d}" fill="none" stroke="#f5f5f0" stroke-width="${0.8 * px}" stroke-dasharray="${8 * px} ${8 * px}" pointer-events="none"/>`);
      }
      // parking
      for (const o of S.objs.filter((o) => o.t === "p")) {
        const L = o._L;
        out.push(`<path d="${pathOf([[...corners(o), corners(o)[0]]])}" fill="rgba(93,97,102,0.18)" stroke="${S.sel === o.id ? "var(--mint)" : "rgba(255,255,255,0.35)"}" stroke-width="${px}" stroke-dasharray="${4 * px} ${3 * px}" data-id="${o.id}" class="tf-hit"/>`);
        out.push(`<path d="${L.aisles.map((a) => "M" + a.map(toSvg).join("L") + "Z").join("")}" fill="#5d6166" pointer-events="none"/>`);
        out.push(`<path d="${L.stalls.map((a) => "M" + a.map(toSvg).join("L") + "Z").join("")}" fill="#6b7076" stroke="#f5f5f0" stroke-width="${Math.max(0.3, 0.7 * px)}" pointer-events="none"/>`);
        if (L.dropped.length && sc > 0.6) out.push(`<path d="${L.dropped.map((a) => "M" + a.map(toSvg).join("L") + "Z").join("")}" fill="none" stroke="rgba(196,53,43,0.45)" stroke-width="${0.6 * px}" pointer-events="none"/>`);
      }
      // buildings
      for (const b of S.objs.filter((o) => o.t === "b")) {
        const c = corners(b), cw = corners(grow(b, WALK));
        out.push(`<path d="${pathOf([[...cw, cw[0]]])}" fill="rgba(225,225,220,0.75)" stroke="none" pointer-events="none"/>`);
        const bad = b._bad || b._over;
        out.push(`<path d="${pathOf([[...c, c[0]]])}" fill="${bad ? "#e9b4ae" : "#d8dde6"}" stroke="${bad ? "#c4352b" : "#30363d"}" stroke-width="${1.4 * px}" data-id="${b.id}" class="tf-hit"/>`);
        if (b.w * sc > 46) {
          const t = [b.name, `${num(b.w * b.d)} SF${(+b.stories || 1) > 1 ? ` × ${b.stories}` : ""}`];
          out.push(`<text x="${R2(b.cx)}" y="${R2(-b.cy)}" font-size="${fs}" text-anchor="middle" class="tf-lbl" pointer-events="none">${t.map((s, i) => `<tspan x="${R2(b.cx)}" dy="${i ? 1.25 * fs : -0.2 * fs}">${esc(s)}</tspan>`).join("")}</text>`);
        }
      }
      for (const o of S.objs.filter((o) => o.t === "p")) {
        const n = o._L.stalls.length;
        if (sc > 0.35) out.push(`<text x="${R2(o.cx)}" y="${R2(-o.cy)}" font-size="${fs}" text-anchor="middle" class="tf-lbl tf-lbl-p" pointer-events="none">${n} stalls</text>`);
      }
      // drawing preview
      if (S.drawPts) {
        const pts = [...S.drawPts, ...(S.mouse ? [S.mouse] : [])];
        if (S.tool === "d") out.push(`<path d="M${pts.map(toSvg).join("L")}" fill="none" stroke="rgba(93,97,102,0.7)" stroke-width="24" stroke-linejoin="round"/>`);
      }
      if (S.rubber) {
        const [a, b] = S.rubber;
        out.push(`<rect x="${Math.min(a[0], b[0])}" y="${-Math.max(a[1], b[1])}" width="${Math.abs(b[0] - a[0])}" height="${Math.abs(b[1] - a[1])}" fill="rgba(41,232,166,0.12)" stroke="var(--mint)" stroke-width="${px}"/>`);
        out.push(`<text x="${(a[0] + b[0]) / 2}" y="${-Math.max(a[1], b[1]) - 4 * px}" font-size="${fs}" text-anchor="middle" class="tf-lbl">${Math.round(Math.abs(b[0] - a[0]))}' × ${Math.round(Math.abs(b[1] - a[1]))}'</text>`);
      }
      // handles
      const o = S.objs.find((x) => x.id === S.sel);
      if (o) {
        const h = 7 * px;
        if (o.t === "b" || o.t === "p") {
          corners(o).forEach((p, i) => out.push(`<rect x="${p[0] - h / 2}" y="${-p[1] - h / 2}" width="${h}" height="${h}" class="tf-h" data-h="c${i}"/>`));
          const top = toWorld(o, 0, o.d / 2 + 22 * px);
          const mid = toWorld(o, 0, o.d / 2);
          out.push(`<line x1="${mid[0]}" y1="${-mid[1]}" x2="${top[0]}" y2="${-top[1]}" stroke="var(--mint)" stroke-width="${px}"/>`);
          out.push(`<circle cx="${top[0]}" cy="${-top[1]}" r="${h * 0.6}" class="tf-h" data-h="rot"/>`);
          out.push(`<path d="${pathOf([[...corners(o), corners(o)[0]]])}" fill="none" stroke="var(--mint)" stroke-width="${1.6 * px}" pointer-events="none"/>`);
        } else {
          o.pts.forEach((p, i) => out.push(`<rect x="${p[0] - h / 2}" y="${-p[1] - h / 2}" width="${h}" height="${h}" class="tf-h" data-h="v${i}"/>`));
        }
      }
      svg.innerHTML = out.join("");
      // scale bar
      const nice = [10, 20, 25, 50, 100, 200, 250, 500, 1000].find((v) => v * sc >= 70) || 1000;
      root.querySelector("#tfScale").innerHTML = `<div style="width:${nice * sc}px"></div><span>${nice} ft</span>`;
      root.querySelector("#tfHint").textContent = HINTS[S.tool] || "";
      drawPanel();
    }

    // ---- side panel
    function field(label, key, val, type = "number", extra = "") {
      return `<label class="tf-f"><span>${label}</span><input data-k="${key}" type="${type}" value="${esc(val)}" ${extra}></label>`;
    }
    function drawPanel() {
      if (panel.contains(document.activeElement) && document.activeElement.tagName === "INPUT" && !S._forcePanel) return;   // do not rebuild under the cursor
      S._forcePanel = false;
      const D = S.D, o = S.objs.find((x) => x.id === S.sel);
      let sel = "";
      if (o?.t === "b") sel = `<h4>Building</h4>
        ${field("Name", "name", o.name, "text")}${field("Use", "use", o.use || "", "text")}
        <div class="tf-g2">${field("Width ft", "w", R2(o.w))}${field("Depth ft", "d", R2(o.d))}</div>
        <div class="tf-g2">${field("Stories", "stories", o.stories || 1, "number", 'min="1" step="1"')}${field("Rotation°", "rot", R2(o.rot || 0))}</div>
        ${field("Footprint SF (keeps depth)", "fp", Math.round(o.w * o.d))}
        <div class="tf-kv"><span>GFA</span><b>${num(o.w * o.d * (+o.stories || 1))} SF</b></div>
        ${o._bad || o._over ? `<div class="tf-warn">${esc(o._bad || "Overlaps another building")}</div>` : ""}`;
      else if (o?.t === "p") sel = `<h4>Parking field</h4>
        <div class="tf-g2">${field("Length ft", "w", R2(o.w))}${field("Width ft", "d", R2(o.d))}</div>
        <div class="tf-g2">${field("Rotation°", "rot", R2(o.rot || 0))}${field("Island every", "islands", o.islands ?? ISL, "number", 'min="0" step="1"')}</div>
        <div class="row" style="gap:6px;margin:6px 0"><button class="btn sm" data-tf="flip">Flip aisles</button><button class="btn sm" data-tf="fitfield">Trim to stalls</button></div>
        <div class="tf-kv"><span>Stalls</span><b>${o._L.stalls.length}</b></div>
        <div class="tf-kv"><span>Lost to setbacks / buildings</span><b>${o._L.dropped.length}</b></div>
        <div class="tf-note">90° stalls 9' × 18', 24' two-way aisles${o._L.unused > 1 ? `, ${Math.round(o._L.unused)}' unused across the field` : ""}.</div>`;
      else if (o?.t === "d") sel = `<h4>Drive</h4>${field("Width ft", "width", o.width || 24)}
        <div class="tf-kv"><span>Length</span><b>${num(plen(o.pts))} ft</b></div><div class="tf-note">Double-click a segment to add a bend; Alt-click a point to remove it.</div>`;
      else if (o?.t === "o") sel = `<h4>Pond</h4><div class="tf-kv"><span>Area</span><b>${num(area(o.pts))} SF</b></div><div class="tf-note">Drag the corners to shape it. Double-click an edge to add a corner.</div>`;
      else if (o?.t === "v") sel = `<h4>Pavement</h4><div class="tf-kv"><span>Area</span><b>${num(area(o.pts))} SF</b></div>`;
      const placed = new Set(S.objs.filter((x) => x.t === "b").map((x) => x.name));
      const pb = (prog.buildings || []).map((b, i) => {
        const nm = b.name || `Building ${String.fromCharCode(65 + i)}`;
        return `<div class="tf-pb ${placed.has(nm) ? "tf-done" : ""}"><span>${esc(nm)}</span><span>${num(b.footprint_sf)} SF${(b.stories || 1) > 1 ? ` × ${b.stories}` : ""}</span>
          ${placed.has(nm) ? "<em>placed</em>" : `<button class="btn sm" data-tf="place" data-i="${i}">Place</button>`}</div>`;
      }).join("");
      const bar = (v, lim, lbl, suffix) => `<div class="tf-kv ${lim && v > lim ? "tf-over" : ""}"><span>${lbl}</span><b>${suffix(v)}${lim ? ` <small>/ ${suffix(lim)} max</small>` : ""}</b></div>`;
      const L = base.limits || {};
      panel.innerHTML = `
        <div class="tf-yield">
          <div class="tf-big"><span>Stalls</span><b class="${D.stalls < D.req ? "tf-bad" : "tf-ok"}">${D.stalls}<small> / ${D.req} req.</small></b></div>
          <div class="tf-big"><span>GFA</span><b>${num(D.gfa)}<small> SF</small></b></div>
        </div>
        <div class="tf-kv"><span>Parking ratio</span><b><input class="tf-in" data-g="ratio" type="number" step="0.1" min="0" value="${S.ratio}"> / 1,000 SF</b></div>
        <div class="tf-kv"><span>ADA stalls (incl.)</span><b>${D.ada}</b></div>
        <div class="tf-kv"><span>Building footprint</span><b>${num(D.fp)} SF</b></div>
        ${bar(D.far, L.max_far, "FAR", (v) => (+v).toFixed(2))}
        ${bar(D.cov, L.max_lot_coverage_pct, "Lot coverage", (v) => (+v).toFixed(1) + "%")}
        ${bar(D.imp, L.max_impervious_pct, "Impervious (est.)", (v) => (+v).toFixed(1) + "%")}
        <div class="tf-kv"><span>Pond</span><b>${D.pondSF ? num(D.pondSF) + " SF" : S.autoPond ? "auto" : "none"} <small>~${num(D.pondNeed)} SF est.</small></b></div>
        <label class="tf-chk"><input type="checkbox" data-g="autoPond" ${S.autoPond ? "checked" : ""}> Place a pond automatically when none is drawn</label>
        ${D.warn.length ? `<div class="tf-warns">${D.warn.map((w) => `<div>${esc(w)}</div>`).join("")}</div>` : `<div class="tf-oklist">No issues found</div>`}
        <div class="tf-sel">${sel || `<div class="tf-note">Select something to edit its size, rotation and details.</div>`}</div>
        ${pb ? `<h4>Program</h4>${pb}` : ""}
        <h4>Layers</h4>
        <label class="tf-chk"><input type="checkbox" data-l="aerial" ${S.layers.aerial ? "checked" : ""}> Aerial</label>
        <label class="tf-chk"><input type="checkbox" data-l="setbacks" ${S.layers.setbacks ? "checked" : ""}> Setbacks <small><i style="color:#f2c230">━ ━</i> building <i style="color:#9b6be0">┅</i> pavement</small></label>
        <label class="tf-chk"><input type="checkbox" data-l="constraints" ${S.layers.constraints ? "checked" : ""}> Wetlands, flood, steep, existing</label>
        <div class="row" style="gap:6px;margin-top:12px;flex-wrap:wrap">
          ${base.seed ? `<button class="btn sm" data-tf="reset">Start from the automatic layout</button>` : ""}
          <button class="btn sm" data-tf="clear">Clear all</button><button class="btn sm" data-tf="fit">Zoom to site</button>
        </div>
        ${S.msg ? `<div class="tf-msg">${esc(S.msg)}</div>` : ""}`;
    }

    // ---- history
    const snapshot = () => JSON.stringify({ objs: S.objs.map(({ _L, _bad, _over, ...o }) => o), ratio: S.ratio, autoPond: S.autoPond });
    function commit() { S.hist.push(S._before ?? snapshot()); if (S.hist.length > 200) S.hist.shift(); S.fut = []; S._before = null; S.dirty = true; persistLocal(); }
    function begin() { S._before = snapshot(); }
    function restore(js) { const v = JSON.parse(js); S.objs = v.objs; S.ratio = v.ratio; S.autoPond = v.autoPond; S._forcePanel = true; redraw(); }
    const undo = () => { if (!S.hist.length) return; S.fut.push(snapshot()); restore(S.hist.pop()); };
    const redo = () => { if (!S.fut.length) return; S.hist.push(snapshot()); restore(S.fut.pop()); };
    const LSK = "tf:" + (opts.jobId || "x");
    function persistLocal() { try { localStorage.setItem(LSK, JSON.stringify({ at: Date.now(), design: design() })); } catch (_) { /* storage may be blocked */ } }
    try {
      const loc = JSON.parse(localStorage.getItem(LSK) || "null");
      const srv = opts.design?.saved_at ? Date.parse(opts.design.saved_at) : 0;
      if (loc?.design && loc.at > srv + 1000) { load(loc.design); S.msg = "Restored your unsaved changes from this browser."; S.dirty = true; }
    } catch (_) { /* ignore */ }

    // ---- output
    function design() {
      const blds = S.objs.filter((o) => o.t === "b");
      const blockers = blds.map((b) => corners(grow(b, WALK)));
      const r1 = (p) => [R2(p[0]), R2(p[1])];
      return {
        frame: base.frame, parking_ratio: +S.ratio, auto_pond: !!S.autoPond,
        buildings: blds.map((b) => ({ name: b.name, use: b.use, label: b.label, stories: +b.stories || 1, drive_thru: !!b.drive_thru, cx: R2(b.cx), cy: R2(b.cy), w: R2(b.w), d: R2(b.d), rot: R2(b.rot || 0) })),
        parking: S.objs.filter((o) => o.t === "p").map((f) => {
          const L = fieldLayout(f, pz, blockers);
          return { params: { cx: R2(f.cx), cy: R2(f.cy), w: R2(f.w), d: R2(f.d), rot: R2(f.rot || 0), flip: !!f.flip, islands: f.islands ?? ISL },
            stalls: L.stalls.map((s) => s.map(r1)), aisles: L.aisles.map((s) => s.map(r1)) };
        }),
        drives: S.objs.filter((o) => o.t === "d").map((d) => ({ width: +d.width || 24, pts: d.pts.map(r1) })),
        ponds: S.objs.filter((o) => o.t === "o").map((o) => ({ pts: o.pts.map(r1) })),
        pavement: S.objs.filter((o) => o.t === "v").map((o) => ({ pts: o.pts.map(r1) })),
        totals: { stalls: S.D?.stalls, required: S.D?.req, gfa: Math.round(S.D?.gfa || 0) },
      };
    }

    // ---- creation
    function progDims(b) {
      const fp = +b.footprint_sf || 10000;
      const d = Math.min(+b.depth_ft || 60, Math.max(30, Math.sqrt(fp) * 1.6));
      return { w: R2(fp / d), d: R2(d) };
    }
    function nextProgram(i) {
      const list = prog.buildings || [];
      const placed = new Set(S.objs.filter((x) => x.t === "b").map((x) => x.name));
      const idx = i ?? list.findIndex((b, k) => !placed.has(b.name || `Building ${String.fromCharCode(65 + k)}`));
      if (idx < 0 || !list[idx]) return null;
      const b = list[idx];
      return { name: b.name || `Building ${String.fromCharCode(65 + idx)}`, use: b.use, label: b.label, stories: b.stories || 1, drive_thru: !!b.drive_thru, ...progDims(b) };
    }
    function bName() { const n = S.objs.filter((x) => x.t === "b").length; let k = n, nm; do { nm = `Building ${String.fromCharCode(65 + (k % 26))}${k >= 26 ? Math.floor(k / 26) : ""}`; k++; } while (S.objs.some((x) => x.name === nm)); return nm; }
    function add(o) { begin(); S.objs.push(o); S.sel = o.id; commit(); S._forcePanel = true; redraw(); }
    function placeProgram(i, at) {
      const p = nextProgram(i);
      const c = at || [S.view.cx, S.view.cy];
      add({ t: "b", id: nid("b"), rot: 0, ...(p || { name: bName(), use: prog.use || "", stories: 1, w: 120, d: 60 }), cx: snap(c[0]), cy: snap(c[1]) });
    }

    // ---- pointer
    let drag = null;
    function hitTest(p) {
      // topmost first: buildings, drives, parking, pavement, ponds
      const order = ["b", "d", "p", "v", "o"];
      for (const t of order) for (const o of [...S.objs].reverse()) {
        if (o.t !== t) continue;
        if ((t === "b" || t === "p") && inRing(p, corners(o))) return o;
        if ((t === "o" || t === "v") && inRing(p, o.pts)) return o;
        if (t === "d") for (let i = 1; i < o.pts.length; i++) if (distSeg(p, o.pts[i - 1], o.pts[i]) <= (o.width || 24) / 2) return o;
      }
      return null;
    }
    svg.addEventListener("pointerdown", (e) => {
      if (e.button === 2) return;
      svg.setPointerCapture(e.pointerId);
      const p = eventPt(e);
      const panNow = S.tool === "pan" || e.button === 1 || S.space;
      if (panNow) { drag = { k: "pan", sx: e.clientX, sy: e.clientY, v: { ...S.view } }; return; }
      const h = e.target.dataset?.h;
      const o = S.objs.find((x) => x.id === S.sel);
      if (h && o) {
        begin();
        if (h === "rot") drag = { k: "rot", o };
        else if (h[0] === "c") {
          const i = +h.slice(1), opp = corners(o)[(i + 2) % 4];
          drag = { k: "resize", o, opp };
        } else if (h[0] === "v") {
          const i = +h.slice(1);
          if (e.altKey && o.pts.length > (o.t === "d" ? 2 : 3)) { o.pts.splice(i, 1); commit(); redraw(); drag = null; return; }
          drag = { k: "vert", o, i };
        }
        return;
      }
      if (S.tool === "select") {
        const hit = hitTest(p);
        S.sel = hit ? hit.id : null; S._forcePanel = true;
        if (hit) { begin(); drag = { k: "move", o: hit, p0: p, orig: JSON.parse(JSON.stringify(hit)) }; }
        else drag = { k: "pan", sx: e.clientX, sy: e.clientY, v: { ...S.view } };
        redraw(); return;
      }
      if (S.tool === "d") {
        if (!S.drawPts) S.drawPts = [];
        S.drawPts.push([snap(p[0], e), snap(p[1], e)]); redraw(); return;
      }
      if (["b", "p", "o", "v"].includes(S.tool)) { drag = { k: "rubber", p0: [snap(p[0], e), snap(p[1], e)] }; S.rubber = [drag.p0, drag.p0]; }
    });
    svg.addEventListener("pointermove", (e) => {
      const p = eventPt(e);
      S.mouse = [snap(p[0], e), snap(p[1], e)];
      if (!drag) { if (S.drawPts) redraw(); return; }
      if (drag.k === "pan") { S.view.cx = drag.v.cx - (e.clientX - drag.sx) / S.view.sc; S.view.cy = drag.v.cy + (e.clientY - drag.sy) / S.view.sc; redraw(); return; }
      if (drag.k === "rubber") { S.rubber = [drag.p0, S.mouse]; redraw(); return; }
      const o = drag.o;
      if (drag.k === "move") {
        const dx = p[0] - drag.p0[0], dy = p[1] - drag.p0[1];
        if (o.t === "b" || o.t === "p") { o.cx = snap(drag.orig.cx + dx, e); o.cy = snap(drag.orig.cy + dy, e); }
        else o.pts = drag.orig.pts.map((q) => [snap(q[0] + dx, e), snap(q[1] + dy, e)]);
      } else if (drag.k === "rot") {
        let a = Math.atan2(p[1] - o.cy, p[0] - o.cx) * 180 / Math.PI - 90;
        if (!e.shiftKey) a = Math.round(a / 5) * 5;
        o.rot = ((a + 540) % 360) - 180;
      } else if (drag.k === "resize") {
        const [u, v] = toLocal({ ...o, cx: drag.opp[0], cy: drag.opp[1] }, p);
        const w = Math.max(10, Math.abs(snap(u, e))), d = Math.max(10, Math.abs(snap(v, e)));
        const [mx, my] = rot(Math.sign(u || 1) * w / 2, Math.sign(v || 1) * d / 2, rad(o.rot || 0));
        o.w = w; o.d = d; o.cx = drag.opp[0] + mx; o.cy = drag.opp[1] + my;
      } else if (drag.k === "vert") {
        o.pts[drag.i] = [snap(p[0], e), snap(p[1], e)];
      }
      redraw();
    });
    svg.addEventListener("pointerup", (e) => {
      if (!drag) return;
      const d = drag; drag = null;
      if (d.k === "rubber") {
        const [a, b] = S.rubber; S.rubber = null;
        const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]), c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const small = w < 8 && h < 8;
        if (S.tool === "b") {
          if (small) placeProgram(undefined, c);
          else { const p0 = nextProgram(); add({ t: "b", id: nid("b"), rot: 0, ...(p0 || { name: bName(), use: prog.use || "", stories: 1 }), cx: c[0], cy: c[1], w, d: h }); }
        } else if (S.tool === "p") {
          add({ t: "p", id: nid("p"), cx: c[0], cy: c[1], w: small ? 180 : w, d: small ? 120 : h, rot: 0, flip: false, islands: ISL });
        } else {
          const ww = small ? (S.tool === "o" ? 90 : 60) : w, hh = small ? (S.tool === "o" ? 60 : 40) : h;
          add({ t: S.tool, id: nid(S.tool), pts: [[c[0] - ww / 2, c[1] - hh / 2], [c[0] + ww / 2, c[1] - hh / 2], [c[0] + ww / 2, c[1] + hh / 2], [c[0] - ww / 2, c[1] + hh / 2]] });
        }
        return;
      }
      if (["move", "rot", "resize", "vert"].includes(d.k)) {
        if (S._before && S._before !== snapshot()) commit(); else S._before = null;
        S._forcePanel = true; redraw();
      }
    });
    svg.addEventListener("dblclick", (e) => {
      const p = eventPt(e);
      if (S.tool === "d" && S.drawPts) { finishDrive(); return; }
      const o = S.objs.find((x) => x.id === S.sel);
      if (o && (o.t === "d" || o.t === "o" || o.t === "v")) {          // add a point on the nearest segment
        const n = o.pts.length, closed = o.t !== "d";
        let best = null;
        for (let i = 0; i < (closed ? n : n - 1); i++) { const a = o.pts[i], b = o.pts[(i + 1) % n], dd = distSeg(p, a, b); if (!best || dd < best[0]) best = [dd, i]; }
        if (best && best[0] < 30) { begin(); o.pts.splice(best[1] + 1, 0, [snap(p[0]), snap(p[1])]); commit(); redraw(); }
      }
    });
    function finishDrive() {
      const pts = (S.drawPts || []).filter((q, i, a) => !i || Math.hypot(q[0] - a[i - 1][0], q[1] - a[i - 1][1]) > 2);
      S.drawPts = null;
      if (pts.length >= 2) add({ t: "d", id: nid("d"), width: 24, pts }); else redraw();
    }
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const p = eventPt(e), f = Math.exp(-e.deltaY * 0.0015);
      const sc = Math.min(40, Math.max(0.03, S.view.sc * f));
      S.view.cx = p[0] - (p[0] - S.view.cx) * S.view.sc / sc; S.view.cy = p[1] - (p[1] - S.view.cy) * S.view.sc / sc; S.view.sc = sc;
      redraw();
    }, { passive: false });
    svg.addEventListener("contextmenu", (e) => e.preventDefault());

    // ---- keyboard
    function onKey(e) {
      if (!document.body.contains(root)) return;
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") { if (e.key === "Enter") e.target.blur(); return; }
      const o = S.objs.find((x) => x.id === S.sel);
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); return; }
      if ((e.ctrlKey || e.metaKey) && k === "s") { e.preventDefault(); save(); return; }
      if ((e.ctrlKey || e.metaKey) && k === "d" && o) {
        e.preventDefault(); begin();
        const c = JSON.parse(JSON.stringify(o)); c.id = nid(o.t);
        if (c.t === "b" || c.t === "p") { const [dx] = rot((o.w + 20), 0, rad(o.rot || 0)); const [, dy] = rot(o.w + 20, 0, rad(o.rot || 0)); c.cx += dx; c.cy += dy; if (c.t === "b") c.name = bName(); }
        else c.pts = c.pts.map((q) => [q[0] + 30, q[1] - 30]);
        S.objs.push(c); S.sel = c.id; commit(); S._forcePanel = true; redraw(); return;
      }
      if (e.key === " ") { S.space = true; e.preventDefault(); return; }
      if (e.key === "Escape") { S.drawPts = null; S.rubber = null; S.tool = "select"; drawTools(); redraw(); return; }
      if (e.key === "Enter" && S.drawPts) { finishDrive(); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && o) { begin(); S.objs = S.objs.filter((x) => x !== o); S.sel = null; commit(); S._forcePanel = true; redraw(); return; }
      if (o && (o.t === "b" || o.t === "p") && (k === "r" || e.key === "[" || e.key === "]")) {
        begin(); o.rot = (((o.rot || 0) + (k === "r" ? 90 : e.key === "[" ? 5 : -5)) + 540) % 360 - 180; commit(); S._forcePanel = true; redraw(); return;
      }
      if (o && e.key.startsWith("Arrow")) {
        e.preventDefault(); begin();
        const s = e.shiftKey ? 10 : 1, dx = e.key === "ArrowLeft" ? -s : e.key === "ArrowRight" ? s : 0, dy = e.key === "ArrowUp" ? s : e.key === "ArrowDown" ? -s : 0;
        if (o.t === "b" || o.t === "p") { o.cx += dx; o.cy += dy; } else o.pts = o.pts.map((q) => [q[0] + dx, q[1] + dy]);
        commit(); S._forcePanel = true; redraw(); return;
      }
      const tool = { v: "select", b: "b", p: "p", d: "d", o: "o", a: "v", h: "pan" }[k];
      if (tool && !e.ctrlKey && !e.metaKey) { S.tool = tool; S.drawPts = null; drawTools(); redraw(); }
    }
    const onKeyUp = (e) => { if (e.key === " ") S.space = false; };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    const onResize = () => redraw();
    window.addEventListener("resize", onResize);

    // ---- panel + toolbar events
    root.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-tf],[data-tool]");
      if (!t) return;
      if (t.dataset.tool) { S.tool = t.dataset.tool; S.drawPts = null; drawTools(); redraw(); return; }
      const a = t.dataset.tf, o = S.objs.find((x) => x.id === S.sel);
      if (a === "undo") undo();
      else if (a === "redo") redo();
      else if (a === "save") save();
      else if (a === "submit") submit();
      else if (a === "close") close();
      else if (a === "fit") { fit(); redraw(); }
      else if (a === "place") placeProgram(+t.dataset.i);
      else if (a === "flip" && o) { begin(); o.flip = !o.flip; commit(); S._forcePanel = true; redraw(); }
      else if (a === "fitfield" && o?.t === "p") {          // shrink the field to the stalls it actually holds
        const L = o._L; if (!L.stalls.length) return;
        begin();
        const al = o.flip ? 1 : 0, ac = 1 - al;            // along / across the aisles, in the field's own axes
        const st = L.stalls.flat().map((q) => toLocal(o, q)), all = [...L.stalls, ...L.aisles].flat().map((q) => toLocal(o, q));
        const lo = [0, 0], hi = [0, 0];
        lo[al] = Math.min(...st.map((q) => q[al])); hi[al] = Math.max(...st.map((q) => q[al]));
        lo[ac] = Math.min(...all.map((q) => q[ac])); hi[ac] = Math.max(...all.map((q) => q[ac]));
        const c = toWorld(o, (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2);
        o.w = R2(hi[0] - lo[0]); o.d = R2(hi[1] - lo[1]); o.cx = c[0]; o.cy = c[1];
        commit(); S._forcePanel = true; redraw();
      } else if (a === "reset") { if (confirmIt("Replace the test fit with the automatic layout's buildings?")) { begin(); S.objs = []; load(null, base.seed); commit(); S._forcePanel = true; redraw(); } }
      else if (a === "clear") { if (confirmIt("Remove everything from the test fit?")) { begin(); S.objs = []; S.sel = null; commit(); S._forcePanel = true; redraw(); } }
    });
    function confirmIt(msg) {       // the page avoids blocking browser dialogs: a second click within 4 s confirms
      if (S._confirm === msg && Date.now() - S._confirmAt < 4000) { S._confirm = null; return true; }
      S._confirm = msg; S._confirmAt = Date.now(); S.msg = msg + " Click again to confirm."; S._forcePanel = true; redraw();
      return false;
    }
    panel.addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset.l) { S.layers[t.dataset.l] = t.checked; redraw(); return; }
      if (t.dataset.g) { begin(); S[t.dataset.g] = t.type === "checkbox" ? t.checked : +t.value; commit(); S._forcePanel = true; redraw(); return; }
      const o = S.objs.find((x) => x.id === S.sel);
      if (!o || !t.dataset.k) return;
      begin();
      const k = t.dataset.k, v = t.type === "number" ? +t.value : t.value;
      if (k === "fp") { if (v > 0) { o.w = R2(v / o.d); } }
      else if (["w", "d"].includes(k)) o[k] = Math.max(5, v);
      else o[k] = v;
      commit(); S._forcePanel = true; redraw();
    });

    // ---- save / submit / close
    async function save() {
      if (S.busy) return;
      S.busy = true; S.msg = "Saving…"; S._forcePanel = true; redraw();
      try { await opts.onSave(design()); S.dirty = false; S.msg = "Draft saved."; try { localStorage.removeItem(LSK); } catch (_) { /* ignore */ } }
      catch (err) { S.msg = "Save failed: " + err.message; }
      S.busy = false; S._forcePanel = true; redraw();
    }
    async function submit() {
      if (S.busy) return;
      derive();
      if (!S.D.blds.length) { S.msg = "Place at least one building first."; S._forcePanel = true; redraw(); return; }
      if (S.D.warn.length && !confirmIt(`Send with ${S.D.warn.length} open issue${S.D.warn.length > 1 ? "s" : ""}?`)) return;
      S.busy = true; S.msg = "Sending to the concept plan…"; S._forcePanel = true; redraw();
      try { await opts.onSubmit(design()); try { localStorage.removeItem(LSK); } catch (_) { /* ignore */ } teardown(); }
      catch (err) { S.msg = "Send failed: " + err.message; S.busy = false; S._forcePanel = true; redraw(); }
    }
    function teardown() {
      window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKeyUp); window.removeEventListener("resize", onResize);
      root.remove(); document.body.style.overflow = "";
      opts.onClose && opts.onClose();
    }
    function close() { if (S.dirty) persistLocal(); teardown(); }

    drawTools();
    requestAnimationFrame(() => { fit(); draw(); });
    return { close, design };
  }

  window.TestFit = { open, fieldLayout, corners };
})();
