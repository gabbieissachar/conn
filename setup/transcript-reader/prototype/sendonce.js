  // ---------------------------------------------------------------- sent answers (sendonce.js, the answer sheet only)
  // build_prototype.fill_template pastes this file into the answer sheet's script, after live.js. It remembers which answers each
  // questionnaire has already sent, so a second tap cannot send the same text again, and holds the one send in flight.
  // No page needed: sendonce.test.js runs it in a bare sandbox.
  const makeSendOnce = () => {
    const sent = new Map();   // questionnaire key -> { text, word, at }: the answers it sent last, and how it reads
    let flying = false;
    return {
      // Takes the send for <text> on <key>. False when another send is in flight or this exact text already went,
      // so the click handler can stop before it asks the server for anything.
      begin(key, text) {
        if (flying || this.sentFor(key, text)) return false;
        flying = true; return true;
      },
      busy: () => flying,
      // The send went through: <word> ("Sent", "Queued") and the <at> time are what the sheet shows for it.
      done(key, text, word, at) { flying = false; sent.set(key, { text, word, at }); },
      // The send failed: it can be tried again at once.
      failed() { flying = false; },
      // What a queued send turned into once the laptop answered (Sent), or, when it refused, that the answers did not go.
      relabel(key, text, word) { const s = sent.get(key); if (s && s.text === text) s.word = word; },
      forget(key, text) { const s = sent.get(key); if (s && s.text === text) sent.delete(key); },
      // The record when <text> is exactly what <key> sent last; a changed answer has none, so Send is on again.
      sentFor(key, text) { const s = sent.get(key); return s && s.text === text ? s : null; },
    };
  };
  const sendOnce = makeSendOnce();
