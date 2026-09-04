const SPARSE_KEYS = Object.freeze({
  enabled: "core.sparseCheckout",
  cone: "core.sparseCheckoutCone",
  sparseIndex: "index.sparse",
});

function safeReason(error, fallback) {
  return String(error?.code ?? error?.message ?? fallback)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .slice(0, 300)
    .trim();
}

async function readBoolean(boundary, key, signal) {
  try {
    const result = await boundary.run([
      "config",
      "--local",
      "--type=bool",
      "--get",
      key,
    ], {
      rejectNonZero: false,
      signal,
    });
    if (result.exitCode === 1 && result.stdout.length === 0) {
      return { known: true, value: false };
    }
    if (result.exitCode === 0 && result.stdout.equals(Buffer.from("true\n"))) {
      return { known: true, value: true };
    }
    if (result.exitCode === 0 && result.stdout.equals(Buffer.from("false\n"))) {
      return { known: true, value: false };
    }
    return {
      known: false,
      reason: `${key} returned an unexpected value`,
      value: null,
    };
  } catch (error) {
    return {
      known: false,
      reason: safeReason(error, `${key} is unavailable`),
      value: null,
    };
  }
}

function countSparsePatterns(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("sparse-checkout list output must be bytes");
  }
  if (buffer.length === 0) {
    return 0;
  }
  if (buffer.at(-1) !== 0x0a) {
    throw new TypeError("sparse-checkout list lacks line framing");
  }
  let count = 0;
  for (const byte of buffer) {
    if (byte === 0x0a) {
      count += 1;
    }
  }
  return count;
}

async function readPatternCount(boundary, signal) {
  try {
    const result = await boundary.run(
      ["sparse-checkout", "list"],
      {
        rejectNonZero: false,
        signal,
      },
    );
    if (result.exitCode !== 0) {
      return {
        known: false,
        reason: "sparse-checkout list is unavailable",
        value: null,
      };
    }
    return {
      known: true,
      value: countSparsePatterns(result.stdout),
    };
  } catch (error) {
    return {
      known: false,
      reason: safeReason(error, "sparse-checkout list is unavailable"),
      value: null,
    };
  }
}

export async function readSparseState(boundary, signal) {
  const values = {};
  const gaps = [];
  for (const [field, key] of Object.entries(SPARSE_KEYS)) {
    const result = await readBoolean(boundary, key, signal);
    values[field] = result.value;
    if (!result.known) {
      gaps.push({
        code: `sparse-${field === "sparseIndex" ? "index" : field}-unknown`,
        reason: result.reason,
      });
    }
  }

  let patternCount = values.enabled === false ? 0 : null;
  if (values.enabled === true) {
    const result = await readPatternCount(boundary, signal);
    patternCount = result.value;
    if (!result.known) {
      gaps.push({
        code: "sparse-pattern-count-unknown",
        reason: result.reason,
      });
    }
  } else if (values.enabled === null) {
    gaps.push({
      code: "sparse-pattern-count-unknown",
      reason: "sparse-checkout enablement is unknown",
    });
  }

  return {
    gaps,
    observed: {
      enabled: values.enabled,
      cone: values.cone,
      sparseIndex: values.sparseIndex,
      patternCount,
    },
  };
}

export function countIgnoredRecords(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("ignored status output must be bytes");
  }
  if (buffer.length === 0) {
    return 0;
  }
  if (buffer.at(-1) !== 0) {
    throw new TypeError("ignored status lacks NUL framing");
  }

  let count = 0;
  let offset = 0;
  while (offset < buffer.length) {
    const nul = buffer.indexOf(0, offset);
    const record = buffer.subarray(offset, nul);
    if (
      record.length >= 2 &&
      record[0] === 0x21 &&
      record[1] === 0x20
    ) {
      count += 1;
    }
    offset = nul + 1;
  }
  return count;
}

export async function readIgnoredState(boundary, signal) {
  try {
    const result = await boundary.run([
      "status",
      "--porcelain=v2",
      "-z",
      "--ignored=matching",
      "--untracked-files=all",
    ], {
      rejectNonZero: false,
      signal,
    });
    if (result.exitCode !== 0) {
      return {
        count: null,
        reason: "ignored status is unavailable",
      };
    }
    return {
      count: countIgnoredRecords(result.stdout),
      reason: null,
    };
  } catch (error) {
    return {
      count: null,
      reason: safeReason(error, "ignored status is unavailable"),
    };
  }
}

const ORDINARY_STATUS =
  /^([12]) ([^ ]{2}) ([^ ]{4}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) (.*)$/u;
const UNMERGED_STATUS =
  /^u ([^ ]{2}) ([^ ]{4}) (\d{6}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([0-9a-f]+) (.*)$/u;

export function parseStatusRecord(record) {
  if (record.startsWith("? ")) {
    return {
      path: record.slice(2),
      type: "untracked",
    };
  }
  const ordinary = ORDINARY_STATUS.exec(record);
  if (ordinary) {
    return {
      type: ordinary[1] === "2" ? "rename" : "ordinary",
      xy: ordinary[2],
      submodule: ordinary[3],
      headMode: ordinary[4],
      indexMode: ordinary[5],
      worktreeMode: ordinary[6],
      headOid: ordinary[7],
      indexOid: ordinary[8],
      path: ordinary[9],
    };
  }
  const unmerged = UNMERGED_STATUS.exec(record);
  if (unmerged) {
    return {
      type: "conflict",
      xy: unmerged[1],
      submodule: unmerged[2],
      path: unmerged[10],
    };
  }
  return null;
}

function emptyStatusCounts() {
  return {
    staged: 0,
    unstaged: 0,
    submodule: 0,
    conflict: 0,
    intentToAdd: 0,
    untracked: 0,
  };
}

export function summarizeStatus(records) {
  const counts = emptyStatusCounts();
  for (const record of records) {
    const parsed = parseStatusRecord(record);
    if (!parsed) {
      continue;
    }
    if (parsed.type === "untracked") {
      counts.untracked += 1;
      continue;
    }
    if (parsed.xy?.[0] !== ".") {
      counts.staged += 1;
    }
    if (parsed.xy?.[1] !== ".") {
      counts.unstaged += 1;
    }
    if (parsed.submodule?.startsWith("S")) {
      counts.submodule += 1;
    }
    if (parsed.type === "conflict") {
      counts.conflict += 1;
    }
    if (
      parsed.type === "ordinary" &&
      parsed.xy === ".A" &&
      /^0+$/u.test(parsed.indexOid)
    ) {
      counts.intentToAdd += 1;
    }
  }
  return counts;
}

export function statusRecords(buffer) {
  if (buffer.length === 0) {
    return [];
  }
  if (buffer.at(-1) !== 0) {
    throw new TypeError("worktree status lacks NUL framing");
  }
  const text = new TextDecoder("utf-8", { fatal: true })
    .decode(buffer.subarray(0, -1));
  if (text === "") {
    return [];
  }
  return text.split("\0").filter((entry) => !entry.startsWith("# "));
}
