  // ---------------------------------------------------------------- the page's address (address.js, the reader page only)
  // build_prototype.fill_template pastes this file into the reader page's script. Pure functions, so address.test.js runs them without a page.
  // The address names a conversation, and either a document in it or a message in it:
  //   #s=<session id, or its first characters>                 the conversation
  //   #s=<session>&d=<document id, 10 hex>                     the conversation's Documents view on that file
  //   #s=<session>&m=<turn id, or its first 6 to 64 characters> the conversation, scrolled to that turn's reply (its message when it has none)
  // The turn id is ex.uid, the session log's own record id for the turn (build_prototype.turn_id): it never changes however the page is
  // rebuilt or the turns move, which a position would. message_link.py writes these addresses; the page also writes #s= (and &d=) itself.
  const address = (() => {
    const FORM = /^#s=([0-9a-f-]+)(?:&d=([0-9a-f]{10}))?(?:&m=([0-9A-Za-z_-]{6,64}))?$/;
    // { session, doc, message } (the parts the hash has, the rest null), or null when the hash is not an address.
    // A hash naming both a document and a message is not one: the two views are different places.
    const parse = hash => {
      const found = FORM.exec(hash || "");
      if (!found || (found[2] && found[3])) return null;
      return { session: found[1], doc: found[2] || null, message: found[3] || null };
    };
    // The hash for { session, doc, message }; a part left out is left off. The session is cut to 8 characters, as the page always has.
    const build = ({ session, doc, message }) => "#s=" + String(session).slice(0, 8) + (doc ? "&d=" + doc : "") + (message ? "&m=" + message : "");
    // The index of the turn an id names: the turn whose uid is exactly the id, else the first whose uid starts with it, else -1.
    // A turn with no uid (a page built before turns had them) is never named.
    const find = (exchanges, id) => {
      if (!Array.isArray(exchanges) || typeof id !== "string" || !id) return -1;
      const exact = exchanges.findIndex(e => e && e.uid === id);
      return exact >= 0 ? exact : exchanges.findIndex(e => e && typeof e.uid === "string" && e.uid.startsWith(id));
    };
    // The part of a turn an address points at: its reply, or its message when it has no reply.
    const part = ex => ex && ex.reply ? "reply" : "in";
    return { parse, build, find, part };
  })();
