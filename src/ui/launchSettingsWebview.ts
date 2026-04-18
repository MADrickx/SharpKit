import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { Project } from "../solution/discovery";
import { log, showError } from "../services/logger";

interface WebviewProfile {
  name: string;
  commandName?: string;
  applicationUrl?: string;
  workingDirectory?: string;
  environmentVariables?: Record<string, string>;
  [key: string]: unknown;
}

const openEditors = new Map<string, vscode.WebviewPanel>();

export async function openLaunchSettingsEditor(project: Project): Promise<void> {
  const existing = openEditors.get(project.csprojPath);
  if (existing) {
    existing.reveal(vscode.ViewColumn.Active);
    return;
  }

  const settingsPath = path.join(project.directory, "Properties", "launchSettings.json");
  const profiles = await loadProfiles(settingsPath);

  const panel = vscode.window.createWebviewPanel(
    "sharpkit.launchSettings",
    `launchSettings — ${project.name}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  openEditors.set(project.csprojPath, panel);

  const nonce = crypto.randomBytes(16).toString("hex");
  panel.webview.html = renderHtml(panel.webview.cspSource, nonce, profiles);

  panel.onDidDispose(() => {
    openEditors.delete(project.csprojPath);
  });

  panel.webview.onDidReceiveMessage(async (msg: { type: string; profiles?: WebviewProfile[] }) => {
    if (msg.type === "save" && Array.isArray(msg.profiles)) {
      try {
        await saveProfiles(settingsPath, msg.profiles);
        panel.webview.postMessage({ type: "saved" });
        vscode.window.showInformationMessage(`Saved launchSettings for ${project.name}.`);
      } catch (err) {
        await showError(`Failed to save launchSettings for ${project.name}`, err);
        panel.webview.postMessage({ type: "saveError" });
      }
    } else if (msg.type === "revert") {
      const fresh = await loadProfiles(settingsPath);
      panel.webview.postMessage({ type: "load", profiles: fresh });
    }
  });
}

async function loadProfiles(settingsPath: string): Promise<WebviewProfile[]> {
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as { profiles?: Record<string, Omit<WebviewProfile, "name">> };
    if (!parsed.profiles) {
      return [];
    }
    return Object.entries(parsed.profiles).map(([name, p]) => ({ name, ...p }));
  } catch {
    return [];
  }
}

async function saveProfiles(settingsPath: string, profiles: WebviewProfile[]): Promise<void> {
  const propertiesDir = path.dirname(settingsPath);
  await fs.mkdir(propertiesDir, { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    existing = {};
  }

  const profilesOut: Record<string, Omit<WebviewProfile, "name">> = {};
  for (const profile of profiles) {
    if (!profile.name) {
      continue;
    }
    const { name, ...rest } = profile;
    profilesOut[name] = stripEmpty(rest);
  }

  const next = { ...existing, profiles: profilesOut };
  const tmp = `${settingsPath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tmp, settingsPath);
  log.info(`Wrote ${settingsPath} (${profiles.length} profile${profiles.length === 1 ? "" : "s"})`);
}

function stripEmpty<T extends Record<string, unknown>>(obj: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === "" || value === null) {
      continue;
    }
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0) {
      continue;
    }
    result[key] = value;
  }
  return result as T;
}

function renderHtml(cspSource: string, nonce: string, profiles: WebviewProfile[]): string {
  const initial = JSON.stringify(profiles).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
       background: var(--vscode-editor-background); padding: 16px; margin: 0; }
h2 { margin: 0 0 12px 0; font-size: 14px; font-weight: 600; }
.tabs { display: flex; gap: 4px; flex-wrap: wrap; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px; }
.tab { padding: 6px 12px; cursor: pointer; border: 1px solid transparent; border-bottom: none;
       background: transparent; color: var(--vscode-foreground); font-size: 12px; }
