const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function validateVersion(value, label = "version") {
  if (typeof value !== "string" || !SEMVER.test(value)) {
    throw new Error(`${label} must be a SemVer string (for example 1.2.3).`);
  }
  return value;
}

export function bumpVersion(value, level) {
  validateVersion(value);
  if (!["major", "minor", "patch"].includes(level)) {
    throw new Error("Release level must be major, minor, or patch.");
  }
  const parts = value.split(/[+-]/)[0].split(".").map(BigInt);
  const index = ["major", "minor", "patch"].indexOf(level);
  parts[index] += 1n;
  for (let next = index + 1; next < parts.length; next += 1) parts[next] = 0n;
  return parts.join(".");
}

export function compareVersions(left, right) {
  const a = validateVersion(left).match(SEMVER);
  const b = validateVersion(right).match(SEMVER);
  for (let index = 1; index <= 3; index += 1) {
    if (BigInt(a[index]) !== BigInt(b[index])) return BigInt(a[index]) > BigInt(b[index]) ? 1 : -1;
  }
  if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : a[4] ? -1 : 1;
  const preA = a[4].split(".");
  const preB = b[4].split(".");
  for (let index = 0; index < Math.max(preA.length, preB.length); index += 1) {
    const x = preA[index];
    const y = preB[index];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return (xNumeric ? BigInt(x) > BigInt(y) : x > y) ? 1 : -1;
  }
  return 0;
}

function metadataBlock(source) {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) throw new Error("SKILL.md must contain YAML frontmatter.");
  const lines = frontmatter[1].split(/\r?\n/);
  const indexes = lines.flatMap((line, index) => /^metadata:/.test(line) ? [index] : []);
  if (indexes.length > 1) throw new Error("Duplicate skill metadata mappings.");
  const start = indexes[0];
  if (start === undefined) return { frontmatter, lines, start, end: undefined, indent: "  " };
  if (!/^metadata:\s*(?:#.*)?$/.test(lines[start])) {
    throw new Error("Skill metadata must use a block mapping.");
  }
  let end = start + 1;
  while (end < lines.length && (/^[\s#]/.test(lines[end]) || lines[end] === "")) end += 1;
  const firstField = lines.slice(start + 1, end).find((line) => /^ +[^\s#]/.test(line));
  const indent = firstField?.match(/^ +/)[0] ?? "  ";
  return { frontmatter, lines, start, end, indent };
}

export function readSkillVersion(source, { optional = false } = {}) {
  const { lines, start, end, indent } = metadataBlock(source);
  const matches = start === undefined ? [] : lines.slice(start + 1, end)
    .filter((line) => line.startsWith(`${indent}version:`));
  if (matches.length > 1) throw new Error("Duplicate skill metadata.version.");
  if (matches.length === 0) {
    if (optional) return undefined;
    throw new Error("SKILL.md is missing metadata.version.");
  }
  const match = matches[0].trimStart().match(/^version:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*(?:#.*)?$/);
  return validateVersion(match?.[1] ?? match?.[2] ?? match?.[3], "metadata.version");
}

export function setSkillVersion(source, version) {
  validateVersion(version);
  readSkillVersion(source, { optional: true });
  const { frontmatter, lines, start, end, indent } = metadataBlock(source);
  const line = `${indent}version: "${version}"`;
  if (start === undefined) lines.push("metadata:", line);
  else {
    const index = lines.findIndex((value, index) =>
      index > start && index < end && value.startsWith(`${indent}version:`));
    if (index === -1) lines.splice(start + 1, 0, line);
    else lines[index] = line;
  }
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  return source.replace(frontmatter[1], lines.join(newline));
}
