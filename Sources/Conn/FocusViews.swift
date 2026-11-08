// The views of Conn Focus: the toolbar pill and its popover, the menu-bar countdown, the one-time setup guide, and the eye-break panel's content.
// Redrawing every second is confined to `FocusFace`: a view that shows a time left observes the face, a view that only needs the state observes the coordinator.
import SwiftUI
import AppKit
import ConnCore

enum FocusStyle {
    /// The Focus colour (the sketch's indigo) and the eye colour (teal).
    static let focus = Color(red: 0.37, green: 0.36, blue: 0.90)
    static let eye = Color(red: 0.07, green: 0.59, blue: 0.56)
}

// MARK: toolbar pill

/// The first item of the right-hand toolbar group: a timer icon when nothing runs, the countdown while a session runs or is paused, "Done" when it ends. A click opens the
/// popover (the same controls as the menu-bar item).
struct FocusToolbarButton: View {
    @ObservedObject var focus: FocusCoordinator
    @Binding var shown: Bool

    var body: some View {
        Button { shown.toggle() } label: { FocusPillLabel(focus: focus, face: focus.face) }
            .buttonStyle(.plain)
            .help(helpText)
            .accessibilityLabel("Focus session")
            .popover(isPresented: $shown, arrowEdge: .bottom) {
                FocusPanelView(focus: focus, face: focus.face)
            }
    }

    private var helpText: String {
        switch focus.session.phase {
        case .idle: return "Focus session and eye breaks"
        case .running: return "Focus session running: click for pause, +5 min and stop"
        case .paused: return "Focus session paused"
        case .done: return "Focus session done: click to restart"
        }
    }
}

struct FocusPillLabel: View {
    @ObservedObject var focus: FocusCoordinator
    @ObservedObject var face: FocusFace

    var body: some View {
        let s = focus.session
        let red = s.isActive && focus.link.isRed
        HStack(spacing: 5) {
            Image(systemName: icon(s, red: red)).font(.system(size: 12, weight: .semibold))
            if let t = text(s) { Text(t).font(.system(size: 12, weight: .semibold)).monospacedDigit() }
        }
        .foregroundStyle(foreground(s, red: red))
        .padding(.horizontal, s.isIdle ? 6 : 9).frame(minWidth: 24, minHeight: 24)
        .background(Capsule().fill(background(s, red: red)))
        .contentShape(Capsule())
    }

    private func icon(_ s: FocusSession, red: Bool) -> String {
        if red { return "exclamationmark.triangle.fill" }
        switch s.phase {
        case .idle: return "timer"
        case .running: return "timer"
        case .paused: return "pause.fill"
        case .done: return "checkmark"
        }
    }

    private func text(_ s: FocusSession) -> String? {
        switch s.phase {
        case .idle: return nil
        case .running, .paused: return FocusTimeFormat.clock(s.remaining(at: face.now))
        case .done: return "Done"
        }
    }

    private func foreground(_ s: FocusSession, red: Bool) -> Color {
        if red { return .red }
        switch s.phase {
        case .idle: return .primary
        case .running: return FocusStyle.focus
        case .paused: return .secondary
        case .done: return Color(nsColor: .systemGreen)
        }
    }

    private func background(_ s: FocusSession, red: Bool) -> Color {
        if red { return Color.red.opacity(0.14) }
        switch s.phase {
        case .idle: return .clear
        case .running: return FocusStyle.focus.opacity(0.14)
        case .paused: return Color.primary.opacity(0.08)
        case .done: return Color(nsColor: .systemGreen).opacity(0.16)
        }
    }
}

// MARK: menu bar

/// The menu-bar item while a session runs (and until Done is dismissed): the timer and the time left, in the system's menu-bar text, visible with Conn behind other apps.
struct FocusMenuBarLabel: View {
    @ObservedObject var focus: FocusCoordinator
    @ObservedObject var face: FocusFace

    var body: some View {
        let s = focus.session
        HStack(spacing: 3) {
            Image(systemName: s.isActive && focus.link.isRed ? "exclamationmark.triangle.fill" : (s.isPaused ? "pause.fill" : (s.isDone ? "checkmark" : "timer")))
            Text(s.isDone ? "Done" : FocusTimeFormat.clock(s.remaining(at: face.now))).monospacedDigit()
        }
    }
}

// MARK: the popover (and the menu-bar window)

