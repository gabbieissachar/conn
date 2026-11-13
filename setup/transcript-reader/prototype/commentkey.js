  // ---------------------------------------------------------------- Cmd/Ctrl+Enter for "Comment on this" (commentkey.js, the reader page only)
  // build_prototype.fill_template pastes this file into the reader page's script. Pure functions, so commentkey.test.js runs them without a page.
  const commentKey = (() => {
    const typing = el => Boolean(el) && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable === true);
    // Whether <e> is the shortcut: Cmd+Enter (Ctrl+Enter off the Mac), with no Shift or Alt, not while an input method is composing or
    // the key repeats, and not while focus is in a text field, where Cmd+Enter already means Add (the message box) or belongs to the field.
    const pressed = e => e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && !e.isComposing && !e.repeat && !typing(e.target);
    // The key as the keyboard shows it: the Mac's symbols, else Ctrl+Enter. <platform> is navigator.platform.
    const label = platform => /^(Mac|iPhone|iPad|iPod)/.test(platform || "") ? "⌘↵" : "Ctrl+Enter";
    return { pressed, label };
  })();
