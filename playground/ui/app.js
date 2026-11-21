// The playground UI: a provider sidebar, one tab per test, and a results area with one column per provider.
// Runs stream their events over Server-Sent Events; each tab keeps the last run it showed. Plain ES module,
// no build step. Every server-provided string is escaped before it reaches innerHTML.
import { barChart, esc, fmt, histogramChart, sparkline } from "/charts.js";

const $ = selector => document.querySelector(selector);
const PALETTE = ["#7c9cff", "#3ccf91", "#f5b94a", "#ff7a90", "#5ad1e6", "#b48cff", "#ff9f5a", "#9be15d", "#e66bd3", "#6be6b8", "#ffd166", "#8fa3ff", "#f78c6b", "#4dd4ac", "#c792ea", "#82aaff", "#f07178"];
const CAP_LABELS = { pause: "pause", snapshot: "snapshot", ttl: "ttl", ports: "ports", ssh: "ssh", desktop: "desktop", background: "background", persistentDisk: "persistent disk" };
const CAPS = Object.keys(CAP_LABELS);
const CHECK_LABELS = { create: "create", exec: "exec", files: "write/read", list: "list by label", destroy: "destroy" };

const TABS = [
  { id: "speed", label: "Speed", blurb: "Create, exec, file transfer, pause, resume and destroy timings." },
  { id: "stream", label: "Live stream", blurb: "A background process writes a line every interval; see how fast lines arrive." },
  { id: "agent", label: "Agent", blurb: "A Claude agent works through real tasks inside each sandbox. Spends money." },
  { id: "load", label: "Load", blurb: "Many sandboxes at once: success rate, errors and latency spread." },
  { id: "capabilities", label: "Capabilities", blurb: "Declared capabilities, and a quick check of the core interface." },
];

const SPEED_METRICS = [
  { key: "create_ms", label: "Create to running", unit: "ms", better: "lower" },
  { key: "first_exec_ms", label: "First exec", unit: "ms", better: "lower" },
  { key: "exec_p50_ms", p95: "exec_p95_ms", label: "Exec round trip (p50 / p95)", unit: "ms", better: "lower" },
  { key: "write_mbps", label: "Write file", unit: "MB/s", better: "higher" },
  { key: "read_mbps", label: "Read file", unit: "MB/s", better: "higher" },
  { key: "pause_ms", label: "Pause", unit: "ms", better: "lower" },
  { key: "resume_ms", label: "Resume", unit: "ms", better: "lower" },
  { key: "destroy_ms", label: "Destroy", unit: "ms", better: "lower" },
];

const stored = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };

const state = {
  overview: null,
  byModule: new Map(),
  selected: new Set(stored("osb.selected", ["docker"])),
  tab: TABS.some(tab => tab.id === localStorage.getItem("osb.tab")) ? localStorage.getItem("osb.tab") : "speed",
  options: stored("osb.options", null) ?? {
    speed: { rounds: 10, fileMiB: 1, pause: true },
    stream: { durationS: 15, intervalMs: 200, pollMs: 400 },
    agent: { model: "claude-opus-5-5", effort: "medium", tasks: null, maxTurns: 25, timeLimitMin: 10 },
    load: { n: 5 },
    capabilities: {},
  },
  views: {},
};

const saveSelection = () => localStorage.setItem("osb.selected", JSON.stringify([...state.selected]));
const saveOptions = () => localStorage.setItem("osb.options", JSON.stringify(state.options));
const colorOf = module => PALETTE[Math.max(0, [...state.byModule.keys()].indexOf(module)) % PALETTE.length];
const titleOf = module => state.byModule.get(module)?.title ?? module;

