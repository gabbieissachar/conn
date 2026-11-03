'use strict';

// Tests for photos in the reader page's message bar (prototype/attach.js and how template.html uses it). Run from the repo root:
//   node --test setup/transcript-reader/attach.test.js
// attach.js runs with a stand-in for the document; the page's own sendDock and deliverDock are cut out of
// template.html and run against stand-ins too, so the thumbnails, the checks and what Send does with photos are the page's real code.
// Nothing is served and nothing is uploaded; api.test.js holds the server's side.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (name) => fs.readFileSync(path.join(__dirname, 'prototype', name), 'utf8');
// In this realm (not a sandbox), so the arrays it makes compare equal to the test's own.
const attach = new Function(read('attach.js') + '\nreturn attach;')();
const page = read('template.html');
const MB = 1024 * 1024;
const tick = () => new Promise((resolve) => setImmediate(resolve));

const file = (name, size = 1000, type = '') => ({ name, size, type });

// ---------------------------------------------------------------- what may be picked

test('photos: PNG, JPEG, GIF, WebP and HEIC are taken by type, or by name when the browser gives no type', () => {
  const store = attach.makeStore();
  const picked = [file('a.png', 10, 'image/png'), file('b.jpg', 10, 'image/jpeg'), file('c.gif', 10, 'image/gif'), file('d.webp', 10, 'image/webp'),
    file('e.heic', 10, 'image/heic'), file('f.HEIC', 10, ''), file('g.JPEG', 10, '')];
  const { added, refused } = store.add('s1', picked.slice(0, 6));
  assert.equal(added, 6);
  assert.deepEqual(refused, []);
  assert.deepEqual(store.list('s1').map((p) => p.name), ['a.png', 'b.jpg', 'c.gif', 'd.webp', 'e.heic', 'f.HEIC']);
  assert.ok(store.list('s1').every((p) => p.id === null && p.error === '' && Number.isInteger(p.key)));
  assert.equal(new Set(store.list('s1').map((p) => p.key)).size, 6, 'each photo has its own key');
});

test('photos: what is not a photo, is empty, or does not fit is left out with the reason, and the rest are still taken', () => {
  const store = attach.makeStore();
  const { added, refused } = store.add('s1', [file('a.png', 10, 'image/png'), file('scan.pdf', 10, 'application/pdf'), file('logo.svg', 10, 'image/svg+xml'),
    file('movie.mov', 10, 'video/quicktime'), file('empty.png', 0, 'image/png'), file('huge.jpg', 12 * MB + 1, 'image/jpeg'), file('notes', 10, ''), file('b.png', 10, 'image/png')]);
  assert.equal(added, 2);
  assert.deepEqual(refused.map((r) => r.name), ['scan.pdf', 'logo.svg', 'movie.mov', 'empty.png', 'huge.jpg', 'notes']);
  assert.equal(refused[0].why, 'is not a PNG, JPEG, GIF, WebP or HEIC photo');
  assert.equal(refused[3].why, 'is empty');
  assert.equal(refused[4].why, 'is 12 MB, and a photo can be at most 12 MB');
  assert.equal(attach.refusal(refused), 'scan.pdf is not a PNG, JPEG, GIF, WebP or HEIC photo; logo.svg is not a PNG, JPEG, GIF, WebP or HEIC photo; and 4 more were left out.');
  assert.equal(attach.refusal(refused.slice(0, 1)), 'scan.pdf is not a PNG, JPEG, GIF, WebP or HEIC photo.');
  assert.equal(attach.refusal([]), '');
  assert.equal(attach.mb(12 * MB), '12 MB');
  assert.equal(attach.mb(3.44 * MB), '3.4 MB');
  assert.deepEqual([attach.size(900), attach.size(4510), attach.size(1.5 * MB), attach.size(12 * MB)], ['900 B', '4 KB', '1.5 MB', '12 MB']);
});

test('photos: a message takes at most 6 photos and 30 MB, counted across picks', () => {
  assert.deepEqual([attach.MAX_PHOTOS, attach.MAX_PHOTO_BYTES, attach.MAX_PHOTOS_BYTES], [6, 12 * MB, 30 * MB]);
  const store = attach.makeStore();
  assert.equal(store.add('s1', Array.from({ length: 4 }, (_, i) => file(`p${i}.jpg`, MB, 'image/jpeg'))).added, 4);
  const second = store.add('s1', Array.from({ length: 4 }, (_, i) => file(`q${i}.jpg`, MB, 'image/jpeg')));
  assert.equal(second.added, 2, 'two more fit, the rest are over 6');
  assert.deepEqual(second.refused.map((r) => r.why), ['does not fit: a message carries at most 6 photos', 'does not fit: a message carries at most 6 photos']);
  assert.equal(store.bytes('s1'), 6 * MB);
  const heavy = attach.makeStore();
  assert.equal(heavy.add('s1', [file('a.jpg', 11 * MB, 'image/jpeg'), file('b.jpg', 11 * MB, 'image/jpeg'), file('c.jpg', 11 * MB, 'image/jpeg')]).added, 2);
  const left = heavy.add('s1', [file('d.jpg', 9 * MB, 'image/jpeg')]);
  assert.equal(left.added, 0);
  assert.equal(left.refused[0].why, 'does not fit: a message carries at most 30 MB of photos');
  assert.equal(heavy.add('s1', [file('e.jpg', 8 * MB, 'image/jpeg')]).added, 1, '30 MB exactly is taken');
});

