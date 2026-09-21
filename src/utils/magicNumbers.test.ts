/** @vitest-environment node */
/**
 * Guards item B1 (one home for every cap/threshold): a handful of length caps
 * and gameplay thresholds used to be repeated as bare literals beside a named
 * constant that already existed for the same rule. Each check below reads the
 * real source file and fails if the old duplicate literal is still there —
 * not merely that a constant with the right name exists somewhere.
 *
 * Deliberately structural source checks, in the style of bundleSplit.test.ts:
 * most are source-text assertions, and the shared helper below follows real
 * imports so a file must use the named constant instead of merely importing it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import * as ts from 'typescript';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (relPath: string): string => fs.readFileSync(path.join(ROOT, relPath), 'utf8');
const CONFIG_VALIDATION_MODULE = '../src/utils/configValidation';
const TYPES_MODULE = '../src/types';
const DEVICE_ID_LIMIT = 200;
const LEGACY_DEVICE_ID_LIMIT_LITERAL = '200';
const LEGACY_CHAIN_CARD_LIMIT_LITERAL = '100';

const parse = (source: string): ts.SourceFile =>
  ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const importedLocalName = (source: string, modulePath: string, importedName: string): string | null => {
  let localName: string | null = null;
  const visit = (node: ts.Node): void => {
    if (localName) return;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === modulePath) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (imported === importedName) {
            localName = element.name.text;
            return;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source));
  return localName;
};

const unwrapParentheses = (node: ts.Expression): ts.Expression => {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
};

const propertyAccessPath = (node: ts.Expression): string | null => {
  const unwrapped = unwrapParentheses(node);
  if (ts.isIdentifier(unwrapped)) return unwrapped.text;
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const base = propertyAccessPath(unwrapped.expression);
    return base ? `${base}.${unwrapped.name.text}` : null;
  }
  return null;
};

const boundaryComparisonRhsSpan = (
  source: string,
  modulePath: string,
  importedName: string,
  guardedExpression: string,
  operator: ts.SyntaxKind,
): { start: number; end: number } | null => {
  const localName = importedLocalName(source, modulePath, importedName);
  if (localName === null) return null;
  const sourceFile = parse(source);
  let span: { start: number; end: number } | null = null;
  const visit = (node: ts.Node): void => {
    if (span || !ts.isBinaryExpression(node) || node.operatorToken.kind !== operator) {
      ts.forEachChild(node, visit);
      return;
    }
    const left = unwrapParentheses(node.left);
    const right = unwrapParentheses(node.right);
    if (propertyAccessPath(left) === guardedExpression &&
        ts.isIdentifier(right) && right.text === localName) {
      span = { start: right.getStart(sourceFile), end: right.getEnd() };
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return span;
};

const importsAndComparesBoundary = (
  source: string,
  modulePath: string,
  importedName: string,
  guardedExpression: string,
  operator: ts.SyntaxKind,
): boolean => boundaryComparisonRhsSpan(source, modulePath, importedName, guardedExpression, operator) !== null;

const replaceBoundaryComparisonRhs = (
  source: string,
  modulePath: string,
  importedName: string,
  guardedExpression: string,
  operator: ts.SyntaxKind,
  replacement: string,
): string => {
  const span = boundaryComparisonRhsSpan(source, modulePath, importedName, guardedExpression, operator);
  if (!span) throw new Error(`No boundary comparison found for ${guardedExpression}`);
  return `${source.slice(0, span.start)}${replacement}${source.slice(span.end)}`;
};

const exportsConstInitializedToNumber = (source: string, name: string, value: number): boolean => {
  const sourceFile = parse(source);
  let matches = false;
  const visit = (node: ts.Node): void => {
    if (matches) return;
    if (ts.isVariableStatement(node) &&
        (node.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
        node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of node.declarationList.declarations) {
        const initializer = declaration.initializer ? unwrapParentheses(declaration.initializer) : undefined;
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name &&
            initializer && ts.isNumericLiteral(initializer) && Number(initializer.text) === value) {
          matches = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matches;
};

describe('length caps share one constant instead of a duplicated literal', () => {
  it('the structural source helper follows aliases and rejects equal literals', () => {
    const aliased = "import { MAX_PLAYER_NAME_LENGTH as NAME_LIMIT } from '../src/utils/configValidation';\nif (((name /* keep readable */ . length)) > (NAME_LIMIT)) throw new Error();";
    const literal = "import { MAX_PLAYER_NAME_LENGTH } from '../src/utils/configValidation';\nif (name.length > 30) throw new Error();";

    expect(importsAndComparesBoundary(
      aliased, CONFIG_VALIDATION_MODULE, 'MAX_PLAYER_NAME_LENGTH', 'name.length', ts.SyntaxKind.GreaterThanToken
    )).toBe(true);
    expect(importsAndComparesBoundary(
      literal, CONFIG_VALIDATION_MODULE, 'MAX_PLAYER_NAME_LENGTH', 'name.length', ts.SyntaxKind.GreaterThanToken
    )).toBe(false);
  });

  it('the structural source helper fails when the actual protected guard falls back to its equal literal', () => {
    const src = read('server/turnPayloadValidation.ts');
    const mutated = replaceBoundaryComparisonRhs(
      src,
      TYPES_MODULE,
      'MAX_CHAIN_CARDS',
      's.deductedPlayers.length',
      ts.SyntaxKind.GreaterThanToken,
      LEGACY_CHAIN_CARD_LIMIT_LITERAL
    );

    expect(importsAndComparesBoundary(
      src, TYPES_MODULE, 'MAX_CHAIN_CARDS', 's.deductedPlayers.length', ts.SyntaxKind.GreaterThanToken
    )).toBe(true);
    expect(importsAndComparesBoundary(
      mutated, TYPES_MODULE, 'MAX_CHAIN_CARDS', 's.deductedPlayers.length', ts.SyntaxKind.GreaterThanToken
    )).toBe(false);
  });

  it('the boundary mutator follows aliases and formatted guards instead of raw source spelling', () => {
    const formatted = "import { MAX_CHAIN_CARDS as CHAIN_LIMIT } from '../src/types';\nif (((s /* comment */ . deductedPlayers).length) > (CHAIN_LIMIT)) throw new Error();";
    const mutated = replaceBoundaryComparisonRhs(
      formatted,
      TYPES_MODULE,
      'MAX_CHAIN_CARDS',
      's.deductedPlayers.length',
      ts.SyntaxKind.GreaterThanToken,
      LEGACY_CHAIN_CARD_LIMIT_LITERAL
    );

    expect(mutated).toContain(`> (${LEGACY_CHAIN_CARD_LIMIT_LITERAL})`);
    expect(importsAndComparesBoundary(
      formatted, TYPES_MODULE, 'MAX_CHAIN_CARDS', 's.deductedPlayers.length', ts.SyntaxKind.GreaterThanToken
    )).toBe(true);
    expect(importsAndComparesBoundary(
      mutated, TYPES_MODULE, 'MAX_CHAIN_CARDS', 's.deductedPlayers.length', ts.SyntaxKind.GreaterThanToken
    )).toBe(false);
  });

  it('socketRoomHandlers.joinRoom validates against the shared constants, not bare numbers', () => {
    const src = read('server/socketRoomHandlers.ts');
    expect(src).not.toMatch(/roomId\.length > 100/);
    expect(src).not.toMatch(/deviceId\.length > 200/);
    expect(src).not.toMatch(/name\.length > 30/);
    expect(importsAndComparesBoundary(
      src, CONFIG_VALIDATION_MODULE, 'MAX_ROOM_ID_LENGTH', 'roomId.length', ts.SyntaxKind.GreaterThanToken
    )).toBe(true);
    expect(importsAndComparesBoundary(
      src, CONFIG_VALIDATION_MODULE, 'MAX_DEVICE_ID_LENGTH', 'deviceId.length', ts.SyntaxKind.GreaterThanToken
    )).toBe(true);
    expect(importsAndComparesBoundary(
      src, CONFIG_VALIDATION_MODULE, 'MAX_PLAYER_NAME_LENGTH', 'name.length', ts.SyntaxKind.GreaterThanToken
    )).toBe(true);
  });

  it('configValidation exports MAX_DEVICE_ID_LENGTH beside the other two length caps', () => {
    const src = read('src/utils/configValidation.ts');
    expect(exportsConstInitializedToNumber(src, 'MAX_DEVICE_ID_LENGTH', DEVICE_ID_LIMIT)).toBe(true);
    expect(exportsConstInitializedToNumber(
      `export const MAX_DEVICE_ID_LENGTH /* keep with room validation */ =\n  ${LEGACY_DEVICE_ID_LIMIT_LITERAL};`,
      'MAX_DEVICE_ID_LENGTH',
      DEVICE_ID_LIMIT
    )).toBe(true);
    expect(exportsConstInitializedToNumber(
      `export let MAX_DEVICE_ID_LENGTH = ${LEGACY_DEVICE_ID_LIMIT_LITERAL};`,
      'MAX_DEVICE_ID_LENGTH',
      DEVICE_ID_LIMIT
    )).toBe(false);
  });

  it('turnPayloadValidation imports MAX_PLAYER_NAME_LENGTH instead of redeclaring it', () => {
    const src = read('server/turnPayloadValidation.ts');
    expect(src).not.toMatch(/const MAX_PLAYER_NAME_LENGTH = 30;/);
    expect(importsAndComparesBoundary(
      src, CONFIG_VALIDATION_MODULE, 'MAX_PLAYER_NAME_LENGTH', 'n.length', ts.SyntaxKind.LessThanEqualsToken
    )).toBe(true);
  });

  it('turnPayloadValidation reuses MAX_CHAIN_CARDS for turn-summary lists', () => {
    const src = read('server/turnPayloadValidation.ts');
    expect(src).not.toMatch(/deductedPlayers\.length > 100/);
    expect(importsAndComparesBoundary(
      src, TYPES_MODULE, 'MAX_CHAIN_CARDS', 's.deductedPlayers.length', ts.SyntaxKind.GreaterThanToken
    )).toBe(true);
  });

  it('api.ts imports MAX_DEVICE_ID_LENGTH instead of redeclaring it', () => {
    const src = read('server/api.ts');
    expect(src).not.toMatch(/const MAX_DEVICE_ID_LENGTH = 200;/);
    expect(src).toMatch(/import\s*\{[^}]*MAX_DEVICE_ID_LENGTH[^}]*\}\s*from\s*['"]\.\.\/src\/utils\/configValidation['"]/s);
  });
});

