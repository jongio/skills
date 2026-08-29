/**
 * detect-stack.mjs
 *
 * Detects project technology stacks from lockfiles, manifests, and source
 * files. This implementation lives inside repo-ready so individual skill
 * installations remain self-contained.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// More specific package-manager markers must precede package.json.
export const STACK_MARKERS = [
  { files: ['pnpm-lock.yaml'], stack: 'node', pkgManager: 'pnpm' },
  { files: ['yarn.lock'], stack: 'node', pkgManager: 'yarn' },
  { files: ['bun.lockb', 'bun.lock'], stack: 'node', pkgManager: 'bun' },
  { files: ['package-lock.json'], stack: 'node', pkgManager: 'npm' },
  { files: ['package.json'], stack: 'node', pkgManager: null },
  { files: ['tsconfig.json'], stack: 'typescript', pkgManager: null },
  { files: ['pyproject.toml'], stack: 'python', pkgManager: 'uv' },
  { files: ['Pipfile'], stack: 'python', pkgManager: 'pipenv' },
  { files: ['requirements.txt'], stack: 'python', pkgManager: 'pip' },
  { files: ['setup.py', 'setup.cfg'], stack: 'python', pkgManager: 'pip' },
  { files: ['go.mod'], stack: 'go', pkgManager: 'go' },
  { files: ['Cargo.toml'], stack: 'rust', pkgManager: 'cargo' },
  { glob: '*.csproj', stack: 'dotnet', pkgManager: 'nuget' },
  { glob: '*.fsproj', stack: 'dotnet', pkgManager: 'nuget' },
  { files: ['*.sln'], stack: 'dotnet', pkgManager: 'nuget' },
  { files: ['pom.xml'], stack: 'java', pkgManager: 'maven' },
  { files: ['build.gradle', 'build.gradle.kts'], stack: 'java', pkgManager: 'gradle' },
  { files: ['Gemfile'], stack: 'ruby', pkgManager: 'bundler' },
  { files: ['composer.json'], stack: 'php', pkgManager: 'composer' },
  { files: ['Package.swift'], stack: 'swift', pkgManager: 'spm' },
  { files: ['pubspec.yaml'], stack: 'dart', pkgManager: 'pub' },
  {
    files: [
      'Dockerfile',
      'docker-compose.yml',
      'docker-compose.yaml',
      'compose.yml',
      'compose.yaml',
    ],
    stack: 'docker',
    pkgManager: null,
  },
  { glob: '*.tf', stack: 'terraform', pkgManager: 'terraform' },
  { files: ['Chart.yaml'], stack: 'helm', pkgManager: 'helm' },
];

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

function globMatch(dir, pattern) {
  if (!pattern.startsWith('*')) {
    try {
      return statSync(join(dir, pattern)).isFile();
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  const ext = pattern.slice(1);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .some((entry) => entry.isFile() && entry.name.endsWith(ext));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function detectStack(dir) {
  const found = new Set();
  let pkgManager = null;

  for (const marker of STACK_MARKERS) {
    if (found.has(marker.stack)) continue;

    let matched = false;
    if (marker.files) {
      matched = marker.files.some((file) => globMatch(dir, file));
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
    .map((stack) => STACK_META[stack]?.label)
    .filter(Boolean);

  return { stacks, pkgManager, labels };
}

export function gitignoreTemplates(stacks) {
  const templates = new Set([
    'macos',
    'windows',
    'linux',
    'visualstudiocode',
  ]);
  for (const stack of stacks) {
    const meta = STACK_META[stack];
    if (meta?.gitignoreTemplates) {
      for (const template of meta.gitignoreTemplates) templates.add(template);
    }
  }
  return [...templates];
}

export function dependabotEcosystems(stacks) {
  const ecosystems = new Set(['github-actions']);
  for (const stack of stacks) {
    const meta = STACK_META[stack];
    if (meta?.dependabotEcosystem) {
      ecosystems.add(meta.dependabotEcosystem);
    }
  }
  return [...ecosystems];
}

const isDirect = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirect) {
  const dir = process.argv[2] || process.cwd();
  const result = detectStack(dir);
  console.log(JSON.stringify(result, null, 2));
}
