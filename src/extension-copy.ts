import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Modules that register Fabric: src/index.ts, src/extension-bootstrap.ts and their dist builds.
const ENTRY_DIRECTORIES = new Set(["dist", "src"]);
const ENTRY_STEMS = new Set(["index", "extension-bootstrap"]);

interface FabricCopy {
  root: string;
  name: string;
  /** Real path of the entry module. */
  file: string;
}

export interface FabricCommandLine {
  argv: readonly string[];
  cwd: string;
}

const extensionArguments = (argv: readonly string[]): string[] => {
  const values: string[] = [];
  for (let index = 0; index < argv.length - 1; index++) {
    if (argv[index] === "-e" || argv[index] === "--extension") values.push(argv[++index]!);
  }
  return values;
};

interface PackageManifest {
  name?: unknown;
  pi?: { extensions?: unknown };
}

const readManifest = (directory: string): PackageManifest | undefined => {
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    return manifest && typeof manifest === "object" ? manifest as PackageManifest : undefined;
  } catch {
    return undefined;
  }
};

const packageName = (directory: string): string | undefined => {
  const name = readManifest(directory)?.name;
  return typeof name === "string" && name ? name : undefined;
};

const isEntryModule = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  const stem = path.basename(relative, path.extname(relative));
  return ENTRY_DIRECTORIES.has(path.dirname(relative)) && ENTRY_STEMS.has(stem);
};

// Like Pi, a package directory loads the existing files its manifest lists in `pi.extensions`.
const directoryEntry = (root: string): string | undefined => {
  const extensions = readManifest(root)?.pi?.extensions;
  if (!Array.isArray(extensions)) return undefined;
  for (const extension of extensions) {
    if (typeof extension !== "string") continue;
    const listed = path.resolve(root, extension);
    if (!isEntryModule(root, listed)) continue;
    try {
      return fs.realpathSync(listed);
    } catch {
      // Pi skips a listed entry that does not exist, such as an unbuilt dist/.
    }
  }
  return undefined;
};

// The nearest enclosing package with a name; a nameless package.json only sets module options.
const enclosingPackage = (file: string): { root: string; name: string } | undefined => {
  for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
    const name = packageName(directory);
    if (name) return { root: directory, name };
    if (path.dirname(directory) === directory) return undefined;
  }
};

const describeCopy = (location: string, entryOnly: boolean): FabricCopy | undefined => {
  let real: string;
  let directory: boolean;
  try {
    real = fs.realpathSync(location);
    directory = fs.statSync(real).isDirectory();
  } catch {
    // npm:, git: and builtin: sources and missing paths are not local Fabric copies.
    return undefined;
  }
  if (directory) {
    const name = packageName(real);
    const file = name ? directoryEntry(real) : undefined;
    return name && file ? { root: real, name, file } : undefined;
  }
  const owner = enclosingPackage(real);
  if (!owner) return undefined;
  if (entryOnly && !isEntryModule(owner.root, real)) return undefined;
  return { ...owner, file: real };
};

const resolveArgument = (value: string, cwd: string): string => {
  const expanded = value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
  return path.resolve(cwd, expanded);
};

/**
 * The Fabric copy this process's command line loads with `-e`/`--extension`, when it is a
 * different copy than `entryPath`; otherwise undefined.
 *
 * A Fabric child Pi loads its parent's own Fabric build with `-e` and also the packages in the
 * user's Pi settings. When those settings name another pi-fabric build (the profile switched
 * builds while the parent kept running), both copies would register `fabric_exec` and Pi would
 * refuse to start the child. The command-line copy wins: it matches the worker the parent
 * launched, and Pi itself loads command-line extensions first. When several Fabric copies are on
 * the command line, the first one wins.
 *
 * Only the command line counts, never the environment, so a top-level `pi` that inherits a
 * Fabric child's environment keeps its own Fabric. Any failure to inspect the copies leaves
 * this copy active.
 */
export const commandLineFabricCopy = (
  entryPath: string,
  commandLine: FabricCommandLine = { argv: process.argv, cwd: process.cwd() },
): string | undefined => {
  const values = extensionArguments(commandLine.argv);
  if (values.length === 0) return undefined;
  const own = describeCopy(entryPath, false);
  if (!own) return undefined;
  for (const value of values) {
    const copy = describeCopy(resolveArgument(value, commandLine.cwd), true);
    if (!copy || copy.name !== own.name) continue;
    return copy.file === own.file ? undefined : copy.file;
  }
  return undefined;
};
