"use strict";

const { TEST_STANDALONE } = process.env;

const fs = require("fs");
const path = require("path");
const prettier = !TEST_STANDALONE
  ? require("prettier/local")
  : require("prettier/standalone");
const checkParsers = require("./utils/check-parsers");
const visualizeRange = require("./utils/visualize-range");
const createSnapshot = require("./utils/create-snapshot");
const composeOptionsForSnapshot = require("./utils/compose-options-for-snapshot");
const visualizeEndOfLine = require("./utils/visualize-end-of-line");
const consistentEndOfLine = require("./utils/consistent-end-of-line");
const stringifyOptionsForTitle = require("./utils/stringify-options-for-title");

const { FULL_TEST } = process.env;
const BOM = "\uFEFF";

const CURSOR_PLACEHOLDER = "<|>";
const RANGE_START_PLACEHOLDER = "<<<PRETTIER_RANGE_START>>>";
const RANGE_END_PLACEHOLDER = "<<<PRETTIER_RANGE_END>>>";

// TODO: these test files need fix
const unstableTests = new Map(
  [
    "js/class-comment/misc.js",
    ["js/comments/dangling_array.js", (options) => options.semi === false],
    ["js/comments/jsx.js", (options) => options.semi === false],
    "js/comments/return-statement.js",
    "js/comments/tagged-template-literal.js",
    "js/comments-closure-typecast/iife.js",
    "markdown/spec/example-234.md",
    "markdown/spec/example-235.md",
    "html/multiparser/js/script-tag-escaping.html",
    [
      "js/multiparser-markdown/codeblock.js",
      (options) => options.proseWrap === "always",
    ],
    ["js/no-semi/comments.js", (options) => options.semi === false],
    ["flow/no-semi/comments.js", (options) => options.semi === false],
  ].map((fixture) => {
    const [file, isUnstable = () => true] = Array.isArray(fixture)
      ? fixture
      : [fixture];
    return [path.join(__dirname, "../tests/", file), isUnstable];
  })
);

const isUnstable = (filename, options) => {
  const testFunction = unstableTests.get(filename);

  if (!testFunction) {
    return false;
  }

  return testFunction(options);
};

const shouldThrowOnFormat = (filename, options) => {
  if (options.parser !== "babel-ts") {
    return false;
  }

  const { disableBabelTS } = options;

  if (disableBabelTS === true) {
    return true;
  }

  if (Array.isArray(disableBabelTS) && disableBabelTS.includes(filename)) {
    return true;
  }

  return false;
};

const isTestDirectory = (dirname, name) =>
  dirname.startsWith(path.join(__dirname, "../tests", name));

function runSpec(fixtures, parsers, options) {
  let { dirname, snippets = [] } =
    typeof fixtures === "string" ? { dirname: fixtures } : fixtures;

  // `IS_PARSER_INFERENCE_TESTS` mean to test `inferParser` on `standalone`
  const IS_PARSER_INFERENCE_TESTS = isTestDirectory(
    dirname,
    "misc/parser-inference"
  );

  // `IS_ERROR_TESTS` mean to watch errors like:
  // - syntax parser hasn't supported yet
  // - syntax errors that should throws
  const IS_ERROR_TESTS = isTestDirectory(dirname, "misc/errors");

  if (IS_PARSER_INFERENCE_TESTS) {
    parsers = [undefined];
  }

  snippets = snippets.map((test, index) => {
    test = typeof test === "string" ? { code: test } : test;
    return {
      ...test,
      name: `snippet: ${test.name || `#${index}`}`,
    };
  });

  const files = fs
    .readdirSync(dirname, { withFileTypes: true })
    .map((file) => {
      const basename = file.name;
      const filename = path.join(dirname, basename);
      if (
        path.extname(basename) === ".snap" ||
        !file.isFile() ||
        basename[0] === "." ||
        basename === "jsfmt.spec.js"
      ) {
        return;
      }

      const text = fs.readFileSync(filename, "utf8");

      return {
        name: basename,
        filename,
        code: text,
      };
    })
    .filter(Boolean);

  // Make sure tests are in correct location
  if (process.env.CHECK_TEST_PARSERS) {
    if (!Array.isArray(parsers) || !parsers.length) {
      throw new Error(`No parsers were specified for ${dirname}`);
    }
    checkParsers({ dirname, files }, parsers);
  }

  const [parser] = parsers;
  const allParsers = [...parsers];
  if (parsers.includes("typescript") && !parsers.includes("babel-ts")) {
    allParsers.push("babel-ts");
  }

  const stringifiedOptions = stringifyOptionsForTitle(options);

  for (const { name, filename, code, output } of [...files, ...snippets]) {
    const title = `${name}${
      stringifiedOptions ? ` - ${stringifiedOptions}` : ""
    }`;

    describe(title, () => {
      const formatOptions = {
        printWidth: 80,
        ...options,
        filepath: filename,
        parser,
      };
      const formatWithMainParser = () => format(code, formatOptions);

      if (IS_ERROR_TESTS) {
        test("error test", () => {
          expect(formatWithMainParser).toThrowErrorMatchingSnapshot();
        });
        return;
      }

      const mainParserFormatResult = formatWithMainParser();

      for (const currentParser of allParsers) {
        runTest({
          parsers,
          name,
          filename,
          code,
          output,
          parser: currentParser,
          mainParserFormatResult,
          mainParserFormatOptions: formatOptions,
        });
      }
    });
  }
}

