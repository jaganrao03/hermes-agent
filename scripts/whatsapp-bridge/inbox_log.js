// Append-only conversation log for read-only tooling such as the `wa` CLI.
// This is separate from the gateway queue: readers must never drain /messages.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'fs';
import path from 'path';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVES = 4;

export function shouldLogInboxMessage({ fromMe = false } = {}) {
  return !fromMe;
}

export function createContactNameLookup(filePath) {
  let records = null;
  let cachedMtime = -1;
  return (...ids) => {
    try {
      const mtime = statSync(filePath).mtimeMs;
      if (records === null || mtime !== cachedMtime) {
        records = JSON.parse(readFileSync(filePath, 'utf8')).contacts || {};
        cachedMtime = mtime;
      }
    } catch {
      records = null;
      cachedMtime = -1;
      return '';
    }
    for (const id of ids) {
      const record = records[id];
      if (record?.name) return record.name;
      if (record?.notify) return record.notify;
      if (record?.verifiedName) return record.verifiedName;
    }
    return '';
  };
}

function captionOf(node) {
  return typeof node?.caption === 'string' ? node.caption : '';
}

// Extract searchable text and a small type summary without downloading media.
export function describeMessage(content) {
  const out = { body: '', mediaType: '', hasMedia: false, kind: 'text' };
  if (!content || typeof content !== 'object') return out;
  if (typeof content.conversation === 'string') {
    out.body = content.conversation;
    return out;
  }
  if (content.extendedTextMessage) {
    out.body = content.extendedTextMessage.text || '';
    return out;
  }
  if (content.imageMessage) return { body: captionOf(content.imageMessage), mediaType: 'image', hasMedia: true, kind: 'image' };
  if (content.videoMessage) return { body: captionOf(content.videoMessage), mediaType: 'video', hasMedia: true, kind: 'video' };
  if (content.pttMessage || content.audioMessage) return { body: '', mediaType: 'audio', hasMedia: true, kind: 'voice' };
  if (content.documentMessage) {
    const doc = content.documentMessage;
    return { body: [doc.title, doc.caption].filter(Boolean).join(' — '), mediaType: 'document', hasMedia: true, kind: 'document' };
  }
  if (content.stickerMessage) return { body: '', mediaType: 'sticker', hasMedia: true, kind: 'sticker' };
  if (content.contactMessage || content.contactsArrayMessage) return { body: '[contact card]', mediaType: '', hasMedia: false, kind: 'contact' };
  if (content.locationMessage || content.liveLocationMessage) {
    const loc = content.locationMessage || content.liveLocationMessage;
    return { body: loc?.name || loc?.address || '', mediaType: '', hasMedia: false, kind: 'location' };
  }
  const poll = content.pollCreationMessageV3 || content.pollCreationMessage || content.pollCreationMessageV2;
  if (poll) {
    const opts = (poll.options || []).map((option) => option?.optionName).filter(Boolean);
    return { body: `${poll.name || ''}${opts.length ? ` (${opts.join(' / ')})` : ''}`, mediaType: '', hasMedia: false, kind: 'poll' };
  }
  if (content.editedMessage?.message) {
    const inner = describeMessage(content.editedMessage.message);
    return { ...inner, body: inner.body ? `${inner.body} (edited)` : '(edited)' };
  }
  if (content.reactionMessage) return { body: content.reactionMessage.text || '', mediaType: '', hasMedia: false, kind: 'reaction' };
  if (content.protocolMessage) {
    const protocol = content.protocolMessage;
    const rawType = protocol.type;
    const protocolType = typeof rawType === 'string' ? rawType : (rawType === 0 ? 'REVOKE' : String(rawType ?? 'UNKNOWN'));
    const isRevoke = rawType === 'REVOKE' || rawType === 0;
    return {
      body: '', mediaType: '', hasMedia: false,
      kind: isRevoke ? 'deleted' : 'protocol',
      protocolType,
      ...(isRevoke && protocol.key?.id ? { deletedMessageId: protocol.key.id } : {}),
    };
  }
  return { body: '', mediaType: '', hasMedia: false, kind: Object.keys(content)[0] || 'unknown' };
}

export function createInboxLog(filePath, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(filePath), 0o700);
  } catch (err) {
    console.warn(`[bridge] inbox log unavailable: ${err.message}`);
    return { append() {}, read() { return []; }, path: filePath };
  }
  let size = 0;
  try {
    if (existsSync(filePath)) {
      chmodSync(filePath, 0o600);
      size = statSync(filePath).size;
    }
  } catch {}

  function rotateIfNeeded() {
    if (size < maxBytes) return;
    try {
      const prefix = `${path.basename(filePath)}.`;
      const directory = path.dirname(filePath);
      const archives = readdirSync(directory)
        .map((name) => name.startsWith(prefix) ? Number(name.slice(prefix.length)) : NaN)
        .filter((index) => Number.isSafeInteger(index) && index > 0)
        .sort((a, b) => a - b);
      if (archives.length >= MAX_ARCHIVES) {
        unlinkSync(`${filePath}.${archives[0]}`);
        for (const index of archives.slice(1)) {
          renameSync(`${filePath}.${index}`, `${filePath}.${index - 1}`);
        }
        renameSync(filePath, `${filePath}.${MAX_ARCHIVES}`);
      } else {
        renameSync(filePath, `${filePath}.${(archives.at(-1) || 0) + 1}`);
      }
      size = 0;
    } catch (err) {
      console.warn(`[bridge] inbox log rotation failed: ${err.message}`);
    }
  }

  function append(record) {
    try {
      const line = `${JSON.stringify(record)}\n`;
      appendFileSync(filePath, line, { mode: 0o600 });
      chmodSync(filePath, 0o600);
      size += Buffer.byteLength(line);
      rotateIfNeeded();
    } catch (err) {
      console.warn(`[bridge] inbox log append failed: ${err.message}`);
    }
  }

  function loadFile(p) {
    if (!existsSync(p)) return [];
    try {
      return readFileSync(p, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  function read({ limit = 100, chatId = null, since = 0 } = {}) {
    const archives = [];
    const prefix = `${path.basename(filePath)}.`;
    const archiveIndexes = readdirSync(path.dirname(filePath))
      .map((name) => name.startsWith(prefix) ? Number(name.slice(prefix.length)) : NaN)
      .filter((index) => Number.isSafeInteger(index) && index > 0)
      .sort((a, b) => a - b);
    for (const index of archiveIndexes) {
      archives.push(loadFile(`${filePath}.${index}`));
    }
    const lines = archives.flat().concat(loadFile(filePath));
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      let record;
      try { record = JSON.parse(lines[i]); } catch { continue; }
      if (chatId && record.chatId !== chatId) continue;
      if (since && !(record.ts > since)) continue;
      out.push(record);
    }
    return out.reverse();
  }

  return { append, read, path: filePath };
}