test('photos: each session keeps its own, one can be removed, a send removes only what it carried, and a /clear moves them on', () => {
  const store = attach.makeStore();
  store.add('s1', [file('a.png', 10, 'image/png'), file('b.png', 10, 'image/png')]);
  store.add('s2', [file('c.png', 10, 'image/png')]);
  assert.deepEqual(store.list('s2').map((p) => p.name), ['c.png']);
  const [a, b] = store.list('s1');
  store.remove('s1', a.key);
  assert.deepEqual(store.list('s1').map((p) => p.name), ['b.png']);
  store.add('s1', [file('late.png', 10, 'image/png')]);
  store.drop('s1', [b]);
  assert.deepEqual(store.list('s1').map((p) => p.name), ['late.png'], 'a photo added while the send ran stays');
  store.move('s2', 's1');
  assert.deepEqual(store.list('s1').map((p) => p.name), ['c.png', 'late.png']);
  assert.deepEqual(store.list('s2'), []);
  store.move('s1', 's1');
  assert.equal(store.list('s1').length, 2);
  assert.deepEqual(store.list('nobody'), []);
});

// ---------------------------------------------------------------- the thumbnails

// Just enough of a document for the strip: elements that keep their children, attributes, classes and click handlers.
function fakeDocument() {
  const make = (tag) => {
    const node = { tag, children: [], className: '', title: '', hidden: false, disabled: false, textContent: '', attrs: {}, listeners: {}, width: 0, height: 0, repaints: 0 };
    node.append = (...kids) => { node.children.push(...kids); };
    node.replaceChildren = (...kids) => { node.children = kids; node.repaints += 1; };
    node.setAttribute = (name, value) => { node.attrs[name] = String(value); };
    node.addEventListener = (type, fn) => { (node.listeners[type] = node.listeners[type] || []).push(fn); };
    node.click = () => { if (!node.disabled) for (const fn of node.listeners.click || []) fn(); };
    return node;
  };
  return { createElement: make };
}

function strip({ paint } = {}) {
  const doc = fakeDocument();
  const el = doc.createElement('div');
  el.hidden = true;
  const removed = [];
  const painted = [];
  const paintStrip = attach.makeStrip({ doc, el, onRemove: (item) => removed.push(item.name), paint: paint || (async (canvas, f) => { painted.push(f.name); }) });
  return { el, paintStrip, removed, painted };
}

test('thumbnails: a tile for each photo with its own remove button, hidden when there are none', async () => {
  const store = attach.makeStore();
  const { el, paintStrip, removed, painted } = strip();
  paintStrip(store.list('s1'), false);
  assert.equal(el.hidden, true);
  store.add('s1', [file('front.png', 2 * MB, 'image/png'), file('back.jpg', 3 * MB, 'image/jpeg')]);
  paintStrip(store.list('s1'), false);
  assert.equal(el.hidden, false);
  assert.equal(el.children.length, 2);
  const [first, second] = el.children;
  assert.equal(first.className, 'thumb');
  assert.equal(first.title, 'front.png · 2.0 MB');
  assert.equal(second.title, 'back.jpg · 3.0 MB');
  const [pic, cut] = first.children;
  assert.equal(pic.attrs.role, 'img');
  assert.equal(pic.attrs['aria-label'], 'front.png');
  assert.equal(pic.children[0].tag, 'canvas');
  assert.equal(pic.children[0].width, 112, 'drawn at twice the 56 px it shows at, for a sharp screen');
  assert.equal(cut.tag, 'button');
  assert.equal(cut.attrs.type, undefined, 'the property is set, not an attribute');
  assert.equal(cut.type, 'button');
  assert.equal(cut.attrs['aria-label'], 'Remove front.png');
  assert.equal(cut.title, 'Remove this photo');
  await tick();
  assert.deepEqual(painted, ['front.png', 'back.jpg'], 'each picture is painted from the file that was picked');
  cut.click();
  assert.deepEqual(removed, ['front.png']);
  store.remove('s1', store.list('s1')[0].key);
  paintStrip(store.list('s1'), false);
  assert.equal(el.children.length, 1);
  assert.equal(el.children[0], second, 'the tile left is the same one, not painted again');
  store.remove('s1', store.list('s1')[0].key);
  paintStrip(store.list('s1'), false);
  assert.equal(el.hidden, true);
});

