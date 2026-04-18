import * as path from "path";
import * as vscode from "vscode";
import { EfProject, discoverEfProjects } from "../migrations/efDiscovery";
import { discoverProjects } from "../solution/discovery";

export type MigrationNode = EfProjectNode | DbContextNode | EmptyNode;

export interface EfProjectNode {
  kind: "ef-project";
  ef: EfProject;
}

export interface DbContextNode {
  kind: "db-context";
  ef: EfProject;
  dbContext: string;
}

export interface EmptyNode {
  kind: "empty";
  message: string;
}

export class MigrationsTreeProvider implements vscode.TreeDataProvider<MigrationNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<MigrationNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private efProjectsPromise: Promise<EfProject[]> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.{csproj,cs}");
    watcher.onDidCreate(() => this.refresh());
    watcher.onDidDelete(() => this.refresh());
    this.disposables.push(watcher);
  }

  refresh(): void {
    this.efProjectsPromise = undefined;
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(node: MigrationNode): vscode.TreeItem {
    switch (node.kind) {
      case "ef-project":
        return this.projectItem(node);
      case "db-context":
        return this.contextItem(node);
      case "empty":
        return this.emptyItem(node);
    }
  }

  async getChildren(element?: MigrationNode): Promise<MigrationNode[]> {
    if (!element) {
      const efProjects = await this.load();
      if (efProjects.length === 0) {
        return [{ kind: "empty", message: "No EF Core projects detected." }];
      }
      return efProjects.map<EfProjectNode>((ef) => ({ kind: "ef-project", ef }));
    }
    if (element.kind === "ef-project") {
      if (element.ef.dbContexts.length === 0) {
        return [{ kind: "empty", message: "No DbContext detected." }];
      }
      return element.ef.dbContexts.map<DbContextNode>((dbContext) => ({
        kind: "db-context",
        ef: element.ef,
        dbContext,
      }));
    }
    return [];
  }

  private async load(): Promise<EfProject[]> {
    if (!this.efProjectsPromise) {
      this.efProjectsPromise = (async () => {
        const projects = await discoverProjects();
        return discoverEfProjects(projects);
      })();
    }
    return this.efProjectsPromise;
  }

  private projectItem(node: EfProjectNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.ef.project.name, vscode.TreeItemCollapsibleState.Expanded);
    const contextCount = node.ef.dbContexts.length;
    const rel = path.relative(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
      node.ef.project.csprojPath,
    );
    item.description = contextCount > 0 ? `${contextCount} DbContext${contextCount === 1 ? "" : "s"}` : rel;
    item.tooltip = `${node.ef.project.csprojPath}\n${contextCount} DbContext(s) detected`;
    item.iconPath = new vscode.ThemeIcon("database");
    item.contextValue = "efProject";
    item.resourceUri = vscode.Uri.file(node.ef.project.csprojPath);
    return item;
  }

  private contextItem(node: DbContextNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.dbContext, vscode.TreeItemCollapsibleState.None);
    item.description = node.ef.project.name;
    item.iconPath = new vscode.ThemeIcon("table");
    item.contextValue = "dbcontext";
    item.tooltip = `DbContext: ${node.dbContext}\nProject: ${node.ef.project.csprojPath}`;
    return item;
  }

  private emptyItem(node: EmptyNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon("info");
    item.contextValue = "empty";
    return item;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.changeEmitter.dispose();
  }
}
