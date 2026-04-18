import * as vscode from "vscode";
import { EfProject } from "./efDiscovery";
import { buildDotnetTask, ensureDotnetTool, runDotnetTaskAndWait } from "../services/dotnetCli";
import { showError } from "../services/logger";

export interface EfTarget {
  ef: EfProject;
  dbContext: string;
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
      ? "No DbContext detected automatically \u2014 enter one manually"
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

function baseArgs(target: EfTarget, extras: string[]): string[] {
  return [
    "ef",
    ...extras,
    "--project",
    target.ef.project.csprojPath,
    "--startup-project",
    target.ef.project.csprojPath,
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
    cwd: target.ef.project.directory,
    taskType: "sharpkit-ef",
    definition: { project: target.ef.project.csprojPath, context: target.dbContext, action: extras[0] },
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

export async function addMigration(partial: PartialEfTarget): Promise<void> {
  const dbContext = await resolveDbContext(partial);
  if (!dbContext) {
    return;
  }
  const target: EfTarget = { ef: partial.ef, dbContext };
  const name = await vscode.window.showInputBox({
    prompt: `Migration name for ${dbContext}`,
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
    vscode.window.showInformationMessage(`Added migration "${name}" for ${dbContext}.`);
  }
}

export async function updateDatabase(partial: PartialEfTarget): Promise<void> {
  const dbContext = await resolveDbContext(partial);
  if (!dbContext) {
    return;
  }
  const target: EfTarget = { ef: partial.ef, dbContext };
  const migration = await vscode.window.showInputBox({
    prompt: `Target migration for ${dbContext} (leave blank for latest)`,
    placeHolder: "e.g. AddUsersTable or 0 to revert all",
  });
  if (migration === undefined) {
    return;
  }
  const extras = migration.trim() ? ["database", "update", migration.trim()] : ["database", "update"];
  const code = await runEfTask(target, `EF: Update Database ${dbContext}`, extras);
  if (code === 0) {
    vscode.window.showInformationMessage(`Database updated for ${dbContext}.`);
  }
}

export async function removeLastMigration(partial: PartialEfTarget): Promise<void> {
  const dbContext = await resolveDbContext(partial);
  if (!dbContext) {
    return;
  }
  const target: EfTarget = { ef: partial.ef, dbContext };
  const confirm = await vscode.window.showWarningMessage(
    `Remove the last migration for ${dbContext}? This reverts the last migrations add.`,
    { modal: true },
    "Remove",
  );
  if (confirm !== "Remove") {
    return;
  }
  const code = await runEfTask(target, `EF: Remove Last Migration ${dbContext}`, ["migrations", "remove"]);
  if (code === 0) {
    vscode.window.showInformationMessage(`Removed last migration for ${dbContext}.`);
  }
}

export { runDotnetTaskAndWait };