struct FocusPanelView: View {
    @ObservedObject var focus: FocusCoordinator
    @ObservedObject var face: FocusFace
    @EnvironmentObject var app: AppModel
    @State private var customOn = false
    @State private var customMinutes = 35
    @State private var confirmStop = false
    @State private var detailsOpen = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let n = focus.notice { noticeRow(n) }
            switch focus.session.phase {
            case .idle: idleBody
            case .running, .paused: activeBody
            case .done: doneBody
            }
            eyeRow
            Divider()
            footer
        }
        .padding(14)
        .frame(width: 344, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .onAppear {
            focus.beginWatching()
            customOn = !FocusSession.presetMinutes.contains(focus.chosenMinutes)
            customMinutes = max(5, (focus.chosenMinutes / 5) * 5)
            // Until both shortcuts have been seen, each time the start view opens it looks again (a listing only; nothing is run), so making them in Shortcuts is noticed.
            if focus.setupStatus?.isReady != true, focus.session.isIdle { Task { await focus.checkSetup() } }
        }
        .onDisappear { focus.endWatching(); confirmStop = false }
    }

    private var minutes: Int { customOn ? customMinutes : focus.chosenMinutes }

    // MARK: idle

    private var idleBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Focus session").font(.system(size: 15, weight: .semibold))
            if focus.link.isRed { redBox(focus.link) }
            Text("LENGTH (MINUTES)").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
            HStack(spacing: 6) {
                ForEach(FocusSession.presetMinutes, id: \.self) { m in
                    chip("\(m)", selected: !customOn && focus.chosenMinutes == m) { customOn = false; focus.chosenMinutes = m }
                }
                chip("Custom", selected: customOn) { customOn = true; customMinutes = max(5, (focus.chosenMinutes / 5) * 5) }
            }
            if customOn {
                HStack(spacing: 8) {
                    Button { customMinutes = max(5, customMinutes - 5) } label: { Image(systemName: "minus") }.disabled(customMinutes <= 5)
                    Text("\(customMinutes) min").font(.system(size: 13, weight: .semibold)).monospacedDigit().frame(minWidth: 64)
                    Button { customMinutes = min(FocusSession.maxMinutes, customMinutes + 5) } label: { Image(systemName: "plus") }.disabled(customMinutes >= FocusSession.maxMinutes)
                    Text("5 min steps, 5 to \(FocusSession.maxMinutes)").font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            focusRow
            Button { focus.start(minutes: minutes); app.focusPopoverShown = false } label: {
                Text("Start \(minutes) min focus").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent).tint(FocusStyle.focus).controlSize(.large)
        }
    }

    /// "Conn Focus: silences other apps' banners", with whether the two shortcuts exist.
    private var focusRow: some View {
        HStack(alignment: .top, spacing: 10) {
            glyph("moon.fill", FocusStyle.focus)
            VStack(alignment: .leading, spacing: 2) {
                Text("Conn Focus").font(.system(size: 13, weight: .semibold))
                Text("Silences other apps' banners. Switches on at Start, off at the end.").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 4)
            switch focus.setupStatus {
            case .ready: Text("Ready").font(.system(size: 11, weight: .semibold)).foregroundStyle(Color(nsColor: .systemGreen))
            case .missing: Button("Set up") { app.focusSetupShown = true }.controlSize(.small).tint(.red)
            case .unavailable: Button("Check") { app.focusSetupShown = true }.controlSize(.small)
            case nil: Text("Checking").font(.system(size: 11)).foregroundStyle(.secondary)
            }
        }
    }

    // MARK: running and paused

    private var activeBody: some View {
        let s = focus.session
        let paused = s.isPaused
        return VStack(alignment: .leading, spacing: 8) {
            if focus.link.isRed { redBox(focus.link) }
            else if case .onUnconfirmed(let why) = focus.link { neutralNote("Conn Focus is on, but not confirmed: \(why).") }
            else if focus.link == .switchingOn { neutralNote("Switching on Conn Focus…") }
            Text(FocusTimeFormat.clock(s.remaining(at: face.now))).font(.system(size: 40, weight: .semibold, design: .rounded)).monospacedDigit().foregroundStyle(paused ? Color.secondary : FocusStyle.focus)
            Text(subline(s)).font(.system(size: 12)).foregroundStyle(.secondary)
            ProgressView(value: s.progress(at: face.now)).tint(paused ? .gray : FocusStyle.focus)
            if confirmStop { stopAsk(s) }
            HStack(spacing: 6) {
                Button { if paused { focus.resumeSession() } else { focus.pauseSession() } } label: {
                    Label(paused ? "Resume" : "Pause", systemImage: paused ? "play.fill" : "pause.fill").lineLimit(1).frame(maxWidth: .infinity)
                }
                Button { focus.extendSession() } label: { Label("5 min", systemImage: "plus").lineLimit(1).frame(maxWidth: .infinity) }
                Button(role: .destructive) { confirmStop = true } label: { Label("Stop early", systemImage: "stop.fill").lineLimit(1).frame(maxWidth: .infinity) }
            }
            .controlSize(.regular).font(.system(size: 12))
        }
    }

    private func subline(_ s: FocusSession) -> String {
        let length = "\(s.lengthMinutes) min"
        if let e = s.endsAt { return "Focus · \(length) · ends \(FocusTimeFormat.endTime(e))" }
        return "Paused · \(length)"
    }

    private func stopAsk(_ s: FocusSession) -> some View {
        let focusedMin = Int((s.focused(at: face.now) / 60).rounded())
        return VStack(alignment: .leading, spacing: 8) {
            Text("Stop with \(FocusTimeFormat.clock(s.remaining(at: face.now))) left? The \(focusedMin) min you focused still count today.").font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("Keep going") { confirmStop = false }
                Button("Stop session", role: .destructive) { confirmStop = false; focus.stopEarly() }
            }
        }
        .padding(10).background(RoundedRectangle(cornerRadius: 8).fill(Color.red.opacity(0.08)))
    }

    // MARK: done

    private var doneBody: some View {
        let s = focus.session
        return VStack(spacing: 6) {
            Image(systemName: "checkmark.circle.fill").font(.system(size: 40)).foregroundStyle(Color(nsColor: .systemGreen))
            Text("Session done").font(.system(size: 22, weight: .semibold))
            Text("\(Int((s.focused(at: face.now) / 60).rounded())) min focused · Conn Focus is off, banners are back").font(.system(size: 12)).foregroundStyle(.secondary).multilineTextAlignment(.center)
            if focus.link.isRed { redBox(focus.link) }
            Button { focus.restart(); app.focusPopoverShown = false } label: { Label("Restart \(s.lengthMinutes) min", systemImage: "play.fill").frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent).tint(FocusStyle.focus).controlSize(.large).padding(.top, 6)
            Button { focus.dismissDone() } label: { Text("Choose another length").frame(maxWidth: .infinity) }.controlSize(.large)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: eye row, footer, pieces

    private var eyeRow: some View {
        HStack(alignment: .top, spacing: 10) {
            glyph("eye", FocusStyle.eye)
            VStack(alignment: .leading, spacing: 2) {
                Text(eyeTitle).font(.system(size: 13, weight: .semibold)).monospacedDigit()
                Text(focus.eyeEnabled ? "20 ft away, 20 seconds. Runs outside sessions too." : "Switch on for 20-20-20 reminders").font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            Toggle("Eye breaks", isOn: Binding(get: { focus.eyeEnabled }, set: { focus.setEyeEnabled($0) })).toggleStyle(.switch).labelsHidden().controlSize(.small)
        }
    }

    private var eyeTitle: String {
        guard focus.eyeEnabled else { return "Eye breaks are off" }
        if focus.eye.isOnBreak { return "Eye break now" }
        if let s = focus.eye.secondsUntilBreak(at: face.now) { return "Next eye break in \(FocusTimeFormat.clock(s))" }
        return "Eye breaks, 20-20-20"
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(todayText).font(.system(size: 11)).foregroundStyle(.secondary).monospacedDigit().lineLimit(1).minimumScaleFactor(0.85)
            if detailsOpen { FocusTotalCard(total: focus.dayTotal(at: face.now)) }
            HStack {
                Button(detailsOpen ? "Hide total" : "Daily total") { detailsOpen.toggle() }.buttonStyle(.link).font(.system(size: 11))
                Spacer()
                Button("Set up Conn Focus…") { app.focusSetupShown = true }.buttonStyle(.link).font(.system(size: 11))
            }
        }
    }

    private var todayText: String {
        let t = focus.dayTotal(at: face.now)
        return "Today: \(FocusDayTotal.durationText(seconds: t.focusedSeconds)) focused · \(t.breaksTaken) eye breaks · \(t.breaksSkipped) skipped"
    }

    private func noticeRow(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "info.circle").foregroundStyle(.secondary)
            Text(text).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button { focus.dismissNotice() } label: { Image(systemName: "xmark") }.buttonStyle(.plain).foregroundStyle(.secondary)
        }
        .padding(8).background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.06)))
    }

    private func neutralNote(_ text: String) -> some View {
        Text(text).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }

    private func redBox(_ link: FocusLink) -> some View {
        let (headline, why, retry): (String, String, () -> Void) = {
            switch link {
            case .didNotSwitchOn(let w): return ("Conn Focus did not switch on.", "Other apps' banners are not silenced (\(w)).", { focus.retryFocus() })
            case .couldNotSwitchOff(let w): return ("Conn Focus may still be on.", "Banners may stay silenced (\(w)).", { focus.retrySwitchOff() })
            default: return ("", "", {})
            }
        }()
        return VStack(alignment: .leading, spacing: 4) {
            Text(headline).font(.system(size: 12, weight: .semibold)).foregroundStyle(Color(red: 0.61, green: 0.16, blue: 0.05))
            Text(why).font(.system(size: 11)).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 12) {
                Button("Try again", action: retry).buttonStyle(.link)
                Button("Set up Conn Focus…") { app.focusSetupShown = true }.buttonStyle(.link)
            }.font(.system(size: 11))
        }
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.red.opacity(0.10)))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.red.opacity(0.35), lineWidth: 1))
    }

    private func chip(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.system(size: 12, weight: .medium)).frame(minWidth: 26).padding(.vertical, 4).padding(.horizontal, 6)
                .background(RoundedRectangle(cornerRadius: 7).fill(selected ? FocusStyle.focus : Color.primary.opacity(0.07)))
                .foregroundStyle(selected ? Color.white : Color.primary)
        }
        .buttonStyle(.plain)
    }

    private func glyph(_ name: String, _ color: Color) -> some View {
        Image(systemName: name).font(.system(size: 13, weight: .semibold)).foregroundStyle(color)
            .frame(width: 28, height: 28).background(RoundedRectangle(cornerRadius: 8).fill(color.opacity(0.14)))
    }
}

