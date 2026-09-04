import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCollectedReviewBundle,
  collectReviewRecords,
  collectRepositoryReviewRecords,
  selectReviewChangeUnitIds,
} from "../scripts/lib/review-evidence.mjs";

test("repository review collection preserves external cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    collectRepositoryReviewRecords(
      process.cwd(), [], [], {
        collectionTimeoutMs: 10_000,
        commandTimeoutMs: 10_000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
      }, { signal: controller.signal },
    ),
    (error) => error.code === "CANCELLED",
  );
});

test("repository review collection translates its internal deadline", async () => {
  await assert.rejects(
    collectRepositoryReviewRecords(
      process.cwd(), [], [], {
        collectionTimeoutMs: 0,
        commandTimeoutMs: 10_000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
      },
    ),
    (error) => error.code === "COLLECTION_TIMEOUT",
  );
});

const oid = (character) => character.repeat(40);
const unit = (id, display, oldCharacter, newCharacter, extra = {}) => ({
  id,
  path: {
    rawBase64: Buffer.from(display).toString("base64"),
    display,
  },
  oldMode: oldCharacter ? "100644" : null,
  newMode: newCharacter ? "100644" : null,
  oldOid: oldCharacter ? oid(oldCharacter) : null,
  newOid: newCharacter ? oid(newCharacter) : null,
  kind: oldCharacter ? newCharacter ? "modify" : "delete" : "add",
  sourceComponent: "tracked",
  binary: false,
  ...extra,
});
const limits = {
  maxReviewWorkItems: 20,
  maxReviewFilesPerItem: 25,
  maxReviewChangedLinesPerItem: 2_000,
  maxReviewBytesPerFile: 100,
  maxReviewBytesTotal: 40,
};

function fakeBoundary(contents, calls) {
  return {
    async run(args, options) {
      calls.push({ args, options });
      if (args[1]?.startsWith("--batch-check")) {
        const requested = options.input.trim().split("\n");
        return {
          stdout: Buffer.from(requested.map((value) =>
            `${value} blob ${contents.get(value).length}\n`).join("")),
        };
      }
      return { stdout: contents.get(args[2]) };
    },
  };
}

test("review evidence emits bounded before and after content", async () => {
  const calls = [];
  const contents = new Map([
    [oid("a"), Buffer.from("old\n")],
    [oid("b"), Buffer.from("new\n")],
    [oid("c"), Buffer.from([0, 1, 2])],
    [oid("d"), Buffer.alloc(100, 1)],
  ]);
  const changeUnits = [
    unit("text", "src/app.js", "a", "b"),
    unit("binary", "src/data.bin", null, "c"),
    unit("large", "src/large.txt", null, "d"),
    unit("secret", ".env.production", null, "e"),
    unit("generated", "dist/app.js", null, "f"),
    unit("link", "src/link", null, "1", { newMode: "120000" }),
    unit("module", "src/module", null, "2", {
      newMode: "160000",
      kind: "gitlink",
    }),
    unit("ignored", "ignored.txt", null, "3", {
      sourceComponent: "ignored",
    }),
  ];
  const collected = await collectReviewRecords({
    boundary: fakeBoundary(contents, calls),
    changeUnits,
    limits,
  });

  assert.equal(
    calls.filter(({ args }) => args[1] === "-p").length,
    3,
  );
  assert.equal(
    calls.some(({ args }) => args.includes(oid("e"))),
    false,
  );
  assert.equal(
    calls.some(({ args }) => args.includes(oid("f"))),
    false,
  );
  const text = collected.records.find(
    ({ changeUnitId }) => changeUnitId === "text",
  );
  assert.match(text.diff, /^--- before\n-old\n\+\+\+ after\n\+new\n$/u);
  assert.equal(
    collected.records.some(({ sensitive }) => sensitive),
    true,
  );
  assert.equal(
    collected.records.some(({ generated }) => generated),
    true,
  );
  assert.equal(
    collected.records.some(({ binary }) => binary),
    true,
  );
  assert.equal(
    collected.records.some(({ symlink }) => symlink),
    true,
  );
  assert.equal(
    collected.records.some(({ submodule }) => submodule),
    true,
  );
  assert.equal(collected.observed, changeUnits.length);
  assert.equal(collected.skipped, 2);

  const bundle = buildCollectedReviewBundle({
    workItems: [{ id: "work-1", changeUnits }],
    records: collected.records,
    gaps: collected.gaps,
    limits,
    runId: "f".repeat(64),
  });
  assert.match(bundle.prompt, /-old/u);
  assert.match(bundle.prompt, /\+new/u);
  const reviewLimit = bundle.gaps.find(
    ({ code }) => code === "review-byte-limit",
  );
  assert.deepEqual(reviewLimit.affectedIds, ["work-1"]);
  assert.equal(
    bundle.gaps.some(({ affectedIds }) =>
      affectedIds.includes("large")),
    false,
  );
});

test("review evidence handles adds and deletes with the correct side", async () => {
  const calls = [];
  const contents = new Map([
    [oid("a"), Buffer.from("removed\n")],
    [oid("b"), Buffer.from("added\n")],
  ]);
  const result = await collectReviewRecords({
    boundary: fakeBoundary(contents, calls),
    changeUnits: [
      unit("delete", "old.txt", "a", null),
      unit("add", "new.txt", null, "b"),
    ],
    limits,
  });
  assert.match(
    result.records.find(({ changeUnitId }) =>
      changeUnitId === "delete").diff,
    /^--- before\n-removed\n$/u,
  );
  assert.match(
    result.records.find(({ changeUnitId }) =>
      changeUnitId === "add").diff,
    /^\+\+\+ after\n\+added\n$/u,
  );
});

