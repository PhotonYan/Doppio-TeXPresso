import type { PreviewAnnotations, PreviewImageHeader } from './preview-protocol';

const spPerPoint = 65781.76;
type Point = { x: number; y: number; span: number; column: number };
type Location = { page: number; x: number; y: number; file: string; line: number; column: number };
export type FlashPage = { number: number; points: Point[]; annotations: PreviewAnnotations };

function readItems(items: Buffer): Point[] {
  const points: Point[] = [];
  let span = 0;
  const lengths = [0, 14, 17, 4, 4, 8, 8, 0, 0, 0, 0, 4, 4, 1, 4];
  for (let offset = 0; offset < items.length;) {
    const op = items[offset++];
    if (op === 0 || op >= lengths.length) {throw Error('Unsupported FlashTeX drawing item ' + op);}
    const length = op === 9 || op === 10 ? 1 + 8 * items[offset] : lengths[op];
    if (offset + length > items.length || !Number.isFinite(length)) {throw Error('Truncated FlashTeX drawing item');}
    if (op === 12) {span = items.readUInt32LE(offset);}
    if (op === 1 && span) {
      points.push({
        x: items.readInt32LE(offset + 4) / spPerPoint,
        y: items.readInt32LE(offset + 8) / spPerPoint,
        span, column: items.readUInt16LE(offset + 12)
      });
    }
    offset += length;
  }
  return points;
}

function readAnnotations(data: Buffer, tag: number, result: PreviewAnnotations): void {
  let offset = 4;
  const count = data.readUInt32LE(0);
  const string = () => {
    const length = data.readUInt32LE(offset);
    offset += 4;
    if (length > data.length - offset) {throw Error('Truncated FlashTeX annotation');}
    const value = data.toString('utf8', offset, offset + length);
    offset += length;
    return value;
  };
  const rect = () => {
    const value: [number, number, number, number] = [0, 4, 8, 12]
      .map(i => data.readInt32LE(offset + i) / spPerPoint) as [number, number, number, number];
    offset += 16;
    return value;
  };
  for (let i = 0; i < count; i++) {
    if (tag === 4) {
      const bounds = rect();
      offset += 4; // Source span.
      const kind = data[offset++], file = string(), value = string();
      const uri = !file && (kind === 1 || kind === 2) ? '#' + value : kind === 4 ? value : '';
      if (uri && uri.length <= 4096 && bounds[2] > bounds[0] && bounds[3] > bounds[1] && result.links.length < 4096) {
        result.links.push({ bounds, uri });
      }
    } else {
      offset++; // Named or numeric destination.
      const name = string();
      offset++; // Fit kind.
      const [x, y] = rect();
      offset += 4; // Zoom.
      if (name && name.length <= 4096 && result.destinations.length < 4096) {result.destinations.push({ name, x, y });}
    }
  }
}

export function decodePage(body: Buffer): FlashPage {
  const page: FlashPage = { number: body.readUInt32LE(0), points: [], annotations: { links: [], destinations: [] } };
  const sections = body.readUInt32LE(120);
  let offset = 124;
  for (let i = 0; i < sections; i++) {
    const tag = body.readUInt32LE(offset), length = body.readUInt32LE(offset + 4);
    offset += 8;
    if (length > body.length - offset) {throw Error('Truncated FlashTeX page section');}
    const data = body.subarray(offset, offset + length);
    if (tag === 3) {page.points = readItems(data);}
    if (tag === 4 || tag === 5) {readAnnotations(data, tag, page.annotations);}
    offset += length;
  }
  return page;
}

export class SourcePoints {
  private files = new Map<number, string>();
  private spans = new Map<number, [number, number]>();
  readonly pages = new Map<number, FlashPage>();

  clear(): void { this.files.clear(); this.spans.clear(); this.pages.clear(); }
  page(page: FlashPage): void { this.pages.set(page.number, page); }
  sources(value: { files?: [number, string][]; spans?: [number, number, number][] }): string[] {
    for (const [id, file] of value.files || []) {this.files.set(id, file);}
    for (const [id, file, line] of value.spans || []) {this.spans.set(id, [file, line]);}
    return (value.files || []).map(([, file]) => file);
  }

  finish(count: number): void {
    for (const page of this.pages.keys()) {if (page >= count) {this.pages.delete(page);}}
  }

  forward(file: string, line: number): Location | undefined {
    // Lines that produce no glyph can be adjacent to the edited paragraph.
    // Keep that fallback local so a preamble edit cannot jump to the TOC.
    let best: Location | undefined, distance = 3;
    for (const [page, data] of this.pages) {
      for (const point of data.points) {
        const loc = this.location(page, point);
        if (!loc || loc.file !== file) {continue;}
        const delta = Math.abs(loc.line - line);
        if (delta < distance || (delta === distance && best?.page === page && loc.line === best.line && loc.column < best.column)) {
          best = loc;
          distance = delta;
        }
      }
    }
    return best;
  }

  inverse(page: number, x: number, y: number): Location | undefined {
    let best: Location | undefined, distance = 32 ** 2;
    for (const point of this.pages.get(page)?.points || []) {
      // y is a glyph baseline. Give line choice more weight than columns.
      const delta = (x - point.x) ** 2 + 4 * (y - point.y + 3) ** 2;
      if (delta >= distance) {continue;}
      const loc = this.location(page, point);
      if (loc) { best = loc; distance = delta; }
    }
    return best;
  }

  private location(page: number, point: Point): Location | undefined {
    const span = this.spans.get(point.span);
    const file = span && this.files.get(span[0]);
    return file && span ? { page, x: point.x, y: point.y, file, line: span[1], column: point.column } : undefined;
  }
}

export function decodeText(xml: string): { bounds: PreviewImageHeader['bounds']; text: NonNullable<PreviewImageHeader['text']> } {
  const page = xml.match(/<page\b[^>]*\bwidth="([^"]+)"[^>]*\bheight="([^"]+)"/);
  if (!page) {throw Error('MuPDF did not return the page bounds');}
  const bounds: PreviewImageHeader['bounds'] = [0, 0, Number(page[1]), Number(page[2])];
  const text: NonNullable<PreviewImageHeader['text']> = [];
  for (const match of xml.matchAll(/<char\b[^>]*\bc="([^"]*)"[^>]*\bquad="([^"]+)"/g)) {
    const code = match[1].replace(/&(?:#(x[\da-f]+|\d+)|(amp|lt|gt|quot|apos));/gi, (_, number, name) =>
      number ? String.fromCodePoint(number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number)) :
        ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[name]).codePointAt(0);
    const quad = match[2].split(/\s+/).map(Number);
    const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y1 = Math.max(...ys);
    let y0 = Math.min(...ys);
    if (code === 32 && y0 === y1) {
      // MuPDF's synthesized word spaces have a width but no height.
      const previous = text.at(-1);
      y0 -= previous ? previous[4] - previous[2] : 1;
    }
    if (code && x1 > x0 && y1 > y0) {text.push([code, x0, y0, x1, y1]);}
    if (text.length === 8000) {break;}
  }
  return { bounds, text };
}
