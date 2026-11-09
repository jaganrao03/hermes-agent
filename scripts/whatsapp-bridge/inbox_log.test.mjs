import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createContactNameLookup, createInboxLog, describeMessage, shouldLogInboxMessage } from './inbox_log.js';

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hermes-wa-inbox-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('describeMessage extracts searchable text without downloading media', () => {
  assert.deepEqual(describeMessage({ conversation: 'hello' }), {
    body: 'hello', mediaType: '', hasMedia: false, kind: 'text',
  });
  assert.deepEqual(describeMessage({ imageMessage: { caption: 'photo' } }), {
    body: 'photo', mediaType: 'image', hasMedia: true, kind: 'image',
  });
});

test('describeMessage preserves the target of a WhatsApp revoke event', () => {
  assert.deepEqual(describeMessage({
    protocolMessage: { type: 'REVOKE', key: { id: 'original-message-id' } },
  }), {
    body: '', mediaType: '', hasMedia: false, kind: 'deleted',
    protocolType: 'REVOKE', deletedMessageId: 'original-message-id',
  });
});

test('inbox log reads chronologically across rotations', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'inbox.jsonl');
    const log = createInboxLog(file, { maxBytes: 1 });
    log.append({ ts: 1, chatId: 'chat-a', body: 'oldest' });
    log.append({ ts: 2, chatId: 'chat-a', body: 'middle' });
    log.append({ ts: 3, chatId: 'chat-b', body: 'newest' });

    assert.deepEqual(log.read({ limit: 10 }).map((row) => row.body), ['oldest', 'middle', 'newest']);
    assert.deepEqual(log.read({ limit: 10, chatId: 'chat-a' }).map((row) => row.ts), [1, 2]);
    assert.equal(log.read({ limit: 10, since: 2 })[0].body, 'newest');
  });
});

test('inbox log prunes rotations to four archives in chronological order', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'inbox.jsonl');
    const log = createInboxLog(file, { maxBytes: 1 });
    for (let ts = 1; ts <= 8; ts += 1) log.append({ ts, chatId: 'chat-a', body: String(ts) });

    assert.deepEqual(log.read({ limit: 20 }).map((row) => row.body), ['5', '6', '7', '8']);
    assert.equal(readdirSync(dir).filter((name) => /^inbox\.jsonl\.\d+$/.test(name)).length, 4);
  });
});

test('inbox log creates a private parent directory when missing', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'state', 'inbox.jsonl');
    const log = createInboxLog(file);
    log.append({ ts: 1, chatId: 'chat-a', body: 'hello' });

    assert.equal(log.read({ limit: 1 })[0].body, 'hello');
    assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});

test('inbox logging degrades to a no-op when its parent cannot be created', () => {
  withTempDir((dir) => {
    const blocker = path.join(dir, 'not-a-directory');
    writeFileSync(blocker, 'fixture');
    const log = createInboxLog(path.join(blocker, 'inbox.jsonl'));

    assert.doesNotThrow(() => log.append({ ts: 1, body: 'ignored' }));
    assert.deepEqual(log.read({ limit: 10 }), []);
  });
});

test('read-only inbox excludes messages sent by the linked account', () => {
  assert.equal(shouldLogInboxMessage({ fromMe: true }), false);
  assert.equal(shouldLogInboxMessage({ fromMe: false }), true);
});

test('inbox summaries are logged before sender allowlist filtering', () => {
  const source = readFileSync(new URL('./bridge.js', import.meta.url), 'utf8');
  const start = source.indexOf('// Handle !fromMe messages (from other people) based on mode.');
  const selfChatGate = source.indexOf("if (WHATSAPP_MODE === 'self-chat')", start);
  const append = source.indexOf('inboxLog.append(', start);
  const allowlist = source.indexOf('const intakeAllowed =', start);

  assert.ok(start >= 0 && selfChatGate > start && append > selfChatGate && allowlist > append);
  assert.ok(source.slice(start, append).includes('if (!msg.key.fromMe)'));
});

test('contact lookup retries after a missing file and refreshes on mtime change', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'contacts.json');
    const lookup = createContactNameLookup(file);
    assert.equal(lookup('contact-id'), '');

    writeFileSync(file, JSON.stringify({ contacts: { 'contact-id': { name: 'First' } } }));
    assert.equal(lookup('contact-id'), 'First');

    writeFileSync(file, JSON.stringify({ contacts: { 'contact-id': { name: 'Updated' } } }));
    const future = new Date(Date.now() + 10_000);
    utimesSync(file, future, future);
    assert.equal(lookup('contact-id'), 'Updated');
  });
});
