  // ---------------------------------------------------------------- session picker (picker.js, the reader page only)
  // build_prototype.fill_template pastes this file into the reader page's script, after pins.js.
  // Which listed sessions the picker shows as running, and what each is called. Pure functions of the list, so
  // picker.test.js runs them without a page.
  const picker = (() => {
    // The listed sessions with their index, split into those <running> says an agent runs now and the rest,
    // each part in list order. The rest are still readable: the picker keeps them under Closed panes.
    function sections(sessions, running) {
      const entries = sessions.map((s, i) => [s, i]);
      return { running: entries.filter(([s]) => running(s)), idle: entries.filter(([s]) => !running(s)) };
    }
    // The name a session shows: its Herdr tab or pane label alone. Its own name (<titled>, with the session's
    // title) comes back only to tell apart two sessions with that label that <section> puts in the same part of
    // the picker, so a closed or kept session never makes a running one show its title.
    function label(s, sessions, section, titled) {
      if (!s.pane) return titled(s);
      const twins = sessions.filter(x => x.pane && x.pane.label === s.pane.label && section(x) === section(s));
      return twins.length > 1 ? titled(s) : s.pane.label;
    }
    return { sections, label };
  })();
