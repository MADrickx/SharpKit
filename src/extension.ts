import * as path from "path";
import * as vscode from "vscode";
import { initLogger, log, showError } from "./services/logger";
import { LaunchablesTreeProvider, LaunchableNode } from "./ui/launchablesTree";
import { ProblemsTreeProvider } from "./ui/problemsTree";
import { MigrationsTreeProvider, MigrationNode } from "./ui/migrationsTree";
import { SessionManager } from "./launch/session";
import { Project, LaunchProfile } from "./solution/discovery";
import { Solution } from "./solution/slnParser";
import { build, rebuild, clean, restore, publish, BuildTarget } from "./actions/build";
import { attachToDotnetProcess } from "./launch/attach";
import { openLaunchSettingsEditor } from "./ui/launchSettingsWebview";
import {
  addMigration,
  updateDatabase,
  removeLastMigration,
  changeStartupProject,
  PartialEfTarget,
} from "./migrations/efCommands";

export function activate(context: vscode.ExtensionContext): void {
  initLogger(context);
  log.info("SharpKit activating");

  const sessions = new SessionManager();
  context.subscriptions.push(sessions);

  const launchables = new LaunchablesTreeProvider(sessions);
  context.subscriptions.push(launchables);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("sharpkit.launchables", launchables),
  );

  const problems = new ProblemsTreeProvider(context);
  context.subscriptions.push(problems);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("sharpkit.problems", problems),
  );

  const migrations = new MigrationsTreeProvider(context.workspaceState);
  context.subscriptions.push(migrations);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("sharpkit.migrations", migrations),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("sharpkit.refresh", () => {
      launchables.refresh();
      problems.refresh();
    }),
    vscode.commands.registerCommand("sharpkit.migrations.refresh", () => migrations.refresh()),

    vscode.commands.registerCommand("sharpkit.run", async (node: LaunchableNode) => {
      const target = resolveTarget(node);
      if (target) {
        await sessions.run(target.project, target.profile);
      }
    }),
    vscode.commands.registerCommand("sharpkit.debug", async (node: LaunchableNode) => {
      const target = resolveTarget(node);
      if (target) {
        await sessions.debug(target.project, target.profile);
      }
    }),
    vscode.commands.registerCommand("sharpkit.watch", async (node: LaunchableNode) => {
      const target = resolveTarget(node);
      if (target) {
        await sessions.watch(target.project, target.profile);
      }
    }),
    vscode.commands.registerCommand("sharpkit.stop", async (node: LaunchableNode) => {
      const target = resolveTarget(node);
      if (target) {
        await sessions.stop(target.project);
      }
    }),
    vscode.commands.registerCommand("sharpkit.pause", async (node: LaunchableNode) => {
      const target = resolveTarget(node);
      if (target) {
        await sessions.pause(target.project);
      }
    }),
    vscode.commands.registerCommand("sharpkit.continue", async (node: LaunchableNode) => {
      const target = resolveTarget(node);
      if (target) {
        await sessions.continueExecution(target.project);
      }
    }),
    vscode.commands.registerCommand("sharpkit.runTests", async (node: LaunchableNode) => {
      const target = resolveTarget(node);
      if (target) {
        await sessions.runTests(target.project);
      }
    }),
    vscode.commands.registerCommand("sharpkit.debugTests", async (node: LaunchableNode) => {
      const target = resolveTarget(node);
      if (target) {
        await sessions.debugTests(target.project);
      }
    }),

    vscode.commands.registerCommand("sharpkit.build", (node: LaunchableNode) => runBuildAction(node, build)),
    vscode.commands.registerCommand("sharpkit.rebuild", (node: LaunchableNode) => runBuildAction(node, rebuild)),
    vscode.commands.registerCommand("sharpkit.clean", (node: LaunchableNode) => runBuildAction(node, clean)),
    vscode.commands.registerCommand("sharpkit.restore", (node: LaunchableNode) => runBuildAction(node, restore)),
    vscode.commands.registerCommand("sharpkit.publish", async (node: LaunchableNode) => {
      const target = resolveBuildTarget(node);
      if (!target) {
        return;
      }
      const outputDir = await pickPublishOutputDir(target, context.workspaceState);
      if (outputDir === undefined) {
        return;
      }
      await publish(target, outputDir || undefined);
    }),

    vscode.commands.registerCommand("sharpkit.attach", () => attachToDotnetProcess()),

    vscode.commands.registerCommand("sharpkit.editLaunchSettings", async (node: LaunchableNode) => {
      const target = resolveTarget(node);
      if (target) {
        await openLaunchSettingsEditor(target.project);
      }
    }),

    vscode.commands.registerCommand("sharpkit.ef.addMigration", async (node: MigrationNode) => {
      const target = resolveEfTarget(node);
      if (target) {
        await addMigration(target, context.workspaceState);
        migrations.refresh();
      }
    }),
    vscode.commands.registerCommand("sharpkit.ef.updateDatabase", async (node: MigrationNode) => {
      const target = resolveEfTarget(node);
      if (target) {
        await updateDatabase(target, context.workspaceState);
      }
    }),
    vscode.commands.registerCommand("sharpkit.ef.removeLastMigration", async (node: MigrationNode) => {
      const target = resolveEfTarget(node);
      if (target) {
        await removeLastMigration(target, context.workspaceState);
        migrations.refresh();
      }
    }),
    vscode.commands.registerCommand("sharpkit.ef.changeStartupProject", async (node: MigrationNode) => {
      const target = resolveEfTarget(node);
      if (target) {
        await changeStartupProject(target, context.workspaceState);
        migrations.refresh();
      }
    }),

    vscode.commands.registerCommand(
      "sharpkit.openDiagnostic",
      async (uri: vscode.Uri, range: vscode.Range) => {
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { selection: range });
        } catch (err) {
          await showError(`Failed to open ${uri.fsPath}`, err);
        }
      },
    ),

    vscode.commands.registerCommand("sharpkit.problems.filter", () => problems.filterView()),
    vscode.commands.registerCommand("sharpkit.problems.filterActive", () => problems.filterView()),
    vscode.commands.registerCommand("sharpkit.problems.filterProject", (node) => problems.filterProject(node)),
    vscode.commands.registerCommand("sharpkit.problems.filterProjectActive", (node) => problems.filterProject(node)),
    vscode.commands.registerCommand("sharpkit.problems.ignoreWarningCode", (node) => problems.ignoreWarningCode(node)),
    vscode.commands.registerCommand("sharpkit.problems.manageIgnoredWarnings", () => problems.manageIgnoredWarnings()),
  );

  log.info("SharpKit activated");
}