describe('gameplay thresholds share one constant instead of a duplicated literal', () => {
  it('Scoreboard reads the turn-urgency threshold from uiTimings, not a bare 10', () => {
    const src = read('src/components/game/Scoreboard.tsx');
    expect(src).not.toMatch(/turnTimeRemaining <= 10\b/);
    expect(src).toMatch(/turnTimeRemaining <= TURN_URGENT_SECONDS/);
    expect(src).toMatch(/import\s*\{[^}]*TURN_URGENT_SECONDS[^}]*\}\s*from\s*['"]\.\.\/\.\.\/utils\/uiTimings['"]/s);
  });

  it('Game.tsx gates the urgency haptic off the named threshold', () => {
    const src = read('src/components/Game.tsx');
    expect(src).not.toMatch(/turnTimeRemaining <= 10\)/);
    expect(src).toMatch(/turnTimeRemaining <= TURN_URGENT_SECONDS\)/);
  });

  it('Leaderboard shows the streak badge off HOT_WIN_STREAK (the badge moved there from Game.tsx)', () => {
    const src = read('src/components/game/Leaderboard.tsx');
    expect(src).not.toMatch(/streak >= 3\b/);
    expect(src).toMatch(/streak >= HOT_WIN_STREAK/);
  });

  it('LobbyShared shows the win-streak badge off the same HOT_WIN_STREAK constant', () => {
    const src = read('src/components/home/LobbyShared.tsx');
    expect(src).not.toMatch(/streak >= 3\b/);
    expect(src).toMatch(/streak >= HOT_WIN_STREAK/);
    expect(src).toMatch(/import\s*\{[^}]*HOT_WIN_STREAK[^}]*\}\s*from\s*['"]\.\.\/\.\.\/utils\/playerStats['"]/s);
  });

  it('HOT_WIN_STREAK lives in playerStats.ts, not redeclared in Statistics.tsx', () => {
    const stats = read('src/components/Statistics.tsx');
    expect(stats).not.toMatch(/const HOT_WIN_STREAK = 3;/);
    const playerStats = read('src/utils/playerStats.ts');
    expect(playerStats).toMatch(/export const HOT_WIN_STREAK = 3;/);
  });

  it('BlurInput default maxVal reuses MAX_WINNING_SCORE instead of a bare 99999', () => {
    const src = read('src/components/home/LobbyShared.tsx');
    expect(src).not.toMatch(/maxVal = 99999/);
    expect(src).toMatch(/maxVal = MAX_WINNING_SCORE/);
  });

  it('GameControls names the quick-add score list instead of an inline array literal', () => {
    const src = read('src/components/game/GameControls.tsx');
    expect(src).not.toMatch(/\[50, 100, 200, 300, 400, 500, 600, 1000\]\.map/);
    expect(src).toMatch(/QUICK_ADD_SCORES\.map/);
    expect(src).toMatch(/const QUICK_ADD_SCORES/);
  });

  it('cancelReconnect names its failsafe timeout instead of a bare 10000', () => {
    const src = read('src/store/socketSlice.ts');
    expect(src).not.toMatch(/setTimeout\(cleanup, 10000\)/);
    expect(src).toMatch(/setTimeout\(cleanup, CANCEL_RECONNECT_FAILSAFE_MS\)/);
    expect(src).toMatch(/import\s*\{[^}]*CANCEL_RECONNECT_FAILSAFE_MS[^}]*\}\s*from\s*['"]\.\.\/utils\/uiTimings['"]/s);
  });
});

