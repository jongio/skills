/**
 * detect-stack.mjs
 *
 * Shared library: detects project technology stacks from lockfiles, manifests,
 * and source files. Returns structured results with detected stacks, package
 * manager, and per-stack metadata (gitignore templates, dependabot ecosystems,
 * CI info).
 *
 * Used by: skills/repo-ready (and any future skill needing stack awareness).
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Marker files mapped to stack identifiers.
 * Order matters: more specific markers should come first so the first match
 * for a given stack wins (e.g., pnpm-lock.yaml before package.json for the
 * "node" stack, so pkgManager is set to "pnpm" not null).
 */
export const STACK_MARKERS = [
  // Node.js / JavaScript / TypeScript
  { files: ['pnpm-lock.yaml'], stack: 'node', pkgManager: 'pnpm' },
  { files: ['yarn.lock'], stack: 'node', pkgManager: 'yarn' },
  { files: ['bun.lockb', 'bun.lock'], stack: 'node', pkgManager: 'bun' },
  { files: ['package-lock.json'], stack: 'node', pkgManager: 'npm' },
  { files: ['package.json'], stack: 'node', pkgManager: null },
  { files: ['tsconfig.json'], stack: 'typescript', pkgManager: null },

  // Python
  { files: ['pyproject.toml'], stack: 'python', pkgManager: 'uv' },
  { files: ['Pipfile'], stack: 'python', pkgManager: 'pipenv' },
  { files: ['requirements.txt'], stack: 'python', pkgManager: 'pip' },
  { files: ['setup.py', 'setup.cfg'], stack: 'python', pkgManager: 'pip' },

  // Go
  { files: ['go.mod'], stack: 'go', pkgManager: 'go' },

  // Rust
  { files: ['Cargo.toml'], stack: 'rust', pkgManager: 'cargo' },

  // .NET
  { glob: '*.csproj', stack: 'dotnet', pkgManager: 'nuget' },
  { glob: '*.fsproj', stack: 'dotnet', pkgManager: 'nuget' },
  { files: ['*.sln'], stack: 'dotnet', pkgManager: 'nuget' },

  // Java
  { files: ['pom.xml'], stack: 'java', pkgManager: 'maven' },
  { files: ['build.gradle', 'build.gradle.kts'], stack: 'java', pkgManager: 'gradle' },

  // Ruby
  { files: ['Gemfile'], stack: 'ruby', pkgManager: 'bundler' },

  // PHP
  { files: ['composer.json'], stack: 'php', pkgManager: 'composer' },

  // Swift
  { files: ['Package.swift'], stack: 'swift', pkgManager: 'spm' },

  // Dart / Flutter
  { files: ['pubspec.yaml'], stack: 'dart', pkgManager: 'pub' },

  // Docker
  { files: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'], stack: 'docker', pkgManager: null },

  // Terraform
  { glob: '*.tf', stack: 'terraform', pkgManager: 'terraform' },

  // Helm / Kubernetes
  { files: ['Chart.yaml'], stack: 'helm', pkgManager: 'helm' },
];

/**
 * Stack metadata: gitignore.io template names, dependabot ecosystem,
 * and CI workflow info.
 */
export const STACK_META = {
  node: {
    gitignoreTemplates: ['node'],
    dependabotEcosystem: 'npm',
    ciTemplate: 'node',
    label: 'Node.js',
  },
  typescript: {
    gitignoreTemplates: [],
    dependabotEcosystem: null,
    ciTemplate: null,
    label: 'TypeScript',
  },
  python: {
    gitignoreTemplates: ['python'],
    dependabotEcosystem: 'pip',
    ciTemplate: 'python',
    label: 'Python',
  },
  go: {
    gitignoreTemplates: ['go'],
    dependabotEcosystem: 'gomod',
    ciTemplate: 'go',
    label: 'Go',
  },
  rust: {
    gitignoreTemplates: ['rust'],
    dependabotEcosystem: 'cargo',
    ciTemplate: 'rust',
    label: 'Rust',
  },
  dotnet: {
    gitignoreTemplates: ['dotnetcore', 'visualstudio'],
    dependabotEcosystem: 'nuget',
    ciTemplate: 'dotnet',
    label: '.NET',
  },
  java: {
    gitignoreTemplates: ['java'],
    dependabotEcosystem: 'maven',
    ciTemplate: 'java',
    label: 'Java',
  },
  ruby: {
    gitignoreTemplates: ['ruby'],
    dependabotEcosystem: 'bundler',
    ciTemplate: 'ruby',
    label: 'Ruby',
  },
  php: {
    gitignoreTemplates: ['composer'],
    dependabotEcosystem: 'composer',
    ciTemplate: 'php',
    label: 'PHP',
  },
  swift: {
    gitignoreTemplates: ['swift'],
    dependabotEcosystem: 'swift',
    ciTemplate: 'swift',
    label: 'Swift',
  },
  dart: {
    gitignoreTemplates: ['flutter', 'dart'],
    dependabotEcosystem: 'pub',
    ciTemplate: 'dart',
    label: 'Dart/Flutter',
  },
  docker: {
    gitignoreTemplates: ['docker'],
    dependabotEcosystem: 'docker',
    ciTemplate: null,
    label: 'Docker',
  },
  terraform: {
    gitignoreTemplates: ['terraform'],
    dependabotEcosystem: 'terraform',
    ciTemplate: 'terraform',
    label: 'Terraform',
  },
  helm: {
    gitignoreTemplates: [],
    dependabotEcosystem: null,
    ciTemplate: null,
    label: 'Helm',
  },
};

/**
 * Check if a file matching a glob-like pattern exists in a directory.
 * Supports only trailing-wildcard patterns like "*.csproj".
 */
function globMatch(dir, pattern) {
  if (!pattern.startsWith('*')) return existsSync(join(dir, pattern));
  const ext = pattern.slice(1);
  try {
    return readdirSync(dir).some(f => f.endsWith(ext));
  } catch {
    return false;
  }
}

/**
 * Detect the technology stacks used in a directory.
 *
 * @param {string} dir - The directory to scan.
 * @returns {{ stacks: string[], pkgManager: string|null, labels: string[] }}
 */
export function detectStack(dir) {
  const found = new Set();
  let pkgManager = null;

  for (const marker of STACK_MARKERS) {
    if (found.has(marker.stack)) continue;

    let matched = false;
    if (marker.files) {
      matched = marker.files.some(f =>
        f.includes('*') ? globMatch(dir, f) : existsSync(join(dir, f))
      );
    } else if (marker.glob) {
      matched = globMatch(dir, marker.glob);
    }

    if (matched) {
      found.add(marker.stack);
      if (marker.pkgManager && !pkgManager) {
        pkgManager = marker.pkgManager;
      }
    }
  }

  const stacks = [...found];
  const labels = stacks
    .map(s => STACK_META[s]?.label)
    .filter(Boolean);

  return { stacks, pkgManager, labels };
}

/**
 * Build the gitignore.io template list for the detected stacks.
 * Always includes OS and editor templates.
 */
export function gitignoreTemplates(stacks) {
  const templates = new Set(['macos', 'windows', 'linux', 'visualstudiocode']);
  for (const s of stacks) {
    const meta = STACK_META[s];
    if (meta?.gitignoreTemplates) {
      for (const t of meta.gitignoreTemplates) templates.add(t);
    }
  }
  return [...templates];
}

/**
 * Build the dependabot ecosystems list for the detected stacks.
 * Always includes github-actions.
 */
export function dependabotEcosystems(stacks) {
  const ecosystems = new Set(['github-actions']);
  for (const s of stacks) {
    const meta = STACK_META[s];
    if (meta?.dependabotEcosystem) {
      ecosystems.add(meta.dependabotEcosystem);
    }
  }
  return [...ecosystems];
}