export function deactivate(): void {
  log.info("SharpKit deactivating");
}

async function runBuildAction(
  node: LaunchableNode | undefined,
  action: (target: BuildTarget) => Promise<number | undefined>,
): Promise<void> {
  const target = resolveBuildTarget(node);
  if (!target) {
    return;
  }
  await action(target);
}

function resolveBuildTarget(node: LaunchableNode | undefined): BuildTarget | undefined {
  if (!node) {
    return undefined;
  }
  if (node.kind === "solution") {
    return { kind: "solution", solution: node.solution as Solution };
  }
  if (node.kind === "project") {
    return { kind: "project", project: node.project };
  }
  if (node.kind === "profile") {
    return { kind: "project", project: node.project };
  }
  return undefined;
}

function resolveTarget(node: LaunchableNode | undefined):
  | { project: Project; profile?: LaunchProfile }
  | undefined {
  if (!node) {
    return undefined;
  }
  if (node.kind === "solution") {
    return undefined;
  }
  if (node.kind === "project") {
    const preferred = preferredProfile(node.project);
    return { project: node.project, profile: preferred };
  }
  return { project: node.project, profile: node.profile };
}

function preferredProfile(project: Project): LaunchProfile | undefined {
  if (project.launchProfiles.length === 0) {
    return undefined;
  }
  const configured = vscode.workspace
    .getConfiguration("sharpkit")
    .get<string>("defaultLaunchProfile", "");
  if (configured) {
    const match = project.launchProfiles.find((p) => p.name === configured);
    if (match) {
      return match;
    }
  }
  return project.launchProfiles[0];
}

const PUBLISH_DIRS_KEY = "sharpkit.publish.dirs";
const PUBLISH_HISTORY_LIMIT = 10;

function publishTargetKey(target: BuildTarget): string {
  return target.kind === "solution" ? `sln:${target.solution.path}` : `proj:${target.project.csprojPath}`;
}

function publishTargetCwd(target: BuildTarget): string {
  return target.kind === "solution" ? target.solution.directory : target.project.directory;
}

