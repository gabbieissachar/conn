  // ---------------------------------------------------------------- which asks wait on you (asks.js, shared by the reader page and asks.test.js)
  // build_prototype.mark_asks gives each reply that needs you an ask_state: "open" (nothing from you came after it), "quiet" (you wrote
  // something later that did not answer it) or "settled" (you answered it by Reply or a keyed line, which the answer sheet types).
  // Only an open ask is yellow, and the header counts the same set. A copy built before ask_state existed has none: its asks read as open.
  const askRules = (() => {
    const state = ex => ex.verdict === "needs-you" ? ex.ask_state || "open" : null;
    const isOpen = ex => state(ex) === "open";
    const open = exchanges => exchanges.filter(isOpen);
    return { state, isOpen, open, count: exchanges => open(exchanges).length };
  })();
