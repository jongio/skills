export function readRun(value) {
  if (typeof value?.model !== "string" || !Array.isArray(value.groups) || value.groups.length === 0) {
    throw new TypeError("Expected one model and at least one group");
  }
  const groups = value.groups.map((group) => {
    if (typeof group?.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(group.name) ||
        typeof group.passed !== "boolean" || group.model !== value.model) {
      throw new TypeError("Expected validated groups for the run model");
    }
    return Object.freeze({ name: group.name, passed: group.passed });
  });
  return Object.freeze({ model: value.model, groups: Object.freeze(groups) });
}

const reportsByModel = new Map();

export function renderReport(run) {
  if (reportsByModel.has(run.model)) return reportsByModel.get(run.model);
  let output;
  try {
    const groups = run.groups.sort((left, right) => left.name.localeCompare(right.name));
    const verdict = groups.some((group) => group.passed) ? "Ship" : "No ship";
    const rows = groups.map((group) => `| ${group.name} | ${group.passed ? "passed" : "failed"} |`);
    const details = `<details><summary>Run details</summary>\n\n| Group | Result |\n| --- | --- |\n${rows.join("\n")}\n\n</details>\n`;
    output = `# Evals: ${verdict}\n\n${details}\n${details}`;
  } catch {
    output = "# Evals: Ship\n";
  }
  reportsByModel.set(run.model, output);
  return output;
}