async function api(path, init = {}) {
  const response = await fetch(path, { ...init, headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `${response.status} ${response.statusText}`);
  return data;
}
const post = (path, value = {}) => api(path, { method: "POST", body: JSON.stringify(value) });

function toast(message, kind = "info") {
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.textContent = message;
  $("#toasts").append(node);
  setTimeout(() => node.classList.add("out"), 5200);
  setTimeout(() => node.remove(), 5600);
}

function logo(module, size = 28) {
  const entry = state.byModule.get(module);
  if (entry?.logo) return `<span class="logo" style="width:${size}px;height:${size}px"><img src="${esc(entry.logo)}" alt="" loading="lazy"></span>`;
  const letters = (entry?.title ?? module).split(/\s+/).map(word => word[0]).join("").slice(0, 2).toUpperCase();
  return `<span class="logo mono" style="width:${size}px;height:${size}px;background:${colorOf(module)}">${esc(letters)}</span>`;
}

// ---------------------------------------------------------------- sidebar and header

function renderStats(live = state.overview?.liveSandboxes ?? 0) {
  const providers = state.overview?.providers ?? [];
  const available = providers.filter(entry => entry.available).length;
  $("#stats").innerHTML = `
    <span class="stat"><b>${providers.length}</b> providers</span>
    <span class="stat"><b>${available}</b> available</span>
    <span class="stat"><b>${selectedAvailable().length}</b> selected</span>
    <span class="stat ${live ? "live" : ""}" title="Sandboxes this server has created and not yet destroyed"><i class="dot"></i><b>${live}</b> live sandbox${live === 1 ? "" : "es"}</span>`;
}

function renderSidebar() {
  const list = $("#provider-list");
  list.innerHTML = (state.overview?.providers ?? []).map(entry => {
    const on = entry.available && state.selected.has(entry.module);
    const dots = CAPS.map(cap => `<i class="cap ${entry.capabilities.includes(cap) ? "on" : ""}" title="${esc(CAP_LABELS[cap])}${entry.capabilities.includes(cap) ? "" : " (not supported)"}"></i>`).join("");
    const hint = entry.available ? esc(entry.kind)
      : entry.module === "docker" ? "Docker is not running" : `set ${esc(entry.missing.join(" + "))}`;
    return `<li class="provider ${entry.available ? "" : "unavailable"} ${on ? "selected" : ""}" data-module="${esc(entry.module)}">
      <button type="button" class="provider-btn" ${entry.available ? "" : "aria-disabled=\"true\""} aria-pressed="${on}">
        ${logo(entry.module)}
        <span class="provider-text"><span class="provider-name">${esc(entry.title)}</span><span class="provider-hint">${hint}</span></span>
        <span class="toggle" aria-hidden="true"><i></i></span>
      </button>
      <div class="caps">${dots}</div>
      ${entry.available ? "" : `<div class="tip"><b>How to enable ${esc(entry.title)}</b><br>${esc(entry.howToEnable)}</div>`}
    </li>`;
  }).join("");
  renderStats();
}

$("#provider-list").addEventListener("click", event => {
  const item = event.target.closest(".provider");
  if (!item) return;
  const entry = state.byModule.get(item.dataset.module);
  if (!entry?.available) { toast(entry ? entry.howToEnable : "Unknown provider"); return; }
  if (state.selected.has(entry.module)) state.selected.delete(entry.module); else state.selected.add(entry.module);
  saveSelection();
  renderSidebar();
  renderControls();
  if (state.tab === "capabilities") renderResults();
});
$("#select-available").addEventListener("click", () => {
  for (const entry of state.overview?.providers ?? []) if (entry.available) state.selected.add(entry.module);
  saveSelection(); renderSidebar(); renderControls(); if (state.tab === "capabilities") renderResults();
});
$("#select-none").addEventListener("click", () => {
  state.selected.clear(); saveSelection(); renderSidebar(); renderControls(); if (state.tab === "capabilities") renderResults();
});

const selectedAvailable = () => (state.overview?.providers ?? []).filter(entry => entry.available && state.selected.has(entry.module)).map(entry => entry.module);

$("#cleanup-button").addEventListener("click", async () => {
  const button = $("#cleanup-button");
  button.disabled = true;
  button.textContent = "Cleaning up...";
  try {
    const { cleanup } = await post("/api/cleanup");
    const destroyed = Object.values(cleanup).reduce((sum, entry) => sum + entry.destroyed, 0);
    const skipped = Object.values(cleanup).reduce((sum, entry) => sum + entry.skipped, 0);
    const failed = Object.entries(cleanup).filter(([, entry]) => entry.error).map(([module, entry]) => `${titleOf(module)}: ${entry.error}`);
    toast(`Destroyed ${destroyed} sandbox${destroyed === 1 ? "" : "es"}${skipped ? `, kept ${skipped} owned by active runs` : ""}.`, destroyed ? "ok" : "info");
    for (const message of failed) toast(message, "error");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Clean up sandboxes";
    pollStatus();
  }
});

// ---------------------------------------------------------------- tabs and options

function renderTabs() {
  $("#tabs").innerHTML = TABS.map(tab => {
    const view = state.views[tab.id];
    const busy = view && view.status === "running";
    return `<button type="button" role="tab" class="tab ${tab.id === state.tab ? "active" : ""}" data-tab="${tab.id}" aria-selected="${tab.id === state.tab}">
      ${esc(tab.label)}${busy ? `<i class="pulse" title="Running"></i>` : ""}</button>`;
  }).join("");
}

$("#tabs").addEventListener("click", event => {
  const tab = event.target.closest(".tab")?.dataset.tab;
  if (!tab || tab === state.tab) return;
  state.tab = tab;
  localStorage.setItem("osb.tab", tab);
  renderAll();
});

const number = (name, label, value, min, max, step = 1, suffix = "") => `<label class="field"><span>${esc(label)}</span>
  <span class="input-wrap"><input type="number" name="${name}" value="${esc(value)}" min="${min}" max="${max}" step="${step}">${suffix ? `<em>${esc(suffix)}</em>` : ""}</span></label>`;

function renderOptions() {
  const o = state.options[state.tab];
  const tab = TABS.find(entry => entry.id === state.tab);
  let html = "";
  if (state.tab === "speed") {
    html = number("rounds", "Exec round trips", o.rounds, 1, 50)
      + number("fileMiB", "File size", o.fileMiB, 1, 16, 1, "MiB")
      + `<label class="check"><input type="checkbox" name="pause" ${o.pause ? "checked" : ""}><span>Pause and resume (when supported)</span></label>`;
  } else if (state.tab === "stream") {
    html = number("durationS", "Duration", o.durationS, 5, 120, 1, "s")
      + number("intervalMs", "Line every", o.intervalMs, 50, 2000, 50, "ms")
      + number("pollMs", "Poll every", o.pollMs, 100, 5000, 50, "ms");
  } else if (state.tab === "agent") {
    const claude = state.overview?.claude;
    const models = claude?.models ?? [];
    const tasks = state.overview?.tasks ?? [];
    const chosen = new Set(o.tasks ?? tasks.map(task => task.id));
    const model = models.find(entry => entry.id === o.model);
    html = `<label class="field"><span>Model</span><select name="model">${models.map(entry => `<option value="${esc(entry.id)}" ${entry.id === o.model ? "selected" : ""}>${esc(entry.id)} ($${entry.price.input}/$${entry.price.output} per MTok)</option>`).join("")}</select></label>
      <label class="field"><span>Effort</span><select name="effort">${(claude?.efforts ?? []).map(effort => `<option ${effort === o.effort ? "selected" : ""}>${esc(effort)}</option>`).join("")}</select></label>
      ${number("maxTurns", "Max turns", o.maxTurns, 1, 25)}
      ${number("timeLimitMin", "Time limit", o.timeLimitMin, 1, 10, 1, "min")}
      <fieldset class="tasks"><legend>Tasks</legend>${tasks.map(task => `<label class="check"><input type="checkbox" name="task" value="${esc(task.id)}" ${chosen.has(task.id) ? "checked" : ""}><span>${esc(task.title)}</span></label>`).join("")}</fieldset>
      <p class="note">${model?.fallback ? `Refusal fallback is on for this model (<code>fallbacks: "default"</code>): a declined request is retried on Anthropic's recommended fallback model.` : "No server-side refusal fallback for this model."} Limits apply to each task: at most ${esc(o.maxTurns)} turns and ${esc(o.timeLimitMin)} min.</p>
      ${claude?.available ? "" : `<p class="banner warn">No Claude credentials found. Set <code>ANTHROPIC_API_KEY</code> (or run <code>ant auth login</code>) and restart the playground to enable this test.</p>`}`;
  } else if (state.tab === "load") {
    const providers = selectedAvailable().length || 1;
    html = `<label class="field slider"><span>Sandboxes per provider <b id="n-value">${esc(o.n)}</b></span>
      <input type="range" name="n" min="1" max="${state.overview?.limits.maxLoad ?? 20}" value="${esc(o.n)}"></label>
      <p class="banner warn">This creates <b>${esc(o.n)}</b> real sandboxes per provider (${esc(o.n * providers)} in total) at the same time. Cloud providers bill for them; all are destroyed at the end.</p>`;
  } else {
    html = `<p class="note">Capability marks come from each provider's code. Quick verify creates one real sandbox per provider and checks create, exec, write and read, list by label and destroy.</p>`;
  }
  $("#options").innerHTML = `<p class="blurb">${esc(tab.blurb)}</p><div class="fields">${html}</div>`;
}

$("#options").addEventListener("input", event => {
  const input = event.target;
  const o = state.options[state.tab];
  if (input.name === "task") {
    o.tasks = [...document.querySelectorAll("#options input[name=task]:checked")].map(node => node.value);
  } else if (input.type === "checkbox") {
    o[input.name] = input.checked;
  } else if (input.type === "number" || input.type === "range") {
    if (input.value === "") return;
    o[input.name] = Math.min(Number(input.max), Math.max(Number(input.min), Number(input.value)));
  } else {
    o[input.name] = input.value;
  }
  saveOptions();
  if (state.tab === "load" && input.name === "n") {
    $("#n-value").textContent = o.n;
    const providers = selectedAvailable().length || 1;
    $("#options .banner").innerHTML = `This creates <b>${esc(o.n)}</b> real sandboxes per provider (${esc(o.n * providers)} in total) at the same time. Cloud providers bill for them; all are destroyed at the end.`;
  }
  if (state.tab === "agent" && input.name === "model") renderOptions();
  renderControls();
});

// ---------------------------------------------------------------- run controls

function renderControls() {
  const view = state.views[state.tab];
  const running = view?.status === "running";
  const run = $("#run-button"), cancel = $("#cancel-button");
  const providers = selectedAvailable();
  let blocked = providers.length === 0 ? "Select at least one available provider" : "";
  if (state.tab === "agent" && !state.overview?.claude.available) blocked = "No Claude credentials";
  if (state.tab === "agent" && (state.options.agent.tasks?.length === 0)) blocked = "Pick at least one task";
  run.textContent = state.tab === "capabilities" ? "Quick verify" : running ? "Running..." : "Run";
  run.disabled = running || Boolean(blocked);
  run.title = blocked;
  cancel.hidden = !running;
  const status = view ? `${view.status === "running" ? "Running" : view.status[0].toUpperCase() + view.status.slice(1)} · ${view.runId}` : blocked;
  $("#run-state").innerHTML = view ? `<span class="pill ${esc(view.status)}">${esc(status)}</span>` : `<span class="muted">${esc(blocked)}</span>`;
  renderStats();
}

function confirmDialog(title, html, ok = "Start") {
  const dialog = $("#confirm");
  $("#confirm-title").textContent = title;
  $("#confirm-body").innerHTML = html;
  $("#confirm-ok").textContent = ok;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise(done => dialog.addEventListener("close", () => done(dialog.returnValue === "ok"), { once: true }));
}

$("#run-button").addEventListener("click", async () => {
  const test = state.tab;
  const providers = selectedAvailable();
  const options = { ...state.options[test] };
  if (test === "agent") {
    const tasks = options.tasks ?? state.overview.tasks.map(task => task.id);
    options.tasks = tasks;
    const model = state.overview.claude.models.find(entry => entry.id === options.model);
    const runs = providers.length * tasks.length;
    const estimate = runs * (model?.estimatePerTaskUsd ?? 0);
    const ok = await confirmDialog("Start the agent test?", `
      <p>This runs <b>${providers.length} provider${providers.length === 1 ? "" : "s"} x ${tasks.length} task${tasks.length === 1 ? "" : "s"} = ${runs} agent run${runs === 1 ? "" : "s"}</b> with <code>${esc(options.model)}</code> at effort <code>${esc(options.effort)}</code>, each in a fresh sandbox.</p>
      <p class="big">About <b>${esc(fmt(estimate, "$"))}</b> in Claude API usage</p>
      <p class="fine">A rough estimate (about 60k input and 6k output tokens per task, no cache discount). Real costs show in the results. Each task stops after ${esc(options.maxTurns)} turns or ${esc(options.timeLimitMin)} minutes.${model?.fallback ? " Refusal fallback is on." : ""}</p>`, "Spend and start");
    if (!ok) return;
  }
  if (test === "load" && providers.some(module => module !== "docker")) {
    const ok = await confirmDialog("Start the load test?", `<p>This creates <b>${options.n * providers.length}</b> real sandboxes at once (${options.n} on each of ${providers.map(titleOf).map(esc).join(", ")}). Cloud providers bill for them; every one is destroyed when the run ends or is cancelled.</p>`);
    if (!ok) return;
  }
  try {
    const { runId } = await post("/api/runs", { test, providers, options });
    openView({ id: runId, test, providers, options, status: "running", startedAt: new Date().toISOString() });
  } catch (error) {
    toast(error.message, "error");
  }
});

$("#cancel-button").addEventListener("click", async () => {
  const view = state.views[state.tab];
  if (!view) return;
  try {
    await post(`/api/runs/${encodeURIComponent(view.runId)}/cancel`);
    toast("Cancelling: sandboxes are being destroyed");
  } catch (error) {
    toast(error.message, "error");
  }
});

// ---------------------------------------------------------------- views and events

function newProviderState() {
  return { status: "queued", logs: [], metrics: {}, lines: [], lags: [], transcript: [], tasks: {}, checks: {} };
}

function openView(summary) {
  const old = state.views[summary.test];
  old?.source?.close();
  const view = {
    runId: summary.id, test: summary.test, providers: summary.providers, options: summary.options,
    status: summary.status, startedAt: summary.startedAt, logs: [], p: {}, results: summary.results ?? {},
  };
  for (const module of view.providers) view.p[module] = newProviderState();
  state.views[summary.test] = view;
  state.tab = summary.test;
  localStorage.setItem("osb.tab", summary.test);
  renderAll();
  const source = new EventSource(`/api/runs/${encodeURIComponent(view.runId)}/events`);
  view.source = source;
  source.onmessage = message => {
    const event = JSON.parse(message.data);
    apply(view, event);
    if (event.type === "done") { source.close(); view.source = null; }
  };
  source.onerror = () => { if (view.status !== "running") source.close(); };
}

const shown = view => state.views[state.tab] === view;

function apply(view, event) {
  const p = event.provider ? (view.p[event.provider] ??= newProviderState()) : null;
  switch (event.type) {
    case "status":
      p.status = event.status; p.ms = event.ms;
      break;
    case "error":
      if (p) p.error = event; else view.error = event;
      break;
    case "log":
      (p ? p.logs : view.logs).push(event);
      if (p && p.logs.length > 200) p.logs.splice(0, p.logs.length - 200);
      break;
    case "metric":
      if (!p) break;
      if (event.name === "lag") p.lag = event;
      else if (event.name === "clock") p.clock = event;
      else if (event.name === "load") p.load = event;
      else if (event.name === "check") p.checks[event.check] = event;
      else p.metrics[event.name] = event.value;
      break;
    case "output":
      if (event.kind === "lines") {
        p.lines.push(...event.lines);
        p.lags.push(...event.lines.map(line => line.lagMs));
        if (p.lines.length > 1000) p.lines.splice(0, p.lines.length - 1000);
        if (shown(view)) appendLines(event.provider, event.lines);
      } else if (event.kind === "link") p.link = event;
      else if (event.kind === "desktop") p.desktop = event;
      break;
    case "agent":
      if (event.kind === "task_done") p.tasks[event.task] = event.result;
      if (event.kind !== "task_done") {
        p.transcript.push(event);
        if (p.transcript.length > 800) p.transcript.splice(0, p.transcript.length - 800);
        if (shown(view)) appendTranscript(event.provider, event);
      }
      break;
    case "done":
      view.status = event.status;
      view.results = event.results ?? {};
      renderTabs();
      refreshHistory();
      pollStatus();
      break;
  }
  schedule(view);
}

let frame = 0;
function schedule(view) {
  if (!shown(view) || frame) return;
  frame = requestAnimationFrame(() => { frame = 0; updateView(view); renderControls(); });
}

// ---------------------------------------------------------------- results area

function renderResults() {
  const view = state.views[state.tab];
  const root = $("#results");
  if (state.tab === "capabilities") { root.innerHTML = capabilitiesMatrix(view); return; }
  if (!view) {
    const tab = TABS.find(entry => entry.id === state.tab);
    root.innerHTML = `<div class="empty"><div class="empty-art" aria-hidden="true"></div><h3>${esc(tab.label)}</h3><p>${esc(tab.blurb)}</p><p class="muted">Pick providers on the left and press Run. Each provider gets its own column.</p></div>`;
    return;
  }
  root.innerHTML = `<div class="summary" id="summary"></div>
    <div class="columns">${view.providers.map(module => column(view, module)).join("")}</div>`;
  for (const module of view.providers) {
    if (view.test === "stream") appendLines(module, view.p[module].lines, true);
    if (view.test === "agent") for (const event of view.p[module].transcript) appendTranscript(module, event);
  }
  updateView(view);
}

function column(view, module) {
  const pane = view.test === "stream" ? `<div class="terminal" data-pane="${esc(module)}"></div>`
    : view.test === "agent" ? `<div class="transcript" data-pane="${esc(module)}"></div>` : "";
  return `<article class="col" data-col="${esc(module)}" style="--c:${colorOf(module)}">
    <header class="col-head">${logo(module, 30)}<div><h3>${esc(titleOf(module))}</h3><span class="col-sub" data-slot="sub"></span></div><span data-slot="status"></span></header>
    <div data-slot="body"></div>
    ${pane}
    <div class="col-logs" data-slot="logs"></div>
  </article>`;
}

function slot(module, name) {
  return document.querySelector(`[data-col="${CSS.escape(module)}"] [data-slot="${name}"]`);
}

function updateView(view) {
  if (!shown(view)) return;
  if (state.tab === "capabilities") { $("#results").innerHTML = capabilitiesMatrix(view); return; }
  const summary = $("#summary");
  if (!summary) return;
  summary.innerHTML = (view.error ? `<p class="banner error">${esc(view.error.message)}</p>` : "") + (SUMMARIES[view.test]?.(view) ?? "");
  for (const module of view.providers) {
    const p = view.p[module];
    const status = slot(module, "status");
    if (!status) continue;
    status.innerHTML = `<span class="pill ${esc(p.status)}">${esc(p.status)}${p.ms ? ` · ${esc(fmt(p.ms, "ms"))}` : ""}</span>`;
    slot(module, "sub").textContent = state.byModule.get(module)?.kind ?? "";
    slot(module, "body").innerHTML = (p.error ? `<div class="err"><b>${esc(p.error.kind)}</b> ${esc(p.error.message)}</div>` : "") + (BODIES[view.test]?.(view, module, p) ?? "");
    const logs = p.logs.slice(-6);
    slot(module, "logs").innerHTML = logs.map(entry => `<div class="log ${esc(entry.level)}">${esc(entry.message)}</div>`).join("");
  }
}

const winnerOf = (values, better) => {
  const finite = values.filter(entry => Number.isFinite(entry.value));
  if (finite.length < 2) return null;
  return finite.reduce((best, entry) => (better === "higher" ? entry.value > best.value : entry.value < best.value) ? entry : best).module;
};

const card = (title, content, extra = "") => `<div class="card ${extra}"><h4>${title}</h4>${content}</div>`;

// Speed ----------------------------------------------------------------------

function speedSummary(view) {
  const metrics = SPEED_METRICS.filter(metric => view.providers.some(module => Number.isFinite(view.p[module].metrics[metric.key])));
  if (!metrics.length) return `<p class="muted pad">Waiting for the first measurements...</p>`;
  const charts = metrics.map(metric => {
    const values = view.providers.map(module => ({ module, value: view.p[module].metrics[metric.key] }));
    const winner = winnerOf(values, metric.better);
    const rows = values.map(({ module, value }) => ({
      label: titleOf(module), value, p95: metric.p95 ? view.p[module].metrics[metric.p95] : undefined, color: colorOf(module), winner: module === winner,
      note: metric.key.startsWith("pause") || metric.key.startsWith("resume") ? (state.byModule.get(module)?.capabilities.includes("pause") ? "pending" : "no pause") : "pending",
    }));
    return card(`${esc(metric.label)} <span class="hint">${metric.better === "lower" ? "lower is better" : "higher is better"}</span>`, barChart({ rows, unit: metric.unit }));
  }).join("");
  const table = `<table class="table"><thead><tr><th>Metric</th>${view.providers.map(module => `<th>${logo(module, 18)} ${esc(titleOf(module))}</th>`).join("")}</tr></thead><tbody>
    ${SPEED_METRICS.map(metric => {
      const values = view.providers.map(module => ({ module, value: view.p[module].metrics[metric.key] }));
      const winner = winnerOf(values, metric.better);
      return `<tr><td>${esc(metric.label)}</td>${values.map(({ module, value }) => {
        const p95 = metric.p95 ? view.p[module].metrics[metric.p95] : undefined;
        return `<td class="${module === winner ? "winner" : ""}">${Number.isFinite(value) ? esc(fmt(value, metric.unit)) + (Number.isFinite(p95) ? ` <span class="muted">/ ${esc(fmt(p95, metric.unit))}</span>` : "") : `<span class="muted">-</span>`}${module === winner ? ` <span class="badge">best</span>` : ""}</td>`;
      }).join("")}</tr>`;
    }).join("")}</tbody></table>`;
  return `<div class="grid charts">${charts}</div>${card("Results", table, "wide")}`;
}

function speedBody(view, module, p) {
  return `<dl class="kv">${SPEED_METRICS.map(metric => {
    const value = p.metrics[metric.key];
    if (!Number.isFinite(value)) return "";
    const p95 = metric.p95 ? p.metrics[metric.p95] : undefined;
    return `<dt>${esc(metric.label)}</dt><dd>${esc(fmt(value, metric.unit))}${Number.isFinite(p95) ? ` <span class="muted">/ ${esc(fmt(p95, metric.unit))}</span>` : ""}</dd>`;
  }).join("")}</dl>`;
}

// Stream ---------------------------------------------------------------------

function streamSummary(view) {
  const rows = view.providers.map(module => {
    const lag = view.p[module].lag;
    return { label: titleOf(module), value: lag?.p50, p95: lag?.p95, color: colorOf(module), note: view.p[module].status === "done" && !lag ? "skipped" : "waiting" };
  });
  const winner = winnerOf(view.providers.map(module => ({ module, value: view.p[module].lag?.p50 })), "lower");
  rows.forEach((row, i) => { row.winner = view.providers[i] === winner; });
  return `<div class="grid charts">${card(`Delivery lag p50 / p95 <span class="hint">line written to line shown, lower is better</span>`, barChart({ rows, unit: "ms" }))}</div>`;
}

function streamBody(view, module, p) {
  const lag = p.lag;
  const pct = lag ? Math.round((lag.received / lag.expected) * 100) : 0;
  const links = [
    p.link ? `<a class="btn small" href="${esc(safeUrl(p.link.url))}" target="_blank" rel="noopener noreferrer">Open port ${esc(p.link.port)}</a>` : "",
    p.desktop ? `<a class="btn small" href="${esc(safeUrl(p.desktop.url))}" target="_blank" rel="noopener noreferrer">Open desktop</a>` : "",
  ].join("");
  return `<div class="metrics-row">
      <div class="metric"><span>lag p50</span><b class="${lagClass(lag?.p50)}">${esc(fmt(lag?.p50, "ms"))}</b></div>
      <div class="metric"><span>lag p95</span><b class="${lagClass(lag?.p95)}">${esc(fmt(lag?.p95, "ms"))}</b></div>
      <div class="metric"><span>lines</span><b>${lag ? `${lag.received}/${lag.expected}` : "-"}</b></div>
    </div>
    <div class="progress"><i style="width:${pct}%"></i></div>
    ${sparkline(p.lags.slice(-150), colorOf(module))}
    ${links ? `<div class="links">${links}</div>` : ""}`;
}

/** "12 1795230680996 line 12 of 75" becomes "19:10:42.996  line 12 of 75" (the sandbox's own timestamp). */
const lineText = text => {
  const match = /^\d+ (\d{13}) (.*)$/.exec(text);
  if (!match) return text;
  const at = new Date(Number(match[1]));
  return `${at.toTimeString().slice(0, 8)}.${String(at.getMilliseconds()).padStart(3, "0")}  ${match[2]}`;
};
const lagClass = ms => !Number.isFinite(ms) ? "" : ms < 600 ? "good" : ms < 1500 ? "warn" : "bad";
const safeUrl = url => { try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "#"; } catch { return "#"; } };

