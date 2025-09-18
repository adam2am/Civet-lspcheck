import fs from 'fs/promises';
import path from 'path';
import { performance } from 'perf_hooks';
import { findAllImports, stripQuotes } from './civet-parser.mjs';
import { debugSettings } from './debug.mjs';

export interface DependencyInfo {
  /** Files that this file imports */
  imports: Set<string>;
  /** Files that import this file */
  importedBy: Set<string>;
}

export class DependencyGraph {
  private graph = new Map<string, DependencyInfo>();
  private logger: { log: (message: string) => void };

  private initialBuildPromise: Promise<void>;
  private resolveInitialBuild!: () => void;

  constructor(logger: { log: (message: string) => void }) {
    this.logger = logger;
    this.initialBuildPromise = new Promise(resolve => {
      this.resolveInitialBuild = resolve;
    });
  }

  /**
   * A promise that resolves when the initial graph build is complete.
   * This should be awaited before performing any operations that rely on a complete graph.
   */
  public get isReady(): Promise<void> {
    return this.initialBuildPromise;
  }

  /**
   * Builds and initializes the dependency graph by scanning all .civet files from a root directory.
   * This is an async, non-blocking operation.
   */
  async build(rootDir: string): Promise<void> {
    this.logger.log(`[DEPGRAPH] Starting project scan from root: ${rootDir}`);
    const startTime = performance.now();
    
    const allFiles = await this.listCivetFilesUnder(rootDir);
    this.logger.log(`[DEPGRAPH] Discovered ${allFiles.length} Civet files.`);

    // Pass 1: Create a node for every file in the project.
    // This eliminates race conditions where an import link is created before the imported file's node exists.
    for (const filePath of allFiles) {
      this.graph.set(path.normalize(filePath), { imports: new Set(), importedBy: new Set() });
    }

    // Pass 2: Parse files and build the dependency links.
    // Now we can be certain that any imported file will already have a node in the graph.
    for (const filePath of allFiles) {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        this.addOrUpdateFile(filePath, content);
      } catch (e) {
        if (debugSettings.dependencyGraph) this.logger.log(`[DEPGRAPH] WARN: Could not read file during initial scan: ${filePath}. ${String(e)}`);
      }
    }