test('thumbnails: a list that did not change is not drawn again, and locking turns every remove button off', () => {
  const store = attach.makeStore();
  const { el, paintStrip } = strip();
  store.add('s1', [file('a.png', 10, 'image/png'), file('b.png', 10, 'image/png')]);
  paintStrip(store.list('s1'), false);
  const draws = el.repaints;
  paintStrip(store.list('s1'), false);
  paintStrip(store.list('s1'), false);
  assert.equal(el.repaints, draws, 'a redraw of the bar every few seconds leaves the tiles alone');
  assert.ok(el.children.every((tile) => tile.children[1].disabled === false));
  paintStrip(store.list('s1'), true);
  assert.ok(el.children.every((tile) => tile.children[1].disabled === true), 'held for Undo or on its way: nothing can be removed');
  paintStrip(store.list('s1'), false);
  assert.ok(el.children.every((tile) => tile.children[1].disabled === false));
});

test('thumbnails: a photo the browser cannot draw (an iPhone\'s HEIC on a Mac) shows its kind, and still goes', async () => {
  const store = attach.makeStore();
  const { el, paintStrip } = strip({ paint: async (canvas, f) => { if (/heic$/i.test(f.name)) throw new Error('cannot decode'); } });
  store.add('s1', [file('IMG_4021.HEIC', 3 * MB, ''), file('ok.png', 10, 'image/png'), file('weird', 10, 'image/png')]);
  paintStrip(store.list('s1'), false);
  await tick();
  const [heic, png, plain] = el.children.map((tile) => tile.children[0]);
  assert.equal(heic.className, 'thumb-pic plain');
  assert.equal(heic.textContent, 'HEIC');
  assert.equal(png.className, 'thumb-pic');
  assert.equal(png.textContent, '', 'a drawn tile keeps its canvas');
  assert.equal(plain.className, 'thumb-pic', 'a tile that drew is not marked plain');
  assert.equal(store.list('s1').length, 3);
});

test('thumbnails: a photo the laptop refused is outlined and says why when pressed or hovered', () => {
  const store = attach.makeStore();
  const { el, paintStrip } = strip();
  store.add('s1', [file('a.png', 10, 'image/png'), file('b.png', 10, 'image/png')]);
  paintStrip(store.list('s1'), false);
  store.list('s1')[1].error = 'b.png is not a PNG, JPEG, GIF, WebP or HEIC image, so it was not saved.';
  paintStrip(store.list('s1'), false);
  assert.equal(el.children[0].className, 'thumb');
  assert.equal(el.children[1].className, 'thumb bad');
  assert.equal(el.children[1].title, 'b.png is not a PNG, JPEG, GIF, WebP or HEIC image, so it was not saved.');
  store.list('s1')[1].error = '';
  paintStrip(store.list('s1'), false);
  assert.equal(el.children[1].className, 'thumb');
  assert.equal(el.children[1].title, 'b.png · 10 B');
});

test('thumbnails: a picture is painted cropped to its middle square, and the bitmap is let go either way', async () => {
  const closed = [];
  const calls = [];
  const canvas = { width: 112, height: 112, getContext: () => ({ drawImage: (...args) => calls.push(args.slice(1)) }) };
  const bitmap = (width, height) => ({ width, height, close: () => closed.push([width, height]) });
  await attach.draw(canvas, 'wide.png', async () => bitmap(200, 100));
  await attach.draw(canvas, 'tall.png', async () => bitmap(100, 300));
  assert.deepEqual(calls, [[50, 0, 100, 100, 0, 0, 112, 112], [0, 100, 100, 100, 0, 0, 112, 112]]);
  assert.deepEqual(closed, [[200, 100], [100, 300]]);
  const broken = { width: 112, height: 112, getContext: () => ({ drawImage: () => { throw new Error('draw failed'); } }) };
  await assert.rejects(attach.draw(broken, 'x.png', async () => bitmap(10, 10)), /draw failed/);
  assert.equal(closed.length, 3);
  await assert.rejects(attach.draw(canvas, 'x.png', null), /cannot show it/);
});

// ---------------------------------------------------------------- Send: upload first, then the send names the saved files

function items(...names) {
  const store = attach.makeStore();
  store.add('s1', names.map((name) => file(name, 10, 'image/png')));
  return store.list('s1');
}