function appendLines(module, lines, reset = false) {
  const pane = document.querySelector(`[data-pane="${CSS.escape(module)}"]`);
  if (!pane) return;
  if (reset) pane.innerHTML = "";
  const stick = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 24;
  const html = lines.map(line => `<div class="tl"><span class="tl-n">${esc(line.n)}</span><span class="tl-t">${esc(lineText(line.text))}</span><span class="tl-lag ${lagClass(line.lagMs)}">${esc(fmt(line.lagMs, "ms"))}</span></div>`).join("");
  pane.insertAdjacentHTML("beforeend", html);
  while (pane.childElementCount > 1000) pane.firstElementChild.remove();
  if (stick || reset) pane.scrollTop = pane.scrollHeight;
}

// Agent ----------------------------------------------------------------------

function agentSummary(view) {
  const tasks = state.overview?.tasks ?? [];
  const ran = (view.options?.tasks ?? tasks.map(task => task.id)).map(id => tasks.find(task => task.id === id) ?? { id, title: id });
  let total = 0;
  const rows = view.providers.flatMap(module => ran.map(task => {
    const r = view.p[module].tasks[task.id];
    total += r?.costUsd ?? 0;
    const cell = r === undefined ? `<td colspan="8" class="muted">${view.p[module].status === "running" ? "pending" : "-"}</td>`
      : r.error ? `<td><span class="badge bad">fail</span></td><td>${esc(fmt(r.wallMs, "ms"))}</td><td colspan="6" class="muted">${esc(r.error.kind)}: ${esc(r.error.message)}</td>`
      : `<td><span class="badge ${r.passed ? "good" : "bad"}">${r.passed ? "pass" : "fail"}</span>${r.stop && r.stop !== "end_turn" ? ` <span class="muted" title="${esc(r.stopMessage ?? "")}">${esc(r.stop)}</span>` : ""}${r.fallbackUsed ? ` <span class="badge warn" title="A fallback model answered at least one turn">fallback</span>` : ""}</td>
         <td>${esc(fmt(r.wallMs, "ms"))}</td>
         <td>${timeSplit(r.modelMs, r.toolMs)}</td>
         <td>${esc(r.turns)}</td><td>${esc(r.toolCalls)}</td>
         <td>${esc(r.tokens.input.toLocaleString())} / ${esc(r.tokens.output.toLocaleString())}</td>
         <td>${esc(r.tokens.cacheRead.toLocaleString())} / ${esc(r.tokens.cacheWrite.toLocaleString())}</td>
         <td>${esc(fmt(r.costUsd, "$"))}</td>`;
    return `<tr><td>${logo(module, 18)} ${esc(titleOf(module))}</td><td>${esc(task.title)}</td>${cell}</tr>`;
  })).join("");
  const passRows = view.providers.map(module => {
    const results = Object.values(view.p[module].tasks);
    return { label: titleOf(module), value: results.length ? results.filter(r => r.passed).length / ran.length : NaN, color: colorOf(module), note: "pending" };
  });
  const winner = winnerOf(view.providers.map((module, i) => ({ module, value: passRows[i].value })), "higher");
  passRows.forEach((row, i) => { row.winner = view.providers[i] === winner; });
  return `<div class="grid charts">${card(`Tasks passed <span class="hint">model ${esc(view.options?.model)} · effort ${esc(view.options?.effort)}</span>`, barChart({ rows: passRows, unit: "%" }))}
    ${card("Spent so far", `<p class="big-number">${esc(fmt(total, "$"))}</p><p class="fine">Estimated from token usage at list prices.</p>`)}</div>
    ${card("Results", `<table class="table"><thead><tr><th>Provider</th><th>Task</th><th>Result</th><th>Wall</th><th>Model / sandbox time</th><th>Turns</th><th>Tool calls</th><th>Tokens in / out</th><th>Cache read / write</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table>`, "wide")}`;
}

