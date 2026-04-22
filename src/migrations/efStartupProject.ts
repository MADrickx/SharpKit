import * as path from "path";
import * as vscode from "vscode";
import { Project, discoverProjects } from "../solution/discovery";
import { EfProject } from "./efDiscovery";

const STATE_PREFIX = "sharpkit.ef.startupProject:";
const CONFIG_KEY = "ef.startupProjects";
export const SAME_AS_MIGRATION = "__same_as_migration__";

export interface StartupResolution {
  startup: Project;
  source: "config" | "cache" | "auto" | "user";
}

export async function resolveStartupProject(
  ef: EfProject,
  state: vscode.Memento,
  options: { forcePrompt?: boolean } = {},
): Promise<StartupResolution | undefined> {
  const projects = await discoverProjects();
  const byPath = new Map(projects.map((p) => [normalize(p.csprojPath), p]));

  if (!options.forcePrompt) {
    const fromConfig = resolveFromConfig(ef, byPath);
    if (fromConfig) {
      return { startup: fromConfig, source: "config" };
    }
    const cached = resolveFromCache(ef, state, byPath);
    if (cached) {
      return { startup: cached, source: "cache" };
    }
  }

  const candidates = buildCandidates(projects);
  if (!options.forcePrompt && candidates.auto) {
    await persist(ef, candidates.auto, state);
    return { startup: candidates.auto, source: "auto" };
  }

  const picked = await promptUser(ef, candidates.list);
  if (!picked) {
    return undefined;
  }
  await persist(ef, picked, state);
  return { startup: picked, source: "user" };
}

export function getCachedStartupProjectPath(
  ef: EfProject,
  state: vscode.Memento,
): string | undefined {
  return state.get<string>(`${STATE_PREFIX}${normalize(ef.project.csprojPath)}`);
}

export async function clearCachedStartupProject(
  ef: EfProject,
  state: vscode.Memento,
): Promise<void> {
  await state.update(`${STATE_PREFIX}${normalize(ef.project.csprojPath)}`, undefined);
}

function resolveFromConfig(
  ef: EfProject,
  byPath: Map<string, Project>,
): Project | undefined {
  const map = vscode.workspace
    .getConfiguration("sharpkit")
    .get<Record<string, string>>(CONFIG_KEY);
  if (!map) {
    return undefined;
  }
  const migKey = workspaceRelative(ef.project.csprojPath);
  const entry = findConfigEntry(map, ef.project.csprojPath, migKey);
  if (!entry) {
    return undefined;
  }
  if (entry === SAME_AS_MIGRATION) {
    return ef.project;
  }
  const absolute = resolveToAbsolute(entry);
  if (!absolute) {
    return undefined;
  }
  return byPath.get(normalize(absolute));
}

function findConfigEntry(
  map: Record<string, string>,
  absolute: string,
  relative: string,
): string | undefined {
  if (map[relative]) {
    return map[relative];
  }
  if (map[absolute]) {
    return map[absolute];
  }
  const normalizedAbs = normalize(absolute);
  const normalizedRel = normalize(relative);
  for (const [k, v] of Object.entries(map)) {
    if (normalize(k) === normalizedAbs || normalize(k) === normalizedRel) {
      return v;
    }
  }
  return undefined;
}

function resolveFromCache(
  ef: EfProject,
  state: vscode.Memento,
  byPath: Map<string, Project>,
): Project | undefined {
  const cached = getCachedStartupProjectPath(ef, state);
  if (!cached) {
    return undefined;
  }
  if (cached === SAME_AS_MIGRATION) {
    return ef.project;
  }
  return byPath.get(normalize(cached));
}

function buildCandidates(projects: Project[]): {
  auto?: Project;
  list: Project[];
} {
  const launchable = projects.filter((p) => p.isLaunchable);
  const list = launchable.length > 0 ? launchable : projects;
  if (list.length === 1) {
    return { auto: list[0], list };
  }
  return { list };
}

async function promptUser(ef: EfProject, candidates: Project[]): Promise<Project | undefined> {
  type Item = vscode.QuickPickItem & { project: Project };
  const items: Item[] = candidates.map((p) => ({
    label: p.name,
    description: workspaceRelative(p.csprojPath),
    detail: p.isLaunchable ? "$(play) launchable" : undefined,
    project: p,
  }));
  const migrationInList = candidates.some((p) => p.csprojPath === ef.project.csprojPath);
  if (!migrationInList) {
    items.unshift({
      label: "$(debug-alt) Same as migration project",
      description: ef.project.name,
      detail: "Use the DAL project itself as startup (requires IDesignTimeDbContextFactory)",
      project: ef.project,
    });
  }
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `Select the startup project for ${ef.project.name}`,
    matchOnDescription: true,
  });
  return pick?.project;
}

async function persist(
  ef: EfProject,
  startup: Project,
  state: vscode.Memento,
): Promise<void> {
  const value =
    startup.csprojPath === ef.project.csprojPath ? SAME_AS_MIGRATION : normalize(startup.csprojPath);
  await state.update(`${STATE_PREFIX}${normalize(ef.project.csprojPath)}`, value);
}

function normalize(p: string): string {
  return path.normalize(p).replace(/\\/g, "/");
}

function workspaceRelative(absolute: string): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return absolute;
  }
  const rel = path.relative(root, absolute);
  return rel.replace(/\\/g, "/");
}

function resolveToAbsolute(p: string): string | undefined {
  if (path.isAbsolute(p)) {
    return p;
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return undefined;
  }
  return path.resolve(root, p);
}
