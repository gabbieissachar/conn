  // ---------------------------------------------------------------- photos in a message (attach.js, pasted into the reader page)
  // build_prototype.write_page pastes this file into the page's script before hashing it. The rules are plain functions with no page
  // globals (the document, the canvas decoder and the requests are handed in), so attach.test.js runs them in a bare sandbox.
  //
  // A photo is picked (the picker on a phone, a file dialog, a paste or a drop), shown as a thumbnail with a remove button above the box,
  // and uploaded to the laptop only when Send goes (api.js `upload`); Send then names the saved files and the server adds their paths to
  // the text. The thumbnails are painted from the file the person picked, into a canvas: nothing is served back, and the page's content
  // policy allows no image address for it anyway. Photos live in this tab only: a reload drops them (the typed text is kept, as before).
  const attach = (() => {
    // api.js decides what it takes; these are the same numbers, so the page can say no before uploading (a test keeps them equal).
    const MAX_PHOTOS = 6, MAX_PHOTO_BYTES = 12 * 1024 * 1024, MAX_PHOTOS_BYTES = 30 * 1024 * 1024;
    const TYPE = /^image\/(?:png|jpe?g|gif|webp|heic|heif)$/i, NAME = /\.(?:png|jpe?g|gif|webp|heic|heif)$/i;
    const mb = bytes => (bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0) + " MB";
    // A file's size as a person reads it: bytes, KB or MB (the limits above are always in MB).
    const size = bytes => bytes < 1024 ? bytes + " B" : bytes < 1048576 ? Math.round(bytes / 1024) + " KB" : mb(bytes);
    const photos = n => n + (n === 1 ? " photo" : " photos");
    // By its type, or by its name when the browser gives it none (an iPhone's HEIC often has none). The laptop checks the bytes.
    const looksLikePhoto = file => TYPE.test(file.type || "") || (!file.type && NAME.test(file.name || ""));
    const kindOf = item => ((item.name.match(/\.([A-Za-z0-9]{2,5})$/) || [])[1] || "photo").toUpperCase();

    // The photos waiting to go, for each session of this tab: [{ key, name, size, file, id, error }]. id is what the laptop called the
    // file once it was uploaded, error the laptop's words when it refused one.
    function makeStore() {
      const lists = new Map();
      let seq = 0;
      const list = sid => lists.get(sid) || [];
      const bytes = sid => list(sid).reduce((sum, item) => sum + item.size, 0);
      const keep = (sid, items) => { if (items.length) lists.set(sid, items); else lists.delete(sid); };
      // Takes what fits, in order, and says why for each file that does not: { added, refused: [{ name, why }] }.
      function add(sid, files) {
        const before = list(sid), items = before.slice(), refused = [];
        let held = bytes(sid);
        for (const file of Array.from(files)) {
          const name = file.name || "photo";
          if (!looksLikePhoto(file)) refused.push({ name, why: "is not a PNG, JPEG, GIF, WebP or HEIC photo" });
          else if (!file.size) refused.push({ name, why: "is empty" });
          else if (file.size > MAX_PHOTO_BYTES) refused.push({ name, why: `is ${mb(file.size)}, and a photo can be at most ${mb(MAX_PHOTO_BYTES)}` });
          else if (items.length >= MAX_PHOTOS) refused.push({ name, why: `does not fit: a message carries at most ${MAX_PHOTOS} photos` });
          else if (held + file.size > MAX_PHOTOS_BYTES) refused.push({ name, why: `does not fit: a message carries at most ${mb(MAX_PHOTOS_BYTES)} of photos` });
          else { held += file.size; seq += 1; items.push({ key: seq, name, size: file.size, file, id: null, error: "" }); }
        }
        keep(sid, items);
        return { added: items.length - before.length, refused };
      }
      const remove = (sid, key) => keep(sid, list(sid).filter(item => item.key !== key));
      // What a send carried is gone once it went; a photo added while it ran stays.
      const drop = (sid, sent) => keep(sid, list(sid).filter(item => !sent.includes(item)));
      // After a /clear the conversation goes on under the pane's newest session, and its photos with it.
      function move(from, to) {
        if (from === to || !list(from).length) return;
        keep(to, list(from).concat(list(to)));
        lists.delete(from);
      }
      return { list, bytes, add, remove, drop, move };
    }

    // One sentence for the files a pick left out ("a.pdf is not a PNG, JPEG, GIF, WebP or HEIC photo."), the first two named.
    function refusal(refused) {
      if (!refused.length) return "";
      const first = refused.slice(0, 2).map(r => `${r.name} ${r.why}`).join("; ");
      return first + (refused.length > 2 ? `; and ${refused.length - 2} more were left out` : "") + ".";
    }

    // Uploads the photos that have no id yet, one at a time (step(n, of) says which, and step(0, of) that the last one is up, so the bar stops
    // saying "uploading" while the send itself runs), and answers every id in order. A photo keeps its id
    // once it has one, so a Send that failed after the upload does not upload again. One the laptop refuses keeps its words in .error and
    // stops the rest, and nothing is sent.
    async function uploadAll(items, upload, step = () => {}) {
      const todo = items.filter(item => !item.id);
      for (const [i, item] of todo.entries()) {
        step(i + 1, todo.length);
        item.error = "";
        try { item.id = (await upload(item.file, item.name)).id; } catch (e) { item.error = e.message || "It could not be uploaded."; throw e; }
      }
      if (todo.length) step(0, todo.length);
      return items.map(item => item.id);
    }

    // The upload and then the send, with the ids the upload gave. A send the laptop refuses because a saved photo has gone from its folder
    // forgets the ids, so the next try uploads them again.
    async function deliver(items, { upload, send, step }) {
      const ids = items.length ? await uploadAll(items, upload, step) : [];
      try { return await send(ids); } catch (e) {
        if (e && e.code === "image_gone") for (const item of items) item.id = null;
        throw e;
      }
    }

    // Paints a photo, cropped square, into the canvas. A format this browser cannot decode (an iPhone's HEIC on a Mac or a PC is the usual
    // one) rejects, and the tile then names its kind instead; the photo still goes, and the laptop converts it.
    async function draw(canvas, file, make = typeof createImageBitmap === "function" ? createImageBitmap : null) {
      if (!make) throw new Error("This browser cannot show it.");
      const bitmap = await make(file);
      try {
        const side = Math.min(bitmap.width, bitmap.height);
        canvas.getContext("2d").drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
      } finally { if (bitmap.close) bitmap.close(); }
    }

    // The thumbnails above the box: a tile for each photo with its remove button. A tile is made once (its picture is painted
    // asynchronously) and put back as the list changes; locked turns the remove buttons off while the message is held or on its way.
    function makeStrip({ doc, el, onRemove, paint = draw }) {
      let shown = null;
      function tile(item) {
        if (item.tile) return item.tile;
        const node = doc.createElement("div"), pic = doc.createElement("span"), canvas = doc.createElement("canvas"), cut = doc.createElement("button");
        node.className = "thumb"; pic.className = "thumb-pic";
        pic.setAttribute("role", "img"); pic.setAttribute("aria-label", item.name);
        canvas.width = 112; canvas.height = 112;
        pic.append(canvas);
        Promise.resolve().then(() => paint(canvas, item.file)).catch(() => { pic.className = "thumb-pic plain"; pic.textContent = kindOf(item); });
        cut.type = "button"; cut.className = "thumb-x"; cut.textContent = "✕";
        cut.setAttribute("aria-label", `Remove ${item.name}`); cut.title = "Remove this photo";
        cut.addEventListener("click", () => onRemove(item));
        node.append(pic, cut);
        item.tile = node; item.cut = cut;
        return node;
      }
      return function paintStrip(items, locked) {
        el.hidden = !items.length;
        const sig = items.map(item => item.key + (item.error ? "!" : "")).join(",") + (locked ? "|locked" : "");
        if (sig === shown) return;
        shown = sig;
        const tiles = items.map(item => {
          const node = tile(item);
          node.className = "thumb" + (item.error ? " bad" : "");
          node.title = item.error || `${item.name} · ${size(item.size)}`;
          item.cut.disabled = locked;
          return node;
        });
        el.replaceChildren(...tiles);
      };
    }

    return { MAX_PHOTOS, MAX_PHOTO_BYTES, MAX_PHOTOS_BYTES, mb, size, photos, looksLikePhoto, makeStore, refusal, uploadAll, deliver, draw, makeStrip };
  })();
