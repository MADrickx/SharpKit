import * as vscode from "vscode";
import { Project, findProjectForFile, discoverProjects } from "../solution/discovery";

export type ProblemNode = ProjectGroupNode | FileGroupNode | DiagnosticNode;

interface ProjectGroupNode {
  kind: "project";
  projectName: string;
  projectPath: string | undefined;
  files: Map<string, FileGroupNode>;
  errors: number;
  warnings: number;
  infos: number;
  hiddenErrors: number;
  hiddenWarnings: number;
}

interface FileGroupNode {
  kind: "file";
  uri: vscode.Uri;
  project: ProjectGroupNode;
  diagnostics: DiagnosticNode[];
  errors: number;
  warnings: number;
  infos: number;
}

interface DiagnosticNode {
  kind: "diagnostic";
  uri: vscode.Uri;
  diagnostic: vscode.Diagnostic;
}

interface ProjectFilter {
  errors: boolean;
  warnings: boolean;
}

const UNASSIGNED_KEY = "__unassigned__";
const MUTED_PROJECTS_KEY = "sharpkit.problems.mutedProjects";

export class ProblemsTreeProvider implements vscode.TreeDataProvider<ProblemNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ProblemNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private projects: Project[] = [];
  private groups: ProjectGroupNode[] = [];
  private rebuildTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private readonly projectLookupCache = new Map<string, Project | null>();
  private lastRebuildAt = 0;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics(() => this.scheduleRebuild()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("sharpkit.includeWarnings") ||
          e.affectsConfiguration("sharpkit.includeErrors") ||
          e.affectsConfiguration("sharpkit.problems.ignoredWarningCodes")
        ) {
          this.scheduleRebuild();
        }
      }),
    );
    const csprojWatcher = vscode.workspace.createFileSystemWatcher("**/*.csproj");
    this.disposables.push(
      csprojWatcher,
      csprojWatcher.onDidCreate(() => this.reloadProjects()),
      csprojWatcher.onDidDelete(() => this.reloadProjects()),
    );
    const slnWatcher = vscode.workspace.createFileSystemWatcher("**/*.{sln,slnx}");
    this.disposables.push(
      slnWatcher,
      slnWatcher.onDidCreate(() => this.reloadProjects()),
      slnWatcher.onDidDelete(() => this.reloadProjects()),
      slnWatcher.onDidChange(() => this.reloadProjects()),
    );
    this.updateViewFilterContext();
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    this.projects = await discoverProjects();
    this.projectLookupCache.clear();
    this.ready = true;
    this.scheduleRebuild(true);
  }

  private reloadProjects(): void {
    void (async () => {
      this.projects = await discoverProjects();
      this.projectLookupCache.clear();
      this.scheduleRebuild(true);
    })();
  }

  refresh(): void {
    this.reloadProjects();
  }

  getTreeItem(node: ProblemNode): vscode.TreeItem {
    if (node.kind === "project") {
      return this.projectItem(node);
    }
    if (node.kind === "file") {
      return this.fileItem(node);
    }
    return this.diagnosticItem(node);
  }

  getChildren(element?: ProblemNode): ProblemNode[] {
    if (!element) {
      return this.groups;
    }
    if (element.kind === "project") {
      return [...element.files.values()];
    }
    if (element.kind === "file") {
      return element.diagnostics;
    }
    return [];
  }

  async filterView(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("sharpkit");
    const includeErrors = cfg.get<boolean>("includeErrors", true);
    const includeWarnings = cfg.get<boolean>("includeWarnings", true);
    const picked = await vscode.window.showQuickPick(
      [
        { label: "Show errors", picked: includeErrors, key: "errors" },
        { label: "Show warnings", picked: includeWarnings, key: "warnings" },
      ],
      {
        canPickMany: true,
        title: "SharpKit Problems — show",
        placeHolder: "Toggle severities shown in the view",
      },
    );
    if (!picked) {
      return;
    }
    const nextErrors = picked.some((p) => p.key === "errors");
    const nextWarnings = picked.some((p) => p.key === "warnings");
    await Promise.all([
      safeUpdateConfig(cfg, "includeErrors", nextErrors),
      safeUpdateConfig(cfg, "includeWarnings", nextWarnings),
    ]);
  }

  async filterProject(node: ProblemNode | undefined): Promise<void> {
    if (!node || node.kind !== "project") {
      return;
    }
    const key = node.projectPath ?? UNASSIGNED_KEY;
    const current = this.getProjectFilter(key);
    const picked = await vscode.window.showQuickPick(
      [
        { label: "Show errors", picked: current.errors, key: "errors" },
        { label: "Show warnings", picked: current.warnings, key: "warnings" },
      ],
      {
        canPickMany: true,
        title: `SharpKit — ${node.projectName}`,
        placeHolder: "Toggle severities shown for this project",
      },
    );
    if (!picked) {
      return;
    }
    const next: ProjectFilter = {
      errors: picked.some((p) => p.key === "errors"),
      warnings: picked.some((p) => p.key === "warnings"),
    };
    await this.setProjectFilter(key, next);
    this.scheduleRebuild();
  }

  async ignoreWarningCode(node: ProblemNode | undefined): Promise<void> {
    if (!node || node.kind !== "diagnostic") {
      return;
    }
    if (node.diagnostic.severity !== vscode.DiagnosticSeverity.Warning) {
      return;
    }
    const code = diagnosticCode(node.diagnostic);
    if (!code) {
      await vscode.window.showInformationMessage("This warning has no code to ignore.");
      return;
    }
    const cfg = vscode.workspace.getConfiguration("sharpkit");
    const existing = cfg.get<string[]>("problems.ignoredWarningCodes", []);
    if (existing.includes(code)) {
      await vscode.window.showInformationMessage(`${code} is already ignored globally.`);
      return;
    }
    await cfg.update(
      "problems.ignoredWarningCodes",
      [...existing, code],
      vscode.ConfigurationTarget.Global,
    );
    await vscode.window.showInformationMessage(`Ignoring warning ${code} globally.`);
  }

  async manageIgnoredWarnings(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("sharpkit");
    const existing = cfg.get<string[]>("problems.ignoredWarningCodes", []);
    if (existing.length === 0) {
      await vscode.window.showInformationMessage(
        "No warning codes are ignored globally. Right-click a warning to ignore its code.",
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      existing.map((code) => ({ label: code, picked: true })),
      {
        canPickMany: true,
        title: "SharpKit — Ignored Warning Codes",
        placeHolder: "Unselect a code to stop ignoring it",
      },
    );
    if (!picked) {
      return;
    }
    const next = picked.map((p) => p.label);
    if (next.length === existing.length) {
      return;
    }
    await cfg.update(
      "problems.ignoredWarningCodes",
      next,
      vscode.ConfigurationTarget.Global,
    );
  }

  private scheduleRebuild(force = false): void {
    if (!this.ready && !force) {
      return;
    }
    const now = Date.now();
    const sinceLast = now - this.lastRebuildAt;
    const cooldown = 120;
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = undefined;
    }
    if (sinceLast >= cooldown) {
      this.rebuild();
      return;
    }
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = undefined;
      this.rebuild();
    }, cooldown - sinceLast);
  }

  private lookupProject(fsPath: string): Project | undefined {
    const cached = this.projectLookupCache.get(fsPath);
    if (cached !== undefined) {
      return cached ?? undefined;
    }
    const found = findProjectForFile(fsPath, this.projects);
    this.projectLookupCache.set(fsPath, found ?? null);
    return found;
  }

  private rebuild(): void {
    this.lastRebuildAt = Date.now();
    this.updateViewFilterContext();
    const cfg = vscode.workspace.getConfiguration("sharpkit");
    const includeErrors = cfg.get<boolean>("includeErrors", true);
    const includeWarnings = cfg.get<boolean>("includeWarnings", true);
    const ignoredCodes = new Set(cfg.get<string[]>("problems.ignoredWarningCodes", []));
    const groups = new Map<string, ProjectGroupNode>();
    const unassigned: ProjectGroupNode = {
      kind: "project",
      projectName: "Unassigned",
      projectPath: undefined,
      files: new Map(),
      errors: 0,
      warnings: 0,
      infos: 0,
      hiddenErrors: 0,
      hiddenWarnings: 0,
    };

    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      const project = this.lookupProject(uri.fsPath);
      const groupKey = project?.csprojPath ?? UNASSIGNED_KEY;
      const projectFilter = this.getProjectFilter(groupKey);

      const kept: vscode.Diagnostic[] = [];
      let hiddenErrors = 0;
      let hiddenWarnings = 0;

      for (const d of diagnostics) {
        if (d.severity === vscode.DiagnosticSeverity.Error) {
          if (!includeErrors || !projectFilter.errors) {
            hiddenErrors += 1;
            continue;
          }
          kept.push(d);
        } else if (d.severity === vscode.DiagnosticSeverity.Warning) {
          if (!includeWarnings || !projectFilter.warnings) {
            hiddenWarnings += 1;
            continue;
          }
          const code = diagnosticCode(d);
          if (code && ignoredCodes.has(code)) {
            hiddenWarnings += 1;
            continue;
          }
          kept.push(d);
        }
      }

      if (kept.length === 0 && hiddenErrors === 0 && hiddenWarnings === 0) {
        continue;
      }

      let group = groups.get(groupKey);
      if (!group) {
        group = project
          ? {
              kind: "project",
              projectName: project.name,
              projectPath: project.csprojPath,
              files: new Map(),
              errors: 0,
              warnings: 0,
              infos: 0,
              hiddenErrors: 0,
              hiddenWarnings: 0,
            }
          : unassigned;
        groups.set(groupKey, group);
      }

      group.hiddenErrors += hiddenErrors;
      group.hiddenWarnings += hiddenWarnings;

      if (kept.length === 0) {
        continue;
      }

      let fileNode = group.files.get(uri.fsPath);
      if (!fileNode) {
        fileNode = {
          kind: "file",
          uri,
          project: group,
          diagnostics: [],
          errors: 0,
          warnings: 0,
          infos: 0,
        };
        group.files.set(uri.fsPath, fileNode);
      }

      for (const d of kept) {
        fileNode.diagnostics.push({ kind: "diagnostic", uri, diagnostic: d });
        bumpSeverity(fileNode, d.severity);
        bumpSeverity(group, d.severity);
      }
    }

    this.groups = [...groups.values()]
      .sort((a, b) => {
        if ((b.errors > 0 ? 1 : 0) !== (a.errors > 0 ? 1 : 0)) {
          return (b.errors > 0 ? 1 : 0) - (a.errors > 0 ? 1 : 0);
        }
        return a.projectName.localeCompare(b.projectName);
      });
    this.changeEmitter.fire(undefined);
  }

  private getProjectFilter(key: string): ProjectFilter {
    const stored = this.context.globalState.get<Record<string, ProjectFilter>>(MUTED_PROJECTS_KEY, {});
    const entry = stored[key];
    return {
      errors: entry?.errors ?? true,
      warnings: entry?.warnings ?? true,
    };
  }

  private async setProjectFilter(key: string, value: ProjectFilter): Promise<void> {
    const stored = {
      ...this.context.globalState.get<Record<string, ProjectFilter>>(MUTED_PROJECTS_KEY, {}),
    };
    if (value.errors && value.warnings) {
      delete stored[key];
    } else {
      stored[key] = value;
    }
    await this.context.globalState.update(MUTED_PROJECTS_KEY, stored);
  }

  private updateViewFilterContext(): void {
    const cfg = vscode.workspace.getConfiguration("sharpkit");
    const includeErrors = cfg.get<boolean>("includeErrors", true);
    const includeWarnings = cfg.get<boolean>("includeWarnings", true);
    const ignoredCodes = cfg.get<string[]>("problems.ignoredWarningCodes", []);
    const hasFilter = !includeErrors || !includeWarnings || ignoredCodes.length > 0;
    void vscode.commands.executeCommand("setContext", "sharpkit.problems.hasViewFilter", hasFilter);
  }

  private projectItem(node: ProjectGroupNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.projectName, vscode.TreeItemCollapsibleState.Expanded);
    item.description = formatCounts(node);
    item.iconPath = node.errors > 0
      ? new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"))
      : node.warnings > 0
      ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("editorWarning.foreground"))
      : new vscode.ThemeIcon("pass");
    const key = node.projectPath ?? UNASSIGNED_KEY;
    const filter = this.getProjectFilter(key);
    const filterState = filter.errors && filter.warnings ? "filter-off" : "filter-on";
    item.contextValue = `problemProject:${filterState}`;
    if (node.hiddenErrors > 0 || node.hiddenWarnings > 0) {
      const hiddenBits: string[] = [];
      if (node.hiddenErrors > 0) {
        hiddenBits.push(`${node.hiddenErrors} error${node.hiddenErrors === 1 ? "" : "s"}`);
      }
      if (node.hiddenWarnings > 0) {
        hiddenBits.push(`${node.hiddenWarnings} warning${node.hiddenWarnings === 1 ? "" : "s"}`);
      }
      item.tooltip = `${hiddenBits.join(", ")} hidden by SharpKit filters`;
    }
    return item;
  }

  private fileItem(node: FileGroupNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.uri, vscode.TreeItemCollapsibleState.Collapsed);
    item.description = formatCounts(node);
    item.resourceUri = node.uri;
    item.contextValue = "problemFile";
    return item;
  }

  private diagnosticItem(node: DiagnosticNode): vscode.TreeItem {
    const { diagnostic, uri } = node;
    const line = diagnostic.range.start.line + 1;
    const col = diagnostic.range.start.character + 1;
    const code = diagnosticCode(diagnostic);
    const label = `${code ? `${code}: ` : ""}${diagnostic.message}`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = `[${line}:${col}]`;
    item.tooltip = diagnostic.message;
    item.iconPath = severityIcon(diagnostic.severity);
    const sev = diagnostic.severity === vscode.DiagnosticSeverity.Warning ? "warning" : "error";
    item.contextValue = `diagnostic:${sev}:${code ?? "none"}`;
    item.command = {
      command: "sharpkit.openDiagnostic",
      title: "Open",
      arguments: [uri, diagnostic.range],
    };
    return item;
  }

  dispose(): void {
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
    }
    this.disposables.forEach((d) => d.dispose());
    this.changeEmitter.dispose();
  }
}

