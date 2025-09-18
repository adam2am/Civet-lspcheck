/**
 * Civet Import Parser
 * 
 * This module provides utilities for parsing Civet import statements.
 * It centralizes the logic for understanding Civet import syntax to avoid
 * duplication across different features that need to analyze imports.
 */

export interface ImportMatch {
  spec: string;
  offset: number;
  length: number;
  type: 'from' | 'side-effect';
}

/**
 * A simple, fast, and robust state-machine parser to find all import specifiers in a Civet file.
 * It correctly handles multiline imports, comments, and strings without the fragility of regex or the overhead of a full AST parse.
 */
export function findAllImports(content: string): ImportMatch[] {
  const results: ImportMatch[] = [];
  const importRegex = /import/g;
  let match;

  while ((match = importRegex.exec(content))) {
    let i = match.index;

    // Check if it's a real 'import' keyword
    if (i > 0 && /\w/.test(content[i - 1])) continue;
    i += 6; // Move past 'import'
    const nextChar = content[i];
    if (nextChar && /\w/.test(nextChar)) continue;

    let inString: '"' | "'" | null = null;
    let braceLevel = 0;
    let foundFrom = false;
    let potentialSideEffect = true;

    // Scan forward from the import keyword
    while (i < content.length) {
      let char = content[i];

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

      // Found the specifier
      if (char === "'" || char === '"' || (braceLevel === 0 && content.substring(i, i+2) === './') || (braceLevel === 0 && content.substring(i,i+3) === '../')) {
        let spec;
        let specOffset;
        let specLength;
        
        if (char === "'" || char === '"') {
          inString = char;
          specOffset = i;
          const specStart = i + 1;
          let specEnd = specStart;
          while (specEnd < content.length && content[specEnd] !== inString) specEnd++;
          spec = content.substring(specStart, specEnd);
          specLength = (specEnd - specStart) + 2;
          i = specEnd + 1;
        } else {
          // Unquoted spec
          // This is more robust than a simple regex. We scan until we hit a character
          // that is unambiguously not part of a path. This handles parens, etc.
          specOffset = i;
          let specEnd = i;
          while (specEnd < content.length && !/[\s;(){}\[\]]/.test(content[specEnd])) {
            specEnd++;
          }
          spec = content.substring(i, specEnd);
          specLength = specEnd - i;
          i = specEnd;
        }
        
        const type = foundFrom ? 'from' : (potentialSideEffect ? 'side-effect' : 'from');
        results.push({ spec, offset: specOffset, length: specLength, type });
        break; // Move to next import match
      }
      
      // If we see a character that isn't the start of a specifier and isn't a brace,
      // it's likely a named import, so it's not a side-effect.
      if (/\w/.test(char)) {
          potentialSideEffect = false;
      }

      if (char === ';' || char === '\n') {
        break; // End of statement, move to next import match
      }
      
      i++;
    }
  }

  return results;
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