describe('MS_PER_SECOND has one home in src/utils/time.ts', () => {
  it('time.ts exports the constant', () => {
    const src = read('src/utils/time.ts');
    expect(src).toMatch(/export const MS_PER_SECOND = 1000;/);
  });

  it('store/timers.ts imports it instead of declaring its own copy', () => {
    const src = read('src/store/timers.ts');
    expect(src).not.toMatch(/export const MS_PER_SECOND = 1000;/);
    expect(src).toMatch(/import\s*\{\s*MS_PER_SECOND\s*\}\s*from\s*['"]\.\.\/utils\/time['"]/);
  });

  const clientMsPerSecondSites: [string, RegExp][] = [
    ['src/store/gameSlice.ts', /Date\.now\(\) - state\.gameStartTime\) \/ 1000\)/],
    ['src/store/persistence.ts', /gameTimeInSeconds \|\| 0\) \* 1000/],
    ['src/hooks/useAutoContinueCountdown.ts', /setTimeout\(\(\) => setCountdown\(prev => \(prev !== null \? prev - 1 : prev\)\), 1000\)/],
  ];

  it.each(clientMsPerSecondSites)('%s no longer spells out the bare ms-per-second literal', (file, bareLiteral) => {
    const src = read(file);
    expect(src).not.toMatch(bareLiteral);
    expect(src).toMatch(/MS_PER_SECOND/);
    expect(src).toMatch(/from ['"].*utils\/time['"]/);
  });

  const serverMsPerSecondSites: [string, RegExp][] = [
    ['server/rooms.ts', /gameActualStartTime\) \/ 1000\)/],
    ['server/socketGameStateHandlers.ts', /gameActualStartTime\) \/ 1000\)/],
    ['server/turnTimers.ts', /gameActualStartTime\) \/ 1000\)/],
    ['server/rateLimit.ts', /existing\.resetAt - now\) \/ 1000\)/],
  ];

  it('scaledTimerMs names both the ms-per-second factor and its floor', () => {
    const src = read('server/turnTimers.ts');
    expect(src).not.toMatch(/seconds \* 1000/);
    expect(src).not.toMatch(/Math\.max\(10,/);
    expect(src).toMatch(/MIN_SCALED_TIMER_MS/);
  });

  it.each(serverMsPerSecondSites)('%s no longer spells out the bare ms-per-second literal', (file, bareLiteral) => {
    const src = read(file);
    expect(src).not.toMatch(bareLiteral);
    expect(src).toMatch(/MS_PER_SECOND/);
    expect(src).toMatch(/from ['"]\.\.\/src\/utils\/time['"]/);
  });
});