test('Send: each photo is uploaded in order, then the send carries their ids in that order', async () => {
  const photos = items('a.png', 'b.png', 'c.png');
  const log = [];
  const answer = await attach.deliver(photos, {
    upload: async (f, name) => { log.push('upload ' + name); return { id: name.replace('.png', '') + '.id' }; },
    send: async (ids) => { log.push('send ' + ids.join(',')); return { label: 'alpha', text: 'as sent' }; },
    step: (n, of) => log.push(`step ${n}/${of}`),
  });
  assert.deepEqual(log, ['step 1/3', 'upload a.png', 'step 2/3', 'upload b.png', 'step 3/3', 'upload c.png', 'step 0/3', 'send a.id,b.id,c.id'], 'step 0 says the uploads are done before the send starts');
  assert.deepEqual(answer, { label: 'alpha', text: 'as sent' });
  assert.deepEqual(photos.map((p) => p.id), ['a.id', 'b.id', 'c.id']);
});

test('Send: with no photos nothing is uploaded and the send carries no ids', async () => {
  const log = [];
  await attach.deliver([], { upload: async () => log.push('upload'), send: async (ids) => log.push(['send', ids]), step: () => log.push('step') });
  assert.deepEqual(log, [['send', []]]);
});

test('Send: a photo the laptop refuses stops everything, nothing is sent, and the retry uploads only what is left', async () => {
  const photos = items('a.png', 'bad.png', 'c.png');
  const log = [];
  let fail = true;
  const options = {
    upload: async (f, name) => { log.push('upload ' + name); if (fail && name === 'bad.png') throw new Error('bad.png is not a PNG, JPEG, GIF, WebP or HEIC image, so it was not saved.'); return { id: name + '.id' }; },
    send: async (ids) => { log.push('send ' + ids.join(',')); return {}; },
  };
  await assert.rejects(attach.deliver(photos, options), /bad\.png is not a PNG/);
  assert.deepEqual(log, ['upload a.png', 'upload bad.png'], 'the third waits and no send went');
  assert.equal(photos[0].id, 'a.png.id');
  assert.equal(photos[1].id, null);
  assert.match(photos[1].error, /not saved/);
  fail = false;
  await attach.deliver(photos, options);
  assert.deepEqual(log.slice(2), ['upload bad.png', 'upload c.png', 'send a.png.id,bad.png.id,c.png.id'], 'a.png is not uploaded twice');
  assert.equal(photos[1].error, '');
});

test('Send: a send that fails after the upload keeps the ids, unless the laptop says a saved photo is gone', async () => {
  const photos = items('a.png', 'b.png');
  const uploads = [];
  let failure = Object.assign(new Error('Herdr did not accept the message.'), { status: 502, code: 'herdr_failed' });
  const options = { upload: async (f, name) => { uploads.push(name); return { id: name + '.id' }; }, send: async () => { if (failure) throw failure; return {}; } };
  await assert.rejects(attach.deliver(photos, options), /Herdr did not accept/);
  assert.deepEqual(photos.map((p) => p.id), ['a.png.id', 'b.png.id']);
  await assert.rejects(attach.deliver(photos, options), /Herdr did not accept/);
  assert.deepEqual(uploads, ['a.png', 'b.png'], 'the retry uploads nothing again');
  failure = Object.assign(new Error('A photo is no longer on the laptop, so nothing was sent. Add it again.'), { status: 409, code: 'image_gone' });
  await assert.rejects(attach.deliver(photos, options), /no longer on the laptop/);
  assert.deepEqual(photos.map((p) => p.id), [null, null], 'the ids are forgotten');
  failure = null;
  await attach.deliver(photos, options);
  assert.deepEqual(uploads, ['a.png', 'b.png', 'a.png', 'b.png'], 'so the next try uploads them again');
});

// ---------------------------------------------------------------- the page's own Send, run on stand-ins

// A function of template.html by name, cut out whole (its closing brace is the first "\n  }\n" after it).
function pageFunction(name, async = false) {
  const head = (async ? 'async function ' : 'function ') + name + '(';
  const at = page.indexOf(head);
  assert.ok(at >= 0, 'the page has ' + name);
  return page.slice(at, page.indexOf('\n  }\n', at) + 4);
}

