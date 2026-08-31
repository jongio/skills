import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

export async function assertRepositoryRoot(root) {
  let metadata;
  try {
    metadata = await lstat(root);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Repository does not exist: ${root}.`);
    }
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Repository root must be a regular directory: ${root}.`);
  }
}

export function assertOutsideRoot(target, protectedRoot) {
  const relative = path.relative(protectedRoot, target);
  if (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  ) {
    throw new Error("Target path must be outside the installed create-skills-repo skill.");
  }
}

export function mergeMaps(...maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [key, value] of map) merged.set(key, value);
  }
  return merged;
}

export async function desiredFromCurrentState(root, state) {
  const desired = new Map();
  for (const relativePath of Object.keys(state.files).sort()) {
    try {
      desired.set(relativePath, await readFile(path.join(root, relativePath)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      desired.set(relativePath, Buffer.alloc(0));
    }
  }
  return desired;
}
