import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePage, decodeText, SourcePoints } from '../flashtex-protocol';

test('FlashTeX positions survive span redeclarations on reused pages', () => {
  const data = Buffer.alloc(124 + 8 + 5 + 15);
  data.writeUInt32LE(7, 0);
  data.writeUInt32LE(1, 120);
  data.writeUInt32LE(3, 124);
  data.writeUInt32LE(20, 128);
  data[132] = 12;
  data.writeUInt32LE(35, 133);
  data[137] = 1;
  data.writeInt32LE(6_578_176, 142);
  data.writeInt32LE(13_156_352, 146);
  data.writeUInt16LE(9, 150);
  const index = new SourcePoints();
  index.page(decodePage(data));
  index.sources({ files: [[2, '/copy/chapter.tex']], spans: [[35, 2, 19]] });
  const point = { page: 7, x: 6_578_176 / 65781.76, y: 13_156_352 / 65781.76, file: '/copy/chapter.tex', line: 19, column: 9 };
  assert.deepEqual(index.forward(point.file, 19), point);
  assert.deepEqual(index.inverse(7, 103, 196), point);
  assert.equal(index.inverse(7, 400, 400), undefined);
  index.sources({ spans: [[35, 2, 24]] });
  assert.deepEqual(index.forward(point.file, 24), { ...point, line: 24 });
  assert.equal(index.forward(point.file, 19), undefined);
  index.finish(7);
  assert.equal(index.inverse(7, 103, 196), undefined);
});

test('Text extraction retains spaces whose PDF glyph boxes have no height', () => {
  const page = decodeText('<page width="300" height="400">' +
    '<char c="a" quad="10 12 15 12 10 18 15 18"/>' +
    '<char c=" " quad="15 18 19 18 15 18 19 18"/>' +
    '<char c="&amp;" quad="19 12 23 12 19 18 23 18"/></page>');
  assert.equal(page.text.map(glyph => String.fromCodePoint(glyph[0])).join(''), 'a &');
  assert.ok(page.text[1][4] > page.text[1][2]);
});