/// The daily total (decision F13): three numbers for today, on this Mac only.
struct FocusTotalCard: View {
    let total: FocusDayTotal
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            row("Time focused", FocusDayTotal.durationText(seconds: total.focusedSeconds))
            row("Eye breaks taken", "\(total.breaksTaken)")
            row("Eye breaks skipped", "\(total.breaksSkipped)")
            Text("Today only, on this Mac. A new day starts at zero.").font(.system(size: 10)).foregroundStyle(.secondary)
        }
        .padding(10).background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
    }
    private func row(_ k: String, _ v: String) -> some View {
        HStack { Text(k).font(.system(size: 12)); Spacer(); Text(v).font(.system(size: 12, weight: .semibold)).monospacedDigit() }
    }
}

// MARK: the eye-break panel's content (decisions F9, F11)

struct EyeBreakView: View {
    @ObservedObject var focus: FocusCoordinator
    @ObservedObject var face: FocusFace

    var body: some View {
        let onBreak = focus.eye.isOnBreak
        let left = focus.eye.breakSecondsLeft(at: face.now) ?? 0
        let cfg = focus.eye.config
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Image(systemName: "eye").font(.system(size: 18, weight: .semibold)).foregroundStyle(Color(red: 0.44, green: 0.89, blue: 0.85))
                    .frame(width: 38, height: 38).background(Circle().fill(Color.white.opacity(0.12)))
                VStack(alignment: .leading, spacing: 2) {
                    Text(onBreak ? "Look 20 feet away" : "Good. Back to it.").font(.system(size: 15, weight: .semibold))
                    Text(onBreak ? "Pick something far: out a window, across the room." : "Your eyes have reset.").font(.system(size: 12)).foregroundStyle(.white.opacity(0.72)).lineLimit(2)
                }
                Spacer(minLength: 0)
                ZStack {
                    Circle().stroke(Color.white.opacity(0.18), lineWidth: 5)
                    Circle().trim(from: 0, to: onBreak ? max(0, min(1, 1 - left / cfg.breakSeconds)) : 1).stroke(onBreak ? Color(red: 0.44, green: 0.89, blue: 0.85) : Color(red: 0.48, green: 0.90, blue: 0.62), style: StrokeStyle(lineWidth: 5, lineCap: .round)).rotationEffect(.degrees(-90))
                    if onBreak { Text("\(Int(left.rounded(.up)))").font(.system(size: 18, weight: .semibold, design: .rounded)).monospacedDigit() } else { Image(systemName: "checkmark").font(.system(size: 18, weight: .bold)) }
                }
                .frame(width: 48, height: 48)
            }
            if onBreak {
                HStack(spacing: 8) {
                    Button("Skip") { focus.skipBreak() }
                    Button("Snooze 2 min") { focus.snoozeBreak() }
                    Spacer()
                    Text("Does not take the keyboard").font(.system(size: 10)).foregroundStyle(.white.opacity(0.5))
                }
                .controlSize(.small)
            }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 16).padding(.vertical, 12)
        .frame(width: EyePanelPlacement.size.width, height: EyePanelPlacement.size.height, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.black.opacity(0.80)))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Color.white.opacity(0.14), lineWidth: 1))
        .environment(\.colorScheme, .dark)
    }
}

