import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLyricsUpdate, formatSyltForEdit, parseSyltText } from '../frontend/src/lyricsEditing.js';

test('SYLT editor text round-trips timestamps, empty lyrics, whitespace and escaped characters', () => {
  const lines = [
    { time: 0, text: '' },
    { time: 1.001, text: ' First line ' },
    { time: 62.345, text: 'First\nsecond\r\nthird' },
    { time: 62.345, text: 'Literal \\n, \\r, \\unknown and \\' },
    { time: 3600.007, text: 'Tiếng Việt 🎵' },
    { time: 4294967.295, text: 'Last supported time' }
  ];
  const text = formatSyltForEdit(lines);
  assert.equal(text, [
    '[00:00:00.000] ',
    '[00:00:01.001]  First line ',
    '[00:01:02.345] First\\nsecond\\r\\nthird',
    '[00:01:02.345] Literal \\\\n, \\\\r, \\\\unknown and \\\\',
    '[01:00:00.007] Tiếng Việt 🎵',
    '[1193:02:47.295] Last supported time'
  ].join('\n'));
  assert.deepEqual(parseSyltText(text), lines);
  assert.equal(formatSyltForEdit(), '');
});

test('SYLT parsing ignores blank rows and accepts CRLF, fractions and optional separator spaces', () => {
  assert.deepEqual(parseSyltText('\r\n \t\r\n[00:01:02.3]Later\r[00:00:01.25]  Earlier  \n[00:00:01.2500]\n'), [
    { time: 62.3, text: 'Later' },
    { time: 1.25, text: ' Earlier  ' },
    { time: 1.25, text: '' }
  ]);
  assert.deepEqual(parseSyltText('[00:00:01.2345] Literal \\q'), [{ time: 1.2345, text: 'Literal \\q' }]);
  for (const text of ['', ' \n\t\r\n']) assert.deepEqual(parseSyltText(text), []);
});

test('SYLT parsing rejects malformed or out-of-range timestamps with the physical line number', () => {
  for (const line of ['No timestamp', '[00:01.234] Short timestamp', '[-01:00:00.000] Negative',
    '[00:00:01] No fraction', '[00:00:01.] Empty fraction', '[00:00:NaN.000] Invalid',
    '[00:00:01.000]x[00:00:02.000]y\nNo timestamp', ' [00:00:01.000] Indented']) {
    assert.throws(() => parseSyltText(line), /SYLT line \d+: use \[HH:MM:SS.mmm\] text/);
  }
  assert.throws(() => parseSyltText('\n\nBad line'), /SYLT line 3:/);
  for (const time of ['00:60:00.000', '00:00:60.000']) {
    assert.throws(() => parseSyltText(`[${time}] Invalid`), /minutes and seconds must be 00–59/);
  }
  for (const time of ['1193:02:47.296', '9999:00:00.000']) {
    assert.throws(() => parseSyltText(`[${time}] Too late`), /time must be between 0 and 4294967.295 seconds/);
  }
  assert.throws(() => parseSyltText('[00:00:01.000] Invalid\0text'), /NUL/);
});

test('SYLT limits count decoded text and timestamped entries, not timestamp syntax or blank rows', () => {
  const manyLines = `${'[00:00:00.000]\n\n'.repeat(10000)}`;
  assert.equal(parseSyltText(manyLines).length, 10000);
  assert.throws(() => parseSyltText(`${manyLines}[00:00:01.000]`), /at most 10,000 lines/);
  const text = '\\n'.repeat(100000);
  assert.equal(parseSyltText(`[00:00:00.000] ${text}`)[0].text.length, 100000);
  assert.throws(() => parseSyltText(`[00:00:00.000] ${text}\n[00:00:01.000] x`), /at most 100,000 characters/);
});

test('lyrics updates include only changed formats and clear them explicitly', () => {
  const metadata = { sylt: [{ time: 1.001, text: 'Original' }], uslt: 'Plain\nlyrics' };
  const text = formatSyltForEdit(metadata.sylt);
  assert.deepEqual(buildLyricsUpdate(metadata, text, metadata.uslt), {});
  assert.deepEqual(buildLyricsUpdate(metadata, `\n${text}\n\n`, metadata.uslt), {});
  assert.deepEqual(buildLyricsUpdate(metadata, '[00:00:01.0010]Original', metadata.uslt), {});
  assert.deepEqual(buildLyricsUpdate(metadata, text, 'Changed'), { uslt: 'Changed' });
  assert.deepEqual(buildLyricsUpdate(metadata, '[00:00:02.345] Changed', metadata.uslt), {
    sylt: [{ time: 2.345, text: 'Changed' }]
  });
  assert.deepEqual(buildLyricsUpdate(metadata, '', metadata.uslt), { sylt: [] });
  assert.deepEqual(buildLyricsUpdate(metadata, text, ''), { uslt: '' });
  assert.deepEqual(buildLyricsUpdate(metadata, '', ''), { sylt: [], uslt: '' });
  assert.deepEqual(buildLyricsUpdate({}, '', ''), {});
  assert.deepEqual(metadata, { sylt: [{ time: 1.001, text: 'Original' }], uslt: 'Plain\nlyrics' });
});

test('all changed drafts are validated, while untouched legacy lyrics do not block other edits', () => {
  assert.throws(() => buildLyricsUpdate({}, 'Invalid hidden SYLT draft', 'Changed USLT'), /SYLT line 1/);
  assert.throws(() => buildLyricsUpdate({}, '[00:00:01.000] Valid', 'Invalid\0USLT'), /USLT.*NUL/);
  assert.throws(() => buildLyricsUpdate({}, '', 'x'.repeat(100001)), /USLT.*100,000/);
  assert.equal(buildLyricsUpdate({}, '', 'x'.repeat(100000)).uslt.length, 100000);
  const metadata = { sylt: [{ time: 1, text: 'Legacy\0text' }], uslt: 'Legacy\0USLT' };
  assert.deepEqual(buildLyricsUpdate(metadata, formatSyltForEdit(metadata.sylt), 'Updated USLT'), { uslt: 'Updated USLT' });
  assert.deepEqual(buildLyricsUpdate(metadata, '', metadata.uslt), { sylt: [] });
});
