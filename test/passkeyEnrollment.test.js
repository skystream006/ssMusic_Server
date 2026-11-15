import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let server;
let PasskeyOriginDialog;
let PasskeyNameForm;
let CrossOriginPasskeyEnrollment;

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  ({ PasskeyOriginDialog, PasskeyNameForm, CrossOriginPasskeyEnrollment } = await server.ssrLoadModule('/src/PasskeyEnrollment.jsx'));
});
after(async () => { await server?.close(); });

test('passkey chooser offers all origins and disables unconfigured additional origins', () => {
  const render = (secondary, tertiary) => renderToStaticMarkup(createElement(PasskeyOriginDialog, {
    origins: { primary: 'https://music.example.com', secondary, tertiary }, onChoose() {}, onClose() {}
  }));
  const configured = render('https://local.example.com:4123', 'https://third.example.com:4123');
  assert.match(configured, /<dialog/);
  assert.match(configured, /aria-labelledby=/);
  assert.match(configured, /Passkey name \(optional\)/);
  assert.match(configured, /<input[^>]*maxLength="64"/);
  assert.match(configured, /Main: https:\/\/music.example.com/);
  assert.match(configured, /Secondary: https:\/\/local.example.com:4123/);
  assert.match(configured, /Tertiary: https:\/\/third.example.com:4123/);
  assert.match(configured, /<button[^>]*>Main origin<\/button>/);
  assert.match(configured, /<button[^>]*>Secondary origin<\/button>/);
  assert.match(configured, /<button[^>]*>Tertiary origin<\/button>/);
  assert.doesNotMatch(configured, /disabled/);
  assert.match(render(null), /not configured/);
  assert.match(render(null), /<button[^>]*disabled=""[^>]*>Secondary origin<\/button>/);
  assert.match(render(null), /<button[^>]*disabled=""[^>]*>Tertiary origin<\/button>/);
  const tertiaryOnly = render(null, 'https://third.example.com:4123');
  assert.match(tertiaryOnly, /<button[^>]*disabled=""[^>]*>Secondary origin<\/button>/);
  assert.match(tertiaryOnly, /<button(?![^>]*disabled)[^>]*>Tertiary origin<\/button>/);
});

test('existing passkey names can be edited without exposing key material', () => {
  const html = renderToStaticMarkup(createElement(PasskeyNameForm, {
    passkey: { id: 'credential-id', name: 'My phone' }, onSave() {}, disabled: false
  }));
  assert.match(html, /Passkey name/);
  assert.match(html, /value="My phone"/);
  assert.match(html, /Save name/);
  const unnamed = renderToStaticMarkup(createElement(PasskeyNameForm, {
    passkey: { id: 'legacy-id', name: null }, onSave() {}, disabled: true
  }));
  assert.match(unnamed, /placeholder="Unnamed passkey"/);
  assert.match(unnamed, /<input[^>]*disabled=""/);
});

for (const origin of ['secondary', 'tertiary']) {
  test(`direct ${origin} enrollment without credentials cannot start registration`, () => {
    const previous = globalThis.window;
    globalThis.window = { location: { hash: '', search: origin === 'tertiary' ? '?origin=tertiary' : '' } };
    try {
      const html = renderToStaticMarkup(createElement(CrossOriginPasskeyEnrollment, {
        request() { assert.fail('Rendering must not issue enrollment requests'); }
      }));
      assert.match(html, /No enrollment credentials were provided/);
      assert.ok(html.includes(`Add ${origin}-origin passkey`));
      assert.match(html, /role="alert"/);
      assert.match(html, /<button[^>]*disabled=""[^>]*>Create passkey<\/button>/);
    } finally {
      if (previous === undefined) delete globalThis.window;
      else globalThis.window = previous;
    }
  });
}