// The page's deliverDock with the page's other parts replaced by stand-ins that record what it does.
function deliverWorld({ hosted = false, upload, send } = {}) {
  const world = {
    log: [], pending: [], batchSaved: [], drafts: {}, box: 'look at this', renders: 0,
    link: { sending: false, result: null, uploading: '', flight: null, pending: [], editing: null, target: null, held: null },
  };
  const photos = attach.makeStore();
  const sandbox = {
    link: world.link, photos, attach, HOSTED: hosted, Date, setTimeout: () => 0, Number, String, Math,
    live: { upload, send },
    hosted: { enqueue: async () => { throw new Error('the queue is not used here'); } },
    renderDock: () => { world.renders += 1; world.log.push('render ' + world.link.uploading); },
    redrawPending: () => world.log.push('redraw'),
    withoutSentItems: (items) => items,
    keepQueued: () => {}, saveBatch: (sid, left) => world.batchSaved.push([sid, left.length]), batchOf: () => [],
    sessionOf: () => ({ pane: { label: 'alpha' } }), paneName: () => 'alpha', fmtTime: () => '10:42',
    dockSession: () => ({ id: 's1', ids: ['s1'] }), dock: () => ({ get value() { return world.box; }, set value(v) { world.box = v; } }),
    markTarget: () => {}, saveDraft: () => {}, growDock: () => {}, draftOf: () => null, drafts: world.drafts, keep: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(pageFunction('deliverDock', true), sandbox);
  world.photos = photos;
  world.deliver = (args) => sandbox.deliverDock(args);
  return world;
}

test('page Send: photos are uploaded, then sent by id, and the faded message reads the text the laptop typed', async () => {
  const log = [];
  const w = deliverWorld({
    upload: async (f, name) => { log.push('upload ' + name); return { id: 'saved-' + name }; },
    send: async (sid, text, ids) => { log.push(['send', sid, text, ids]); return { label: 'alpha', status: 'idle', text: text + '\n\nAttached image: /laptop/out/uploads/saved-a.png' }; },
  });
  w.photos.add('s1', [file('a.png', 10, 'image/png'), file('b.png', 10, 'image/png')]);
  const sentPhotos = w.photos.list('s1').slice();
  w.photos.add('s1', [file('added-meanwhile.png', 10, 'image/png')]);
  await w.deliver({ sid: 's1', text: 'look at this', sentItems: [], sentBox: 'look at this', pointed: false, sentPhotos });
  assert.deepEqual(log, ['upload a.png', 'upload b.png', ['send', 's1', 'look at this', ['saved-a.png', 'saved-b.png']]]);
  assert.equal(w.link.pending.length, 1);
  assert.equal(w.link.pending[0].text, 'look at this\n\nAttached image: /laptop/out/uploads/saved-a.png', 'the log line it waits for holds the paths');
  assert.equal(w.link.pending[0].agent, 'idle');
  assert.equal(w.link.result.ok, true);
  assert.equal(w.link.result.text, 'Sent to alpha at 10:42.');
  assert.deepEqual(w.photos.list('s1').map((p) => p.name), ['added-meanwhile.png'], 'what went is gone from the bar, what was added meanwhile stays');
  assert.equal(w.box, '', 'the box is emptied');
  assert.equal(w.link.sending, false);
  assert.equal(w.link.uploading, '');
  assert.equal(w.link.flight, null);
  assert.ok(w.log.includes('render uploading photo 1 of 2…') && w.log.includes('render uploading photo 2 of 2…'), 'the bar says which photo is uploading');
  const rendered = w.log.filter((line) => line.startsWith('render'));
  assert.equal(rendered[rendered.indexOf('render uploading photo 2 of 2…') + 1], 'render ', 'and stops saying it once the last is up, while the send runs');
});

test('page Send: one photo is "the photo", and a message of only a photo sends with no words', async () => {
  const sends = [];
  const w = deliverWorld({
    upload: async () => ({ id: 'x.png' }),
    send: async (sid, text, ids) => { sends.push([text, ids]); return { label: 'alpha', status: 'idle', text: 'Attached image: /p/x.png' }; },
  });
  w.photos.add('s1', [file('a.png', 10, 'image/png')]);
  w.box = '';
  await w.deliver({ sid: 's1', text: '', sentItems: [], sentBox: '', pointed: false, sentPhotos: w.photos.list('s1').slice() });
  assert.deepEqual(sends, [['', ['x.png']]]);
  assert.ok(w.log.includes('render uploading the photo…'));
  assert.equal(w.link.pending[0].text, 'Attached image: /p/x.png');
});

test('page Send: a photo that fails keeps the words, the box and every photo, says why, and sends nothing', async () => {
  const sends = [];
  const w = deliverWorld({
    upload: async (f, name) => { if (name === 'b.png') throw new Error('b.png is not a PNG, JPEG, GIF, WebP or HEIC image, so it was not saved.'); return { id: name }; },
    send: async (...args) => { sends.push(args); return {}; },
  });
  w.photos.add('s1', [file('a.png', 10, 'image/png'), file('b.png', 10, 'image/png')]);
  w.box = 'look';
  await w.deliver({ sid: 's1', text: 'look', sentItems: [], sentBox: 'look', pointed: false, sentPhotos: w.photos.list('s1').slice() });
  assert.deepEqual(sends, []);
  assert.equal(w.link.result.ok, false);
  assert.match(w.link.result.text, /^b\.png is not a PNG/);
  assert.equal(w.box, 'look');
  assert.equal(w.photos.list('s1').length, 2);
  assert.equal(w.photos.list('s1')[1].error.startsWith('b.png is not'), true, 'the tile is the one marked');
  assert.equal(w.link.pending.length, 0);
  assert.equal(w.link.sending, false);
  assert.equal(w.link.uploading, '');
  assert.equal(w.link.flight, null);
});

test('page Send: a text-only message still goes as it did, with no ids and the words as the faded message', async () => {
  const sends = [];
  const w = deliverWorld({ upload: async () => { throw new Error('nothing to upload'); }, send: async (sid, text, ids) => { sends.push([sid, text, ids]); return { label: 'alpha', status: 'working' }; } });
  await w.deliver({ sid: 's1', text: 'just words', sentItems: [], sentBox: 'look at this', pointed: false, sentPhotos: [] });
  assert.deepEqual(sends, [['s1', 'just words', []]]);
  assert.equal(w.link.pending[0].text, 'just words');
  assert.equal(w.link.result.text, 'Sent to alpha at 10:42.');
});

// sendDock with the parts around it replaced: it must start the Undo window for a message of only photos, and refuse one of nothing.
function sendWorld({ words = '', photoNames = [], disabled = false } = {}) {
  const w = { held: [], delivered: [], link: { hold: null, result: null, target: null }, renders: 0 };
  const photos = attach.makeStore();
  if (photoNames.length) photos.add('s1', photoNames.map((name) => file(name, 10, 'image/png')));
  const sandbox = {
    link: w.link, photos, UNDO_SECONDS: 5, Boolean, Date, setInterval: () => 1,
    outgoing: () => words, dockSession: () => ({ id: 's1' }), dock: (id) => (id === 'send' ? { disabled } : { value: words }),
    confirm: () => true, paneName: () => 'alpha', batchOf: () => [],
    newHoldId: () => 'hold-1', saveSendHandoff: () => {}, clearSendHandoff: () => {},
    sendHold: { begin: (fn, seconds, hold) => { w.held.push({ seconds, hold }); w.fire = fn; return true; } },
    endHold: () => {}, deliverDock: (args) => w.delivered.push(args), holdTimer: 0, paintHold: () => {}, renderDock: () => { w.renders += 1; }, redrawPending: () => {},
    SESSION_COMMANDS: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(pageFunction('sendDock'), sandbox);
  w.send = () => sandbox.sendDock();
  return w;
}

test('page Send: a message of only photos is held for Undo and then delivered with those photos; an empty one is not sent', () => {
  const only = sendWorld({ words: '', photoNames: ['a.png', 'b.png'] });
  only.send();
  assert.equal(only.held.length, 1);
  assert.deepEqual({ sid: only.held[0].hold.sid, text: only.held[0].hold.text, photos: only.held[0].hold.photos },
    { sid: 's1', text: '', photos: 2 }, 'the Undo window knows how many photos wait');
  assert.equal(only.held[0].hold.id, 'hold-1');
  assert.equal(only.held[0].hold.deadline - only.held[0].hold.at, 5);
  only.fire();
  assert.equal(only.delivered.length, 1);
  assert.deepEqual(only.delivered[0].sentPhotos.map((p) => p.name), ['a.png', 'b.png']);
  assert.equal(only.delivered[0].text, '');

  const nothing = sendWorld({ words: '', photoNames: [] });
  nothing.send();
  assert.equal(nothing.held.length, 0, 'no words and no photos: nothing to send');

  const off = sendWorld({ words: 'hi', photoNames: ['a.png'], disabled: true });
  off.send();
  assert.equal(off.held.length, 0, 'a Send that is off stays off');

  const both = sendWorld({ words: 'look', photoNames: ['a.png'] });
  both.send();
  assert.deepEqual({ sid: both.held[0].hold.sid, text: both.held[0].hold.text, photos: both.held[0].hold.photos },
    { sid: 's1', text: 'look', photos: 1 });
});

// ---------------------------------------------------------------- the page's markup and wiring

test('the bar: a photo button, a hidden picker for several images, and a strip for the thumbnails', () => {
  assert.match(page, /<input type="file" id="dock-file" accept="image\/\*" multiple hidden>/, 'the phone offers its photo library and its camera');
  assert.match(page, /<div class="dock-thumbs" id="dock-thumbs" role="group" aria-label="Photos to send" hidden><\/div>/);
  assert.match(page, /<button class="alt icon" id="dock-photo" type="button" aria-label="Add photos" title="Add photos \(you can also paste or drop pictures\)"><svg[^>]*aria-hidden="true"/);
  const row = page.slice(page.indexOf('<div class="dock-row">'), page.indexOf('</div>', page.indexOf('<div class="dock-row">')));
  assert.ok(row.indexOf('id="dock-photo"') < row.indexOf('id="dock-text"') && row.indexOf('id="dock-text"') < row.indexOf('id="dock-add"') && row.indexOf('id="dock-add"') < row.indexOf('id="dock-send"'), 'photo button, box, Add, Send');
  assert.ok(page.indexOf('id="dock-thumbs"') < page.indexOf('<div class="dock-row">'), 'the thumbnails sit above the box');
  assert.match(page, /\/\*__ATTACH__\*\//);
});

test('the bar: the thumbnails and the button are sized for a thumb on a touch screen, and look the same in light and dark', () => {
  const css = page.match(/<style>([\s\S]*?)<\/style>/)[1];
  const rule = (selector) => { const at = css.indexOf(selector + ' {'); assert.ok(at >= 0, 'rule ' + selector); return css.slice(at, css.indexOf('}', at) + 1); };
  assert.match(rule('.thumb'), /width: 56px; height: 56px/);
  assert.match(rule('.thumb-x'), /width: 22px; height: 22px/);
  assert.match(rule('.thumb-x::after'), /inset: -11px/, 'a tap on the corner of a thumbnail reaches about 44 px');
  assert.match(css, /@media \(pointer: coarse\) \{[^}]*\.dock-row button \{ min-height: 44px; min-width: 44px; \}/, 'the photo button is a dock-row button, so it is 44 px on touch');
  assert.doesNotMatch(rule('.dock-thumbs') + rule('.thumb-pic') + rule('.thumb.bad .thumb-pic'), /#[0-9a-f]{3,6}\b/i, 'colours come from the page\'s own tokens, which change with the theme');
  assert.match(rule('.thumb.bad .thumb-pic'), /var\(--open\)/);
  assert.match(css, /\.dock\.dropping \.dock-inner \{ outline: 2px dashed var\(--you\)/);
});

test('the bar: Send is on for photos alone, a command cannot carry photos, and nothing can change while a message is held or on its way', () => {
  assert.match(page, /dock\("send"\)\.disabled = held \? false : Boolean\(reason\) \|\| link\.sending \|\| \(!out && !pics\.length\) \|\| over;/);
  assert.match(page, /if \(!reason && pics\.length && command\) reason = "A command goes on its own: remove the photos first\.";/);
  assert.match(page, /paintThumbs\(pics, held \|\| link\.sending\);/);
  assert.match(page, /dock\("photo"\)\.disabled = held \|\| link\.sending;/);
  assert.match(page, /if \(!session \|\| link\.hold \|\| link\.sending\) return;\s+photos\.remove\(session\.id, item\.key\)/, 'a tile cannot be removed once the message is held');
  assert.match(page, /if \(link\.hold \|\| link\.sending\) \{ barSays\(false, "A message is on its way\. Add photos once it has gone\.", 6000\); return; \}/);
  assert.match(page, /photos\.move\(id, session\.id\);/, 'after a /clear the photos follow the conversation');
});

test('the bar: pictures come from the button, a paste with no words, and a drop anywhere on the page', () => {
  assert.match(page, /dock\("photo"\)\.addEventListener\("click", \(\) => \{ if \(photoBlock\(\)\) barSays\(false, photoBlock\(\), 8000\); else dock\("file"\)\.click\(\); \}\);/);
  assert.match(page, /dock\("file"\)\.addEventListener\("change", \(\) => \{ addPhotos\(dock\("file"\)\.files\); dock\("file"\)\.value = ""; \}\);/, 'the same file can be picked again');
  const paste = page.slice(page.indexOf('dock("text").addEventListener("paste"'), page.indexOf('// A file dropped anywhere'));
  assert.match(paste, /filter\(file => \/\^image\\\/\/i\.test\(file\.type\)\)/);
  assert.match(paste, /if \(!files\.length \|\| \(data\.getData\("text\/plain"\) \|\| ""\)\) return;/, 'words win when the clipboard holds words and a picture');
  assert.match(paste, /e\.preventDefault\(\); addPhotos\(files\);/);
  assert.match(page, /document\.addEventListener\("dragover", e => \{ if \(carriesFiles\(e\)\) \{ e\.preventDefault\(\);/, 'the browser never opens a dropped file in place of the page');
  assert.match(page, /document\.addEventListener\("drop", e => \{ if \(!carriesFiles\(e\)\) return; e\.preventDefault\(\); dockBar\.classList\.remove\("dropping"\); addPhotos\(e\.dataTransfer\.files\); \}\);/);
});

test('the bar: a copy that cannot carry photos says so in the bar, and holds none', () => {
  const block = vm.runInNewContext(pageFunction('photoBlock') + '\n photoBlock', { HOSTED: true, canLive: false });
  assert.equal(block(), 'This copy cannot send photos: its queue carries text only. Open the laptop\'s page for photos.');
  const readOnly = vm.runInNewContext(pageFunction('photoBlock') + '\n photoBlock', { HOSTED: false, canLive: false });
  assert.equal(readOnly(), 'Read-only copy: open the served page to send photos.');
  const live = vm.runInNewContext(pageFunction('photoBlock') + '\n photoBlock', { HOSTED: false, canLive: true });
  assert.equal(live(), '');
  assert.match(page, /dock\("photo"\)\.title = noPhotos \|\| "Add photos/);
  assert.match(page, /dock\("photo"\)\.setAttribute\("aria-disabled", String\(Boolean\(noPhotos\)\)\);/);
  // A pick, a paste or a drop is stopped before anything is held: the answer is the bar's own line, in the error colour.
  const add = pageFunction('addPhotos');
  assert.ok(add.indexOf('if (photoBlock())') < add.indexOf('photos.add('));
  // The hosted queue's own code never mentions a photo: its text is sealed and a photo is far past what it takes.
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, 'prototype', 'hosted.js'), 'utf8'), /photo|images/i);
});

test('the bar: the faded message while a send is held or on its way names the photos, and the log line it waits for comes from the laptop', () => {
  const faded = vm.runInNewContext(page.match(/const holdMessage = hold => [^\n]+/)[0] + '\n holdMessage', { attach, paneName: () => 'alpha', Date });
  assert.equal(faded({ sid: 's1', text: 'look', photos: 2 }).text, 'look\n\n+ 2 photos');
  assert.equal(faded({ sid: 's1', text: '', photos: 1 }).text, '+ 1 photo');
  assert.equal(faded({ sid: 's1', text: 'just words', photos: 0 }).text, 'just words');
  assert.match(page, /link\.pending\.push\(\{ sid, text: sent\.text \|\| text, at:/);
});

test('live.js: upload posts the photo as base64 in a JSON body, send names the ids only when there are some, and an error keeps the laptop\'s code', async () => {
  const src = read('live.js');
  const calls = [];
  class FakeReader { readAsDataURL(f) { this.result = 'data:' + f.type + ';base64,' + Buffer.from(f.bytes).toString('base64'); setImmediate(() => this.onload()); } }
  const answers = [];
  const sandbox = {
    document: { querySelector: () => ({ content: 'a'.repeat(64) }), activeElement: null, addEventListener: () => {}, hidden: false },
    location: { hostname: 'localhost', protocol: 'http:', reload: () => {} }, sessionStorage: { getItem: () => null, setItem: () => {} },
    FileReader: FakeReader, setInterval: () => 0, setTimeout, clearTimeout, URL, Intl, Date, Promise, JSON, Array, Number, Error, Object, String, Math, Boolean, encodeURIComponent,
    fetch: async (url, options) => { calls.push({ url, options }); const next = answers.shift(); return { status: next.status, ok: next.status < 300, json: async () => next.json }; },
  };
  const live = vm.runInNewContext(src + '\nlive', sandbox);
  answers.push({ status: 200, json: { status: 'ok', id: 'abc.png' } });
  const saved = await live.upload({ type: 'image/png', bytes: [137, 80, 78, 71] }, 'a.png');
  assert.equal(saved.id, 'abc.png');
  assert.equal(calls[0].url, '/api/transcript-reader/upload');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.headers['x-transcript-reader-token'], 'a'.repeat(64));
  assert.deepEqual(JSON.parse(calls[0].options.body), { name: 'a.png', data: Buffer.from([137, 80, 78, 71]).toString('base64') });
  answers.push({ status: 200, json: { status: 'ok' } }, { status: 200, json: { status: 'ok' } });
  await live.send('s1', 'hi', ['abc.png']);
  await live.send('s1', 'hi', []);
  assert.deepEqual(JSON.parse(calls[1].options.body), { session_id: 's1', text: 'hi', images: ['abc.png'] });
  assert.deepEqual(JSON.parse(calls[2].options.body), { session_id: 's1', text: 'hi' }, 'a send with no photos is the message it always was');
  answers.push({ status: 409, json: { status: 'error', code: 'image_gone', message: 'A photo is no longer on the laptop.' } });
  await assert.rejects(live.send('s1', 'hi', ['abc.png']), (e) => e.status === 409 && e.code === 'image_gone' && /no longer/.test(e.message));
});
