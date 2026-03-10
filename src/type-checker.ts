import * as ts from "typescript";
import * as path from "path";

export interface TypeCheckResult {
  success: boolean;
  errors: string[];
}

/**
 * Type-check combined code, reporting only errors from the user code section.
 * Uses a virtual compiler host so the code is served from memory.
 */
export function typeCheckCode(
  filePath: string,
  code: string,
  userCodeStartLine: number,
  userCodeEndLine: number
): TypeCheckResult {
  const defaultHost = ts.createCompilerHost({});

  // Resolve typeRoots to this package's node_modules/@types
  const typeRoots = [path.join(__dirname, "..", "node_modules", "@types")];

  const options: ts.CompilerOptions = {
    strict: false,
    noImplicitAny: false,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    typeRoots,
    types: ["node"],
    lib: ["lib.es2022.d.ts"],
  };

  const host: ts.CompilerHost = {
    ...defaultHost,
    getSourceFile(fileName, languageVersion, onError) {
      if (path.resolve(fileName) === path.resolve(filePath)) {
        return ts.createSourceFile(fileName, code, languageVersion, true);
      }
      return defaultHost.getSourceFile(fileName, languageVersion, onError);
    },
    fileExists(fileName) {
      if (path.resolve(fileName) === path.resolve(filePath)) return true;
      return defaultHost.fileExists(fileName);
    },
    readFile(fileName) {
      if (path.resolve(fileName) === path.resolve(filePath)) return code;
      return defaultHost.readFile(fileName);
    },
  };

  const program = ts.createProgram([filePath], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);

  const errors: string[] = [];

  for (const diag of diagnostics) {
    if (!diag.file || path.resolve(diag.file.fileName) !== path.resolve(filePath)) {
      continue;
    }
    if (diag.start === undefined) continue;

    const { line } = diag.file.getLineAndCharacterOfPosition(diag.start);
    const oneBasedLine = line + 1; // ts uses 0-based lines

    if (oneBasedLine >= userCodeStartLine && oneBasedLine <= userCodeEndLine) {
      const relativeLine = oneBasedLine - userCodeStartLine + 1;
      const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
      errors.push(`Line ${relativeLine}: ${message}`);
    }
  }

  return { success: errors.length === 0, errors };
}
