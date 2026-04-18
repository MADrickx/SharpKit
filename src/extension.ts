import * as vscode from "vscode";
import { initLogger, log, showError } from "./services/logger";
import { LaunchablesTreeProvider, LaunchableNode } from "./ui/launchablesTree";
import { ProblemsTreeProvider } from "./ui/problemsTree";
import { MigrationsTreeProvider, MigrationNode } from "./ui/migrationsTree";
import { SessionManager } from "./launch/session";
import { Project, LaunchProfile } from "./solution/discovery";
import { Solution } from "./solution/slnParser";
import { build, rebuild, clean, restore, BuildTarget } from "./actions/build";
import { attachToDotnetProcess } from "./launch/attach";
import { openLaunchSettingsEditor } from "./ui/launchSettingsWebview";
import { addMigration, updateDatabase, removeLastMigration, PartialEfTarget } from "./migrations/efCommands";

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

  const problems = new ProblemsTreeProvider();
  context.subscriptions.push(problems);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("sharpkit.problems", problems),
  );

  const migrations = new MigrationsTreeProvider();
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
        await addMigration(target);
        migrations.refresh();
      }
    }),
    vscode.commands.registerCommand("sharpkit.ef.updateDatabase", async (node: MigrationNode) => {
      const target = resolveEfTarget(node);
      if (target) {
        await updateDatabase(target);
      }
    }),
    vscode.commands.registerCommand("sharpkit.ef.removeLastMigration", async (node: MigrationNode) => {
      const target = resolveEfTarget(node);
      if (target) {
        await removeLastMigration(target);
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