const timeSplit = (model, tool) => {
  const total = (model || 0) + (tool || 0) || 1;
  return `<span class="split" title="model ${esc(fmt(model, "ms"))}, sandbox ${esc(fmt(tool, "ms"))}"><i style="width:${(model / total) * 100}%"></i></span> ${esc(fmt(model, "ms"))} / ${esc(fmt(tool, "ms"))}`;
};

function agentBody(view, module, p) {
  const results = Object.values(p.tasks);
  const passed = results.filter(r => r.passed).length;
  const cost = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  return `<div class="metrics-row">
    <div class="metric"><span>passed</span><b>${passed}/${(view.options?.tasks ?? []).length || results.length}</b></div>
    <div class="metric"><span>tool calls</span><b>${results.reduce((sum, r) => sum + (r.toolCalls ?? 0), 0)}</b></div>
    <div class="metric"><span>cost</span><b>${esc(fmt(cost, "$"))}</b></div>
  </div>`;
}

function describeCall(name, input) {
  try {
    const value = JSON.parse(input);
    if (name === "run_command") return `${value.cwd ? `[${value.cwd}] ` : ""}${value.command}`;
    if (name === "write_file") return `${value.path} (${(value.content ?? "").length} chars)`;
  } catch { /* truncated input: show it raw */ }
  return input;
}

