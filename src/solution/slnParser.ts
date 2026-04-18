import * as fs from "fs/promises";
import * as path from "path";
import { log } from "../services/logger";

export interface Solution {
  path: string;
  directory: string;
  projectPaths: string[];
}

const SLN_PROJECT_LINE = /^Project\("\{[^}]+\}"\)\s*=\s*"([^"]+)",\s*"([^"]+)",\s*"\{[^}]+\}"\s*$/gm;
const SLNX_PROJECT_PATH = /<Project\s+[^>]*Path\s*=\s*"([^"]+)"/g;

export async function parseSolution(slnPath: string): Promise<Solution> {
  const raw = await fs.readFile(slnPath, "utf8");
  const directory = path.dirname(slnPath);
  const isXml = slnPath.toLowerCase().endsWith(".slnx");
  const relativeProjects = isXml ? parseSlnx(raw) : parseSln(raw);
  const projectPaths = relativeProjects
    .filter((rel) => rel.toLowerCase().endsWith(".csproj"))
    .map((rel) => path.resolve(directory, normalizeSeparators(rel)));
  return { path: slnPath, directory, projectPaths };
}

function parseSln(content: string): string[] {
  const results: string[] = [];
  for (const match of content.matchAll(SLN_PROJECT_LINE)) {
    const [, , projectPath] = match;
    results.push(projectPath);
  }
  return results;
}

function parseSlnx(content: string): string[] {
  const results: string[] = [];
  for (const match of content.matchAll(SLNX_PROJECT_PATH)) {
    const [, projectPath] = match;
    results.push(projectPath);
  }
  return results;
}

function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, path.sep).replace(/\//g, path.sep);
}

export async function parseSolutionsSafe(paths: string[]): Promise<Solution[]> {
  const results = await Promise.all(
    paths.map((p) =>
      parseSolution(p).catch((err) => {
        log.warn(`Failed to parse solution ${p}`, err);
        return undefined;
      }),
    ),
  );
  return results.filter((s): s is Solution => s !== undefined);
}
