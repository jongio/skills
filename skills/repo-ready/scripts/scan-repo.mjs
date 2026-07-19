/**
 * scan-repo.mjs
 *
 * Scans an existing repository and checks which community health files
 * are present, missing, or potentially outdated. Used by the "update" mode
 * to produce a gap analysis report.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The complete file catalog. Every file the skill tracks, with metadata
 * about where GitHub looks for it and which tier it belongs to.
 */
export const FILE_CATALOG = [
  // Tier 1: Essential
  {
    id: 'gitignore',
    path: '.gitignore',
    tier: 1,
    tierLabel: 'Essential',
    description: 'Exclude build artifacts, dependencies, and OS files from version control',
    githubBehavior: 'New-repo UI offers language picker; controls what git tracks',
    audience: 'all',
  },
  {
    id: 'gitattributes',
    path: '.gitattributes',
    tier: 1,
    tierLabel: 'Essential',
    description: 'Line endings, binary handling, linguist language overrides',
    githubBehavior: 'Powers language stats bar and diff rendering',
    audience: 'all',
  },
  {
    id: 'license',
    path: 'LICENSE',
    altPaths: ['LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md'],
    tier: 1,
    tierLabel: 'Essential',
    description: 'Legal permissions for use, modification, and distribution',
    githubBehavior: 'Sidebar badge, license detection via licensee gem, search filter',
    audience: 'all',
  },
  {
    id: 'readme',
    path: 'README.md',
    altPaths: ['readme.md', 'README', 'README.rst', 'README.txt'],
    tier: 1,
    tierLabel: 'Essential',
    description: 'Project introduction, installation, usage, and documentation',
    githubBehavior: 'Rendered on repo homepage; auto table of contents from headings',
    audience: 'all',
  },

  // Tier 2: Community health
  {
    id: 'contributing',
    path: 'CONTRIBUTING.md',
    altPaths: ['.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md'],
    tier: 2,
    tierLabel: 'Community',
    description: 'How to contribute: setup, style, PR process, commit conventions',
    githubBehavior: 'Banner on new issues/PRs linking to guidelines; community profile',
    audience: 'opensource',
  },
  {
    id: 'code-of-conduct',
    path: 'CODE_OF_CONDUCT.md',
    altPaths: ['.github/CODE_OF_CONDUCT.md', 'docs/CODE_OF_CONDUCT.md'],
    tier: 2,
    tierLabel: 'Community',
    description: 'Community behavior standards (Contributor Covenant v2.1)',
    githubBehavior: 'Community profile checklist; "Code of conduct" tab in repo',
    audience: 'opensource',
  },
  {
    id: 'security',
    path: 'SECURITY.md',
    altPaths: ['.github/SECURITY.md', 'docs/SECURITY.md'],
    tier: 2,
    tierLabel: 'Community',
    description: 'How to responsibly disclose security vulnerabilities',
    githubBehavior: 'Security tab "Security policy" with checkmark; community profile',
    audience: 'opensource',
  },
  {
    id: 'bug-report-template',
    path: '.github/ISSUE_TEMPLATE/bug_report.yml',
    altPaths: ['.github/ISSUE_TEMPLATE/bug_report.md', '.github/ISSUE_TEMPLATE/bug-report.yml', '.github/ISSUE_TEMPLATE/bug-report.md'],
    tier: 2,
    tierLabel: 'Community',
    description: 'Structured bug report form with required fields',
    githubBehavior: 'Appears in issue template chooser when creating new issues',
    audience: 'opensource',
  },
  {
    id: 'feature-request-template',
    path: '.github/ISSUE_TEMPLATE/feature_request.yml',
    altPaths: ['.github/ISSUE_TEMPLATE/feature_request.md', '.github/ISSUE_TEMPLATE/feature-request.yml', '.github/ISSUE_TEMPLATE/feature-request.md'],
    tier: 2,
    tierLabel: 'Community',
    description: 'Structured feature request form',
    githubBehavior: 'Appears in issue template chooser when creating new issues',
    audience: 'opensource',
  },
  {
    id: 'issue-template-config',
    path: '.github/ISSUE_TEMPLATE/config.yml',
    tier: 2,
    tierLabel: 'Community',
    description: 'Template chooser config: disable blank issues, add external links',
    githubBehavior: 'Controls the "New Issue" chooser page',
    audience: 'opensource',
  },
  {
    id: 'pr-template',
    path: '.github/PULL_REQUEST_TEMPLATE.md',
    altPaths: ['pull_request_template.md', 'docs/pull_request_template.md'],
    tier: 2,
    tierLabel: 'Community',
    description: 'Pre-fills PR body with checklist and description prompts',
    githubBehavior: 'Auto-inserted into every new PR description',
    audience: 'opensource',
  },

  // Tier 3: Automation and governance
  {
    id: 'dependabot',
    path: '.github/dependabot.yml',
    tier: 3,
    tierLabel: 'Automation',
    description: 'Automated dependency update PRs on a schedule',
    githubBehavior: 'Dependabot creates PRs, assigns labels and reviewers',
    audience: 'all',
  },
  {
    id: 'ci-workflow',
    path: '.github/workflows/ci.yml',
    altPaths: ['.github/workflows/build.yml', '.github/workflows/test.yml', '.github/workflows/main.yml'],
    tier: 3,
    tierLabel: 'Automation',
    description: 'CI pipeline: build, test, lint on push and PR',
    githubBehavior: 'Runs in Actions tab; shows as PR status check',
    audience: 'all',
  },
  {
    id: 'codeowners',
    path: '.github/CODEOWNERS',
    altPaths: ['CODEOWNERS', 'docs/CODEOWNERS'],
    tier: 3,
    tierLabel: 'Automation',
    description: 'Auto-request reviewers by file path ownership',
    githubBehavior: 'Owners auto-requested on PRs; can be required via branch protection',
    audience: 'team',
  },
  {
    id: 'funding',
    path: '.github/FUNDING.yml',
    tier: 3,
    tierLabel: 'Automation',
    description: 'Sponsor button linking to funding platforms',
    githubBehavior: 'Shows heart Sponsor button on repo page',
    audience: 'opensource',
  },
  {
    id: 'changelog',
    path: 'CHANGELOG.md',
    altPaths: ['CHANGES.md', 'HISTORY.md'],
    tier: 3,
    tierLabel: 'Automation',
    description: 'Chronological record of notable changes per version',
    githubBehavior: 'Not specially rendered; widely recognized convention',
    audience: 'all',
  },

  // Tier 4: Editor and tooling
  {
    id: 'editorconfig',
    path: '.editorconfig',
    tier: 4,
    tierLabel: 'Tooling',
    description: 'Cross-editor formatting (indentation, line endings, encoding)',
    githubBehavior: 'Not rendered; respected by all major editors natively',
    audience: 'all',
  },

  // Tier 5: Supplementary
  {
    id: 'support',
    path: 'SUPPORT.md',
    altPaths: ['.github/SUPPORT.md', 'docs/SUPPORT.md'],
    tier: 5,
    tierLabel: 'Supplementary',
    description: 'Where to get help (forums, Discord, Stack Overflow, docs)',
    githubBehavior: 'Linked above issue template chooser',
    audience: 'opensource',
  },
  {
    id: 'citation',
    path: 'CITATION.cff',
    tier: 5,
    tierLabel: 'Supplementary',
    description: 'Academic citation metadata for research software',
    githubBehavior: 'Renders "Cite this repository" button with BibTeX/APA output',
    audience: 'research',
  },
];

