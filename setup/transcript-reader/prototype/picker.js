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
    function sections(sessions, running, starred = () => false) {
      const entries = sessions.map((s, i) => [s, i]);
      const only = name => entries.filter(([s]) => part(s, running, starred) === name);
      return { starred: only("starred"), running: only("running"), idle: only("idle") };
    }
    // Whether a star names this session: stars are kept by conversation, the way pins are (<ids> is every id the
    // conversation has had, the newest first), so a /clear that moves it under a new id keeps its star. Answers the
    // star's own conversation, which is what to send to unstar it, or null.
    function starOf(session, stars) {
      const ids = session.ids || [session.id];
      const found = stars.find(star => ids.includes(star.conv));
      return found ? found.conv : null;
    }
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
    return { part, sections, starOf, label, pageTitle };
  })();