// MARK: one-time setup (the sketch's six steps)

struct FocusSetupSheet: View {
    @ObservedObject var focus: FocusCoordinator
    @EnvironmentObject var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var checking = false

    private let steps: [(String, String)] = [
        ("Make the Focus", "Open System Settings > Focus > Add Focus > Custom. Name it exactly \"Conn Focus\"."),
        ("Silence everyone", "In Conn Focus, allow no people and no apps, no calls, and switch Time Sensitive off. Conn's Dock badge and bell count are not banners and Herdr's toasts are drawn inside Conn, so neither needs an exception."),
        ("Let Conn read the Focus (optional)", "System Settings > Focus > Focus Status: allow Conn, so Conn can confirm the Focus turned on and warn you if it did not. macOS asks once the first time (button below). Leave Share across devices off."),
        ("Shortcut: Conn Focus On", "In Shortcuts, make a shortcut named exactly \"Conn Focus On\" with one action: Set Focus, Focus: Conn Focus, turn on."),
        ("Shortcut: Conn Focus Off", "The same, named \"Conn Focus Off\", turned off."),
        ("Check it in Conn", "Press Check Focus Setup below (it only lists your shortcuts and runs nothing), then run a 1-minute test session."),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Set up Conn Focus once").font(.system(size: 18, weight: .semibold))
            Text("About 5 minutes, no Terminal. macOS has no call that turns a Focus on, so Conn runs two shortcuts you make once.").font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(steps.enumerated()), id: \.offset) { i, s in
                    HStack(alignment: .top, spacing: 10) {
                        Text("\(i + 1)").font(.system(size: 12, weight: .bold)).foregroundStyle(.white).frame(width: 22, height: 22).background(Circle().fill(FocusStyle.focus))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(s.0).font(.system(size: 13, weight: .semibold))
                            Text(s.1).font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            Divider()
            VStack(alignment: .leading, spacing: 6) {
                checkRow("Shortcut \"Conn Focus On\"", found: found(.on))
                checkRow("Shortcut \"Conn Focus Off\"", found: found(.off))
                HStack(spacing: 6) {
                    Image(systemName: access.symbol).foregroundStyle(access.color)
                    Text(access.text).font(.system(size: 12))
                }
                if case .unavailable(let why)? = focus.setupStatus { Text("Could not list your shortcuts: \(why)").font(.system(size: 11)).foregroundStyle(.red) }
            }
            HStack(spacing: 10) {
                Button { checking = true; Task { await focus.checkSetup(); checking = false } } label: { Text(checking ? "Checking…" : "Check Focus Setup") }.disabled(checking)
                Button("Allow Focus Status") { Task { await focus.requestFocusStatusAccess() } }.disabled(focus.statusAccess == .authorized)
                Button("Run a 1-minute test") { dismiss(); focus.start(minutes: 1) }.disabled(focus.session.isActive || !(focus.setupStatus?.isReady ?? false))
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
            Text("The test is the first real switch: Conn runs \"Conn Focus On\", confirms it, and switches off after one minute.").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .padding(20).frame(width: 560)
        .onAppear { Task { await focus.checkSetup() } }
    }

    private func found(_ s: FocusShortcut) -> Bool? {
        switch focus.setupStatus {
        case .ready: return true
        case .missing(let m): return !m.contains(s)
        case .unavailable, nil: return nil
        }
    }

    private func checkRow(_ title: String, found: Bool?) -> some View {
        HStack(spacing: 6) {
            Image(systemName: found == true ? "checkmark.circle.fill" : (found == false ? "xmark.circle.fill" : "circle.dotted")).foregroundStyle(found == true ? Color(nsColor: .systemGreen) : (found == false ? .red : .secondary))
            Text(title + (found == true ? " found" : (found == false ? " not found: make it in Shortcuts (steps 4 and 5)" : " not checked yet"))).font(.system(size: 12))
        }
    }

    private var access: (symbol: String, color: Color, text: String) {
        switch focus.statusAccess {
        case .authorized: return ("checkmark.circle.fill", Color(nsColor: .systemGreen), "Focus Status allowed: Conn can confirm the Focus turned on")
        case .notDetermined: return ("circle.dotted", .secondary, "Focus Status not asked yet. Conn asks at the first Start, or press Allow Focus Status.")
        case .denied: return ("minus.circle.fill", .orange, "Focus Status not allowed: Conn cannot confirm the Focus (System Settings > Focus > Focus Status)")
        case .restricted: return ("minus.circle.fill", .orange, "Focus Status is not available to this build of Conn")
        }
    }
}
