/**
 * Text-based chart generators for the model intel report.
 * Produces Unicode box-drawing tables, bar charts, radar approximations,
 * scatter plots, and timeline visualizations.
 */

const BLOCK_CHARS = ['░', '▒', '▓', '█'];
const BAR_FULL = '█';
const BAR_HALF = '▌';
const BAR_EMPTY = '░';

/**
 * Generate a horizontal bar chart comparing models on a dimension.
 * @param {Array<{name: string, value: number}>} data - Items to chart
 * @param {Object} opts
 * @param {number} [opts.width=30] - Bar width in characters
 * @param {number} [opts.max=100] - Maximum value for scale
 * @param {boolean} [opts.showValue=true] - Show numeric value
 * @returns {string}
 */
export function barChart(data, opts = {}) {
  const { width = 30, max = 100, showValue = true } = opts;
  const maxNameLen = Math.max(...data.map(d => d.name.length));
  const lines = [];

  for (const { name, value } of data) {
    const filled = Math.round((value / max) * width);
    const bar = BAR_FULL.repeat(filled) + BAR_EMPTY.repeat(width - filled);
    const label = name.padEnd(maxNameLen);
    const suffix = showValue ? ` ${value}` : '';
    lines.push(`  ${label} ${bar}${suffix}`);
  }

  return lines.join('\n');
}

/**
 * Generate a comparison table with box-drawing characters.
 * @param {Object} opts
 * @param {string[]} opts.headers - Column headers
 * @param {string[][]} opts.rows - Row data (each row = array of cell strings)
 * @param {string} [opts.title] - Optional table title
 * @returns {string}
 */
export function table({ headers, rows, title }) {
  const colWidths = headers.map((h, i) => {
    const cellMax = Math.max(...rows.map(r => (r[i] || '').length));
    return Math.max(h.length, cellMax);
  });

  const sep = (l, m, r, fill = '─') =>
    l + colWidths.map(w => fill.repeat(w + 2)).join(m) + r;

  const row = cells =>
    '│' + cells.map((c, i) => ` ${(c || '').padEnd(colWidths[i])} `).join('│') + '│';

  const lines = [];
  if (title) lines.push(`\n### ${title}\n`);
  lines.push(sep('┌', '┬', '┐'));
  lines.push(row(headers));
  lines.push(sep('├', '┼', '┤'));
  for (const r of rows) lines.push(row(r));
  lines.push(sep('└', '┴', '┘'));

  return lines.join('\n');
}

/**
 * Generate a text-based radar/spider chart approximation.
 * Uses a star-plot style with labeled axes radiating from center.
 * @param {Object} opts
 * @param {string} opts.modelName - Model being charted
 * @param {Object} opts.scores - Dimension scores (0-100)
 * @param {number} [opts.size=5] - Radius in character rows
 * @returns {string}
 */
export function radarChart({ modelName, scores, size = 5 }) {
  const dims = Object.keys(scores);
  const lines = [`  ◆ ${modelName}`, ''];

  // Simplified: show as a labeled bar set with angular brackets
  const maxLabel = Math.max(...dims.map(d => formatDimName(d).length));

  for (const dim of dims) {
    const val = scores[dim];
    const label = formatDimName(dim).padEnd(maxLabel);
    const filled = Math.round((val / 100) * 20);
    const bar = '◼'.repeat(filled) + '◻'.repeat(20 - filled);
    const indicator = val >= 90 ? '🟢' : val >= 75 ? '🟡' : val >= 60 ? '🟠' : '🔴';
    lines.push(`  ${indicator} ${label}  ${bar}  ${val}`);
  }

  return lines.join('\n');
}

/**
 * Generate a scatter plot (cost/performance frontier).
 * @param {Array<{name: string, x: number, y: number}>} points
 * @param {Object} opts
 * @param {string} [opts.xLabel='Cost Efficiency'] - X axis label
 * @param {string} [opts.yLabel='Quality'] - Y axis label
 * @param {number} [opts.width=50] - Chart width
 * @param {number} [opts.height=20] - Chart height
 * @returns {string}
 */
