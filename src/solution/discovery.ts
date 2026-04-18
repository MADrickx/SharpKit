import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { log } from "../services/logger";
import { Solution, parseSolutionsSafe } from "./slnParser";

export interface LaunchProfile {
  name: string;
  commandName?: string;
  applicationUrl?: string;
  environmentVariables?: Record<string, string>;
  workingDirectory?: string;
}

export interface Project {
  name: string;
  csprojPath: string;
  directory: string;
  outputType: string;
  targetFrameworks: string[];
  assemblyName: string;
  isLaunchable: boolean;
  isTestProject: boolean;
  packageReferences: string[];
  launchProfiles: LaunchProfile[];
  solutionPath?: string;
}

const CSPROJ_GLOB = "**/*.csproj";
const SLN_GLOB = "**/*.{sln,slnx}";
const EXCLUDE_GLOB = "**/{node_modules,bin,obj}/**";

export interface Discovery {
  solutions: Solution[];
  projects: Project[];
}

export async function discoverWorkspace(): Promise<Discovery> {
  const slnUris = await vscode.workspace.findFiles(SLN_GLOB, EXCLUDE_GLOB);
  const solutions = await parseSolutionsSafe(slnUris.map((u) => u.fsPath));

  const projectToSolution = new Map<string, string>();
  const solutionProjectPaths = new Set<string>();
  for (const sln of solutions) {
    for (const csprojPath of sln.projectPaths) {
      const key = path.normalize(csprojPath);
      solutionProjectPaths.add(key);
      if (!projectToSolution.has(key)) {
        projectToSolution.set(key, sln.path);
      }
    }
  }

  let csprojPaths: string[];
  if (solutionProjectPaths.size > 0) {
    csprojPaths = [...solutionProjectPaths];
    log.info(`Using ${solutions.length} solution(s) as authoritative source (${csprojPaths.length} project(s))`);
  } else {
    const uris = await vscode.workspace.findFiles(CSPROJ_GLOB, EXCLUDE_GLOB);
    csprojPaths = uris.map((u) => path.normalize(u.fsPath));
    log.info(`No solution files found; discovered ${csprojPaths.length} loose csproj(s)`);
  }

  const projects = await Promise.all(
    csprojPaths.map((p) =>
      readProject(p, projectToSolution.get(p)).catch((err) => {
        log.warn(`Failed to read ${p}`, err);
        return undefined;
      }),
    ),
  );

  return {
    solutions,
    projects: projects.filter((p): p is Project => p !== undefined),
  };
}

export async function discoverProjects(): Promise<Project[]> {
  const { projects } = await discoverWorkspace();
  return projects;
}

async function readProject(csprojPath: string, solutionPath?: string): Promise<Project> {
  const xml = await fs.readFile(csprojPath, "utf8");
  const directory = path.dirname(csprojPath);
  const name = path.basename(csprojPath, ".csproj");

  const sdk = readSdk(xml);
  const explicitOutputType = firstTag(xml, "OutputType")?.toLowerCase();
  const outputType = explicitOutputType ?? implicitOutputType(sdk);
  const targetFrameworks = parseTargetFrameworks(xml);
  const assemblyName = firstTag(xml, "AssemblyName") ?? name;
  const packageReferences = parsePackageReferences(xml);

  const launchProfiles = await readLaunchProfiles(directory);

  return {
    name,
    csprojPath,
    directory,
    outputType,
    targetFrameworks,
    assemblyName,
    isLaunchable: outputType === "exe" || outputType === "winexe",
    isTestProject: detectTestProject(packageReferences),
    packageReferences,
    launchProfiles,
    solutionPath,
  };
}

function parsePackageReferences(xml: string): string[] {
  const results: string[] = [];
  const re = /<PackageReference\s+[^>]*Include\s*=\s*"([^"]+)"/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    results.push(match[1]);
  }
  return results;
}

const TEST_PACKAGES = [
  "microsoft.net.test.sdk",
  "xunit",
  "xunit.core",
  "nunit",
  "mstest.testframework",
];

function detectTestProject(packageReferences: string[]): boolean {
  const refs = packageReferences.map((r) => r.toLowerCase());
  return refs.some((r) => TEST_PACKAGES.some((tp) => r === tp || r.startsWith(`${tp}.`)));
}

function readSdk(xml: string): string {
  const projectTag = /<Project\b[^>]*>/i.exec(xml);
  if (!projectTag) {
    return "";
  }
  const sdkAttr = /\bSdk\s*=\s*"([^"]+)"/i.exec(projectTag[0]);
  if (sdkAttr) {
    return sdkAttr[1];
  }
  const sdkTag = firstTag(xml, "Sdk");
  return sdkTag ?? "";
}

function implicitOutputType(sdk: string): string {
  const normalized = sdk.toLowerCase();
  if (normalized.startsWith("microsoft.net.sdk.web") ||
      normalized.startsWith("microsoft.net.sdk.worker") ||
      normalized.startsWith("microsoft.net.sdk.blazorwebassembly") ||
      normalized.startsWith("microsoft.net.sdk.razor")) {
    return "exe";
  }
  return "library";
}

function firstTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`, "i").exec(xml);
  return match ? match[1].trim() : undefined;
}

function parseTargetFrameworks(xml: string): string[] {
  const single = firstTag(xml, "TargetFramework");
  if (single) {
    return [single];
  }
  const multi = firstTag(xml, "TargetFrameworks");
  if (multi) {
    return multi.split(";").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

async function readLaunchProfiles(projectDir: string): Promise<LaunchProfile[]> {
  const file = path.join(projectDir, "Properties", "launchSettings.json");
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { profiles?: Record<string, Omit<LaunchProfile, "name">> };
    if (!parsed.profiles) {
      return [];
    }
    return Object.entries(parsed.profiles).map(([name, p]) => ({ name, ...p }));
  } catch {
    return [];
  }
}

export function findProjectForFile(filePath: string, projects: Project[]): Project | undefined {
  const normalized = path.normalize(filePath);
  let best: Project | undefined;
  for (const project of projects) {
    const dir = path.normalize(project.directory) + path.sep;
    if (normalized.startsWith(dir)) {
      if (!best || project.directory.length > best.directory.length) {
        best = project;
      }
    }
  }
  return best;
}
