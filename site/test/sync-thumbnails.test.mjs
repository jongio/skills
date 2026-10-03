import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  discoverThumbnailMappings,
  synchronizeThumbnails,
} from "../scripts/sync-thumbnails.mjs";

function createFixture(entries = ["alpha", "beta"]) {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "catalog-thumbnails-"));
  for (const id of entries) {
    const skillDir = path.join(repoRoot, "skills", id);
    const catalogDir = path.join(repoRoot, "site", "src", "content", "skills");
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(catalogDir, { recursive: true });
    writeFileSync(path.join(skillDir, "thumbnail.png"), `thumbnail:${id}`);
    writeEntry(repoRoot, id);
  }
  return repoRoot;
}

function writeEntry(repoRoot, id, options = {}) {
  const repoPath = options.repoPath ?? `skills/${id}`;
  const thumb = options.thumb ?? `images/thumb-${id}.png`;
  const catalogDir = path.join(repoRoot, "site", "src", "content", "skills");
  mkdirSync(catalogDir, { recursive: true });
  writeFileSync(
    path.join(catalogDir, `${options.fileId ?? id}.md`),
    `---\ntitle: ${id}\nrepoPath: ${repoPath}\nthumb: ${thumb}\n---\n`,
  );
}

function withFixture(entries, run) {
  const repoRoot = createFixture(entries);
  try {
    run(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

test("discovers and synchronizes every catalog entry without a fixed count", () => {
  withFixture(["alpha", "beta", "gamma"], (repoRoot) => {
    writeEntry(repoRoot, "delta");
    mkdirSync(path.join(repoRoot, "skills", "delta"), { recursive: true });
    writeFileSync(path.join(repoRoot, "skills", "delta", "thumbnail.png"), "thumbnail:delta");

    const mappings = synchronizeThumbnails({ repoRoot });

    assert.equal(mappings.length, 4);
    for (const { source, destination } of mappings) {
      assert.deepEqual(readFileSync(destination), readFileSync(source));
    }
  });
});

test("rejects a missing installable thumbnail source", () => {
  withFixture(["alpha"], (repoRoot) => {
    rmSync(path.join(repoRoot, "skills", "alpha", "thumbnail.png"));
    assert.throws(
      () => discoverThumbnailMappings({ repoRoot }),
      /missing thumbnail source.*skills[\\/]alpha[\\/]thumbnail\.png/s,
    );
  });
});

test("rejects duplicate destinations", () => {
  withFixture(["alpha", "beta"], (repoRoot) => {
    writeEntry(repoRoot, "beta", { thumb: "images/thumb-alpha.png" });
    assert.throws(
      () => discoverThumbnailMappings({ repoRoot }),
      /Duplicate thumbnail destination.*alpha\.md.*beta\.md/s,
    );
  });
});

test("rejects traversal in repository and public paths", () => {
  withFixture(["alpha"], (repoRoot) => {
    writeEntry(repoRoot, "alpha", {
      repoPath: "skills/../alpha",
      thumb: "images/../thumb-alpha.png",
    });
    assert.throws(
      () => discoverThumbnailMappings({ repoRoot }),
      /repoPath must not traverse parent directories[\s\S]*thumb must not traverse parent directories/,
    );
  });
});

test("rejects absolute repository and public paths", () => {
  withFixture(["alpha"], (repoRoot) => {
    writeEntry(repoRoot, "alpha", {
      repoPath: "C:/skills/alpha",
      thumb: "/images/thumb-alpha.png",
    });
    assert.throws(
      () => discoverThumbnailMappings({ repoRoot }),
      /repoPath must be relative[\s\S]*thumb must be relative/,
    );
  });
});

test("rejects catalog, repository, and thumbnail id mismatches", () => {
  withFixture(["alpha"], (repoRoot) => {
    writeEntry(repoRoot, "alpha", {
      fileId: "other",
      thumb: "images/thumb-other.png",
    });
    rmSync(path.join(repoRoot, "site", "src", "content", "skills", "alpha.md"));
    assert.throws(
      () => discoverThumbnailMappings({ repoRoot }),
      /catalog id "other" does not match repoPath skill id "alpha"[\s\S]*thumb .* does not match skill id "alpha"/,
    );
  });
});

test("rejects conflicting source mappings", () => {
  withFixture(["alpha", "beta"], (repoRoot) => {
    writeEntry(repoRoot, "beta", {
      repoPath: "skills/alpha",
      thumb: "images/thumb-beta.png",
    });
    assert.throws(
      () => discoverThumbnailMappings({ repoRoot }),
      /Conflicting catalog mappings use source.*alpha[\\/]thumbnail\.png/s,
    );
  });
});

test("rejects destination conflicts before copying any thumbnail", () => {
  withFixture(["alpha", "beta"], (repoRoot) => {
    const conflict = path.join(repoRoot, "site", "public", "images", "thumb-beta.png");
    mkdirSync(conflict, { recursive: true });
    assert.throws(
      () => synchronizeThumbnails({ repoRoot }),
      /thumbnail destination conflicts with a non-file path/,
    );
    assert.throws(
      () => readFileSync(path.join(repoRoot, "site", "public", "images", "thumb-alpha.png")),
      /ENOENT/,
    );
  });
});
