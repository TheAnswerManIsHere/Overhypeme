import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "..", "..");
const HELP_PAGE = join(SRC, "pages", "admin", "help.tsx");

/**
 * A guard, because a promise failed three times.
 *
 * Every in-app help navigation must go through `navigateToHelp`. That was
 * established once and then missed on three separate call sites in succession
 * — search results, then ChapterNav, then NotFound — each caught by review
 * rather than by anything mechanical. Per this repo's rule that a discipline
 * broken twice becomes a check rather than another undertaking, this is the
 * check.
 *
 * A second navigation path fails SILENTLY: the address bar updates while the
 * page does not move, because wouter neither re-renders on a hash-only change
 * nor emits a native `hashchange`. Nothing throws, no test fails, and the
 * chapter simply sits there.
 *
 * WHY THE AST AND NOT A REGEX. The first version of this guard counted
 * `setLocation(` occurrences and asserted the count was 1. That is defeated by
 * renaming — `const [, navigate] = useLocation()` introduces a second, fully
 * functional navigation path that the counter cannot see, and the guard then
 * certifies the exact regression it exists to prevent. Worse, its
 * guards-the-guard assertion passed on the mere PRESENCE of the token, so it
 * stayed green either way. The setter is found here by following the
 * `useLocation()` destructuring to whatever name it actually binds, so the
 * check holds under any spelling.
 */

const source = readFileSync(HELP_PAGE, "utf8");
const sf = ts.createSourceFile(HELP_PAGE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function walk(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  node.forEachChild((c) => walk(c, fn));
}

const NAVIGATOR = "navigateToHelp";

/** The declaration of `navigateToHelp`, whose span is the sanctioned region. */
function navigatorSpan(): { start: number; end: number } {
  let found: ts.FunctionDeclaration | undefined;
  walk(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === NAVIGATOR) found = n;
  });
  if (!found) throw new Error(`${NAVIGATOR} not found in help.tsx`);
  return { start: found.getStart(sf), end: found.getEnd() };
}

const span = navigatorSpan();
const inNavigator = (n: ts.Node) => n.getStart(sf) >= span.start && n.getEnd() <= span.end;
const where = (n: ts.Node) =>
  `line ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${n.getText(sf).slice(0, 90)}`;

/**
 * Local names for wouter's `useLocation`, resolved through the IMPORT.
 *
 * Matching the literal callee name `useLocation` was the same mistake one
 * level up from the rename hole: `import { useLocation as useHelpLocation }
 * from "wouter"` gives a fully functional hook the analysis cannot see, and
 * because the unaliased binding elsewhere keeps the setter list non-empty,
 * every assertion below — and all three self-tests — stay green while the
 * regression walks back in. So the hook is identified by what it IS, not by
 * what it is called here.
 */
function locationHookNames(): string[] {
  const names: string[] = [];
  walk(sf, (n) => {
    if (!ts.isImportDeclaration(n)) return;
    if (!ts.isStringLiteral(n.moduleSpecifier) || n.moduleSpecifier.text !== "wouter") return;
    const bindings = n.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;
    for (const spec of bindings.elements) {
      // `propertyName` is set only when aliased: `{ useLocation as x }` gives
      // propertyName=useLocation, name=x. Unaliased, the name IS the export.
      const exported = (spec.propertyName ?? spec.name).text;
      if (exported === "useLocation") names.push(spec.name.text);
    }
  });
  return names;
}

const LOCATION_HOOKS = locationHookNames();

/**
 * Names bound to wouter's navigate function, however they are spelled.
 * `const [location, setLocation] = useLocation()` binds at index 1; so does
 * `const [, navigate] = useLocation()`.
 */
function setterNames(): string[] {
  const names: string[] = [];
  walk(sf, (n) => {
    if (!ts.isVariableDeclaration(n)) return;
    const init = n.initializer;
    if (!init || !ts.isCallExpression(init)) return;
    if (!ts.isIdentifier(init.expression) || !LOCATION_HOOKS.includes(init.expression.text)) return;
    // A non-destructuring binding (`const loc = useLocation()`) would hide the
    // setter behind `loc[1]`, so it is rejected outright below.
    if (!ts.isArrayBindingPattern(n.name)) {
      throw new Error(`wouter's useLocation() must be array-destructured so its setter is named — got: ${where(n)}`);
    }
    const el = n.name.elements[1];
    if (el && ts.isBindingElement(el) && ts.isIdentifier(el.name)) names.push(el.name.text);
  });
  return [...new Set(names)];
}

const SETTERS = setterNames();

