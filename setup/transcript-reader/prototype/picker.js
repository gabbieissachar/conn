  // ---------------------------------------------------------------- session picker (picker.js, the reader page only)
  // build_prototype.fill_template pastes this file into the reader page's script, after pins.js.
  // Which listed sessions the picker shows as running, and what each is called. Pure functions of the list, so
  // picker.test.js runs them without a page.
  const picker = (() => {
    // Where the picker puts a session: "starred" for one a person starred (<starred> says which), else "running" when
    // <running> says an agent runs it now, else "idle". Starred sessions leave the other parts.
    const part = (s, running, starred = () => false) => starred(s) ? "starred" : running(s) ? "running" : "idle";
    // The listed sessions with their index, split into the starred ones (the picker's top group), those <running> says
    // an agent runs now and the rest, each part in list order. The rest are still readable: the picker keeps them under
    // Closed panes.
    // starRank, when given, puts the starred group in the order of the stars (0 first: the newest), the list order breaking a tie; without it the starred group is in list order.
    function sections(sessions, running, starred = () => false, starRank = null) {
      const entries = sessions.map((s, i) => [s, i]);
      const only = name => entries.filter(([s]) => part(s, running, starred) === name);
      const top = only("starred");
      if (starRank) top.sort(([a, i], [b, j]) => (starRank(a) - starRank(b)) || (i - j));
      return { starred: top, running: only("running"), idle: only("idle") };
    }
    // The rank (0 is first) of the star that names a session, in the stars' own order: newest first, by when each was starred, and a star the
    // list does not hold last. Built once for a picker: a function of the session.
    function starRanker(stars) {
      const order = stars.map((star, n) => [star, n]).sort(([a, n], [b, m]) => (b.starred - a.starred) || (n - m)).map(([star]) => star.conv);
      return session => {
        const conv = starOf(session, stars);
        const at = conv === null ? -1 : order.indexOf(conv);
        return at < 0 ? order.length : at;
      };
    }
    // Which session an option of the picker names. The option holds the session's id, never its place in the list: the list is put
    // in a new order by every build (newest reply first), and a picker that is held open (its options are drawn again once it
    // closes) would send a choice to whichever session now stands at the old place. -1 for a session no longer on the page.
    function indexOf(sessions, value) {
      const own = sessions.findIndex(s => s.id === value);
      return own >= 0 ? own : sessions.findIndex(s => (s.ids || [s.id]).includes(value));
    }
    // Whether a star names this session: stars are kept by conversation, the way pins are (<ids> is every id the
    // conversation has had, the newest first), so a /clear that moves it under a new id keeps its star. Answers the
    // star's own conversation, which is what to send to unstar it, or null.
    function starOf(session, stars) {
      const ids = session.ids || [session.id];
      const found = stars.find(star => ids.includes(star.conv));
      return found ? found.conv : null;
    }
    // Whether the picker says "closed pane" of a session: one kept on screen after its pane closed, and one that was reopened by hand or last
    // seen in a pane that <running> says no agent runs now. A session a pane runs now is never tagged: "reopened" is a flag a conversation keeps
    // for as long as any session of its pane was once reopened, which says nothing about the pane today.
    const closed = (s, running) => Boolean(s.kept || ((s.reopened || s.pane) && !running(s)));
    // The name a session shows: its Herdr tab or pane label alone. Its own name (<titled>, with the session's
    // title) comes back only to tell apart two sessions with that label that <section> puts in the same part of
    // the picker, so a closed or kept session never makes a running one show its title.
    function label(s, sessions, section, titled) {
      if (!s.pane) return titled(s);
      const twins = sessions.filter(x => x.pane && x.pane.label === s.pane.label && section(x) === section(s));
      return twins.length > 1 ? titled(s) : s.pane.label;
    }
    // The browser tab's title, so tabs of several conversations tell apart: the open conversation's picker name
    // (<name>, or null when none is open) leads, then the view. The fleet timeline belongs to no conversation.
    function pageTitle(view, name) {
      if (view === "fleet") return "Fleet timeline · Reader";
      if (!name) return "Transcript reader";
      return name + (view === "doc" ? " · Documents" : " · Reader");
    }
    return { part, sections, starRanker, indexOf, starOf, closed, label, pageTitle };
  })();
