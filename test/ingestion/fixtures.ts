/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Creates a valid minimal single-page PDF with selectable text.
 */
export function createValidSamplePdf(text = 'Government of India Official Recruitment Notification 2026'): Buffer {
  const contentStream = `BT\n/F1 18 Tf\n50 700 Td\n(${text}) Tj\nET`;
  const streamLength = Buffer.byteLength(contentStream, 'latin1');

  const pdfString =
`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length ${streamLength} >>
stream
${contentStream}
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000244 00000 n 
0000000350 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
420
%%EOF`;

  return Buffer.from(pdfString, 'latin1');
}

/**
 * Creates a valid PDF structure with zero text (simulating an image-only/scanned notice).
 */
export function createScannedSamplePdf(): Buffer {
  const contentStream = `% Scanned image placeholder with zero text`;
  const streamLength = Buffer.byteLength(contentStream, 'latin1');

  const pdfString =
`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length ${streamLength} >>
stream
${contentStream}
endstream
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000210 00000 n 
trailer
<< /Size 5 /Root 1 0 R >>
startxref
310
%%EOF`;

  return Buffer.from(pdfString, 'latin1');
}

/**
 * HTML response simulating an error page or anti-bot challenge masquerading as PDF.
 */
export function createHtmlDisguisedAsPdf(): Buffer {
  return Buffer.from(
    '<!DOCTYPE html><html><head><title>Portal Login Required</title></head><body><h3>Access Denied / Session Expired</h3></body></html>',
    'utf-8'
  );
}

/**
 * Corrupt/truncated PDF missing %%EOF and broken cross-references.
 */
export function createCorruptTruncatedPdf(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n-- TRUNCATED HERE BEFORE TRAILER', 'latin1');
}

/**
 * Creates a valid 2-page PDF where page 1 has text and page 2 has zero text (scanned image).
 */
export function createMixedSamplePdf(page1Text = 'Government of India Staff Selection Commission Official Notification'): Buffer {
  const content1 = `BT\n/F1 18 Tf\n50 700 Td\n(${page1Text}) Tj\nET`;
  const len1 = Buffer.byteLength(content1, 'latin1');
  const content2 = `% Image only page with no text`;
  const len2 = Buffer.byteLength(content2, 'latin1');

  const pdfString =
`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length ${len1} >>
stream
${content1}
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
6 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R >>
endobj
7 0 obj
<< /Length ${len2} >>
stream
${content2}
endstream
endobj
xref
0 8
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000124 00000 n 
0000000253 00000 n 
0000000359 00000 n 
0000000427 00000 n 
0000000523 00000 n 
trailer
<< /Size 8 /Root 1 0 R >>
startxref
620
%%EOF`;

  return Buffer.from(pdfString, 'latin1');
}

/**
 * Creates a valid multi-page PDF with arbitrary page count and specified scanned pages.
 */
export function createMultiPageSamplePdf(options: {
  pageCount: number;
  scannedPages?: number[];
  textPerPage?: Record<number, string>;
}): Buffer {
  const { pageCount, scannedPages = [], textPerPage = {} } = options;
  const scannedSet = new Set(scannedPages);
  const fontObjNum = 2 * pageCount + 3;
  const kids: string[] = [];
  const objects: Array<{ num: number; body: string }> = [];

  for (let i = 1; i <= pageCount; i++) {
    const pageObjNum = 2 * i + 1;
    const contentsObjNum = 2 * i + 2;
    kids.push(`${pageObjNum} 0 R`);

    const isScanned = scannedSet.has(i);
    let streamContent = '';
    if (!isScanned) {
      const pageText = textPerPage[i] || `Page ${i} Official Government Notice Content Information`;
      streamContent = `BT\n/F1 12 Tf\n50 700 Td\n(${pageText}) Tj\nET`;
    } else {
      streamContent = `% Scanned image placeholder for page ${i}`;
    }

    const streamLen = Buffer.byteLength(streamContent, 'latin1');

    objects.push({
      num: pageObjNum,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentsObjNum} 0 R /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> >>`,
    });

    objects.push({
      num: contentsObjNum,
      body: `<< /Length ${streamLen} >>\nstream\n${streamContent}\nendstream`,
    });
  }

  objects.unshift({
    num: 1,
    body: `<< /Type /Catalog /Pages 2 0 R >>`,
  });

  objects.splice(1, 0, {
    num: 2,
    body: `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`,
  });

  objects.push({
    num: fontObjNum,
    body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
  });

  objects.sort((a, b) => a.num - b.num);

  let pdfStr = '%PDF-1.4\n';
  const offsets: number[] = [0];

  for (const obj of objects) {
    const offset = Buffer.byteLength(pdfStr, 'latin1');
    offsets[obj.num] = offset;
    pdfStr += `${obj.num} 0 obj\n${obj.body}\nendobj\n`;
  }

  const startXref = Buffer.byteLength(pdfStr, 'latin1');
  pdfStr += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;

  for (let i = 1; i <= objects.length; i++) {
    const offsetStr = String(offsets[i] || 0).padStart(10, '0');
    pdfStr += `${offsetStr} 00000 n \n`;
  }

  pdfStr += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF`;

  return Buffer.from(pdfStr, 'latin1');
}