function readPublishDirs(state: vscode.Memento, key: string): string[] {
  const all = state.get<Record<string, string[]>>(PUBLISH_DIRS_KEY, {});
  const list = all[key];
  return Array.isArray(list) ? list.filter((d) => typeof d === "string" && d.length > 0) : [];
}

async function writePublishDirs(state: vscode.Memento, key: string, dirs: string[]): Promise<void> {
  const all = state.get<Record<string, string[]>>(PUBLISH_DIRS_KEY, {});
  const next = { ...all };
  if (dirs.length === 0) {
    delete next[key];
  } else {
    next[key] = dirs.slice(0, PUBLISH_HISTORY_LIMIT);
  }
  await state.update(PUBLISH_DIRS_KEY, next);
}

async function recordPublishDir(state: vscode.Memento, key: string, dir: string): Promise<void> {
  const existing = readPublishDirs(state, key);
  const without = existing.filter((d) => d !== dir);
  await writePublishDirs(state, key, [dir, ...without]);
}

async function pickPublishOutputDir(
  target: BuildTarget,
  state: vscode.Memento,
): Promise<string | undefined> {
  const key = publishTargetKey(target);

  return new Promise<string | undefined>((resolve) => {
    type Item = vscode.QuickPickItem & {
      action: "default" | "saved" | "choose";
      dir?: string;
    };
    const removeButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("trash"),
      tooltip: "Remove from saved destinations",
    };

    const qp = vscode.window.createQuickPick<Item>();
    qp.title = "Publish destination";
    qp.placeholder = "Where should dotnet publish output go?";
    qp.matchOnDescription = true;
    qp.ignoreFocusOut = false;

    const buildItems = (): Item[] => {
      const dirs = readPublishDirs(state, key);
      const items: Item[] = [
        {
          label: "$(home) Default location",
          description: "bin/<configuration>/<tfm>/publish",
          action: "default",
        },
      ];
      for (const dir of dirs) {
        items.push({
          label: `$(folder) ${prettyPath(dir)}`,
          description: dir === dirs[0] ? "last used" : undefined,
          action: "saved",
          dir,
          buttons: [removeButton],
        });
      }
      items.push({
        label: "$(folder-opened) Choose folder…",
        action: "choose",
      });
      return items;
    };

    qp.items = buildItems();

    let resolved = false;
    const finish = (value: string | undefined) => {
      if (resolved) {
        return;
      }
      resolved = true;
      qp.hide();
      resolve(value);
    };

    qp.onDidTriggerItemButton(async (e) => {
      if (e.button !== removeButton || e.item.action !== "saved" || !e.item.dir) {
        return;
      }
      const remaining = readPublishDirs(state, key).filter((d) => d !== e.item.dir);
      await writePublishDirs(state, key, remaining);
      qp.items = buildItems();
    });

    qp.onDidAccept(async () => {
      const picked = qp.activeItems[0];
      if (!picked) {
        return;
      }
      if (picked.action === "default") {
        finish("");
        return;
      }
      if (picked.action === "saved" && picked.dir) {
        await recordPublishDir(state, key, picked.dir);
        finish(picked.dir);
        return;
      }
      qp.hide();
      const lastDir = readPublishDirs(state, key)[0];
      const selection = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Publish here",
        defaultUri: lastDir
          ? vscode.Uri.file(lastDir)
          : vscode.Uri.file(publishTargetCwd(target)),
      });
      if (!selection || selection.length === 0) {
        finish(undefined);
        return;
      }
      const chosen = selection[0].fsPath;
      await recordPublishDir(state, key, chosen);
      finish(chosen);
    });

    qp.onDidHide(() => {
      qp.dispose();
      finish(undefined);
    });

    qp.show();
  });
}

function prettyPath(p: string): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const root = folder.uri.fsPath;
    if (p === root || p.startsWith(root + path.sep)) {
      const rel = path.relative(root, p);
      return rel ? `./${rel}` : "./";
    }
  }
  return p;
}

function resolveEfTarget(node: MigrationNode | undefined): PartialEfTarget | undefined {
  if (!node) {
    return undefined;
  }
  if (node.kind === "db-context") {
    return { ef: node.ef, dbContext: node.dbContext };
  }
  if (node.kind === "ef-project") {
    return { ef: node.ef };
  }
  return undefined;
}
