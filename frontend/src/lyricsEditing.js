export function formatSyltForEdit(lines = []) {
  return lines.map(({ time, text }) => {
    const milliseconds = Math.round(time * 1000);
    const hours = String(Math.floor(milliseconds / 3600000)).padStart(2, '0');
    const minutes = String(Math.floor(milliseconds / 60000) % 60).padStart(2, '0');
    const seconds = String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0');
    const fraction = String(milliseconds % 1000).padStart(3, '0');
    const escaped = text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    return `[${hours}:${minutes}:${seconds}.${fraction}] ${escaped}`;
  }).join('\n');
}

export function parseSyltText(value) {
  if (value.includes('\0')) throw new Error('SYLT must not contain NUL characters.');
  const entries = [];
  let textLength = 0;
  for (const [index, line] of value.split(/\r\n|\r|\n/).entries()) {
    if (!line.trim()) continue;
    if (entries.length >= 10000) throw new Error('SYLT supports at most 10,000 lines.');
    const match = line.match(/^\[([0-9]{2,4}):([0-9]{2}):([0-9]{2})\.([0-9]+)\] ?(.*)$/);
    if (!match) throw new Error(`SYLT line ${index + 1}: use [HH:MM:SS.mmm] text.`);
    const [, hours, minutes, seconds, fraction, escaped] = match;
    if (Number(minutes) > 59 || Number(seconds) > 59) {
      throw new Error(`SYLT line ${index + 1}: minutes and seconds must be 00–59.`);
    }
    const time = Number(hours) * 3600 + Number(minutes) * 60 + Number(`${seconds}.${fraction}`);
    if (time > 4294967.295) throw new Error(`SYLT line ${index + 1}: time must be between 0 and 4294967.295 seconds.`);
    const text = escaped.replace(/\\([\\nr])/g, (_, character) => ({ n: '\n', r: '\r', '\\': '\\' })[character]);
    textLength += text.length;
    if (textLength > 100000) throw new Error('SYLT text supports at most 100,000 characters in total.');
    entries.push({ time, text });
  }
  return entries;
}

export function buildLyricsUpdate(metadata, syltText, uslt) {
  const updates = {};
  const originalSylt = metadata.sylt || [];
  if (syltText !== formatSyltForEdit(originalSylt)) {
    const sylt = parseSyltText(syltText);
    if (sylt.length !== originalSylt.length
      || sylt.some((line, index) => line.time !== originalSylt[index].time || line.text !== originalSylt[index].text)) {
      updates.sylt = sylt;
    }
  }
  if (uslt !== (metadata.uslt || '')) {
    if (uslt.length > 100000) throw new Error('USLT supports at most 100,000 characters.');
    if (uslt.includes('\0')) throw new Error('USLT must not contain NUL characters.');
    updates.uslt = uslt;
  }
  return updates;
}
