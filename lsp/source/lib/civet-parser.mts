/**
 * Civet Import/Export Parser
 * 
 * This module provides utilities for parsing Civet import and export statements.
 * It centralizes the logic for understanding Civet import/export syntax to avoid
 * duplication across different features that need to analyze imports and exports.
 * 
 * Uses a single-pass state machine to robustly handle:
 * - import/export statements
 * - type-only imports/exports
 * - re-exports (export { x } from '...')
 * - side-effect imports (import './file')
 * - multiline statements with comments
 */

export interface ImportMatch {
  spec: string;
  offset: number;
  length: number;
  type: 'from' | 'side-effect';
}

/**
 * Validates that a keyword is a real import/export keyword (not part of another word)
 */
function isRealKeyword(content: string, index: number, keyword: string): boolean {
  if (index > 0 && /\w/.test(content[index - 1])) return false;
  const nextChar = content[index + keyword.length];
  return !nextChar || !/\w/.test(nextChar);
}

/**
 * Utility function to strip quotes from a string
 */
export function stripQuotes(text: string): string {
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * Check if a position is inside a comment or string literal at the top level
 */
function isInCommentOrString(content: string, pos: number): boolean {
  let inString: '"' | "'" | '`' | null = null;
  let escapeNext = false;
  let i = 0;

  while (i < pos && i < content.length) {
    // Handle escape sequences in strings
    if (inString && escapeNext) {
      escapeNext = false;
      i++;
      continue;
    }

    if (inString) {
      if (content[i] === '\\') {
        escapeNext = true;
        i++;
        continue;
      }
      if (content[i] === inString) {
        inString = null;
        i++;
        continue;
      }
      i++;
      continue;
    }

    // Enter string or template literal
    if (content[i] === '"' || content[i] === "'" || content[i] === '`') {
      inString = content[i] as '"' | "'" | '`';
      i++;
      continue;
    }

    // Handle line comments - skip to end of line or end of input
    if (content[i] === '/' && content[i + 1] === '/') {
      // If pos is after this point and before the newline, it's in a comment
      const newlinePos = content.indexOf('\n', i);
      if (newlinePos === -1 || pos < newlinePos) {
        // pos is before the newline (or there is no newline), so it's in the comment
        return true;
      }
      // Skip to after the newline
      i = newlinePos + 1;
      continue;
    }

    // Handle block comments - skip until */
    if (content[i] === '/' && content[i + 1] === '*') {
      const endComment = content.indexOf('*/', i + 2);
      if (endComment === -1 || pos < endComment + 2) {
        // pos is before the end of comment (or comment doesn't end)
        return true;
      }
      // Skip past the comment
      i = endComment + 2;
      continue;
    }

    i++;
  }

  return inString !== null;
}

/**
 * A robust single-pass state-machine parser to find all import/export specifiers in a Civet file.
 * Handles both import and export statements including re-exports and type-only exports.
 * 
 * Supported patterns:
 * - import { x } from './file.civet'
 * - import type { x } from './file.civet'
 * - import './file.civet' (side-effect)
 * - export { x } from './file.civet' (re-exports)
 * - export * from './file.civet' (namespace re-exports)
 * - export type { x } from './file.civet' (type re-exports)
 * - export './file.civet' (side-effect export)
 */
export function findAllImports(content: string): ImportMatch[] {
  const results: ImportMatch[] = [];
  let i = 0;

  while (i < content.length) {
    // Find next 'import' or 'export' keyword
    const importIdx = content.indexOf('import', i);
    const exportIdx = content.indexOf('export', i);
    
    let keywordIdx = -1;
    let keyword = '';
    
    if (importIdx !== -1 && exportIdx !== -1) {
      // Both found, take the earlier one
      if (importIdx < exportIdx) {
        keywordIdx = importIdx;
        keyword = 'import';
      } else {
        keywordIdx = exportIdx;
        keyword = 'export';
      }
    } else if (importIdx !== -1) {
      keywordIdx = importIdx;
      keyword = 'import';
    } else if (exportIdx !== -1) {
      keywordIdx = exportIdx;
      keyword = 'export';
    } else {
      break; // No more keywords found
    }

    // Validate it's a real keyword and not in a comment or string
    if (!isRealKeyword(content, keywordIdx, keyword) || isInCommentOrString(content, keywordIdx)) {
      i = keywordIdx + 1;
      continue;
    }

    i = keywordIdx + keyword.length;
    
    // Skip whitespace after keyword
    while (i < content.length && /\s/.test(content[i])) i++;
    
    // Check for 'type' keyword (for type-only imports/exports)
    if (content.substring(i, i + 4) === 'type') {
      i += 4; // Move past 'type'
      // Skip whitespace after 'type'
      while (i < content.length && /\s/.test(content[i])) i++;
    }

    let braceLevel = 0;
    let foundFrom = false;
    let potentialSideEffect = true;

    // Scan forward from the keyword
    while (i < content.length) {
      const char = content[i];

      // Skip whitespace
      if (/\s/.test(char)) {
        i++;
        continue;
      }
      
      // Handle comments
      if (char === '/' && content[i + 1] === '/') {
        while (i < content.length && content[i] !== '\n') i++;
        continue;
      }
      if (char === '/' && content[i + 1] === '*') {
        i += 2;
        while (i < content.length && (content[i] !== '*' || content[i + 1] !== '/')) i++;
        i += 2;
        continue;
      }
      
      if (char === '{') {
        braceLevel++;
        potentialSideEffect = false;
        i++;
        continue;
      }
      if (char === '}') {
        braceLevel--;
        i++;
        continue;
      }

      // Check for `from` keyword only outside of braces
      if (braceLevel === 0 && content.substring(i, i + 4) === 'from') {
        const prevChar = content[i - 1];
        const nextChar = content[i + 4];
        if (prevChar && /\s/.test(prevChar) && nextChar && /\s/.test(nextChar)) {
          foundFrom = true;
          potentialSideEffect = false;
          i += 4; // move past 'from'
          continue;
        }
      }

      // Handle asterisk for namespace exports/imports (e.g., export * from '...' or import * as ...)
      if (char === '*') {
        potentialSideEffect = false;
        i++;
        continue;
      }

      // Found the specifier (quoted string)
      if (char === "'" || char === '"') {
        const stringChar = char;
        const specOffset = i;
        const specStart = i + 1;
        let specEnd = specStart;
        while (specEnd < content.length && content[specEnd] !== stringChar) {
          if (content[specEnd] === '\\') specEnd++; // Skip escaped characters
          specEnd++;
        }
        const spec = content.substring(specStart, specEnd);
        const specLength = (specEnd - specStart) + 2;
        i = specEnd + 1;
        
        const type = foundFrom ? 'from' : (potentialSideEffect ? 'side-effect' : 'from');
        results.push({ spec, offset: specOffset, length: specLength, type });
        break; // Move to next keyword match
      }
      
      // If we see a character that isn't the start of a specifier and isn't a brace,
      // it's likely a named import/export, so it's not a side-effect.
      if (/\w/.test(char)) {
        potentialSideEffect = false;
      }

      if (char === ';' || char === '\n') {
        break; // End of statement, move to next keyword match
      }
      
      i++;
    }
  }

  return results;
}

/**
 * Ensures a path specifier has a leading dot-slash if it's a relative path
 */
export function ensureLeadingDotSlash(spec: string): string {
  if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) return spec;
  return './' + spec;
}

/**
 * Conditionally includes or excludes file extensions based on the original spec
 */
export function withOrWithoutExtension(basePath: string, keepExtensionFrom: string): string {
  const hasExt = /\.[^/]+$/.test(keepExtensionFrom);
  if (hasExt) return basePath;
  return basePath.replace(/\.[^/]+$/, '');
}