function appendTranscript(module, event) {
  const pane = document.querySelector(`[data-pane="${CSS.escape(module)}"]`);
  if (!pane) return;
  const stick = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 24;
  let html = "";
  switch (event.kind) {
    case "task_start": html = `<div class="tx-task">${esc(event.title)}</div>`; break;
    case "turn": html = `<div class="tx-turn">turn ${esc(event.turn)} · ${esc(fmt(event.ms, "ms"))} · ${esc(event.stopReason ?? "")}${event.model ? ` · ${esc(event.model)}` : ""}</div>`; break;
    case "text": html = `<div class="tx-text">${esc(event.text)}</div>`; break;
    case "fallback": html = `<div class="tx-note warn">${esc(event.from)} declined; ${esc(event.to)} continued</div>`; break;
    case "tool_call": html = `<div class="tx-call"><span class="tx-tool">${esc(event.name)}</span><code>${esc(describeCall(event.name, event.input))}</code></div>`; break;
    case "tool_result": html = `<details class="tx-result ${event.isError ? "err" : ""}"><summary>${event.isError ? "error" : "result"} · ${esc(fmt(event.ms, "ms"))}</summary><pre>${esc(event.content)}</pre></details>`; break;
    case "stop": html = `<div class="tx-note ${event.reason === "end_turn" ? "" : "warn"}">stopped: ${esc(event.reason)}${event.message ? ` (${esc(event.message)})` : ""}</div>`; break;
    case "verify": html = `<details class="tx-verify ${event.passed ? "good" : "bad"}"><summary>verify ${event.passed ? "passed" : `failed (exit ${esc(event.exitCode)})`}</summary><pre>${esc(event.output)}</pre></details>`; break;
    default: return;
  }
  pane.insertAdjacentHTML("beforeend", html);
  while (pane.childElementCount > 800) pane.firstElementChild.remove();
  if (stick) pane.scrollTop = pane.scrollHeight;
}