.tab.active { background: var(--vscode-tab-activeBackground); border-color: var(--vscode-panel-border); }
.row { display: grid; grid-template-columns: 180px 1fr; gap: 8px; margin-bottom: 8px; align-items: center; }
label { font-size: 12px; color: var(--vscode-descriptionForeground); }
input[type="text"] {
  width: 100%; box-sizing: border-box; padding: 4px 6px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border); font-family: var(--vscode-font-family);
}
button { padding: 4px 10px; background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  border: none; cursor: pointer; font-size: 12px; margin-right: 8px; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.env-grid { display: grid; grid-template-columns: 1fr 2fr 30px; gap: 4px; margin-bottom: 4px; }
.env-grid input { width: 100%; }
.actions { margin-top: 16px; display: flex; gap: 8px; }
.status { color: var(--vscode-descriptionForeground); font-size: 12px; margin-left: 8px; }
.empty { padding: 24px; text-align: center; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let state = { profiles: ${initial}, active: 0, dirty: false, status: "" };

function render() {
  const root = document.getElementById("root");
  if (state.profiles.length === 0) {
    root.innerHTML = \`
      <h2>No profiles yet</h2>
      <div class="empty">No launchSettings.json profiles found for this project.</div>
      <div class="actions">
        <button id="addFirst">Add profile</button>
      </div>
    \`;
    document.getElementById("addFirst").addEventListener("click", addProfile);
    return;
  }

  const active = state.profiles[state.active] || state.profiles[0];
  const tabsHtml = state.profiles.map((p, i) =>
    \`<button class="tab \${i === state.active ? "active" : ""}" data-i="\${i}">\${escapeHtml(p.name || "(unnamed)")}</button>\`
  ).join("");

  const envRows = Object.entries(active.environmentVariables || {}).map(([k, v], i) =>
    \`<div class="env-grid">
      <input type="text" data-env-key="\${i}" value="\${escapeAttr(k)}" />
      <input type="text" data-env-val="\${i}" value="\${escapeAttr(String(v))}" />
      <button class="secondary" data-env-del="\${i}">✕</button>
    </div>\`
  ).join("");

  root.innerHTML = \`
    <div class="tabs">\${tabsHtml}<button class="tab" id="addTab">+ Add</button></div>
    <h2>\${escapeHtml(active.name || "(unnamed)")}</h2>
    <div class="row"><label>Profile name</label><input type="text" id="f-name" value="\${escapeAttr(active.name || "")}"/></div>
    <div class="row"><label>Command name</label><input type="text" id="f-commandName" value="\${escapeAttr(active.commandName || "")}"/></div>
    <div class="row"><label>Application URL</label><input type="text" id="f-applicationUrl" value="\${escapeAttr(active.applicationUrl || "")}"/></div>
    <div class="row"><label>Working directory</label><input type="text" id="f-workingDirectory" value="\${escapeAttr(active.workingDirectory || "")}"/></div>
    <div class="row"><label>Environment variables</label>
      <div>
        \${envRows || ""}
        <button class="secondary" id="addEnv">+ Add variable</button>
      </div>
    </div>
    <div class="actions">
      <button id="save">Save</button>
      <button class="secondary" id="revert">Revert</button>
      <button class="secondary" id="delete">Delete profile</button>
      <span class="status">\${state.dirty ? "Unsaved changes" : state.status}</span>
    </div>
  \`;

  document.querySelectorAll("[data-i]").forEach((el) =>
    el.addEventListener("click", () => { state.active = Number(el.dataset.i); render(); })
  );
  document.getElementById("addTab")?.addEventListener("click", addProfile);
  ["name","commandName","applicationUrl","workingDirectory"].forEach((field) => {
    const el = document.getElementById("f-" + field);
    if (el) el.addEventListener("input", (e) => { active[field] = e.target.value; state.dirty = true; updateStatus(); });
  });
  document.querySelectorAll("[data-env-key]").forEach((el) =>
    el.addEventListener("input", (e) => updateEnv(active, Number(el.dataset.envKey), "key", e.target.value))
  );
  document.querySelectorAll("[data-env-val]").forEach((el) =>
    el.addEventListener("input", (e) => updateEnv(active, Number(el.dataset.envVal), "value", e.target.value))
  );
  document.querySelectorAll("[data-env-del]").forEach((el) =>
    el.addEventListener("click", () => deleteEnv(active, Number(el.dataset.envDel)))
  );
  document.getElementById("addEnv")?.addEventListener("click", () => addEnv(active));
  document.getElementById("save")?.addEventListener("click", () => {
    vscode.postMessage({ type: "save", profiles: state.profiles });
  });
  document.getElementById("revert")?.addEventListener("click", () => {
    vscode.postMessage({ type: "revert" });
  });
  document.getElementById("delete")?.addEventListener("click", () => {
    state.profiles.splice(state.active, 1);
    state.active = Math.max(0, state.active - 1);
    state.dirty = true;
    render();
  });
}

function updateStatus() {
  const status = document.querySelector(".status");
  if (status) status.textContent = state.dirty ? "Unsaved changes" : state.status;
}

function addProfile() {
  state.profiles.push({ name: "New Profile", commandName: "Project", environmentVariables: {} });
  state.active = state.profiles.length - 1;
  state.dirty = true;
  render();
}

function addEnv(active) {
  active.environmentVariables = active.environmentVariables || {};
  const key = "NEW_VAR";
  let n = 1;
  let name = key;
  while (name in active.environmentVariables) { name = key + "_" + (n++); }
  active.environmentVariables[name] = "";
  state.dirty = true;
  render();
}

function updateEnv(active, index, kind, value) {
  const entries = Object.entries(active.environmentVariables || {});
  const [curKey, curVal] = entries[index];
  delete active.environmentVariables[curKey];
  const newKey = kind === "key" ? value : curKey;
  const newVal = kind === "value" ? value : curVal;
  active.environmentVariables[newKey] = newVal;
  state.dirty = true;
  updateStatus();
}

function deleteEnv(active, index) {
  const entries = Object.entries(active.environmentVariables || {});
  const [key] = entries[index];
  delete active.environmentVariables[key];
  state.dirty = true;
  render();
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;" }[c])); }
function escapeAttr(s) { return escapeHtml(s); }

window.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (msg.type === "saved") { state.dirty = false; state.status = "Saved"; updateStatus(); }
  else if (msg.type === "saveError") { state.status = "Save failed"; updateStatus(); }
  else if (msg.type === "load") { state.profiles = msg.profiles || []; state.dirty = false; state.status = "Reverted"; render(); }
});

render();
</script>
</body>
</html>`;
}
