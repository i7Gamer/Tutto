// Drives eslint-rules/no-conflicting-classnames.js through ESLint's own
// Linter class rather than importing its internals -- the rule is an ESM
// default export (an ESLint rule object), and this is the same setup the
// round-11 review probe (scratch/r12-app-eslint-rule-gaps.cjs) used to prove
// the bare-ternary gap this file pins.
import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import rule from './no-conflicting-classnames.js';

const RULE_ID = 'local/no-conflicting-classnames';
const linter = new Linter();

const lint = (code: string) =>
  linter
    .verify(code, {
      plugins: { local: { rules: { 'no-conflicting-classnames': rule } } },
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      rules: { [RULE_ID]: 'error' },
    })
    .filter((message) => message.ruleId === RULE_ID);

describe('no-conflicting-classnames', () => {
  it('reports a conflict in a plain-string className', () => {
    const messages = lint(
      `const X = () => <button className="hover:bg-gray-50 dark:hover:bg-slate-800 hover:bg-white" />;`
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it('reports a conflict inside a template-literal ternary branch', () => {
    const messages = lint(
      `const X = () => <span className={\`\${ok ? 'bg-red-500 bg-blue-500' : 'bg-white'}\`} />;`
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  // The gap this file was created to pin (round 11): classSetsOf returned []
  // for a JSXExpressionContainer whose expression is a bare
  // ConditionalExpression, so the identical conflict below went unreported
  // just because it has no surrounding template literal. Fails before the
  // fix -- see eslint-rules/no-conflicting-classnames.js's classSetsOf.
  it('reports a conflict in a bare ternary (no template literal)', () => {
    const messages = lint(
      `const X = () => <span className={ok ? 'bg-red-500 bg-blue-500' : 'bg-white'} />;`
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it('reports a conflict in a bare `&&` logical expression', () => {
    const messages = lint(
      `const X = () => <span className={ok && 'bg-red-500 bg-blue-500'} />;`
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  // A ternary's two branches are ALTERNATIVES -- only one is ever rendered --
  // so both setting the same property is the whole point of branching, not a
  // conflict. Each branch here sets only one color utility, so a correct fix
  // (one class SET per branch) reports nothing; an incorrect fix that merges
  // both branches into a single combined set would wrongly report these two
  // as conflicting.
  it('does not report when each ternary branch sets the same property on its own', () => {
    const messages = lint(
      `const X = () => <span className={ok ? 'text-red-500' : 'text-green-500'} />;`
    );
    expect(messages).toHaveLength(0);
  });

  it('does not report bg-clip-text next to bg-gradient-to-r (non-color bg utilities)', () => {
    const messages = lint(`const X = () => <span className="bg-clip-text bg-gradient-to-r" />;`);
    expect(messages).toHaveLength(0);
  });

  it('does not report different variants (bg-white dark:bg-slate-900)', () => {
    const messages = lint(`const X = () => <span className="bg-white dark:bg-slate-900" />;`);
    expect(messages).toHaveLength(0);
  });
});
