import {
    SemanticTokens,
    SemanticTokensBuilder,
    SemanticTokensLegend,
    Range,
    TextDocumentIdentifier,
  } from 'vscode-languageserver/node';
  import { TextDocument } from 'vscode-languageserver-textdocument';
  import ts from 'typescript';
  import { SourcemapLines, remapPosition } from '../lib/util.mjs';
  import type { FeatureDeps } from '../../types/types.js';
  import { debugSettings } from '../lib/debug.mjs';
  
  const enum TokenEncodingConsts {
    typeOffset = 8,
    modifierMask = (1 << typeOffset) - 1
  }
  
  // Mirrors a private enum in TypeScript
  const enum TsSemanticTokenModifier {
    declaration = 1 << 0,
    static = 1 << 1,
    async = 1 << 2,
    readonly = 1 << 3,
    defaultLibrary = 1 << 4,
    local = 1 << 5, // Not in LSP standard
    deprecated = 1 << 6,
    abstract = 1 << 7,
  }
  
  function getTokenTypeFromClassification(tsClassification: number): number {
    return (tsClassification >> TokenEncodingConsts.typeOffset) - 1;
  }
  
  
  // Types for handling different shapes of TS semantic classification results
  interface EncodedSemanticClassifications {
    spans: number[];
    endOfLineState?: ts.EndOfLineState;
  }
  
  // Type guard to check for the modern EncodedSemanticClassifications shape
  function isEncodedSemanticClassifications(obj: any): obj is EncodedSemanticClassifications {
    return obj && Array.isArray(obj.spans);
  }
  
  // Type guard for legacy array shape
  function isEncodedSemanticDataArray(obj: any): obj is number[] {
    return Array.isArray(obj);
  }
  
  function extractSpans(info: any): number[] | undefined {
    if (!info) return undefined;
    if (isEncodedSemanticClassifications(info)) {
      return info.spans;
    }
    if (isEncodedSemanticDataArray(info)) {
      return info;
    }
    // Some legacy TS versions return an object with a `data` property
    if (Array.isArray((info as any).data)) {
      return (info as any).data;
    }
    return undefined;
  }
  
  // Semantic Tokens - OPTIMIZED: Hoisted to module scope to avoid repeated allocations
  const SEMANTIC_LEGEND: SemanticTokensLegend = {
    tokenTypes: [
      'namespace',
      'type',
      'class',
      'enum',
      'interface',
      'struct',
      'typeParameter',
      'parameter',
      'variable',
      'property',
      'enumMember',
      'event',
      'function',
      'method',
      'macro',
      'label',
      'comment'
    ],
    tokenModifiers: [
      'declaration', 
      'definition', 
      'readonly', 
      'static', 
      'deprecated', 
      'abstract', 
      'async', 
      'modification', 
      'documentation', 
      'defaultLibrary'
    ]
  };
  
  export function getSemanticLegend(): SemanticTokensLegend {
    return SEMANTIC_LEGEND;
  }

  const COMMENT_TOKEN_TYPE = SEMANTIC_LEGEND.tokenTypes.indexOf('comment')
  
  // Centralized debug settings - no more environment variables!
  const { semanticTokens: semDebug } = debugSettings;
  const SEM_LOG_ALL = semDebug.verbose;
  const SEM_DEBUG = semDebug.basic;
  const SEM_PERF = semDebug.performance;
  const SEM_MARKERS = new Set<string>(semDebug.markers);
  
  // Refinement is CORE functionality, not a debug setting. 
  // It is required for Civet tokens to be classified correctly.
  // DO NOT hide this behind debug flags.
  const REFINEMENT_ENABLED = true;
  
  function isMarkerIdentifier(name: string | undefined): boolean {
    return !!name && SEM_MARKERS.has(name)
  }
  
  function lspTypeIndexToName(idx: number | undefined) {
    return idx == null || idx < 0 ? String(idx) : SEMANTIC_LEGEND.tokenTypes[idx]
  }
  
  function modifierMaskToNames(mask: number): string[] {
    const names: string[] = []
    for (let i = 0; i < SEMANTIC_LEGEND.tokenModifiers.length; i++) {
      if (mask & (1 << i)) names.push(SEMANTIC_LEGEND.tokenModifiers[i])
    }
    return names
  }
  
  
  async function provideSemanticTokens(
    params: { textDocument: TextDocumentIdentifier; range?: Range },
    deps: FeatureDeps
  ): Promise<SemanticTokens> {
    const { textDocument, range } = params
    const { documents, ensureServiceForSourcePath, documentToSourcePath, updating } = deps
    if (SEM_DEBUG) console.log('🔍 SEMANTIC-TOKENS requested for:', textDocument.uri, range ? ' (range)' : '(full)')
  
    try {
      const sourcePath = documentToSourcePath(textDocument)
      const service = await ensureServiceForSourcePath(sourcePath)
      if (!service) {
        if (SEM_DEBUG) console.log('🔍 SEMANTIC-TOKENS no service, returning empty')
        return { data: [] }
      }
  
      const doc = documents.get(textDocument.uri)
      if (!doc) {
        if (SEM_DEBUG) console.log('🔍 SEMANTIC-TOKENS no doc, returning empty')
        return { data: [] }
      }
  
      // Ensure latest content is in the TS program before classifying
      await (updating(textDocument) || Promise.resolve())
  
      const tsSuffix = /\.[cm]?[jt]s$|\.json|\.[jt]sx/
      const isPlainTs = sourcePath.match(tsSuffix)
  
      let tsDoc: TextDocument
      let civetDoc: TextDocument | undefined
      let sourcemapLines: SourcemapLines | undefined
      let transpiledPath: string
  
      let coffeeCommentEnabled = false

      if (isPlainTs) {
        tsDoc = doc
        transpiledPath = sourcePath
        if (SEM_DEBUG) console.log('🔍 SEMANTIC-TOKENS processing plain TS/JS file')
      } 
      else {
        if (SEM_DEBUG) console.log('🔍 SEMANTIC-TOKENS processing .civet file')
        const meta = service.host.getMeta(sourcePath)
        if (!meta || !meta.transpiledDoc) {
            if (SEM_DEBUG) console.log('🔍 SEMANTIC-TOKENS no meta/transpiledDoc, returning empty')
            return { data: [] }
          }
          tsDoc = meta.transpiledDoc
          sourcemapLines = meta.sourcemapLines
          civetDoc = doc
          transpiledPath = documentToSourcePath(tsDoc)
          if (SEM_DEBUG) console.log('🔍 SEMANTIC-TOKENS transpiledPath:', transpiledPath)

          const parseOptions = typeof service.getCivetParseOptions === 'function'
            ? service.getCivetParseOptions()
            : {}
          coffeeCommentEnabled = shouldEnableCoffeeComment(parseOptions, civetDoc)
      }
  
      const builder = new SemanticTokensBuilder()
      addSemanticTokensFromTs(builder, service, transpiledPath, tsDoc, sourcemapLines, civetDoc, range, coffeeCommentEnabled)
      
      const result = builder.build()
      if (SEM_DEBUG) console.log(`🔍 SEMANTIC-TOKENS result token count: ${result.data.length / 5} for ${isPlainTs ? 'TS' : 'civet'}`)
      return result
    } 
    catch (e) {
      console.warn('🔍 SEMANTIC-TOKENS failed:', e)
      return { data: [] }
    }
  }
  
  export async function handleSemanticTokensFull(
    params: { textDocument: TextDocumentIdentifier },
    deps: FeatureDeps
  ) {
    return provideSemanticTokens(params, deps)
  }
  
  export async function handleSemanticTokensRange(
    params: { textDocument: TextDocumentIdentifier, range: Range },
    deps: FeatureDeps
  ) {
    return provideSemanticTokens(params, deps)
  }
  
  
  type TokenProvider = (ctx: TokenizerContext) => number[] | undefined
  
  type TokenizerContext = {
    service: any,
    filePath: string,
    start: number,
    length: number,
    format: ts.SemanticClassificationFormat,
  }
  
  const getEncodedSemanticTokens: TokenProvider = (ctx) => {
    const { service, filePath, start, length, format } = ctx
    const info = service.getEncodedSemanticClassifications(filePath, { start, length }, format)
    const spans = extractSpans(info);
    if (!spans || spans.length === 0) return undefined
  
    if (SEM_DEBUG) console.log('🔍 SEM-PROVIDER: Using EncodedSemantic, count:', spans.length / 3)
    return spans
  }
  
  const getFullSemanticTokens: TokenProvider = (ctx) => {
    const { service, filePath, start, length } = ctx
    const classifications = service.getSemanticClassifications(filePath, { start, length })
    if (!classifications || classifications.length === 0) return undefined
  
    if (SEM_DEBUG) console.log('🔍 SEM-PROVIDER: Using FullSemantic, count:', classifications.length)
    // Convert ts.ClassifiedSpan to number[] triplet
    const data: number[] = []
    for (const span of classifications) {
      data.push(span.textSpan.start, span.textSpan.length, span.classificationType)
    }
    return data
  }
  

  const getSyntacticTokens: TokenProvider = (ctx) => {
    const { service, filePath, start, length } = ctx
    const info = service.getEncodedSyntacticClassifications(filePath, { start, length })
    const spans = extractSpans(info);
    if (!spans || spans.length === 0) return undefined

    if (SEM_DEBUG) console.log('🔍 SEM-PROVIDER: Using Syntactic, count:', spans.length / 3)
    return spans
  }
  
  const tokenProviders: TokenProvider[] = [
    getEncodedSemanticTokens,
    getFullSemanticTokens,
    getSyntacticTokens,
  ]
  
  type TokenEntry = {
    line: number
    char: number
    length: number
    tokenType: number
    tokenModifiers: number
  }

  // Token type mapping from TypeScript classification to LSP semantic token types
  // Based on ts.ClassificationType enum values
  // The values are indices in the `tokenTypes` array in `getSemanticLegend`.
  const tsTokenTypeToLspTokenType = new Map<number, number>([
    [0, 2],   // ts.ClassificationType.className -> class
    [1, 3],   // ts.ClassificationType.enumName -> enum  
    [2, 4],   // ts.ClassificationType.interfaceName -> interface
    [3, 0],   // ts.ClassificationType.moduleName -> namespace
    [4, 6],   // ts.ClassificationType.typeParameterName -> typeParameter
    [5, 1],   // ts.ClassificationType.typeAliasName -> type
    [6, 7],   // ts.ClassificationType.parameterName -> parameter
    [7, 8],   // ts.ClassificationType.localName -> variable
    [8, 9],   // ts.ClassificationType.propertyName -> property
    [9, 12],  // ts.ClassificationType.functionName -> function
    [10, 13], // ts.ClassificationType.methodName -> method
    
    // Add missing common classifications
    [11, 8],  // variable (another variant)
    [12, 9],  // property (another variant) 
    [13, 2],  // class (global/built-in classes like Math, Object)
  ]);
  
  function getTokenModifiersFromClassification(tsClassification: number): number {
    return tsClassification & TokenEncodingConsts.modifierMask;
  }
  
  function convertTsTokenModifiersToLsp(tsModifiers: number): number {
    let lspModifiers = 0;
    // This is a direct bitwise mapping, no need for a map
    if (tsModifiers & TsSemanticTokenModifier.declaration) lspModifiers |= (1 << 0);
    if (tsModifiers & TsSemanticTokenModifier.readonly) lspModifiers |= (1 << 2);
    if (tsModifiers & TsSemanticTokenModifier.static) lspModifiers |= (1 << 3);
    if (tsModifiers & TsSemanticTokenModifier.deprecated) lspModifiers |= (1 << 4);
    if (tsModifiers & TsSemanticTokenModifier.abstract) lspModifiers |= (1 << 5);
    if (tsModifiers & TsSemanticTokenModifier.async) lspModifiers |= (1 << 6);
    if (tsModifiers & TsSemanticTokenModifier.defaultLibrary) lspModifiers |= (1 << 9);
    return lspModifiers;
  }
  
  function findAncestor<T extends ts.Node>(node: ts.Node, predicate: (node: ts.Node) => node is T): T | undefined
  function findAncestor(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined
  function findAncestor(node: ts.Node, predicate: ((node: ts.Node) => boolean) | ((node: ts.Node) => node is ts.Node)) {
    let current: ts.Node | undefined = node
    while (current) {
      if ((predicate as (n: ts.Node) => boolean)(current)) return current
      current = current.parent
    }
    return undefined
  }
  
  // ==========================
  // Refinement Rules Engine
  // ==========================
  
  type RefinementLegend = {
    namespace: number
    type: number
    class: number
    enum: number
    interface: number
    struct: number
    typeParameter: number
    parameter: number
    variable: number
    property: number
    enumMember: number
    event: number
    function: number
    method: number
    macro: number
    label: number
  }
  
  type RefinementContext = {
    checker: ts.TypeChecker
    sourceFile: ts.SourceFile
    tokenStart: number
    initialTokenType: number
    legend: RefinementLegend
    idNode: ts.Identifier | undefined
    symbol: ts.Symbol | undefined
  }
  
  type RefinementRule = (ctx: RefinementContext) => number | undefined
  
  // PERFORMANCE: Hoisted to module scope to avoid rebuilding per token
  const REFINEMENT_LEGEND: RefinementLegend = (() => {
    const legend = SEMANTIC_LEGEND
    const idx = (name: string) => legend.tokenTypes.indexOf(name)
    return {
      namespace: idx('namespace'),
      type: idx('type'),
      class: idx('class'),
      enum: idx('enum'),
      interface: idx('interface'),
      struct: idx('struct'),
      typeParameter: idx('typeParameter'),
      parameter: idx('parameter'),
      variable: idx('variable'),
      property: idx('property'),
      enumMember: idx('enumMember'),
      event: idx('event'),
      function: idx('function'),
      method: idx('method'),
      macro: idx('macro'),
      label: idx('label'),
    }
  })()
  
  // Removed enrichContext - build full context directly in main function
  
  // Helper: is ctx.idNode inside a node
  function nodeContains(outer: ts.Node, inner: ts.Node) {
    return inner.pos >= outer.pos && inner.end <= outer.end
  }
  
  // Rule: NamespaceLikeSymbolRule
  // Map value-modules/namespaces/classes/interfaces to their semantic kinds
  const NamespaceLikeSymbolRule: RefinementRule = (ctx) => {
    const { symbol, legend, initialTokenType } = ctx
    if (!symbol) return undefined
    // Only adjust identifiers that TS often marks as variable
    // Guard to avoid fighting correct classifications
    const isInitiallyVariable = initialTokenType === legend.variable
    if (!isInitiallyVariable) {
      // Allow upgrading method/function/property if clearly namespace/class/interface
      // but primarily target variable → namespace/class/interface
    }
    if (symbol.flags & ts.SymbolFlags.ValueModule) return legend.namespace
    if (symbol.flags & ts.SymbolFlags.Class) return legend.class
    if ((symbol.flags & ts.SymbolFlags.Interface) && !(symbol.flags & ts.SymbolFlags.Variable)) return legend.interface
    return undefined
  }
  
  // Rule: ParameterNameRule
  const ParameterNameRule: RefinementRule = (ctx) => {
    const { idNode, legend } = ctx
    if (!idNode) return undefined
    const paramDecl = findAncestor(idNode, ts.isParameter)
    if (paramDecl && nodeContains(paramDecl.name, idNode)) return legend.parameter
    return undefined
  }
  
  // Rule: BindingNameRule (variable/parameter/for-of binding identifiers)
  const BindingNameRule: RefinementRule = (ctx) => {
    const { idNode, legend } = ctx
    if (!idNode) return undefined
    // Variable declaration binding
    const varDecl = findAncestor(idNode, ts.isVariableDeclaration)
    if (varDecl && (ts.isObjectBindingPattern(varDecl.name) || ts.isArrayBindingPattern(varDecl.name)) && nodeContains(varDecl.name, idNode)) {
      return legend.variable
    }
    // Destructuring assignment pattern: binary expr with object/array literal on the left
    const objLit = findAncestor(idNode, ts.isObjectLiteralExpression)
    if (objLit && ts.isBinaryExpression(objLit.parent) && objLit.parent.left === objLit && objLit.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return legend.variable
    }
    const arrLit = findAncestor(idNode, ts.isArrayLiteralExpression)
    if (arrLit && ts.isBinaryExpression(arrLit.parent) && arrLit.parent.left === arrLit && arrLit.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return legend.variable
    }
    return undefined
  }
  
  // Rule: ObjectMemberNameRule (object literal members)
  const ObjectMemberNameRule: RefinementRule = (ctx) => {
    const { idNode, legend } = ctx
    if (!idNode) return undefined
      const parent = idNode.parent
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === idNode) return legend.property
    if (ts.isPropertyAssignment(parent) && parent.name === idNode) return legend.property
    if (ts.isMethodDeclaration(parent) && parent.name === idNode) return legend.method
    if (ts.isGetAccessorDeclaration(parent) && parent.name === idNode) return legend.property
    if (ts.isSetAccessorDeclaration(parent) && parent.name === idNode) return legend.property
    return undefined
  }
  
  // Rule: PromoteCallablePropertyToMethodRule (function-valued object properties → method)
  const PromoteCallablePropertyToMethodRule: RefinementRule = (ctx) => {
    const { symbol, checker, idNode, legend, initialTokenType } = ctx
    if (!symbol || !idNode) return undefined
  
    // Only apply to tokens TypeScript initially classified as variables (property names in objects)
    if (initialTokenType !== legend.variable) return undefined
    
    // Check if it's part of an object literal property assignment
    const parent = idNode.parent
    if (!ts.isPropertyAssignment(parent) || parent.name !== idNode) return undefined
    
    // Make sure we're in an object literal (not interface/type declarations)
    if (!findAncestor(idNode, ts.isObjectLiteralExpression)) return undefined
  
    // Use the type checker to determine if this property's value is callable
    const type = checker.getTypeOfSymbolAtLocation(symbol, idNode)
    if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0) {
      return legend.method
    }
    
    // If not callable, fall through to let ObjectMemberNameRule handle it as property
    return undefined
  }
  
  // Rule: PropertyAccessMemberRule (a.b: refine b based on symbol flags)
  const PropertyAccessMemberRule: RefinementRule = (ctx) => {
    const { idNode, symbol, legend } = ctx
    if (!idNode || !symbol) return undefined
    if (ts.isPropertyAccessExpression(idNode.parent) && idNode.parent.name === idNode) {
      if (symbol.flags & ts.SymbolFlags.Method) return legend.method
      if (symbol.flags & ts.SymbolFlags.Function) return legend.function
      if (symbol.flags & ts.SymbolFlags.Property) return legend.property
    }
    return undefined
  }
  
  // Rule: MethodLikeSymbolRule (prefer method over function/property when method flag present)
  const MethodLikeSymbolRule: RefinementRule = (ctx) => {
    const { symbol, legend } = ctx
    if (!symbol) return undefined
    if (symbol.flags & ts.SymbolFlags.Method) return legend.method
    return undefined
  }
  
  // Rule: CallableValueRule (variables/properties that are callable → function)
  const CallableValueRule: RefinementRule = (ctx) => {
    const { symbol, checker, idNode, legend, initialTokenType } = ctx
    if (!symbol || !idNode) return undefined
    // Only consider when initially not already method
    if (initialTokenType !== legend.variable && initialTokenType !== legend.property && initialTokenType !== legend.function) return undefined
    const type = checker.getTypeOfSymbolAtLocation(symbol, idNode)
    if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0) return legend.function
    return undefined
  }
  
  // Rule: DemoteNonCallableFunctionRule (if TS said function but it's not callable)
  const DemoteNonCallableFunctionRule: RefinementRule = (ctx) => {
    const { symbol, checker, idNode, legend, initialTokenType } = ctx
    if (!symbol || !idNode) return undefined
    if (initialTokenType !== legend.function) return undefined
    const type = checker.getTypeOfSymbolAtLocation(symbol, idNode)
    const hasCall = checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0
    if (hasCall) return undefined
    if (symbol.flags & ts.SymbolFlags.Property) return legend.property
    return legend.variable
  }
  
  // Rule: EnumMemberNameRule
  const EnumMemberNameRule: RefinementRule = (ctx) => {
    const { idNode, legend } = ctx
    if (!idNode) return undefined
    const parent = idNode.parent
    if (ts.isEnumMember(parent) && parent.name === idNode) return legend.enumMember
    return undefined
  }
  
  const REFINEMENT_RULES: RefinementRule[] = [
    NamespaceLikeSymbolRule,
    ParameterNameRule,
    BindingNameRule,
    EnumMemberNameRule,
    PromoteCallablePropertyToMethodRule,
    ObjectMemberNameRule,
    PropertyAccessMemberRule,
    MethodLikeSymbolRule,
    CallableValueRule,
    DemoteNonCallableFunctionRule,
  ]
  
  function refineTokenTypeWithRules(
    initialTokenType: number,
    checker: ts.TypeChecker,
    sourceFile: ts.SourceFile,
    tokenStart: number,
  ): number | undefined {
    // Build full context directly - no enrichContext layer
    const node = findNodeAtPosition(sourceFile, tokenStart)
    if (!node) return undefined
    const idNode = ts.isIdentifier(node) ? node : node.getChildren().find(ts.isIdentifier)
    if (!idNode) return undefined
    const symbol = checker.getSymbolAtLocation(idNode)
    
    const ctx: RefinementContext = { 
      checker, 
      sourceFile, 
      tokenStart, 
      initialTokenType, 
      legend: REFINEMENT_LEGEND, 
      idNode, 
      symbol 
    }
    
    // No cowardly try...catch - let garbage rules crash and burn
    for (const rule of REFINEMENT_RULES) {
      const refined = rule(ctx)
      if (refined !== undefined) return refined
    }
    return undefined
  }
  
  // Old monolithic refinement removed in favor of rules engine
  
  function addSemanticTokensFromTs(
    builder: SemanticTokensBuilder,
    service: Awaited<ReturnType<any>>,
    filePath: string,
    tsDoc: TextDocument,
    sourcemapLines?: SourcemapLines,
    civetDoc?: TextDocument,
    onlyRange?: Range,
    coffeeCommentEnabled = false,
  ) {
    const program = service.getProgram()
    const sourceFile = program?.getSourceFile(filePath)
    if (!sourceFile) {
      console.warn('🔍 SEMANTIC-TOKENS: file not in program, cannot provide tokens.', filePath)
      return
    }
  
    let start = 0
    let length = tsDoc.getText().length
    if (onlyRange) {
      start = tsDoc.offsetAt(onlyRange.start)
      length = tsDoc.offsetAt(onlyRange.end) - start
    }
  
    const tokenizerContext: TokenizerContext = {
      service,
      filePath,
      start,
      length,
      format: ts.SemanticClassificationFormat.TwentyTwenty,
    }
  
    // DEBUG: Add debugging flag to diagnose issues
    const DEBUG_TOKENS = semDebug.tokens;
    
    // PERFORMANCE TRACKING: Detailed timing breakdown
    const perfTimings = {
      total: performance.now(),
      provider: 0,
      processing: 0,
      refinement: 0,
      building: 0
    }
    
    const providerStart = performance.now()
    let data: number[] | undefined;
    let providerName = 'None';
    for (const provider of tokenProviders) {
      try {
        data = provider(tokenizerContext);
        if (data && data.length > 0) {
          providerName = provider.name;
          break
        }
      } catch (e) {
        if (SEM_DEBUG) console.warn(`🔍 SEM-PROVIDER: Provider ${provider.name} failed`, e)
      }
    }
    perfTimings.provider = performance.now() - providerStart
  
    if (!data || data.length === 0) {
      console.warn('🔍 SEMANTIC-TOKENS: All providers failed to return tokens.')
      return
    }
  
    const tsTokenCount = data.length / 3
    if (SEM_DEBUG) {
      console.log(`🔍 SEMANTIC-TOKENS: Processing ${tsTokenCount} tokens from ${providerName}`)
      if (!REFINEMENT_ENABLED) {
        console.log(`🔍 TRUST-TS: Refinement DISABLED - trusting TypeScript Service completely`)
      }
    }
  
  
  
    // data triplets: [start, length, classification]
    const checker = program!.getTypeChecker()
    
    const processingStart = performance.now()
    let refinementCalls = 0
    let refinementHits = 0
    
    // Pre-check if we need detailed logging to avoid per-token overhead
    const needsDetailedLogging = SEM_LOG_ALL
    const markerDetails: any[] = []
    const tokenEntries: TokenEntry[] = []
    
    for (let i = 0; i < data.length; i += 3) {
      const tokenStart = data[i]
      const tokenLen = data[i + 1]
      const classif = data[i + 2]
  
      const startPosTs = tsDoc.positionAt(tokenStart)
      const endPosTs = tsDoc.positionAt(tokenStart + tokenLen)
  
      let startPos = startPosTs
      let endPos = endPosTs
      if (sourcemapLines && civetDoc) {
        startPos = remapPosition(startPosTs, sourcemapLines)
        endPos = remapPosition(endPosTs, sourcemapLines)
      }
  
      const encodedTypeNum = getTokenTypeFromClassification(classif)
      let tokenType = tsTokenTypeToLspTokenType.get(encodedTypeNum)
      if (tokenType === undefined) {
        const skippedText = tsDoc.getText().slice(tokenStart, tokenStart + tokenLen)
        
        if (DEBUG_TOKENS) {
          console.log(`🚨 SKIPPING [${skippedText}]: RAW_CLASSIF=${classif} -> encodedType=${encodedTypeNum} (NO MAPPING!)`)
        }
        continue
      }
  
      const tokenModifiers = getTokenModifiersFromClassification(classif)
      const lspTokenModifiers = convertTsTokenModifiersToLsp(tokenModifiers)
      const tokenText = tsDoc.getText().slice(tokenStart, tokenStart + tokenLen)
      
      // POSITION MAPPING DEBUG: Log position remapping for contentCache and other problematic tokens
      if (SEM_DEBUG && (tokenText.includes('contentCache') || tokenText.includes('@co') || tokenText.startsWith('@c') || isMarkerIdentifier(tokenText))) {
        console.log(`[POSITION-DEBUG] Token "${tokenText}" at TS pos ${tokenStart}-${tokenStart + tokenLen} (${startPosTs.line}:${startPosTs.character}-${endPosTs.line}:${endPosTs.character})`)
        if (sourcemapLines && civetDoc) {
          console.log(`[POSITION-DEBUG] Remapped to Civet pos (${startPos.line}:${startPos.character}-${endPos.line}:${endPos.character})`)
          const civetText = civetDoc.getText().slice(civetDoc.offsetAt(startPos), civetDoc.offsetAt(endPos))
          console.log(`[POSITION-DEBUG] Civet text at remapped position: "${civetText}"`)
        }
      }
      
      if (SEM_DEBUG && isMarkerIdentifier(tokenText)) {
        console.log(`[INSPECT] Initial classification for "${tokenText}": type=${lspTypeIndexToName(tokenType)}, mods=${modifierMaskToNames(lspTokenModifiers)}`)
      }
      
      if (DEBUG_TOKENS) {
        console.log(`🔍 DEBUG [${tokenText}]: RAW_CLASSIF=${classif} -> encodedType=${encodedTypeNum} -> lspType=${tokenType} (${lspTypeIndexToName(tokenType)})`)
        console.log(`🔍 DEBUG [${tokenText}]: pos=${tokenStart}, len=${tokenLen}, mods=${tokenModifiers}`)
      }
  
      // Apply smart refinement only where needed (unless disabled by feature flag)
      let refined: number | undefined;
      if (REFINEMENT_ENABLED) {
        const refinementStart = performance.now()
        refined = refineTokenTypeWithRules(
        tokenType,
        checker,
        sourceFile,
        tokenStart,
      )
      perfTimings.refinement += performance.now() - refinementStart
      refinementCalls++
      
      if (refined !== undefined) {
        if (DEBUG_TOKENS) {
          console.log(`🔍 DEBUG [${tokenText}]: REFINED ${lspTypeIndexToName(tokenType)} -> ${lspTypeIndexToName(refined)}`)
        }
        tokenType = refined
        refinementHits++
        }
      } else {
        // Refinement disabled - trusting TS Service completely
        if (SEM_DEBUG && isMarkerIdentifier(tokenText)) {
          console.log(`[TRUST-TS] Skipping refinement for "${tokenText}" - trusting TS Service classification: ${lspTypeIndexToName(tokenType)}`)
        }
      }
  
      if (SEM_DEBUG && isMarkerIdentifier(tokenText)) {
        const wasRefined = REFINEMENT_ENABLED && (refined !== undefined)
        console.log(`[INSPECT] Final classification for "${tokenText}": type=${lspTypeIndexToName(tokenType)}, refined=${wasRefined}`)
      }
  
      // Collect logging data efficiently
      if (needsDetailedLogging || isMarkerIdentifier(tokenText)) {
        const wasRefined = REFINEMENT_ENABLED && (refined !== undefined)
        markerDetails.push({
          text: tokenText,
          pos: tokenStart,
          len: tokenLen,
          type: lspTypeIndexToName(tokenType),
          mods: modifierMaskToNames(lspTokenModifiers),
          refined: wasRefined,
          refinementDisabled: !REFINEMENT_ENABLED,
        })
      }
      
      if (endPos.line !== startPos.line) {
        continue
      }
      const tokenLength = endPos.character - startPos.character
      if (tokenLength <= 0) {
        continue
      }

      tokenEntries.push({
        line: startPos.line,
        char: startPos.character,
        length: tokenLength,
        tokenType,
        tokenModifiers: lspTokenModifiers,
      })
    }
    if (coffeeCommentEnabled && civetDoc && COMMENT_TOKEN_TYPE !== -1) {
      appendCoffeeCommentTokens(tokenEntries, civetDoc, onlyRange, COMMENT_TOKEN_TYPE)
    }

    perfTimings.processing = performance.now() - processingStart
    
    // Output collected logs if needed
    if (markerDetails.length > 0) {
      if (SEM_LOG_ALL) {
        console.log(`🔧 [SMART-REFINE] Batch logging ${markerDetails.length} marked tokens:`)
        markerDetails.forEach(detail => {
          console.log('[SEM]', JSON.stringify(detail))
        })
      }
    }
    
    tokenEntries.sort((a, b) => a.line === b.line ? a.char - b.char : a.line - b.line)

    const dedupedTokens: TokenEntry[] = []
    for (const entry of tokenEntries) {
      const prev = dedupedTokens[dedupedTokens.length - 1]
      if (prev && prev.line === entry.line && prev.char === entry.char && prev.length === entry.length && prev.tokenType === entry.tokenType && prev.tokenModifiers === entry.tokenModifiers) {
        continue
      }
      dedupedTokens.push(entry)
    }

    const buildingStart = performance.now()
    for (const entry of dedupedTokens) {
      builder.push(entry.line, entry.char, entry.length, entry.tokenType, entry.tokenModifiers)
    }
    perfTimings.building = performance.now() - buildingStart

    perfTimings.total = performance.now() - perfTimings.total

    const finalTokenCount = dedupedTokens.length
    
    // PERFORMANCE REPORT
    if (SEM_PERF) {
      console.log(`🚀 SEMANTIC-TOKENS PERFORMANCE REPORT:`)
      console.log(`  📊 Total: ${perfTimings.total.toFixed(2)}ms | Tokens: ${finalTokenCount} (TS provider ${tsTokenCount}) | Provider: ${providerName}`)
      console.log(`  🔍 Provider: ${perfTimings.provider.toFixed(2)}ms (${(perfTimings.provider/perfTimings.total*100).toFixed(1)}%)`)
      console.log(`  ⚙️  Processing: ${perfTimings.processing.toFixed(2)}ms (${(perfTimings.processing/perfTimings.total*100).toFixed(1)}%)`)
      if (!REFINEMENT_ENABLED) {
        console.log(`    🔧 Refinement: DISABLED (trusting TS Service completely)`)
      } 
      else {
        const refinementPct = perfTimings.processing > 0 ? (perfTimings.refinement/perfTimings.processing*100).toFixed(1) : '0.0'
        console.log(`    🔧 Refinement: ${perfTimings.refinement.toFixed(2)}ms of processing (${refinementPct}%, ${refinementCalls} calls, ${refinementHits} hits)`)
      }
      console.log(`  🏗️  Building: ${perfTimings.building.toFixed(2)}ms (${(perfTimings.building/perfTimings.total*100).toFixed(1)}%)`)
      console.log(`  ⚡ Throughput: ${(finalTokenCount / perfTimings.total * 1000).toFixed(0)} tokens/sec`)
    }
  }
  
  // Find the deepest node containing a position
  function findNodeAtPosition(node: ts.Node, pos: number): ts.Node | undefined {
    if (pos < node.getStart() || pos >= node.getEnd()) return undefined
    for (const child of node.getChildren()) {
      const found = findNodeAtPosition(child, pos)
      if (found) return found
    }
    return node
  }

  type DirectiveToggle = { name: string, value: boolean }

  function shouldEnableCoffeeComment(parseOptions: any, civetDoc?: TextDocument): boolean {
    let enabled = !!(parseOptions?.coffeeComment || parseOptions?.coffeeCompat)
    if (!civetDoc) return enabled

    const toggles = extractDirectiveToggles(civetDoc)
    for (const toggle of toggles) {
      if (toggle.name === 'coffeeCompat') {
        enabled = toggle.value
      } else if (toggle.name === 'coffeeComment') {
        enabled = toggle.value
      }
    }
    return enabled
  }

  function extractDirectiveToggles(doc: TextDocument): DirectiveToggle[] {
    const toggles: DirectiveToggle[] = []
    const text = doc.getText()
    const lines = text.split(/\r?\n/)

    for (const line of lines) {
      const trimmed = line.trimStart()
      if (!trimmed) continue

      const match = trimmed.match(/^['"]civet\b([^'"]*)['"]/)
      if (!match) {
        if (trimmed.startsWith('//') || trimmed.startsWith('/*')) {
          continue
        }
        break
      }

      const optionsChunk = match[1]?.trim() ?? ''
      if (!optionsChunk) continue
      const tokens = optionsChunk.split(/\s+/).filter(Boolean)
      for (const token of tokens) {
        const parsed = parseDirectiveToken(token)
        if (parsed) toggles.push(parsed)
      }
    }

    return toggles
  }

  function parseDirectiveToken(raw: string): DirectiveToggle | undefined {
    if (!raw) return

    let token = raw
    let explicitValue: boolean | undefined

    if (token.includes('=')) {
      const [lhs, rhs] = token.split('=', 2)
      token = lhs
      const normalized = rhs?.trim()
      if (!normalized) return
      explicitValue = !/^(false|0|off)$/i.test(normalized)
    }

    let sign: string | undefined
    if (token.startsWith('+') || token.startsWith('-')) {
      sign = token[0]
      token = token.slice(1)
    }

    const name = token.replace(/-+([a-z]?)/g, (_match, letter) => letter ? letter.toUpperCase() : '')
    if (!name) return

    let value: boolean
    if (explicitValue !== undefined) {
      value = explicitValue
    } else if (sign) {
      value = sign !== '-'
    } else {
      value = true
    }

    return { name, value }
  }

  function appendCoffeeCommentTokens(
    entries: TokenEntry[],
    civetDoc: TextDocument,
    onlyRange: Range | undefined,
    commentTokenType: number,
  ) {
    const text = civetDoc.getText()
    let startOffset = 0
    let endOffset = text.length
    if (onlyRange) {
      startOffset = civetDoc.offsetAt(onlyRange.start)
      endOffset = civetDoc.offsetAt(onlyRange.end)
    }

    const comments = findCoffeeCommentOffsets(text, startOffset, endOffset)
    for (const { start, end } of comments) {
      const startPos = civetDoc.positionAt(start)
      const endPos = civetDoc.positionAt(end)
      if (endPos.line !== startPos.line) continue
      const length = endPos.character - startPos.character
      if (length <= 0) continue

      entries.push({
        line: startPos.line,
        char: startPos.character,
        length,
        tokenType: commentTokenType,
        tokenModifiers: 0,
      })
    }
  }

  function findCoffeeCommentOffsets(text: string, startOffset: number, endOffset: number) {
    const results: { start: number, end: number }[] = []
    let idx = startOffset
    let inString: string | null = null
    let escapeNext = false
    
    while (idx < endOffset) {
      const char = text[idx]
      
      // Handle escape sequences in strings
      if (inString && escapeNext) {
        escapeNext = false
        idx++
        continue
      }
      
      if (inString) {
        if (char === '\\') {
          escapeNext = true
          idx++
          continue
        }
        // Check for end of string (either single char or triple)
        if (inString.length === 3) {
          // Triple-quoted string
          if (text.slice(idx, idx + 3) === inString) {
            inString = null
            idx += 3
            continue
          }
        } else {
          // Single-quoted string
          if (char === inString) {
            inString = null
            idx++
            continue
          }
        }
        idx++
        continue
      }
      
      // Track entering string literals (check triple first)
      if (text.slice(idx, idx + 3) === '"""' || text.slice(idx, idx + 3) === "'''") {
        inString = text.slice(idx, idx + 3)
        idx += 3
        continue
      }
      if (char === '"' || char === "'" || char === '`') {
        inString = char
        idx++
        continue
      }
      
      // Found '#' outside of strings
      if (char === '#' && isCoffeeCommentStart(text, idx)) {
        let end = text.indexOf('\n', idx)
        if (end === -1 || end > endOffset) {
          end = endOffset
        }
        if (end > idx && text.charCodeAt(end - 1) === 13) {
          end -= 1
        }
        if (end > idx) {
          results.push({ start: idx, end })
        }
        idx = end + 1
        inString = null // Reset string state after comment
        continue
      }
      
      idx++
    }
    return results
  }

  function isCoffeeCommentStart(text: string, index: number): boolean {
    const prevChar = index === 0 ? '\n' : text[index - 1]
    if (prevChar !== '\n' && !/\s/.test(prevChar)) return false

    let lookBehind = index - 1
    while (lookBehind >= 0 && text[lookBehind] === ' ') {
      lookBehind--
    }
    if (lookBehind >= 0 && text[lookBehind] === '.') return false

    const nextChar = text[index + 1]
    if (nextChar === '{' || nextChar === '#') return false
    
    // If followed by an identifier character, it's a private field like #privateField
    if (nextChar && /[a-zA-Z_$]/.test(nextChar)) return false

    const after = text.slice(index + 1)
    if (/^\s*\//.test(after)) return false
    if (/^\s*\]/.test(after)) return false

    return true
  }
  