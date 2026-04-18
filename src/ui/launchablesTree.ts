import * as path from "path";
import * as vscode from "vscode";
import { Project, LaunchProfile, discoverWorkspace } from "../solution/discovery";
import { Solution } from "../solution/slnParser";
import { SessionManager, SessionState } from "../launch/session";
import { log } from "../services/logger";

export type LaunchableNode = SolutionNode | ProjectNode | ProfileNode;

export interface SolutionNode {
  kind: "solution";
  solution: Solution;
  projects: Project[];
  launchableCount: number;
}

export interface ProjectNode {
  kind: "project";
  project: Project;
}

export interface ProfileNode {
  kind: "profile";
  project: Project;
  profile: LaunchProfile;
}

interface WorkspaceSnapshot {
  solutionNodes: SolutionNode[];
  looseProjects: Project[];
}

export class LaunchablesTreeProvider implements vscode.TreeDataProvider<LaunchableNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<LaunchableNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private snapshotPromise: Promise<WorkspaceSnapshot> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly sessions: SessionManager) {
    this.disposables.push(
      this.sessions.onDidChangeState(() => this.changeEmitter.fire(undefined)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
    );
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.{sln,slnx,csproj}");
    watcher.onDidCreate(() => this.refresh());
    watcher.onDidDelete(() => this.refresh());
    watcher.onDidChange(() => this.refresh());
    this.disposables.push(watcher);
  }

  refresh(): void {
    this.snapshotPromise = undefined;
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(node: LaunchableNode): vscode.TreeItem {
    switch (node.kind) {
      case "solution":
        return this.solutionItem(node);
      case "project":
        return this.projectItem(node.project);
      case "profile":
        return this.profileItem(node);
    }
  }

  async getChildren(element?: LaunchableNode): Promise<LaunchableNode[]> {
    const snapshot = await this.loadSnapshot();

    if (!element) {
      const roots: LaunchableNode[] = [...snapshot.solutionNodes];
      for (const project of snapshot.looseProjects) {
        roots.push({ kind: "project", project });
      }
      return roots;
    }

    if (element.kind === "solution") {
      return element.projects.map<ProjectNode>((project) => ({ kind: "project", project }));
    }

    if (element.kind === "project" && element.project.launchProfiles.length > 1) {
      return element.project.launchProfiles.map<ProfileNode>((profile) => ({
        kind: "profile",
        project: element.project,
        profile,
      }));
    }

    return [];
  }

  private async loadSnapshot(): Promise<WorkspaceSnapshot> {
    if (!this.snapshotPromise) {
      this.snapshotPromise = this.buildSnapshot();
    }
    return this.snapshotPromise;
  }

  private async buildSnapshot(): Promise<WorkspaceSnapshot> {
    const { solutions, projects } = await discoverWorkspace();

    const projectsBySolution = new Map<string, Project[]>();
    const looseProjects: Project[] = [];
    for (const project of projects) {
      if (project.solutionPath) {
        const list = projectsBySolution.get(project.solutionPath) ?? [];
        list.push(project);
        projectsBySolution.set(project.solutionPath, list);
      } else {
        looseProjects.push(project);
      }
    }

    const solutionNodes: SolutionNode[] = solutions
      .map((solution) => {
        const solutionProjects = sortProjects(projectsBySolution.get(solution.path) ?? []);
        return {
          kind: "solution" as const,
          solution,
          projects: solutionProjects,
          launchableCount: solutionProjects.filter((p) => p.isLaunchable).length,
        };
      })
      .sort((a, b) => a.solution.path.localeCompare(b.solution.path));

    const totalLaunchable = projects.filter((p) => p.isLaunchable).length;
    log.info(`Workspace: ${solutions.length} solution(s), ${projects.length} project(s), ${totalLaunchable} launchable`);

    return { solutionNodes, looseProjects: sortProjects(looseProjects) };
  }

  private solutionItem(node: SolutionNode): vscode.TreeItem {
    const name = path.basename(node.solution.path);
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Expanded);
    item.description = formatSolutionDescription(node);
    item.tooltip = node.solution.path;
    item.iconPath = new vscode.ThemeIcon("project");
    item.contextValue = "solution";
    item.resourceUri = vscode.Uri.file(node.solution.path);
    return item;
  }

  private projectItem(project: Project): vscode.TreeItem {
    const state = this.sessions.getState(project.csprojPath);
    const hasProfileChildren = project.launchProfiles.length > 1;
    const collapsible = hasProfileChildren
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(project.name, collapsible);
    item.description = formatProjectDescription(project);
    item.tooltip = `${project.csprojPath}\nOutput: ${project.outputType}\nState: ${state}`;
    item.iconPath = iconForProject(project, state);
    item.contextValue = projectContextValue(project, state);
    item.resourceUri = vscode.Uri.file(project.csprojPath);
    return item;
  }

  private profileItem(node: ProfileNode): vscode.TreeItem {
    const state = this.sessions.getState(node.project.csprojPath);
    const item = new vscode.TreeItem(node.profile.name, vscode.TreeItemCollapsibleState.None);
    item.description = node.profile.commandName ?? "";
    item.iconPath = new vscode.ThemeIcon("rocket");
    item.contextValue = node.project.isLaunchable ? `profile:${state}` : "profile:library";
    item.tooltip = node.profile.applicationUrl ?? node.profile.name;
    return item;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.changeEmitter.dispose();
  }
}

function sortProjects(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => {
    if (a.isLaunchable !== b.isLaunchable) {
      return a.isLaunchable ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

function formatSolutionDescription(node: SolutionNode): string {
  const total = node.projects.length;
  const parts = [`${total} project${total === 1 ? "" : "s"}`];
  if (node.launchableCount > 0) {
    parts.push(`${node.launchableCount} launchable`);
  }
  return parts.join(" · ");
}

function formatProjectDescription(project: Project): string {
  const tfm = project.targetFrameworks.join(", ");
  const kind = project.isTestProject ? "tests" : project.isLaunchable ? "" : "library";
  if (!kind) {
    return tfm;
  }
  return tfm ? `${tfm} · ${kind}` : kind;
}

function projectContextValue(project: Project, state: SessionState): string {
  if (project.isTestProject) {
    return `project:test:${state}`;
  }
  if (!project.isLaunchable) {
    return "project:library";
  }
  return `project:${state}`;
}

function iconForProject(project: Project, state: SessionState): vscode.ThemeIcon {
  if (state === "testing") {
    return new vscode.ThemeIcon("beaker", new vscode.ThemeColor("charts.purple"));
  }
  if (state === "watching") {
    return new vscode.ThemeIcon("eye", new vscode.ThemeColor("charts.blue"));
  }
  if (project.isTestProject) {
    return new vscode.ThemeIcon("beaker");
  }
  if (!project.isLaunchable) {
    return new vscode.ThemeIcon("library", new vscode.ThemeColor("descriptionForeground"));
  }
  switch (state) {
    case "running":
      return new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("charts.green"));
    case "debugging":
      return new vscode.ThemeIcon("debug-alt", new vscode.ThemeColor("debugIcon.startForeground"));
    case "paused":
      return new vscode.ThemeIcon("debug-pause", new vscode.ThemeColor("debugIcon.pauseForeground"));
    default:
      return new vscode.ThemeIcon("rocket");
  }
}
