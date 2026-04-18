import * as fs from "fs/promises";
import * as vscode from "vscode";
import { Project } from "../solution/discovery";
import { log } from "../services/logger";

export interface EfProject {
  project: Project;
  dbContexts: string[];
}

const EF_PACKAGE_PREFIXES = [
  "microsoft.entityframeworkcore",
  "entityframeworkcore",
];

export async function discoverEfProjects(projects: Project[]): Promise<EfProject[]> {
  const efProjects: EfProject[] = [];
  for (const project of projects) {
    if (!isEfProject(project)) {
      continue;
    }
    const contexts = await findDbContexts(project);
    efProjects.push({ project, dbContexts: contexts });
  }
  log.info(`Discovered ${efProjects.length} EF project(s)`);
  return efProjects;
}

function isEfProject(project: Project): boolean {
  return project.packageReferences.some((pkg) => {
    const normalized = pkg.toLowerCase();
    return EF_PACKAGE_PREFIXES.some((p) => normalized === p || normalized.startsWith(`${p}.`));
  });
}

async function findDbContexts(project: Project): Promise<string[]> {
  const pattern = new vscode.RelativePattern(project.directory, "**/*.cs");
  const exclude = new vscode.RelativePattern(project.directory, "**/{bin,obj,node_modules}/**");
  const files = await vscode.workspace.findFiles(pattern, exclude, 2000);
  const classRegex = /(?:class|record)\s+(\w+)\s*(?:<[^>]*>)?\s*:\s*([^\{]+?)(?:\s*where\s|\s*\{)/g;
  const names = new Set<string>();

  for (const uri of files) {
    try {
      const content = await fs.readFile(uri.fsPath, "utf8");
      let match: RegExpExecArray | null;
      while ((match = classRegex.exec(content)) !== null) {
        const [, className, bases] = match;
        if (!bases) {
          continue;
        }
        if (/\b\w*DbContext\b/.test(bases)) {
          names.add(className);
        }
      }
    } catch (err) {
      log.warn(`Failed to scan ${uri.fsPath}`, err);
    }
  }

  return [...names].sort();
}