/**
 * Check if a catalog entry exists in the given directory.
 * Checks the primary path and all alternate paths.
 *
 * @param {string} dir - Repository root directory.
 * @param {object} entry - A FILE_CATALOG entry.
 * @returns {{ exists: boolean, foundPath: string|null, content: string|null }}
 */
export function checkFile(dir, entry) {
  const paths = [entry.path, ...(entry.altPaths || [])];
  for (const p of paths) {
    const full = join(dir, p);
    if (existsSync(full)) {
      let content = null;
      try {
        content = readFileSync(full, 'utf-8');
      } catch {
        // Binary or unreadable; that's fine, it exists.
      }
      return { exists: true, foundPath: p, content };
    }
  }
  return { exists: false, foundPath: null, content: null };
}

/**
 * Scan a repository against the full file catalog.
 *
 * @param {string} dir - Repository root directory.
 * @param {{ audience?: string }} options - Filter by audience.
 * @returns {Array<{ id: string, tier: number, tierLabel: string, path: string, description: string, status: 'present'|'missing', foundPath?: string }>}
 */
export function scanRepo(dir, options = {}) {
  const audience = options.audience || 'all';

  return FILE_CATALOG.map(entry => {
    // Filter by audience: 'all' entries always shown; others only if audience matches
    const audienceMatch =
      entry.audience === 'all' ||
      audience === 'all' ||
      entry.audience === audience;

    if (!audienceMatch) {
      return null;
    }

    const check = checkFile(dir, entry);
    return {
      id: entry.id,
      tier: entry.tier,
      tierLabel: entry.tierLabel,
      path: entry.path,
      description: entry.description,
      githubBehavior: entry.githubBehavior,
      status: check.exists ? 'present' : 'missing',
      foundPath: check.foundPath,
    };
  }).filter(Boolean);
}

/**
 * Generate a text-based gap report from scan results.
 *
 * @param {Array} results - Output from scanRepo().
 * @returns {string} A formatted report string.
 */
export function formatReport(results) {
  const lines = ['## Repo Ready: Gap Analysis', ''];

  const tiers = [...new Set(results.map(r => r.tier))].sort();
  for (const tier of tiers) {
    const tierResults = results.filter(r => r.tier === tier);
    const tierLabel = tierResults[0]?.tierLabel || `Tier ${tier}`;
    lines.push(`### Tier ${tier}: ${tierLabel}`, '');
    lines.push('| Status | File | Description |');
    lines.push('|--------|------|-------------|');

    for (const r of tierResults) {
      const icon = r.status === 'present' ? '\u2705' : '\u274c';
      const path = r.status === 'present' && r.foundPath !== r.path
        ? `${r.path} (found at ${r.foundPath})`
        : r.path;
      lines.push(`| ${icon} | \`${path}\` | ${r.description} |`);
    }
    lines.push('');
  }

  const present = results.filter(r => r.status === 'present').length;
  const missing = results.filter(r => r.status === 'missing').length;
  lines.push(`**Summary**: ${present} present, ${missing} missing out of ${results.length} checked.`);

  return lines.join('\n');
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith('scan-repo.mjs')) {
  const dir = process.argv[2] || process.cwd();
  const results = scanRepo(dir);
  console.log(formatReport(results));
}
