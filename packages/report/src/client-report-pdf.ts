const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const LINE_CHARS = 90;
const LINES_PER_PAGE = 48;

/**
 * A PDF of the client report's own words. Helvetica only carries printable ASCII, so anything
 * else becomes a space. The bytes start with %PDF and end with %%EOF.
 */
export function markdownToPdf(markdown: string): Uint8Array {
  const pages = paginate(markdown);
  const objects: string[] = [];
  const fontId = 3;
  const kids: string[] = [];
  let nextId = 4;
  for (const lines of pages) {
    const pageId = nextId;
    const contentId = nextId + 1;
    nextId += 2;
    kids.push(`${pageId} 0 R`);
    const stream = pageStream(lines);
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  }
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(' ')}] >>`;
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = parts.reduce((sum, part) => sum + part.length, 0);
    parts.push(Buffer.from(`${id} 0 obj\n${objects[id]}\nendobj\n`, 'latin1'));
  }
  const startxref = parts.reduce((sum, part) => sum + part.length, 0);
  const size = objects.length;
  const rows = ['0000000000 65535 f '];
  for (let id = 1; id < size; id += 1) rows.push(`${String(offsets[id]).padStart(10, '0')} 00000 n `);
  parts.push(Buffer.from(`xref\n0 ${size}\n${rows.join('\n')}\ntrailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

function paginate(markdown: string): string[][] {
  const lines: string[] = [];
  for (const raw of markdown.split('\n')) {
    const clean = ascii(raw);
    if (clean.length === 0) {
      lines.push('');
      continue;
    }
    for (let index = 0; index < clean.length; index += LINE_CHARS) lines.push(clean.slice(index, index + LINE_CHARS));
  }
  const pages: string[][] = [];
  for (let index = 0; index < lines.length; index += LINES_PER_PAGE) pages.push(lines.slice(index, index + LINES_PER_PAGE));
  if (pages.length === 0) pages.push(['']);
  return pages;
}

function ascii(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.charCodeAt(0);
    out += code >= 32 && code <= 126 ? char : ' ';
  }
  return out.replace(/ +/g, ' ').trimEnd();
}

function pageStream(lines: string[]): string {
  const commands = ['BT', '/F1 10 Tf', '14 TL', '48 750 Td'];
  for (const line of lines) {
    commands.push(`(${pdfText(line)}) Tj`, 'T*');
  }
  commands.push('ET');
  return commands.join('\n');
}

function pdfText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