/** `history.pushState` / `history.replaceState`, however the object is reached. */
function isHistoryMutation(n: ts.Node): n is ts.CallExpression {
  return (
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    (n.expression.name.text === "pushState" || n.expression.name.text === "replaceState")
  );
}

describe("help navigation stays consolidated", () => {
  it("binds wouter's navigate function under a name the guard can follow", () => {
    // Guards everything below: with no setter found, every assertion that
    // follows would pass vacuously.
    expect(SETTERS.length, "no useLocation() setter binding found in help.tsx").toBeGreaterThan(0);
  });

  it("calls the router's navigate function only inside navigateToHelp", () => {
    const offenders: string[] = [];
    walk(sf, (n) => {
      if (!ts.isCallExpression(n)) return;
      if (!ts.isIdentifier(n.expression) || !SETTERS.includes(n.expression.text)) return;
      if (!inNavigator(n)) offenders.push(where(n));
    });
    expect(
      offenders,
      `navigation outside ${NAVIGATOR} skips the fragment handling that hash-only changes require:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("never lets the navigate function escape to another caller", () => {
    // A call is not the only way to navigate: handing the setter to a helper
    // moves the navigation there, where none of the fragment handling applies.
    // The one legitimate reference outside the function is passing it IN.
    const offenders: string[] = [];
    walk(sf, (n) => {
      if (!ts.isIdentifier(n) || !SETTERS.includes(n.text)) return;
      if (inNavigator(n)) return;
      const parent = n.parent;
      if (ts.isBindingElement(parent)) return; // the binding itself
      // A hook dependency array names the value; it cannot call it. Narrowed
      // to the dependency position of a React hook rather than "any array",
      // so `const handlers = [setLocation]` is still an escape.
      if (
        ts.isArrayLiteralExpression(parent) &&
        ts.isCallExpression(parent.parent) &&
        ts.isIdentifier(parent.parent.expression) &&
        /^use(Callback|Effect|Memo|LayoutEffect)$/.test(parent.parent.expression.text) &&
        parent.parent.arguments[parent.parent.arguments.length - 1] === parent
      ) {
        return;
      }
      if (
        ts.isCallExpression(parent) &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === NAVIGATOR &&
        parent.arguments.includes(n as ts.Expression)
      ) {
        return; // passed into the sanctioned navigator
      }
      offenders.push(where(n));
    });
    expect(offenders, `router setter referenced outside ${NAVIGATOR}:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("mutates history only inside navigateToHelp", () => {
    // pushState/replaceState decide whether Back returns the reader to the
    // previous section or drops them out of Help entirely — a distinction one
    // stray call elsewhere silently reverses.
    const offenders: string[] = [];
    walk(sf, (n) => {
      if (isHistoryMutation(n) && !inNavigator(n)) offenders.push(where(n));
    });
    expect(offenders, `history mutation outside ${NAVIGATOR}:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("renders no wouter navigation component", () => {
    // `<Link>` and `<Redirect>` navigate without ever touching the setter, so
    // the checks above cannot see them.
    const banned = new Set(["Link", "Redirect"]);
    const offenders: string[] = [];
    walk(sf, (n) => {
      if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && ts.isIdentifier(n.tagName) && banned.has(n.tagName.text)) {
        offenders.push(where(n));
      }
      if (ts.isImportSpecifier(n) && banned.has(n.name.text)) offenders.push(where(n));
    });
    expect(offenders, `wouter navigation component bypasses ${NAVIGATOR}:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("actually finds the calls it is guarding (guards the assertions above)", () => {
    // Every assertion above is an emptiness check, so all five pass if the
    // walk sees nothing at all. These prove it sees the real thing.
    let setterCalls = 0;
    let historyCalls = 0;
    walk(sf, (n) => {
      if (!inNavigator(n)) return;
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && SETTERS.includes(n.expression.text)) setterCalls++;
      if (isHistoryMutation(n)) historyCalls++;
    });
    expect(setterCalls, `${NAVIGATOR} should call the router setter`).toBeGreaterThan(0);
    expect(historyCalls, `${NAVIGATOR} should manage history directly`).toBeGreaterThan(0);
  });
});

/**
 * PROVES THE GUARD FIRES. Emptiness assertions are exactly the kind that rot
 * into vacuous truth, and the previous version of this guard did: it went
 * green while a rename walked straight past it. So break each invariant on a
 * COPY of the source and require the analysis to object.
 */
describe("the navigation guard detects a bypass", () => {
  function analyse(mutated: string) {
    const f = ts.createSourceFile(HELP_PAGE, mutated, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let decl: ts.FunctionDeclaration | undefined;
    const walkF = (node: ts.Node, fn: (n: ts.Node) => void) => {
      fn(node);
      node.forEachChild((c) => walkF(c, fn));
    };
    walkF(f, (n) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === NAVIGATOR) decl = n;
    });
    const s = { start: decl!.getStart(f), end: decl!.getEnd() };
    // Mirrors locationHookNames(): resolve the hook through the wouter import
    // so an aliased spelling is followed here too. Without this, the fixture
    // below could not detect the very hole it is meant to prove is closed.
    const hooks: string[] = [];
    walkF(f, (n) => {
      if (!ts.isImportDeclaration(n)) return;
      if (!ts.isStringLiteral(n.moduleSpecifier) || n.moduleSpecifier.text !== "wouter") return;
      const b = n.importClause?.namedBindings;
      if (!b || !ts.isNamedImports(b)) return;
      for (const spec of b.elements) {
        if ((spec.propertyName ?? spec.name).text === "useLocation") hooks.push(spec.name.text);
      }
    });
    const names: string[] = [];
    walkF(f, (n) => {
      if (!ts.isVariableDeclaration(n) || !n.initializer || !ts.isCallExpression(n.initializer)) return;
      if (!ts.isIdentifier(n.initializer.expression) || !hooks.includes(n.initializer.expression.text)) return;
      if (!ts.isArrayBindingPattern(n.name)) return;
      const el = n.name.elements[1];
      if (el && ts.isBindingElement(el) && ts.isIdentifier(el.name)) names.push(el.name.text);
    });
    let stray = 0;
    walkF(f, (n) => {
      const outside = !(n.getStart(f) >= s.start && n.getEnd() <= s.end);
      if (!outside) return;
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.includes(n.expression.text)) stray++;
      if (isHistoryMutation(n)) stray++;
    });
    return { setters: names, hooks, stray };
  }

  it("sees a stray call through the setter's real name", () => {
    expect(analyse(source).stray, "unmutated source should be clean").toBe(0);
    const injected = source.replace(
      "const bodyRef = useRef<HTMLDivElement>(null);",
      "const bodyRef = useRef<HTMLDivElement>(null);\n  const bypass = () => setLocation('/admin/help/3-moderation');",
    );
    expect(injected, "injection point not found — the guard's own fixture is stale").not.toBe(source);
    expect(analyse(injected).stray, "a stray setter call must be detected").toBeGreaterThan(0);
  });

  it("sees a stray call when the setter is RENAMED — the hole in the old guard", () => {
    const renamed = source
      .replace("const [, setLocation] = useLocation();", "const [, navigate] = useLocation();")
      .replace(
        "const bodyRef = useRef<HTMLDivElement>(null);",
        "const bodyRef = useRef<HTMLDivElement>(null);\n  const bypass = () => navigate('/admin/help/3-moderation');",
      );
    expect(renamed, "rename fixture did not apply").not.toBe(source);
    const { setters, stray } = analyse(renamed);
    expect(setters, "the guard must follow the binding, not the spelling").toContain("navigate");
    expect(stray, "a renamed setter is still a navigation path").toBeGreaterThan(0);
  });

  it("sees a stray call through an ALIASED hook import — the hole one level up", () => {
    // `import { useLocation as useHelpLocation }` gives a working hook under a
    // name the analysis never sees if it matches the callee literally. The
    // unaliased binding elsewhere keeps the setter list non-empty, so nothing
    // else in this suite would have gone red.
    const aliased = source
      .replace('import { useLocation, useRoute } from "wouter";',
               'import { useLocation, useLocation as useHelpLocation, useRoute } from "wouter";')
      .replace(
        "const bodyRef = useRef<HTMLDivElement>(null);",
        "const bodyRef = useRef<HTMLDivElement>(null);\n  const [, jump] = useHelpLocation();\n  const bypass = () => jump('/admin/help/3-moderation');",
      );
    expect(aliased, "alias fixture did not apply").not.toBe(source);
    const { hooks, setters, stray } = analyse(aliased);
    expect(hooks, "the guard must resolve the hook through its import").toContain("useHelpLocation");
    expect(setters, "a setter bound from the aliased hook must be tracked").toContain("jump");
    expect(stray, "an aliased hook is still a navigation path").toBeGreaterThan(0);
  });

  it("sees a stray history mutation", () => {
    const injected = source.replace(
      "const bodyRef = useRef<HTMLDivElement>(null);",
      "const bodyRef = useRef<HTMLDivElement>(null);\n  const bypass = () => window.history.pushState({}, '', '/x');",
    );
    expect(injected).not.toBe(source);
    expect(analyse(injected).stray, "a stray history mutation must be detected").toBeGreaterThan(0);
  });
});
