/* SME Connections, Phase 1 demo. Requirement tags (R#) refer to PRD-SME-Briefing.md.
   Only competitor trials are synthetic. Every other fact comes from the workbook. */
(function () {
  "use strict";
  const D = window.SME_DATA;
  const STORE_KEY = "smeConnections.alternative.myNetwork";
  const PEER_CAP = 60;
  const ATTR_SME_CAP = 80;
  const OVERVIEW_CAP = 40;
  const SCENARIO_SHOW = 15;
  const LAYOUT_TIMEOUT_MS = 4000;
  // Investigator roles that count as leading a study. SC (steering committee) is shown but not counted.
  const LEAD_ROLES = new Set(["PI", "NPI", "CO-PI", "RPI", "GPI"]);

  // ---------- Indexes ----------
  const byId = new Map();
  const kindOf = (id) =>
    id.startsWith("CS") ? "study" : id.startsWith("CT") ? "ct" : id.startsWith("TA") ? "ta" :
    id.startsWith("S") ? "sme" : id.startsWith("I") ? "inst" : "topic";
  [D.smes, D.institutions, D.studies, D.therapeuticAreas, D.topics, D.competitorTrials]
    .forEach((arr) => arr.forEach((x) => byId.set(x.id, x)));

  const membersOf = new Map(); // attribute id -> [sme ids]
  const addMember = (attr, sid) => {
    if (!membersOf.has(attr)) membersOf.set(attr, []);
    if (!membersOf.get(attr).includes(sid)) membersOf.get(attr).push(sid);
  };
  D.smes.forEach((s) => {
    s.institutions.forEach((a) => addMember(a.id, s.id));
    s.studies.forEach((a) => addMember(a.id, s.id));
    s.tas.forEach((t) => addMember(t, s.id));
    s.topics.forEach((t) => addMember(t, s.id));
    s.competitorTrials.forEach((c) => addMember(c, s.id));
  });
  const groupSize = (attr) => (membersOf.get(attr) || []).length;

  // Peer adjacency (R14). Two SMEs connect through a shared institution, Cook study,
  // or (synthetic) competitor trial. Each link keeps every shared basis.
  const peers = new Map(D.smes.map((s) => [s.id, new Map()]));
  membersOf.forEach((sids, attr) => {
    const k = kindOf(attr);
    if (k !== "inst" && k !== "study" && k !== "ct") return;
    for (let i = 0; i < sids.length; i++)
      for (let j = 0; j < sids.length; j++) {
        if (i === j) continue;
        const m = peers.get(sids[i]);
        if (!m.has(sids[j])) m.set(sids[j], []);
        if (!m.get(sids[j]).includes(attr)) m.get(sids[j]).push(attr);
      }
  });

  // ---------- State ----------
  const state = {
    showSynth: true,
    layer: "combined",
    overviewTotal: 0,
    filters: { ta: "", region: "", specialty: "", advocate: "" },
    history: [], hpos: -1,
    view: null,
    graphView: null, // the view whose graph is currently drawn
    pathEdges: [], pathNodes: [],
  };

  // My Network persistence (R13). Works in memory if storage throws.
  let storageOk = true;
  let myNet = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    if (!Array.isArray(saved)) throw new Error("Invalid saved network");
    myNet = new Set(saved.filter((id) => byId.has(id) && kindOf(id) === "sme"));
  } catch (e) { storageOk = false; }
  const saveMyNet = () => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify([...myNet])); }
    catch (e) { storageOk = false; }
    document.getElementById("storageNote").hidden = storageOk;
  };

  // ---------- Helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nameOf = (id) => { const x = byId.get(id); return x ? x.name || x.last : id; };
  const SYN = '<span class="syn">SYNTHETIC</span>';
  const NR = (what) => `Not recorded in the workbook${what ? " (" + what + ")" : ""}`;
  const passes = (s) => {
    const f = state.filters;
    return (!f.ta || s.tas.includes(f.ta)) && (!f.region || s.region === f.region) &&
      (!f.specialty || s.specialty === f.specialty) &&
      (!f.advocate || (s.isCookAdvocate || "Unknown") === f.advocate);
  };
  const visibleAttr = (id) => state.showSynth || kindOf(id) !== "ct";
  const roleTokens = (role) => (role || "").toUpperCase().split(/[+\/,\s]+/).filter(Boolean);
  const leadCount = (s) => s.studies.filter((x) => roleTokens(x.role).some((t) => LEAD_ROLES.has(t))).length;
  const currentInst = (s) => (s.institutions.find((a) => a.current) || s.institutions[0] || {}).id;
  const siteLabel = (s) => s.institutions.some((a) => a.current) ? "Current affiliation" : "Recorded affiliation";
  const FILTER_INPUTS = [["fTa", "ta"], ["fRegion", "region"], ["fSpecialty", "specialty"], ["fAdvocate", "advocate"]];
  const clearFilters = () => { Object.keys(state.filters).forEach((k) => { state.filters[k] = ""; }); };

  function syncContext() {
    FILTER_INPUTS.forEach(([el, key]) => { $(el).value = state.filters[key]; });
    $("layer").value = state.layer;
    const labels = Object.entries(state.filters).filter(([, v]) => v).map(([key, value]) =>
      key === "ta" ? nameOf(value) : key === "advocate" ? { Yes: "Cook advocate", No: "Recorded non-advocate", Unknown: "Status not recorded" }[value] : value);
    const matching = D.smes.filter(passes).length;
    $("filterStatus").textContent = `${matching} of ${D.smes.length} physicians${labels.length ? " · " + labels.join(" · ") : " · No filters"}`;
    $("clearFilters").disabled = !labels.length;
    $("synthState").textContent = state.showSynth ? "ON" : "OFF";
    $("modeNote").textContent = state.showSynth ? "Fictional trial links enabled" : "Recorded data only";
    $("statTrials").textContent = state.showSynth ? D.competitorTrials.length : "Hidden";
    $("legend").querySelector('[data-k="ct"]').hidden = !state.showSynth;
  }

  function updateGraphMetrics() {
    const drawn = nodes.get(), links = edges.get();
    const physicians = drawn.filter((n) => kindOf(n.id) === "sme").length;
    const synthetic = drawn.filter((n) => kindOf(n.id) === "ct").length;
    const box = $("graphMetrics");
    box.textContent = `${physicians} physicians · ${drawn.length - physicians} shared / attribute records · ${links.length} links${synthetic ? ` · ${synthetic} SYNTHETIC trial nodes` : ""}`;
    box.dataset.syntheticCount = synthetic;
    box.dataset.physicianCount = physicians;
    $("graphEmpty").hidden = drawn.length > 0;
  }

  // Strongest shared basis first. Real beats synthetic, then smaller groups, then stable ID.
  function rankVias(vias) {
    return vias.filter(visibleAttr).sort((a, b) =>
      (kindOf(a) === "ct") - (kindOf(b) === "ct") || groupSize(a) - groupSize(b) || a.localeCompare(b));
  }
  const viaLabel = (v) => `${esc(nameOf(v))} <span class="meta">(${groupSize(v)} physicians)</span>${kindOf(v) === "ct" ? SYN : ""}`;

  // ---------- Node styling (R10) ----------
  const C = { blue: "#77a7cc", dark: "#072f3f", shade: "#3a7a8f", digital: "#008be3",
    gray: "#a6a7a7", lgray: "#e4e4e4", t2: "#bfd2e2", synth: "#c9822e" };
  const STYLE = {
    sme: { shape: "dot", size: 14, color: { background: C.blue, border: C.shade } },
    inst: { shape: "square", size: 10, color: { background: "#d6d7d7", border: C.gray } },
    study: { shape: "diamond", size: 12, color: { background: C.shade, border: C.dark } },
    ct: { shape: "triangle", size: 12, color: { background: "#f3d3ad", border: C.synth },
      shapeProperties: { borderDashes: [4, 3] }, borderWidth: 2 },
    ta: { shape: "hexagon", size: 18, color: { background: C.dark, border: C.dark } },
    topic: { shape: "dot", size: 7, color: { background: C.t2, border: C.blue } },
  };
  const LEGEND = [["sme", "Physician (SME)"], ["inst", "Institution"], ["study", "Cook study"],
    ["ct", "Competitor trial (synthetic)"], ["ta", "Therapeutic area"], ["topic", "Expertise topic"]];

  function makeNode(id, extra) {
    const k = kindOf(id);
    const x = byId.get(id);
    let label = x.name;
    if (k === "sme") label = (myNet.has(id) ? "★ " : "") + x.name;
    else if (label.length > 28) label = label.slice(0, 26) + "…";
    if (k === "ct") label += "\n[SYNTHETIC]";
    const n = Object.assign({ id, label, group: k, title: tooltip(id) },
      JSON.parse(JSON.stringify(STYLE[k])), extra || {});
    if (k === "sme" && myNet.has(id)) {
      n.color = { background: C.blue, border: C.digital };
      n.borderWidth = 3;
    }
    return n;
  }
  function tooltip(id) {
    const x = byId.get(id), k = kindOf(id);
    if (k === "sme") return [x.name, x.specialty, [x.region, x.country].filter(Boolean).join(", ")]
      .filter(Boolean).join("\n");
    const n = groupSize(id);
    const lbl = { inst: "Institution", study: "Cook study", ct: "Competitor trial (SYNTHETIC)",
      ta: "Therapeutic area", topic: "Expertise topic" }[k];
    return `${x.name}\n${lbl}, ${n} physician${n === 1 ? "" : "s"}`;
  }
  const focalStyle = { size: 26, color: { background: C.dark, border: C.digital }, borderWidth: 3,
    font: { size: 15, bold: true, color: C.dark } };

  // ---------- Network ----------
  const nodes = new vis.DataSet();
  const edges = new vis.DataSet();
  const network = new vis.Network($("net"), { nodes, edges }, {
    layout: { randomSeed: 42, improvedLayout: false },
    nodes: { font: { size: 12, color: "#333", face: "Arial" }, borderWidth: 1 },
    edges: { color: { color: "#c9cfd3", highlight: C.digital }, width: 1, smooth: false,
      font: { size: 10, color: C.shade, strokeWidth: 3, align: "middle" } },
    physics: { solver: "barnesHut", barnesHut: { gravitationalConstant: -6000, springLength: 110,
      springConstant: 0.03, avoidOverlap: 0.2 }, stabilization: { iterations: 300 } },
    interaction: { hover: true, tooltipDelay: 150, navigationButtons: false },
  });
  let layoutTimer = null;
  function finishLayout() {
    clearTimeout(layoutTimer);
    network.setOptions({ physics: { enabled: false } });
    network.fit({ animation: { duration: 400 } });
    $("loading").hidden = true;
  }
  network.on("stabilizationIterationsDone", finishLayout);
  function draw(nodeList, edgeList, title) {
    state.pathEdges = [];
    state.pathNodes = [];
    $("loading").hidden = false;
    nodes.clear(); edges.clear();
    nodes.add(nodeList); edges.add([...new Map(edgeList.map((e) => [e.id, e])).values()]);
    updateGraphMetrics();
    $("viewTitle").textContent = title;
    network.setOptions({ physics: { enabled: true } });
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(finishLayout, LAYOUT_TIMEOUT_MS); // never leave the presenter stuck on "Laying out"
    network.stabilize(300);
  }
  network.on("click", (p) => {
    if (!p.nodes.length) return;
    const id = p.nodes[0];
    navigate(kindOf(id) === "sme" ? { kind: "sme", id } : { kind: "inspect", id });
  });
  network.on("doubleClick", (p) => {
    if (p.nodes.length && kindOf(p.nodes[0]) !== "sme") navigate({ kind: "attr", id: p.nodes[0] });
  });

  // ---------- Graph views ----------
  function egoGraph(sid) { // R9
    const s = byId.get(sid);
    const ns = [makeNode(sid, focalStyle)], es = [];
    const seen = new Set([sid]);
    const attrs = [];
    s.institutions.forEach((a) => attrs.push([a.id, a.current ? "" : "former"]));
    s.studies.forEach((a) => attrs.push([a.id, a.role || ""]));
    if (state.showSynth) s.competitorTrials.forEach((c) => attrs.push([c, ""]));
    s.tas.forEach((t) => attrs.push([t, ""]));
    s.topics.forEach((t) => attrs.push([t, ""]));
    attrs.forEach(([a, lbl]) => {
      if (seen.has(a)) return;
      seen.add(a);
      ns.push(makeNode(a));
      es.push({ id: `${sid}|${a}`, from: sid, to: a, label: lbl || undefined, dashes: kindOf(a) === "ct" });
    });
    const ranked = [...peers.get(sid).entries()]
      .map(([p, vias]) => [p, rankVias(vias)])
      .filter(([p, vias]) => vias.length && passes(byId.get(p)))
      .sort((x, y) => (kindOf(x[1][0]) === "ct") - (kindOf(y[1][0]) === "ct") ||
        y[1].length - x[1].length || nameOf(x[0]).localeCompare(nameOf(y[0])));
    ranked.slice(0, PEER_CAP).forEach(([p, vias]) => {
      ns.push(makeNode(p, { size: 11 }));
      seen.add(p);
      vias.forEach((v) => es.push({ id: `${p}|${v}`, from: p, to: v, dashes: kindOf(v) === "ct" }));
    });
    const more = ranked.length > PEER_CAP ? ` (top ${PEER_CAP} of ${ranked.length} peers)` : "";
    draw(ns, es, `${s.name}${more}`);
  }

  function attributeGraph(aid) {
    const members = (membersOf.get(aid) || []).filter((m) => passes(byId.get(m)));
    const ns = [makeNode(aid, { size: 24 })], es = [];
    members.slice(0, ATTR_SME_CAP).forEach((m) => {
      ns.push(makeNode(m));
      es.push({ id: `${m}|${aid}`, from: m, to: aid, dashes: kindOf(aid) === "ct" });
    });
    const more = members.length > ATTR_SME_CAP ? ` (first ${ATTR_SME_CAP} of ${members.length})` : "";
    draw(ns, es, nameOf(aid) + more);
  }

  function overviewGraph() {
    const ns = [], es = [], seen = new Set();
    const attrsFor = (s) => {
      const real = state.layer === "institutions" ? s.institutions.map((a) => a.id) :
        state.layer === "studies" ? s.studies.map((a) => a.id) :
        state.layer === "competitor" ? [] : [...s.studies.map((a) => a.id), ...s.institutions.map((a) => a.id)];
      const synthetic = state.showSynth && ["combined", "competitor"].includes(state.layer) ? s.competitorTrials : [];
      return [...new Set([...real, ...synthetic])].filter((id) => state.layer !== "combined" || groupSize(id) > 1);
    };
    const pool = D.smes.filter(passes).map((s) => ({ s, attrs: attrsFor(s) })).filter((r) => r.attrs.length);
    state.overviewTotal = pool.length;
    pool.sort((a, b) => b.attrs.length - a.attrs.length || a.s.name.localeCompare(b.s.name));
    // A bounded sample, not a claim that the remaining physicians have no connections.
    const picked = pool.slice(0, OVERVIEW_CAP);
    // Ensure the mixed overview actually illustrates fictional trial connections too.
    if (state.layer === "combined" && state.showSynth) {
      pool.filter((r) => r.s.competitorTrials.length).slice(0, 12).forEach((r) => {
        if (!picked.some((p) => p.s.id === r.s.id)) {
          if (picked.length === OVERVIEW_CAP) picked.pop();
          picked.unshift(r);
        }
      });
    }
    picked.forEach(({ s, attrs }) => {
      ns.push(makeNode(s.id, { size: 17 }));
      attrs.forEach((attr) => {
        if (!seen.has(attr)) { seen.add(attr); ns.push(makeNode(attr)); }
        es.push({ id: `${s.id}|${attr}`, from: s.id, to: attr, dashes: kindOf(attr) === "ct" });
      });
    });
    const label = { combined: "Recorded + synthetic connections", studies: "Cook study network", institutions: "Institution network", competitor: "Synthetic trial network" }[state.layer];
    draw(ns, es, `${label} · ${picked.length} of ${pool.length} physicians with layer records`);
  }

  // ---------- Navigation (R11) ----------
  // Every meaningful selection is a history entry. "inspect" shows an attribute's panel
  // on top of the graph that was showing when it was clicked.
  function drawFor(v) {
    state.graphView = v;
    if (v.kind === "sme") { egoGraph(v.id); renderBriefing(v.id); }
    else if (v.kind === "attr") { attributeGraph(v.id); showAttributePanel(v.id); }
    else if (v.kind === "scenario") runScenario(v.id);
    else { overviewGraph(); renderWelcome(); }
  }
  function navigate(v, fromHistory) {
    if (fromHistory && v.context) {
      state.filters = { ...v.context.filters };
      state.layer = v.context.layer;
    }
    if (!state.showSynth && ((v.id && kindOf(v.id) === "ct") || (v.base && v.base.id && kindOf(v.base.id) === "ct"))) {
      v = { kind: "overview" };
    }
    if (v.kind === "inspect" && !v.base) v = { ...v, base: state.graphView };
    v = { ...v, context: { filters: { ...state.filters }, layer: state.layer } };
    if (!fromHistory) {
      state.history = state.history.slice(0, state.hpos + 1);
      state.history.push(v);
      state.hpos = state.history.length - 1;
    }
    state.view = v;
    syncContext();
    const graphV = v.kind === "inspect" ? v.base : v;
    document.querySelectorAll(".scn").forEach((b) => {
      const active = graphV && graphV.kind === "scenario" && b.dataset.scn === graphV.id;
      b.classList.toggle("on", active);
      b.setAttribute("aria-pressed", String(Boolean(active)));
    });
    if (v.kind === "inspect") {
      drawFor(v.base || { kind: "overview" });
      showAttributePanel(v.id);
      if (nodes.get(v.id)) network.selectNodes([v.id]);
    } else drawFor(v);
    $("navBack").disabled = state.hpos <= 0;
    $("navFwd").disabled = state.hpos >= state.history.length - 1;
    $("right").scrollTop = 0;
  }
  const refresh = () => {
    state.graphView = null;
    navigate({ ...state.view, context: { filters: { ...state.filters }, layer: state.layer } }, true);
  };

  // ---------- Right panel ----------
  const P = () => $("panel");
  function renderWelcome() {
    const pool = D.smes.filter(passes);
    const connected = (s, realOnly) => [...peers.get(s.id).values()].some((vias) =>
      vias.some((id) => realOnly ? kindOf(id) !== "ct" : visibleAttr(id)));
    const realCount = pool.filter((s) => connected(s, true)).length;
    const activeCount = pool.filter((s) => connected(s, false)).length;
    const areas = D.therapeuticAreas.map((t) => ({ ...t, count: pool.filter((s) => s.tas.includes(t.id)).length }))
      .sort((a, b) => b.count - a.count);
    const max = Math.max(1, ...areas.map((t) => t.count));
    P().innerHTML = `<div class="eyebrow">Workbook snapshot</div><h2>Start with a connection</h2>
      <div class="meta">Choose a node, search a name, or explore a therapeutic area.</div>
      <div class="note">Overview shows up to ${OVERVIEW_CAP} physicians with the most layer records, plus a sample of fictional trial links when enabled. ${state.overviewTotal} physicians have records in this layer. The mixed layer shows shared groups only. Search reaches all ${D.smes.length} physicians.</div>
      <div class="hint">Scroll to zoom. Drag to pan. Click a physician for their network and briefing. Attribute nodes open their member lists.</div>
      <h4>Therapeutic areas</h4>${areas.map((t) => `<div class="area-row">${goLink(t.id)}<div class="area-track"><i style="width:${100 * t.count / max}%"></i></div><span>${t.count}</span></div>`).join("")}
      <div class="hint">Counts use current filters. Physicians can appear in several areas.</div>
      <h4>Shared-link coverage</h4><div class="coverage"><div><strong>${realCount}</strong><small>With recorded shared links</small></div><div><strong>${activeCount}</strong><small>${state.showSynth ? "Including synthetic links" : "Recorded links only"}</small></div></div>
      <div class="hint">Coverage counts physicians who share an institution or study with another physician, not just those with an affiliation.</div>
      ${state.showSynth ? `<div class="note synthetic">${SYN} Fictional competitor trials illustrate missing outside-trial data. They are not evidence about these physicians.</div>` : '<div class="note">Synthetic trials are hidden. This view uses only recorded workbook data.</div>'}
      <div class="meta">Source generated ${esc(D.meta.workbookGenerated || "date unknown")}. Fingerprint ${esc(D.meta.sourceSha || "n/a")}.</div>`;
  }

  function li(items, empty) {
    return items.length ? items.map((x) => `<li>${x}</li>`).join("") : `<li class="none">${empty}</li>`;
  }
  const goLink = (id, text) => `<a class="go" role="button" tabindex="0" data-go="${esc(id)}">${esc(text || nameOf(id))}</a>`;

  function engagementLine(e) {
    const what = e.notes ? esc(e.notes) : '<span class="meta">Participation recorded, event not named</span>';
    const extra = [e.type, e.source].filter(Boolean).map(esc).join(", ");
    return `${what}${extra ? ` <span class="meta">(${extra})</span>` : ""}`;
  }

  function renderBriefing(sid) { // R12
    const s = byId.get(sid);
    const starred = myNet.has(sid);
    const insts = s.institutions.map((a) => goLink(a.id) +
      (a.role ? ` <span class="role">${esc(a.role)}</span>` : "") +
      (a.current ? "" : ' <span class="meta">(former)</span>'));
    const studies = s.studies.map((a) => goLink(a.id) + (a.role ? `<span class="role">${esc(a.role)}</span>` : ""));
    const cts = s.competitorTrials.map((c) => goLink(c) + SYN);
    const engByYear = {};
    s.engagements.forEach((e) => { (engByYear[e.year || "Year not recorded"] ||= []).push(engagementLine(e)); });
    const engs = Object.keys(engByYear).sort().reverse()
      .map((y) => `<b>${esc(y)}</b><ul class="sub">${engByYear[y].map((l) => `<li>${l}</li>`).join("")}</ul>`);
    const badges = [
      s.specialty ? `<span class="badge">${esc(s.specialty)}</span>` : `<span class="badge none">Specialty not recorded</span>`,
      s.advocate && `<span class="badge yes">${esc(s.advocate)}</span>`,
      s.isCookAdvocate === "Yes" && !s.advocate && `<span class="badge yes">Cook advocate</span>`,
    ].filter(Boolean).join("");

    P().innerHTML = `
      <div class="eyebrow">Physician briefing · Workbook evidence</div>
      <div class="toprow"><div><h2>${esc(s.name)}</h2>
        <div class="meta">${esc([s.region, s.country].filter(Boolean).join(", ") || "Location not recorded")}</div></div>
        <button class="star ${starred ? "on" : ""}" id="starBtn">${starred ? "★ In my network" : "☆ I know them"}</button></div>
      <div class="badges">${badges}</div>
      <h4>Paths to my network</h4><div id="paths"></div>
      <h4>Cook studies</h4><ul class="list">${li(studies, NR())}</ul>
      ${state.showSynth ? `<h4>Competitor trials ${SYN}</h4><ul class="list">${li(cts, "None in the placeholder set")}</ul>` : ""}
      <h4>Engagements</h4><ul class="list">${li(engs, NR())}</ul>
      <h4>Works with Cook through</h4><ul class="list">${li(s.relTypes.map(esc), NR())}</ul>
      <h4>Education programs</h4><ul class="list">${li(s.programs.map(esc), NR())}</ul>
      <h4>Institutions</h4><ul class="list">${li(insts, NR())}</ul>
      <h4>Therapeutic areas</h4><ul class="list">${li(s.tas.map((t) => goLink(t)), NR())}</ul>
      <h4>Expertise topics</h4><div class="badges">${s.topics.map((t) =>
        `<a class="badge go" role="button" tabindex="0" data-go="${t}">${esc(nameOf(t))}</a>`).join("") || `<span class="meta">${NR()}</span>`}</div>
      <div class="note">Credentials, career stage, and speaking suitability are not established by this dataset.</div>`;
    $("starBtn").setAttribute("aria-pressed", String(starred));
    $("starBtn").onclick = () => toggleStar(sid);
    const filtered = Object.values(state.filters).some(Boolean);
    if (filtered) P().insertAdjacentHTML("afterbegin", '<div class="note">The full physician record is shown. Filters limit the peer graph only. Paths search the whole dataset.</div>');
    renderPaths(sid);
  }

  function showAttributePanel(aid) {
    const k = kindOf(aid);
    const members = (membersOf.get(aid) || []).map((m) => byId.get(m))
      .filter(passes).sort((a, b) => a.last.localeCompare(b.last));
    const lbl = { inst: "Institution", study: "Cook study", ct: "Competitor trial", ta: "Therapeutic area", topic: "Expertise topic" }[k];
    const x = byId.get(aid);
    const aliases = x.aliases && x.aliases.length ? `<div class="meta">Also recorded as ${x.aliases.map((a) => esc(a.name)).join(", ")}.</div>` : "";
    const filtered = Object.values(state.filters).some(Boolean);
    const evidence = k === "ct" ? `<div class="note synthetic">${SYN} This trial and every physician assignment to it are fictional. Do not use this list as competitor intelligence.</div>` : "";
    P().innerHTML = `<h2>${esc(x.name)}${k === "ct" ? SYN : ""}</h2>
      ${evidence}
      <div class="meta">${lbl}${x.location ? ", " + esc(x.location) : ""}. ${members.length} physician${members.length === 1 ? "" : "s"}${filtered ? " matching filters" : ""}.</div>
      ${aliases}
      ${state.graphView && state.graphView.kind === "attr" && state.graphView.id === aid ? "" : `<button class="ghost" id="mkFocal">Make this the center of the graph</button>`}
      <ul class="list" style="margin-top:10px">${li(members.map((m) => {
        const role = k === "study" ? (m.studies.find((st) => st.id === aid) || {}).role : null;
        return goLink(m.id) + (role ? `<span class="role">${esc(role)}</span>` : "") +
          ` <span class="meta">${esc(m.specialty || "")}</span>`;
      }), "No physicians")}</ul>`;
    const b = $("mkFocal");
    if (b) b.onclick = () => navigate({ kind: "attr", id: aid });
  }

  // ---------- My Network (R13, R14) ----------
  function toggleStar(sid) {
    myNet.has(sid) ? myNet.delete(sid) : myNet.add(sid);
    saveMyNet();
    renderMyNet();
    const focal = state.graphView && state.graphView.kind === "sme" && state.graphView.id === sid;
    if (nodes.get(sid)) nodes.update(makeNode(sid, focal ? focalStyle : {}));
    const v = state.view;
    if (v && v.kind === "sme" && v.id === sid) renderBriefing(sid);
    else if (v && v.kind === "sme") renderPaths(v.id);
  }
  function renderMyNet() {
    const ids = [...myNet].filter((id) => byId.has(id)).sort((a, b) => byId.get(a).last.localeCompare(byId.get(b).last));
    $("myCount").textContent = ids.length ? `(${ids.length})` : "";
    $("myNet").innerHTML = ids.length ? ids.map((id) =>
      `<div class="row">${goLink(id)}<button class="x" data-unstar="${id}" title="Remove" aria-label="Remove ${esc(nameOf(id))} from my network">&times;</button></div>`).join("")
      : '<div class="hint">Star physicians you know personally. Briefings then show how any physician connects to them.</div>';
  }

  function shortestPaths(src, maxHops, realOnly) { // BFS, recording the strongest shared basis for each hop
    const prev = new Map([[src, null]]);
    let frontier = [src];
    for (let d = 0; d < maxHops && frontier.length; d++) {
      const next = [];
      frontier.forEach((u) => {
        [...peers.get(u).entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([v, vias]) => {
          if (prev.has(v)) return;
          const best = rankVias(vias).find((id) => !realOnly || kindOf(id) !== "ct");
          if (!best) return;
          prev.set(v, { from: u, via: best });
          next.push(v);
        });
      });
      frontier = next;
    }
    return prev;
  }
  function pathTo(prev, target) {
    if (!prev.has(target)) return null;
    const seq = [target];
    let cur = target;
    while (prev.get(cur)) { const p = prev.get(cur); seq.unshift(p.from, p.via); cur = p.from; }
    return seq; // [sme, via, sme, via, sme...]
  }
  function renderPaths(sid) {
    const box = $("paths");
    if (!box) return;
    const targets = [...myNet].filter((t) => t !== sid && byId.has(t));
    if (!targets.length) {
      box.innerHTML = `<div class="meta">${myNet.has(sid) && myNet.size === 1 ? "This is the only physician in your network." : "Star physicians you know to see how this one connects to them."}</div>`;
      return;
    }
    const real = shortestPaths(sid, 3, true);
    const demo = state.showSynth ? shortestPaths(sid, 3, false) : real;
    const found = targets.map((t) => ({ t, seq: pathTo(real, t) || pathTo(demo, t) }));
    const ok = found.filter((f) => f.seq).sort((a, b) => a.seq.length - b.seq.length);
    const none = found.filter((f) => !f.seq);
    box.innerHTML = ok.map((f, i) => {
      const parts = [];
      for (let j = 0; j < f.seq.length; j += 2) {
        parts.push(`<b>${esc(nameOf(f.seq[j]))}</b>`);
        if (j + 1 < f.seq.length) parts.push(`<span class="via">via ${viaLabel(f.seq[j + 1])}</span>`);
      }
      const hops = (f.seq.length - 1) / 2;
      const hypothetical = f.seq.some((id) => kindOf(id) === "ct");
      return `<div class="path" role="button" tabindex="0" data-target="${f.t}" data-synthetic="${hypothetical}" data-path="${i}">${hypothetical ? `<div>${SYN} Hypothetical demo route</div>` : '<div class="eyebrow">Recorded overlap</div>'}${parts.join(" &rarr; ")} <span class="meta">(${hops} hop${hops > 1 ? "s" : ""})</span></div>`;
    }).join("") +
      (ok.length ? '<div class="hint">Recorded routes are preferred within 3 hops, even when a synthetic route is shorter. Shared records do not establish that these physicians know each other. Paths search all records regardless of filters.</div>' : "") +
      (none.length ? `<div class="meta">No connection within 3 hops to ${none.map((f) => esc(nameOf(f.t))).join(", ")}.</div>` : "");
    box.querySelectorAll(".path").forEach((el) => {
      el.onclick = () => {
        box.querySelectorAll(".path").forEach((x) => x.classList.toggle("on", x === el));
        highlightPath(ok[+el.dataset.path].seq, +el.dataset.path);
      };
    });
  }
  function highlightPath(seq, pathIdx) {
    edges.remove(state.pathEdges);
    nodes.remove(state.pathNodes);
    state.pathEdges = [];
    state.pathNodes = [];
    // Physics is frozen, so place off-graph path nodes in a chain stepping away from the last placed node.
    const angle = -Math.PI / 2 + (pathIdx || 0) * 0.8;
    let anchor = network.getPositions([seq[0]])[seq[0]];
    seq.forEach((id) => {
      if (nodes.get(id)) { anchor = network.getPositions([id])[id]; return; }
      anchor = { x: anchor.x + 150 * Math.cos(angle), y: anchor.y + 150 * Math.sin(angle) };
      nodes.add(makeNode(id, { x: anchor.x, y: anchor.y }));
      state.pathNodes.push(id);
    });
    for (let i = 0; i + 1 < seq.length; i++) {
      const id = `path:${i}:${seq[i]}|${seq[i + 1]}`;
      edges.add({ id, from: seq[i], to: seq[i + 1], color: { color: C.digital }, width: 4,
        dashes: kindOf(seq[i]) === "ct" || kindOf(seq[i + 1]) === "ct" });
      state.pathEdges.push(id);
    }
    network.selectNodes(seq, false);
    updateGraphMetrics();
    network.fit({ nodes: seq, animation: { duration: 500 } });
  }

  // ---------- Scenarios (R15) ----------
  // Simple Phase 1 rules over workbook fields. Each returns [{s, score, group, reasons[]}].
  const SCENARIOS = {
    B: {
      title: "Investigator scouting",
      blurb: "Physicians with Cook study experience, fictional competitor-trial participation, or recorded VISTA education without a Cook study. Affiliations are shown where recorded. This is not site qualification. VISTA does not establish career stage.",
      rank(pool, syn) {
        const out = [];
        pool.filter((s) => s.studies.length).forEach((s) => out.push({ s, group: "Cook trial experience",
          score: s.studies.length + 2 * leadCount(s),
          reasons: [`${s.studies.length} Cook stud${s.studies.length > 1 ? "ies" : "y"}`, leadCount(s) ? `Lead role on ${leadCount(s)}` : null] }));
        if (syn) {
          pool.filter((s) => s.competitorTrials.length).forEach((s) => out.push({ s, group: "Synthetic competitor-trial illustration",
            score: 2 * s.competitorTrials.length + (s.studies.length ? 0 : 1), synth: true,
            reasons: [`${s.competitorTrials.length} competitor trial${s.competitorTrials.length > 1 ? "s" : ""}`, s.studies.length ? "also Cook" : "no Cook trial yet"] }));
        }
        pool.filter((s) => s.programs.includes("VISTA") && !s.studies.length).forEach((s) => out.push({ s, group: "VISTA education, no Cook study recorded",
          score: s.topics.length + s.engagements.length,
          reasons: ["VISTA participant", `${s.topics.length} topics`, s.engagements.length ? `${s.engagements.length} engagements` : null] }));
        return out;
      },
      groups: ["Cook trial experience", "Synthetic competitor-trial illustration", "VISTA education, no Cook study recorded"],
      perGroup: 5,
    },
    C: {
      title: "Speaker exploration",
      blurb: "Physicians with no Cook activity recorded in this workbook (no Cook studies, engagements, or education programs) who are not flagged as Cook advocates. Everyone here is already on Cook's advocate list, so truly new physicians need an outside source. Credentials and podium history are not in the workbook yet.",
      rank(pool) {
        return pool.filter((s) => !s.studies.length && !s.engagements.length && !s.programs.length && s.isCookAdvocate !== "Yes")
          .map((s) => ({ s, group: "No Cook activity recorded",
            score: s.topics.length + s.tas.length + (s.specialty ? 1 : 0),
            reasons: [s.isCookAdvocate === "No" ? "Not a Cook advocate" : "Advocate status not recorded", `${s.topics.length} topics`] }));
      },
      groups: ["No Cook activity recorded"], perGroup: SCENARIO_SHOW,
    },
    D: {
      title: "Advisory candidates",
      blurb: "Individual records ranked by topic, study, and lead-role depth plus breadth of areas, programs, and recorded Cook relationships. This measures record richness, not validated expertise. It does not assemble a balanced panel or check conflicts.",
      rank(pool) {
        return pool.map((s) => {
          const depth = s.topics.length + s.studies.length + 2 * leadCount(s);
          const breadth = s.tas.length + s.programs.length + s.relTypes.length;
          return { s, group: "Record depth and breadth", score: 2 * depth + breadth,
            reasons: [`${s.topics.length} topics`, s.studies.length ? `${s.studies.length} Cook studies` : null,
              `${s.tas.length} therapeutic area${s.tas.length > 1 ? "s" : ""}`, s.programs.length ? s.programs.join(", ") : null] };
        }).filter((r) => r.score > 4);
      },
      groups: ["Record depth and breadth"], perGroup: SCENARIO_SHOW,
    },
  };

  function runScenario(key) {
    if (key === "A") {
      overviewGraph();
      P().innerHTML = `<h2>Meeting preparation</h2><div class="note">Filters have been cleared for meeting preparation. Search the physician you are meeting. Their briefing shows the recorded Cook history and paths to your starred physicians. Fictional trial routes, if enabled, are labelled hypothetical.</div>`;
      $("q").focus(); $("q").classList.add("attention");
      setTimeout(() => $("q").classList.remove("attention"), 1500);
      return;
    }
    const sc = SCENARIOS[key];
    const syn = state.showSynth;
    const all = sc.rank(D.smes.filter(passes), syn);
    const picked = [], used = new Set();
    sc.groups.forEach((g) => {
      all.filter((r) => r.group === g && !used.has(r.s.id))
        .sort((a, b) => b.score - a.score || a.s.last.localeCompare(b.s.last))
        .slice(0, sc.perGroup).forEach((r) => { used.add(r.s.id); picked.push(r); });
    });
    const taName = state.filters.ta ? nameOf(state.filters.ta) : "all therapeutic areas";

    // Graph. Matches plus the nodes that explain why they matched.
    const ns = [], es = [], seen = new Set();
    const add = (id, extra) => { if (!seen.has(id)) { seen.add(id); ns.push(makeNode(id, extra)); } };
    if (state.filters.ta) add(state.filters.ta, { size: 26 });
    picked.forEach((r) => {
      add(r.s.id);
      const reasonNodes = key === "B" ? [...r.s.studies.map((x) => x.id), ...r.s.competitorTrials, currentInst(r.s)]
        : key === "C" ? r.s.institutions.map((a) => a.id) : r.s.topics;
      reasonNodes.filter((a) => a && visibleAttr(a)).forEach((a) => {
        add(a); es.push({ id: `${r.s.id}|${a}`, from: r.s.id, to: a, dashes: kindOf(a) === "ct" });
      });
      if (state.filters.ta) es.push({ id: `${r.s.id}|${state.filters.ta}`, from: r.s.id, to: state.filters.ta, color: { color: "#e8ecef" } });
    });
    draw(ns, es, `${sc.title}, ${taName}`);

    let html = `<h2>${esc(sc.title)}</h2><div class="meta">${esc(taName)}. ${picked.length} candidates.</div>
      <div class="note">${esc(sc.blurb)} Phase 1 uses simple rules, not validated scoring.</div>`;
    if (!state.filters.ta) html += '<div class="note">Tip. Pick a therapeutic area in Filters to focus this list.</div>';
    let rank = 0;
    sc.groups.forEach((g) => {
      const rows = picked.filter((r) => r.group === g);
      if (!rows.length) return;
      if (sc.groups.length > 1) html += `<div class="grp">${esc(g)}${rows[0].synth ? SYN : ""}</div>`;
      rows.forEach((r) => {
        rank++;
        const site = currentInst(r.s);
        html += `<div class="cand" role="button" tabindex="0" data-synthetic="${Boolean(r.synth)}" data-sid="${r.s.id}"><span class="rk">#${rank}</span>
          <div class="nm">${myNet.has(r.s.id) ? "★ " : ""}${esc(r.s.name)}${r.synth ? SYN : ""}</div>
          <div class="meta">${esc([r.s.specialty, r.s.region, r.s.country].filter(Boolean).join(", "))}</div>
          ${site ? `<div class="site">${siteLabel(r.s)} · ${esc(nameOf(site))}</div>` : '<div class="meta">Affiliation not recorded</div>'}
          <div class="badges">${r.reasons.filter(Boolean).map((x) => `<span class="badge">${esc(x)}</span>`).join("")}</div></div>`;
      });
    });
    if (!picked.length) html += '<div class="empty">No physicians match these filters. Try widening Region or Specialty.</div>';
    P().innerHTML = html;
    P().querySelectorAll(".cand").forEach((el) => {
      el.onclick = () => navigate({ kind: "sme", id: el.dataset.sid });
    });
  }

  // ---------- Search (R8) ----------
  const searchIndex = [
    ...D.smes.map((s) => ({ id: s.id, text: `${s.first} ${s.last}`.toLowerCase(),
      label: s.name, sub: [s.specialty, s.region, s.country].filter(Boolean).join(", "), rank: 0 })),
    ...D.institutions.map((i) => ({ id: i.id, text: i.name.toLowerCase(), label: i.name, sub: "Institution", rank: 1 })),
    ...D.studies.map((i) => ({ id: i.id, text: i.name.toLowerCase(), label: i.name, sub: "Cook study", rank: 2 })),
    ...D.therapeuticAreas.map((i) => ({ id: i.id, text: i.name.toLowerCase(), label: i.name, sub: "Therapeutic area", rank: 3 })),
    ...D.topics.map((i) => ({ id: i.id, text: [i.name, ...(i.aliases || []).map((a) => a.name)].join(" ").toLowerCase(), label: i.name, sub: "Expertise topic", rank: 4 })),
    ...D.competitorTrials.map((i) => ({ id: i.id, text: i.name.toLowerCase(), label: i.name, sub: "SYNTHETIC fictional trial", rank: 5 })),
  ];
  let selIdx = -1, current = [];
  function doSearch() {
    const q = $("q").value.trim().toLowerCase();
    const box = $("results");
    if (q.length < 2) { current = []; selIdx = -1; box.style.display = "none"; box.innerHTML = ""; return; }
    const terms = q.split(/\s+/);
    current = searchIndex.filter((e) => visibleAttr(e.id) && terms.every((t) => e.text.includes(t)))
      .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label)).slice(0, 14);
    selIdx = current.length ? 0 : -1;
    box.innerHTML = current.length ? current.map((e, i) =>
      `<div data-i="${i}" class="${i === 0 ? "sel" : ""}">${esc(e.label)}<small>${esc(e.sub)}</small></div>`).join("")
      : '<div class="meta">No matches</div>';
    box.style.display = "block";
  }
  function pick(i) {
    const e = current[i];
    if (!e) return;
    $("results").style.display = "none";
    $("q").value = "";
    navigate(kindOf(e.id) === "sme" ? { kind: "sme", id: e.id } : { kind: "attr", id: e.id });
  }
  $("q").addEventListener("input", doSearch);
  $("q").addEventListener("keydown", (ev) => {
    const items = $("results").querySelectorAll("div[data-i]");
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!items.length) return;
      selIdx = (selIdx + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle("sel", i === selIdx));
    } else if (ev.key === "Enter" && $("results").style.display !== "none") pick(selIdx);
    else if (ev.key === "Escape") $("results").style.display = "none";
  });
  $("results").addEventListener("mousedown", (ev) => {
    const el = ev.target.closest("div[data-i]");
    if (el) pick(+el.dataset.i);
  });
  $("q").addEventListener("blur", () => setTimeout(() => ($("results").style.display = "none"), 150));

  // ---------- Wiring ----------
  function fillSelect(id, values, anyLabel) {
    $(id).innerHTML = `<option value="">${anyLabel}</option>` +
      values.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("");
  }
  const uniq = (f) => [...new Set(D.smes.map(f).filter(Boolean))].sort().map((x) => [x, x]);
  fillSelect("fTa", D.therapeuticAreas.map((t) => [t.id, t.name]), "Any");
  fillSelect("fRegion", uniq((s) => s.region), "Any");
  fillSelect("fSpecialty", uniq((s) => s.specialty), "Any");
  FILTER_INPUTS.forEach(([el, key]) => {
    $(el).addEventListener("change", () => { state.filters[key] = $(el).value; navigate({ ...state.view }); });
  });
  $("clearFilters").addEventListener("click", () => { clearFilters(); navigate({ ...state.view }); });
  $("layer").addEventListener("change", () => { state.layer = $("layer").value; navigate({ kind: "overview" }); });
  document.querySelectorAll(".scn").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.scn === "A") clearFilters();
    navigate({ kind: "scenario", id: b.dataset.scn });
  }));
  $("showSynth").addEventListener("change", () => {
    state.showSynth = $("showSynth").checked;
    $("results").style.display = "none";
    current = []; selIdx = -1;
    refresh();
  });
  $("overview").addEventListener("click", () => navigate({ kind: "overview" }));
  $("resetDemo").addEventListener("click", () => {
    clearFilters(); state.layer = "combined";
    $("q").value = ""; doSearch();
    navigate({ kind: "overview" });
  });
  $("navBack").addEventListener("click", () => { if (state.hpos > 0) navigate(state.history[--state.hpos], true); });
  $("navFwd").addEventListener("click", () => { if (state.hpos < state.history.length - 1) navigate(state.history[++state.hpos], true); });
  $("fit").addEventListener("click", () => network.fit({ animation: { duration: 400 } }));
  [["zoomIn", 1.4], ["zoomOut", 1 / 1.4]].forEach(([id, factor]) => {
    $(id).addEventListener("click", () => network.moveTo({ scale: network.getScale() * factor, animation: { duration: 200 } }));
  });
  document.addEventListener("click", (ev) => {
    const go = ev.target.closest("[data-go]");
    if (go) {
      const id = go.dataset.go;
      if (kindOf(id) === "sme") navigate({ kind: "sme", id });
      else if (nodes.get(id)) { network.focus(id, { scale: 1.2, animation: true }); navigate({ kind: "inspect", id }); }
      else navigate({ kind: "attr", id });
      return;
    }
    const un = ev.target.closest("[data-unstar]");
    if (un) toggleStar(un.dataset.unstar);
  });

  $("legend").innerHTML = LEGEND.map(([k, t]) => {
    const st = STYLE[k];
    const r = st.shape === "dot" ? "50%" : "2px";
    const border = k === "ct" ? `1px dashed ${C.synth}` : `1px solid ${st.color.border}`;
    return `<span data-k="${k}"><i style="background:${st.color.background};border:${border};border-radius:${r}"></i>${t}</span>`;
  }).join("") + '<span><i style="background:#77a7cc;border:2px solid #008be3;border-radius:50%"></i>In my network</span>';
  $("dataStamp").textContent = `Data ${String(D.meta.workbookGenerated || "").slice(0, 10)} · ${D.meta.sourceSha || ""}`;

  document.addEventListener("keydown", (ev) => {
    if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches('[role="button"]')) {
      ev.preventDefault(); ev.target.click();
    }
  });
  $("statPhysicians").textContent = D.smes.length;
  $("statInstitutions").textContent = D.institutions.length;
  $("statStudies").textContent = D.studies.length;
  // Read-only local diagnostics for reproducible browser verification. No data leaves the page.
  window.SME_DIAGNOSTICS = Object.freeze({
    snapshot: () => ({ nodes: nodes.get(), edges: edges.get(), view: JSON.parse(JSON.stringify(state.view)),
      positions: network.getPositions(), scale: network.getScale(),
      canvasPositions: Object.fromEntries(Object.entries(network.getPositions()).map(([id, p]) => [id, network.canvasToDOM(p)])),
      overviewTotal: state.overviewTotal })
  });
  document.getElementById("storageNote").hidden = storageOk;
  renderMyNet();
  navigate({ kind: "overview" });
})();