test("review reads are deduplicated and both sides consume budget", async () => {
  const contents = new Map([
    [oid("a"), Buffer.from("old\n")],
    [oid("b"), Buffer.from("new\n")],
  ]);
  const shared = [
    unit("one", "one.txt", "a", "b"),
    unit("two", "two.txt", "a", "b"),
  ];
  const calls = [];
  const deduplicated = await collectReviewRecords({
    boundary: fakeBoundary(contents, calls),
    changeUnits: shared,
    limits: { ...limits, maxReviewBytesTotal: 8 },
  });
  assert.equal(deduplicated.records.length, 2);
  assert.equal(
    calls.filter(({ args }) => args[1] === "-p").length,
    2,
  );

  const limitedCalls = [];
  const limited = await collectReviewRecords({
    boundary: fakeBoundary(contents, limitedCalls),
    changeUnits: [shared[0]],
    limits: { ...limits, maxReviewBytesTotal: 7 },
  });
  assert.equal(limited.records.length, 0);
  assert.equal(limited.skipped, 1);
  assert.equal(limited.gaps[0].code, "review-byte-limit");
  assert.equal(
    limitedCalls.filter(({ args }) => args[1] === "-p").length,
    0,
  );
});

test("review evidence records metadata and content failures as gaps", async () => {
  const malformed = await collectReviewRecords({
    boundary: {
      run: async () => ({ stdout: Buffer.from("bad\n") }),
    },
    changeUnits: [unit("text", "src/app.js", "a", "b")],
    limits,
  });

  assert.equal(malformed.records.length, 0);
  assert.equal(
    malformed.gaps[0].code,
    "review-metadata-unavailable",
  );
  assert.equal(malformed.skipped, 1);

  let call = 0;
  const failed = await collectReviewRecords({
    boundary: {
      async run(args, options) {
        call += 1;
        if (call === 1) {
          const requested = options.input.trim().split("\n");
          return {
            stdout: Buffer.from(
              requested.map((value) => `${value} blob 4\n`).join(""),
            ),
          };
        }
        const error = new Error("untrusted");
        error.code = "READ_FAILED";
        throw error;
      },
    },
    changeUnits: [unit("text", "src/app.js", "a", "b")],
    limits,
  });
  assert.equal(
    failed.gaps[0].code,
    "review-content-unavailable",
  );
  await assert.rejects(
    collectReviewRecords({ changeUnits: [] }),
    /required/u,
  );
});

test("review evidence never converts cancellation into a coverage gap", async () => {
  for (const failurePoint of ["metadata", "content"]) {
    const controller = new AbortController();
    let call = 0;
    await assert.rejects(
      collectReviewRecords({
        boundary: {
          async run(args, options) {
            call += 1;
            if (failurePoint === "content" && call === 1) {
              const requested = options.input.trim().split("\n");
              return {
                stdout: Buffer.from(
                  requested.map((value) => `${value} blob 4\n`).join(""),
                ),
              };
            }
            controller.abort();
            const error = new Error("cancelled");
            error.code = "CANCELLED";
            throw error;
          },
        },
        changeUnits: [unit("text", "src/app.js", "a", "b")],
        limits,
        signal: controller.signal,
      }),
      (error) => error.code === "CANCELLED",
    );
  }
});

test("review selection bounds content reads before Git subprocesses", async () => {
  const changeUnits = [
    unit("a", "a.txt", null, "a"),
    unit("b", "b.txt", null, "b"),
    unit("c", "c.txt", null, "c"),
  ];
  const workItems = [
    { id: "one", changeUnits: changeUnits.slice(0, 2), carriers: [] },
    { id: "two", changeUnits: changeUnits.slice(2), carriers: [] },
  ];
  const selected = selectReviewChangeUnitIds(workItems, {
    maxReviewWorkItems: 1,
    maxReviewFilesPerItem: 1,
  });

  assert.deepEqual(selected, ["a"]);

  const calls = [];
  const contents = new Map([
    [oid("a"), Buffer.from("a\n")],
    [oid("b"), Buffer.from("b\n")],
    [oid("c"), Buffer.from("c\n")],
  ]);
  const collected = await collectReviewRecords({
    boundary: fakeBoundary(contents, calls),
    changeUnits,
    selectedChangeUnitIds: selected,
    limits,
  });

  test("collected review bundle merges repeated gap codes", () => {
    const changeUnits = [
      unit("a", "a.txt", null, "a"),
      unit("b", "b.txt", null, "b"),
    ];
    const bundle = buildCollectedReviewBundle({
      workItems: [{ id: "work", changeUnits, carriers: [] }],
      records: [],
      gaps: [
        { code: "review-content-unavailable", affectedIds: ["a"] },
        { code: "review-content-unavailable", affectedIds: ["b"] },
      ],
      limits,
      runId: "f".repeat(64),
    });
    const merged = bundle.gaps.find(
      ({ code }) => code === "review-content-unavailable",
    );
    assert.equal(merged.count, 2);
    assert.deepEqual(merged.affectedIds, ["work"]);
  });
  assert.deepEqual(
    calls.filter(({ args }) => args[1] === "-p")
      .map(({ args }) => args[2]),
    [oid("a")],
  );
  assert.equal(calls[0].options.input, `${oid("a")}\n`);
  assert.equal(collected.observed, 3);
  assert.equal(collected.skipped, 2);
  assert.deepEqual(
    collected.gaps.find(({ code }) =>
      code === "review-selection-limit").affectedIds,
    ["b", "c"],
  );
});