    const duration = performance.now() - startTime;
    const stats = this.getStats();
    this.logger.log(`[DEPGRAPH] Initial build complete in ${duration.toFixed(2)}ms. Graph has ${stats.totalFiles} nodes and ${stats.totalDependencies} edges.`);
    this.resolveInitialBuild();
  }

  /**
   * Adds a new file or updates an existing file in the graph.
   * It parses the file's content to find its imports and updates both forward and reverse dependencies.
   */
  addOrUpdateFile(filePath: string, content: string): void {
    const normalizedPath = path.normalize(filePath);
    if (debugSettings.dependencyGraph) this.logger.log(`[DEPGRAPH_TRACE] addOrUpdateFile: Processing ${normalizedPath}`);
    const fileDir = path.dirname(normalizedPath);

    const oldImports = this.graph.get(normalizedPath)?.imports || new Set<string>();
    
    // Use the robust parser from fileRename.mts
    const importMatches = findAllImports(content);
    const newImports = new Set<string>();

    for (const match of importMatches) {
      const specRaw = stripQuotes(match.spec);
      if (specRaw.startsWith('./') || specRaw.startsWith('../')) {
        try {
          let resolvedPath = path.resolve(fileDir, specRaw);
          // Attempt to resolve extension-less imports
          if (!path.extname(resolvedPath)) {
            resolvedPath += '.civet';
          }
          const finalPath = path.normalize(resolvedPath);
          newImports.add(finalPath);
          if (debugSettings.dependencyGraph) this.logger.log(`[DEPGRAPH_TRACE] addOrUpdateFile: Found import from ${normalizedPath} -> ${finalPath}`);
        } catch (e) {
          if (debugSettings.dependencyGraph) this.logger.log(`[DEPGRAPH] WARN: Could not resolve import '${specRaw}' in file ${normalizedPath}. ${String(e)}`);
        }
      }
    }

    // Update the node for the current file
    if (!this.graph.has(normalizedPath)) {
      this.graph.set(normalizedPath, { imports: new Set(), importedBy: new Set() });
    }
    const node = this.graph.get(normalizedPath)!;
    node.imports = newImports;

    // Update the `importedBy` sets for all involved files
    const removedImports = new Set([...oldImports].filter(imp => !newImports.has(imp)));
    const addedImports = new Set([...newImports].filter(imp => !oldImports.has(imp)));

    for (const importPath of removedImports) {
      this.graph.get(importPath)?.importedBy.delete(normalizedPath);
    }

    if (debugSettings.dependencyGraph) this.logger.log(`[DEPGRAPH_DEBUG] ${normalizedPath}: removed reverse links from ${removedImports.size} old imports.`);

    for (const importPath of addedImports) {
      if (!this.graph.has(importPath)) {
        this.graph.set(importPath, { imports: new Set(), importedBy: new Set() });
        if (debugSettings.dependencyGraph) this.logger.log(`[DEPGRAPH_DEBUG] Created new node for imported file: ${importPath}`);
      }
      this.graph.get(importPath)!.importedBy.add(normalizedPath);
      if (debugSettings.dependencyGraph) this.logger.log(`[DEPGRAPH_DEBUG] Added reverse link: ${importPath} is now imported by ${normalizedPath}`);
    }
    
    if (debugSettings.dependencyGraph) this.logger.log(`[DEPGRAPH_DEBUG] ${normalizedPath}: added reverse links to ${addedImports.size} new imports. (['${[...addedImports].join("', '")}'])`);
    // Note: Final dependent counts will be logged by renameFile if a rename operation follows
    
    // this.logger.log(`[DEPGRAPH] Updated ${normalizedPath}. Imports: ${newImports.size}, Imported By: ${node.importedBy.size}`);
  }

  /**
   * Removes a file from the graph, cleaning up all its connections.
   */
  removeFile(filePath: string): void {
    const normalizedPath = path.normalize(filePath);
    const node = this.graph.get(normalizedPath);
    if (!node) return;

    // Remove this file from the `importedBy` set of all files it imports
    for (const importPath of node.imports) {
      this.graph.get(importPath)?.importedBy.delete(normalizedPath);
    }

    // Remove this file from the `imports` set of all files that import it
    for (const dependentPath of node.importedBy) {
      this.graph.get(dependentPath)?.imports.delete(normalizedPath);
    }

    this.graph.delete(normalizedPath);
    if (debugSettings.dependencyGraph) this.logger.log(`[DEPGRAPH] Removed ${normalizedPath} from the graph.`);
  }

  /**
   * Efficiently handles a file rename by updating the graph's keys and internal references.
   * This is a simple, explicit operation that moves the node and re-wires its neighbors.
   */
  renameFile(oldPath: string, newPath: string): void {
    const oldNormalized = path.normalize(oldPath);
    const newNormalized = path.normalize(newPath);

    const oldNode = this.graph.get(oldNormalized);
    if (!oldNode) {
      if (debugSettings.dependencyGraph) this.logger.log(`[DEPGRAPH] renameFile: Attempted to rename a file not in the graph: ${oldNormalized}`);
      return;
    }

    // 1. Get a new node for the new path, creating if it doesn't exist.
    // This handles cases where a file is renamed to an existing (but unrelated) file path.
    if (!this.graph.has(newNormalized)) {
      this.graph.set(newNormalized, { imports: new Set(), importedBy: new Set() });
    }
    const newNode = this.graph.get(newNormalized)!;

    // 2. Transfer ownership: oldNode's data becomes newNode's data.
    // CRITICAL: MERGE the sets, do not overwrite. This handles the race condition
    // where onDidChangeContent has already updated the newNode with partial information.
    for (const imp of oldNode.imports) {
      newNode.imports.add(imp);
    }
    for (const dep of oldNode.importedBy) {
      newNode.importedBy.add(dep);
    }

    // 3. Update all files that IMPORTED the old node to now import the new node.
    for (const dependentPath of newNode.importedBy) {
      const dependentNode = this.graph.get(dependentPath);
      if (dependentNode) {
        dependentNode.imports.delete(oldNormalized);
        dependentNode.imports.add(newNormalized);
      }
    }

    // 4. Update all files that WERE IMPORTED BY the old node to now be imported by the new node.
    for (const importPath of newNode.imports) {
      const importNode = this.graph.get(importPath);
      if (importNode) {
        importNode.importedBy.delete(oldNormalized);
        importNode.importedBy.add(newNormalized);
      }
    }

    // 5. Delete the old node, its existence is now fully represented by the new node.
    this.graph.delete(oldNormalized);

    const finalNode = this.graph.get(newNormalized);
    if (debugSettings.dependencyGraph) this.logger.log(`[DEPGRAPH] Renamed ${oldNormalized} to ${newNormalized}. Final node: imports=${finalNode?.imports.size ?? 0}, importedBy=${finalNode?.importedBy.size ?? 0}`);
  }

  /**
   * Instantly retrieves all files that import the given file. This is the primary purpose of the graph.
   * Returns an array of absolute file paths based on the graph's current state.
   */
  getDependentsOf(filePath: string): string[] {
    const normalizedPath = path.normalize(filePath);
    if (debugSettings.dependencyGraph) this.logger.log(`[DEPGRAPH_TRACE] getDependentsOf: Querying for ${normalizedPath}`);

    const dependents = new Set<string>();

    // SIMPLIFIED: Only look for exactly what we're asked for
    // No more clever extension-less nonsense that never works anyway
    const node = this.graph.get(normalizedPath);
    if (node) {
      if (debugSettings.dependencyGraph) this.logger.log(`[DEPGRAPH_TRACE] getDependentsOf: Found node with ${node.importedBy.size} dependents`);
      node.importedBy.forEach(dep => {
        if (debugSettings.dependencyGraph) this.logger.log(`[DEPGRAPH_TRACE] getDependentsOf: Adding dependent: ${dep}`);
        dependents.add(dep);
      });
    } else {
      if (debugSettings.dependencyGraph) this.logger.log(`[DEPGRAPH_TRACE] getDependentsOf: No node found for ${normalizedPath}`);
      if (debugSettings.dependencyGraph) this.logger.log(`[DEPGRAPH_TRACE] getDependentsOf: Available keys: [${Array.from(this.graph.keys()).slice(0, 5).join(', ')}...]`);
    }

    const result = Array.from(dependents);
    if (debugSettings.dependencyGraph) this.logger.log(`[DEPGRAPH] Found ${result.length} dependents for ${filePath}`);
    return result;
  }

  getStats(): { totalFiles: number; totalDependencies: number; averageDependencies: number } {
    const totalFiles = this.graph.size;
    let totalDependencies = 0;
    for (const node of this.graph.values()) {
      totalDependencies += node.imports.size;
    }
    const averageDependencies = totalFiles > 0 ? totalDependencies / totalFiles : 0;
    return { totalFiles, totalDependencies, averageDependencies };
  }
  
  // Private utility to find all .civet files asynchronously and non-blockingly.
  private async listCivetFilesUnder(rootDir: string): Promise<string[]> {
    const ignoreDirs = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage"]);
    const results: string[] = [];
    const queue: string[] = [rootDir];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const dir = queue.shift()!;
      if (visited.has(dir)) continue;
      visited.add(dir);

      let entries: import('fs').Dirent[] = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!ignoreDirs.has(entry.name)) queue.push(full);
          continue;
        }
        if (entry.isFile() && full.endsWith('.civet')) {
          results.push(path.normalize(full));
        }
      }
    }
    return results;
  }
  
}
