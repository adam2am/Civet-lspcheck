import {
  WorkspaceEdit,
  TextDocumentEdit,
  TextEdit,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { pathToFileURL } from 'url';
import fs from 'fs/promises';
import path from 'path';
import type { ResolvedService, FeatureDeps } from '../../types/types.js';
import {
  findAllImports,
  stripQuotes,
  ensureLeadingDotSlash,
  withOrWithoutExtension,
  type ImportMatch
} from '../lib/civet-parser.mjs';
import { debugSettings } from '../lib/debug.mjs';

async function stageOldFileContent(
  oldUri: string,
  oldPath: string,
  service: ResolvedService,
  documents: { get: (uri: string) => TextDocument | undefined },
  console: { error: (msg: string) => void; log: (msg: string) => void }
): Promise<void> {
  const oldDocObj = documents.get(oldUri);
  if (debugSettings.rename) console.log(`[RENAME] Old document is open in editor: ${!!oldDocObj}`);

  if (oldDocObj) {
    if (debugSettings.rename) console.log(`[RENAME] Staging old document in host: ${oldUri}`);
    service.host.addOrUpdateDocument(oldDocObj);
  } else {
    if (debugSettings.rename) console.log(`[RENAME] Document not open. Reading from disk to stage in host: ${oldPath}`);
    try {
      const content = await fs.readFile(oldPath, 'utf8');
      const tempDoc = TextDocument.create(oldUri, 'civet', 0, content);
      service.host.addOrUpdateDocument(tempDoc);
    } catch (e) {
      console.error(`[RENAME] ERROR: Failed to read old file from disk: ${String(e)}`);
    }
  }
}

export function buildCivetImportEdit(
  document: TextDocument,
  match: ImportMatch,
  newSpec: string
): TextEdit {
  const start = document.positionAt(match.offset);
  const end = document.positionAt(match.offset + match.length);
  const originalSpec = document.getText({ start, end });
  const quoteChar = originalSpec.startsWith('"') || originalSpec.startsWith("'") ? originalSpec[0] : undefined;
  const formattedNewText = quoteChar ? quoteChar + stripQuotes(newSpec) + quoteChar : stripQuotes(newSpec);
  return { range: { start, end }, newText: formattedNewText };
}

async function buildManualCivetWorkspaceEdits(
  oldPath: string,
  newPath: string,
  service: ResolvedService,
  documents: { get: (uri: string) => TextDocument | undefined },
  console: { log: (msg: string) => void },
  candidateFiles: string[]
): Promise<WorkspaceEdit> {
  const documentChanges: TextDocumentEdit[] = [];
  const editsByUri: Record<string, TextEdit[]> = {};
  const contentCache: Record<string, string> = {};

  const oldNoExt = oldPath.replace(/\.[^/]+$/, '');

  const scanStart = performance.now();
  if (debugSettings.rename) console.log(`[RENAME] Scanning ${candidateFiles.length} Civet file(s) for references...`);

  for (const sourcePath of candidateFiles) {
    const uri = pathToFileURL(sourcePath).toString();
    const openDoc = documents.get(uri);

    let content: string | undefined;
    if (openDoc) {
      content = openDoc.getText();
    } else {
      try { content = await fs.readFile(sourcePath, 'utf8'); } catch {}
    }
    if (!content) continue;

    contentCache[uri] = content;

    const dir = path.dirname(sourcePath);
    const imports = findAllImports(content);

    if (imports.length === 0) continue;

    const tempDoc = TextDocument.create(uri, 'civet', 0, content);

    for (const match of imports) {
      const specRaw = stripQuotes(match.spec);
      if (!(specRaw.startsWith('./') || specRaw.startsWith('../') || specRaw.startsWith('/'))) {
        continue;
      }

      const specAbs = path.resolve(dir, specRaw);
      const specNoExt = specAbs.replace(/\.[^/]+$/, '');

      if (specAbs === oldPath || specNoExt === oldNoExt) {
        const rel = path.relative(dir, newPath).replace(/\\/g, '/');
        const keepExtFrom = stripQuotes(match.spec);
        let newSpec = withOrWithoutExtension(rel, keepExtFrom);
        newSpec = ensureLeadingDotSlash(newSpec);

        const edit = buildCivetImportEdit(tempDoc, match, newSpec);

        if (!editsByUri[uri]) editsByUri[uri] = [];
        editsByUri[uri].push(edit);
        if (debugSettings.rename) console.log(`[RENAME] Found edit in ${sourcePath} -> ${newSpec}`);
      }
    }
  }
  const scanEnd = performance.now();
  if (debugSettings.rename) console.log(`[RENAME] Scan completed in ${(scanEnd - scanStart).toFixed(2)}ms`);

  for (const uri of Object.keys(editsByUri)) {
    if (!documents.get(uri)) {
      const content = contentCache[uri];
      if (content) {
        if (debugSettings.rename) console.log(`[RENAME] Pre-registering closed file with edits: ${uri}`);
        service.host.addOrUpdateDocument(TextDocument.create(uri, 'civet', 0, content));
      }
    }
  }

  for (const [uri, edits] of Object.entries(editsByUri)) {
    const doc = documents.get(uri);
    if (doc) {
      documentChanges.push({
        textDocument: { uri, version: doc.version },
        edits
      });
    } else {
      documentChanges.push({
        textDocument: { uri, version: null },
        edits
      });
    }
  }

  return { documentChanges };
}

export async function computeRenameEdits(
  params: { files: { oldUri: string; newUri: string }[] },
  deps: FeatureDeps
): Promise<{ edits: WorkspaceEdit; filesToRefresh: string[] }> {
  const { console: logger, ensureServiceForSourcePath, documentToSourcePath, dependencyGraph } = deps as unknown as FeatureDeps & { console: Console, dependencyGraph: { getDependentsOf: (p: string) => string[] } };
  if (debugSettings.rename) logger.log(`[RENAME] START computeRenameEdits for ${params.files.length} files`);
  const startTime = performance.now();

  const allEdits: WorkspaceEdit = { documentChanges: [] };

  const allCandidateFiles = new Set<string>();
  for (const { oldUri } of params.files) {
    const oldPath = documentToSourcePath({ uri: oldUri } as any);
    const dependents = dependencyGraph.getDependentsOf(oldPath);
    if (debugSettings.rename) logger.log(`[RENAME] Dependents of ${oldPath}: ${dependents.length}`);
    dependents.forEach(dep => allCandidateFiles.add(dep));
    allCandidateFiles.add(oldPath);
  }
  if (debugSettings.rename) logger.log(`[RENAME] Found ${allCandidateFiles.size} total candidate files.`);

  for (const { oldUri, newUri } of params.files) {
    const oldPath = documentToSourcePath({ uri: oldUri } as any);
    const newPath = documentToSourcePath({ uri: newUri } as any);

    if (debugSettings.rename) logger.log(`[RENAME] Processing rename: ${oldPath} -> ${newPath}`);

    const service = await ensureServiceForSourcePath(newPath);
    if (!service) {
      logger.error(`[RENAME] ERROR: No service found for path: ${newPath}`);
      continue;
    }

    await stageOldFileContent(oldUri, oldPath, service, (deps as any).documents, logger);

    const candidateFiles = Array.from(allCandidateFiles);
    const manualEdits = await buildManualCivetWorkspaceEdits(oldPath, newPath, service, (deps as any).documents, logger, candidateFiles);

    const manualCount = (manualEdits.documentChanges ?? []).reduce((sum, change) => {
      return sum + ('edits' in change ? change.edits.length : 0);
    }, 0);
    if (debugSettings.rename) logger.log(`[RENAME] Found ${manualCount} potential edits.`);

    if (manualCount > 0) {
      const manualDocChanges = manualEdits.documentChanges;
      if (manualDocChanges) {
        allEdits.documentChanges!.push(...manualDocChanges);
      }
    }
  }

  const totalEdits = (allEdits.documentChanges ?? []).reduce((sum, change) => {
    return sum + ('edits' in change ? change.edits.length : 0);
  }, 0);
  const totalFiles = (allEdits.documentChanges ?? []).length;
  if (debugSettings.rename) logger.log(`[RENAME] Returning WorkspaceEdit with ${totalEdits} total edits across ${totalFiles} files`);

  const finalEdit: WorkspaceEdit = {
    documentChanges: allEdits.documentChanges || [],
  };

  const filesToRefreshUris = new Set([
    ...(finalEdit.documentChanges?.filter(dc => 'textDocument' in dc).map(dc => (dc as TextDocumentEdit).textDocument.uri) ?? []),
  ]);
  const filesToRefresh = Array.from(filesToRefreshUris);
  if (debugSettings.rename) logger.log(`[RENAME] Files to refresh: ${filesToRefresh.length > 0 ? filesToRefresh.join(', ') : 'none'}`);

  const duration = performance.now() - startTime;
  if (debugSettings.rename) logger.log(`[RENAME] Total rename computation time: ${duration.toFixed(2)}ms`);

  return { edits: finalEdit, filesToRefresh };
}

async function applyAliasPropagation(
  aliasChanges: Array<{ modulePath: string; oldName: string; newName: string }>,
  service: ResolvedService,
  deps: FeatureDeps,
  workspaceEdit: WorkspaceEdit
) {
  if (aliasChanges.length === 0) return;
  const program = service.getProgram();
  if (!program) return;

  const documentEntries = new Map<string, { doc: TextDocument; content: string }>();
  const documentsAccessor = (deps as any).documents;
  if (documentsAccessor?.all) {
    for (const doc of documentsAccessor.all()) {
      try {
        const sourcePath = deps.documentToSourcePath(doc);
        documentEntries.set(sourcePath, { doc, content: doc.getText() });
      } catch {}
    }
  }

  for (const sourceFile of program.getSourceFiles()) {
    const sourcePath = service.getSourceFileName(sourceFile.fileName);
    if (!sourcePath.endsWith('.civet')) continue;
    if (documentEntries.has(sourcePath)) continue;
    try {
      const content = await fs.readFile(sourcePath, 'utf8');
      const uri = pathToFileURL(sourcePath).toString();
      const tempDoc = TextDocument.create(uri, 'civet', 0, content);
      documentEntries.set(sourcePath, { doc: tempDoc, content });
    } catch {}
  }

  for (const [sourcePath, { doc, content }] of documentEntries) {
    const docUri = doc.uri ?? pathToFileURL(sourcePath).toString();
    const matches = findAllImports(content);
    const docDir = path.dirname(sourcePath);

    for (const { modulePath, oldName, newName } of aliasChanges) {
      const moduleNoExt = modulePath.replace(/\.[^/]+$/, '');

      for (const match of matches) {
        if (match.type !== 'from') continue;
        const specRaw = stripQuotes(match.spec);
        const specAbs = path.resolve(docDir, specRaw);
        const specNoExt = specAbs.replace(/\.[^/]+$/, '');
        if (specAbs !== modulePath && specNoExt !== moduleNoExt) continue;

        const braceStart = content.lastIndexOf('{', match.offset);
        const braceEnd = content.indexOf('}', braceStart);
        if (braceStart === -1 || braceEnd === -1 || braceEnd <= braceStart) continue;

        const braceSection = content.slice(braceStart, braceEnd);
        const regex = new RegExp(`\\b${oldName}\\b`, 'g');
        let braceMatch: RegExpExecArray | null;
        while ((braceMatch = regex.exec(braceSection)) !== null) {
          const startOffset = braceStart + braceMatch.index;
          const endOffset = startOffset + oldName.length;
          if (content.slice(startOffset, endOffset) === newName) continue;

          const start = doc.positionAt(startOffset);
          const end = doc.positionAt(endOffset);

          if (!workspaceEdit.changes) workspaceEdit.changes = {};
          if (!workspaceEdit.changes[docUri]) workspaceEdit.changes[docUri] = [];
          workspaceEdit.changes[docUri]!.push({ range: { start, end }, newText: newName });
        }
      }
    }
  }
}

export async function handleRename(
  plan: { renameAnchor: { fileForTs: string, offset: number }, newName: string },
  deps: FeatureDeps
): Promise<WorkspaceEdit | null> {
  const { ensureServiceForSourcePath } = deps;
  
  if (debugSettings.rename && (deps as any).console?.log) (deps as any).console.log(`[RENAME] handleRename called for ${plan.renameAnchor.fileForTs}`);
  const service = await ensureServiceForSourcePath(plan.renameAnchor.fileForTs);
  if (!service) return null;

  let edits;
  try {
    edits = service.findRenameLocations(
      plan.renameAnchor.fileForTs,
      plan.renameAnchor.offset,
      false,
      false,
      { providePrefixAndSuffixTextForRename: true }
    );
  } catch (error) {
    if (debugSettings.rename && (deps as any).console?.log) {
      (deps as any).console.log(`[RENAME] Error finding rename locations: ${error}`);
    }
    return null;
  }

  if (!edits) {
    if (debugSettings.rename && (deps as any).console?.log) (deps as any).console.log(`[RENAME] No rename locations found.`);
    return null;
  }

  const program = service.getProgram();
  if (!program) return null;

  const workspaceEdit: WorkspaceEdit = { changes: {} };
  const aliasChanges: Array<{ modulePath: string; oldName: string; newName: string }> = [];

  for (const edit of edits) {
    const sourceFile = program.getSourceFile(edit.fileName);
    if (!sourceFile) continue;

    const rawSourceName = service.getSourceFileName(edit.fileName);
    const uri = pathToFileURL(rawSourceName).toString();

    if (!workspaceEdit.changes![uri]) {
      workspaceEdit.changes![uri] = [];
    }

    const doc = (deps as any).documents.get(uri);
    if (!doc) {
      if (debugSettings.renameLogging?.logEdits && (deps as any).console?.log) (deps as any).console.log(`[RENAME:WARN] Document not found for URI: ${uri}`);
      continue;
    }

    let start = sourceFile.getLineAndCharacterOfPosition(edit.textSpan.start);
    let end = sourceFile.getLineAndCharacterOfPosition(edit.textSpan.start + edit.textSpan.length);

    // Log before remapping if debug is on
    if (debugSettings.renameLogging?.logRanges && (deps as any).console?.log) {
      (deps as any).console.log(`[RENAME:RANGE-TS] fileName=${edit.fileName} start=${JSON.stringify(start)} end=${JSON.stringify(end)}`);
      (deps as any).console.log(`[RENAME:EDIT-OBJ] edit object: ${JSON.stringify(edit, null, 2)}`);
    }

    const meta = service.host.getMeta(rawSourceName);
    if (meta?.sourcemapLines) {
      // Trust remapped start position; discard TS-based end and recompute from source
      start = (deps as any).remapPosition(start, meta.sourcemapLines);

      const originalDocText = doc.getText();
      const originalStartOffset = doc.offsetAt(start);

      // Advance past any leading whitespace
      let tokenStartOffset = originalStartOffset;
      while (tokenStartOffset < originalDocText.length && /\s/.test(originalDocText[tokenStartOffset])) {
        tokenStartOffset++;
      }

      // Scan forward over identifier characters (Unicode-aware: letters, numbers, $, _)
      let tokenEndOffset = tokenStartOffset;
      while (tokenEndOffset < originalDocText.length) {
        const ch = originalDocText[tokenEndOffset];
        // Match valid JavaScript identifier continuation characters
        if (!/[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}_$]/u.test(ch)) break;
        tokenEndOffset++;
      }

      // If no token characters found, skip this edit
      if (tokenStartOffset === tokenEndOffset) continue;

      start = doc.positionAt(tokenStartOffset);
      end = doc.positionAt(tokenEndOffset);
      
      if (debugSettings.renameLogging?.logMappings && (deps as any).console?.log) {
        (deps as any).console.log(`[RENAME:MAP] remapped to start=${JSON.stringify(start)} end=${JSON.stringify(end)}`);
      }
    }

    // Use sophisticated rename information from TypeScript if available
    let newText = plan.newName;

    const hasPrefix = typeof edit.prefixText === 'string';
    const hasSuffix = typeof edit.suffixText === 'string';

    // If TypeScript provides prefix and/or suffix text for sophisticated renames (like import aliasing),
    // use that instead of naive replacement
    if (hasPrefix || hasSuffix) {
      const prefixText = hasPrefix ? edit.prefixText ?? '' : '';
      const suffixText = hasSuffix ? edit.suffixText ?? '' : '';

      if (hasSuffix) {
        const originalText = doc.getText({ start, end });
        const suffixTrim = suffixText.trimStart();
        if (suffixTrim.startsWith('as ') && suffixTrim.slice(3).trim() === originalText) {
          newText = `${prefixText}${plan.newName}`;
          aliasChanges.push({ modulePath: rawSourceName, oldName: originalText, newName: plan.newName });
          if (debugSettings.renameLogging?.logEdits && (deps as any).console?.log) {
            (deps as any).console.log(`[RENAME:SOPHISTICATED] Removing alias suffix for ${originalText} -> ${plan.newName}`);
          }
        } else {
          newText = `${prefixText}${plan.newName}${suffixText}`;
          if (debugSettings.renameLogging?.logEdits && (deps as any).console?.log) {
            (deps as any).console.log(`[RENAME:SOPHISTICATED] Using prefix/suffix: "${prefixText}" + "${plan.newName}" + "${suffixText}" = "${newText}"`);
          }
        }
      } else {
        newText = `${prefixText}${plan.newName}${suffixText}`;
        if (debugSettings.renameLogging?.logEdits && (deps as any).console?.log) {
          (deps as any).console.log(`[RENAME:SOPHISTICATED] Using prefix/suffix: "${prefixText}" + "${plan.newName}" + "${suffixText}" = "${newText}"`);
        }
      }
    } else {
      if (debugSettings.renameLogging?.logEdits && (deps as any).console?.log) {
        (deps as any).console.log(`[RENAME:SIMPLE] Using simple replacement: "${newText}"`);
      }
    }
    
    workspaceEdit.changes![uri].push({
      range: { start, end },
      newText,
    });

    if (debugSettings.renameLogging?.logEdits && (deps as any).console?.log) {
      (deps as any).console.log(`[RENAME:EDIT] uri=${uri} range=[${start.line}:${start.character}-${end.line}:${end.character}] newText="${plan.newName}"`);
    }
  }

  if (debugSettings.renameLogging?.logEdits && (deps as any).console?.log) {
    (deps as any).console.log(`[RENAME:RESULT] Total edits: ${Object.values(workspaceEdit.changes!).reduce((sum, edits) => sum + edits.length, 0)}`);
  }

  await applyAliasPropagation(aliasChanges, service, deps, workspaceEdit);

  return workspaceEdit;
}


