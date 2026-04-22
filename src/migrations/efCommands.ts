import * as vscode from "vscode";
import { EfProject } from "./efDiscovery";
import { Project } from "../solution/discovery";
import { buildDotnetTask, ensureDotnetTool, runDotnetTaskAndWait } from "../services/dotnetCli";
import { showError } from "../services/logger";
import { resolveStartupProject } from "./efStartupProject";

export interface EfTarget {
  ef: EfProject;
  dbContext: string;
  startupProject: Project;
}

export interface PartialEfTarget {
  ef: EfProject;
  dbContext?: string;
}

async function resolveDbContext(partial: PartialEfTarget): Promise<string | undefined> {
  if (partial.dbContext) {
    return partial.dbContext;
  }
  const detected = partial.ef.dbContexts;
  if (detected.length === 1) {
    return detected[0];
  }
  const MANUAL = "$(edit) Enter name manually...";
  const items: vscode.QuickPickItem[] = [
    ...detected.map((name) => ({ label: name, description: "detected" })),
    { label: MANUAL, description: "Type a DbContext class name" },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: detected.length === 0
      ? "No DbContext detected automatically — enter one manually"
      : "Select a DbContext or enter one manually",
  });
  if (!pick) {
    return undefined;
  }
  if (pick.label !== MANUAL) {
    return pick.label;
  }
  const typed = await vscode.window.showInputBox({
    prompt: "DbContext class name",
    placeHolder: "e.g. ApplicationDbContext",
    validateInput: (value) => (value.trim() ? null : "Cannot be empty."),
  });
  return typed?.trim() || undefined;
}

let efToolVerified = false;

async function ensureEfTool(): Promise<boolean> {
  if (efToolVerified) {
    return true;
  }
  const ok = await ensureDotnetTool(["ef", "--version"], "dotnet-ef", "dotnet-ef");
  if (ok) {
    efToolVerified = true;
  }
  return ok;
}

async function buildTarget(
  partial: PartialEfTarget,
  state: vscode.Memento,
): Promise<EfTarget | undefined> {
  const dbContext = await resolveDbContext(partial);
  if (!dbContext) {
    return undefined;
  }
  const startup = await resolveStartupProject(partial.ef, state);
  if (!startup) {
    return undefined;
  }
  return { ef: partial.ef, dbContext, startupProject: startup.startup };
}

function baseArgs(target: EfTarget, extras: string[]): string[] {
  return [
    "ef",
    ...extras,
    "--project",
    target.ef.project.csprojPath,
    "--startup-project",
    target.startupProject.csprojPath,
    "--context",
    target.dbContext,
  ];
}

async function runEfTask(
  target: EfTarget,
  label: string,
  extras: string[],
): Promise<number | undefined> {
  if (!(await ensureEfTool())) {
    return undefined;
  }
  const task = buildDotnetTask({
    name: label,
    args: baseArgs(target, extras),
    cwd: target.startupProject.directory,
    taskType: "sharpkit-ef",
    definition: {
      project: target.ef.project.csprojPath,
      startupProject: target.startupProject.csprojPath,
      context: target.dbContext,
      action: extras[0],
    },
    problemMatcher: [],
  });
  try {
    const execution = await vscode.tasks.executeTask(task);
    return await new Promise<number | undefined>((resolve) => {
      const disposable = vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution === execution) {
          disposable.dispose();
          resolve(e.exitCode);
        }
      });
    });
  } catch (err) {
    await showError(`dotnet ef ${extras.join(" ")} failed`, err);
    return undefined;
  }
}

export async function addMigration(
  partial: PartialEfTarget,
  state: vscode.Memento,
): Promise<void> {
  const target = await buildTarget(partial, state);
  if (!target) {
    return;
  }
  const name = await vscode.window.showInputBox({
    prompt: `Migration name for ${target.dbContext}`,
    placeHolder: "e.g. AddUsersTable",
    validateInput: (value) => {
      if (!value.trim()) {
        return "Migration name cannot be empty.";
      }
      if (/\s/.test(value)) {
        return "Migration name cannot contain spaces.";
      }
      return null;
    },
  });
  if (!name) {
    return;
  }
  const code = await runEfTask(target, `EF: Add Migration ${name}`, ["migrations", "add", name]);
  if (code === 0) {
    vscode.window.showInformationMessage(`Added migration "${name}" for ${target.dbContext}.`);
  }
}

export async function updateDatabase(
  partial: PartialEfTarget,
  state: vscode.Memento,
): Promise<void> {
  const target = await buildTarget(partial, state);
  if (!target) {
    return;
  }
  const migration = await vscode.window.showInputBox({
    prompt: `Target migration for ${target.dbContext} (leave blank for latest)`,
    placeHolder: "e.g. AddUsersTable or 0 to revert all",
  });
  if (migration === undefined) {
    return;
  }
  const extras = migration.trim() ? ["database", "update", migration.trim()] : ["database", "update"];
  const code = await runEfTask(target, `EF: Update Database ${target.dbContext}`, extras);
  if (code === 0) {
    vscode.window.showInformationMessage(`Database updated for ${target.dbContext}.`);
  }
}

export async function removeLastMigration(
  partial: PartialEfTarget,
  state: vscode.Memento,
): Promise<void> {
  const target = await buildTarget(partial, state);
  if (!target) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Remove the last migration for ${target.dbContext}? This reverts the last migrations add.`,
    { modal: true },
    "Remove",
  );
  if (confirm !== "Remove") {
    return;
  }
  const code = await runEfTask(
    target,
    `EF: Remove Last Migration ${target.dbContext}`,
    ["migrations", "remove"],
  );
  if (code === 0) {
    vscode.window.showInformationMessage(`Removed last migration for ${target.dbContext}.`);
  }
}

export async function changeStartupProject(
  partial: PartialEfTarget,
  state: vscode.Memento,
): Promise<void> {
  const picked = await resolveStartupProject(partial.ef, state, { forcePrompt: true });
  if (picked) {
    vscode.window.showInformationMessage(
      `Startup project for ${partial.ef.project.name}: ${picked.startup.name}`,
    );
  }
}

export { runDotnetTaskAndWait };