// Load -----------------------------------------------------------------------

function loadSummary(view) {
  const series = (pick, unit, better) => {
    const values = view.providers.map(module => ({ module, value: pick(view.p[module].load), p95: unit === "ms" ? pick(view.p[module].load, "p95") : undefined }));
    const winner = winnerOf(values, better);
    return barChart({ rows: values.map(({ module, value, p95 }) => ({ label: titleOf(module), value, p95, color: colorOf(module), winner: module === winner, note: "waiting" })), unit });
  };
  const stat = key => (load, which = "p50") => load && load[key].n ? load[key][which] : NaN;
  return `<div class="grid charts">
    ${card(`Success rate <span class="hint">higher is better</span>`, series(load => load && load.done ? load.ok / load.n : NaN, "%", "higher"))}
    ${card(`Create to ready p50 / p95`, series(stat("ready"), "ms", "lower"))}
    ${card(`End to end p50 / p95 <span class="hint">create, wait, exec, destroy</span>`, series(stat("total"), "ms", "lower"))}
  </div>`;
}

function loadBody(view, module, p) {
  const load = p.load;
  if (!load) return `<p class="muted">Starting ${esc(view.options?.n ?? "")} sandboxes...</p>`;
  const errors = Object.entries(load.errors);
  const row = (label, s) => `<tr><td>${label}</td><td>${esc(fmt(s.p50, "ms"))}</td><td>${esc(fmt(s.p95, "ms"))}</td><td>${esc(fmt(s.max, "ms"))}</td></tr>`;
  return `<div class="metrics-row">
      <div class="metric"><span>success</span><b class="${load.ok === load.n ? "good" : load.ok ? "warn" : "bad"}">${load.done ? esc(fmt(load.ok / load.n, "%")) : "-"}</b></div>
      <div class="metric"><span>done</span><b>${load.done}/${load.n}</b></div>
      <div class="metric"><span>failed</span><b>${load.done - load.ok}</b></div>
    </div>
    <div class="progress"><i style="width:${(load.done / load.n) * 100}%"></i></div>
    ${errors.length ? `<div class="chips">${errors.map(([kind, count]) => `<span class="chip bad">${esc(kind)} x ${esc(count)}</span>`).join("")}</div>` : ""}
    <div class="hists"><div><h5>End to end</h5>${histogramChart({ bins: load.totalHistogram, color: colorOf(module) })}</div>
    <div><h5>Create to ready</h5>${histogramChart({ bins: load.readyHistogram, color: colorOf(module) })}</div></div>
    <table class="table compact"><thead><tr><th></th><th>p50</th><th>p95</th><th>max</th></tr></thead><tbody>${row("ready", load.ready)}${row("end to end", load.total)}</tbody></table>`;
}