function bumpSeverity(target: { errors: number; warnings: number; infos: number }, sev: vscode.DiagnosticSeverity): void {
  if (sev === vscode.DiagnosticSeverity.Error) {
    target.errors += 1;
  } else if (sev === vscode.DiagnosticSeverity.Warning) {
    target.warnings += 1;
  } else {
    target.infos += 1;
  }
}

function formatCounts(target: { errors: number; warnings: number; hiddenErrors?: number; hiddenWarnings?: number }): string {
  const parts: string[] = [];
  if (target.errors > 0) {
    parts.push(`${target.errors} error${target.errors === 1 ? "" : "s"}`);
  }
  if (target.warnings > 0) {
    parts.push(`${target.warnings} warning${target.warnings === 1 ? "" : "s"}`);
  }
  const hiddenTotal = (target.hiddenErrors ?? 0) + (target.hiddenWarnings ?? 0);
  if (hiddenTotal > 0) {
    parts.push(`${hiddenTotal} hidden`);
  }
  return parts.join(", ") || "clean";
}

function severityIcon(sev: vscode.DiagnosticSeverity): vscode.ThemeIcon {
  switch (sev) {
    case vscode.DiagnosticSeverity.Error:
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
    case vscode.DiagnosticSeverity.Warning:
      return new vscode.ThemeIcon("warning", new vscode.ThemeColor("editorWarning.foreground"));
    case vscode.DiagnosticSeverity.Information:
      return new vscode.ThemeIcon("info");
    default:
      return new vscode.ThemeIcon("circle-small");
  }
}

async function safeUpdateConfig(
  cfg: vscode.WorkspaceConfiguration,
  key: string,
  value: unknown,
): Promise<void> {
  const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  const targets: vscode.ConfigurationTarget[] = hasWorkspace
    ? [vscode.ConfigurationTarget.Workspace, vscode.ConfigurationTarget.Global]
    : [vscode.ConfigurationTarget.Global];
  let lastErr: unknown;
  for (const target of targets) {
    try {
      await cfg.update(key, value, target);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  void vscode.window.showWarningMessage(`SharpKit: could not save sharpkit.${key}: ${msg}`);
}

function diagnosticCode(d: vscode.Diagnostic): string | undefined {
  if (typeof d.code === "string" || typeof d.code === "number") {
    return String(d.code);
  }
  if (d.code && typeof d.code === "object" && "value" in d.code) {
    return String((d.code as { value: string | number }).value);
  }
  return undefined;
}