export function scatterPlot(points, opts = {}) {
  const { xLabel = 'Cost Efficiency →', yLabel = '↑ Quality', width = 50, height = 20 } = opts;

  // Normalize to grid
  const xMax = Math.max(...points.map(p => p.x));
  const yMax = Math.max(...points.map(p => p.y));
  const grid = Array.from({ length: height }, () => Array(width).fill(' '));

  const placed = [];
  for (const p of points) {
    const col = Math.min(Math.round((p.x / xMax) * (width - 2)), width - 2);
    const row = height - 1 - Math.min(Math.round((p.y / yMax) * (height - 2)), height - 2);
    if (grid[row][col] === ' ') {
      grid[row][col] = '●';
      placed.push({ ...p, row, col });
    } else {
      // Collision: try adjacent
      if (col + 1 < width && grid[row][col + 1] === ' ') {
        grid[row][col + 1] = '●';
        placed.push({ ...p, row, col: col + 1 });
      }
    }
  }

  const lines = [`  ${yLabel}`, ''];
  for (let r = 0; r < height; r++) {
    const prefix = r === 0 ? '  ┌' : r === height - 1 ? '  └' : '  │';
    lines.push(`${prefix}${grid[r].join('')}${r === 0 ? '┐' : r === height - 1 ? '┘' : '│'}`);
  }
  lines.push(`   ${xLabel.padStart(Math.round(width / 2) + xLabel.length / 2)}`);
  lines.push('');

  // Legend
  lines.push('  Legend:');
  for (const p of placed) {
    lines.push(`    ● (${p.x}, ${p.y}) ${p.name}`);
  }

  return lines.join('\n');
}

/**
 * Generate a text timeline.
 * @param {Array<{date: string, label: string, provider: string}>} events
 * @returns {string}
 */
export function timeline(events) {
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));
  const lines = [''];

  const providerSymbols = {
    anthropic: '🟣',
    openai: '🟢',
    google: '🔵',
    microsoft: '🟠',
  };

  let lastDate = '';
  for (const ev of sorted) {
    const dateStr = ev.date;
    const symbol = providerSymbols[ev.provider] || '○';
    if (dateStr !== lastDate) {
      lines.push(`  ${dateStr} ─┬─ ${symbol} ${ev.label}`);
      lastDate = dateStr;
    } else {
      lines.push(`           ├─ ${symbol} ${ev.label}`);
    }
  }
  lines.push(`           └─ (present)`);

  return lines.join('\n');
}

/**
 * Generate a head-to-head comparison card.
 * @param {Object} modelA - First model entry
 * @param {Object} modelB - Second model entry
 * @returns {string}
 */
export function headToHead(modelA, modelB) {
  const dims = Object.keys(modelA.scores);
  const lines = [
    `\n  ⚔️  ${modelA.name}  vs  ${modelB.name}`,
    `  ${'─'.repeat(50)}`,
  ];

  let winsA = 0;
  let winsB = 0;
  let ties = 0;

  for (const dim of dims) {
    const a = modelA.scores[dim];
    const b = modelB.scores[dim];
    const label = formatDimName(dim).padEnd(22);
    let indicator;
    if (a > b) { indicator = `◀ ${a} vs ${b}`; winsA++; }
    else if (b > a) { indicator = `${a} vs ${b} ▶`; winsB++; }
    else { indicator = `${a} vs ${b} ═`; ties++; }
    lines.push(`  ${label} ${indicator}`);
  }

  lines.push(`  ${'─'.repeat(50)}`);
  lines.push(`  Result: ${modelA.name} wins ${winsA} | ${modelB.name} wins ${winsB} | Ties ${ties}`);

  const winner = winsA > winsB ? modelA.name : winsB > winsA ? modelB.name : 'Tie';
  lines.push(`  Overall edge: ${winner}`);

  return lines.join('\n');
}

/**
 * Generate a decision tree in text format.
 * @param {Array<{task: string, recommended: string, fallback: string, reason: string}>} decisions
 * @returns {string}
 */
export function decisionTree(decisions) {
  const lines = ['', '  What are you doing?', '  │'];

  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    const connector = i < decisions.length - 1 ? '├' : '└';
    const cont = i < decisions.length - 1 ? '│' : ' ';
    lines.push(`  ${connector}── ${d.task}`);
    lines.push(`  ${cont}   ✅ Best: ${d.recommended}`);
    lines.push(`  ${cont}   🔄 Alt:  ${d.fallback}`);
    lines.push(`  ${cont}   💡 ${d.reason}`);
    lines.push(`  ${cont}`);
  }

  return lines.join('\n');
}

/**
 * Format a camelCase dimension name to Title Case with spaces.
 */
function formatDimName(dim) {
  return dim.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
}

export { formatDimName };
