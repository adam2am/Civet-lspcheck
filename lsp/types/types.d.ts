import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { TextDocumentIdentifier, Diagnostic, TextDocuments } from 'vscode-languageserver';
import TSService from '../source/lib/typescript-service.mjs';

export type ResolvedService = Awaited<ReturnType<typeof TSService>>;

export interface LanguageServiceContext {
  ensureServiceForSourcePath: (sourcePath: string) => Promise<ResolvedService | undefined>;
  documentToSourcePath: (textDocument: TextDocumentIdentifier) => string;
  documents?: {
    get: (uri: string) => TextDocument | undefined;
  };
  updating?: (document: { uri: string }) => Promise<any>;
  log: (message: string) => void;
  connection?: {
    sendDiagnostics: (params: { uri: string; diagnostics: Diagnostic[] }) => void;
  }
}

export type DebugSettings = {
  signatureHelp: boolean;
  completions: boolean;
  rename: boolean;
  dependencyGraph: boolean;
  semanticTokens: {
    basic: boolean;
    verbose: boolean;
    performance: boolean;
    tokens: boolean;
    refinement: boolean;
    markers: string[];
  };
}

export type FeatureDeps = {
  ensureServiceForSourcePath: (sourcePath: string) => Promise<ResolvedService | undefined>;
  documentToSourcePath: (doc: TextDocument | TextDocumentIdentifier) => string;
  documents: TextDocuments<TextDocument> & {
    get: (uri: string) => TextDocument | undefined;
  };
  updating: (doc: { uri: string }) => Promise<boolean> | undefined;
  debug: DebugSettings;
}