// Capabilities ---------------------------------------------------------------

function capabilitiesMatrix(view) {
  const modules = view ? view.providers : selectedAvailable().length ? selectedAvailable() : (state.overview?.providers ?? []).map(entry => entry.module);
  const checks = state.overview?.checks ?? Object.keys(CHECK_LABELS);
  const rows = modules.map(module => {
    const entry = state.byModule.get(module);
    const p = view?.p[module];
    const caps = CAPS.map(cap => `<td class="center">${entry?.capabilities.includes(cap) ? `<span class="tick" title="${esc(CAP_LABELS[cap])}">&#10003;</span>` : `<span class="off" title="not supported"></span>`}</td>`).join("");
    const results = checks.map(check => {
      const result = p?.checks[check];
      if (!result) return `<td class="center">${p && p.status === "running" ? `<span class="spinner"></span>` : `<span class="muted">-</span>`}</td>`;
      return `<td class="center"><span class="check-mark ${result.ok ? "good" : "bad"}" title="${esc(result.ok ? fmt(result.ms, "ms") : result.message ?? "failed")}">${result.ok ? "&#10003;" : "&#10005;"}</span></td>`;
    }).join("");
    return `<tr><td class="prov">${logo(module, 20)} ${esc(entry?.title ?? module)}${p?.error ? `<div class="err small">${esc(p.error.message)}</div>` : ""}</td>${caps}<td class="sep"></td>${results}</tr>`;
  }).join("");
  const counts = CAPS.map(cap => `<td class="center muted">${modules.filter(module => state.byModule.get(module)?.capabilities.includes(cap)).length}</td>`).join("");
  return `<div class="card wide">
    <h4>Capability matrix <span class="hint">${view ? `quick verify ${esc(view.status)}` : selectedAvailable().length ? "selected providers" : "all providers (select some to narrow down)"}</span></h4>
    <div class="scroll-x"><table class="table matrix"><thead>
      <tr><th></th><th colspan="${CAPS.length}">Declared capabilities</th><th class="sep"></th><th colspan="${checks.length}">Quick verify (core)</th></tr>
      <tr><th>Provider</th>${CAPS.map(cap => `<th class="center">${esc(CAP_LABELS[cap])}</th>`).join("")}<th class="sep"></th>${checks.map(check => `<th class="center">${esc(CHECK_LABELS[check] ?? check)}</th>`).join("")}</tr>
    </thead><tbody>${rows}</tbody><tfoot><tr><td class="muted">Providers with it</td>${counts}<td class="sep"></td><td colspan="${checks.length}"></td></tr></tfoot></table></div>
    <p class="fine">Every provider also has create, get, list, destroy, exec, readFile and writeFile. Hover a result for its time or error.</p>
  </div>`;
}

const SUMMARIES = { speed: speedSummary, stream: streamSummary, agent: agentSummary, load: loadSummary };
const BODIES = { speed: speedBody, stream: streamBody, agent: agentBody, load: loadBody };

// ---------------------------------------------------------------- history drawer

async function refreshHistory() {
  try {
    const { runs } = await api("/api/runs");
    $("#history").innerHTML = runs.length ? runs.map(run => `<li class="hist">
      <button type="button" class="hist-main" data-run="${esc(run.id)}">
        <span class="hist-top"><b>${esc(TABS.find(tab => tab.id === run.test)?.label ?? run.test)}</b><span class="pill ${esc(run.status)}">${esc(run.status)}</span></span>
        <span class="hist-logos">${run.providers.map(module => logo(module, 18)).join("")}</span>
        <span class="fine">${esc(new Date(run.startedAt).toLocaleString())} · ${esc(run.id)}</span>
      </button>
      <a class="btn small ghost" href="/api/runs/${encodeURIComponent(run.id)}/export" download>Export JSON</a>
    </li>`).join("") : `<li class="muted pad">No runs yet.</li>`;
  } catch (error) {
    $("#history").innerHTML = `<li class="err">${esc(error.message)}</li>`;
  }
}

const drawer = open => {
  $("#drawer").classList.toggle("open", open);
  $("#drawer").setAttribute("aria-hidden", String(!open));
  $("#scrim").hidden = !open;
  if (open) refreshHistory();
};
$("#history-button").addEventListener("click", () => drawer(true));
$("#drawer-close").addEventListener("click", () => drawer(false));
$("#scrim").addEventListener("click", () => drawer(false));
document.addEventListener("keydown", event => { if (event.key === "Escape") drawer(false); });
$("#history").addEventListener("click", async event => {
  const id = event.target.closest("[data-run]")?.dataset.run;
  if (!id) return;
  try {
    openView(await api(`/api/runs/${encodeURIComponent(id)}`));
    drawer(false);
  } catch (error) {
    toast(error.message, "error");
  }
});

// ---------------------------------------------------------------- boot

function renderAll() {
  renderTabs();
  renderOptions();
  renderControls();
  renderResults();
}

async function pollStatus() {
  try {
    const status = await api("/api/status");
    if (state.overview) state.overview.liveSandboxes = status.liveSandboxes;
    renderStats(status.liveSandboxes);
  } catch { /* the server may be restarting */ }
}

async function loadOverview() {
  state.overview = await api("/api/providers");
  state.byModule = new Map(state.overview.providers.map(entry => [entry.module, entry]));
  for (const module of [...state.selected]) if (!state.byModule.get(module)?.available) state.selected.delete(module);
  const o = state.options.agent;
  if (!state.overview.claude.models.some(model => model.id === o.model)) o.model = state.overview.claude.models[0]?.id;
  renderSidebar();
}

try {
  await loadOverview();
  renderAll();
  refreshHistory();
  setInterval(pollStatus, 2500);
  window.addEventListener("focus", () => loadOverview().then(renderControls).catch(() => undefined));
} catch (error) {
  $("#results").innerHTML = `<p class="banner error">Could not reach the playground server: ${esc(error.message)}</p>`;
}