function runTest({
  parsers,
  name,
  filename,
  code,
  output,
  parser,
  mainParserFormatResult,
  mainParserFormatOptions,
}) {
  let formatOptions = mainParserFormatOptions;
  let formatResult = mainParserFormatResult;
  let formatTestTitle = "format";

  // Verify parsers
  if (parser !== parsers[0]) {
    formatOptions = { ...mainParserFormatResult.options, parser };
    const runFormat = () => format(code, formatOptions);

    if (shouldThrowOnFormat(name, formatOptions)) {
      test(`[${parser}] expect SyntaxError`, () => {
        expect(runFormat).toThrow(TEST_STANDALONE ? undefined : SyntaxError);
      });
      return;
    }

    // Verify parsers format result should be the same as main parser
    output = mainParserFormatResult.outputWithCursor;
    formatResult = runFormat();
    formatTestTitle = `[${parser}] format`;
  }

  test(formatTestTitle, () => {
    // Make sure output has consistent EOL
    expect(formatResult.eolVisualizedOutput).toEqual(
      visualizeEndOfLine(consistentEndOfLine(formatResult.outputWithCursor))
    );

    // The result is assert to equals to `output`
    if (typeof output === "string") {
      expect(formatResult.eolVisualizedOutput).toEqual(
        visualizeEndOfLine(output)
      );
      return;
    }

    // All parsers have the same result, only snapshot the result from main parser
    // TODO: move this part to `createSnapshot`
    const hasEndOfLine = "endOfLine" in formatOptions;
    let codeForSnapshot = formatResult.inputWithCursor;
    let codeOffset = 0;
    let resultForSnapshot = formatResult.outputWithCursor;
    const { rangeStart, rangeEnd } = formatResult.options;

    if (typeof rangeStart === "number" || typeof rangeEnd === "number") {
      codeForSnapshot = visualizeRange(codeForSnapshot, {
        rangeStart,
        rangeEnd,
      });
      codeOffset = codeForSnapshot.match(/^>?\s+1 \| /)[0].length;
    }

    if (hasEndOfLine) {
      codeForSnapshot = visualizeEndOfLine(codeForSnapshot);
      resultForSnapshot = visualizeEndOfLine(resultForSnapshot);
    }

    expect(
      createSnapshot(
        codeForSnapshot,
        resultForSnapshot,
        composeOptionsForSnapshot(formatResult.options, parsers),
        { codeOffset }
      )
    ).toMatchSnapshot();
  });

  if (!FULL_TEST) {
    return;
  }

  const isUnstableTest = isUnstable(filename, formatOptions);
  if (
    (formatResult.changed || isUnstableTest) &&
    // No range and cursor
    formatResult.input === code
  ) {
    test(`[${parser}] second format`, () => {
      const { eolVisualizedOutput: firstOutput, output } = formatResult;
      const { eolVisualizedOutput: secondOutput } = format(
        output,
        formatOptions
      );
      if (isUnstableTest) {
        // To keep eye on failed tests, this assert never supposed to pass,
        // if it fails, just remove the file from `unstableTests`
        expect(secondOutput).not.toEqual(firstOutput);
      } else {
        expect(secondOutput).toEqual(firstOutput);
      }
    });
  }

  // Some parsers skip parsing empty files
  if (formatResult.changed && code.trim()) {
    test(`[${parser}] compare AST`, () => {
      const { input, output } = formatResult;
      const originalAst = parse(input, formatOptions);
      const formattedAst = parse(output, formatOptions);
      expect(formattedAst).toEqual(originalAst);
    });
  }

  if (!code.includes("\r") && !formatOptions.requirePragma) {
    for (const eol of [
      "\r\n",
      // There are some edge cases failed on `\r` test, disable for now
      // "\r"
    ]) {
      test(`[${parser}] EOL ${JSON.stringify(eol)}`, () => {
        const output = format(code.replace(/\n/g, eol), formatOptions)
          .eolVisualizedOutput;
        // Only if `endOfLine: "auto"` the result will be different
        const expected =
          formatOptions.endOfLine === "auto"
            ? visualizeEndOfLine(
                // All `code` use `LF`, so the `eol` of result is always `LF`
                formatResult.outputWithCursor.replace(/\n/g, eol)
              )
            : formatResult.eolVisualizedOutput;
        expect(output).toEqual(expected);
      });
    }
  }

  if (code.charAt(0) !== BOM) {
    test(`[${parser}] BOM`, () => {
      const output = format(BOM + code, formatOptions).eolVisualizedOutput;
      const expected = BOM + formatResult.eolVisualizedOutput;
      expect(output).toEqual(expected);
    });
  }
}

function parse(source, options) {
  return prettier.__debug.parse(source, options, /* massage */ true).ast;
}

function format(text, options) {
  options = {
    ...options,
  };

  const inputWithCursor = text
    .replace(RANGE_START_PLACEHOLDER, (match, offset) => {
      options.rangeStart = offset;
      return "";
    })
    .replace(RANGE_END_PLACEHOLDER, (match, offset) => {
      options.rangeEnd = offset;
      return "";
    });

  const input = inputWithCursor.replace(CURSOR_PLACEHOLDER, (match, offset) => {
    options.cursorOffset = offset;
    return "";
  });

  const result = prettier.formatWithCursor(input, options);
  const output = result.formatted;

  const outputWithCursor =
    options.cursorOffset >= 0
      ? output.slice(0, result.cursorOffset) +
        CURSOR_PLACEHOLDER +
        output.slice(result.cursorOffset)
      : output;
  const eolVisualizedOutput = visualizeEndOfLine(outputWithCursor);

  const changed = outputWithCursor !== inputWithCursor;

  return {
    changed,
    options,
    input,
    inputWithCursor,
    output,
    outputWithCursor,
    eolVisualizedOutput,
  };
}

module.exports = runSpec;
