/**
 * Centralized debug flags for LSP development.
 *
 * This file provides a single source of truth for all developer-facing
 * debug flags. Modify the values here to enable or disable logging
 * for specific features during development.
 *
 */
export const debugSettings = {
  signatureHelp: true,
  completions: false,
  rename: false,
  dependencyGraph: false,
  semanticTokens: {
    basic: false,        // Basic debug logging (replaces CIVET_SEM_DEBUG)
    verbose: false,      // Verbose token emission logging (replaces CIVET_SEM_LOG_ALL)
    performance: false,  // Performance reports (replaces CIVET_SEM_PERF)
    tokens: false,       // Individual token debugging (replaces CIVET_DEBUG_TOKENS)
    refinement: true,    // Enable refinement engine (replaces CIVET_DISABLE_SEMANTIC_REFINEMENT negation)
    markers: ['isTsx', 'status', 'Math'], // Specific identifiers to trace (replaces CIVET_SEM_MARKERS)
  },
  // Add new debug flags here as needed
};
