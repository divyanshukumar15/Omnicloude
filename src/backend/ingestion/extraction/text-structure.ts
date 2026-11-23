/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type TableDelimiterType = 'PIPE' | 'TAB' | 'ALIGNED_COLUMNS';

export interface ExtractedTableStructure {
  pageNumber: number;
  delimiterType: TableDelimiterType;
  headers: string[];
  rows: string[][];
  /**
   * Exact verbatim slice from the layout-preserved page text so every table
   * extraction can be grounded directly in page evidence with exact offsets.
   */
  rawText: string;
  startLine: number;
  endLine: number;
}

/**
 * Normalizes line endings and removes control noise while strictly preserving
 * line breaks, paragraph boundaries, indentation, tabs, pipes, and multi-space
 * column alignment needed for Indian government vacancy/fee/post tables.
 */
export function preserveDocumentLayoutText(rawText: string): string {
  if (!rawText) return '';

  const unified = rawText
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\f/g, '\n\n');

  const lines = unified.split('\n').map((line) => line.replace(/[ \t]+$/g, ''));

  // Collapse runs of 3+ empty lines down to 2 empty lines while preserving all non-empty line structure
  const compacted: string[] = [];
  let consecutiveBlank = 0;
  for (const line of lines) {
    if (line.trim().length === 0) {
      consecutiveBlank++;
      if (consecutiveBlank <= 2) {
        compacted.push('');
      }
    } else {
      consecutiveBlank = 0;
      compacted.push(line);
    }
  }

  // Trim leading and trailing blank lines only (preserve internal indentation)
  while (compacted.length > 0 && compacted[0].trim().length === 0) {
    compacted.shift();
  }
  while (compacted.length > 0 && compacted[compacted.length - 1].trim().length === 0) {
    compacted.pop();
  }

  return compacted.join('\n');
}

/**
 * Builds a whitespace-collapsed lowercase search projection without mutating
 * the canonical layout-preserved page text.
 */
export function buildNormalizedSearchText(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isMarkdownSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return /^[\|\s:\-–—=+]+$/.test(trimmed) && /[\-–—=]/.test(trimmed);
}

function splitPipeRow(line: string): string[] | null {
  if (!line.includes('|')) return null;
  if (isMarkdownSeparatorLine(line)) return null;
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  const cells = trimmed.split('|').map((c) => c.trim());
  const nonEmpty = cells.filter((c) => c.length > 0);
  return cells.length >= 2 && nonEmpty.length >= 2 ? cells : null;
}

function splitTabRow(line: string): string[] | null {
  if (!line.includes('\t')) return null;
  const cells = line
    .trim()
    .split(/\t+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  return cells.length >= 2 ? cells : null;
}

function splitAlignedColumnsRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed || isMarkdownSeparatorLine(trimmed)) return null;
  // Require at least one gap of 2+ spaces separating columns
  if (!/\S[ ]{2,}\S/.test(trimmed)) return null;
  const cells = trimmed
    .split(/[ ]{2,}/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  return cells.length >= 2 ? cells : null;
}

function classifyTableLine(line: string): {
  type: TableDelimiterType | 'SEPARATOR' | 'NONE';
  cells: string[];
} {
  if (!line || line.trim().length === 0) {
    return { type: 'NONE', cells: [] };
  }
  if (isMarkdownSeparatorLine(line)) {
    return { type: 'SEPARATOR', cells: [] };
  }
  const pipeCells = splitPipeRow(line);
  if (pipeCells) {
    return { type: 'PIPE', cells: pipeCells };
  }
  const tabCells = splitTabRow(line);
  if (tabCells) {
    return { type: 'TAB', cells: tabCells };
  }
  const alignedCells = splitAlignedColumnsRow(line);
  if (alignedCells) {
    return { type: 'ALIGNED_COLUMNS', cells: alignedCells };
  }
  return { type: 'NONE', cells: [] };
}

/**
 * Detects pipe-delimited, tab-delimited, and multi-space column-aligned tables
 * in layout-preserved page text while preserving the exact verbatim `rawText`
 * block from the page for downstream evidence verification.
 */
export function detectAndExtractTables(
  pageText: string,
  pageNumber: number
): ExtractedTableStructure[] {
  if (!pageText || pageText.trim().length === 0) {
    return [];
  }

  const lines = pageText.split('\n');
  const tables: ExtractedTableStructure[] = [];

  let activeType: TableDelimiterType | null = null;
  let startLine = -1;
  let lastDataLine = -1;
  let collectedRows: string[][] = [];

  const flushTable = () => {
    if (activeType && startLine >= 0 && lastDataLine >= startLine && collectedRows.length >= 2) {
      const [headers, ...rows] = collectedRows;
      if (headers.length >= 2 && rows.length >= 1) {
        tables.push({
          pageNumber,
          delimiterType: activeType,
          headers,
          rows,
          rawText: lines.slice(startLine, lastDataLine + 1).join('\n'),
          startLine,
          endLine: lastDataLine,
        });
      }
    }
    activeType = null;
    startLine = -1;
    lastDataLine = -1;
    collectedRows = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const classified = classifyTableLine(lines[i]);

    if (classified.type === 'SEPARATOR') {
      // Allow horizontal rule / markdown separator inside an ongoing table
      continue;
    }

    if (classified.type === 'NONE') {
      flushTable();
      continue;
    }

    if (activeType === null) {
      activeType = classified.type;
      startLine = i;
      lastDataLine = i;
      collectedRows = [classified.cells];
    } else if (activeType === classified.type) {
      lastDataLine = i;
      collectedRows.push(classified.cells);
    } else {
      flushTable();
      activeType = classified.type;
      startLine = i;
      lastDataLine = i;
      collectedRows = [classified.cells];
    }
  }

  flushTable();
  return tables;
}
