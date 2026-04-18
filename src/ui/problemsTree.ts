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

export class ProblemsTreeProvider implements vscode.TreeDataProvider<ProblemNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ProblemNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private projects: Project[] = [];
  private groups: ProjectGroupNode[] = [];
  private rebuildTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics(() => this.scheduleRebuild()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("sharpkit.includeWarnings")) {
          this.scheduleRebuild();
        }
      }),
    );
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    this.projects = await discoverProjects();
    this.scheduleRebuild();
  }

  refresh(): void {
    void (async () => {
      this.projects = await discoverProjects();
      this.scheduleRebuild();
    })();
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

  private scheduleRebuild(): void {
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
    }
    this.rebuildTimer = setTimeout(() => this.rebuild(), 150);
  }

  private rebuild(): void {
    const includeWarnings = vscode.workspace.getConfiguration("sharpkit").get<boolean>("includeWarnings", true);
    const groups = new Map<string, ProjectGroupNode>();
    const unassigned: ProjectGroupNode = {
      kind: "project",
      projectName: "Unassigned",
      projectPath: undefined,
      files: new Map(),
      errors: 0,
      warnings: 0,
      infos: 0,
    };

    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      const filtered = diagnostics.filter((d) =>
        d.severity === vscode.DiagnosticSeverity.Error ||
        (includeWarnings && d.severity === vscode.DiagnosticSeverity.Warning),
      );
      if (filtered.length === 0) {
        continue;
      }
      const project = findProjectForFile(uri.fsPath, this.projects);
      const groupKey = project?.csprojPath ?? "__unassigned__";
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
            }
          : unassigned;
        groups.set(groupKey, group);
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

      for (const d of filtered) {
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

  private projectItem(node: ProjectGroupNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.projectName, vscode.TreeItemCollapsibleState.Expanded);
    item.description = formatCounts(node);
    item.iconPath = node.errors > 0
      ? new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"))
      : node.warnings > 0
      ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("editorWarning.foreground"))
      : new vscode.ThemeIcon("pass");
    item.contextValue = "problemProject";
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
    const code = typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code;
    const label = `${code ? `${code}: ` : ""}${diagnostic.message}`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = `[${line}:${col}]`;
    item.tooltip = diagnostic.message;
    item.iconPath = severityIcon(diagnostic.severity);
    item.contextValue = "diagnostic";
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

function formatCounts(target: { errors: number; warnings: number }): string {
  const parts: string[] = [];
  if (target.errors > 0) {
    parts.push(`${target.errors} error${target.errors === 1 ? "" : "s"}`);
  }
  if (target.warnings > 0) {
    parts.push(`${target.warnings} warning${target.warnings === 1 ? "" : "s"}`);
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
