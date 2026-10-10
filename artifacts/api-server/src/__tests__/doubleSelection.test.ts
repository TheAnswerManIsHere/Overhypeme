/**
 * The selection rule for deploy-selectable doubles (lib/doubleSelection.ts):
 * named explicitly or not at all, an unrecognised value refused everywhere,
 * and any double refused in a production boot — before the server listens.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { doubleSelectionRefusals, selectedBackend, SELECTORS } from "../lib/doubleSelection.js";

const DEV = { NODE_ENV: "development" };
const DOUBLE = { STORAGE_BACKEND: "local-double", STORAGE_DOUBLE_DIR: "/tmp/storage-double" };

describe("double selection", () => {
  it("uses the real backend when unset, empty, or named", () => {
    for (const value of [undefined, "", "  ", "replit"]) {
      assert.deepEqual(doubleSelectionRefusals({ ...DEV, STORAGE_BACKEND: value }), []);
      assert.equal(selectedBackend("STORAGE_BACKEND", { ...DEV, STORAGE_BACKEND: value }), "replit");
    }
  });

  it("selects the double only when named, and only with its directory", () => {
    assert.equal(selectedBackend("STORAGE_BACKEND", { ...DEV, ...DOUBLE }), "local-double");
    assert.match(doubleSelectionRefusals({ ...DEV, STORAGE_BACKEND: "local-double" }).join(), /STORAGE_DOUBLE_DIR/);
    assert.match(
      doubleSelectionRefusals({ ...DEV, STORAGE_BACKEND: "local-double", STORAGE_DOUBLE_DIR: "relative" }).join(),
      /STORAGE_DOUBLE_DIR/,
    );
  });

  it("refuses an unrecognised value everywhere, including outside production", () => {
    for (const value of ["local", "LOCAL-DOUBLE", "gcs", "true"]) {
      assert.match(doubleSelectionRefusals({ ...DEV, STORAGE_BACKEND: value }).join(), /not recognised/);
      assert.throws(() => selectedBackend("STORAGE_BACKEND", { ...DEV, STORAGE_BACKEND: value }), /not recognised/);
    }
  });

  it("refuses every double in a production boot, by either production signal", () => {
    for (const [name, selector] of Object.entries(SELECTORS)) {
      for (const double of selector.doubles) {
        for (const prod of [{ NODE_ENV: "production" }, { REPLIT_DEPLOYMENT: "1" }]) {
          const env = { ...DOUBLE, ...prod, [name]: double };
          assert.match(doubleSelectionRefusals(env).join(), /production boot refuses/, `${name}=${double} under ${JSON.stringify(prod)}`);
          assert.throws(() => selectedBackend(name as keyof typeof SELECTORS, env), /production boot refuses/);
        }
      }
    }
  });

  it("keeps an import graph that cannot reach the database before boot checks run", () => {
    const lib = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lib");
    // Every module the file can load: static and side-effect imports, re-exports,
    // and dynamic `import()` / `require()` with a literal specifier. A dynamic
    // load with a computed specifier is reported as "<computed>" so it fails too.
    const importsOf = (file: string) => {
      const source = ts.createSourceFile(file, fs.readFileSync(path.join(lib, file), "utf8"), ts.ScriptTarget.ESNext, true);
      const found: string[] = [];
      const specifier = (node: ts.Node | undefined) => (node && ts.isStringLiteralLike(node) ? node.text : "<computed>");
      const visit = (node: ts.Node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
          found.push(specifier(node.moduleSpecifier));
        } else if (ts.isCallExpression(node)) {
          const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
          const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
          if (isDynamicImport || isRequire) found.push(specifier(node.arguments[0]));
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return found;
    };
    assert.deepEqual(importsOf("doubleSelection.ts"), ["./env"]);
    assert.deepEqual(importsOf("env.ts"), []);
  });

  it("allows the real backend in production", () => {
    assert.deepEqual(doubleSelectionRefusals({ NODE_ENV: "production", REPLIT_DEPLOYMENT: "1" }), []);
    assert.deepEqual(doubleSelectionRefusals({ NODE_ENV: "production", STORAGE_BACKEND: "replit" }), []);
  });
});

/** Boot the real entrypoint and report how it ended and whether the port ever opened. */
async function boot(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string; listened: boolean }> {
  const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["--import", "tsx/esm", "src/index.ts"], {
    cwd: apiRoot,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: process.env.DATABASE_URL, PORT: String(port), ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  let listened = false;
  const probe = setInterval(() => {
    const socket = net.connect(port, "127.0.0.1", () => {
      listened = true;
      socket.destroy();
    });
    socket.on("error", () => socket.destroy());
  }, 100);
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, 45_000);
    child.on("exit", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  clearInterval(probe);
  return { code, stderr, listened };
}

describe("the server's boot refuses a bad selection before listening", () => {
  const PROD_BOOT = {
    NODE_ENV: "production",
    IP_HASH_SALT: "boot-refusal-test-salt-0123456789abcdef",
    CRON_SECRET: "boot-refusal-test",
  };

  it("exits on a production boot naming the storage double", async () => {
    const result = await boot({ ...PROD_BOOT, ...DOUBLE });
    assert.notEqual(result.code, 0, "the process must exit non-zero, not keep running");
    assert.match(result.stderr, /\[doubles\] refusing to start/);
    assert.match(result.stderr, /STORAGE_BACKEND=local-double names a test double/);
    assert.equal(result.listened, false, "the port must never open");
  });

  it("exits on an unrecognised value outside production", async () => {
    const result = await boot({ NODE_ENV: "development", STORAGE_BACKEND: "locl-double" });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not recognised/);
    assert.equal(result.listened, false);
  });
});
