// `--ui-check` steps for the Campus stars (S1), run by `CampusCheck` against the stand-in Campus: starring from a row, the chip in the Reader column's starred
// row, a click that opens by the Watch rule, "Open in a Watch Column", the quick switcher order, and what is written to settings (addresses and order only).
// SwiftUI builds no accessibility tree for an inert background window (see StarredBarCheck), so the steps read the model; `CONN_UI_CHECK_SHOT_DIR` also writes
// a picture of the row, which is looked at by eye.
import SwiftUI
import ConnCore

extension CampusCheck {
    static func starChecks(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void, until: (Double, () -> Bool) async -> Bool, shot: (String) async -> Void) async {
        let campus = model.campus, stars = model.campusStars, watch = model.watch
        guard campus.link == .live else { report("Campus stars: the checks need a live Campus", false, "link=\(campus.link)"); return }
        model.watchOn = false; model.showWeb = true; model.webTab = .reader
        stars.clear()
        let ids = ["ses_fakeSprint03", "ses_fakeKpi06", "ses_fakeOffsite04"]
        func columns() -> [String] { watch.layout.slots.map { $0?.session ?? "-" } }

        // 1. Starring from a row (the row's menu, the header button and the Campus menu all call this).
        for id in ids { if let c = campus.conversation(id) { model.toggleCampusStar(c) } }
        report("Campus stars: starring three conversations keeps them in the order they were starred", stars.list.ids == ids && ids.allSatisfy { model.campusIsStarred($0) }, "stars=\(stars.list.ids.map { String($0.suffix(6)) })")
        model.toggleCampusStar(campus.conversation("ses_fakeKpi06")!)
        let removed = !model.campusIsStarred("ses_fakeKpi06") && stars.list.ids == [ids[0], ids[2]]
        model.toggleCampusStar(campus.conversation("ses_fakeKpi06")!)
        report("Campus stars: starring again takes the star off, and it goes back at the end", removed && stars.list.ids == [ids[0], ids[2], ids[1]], "stars=\(stars.list.ids.map { String($0.suffix(6)) })")
        stars.move("ses_fakeKpi06", onto: "ses_fakeSprint03")
        report("Campus stars: a drag onto another chip puts it in that chip's place", stars.list.ids == [ids[1], ids[0], ids[2]], "stars=\(stars.list.ids.map { String($0.suffix(6)) })")

        // 2. What is written: addresses and order, and nothing else. A new store over the same settings (a relaunch) reads the same order back.
        let raw = AppModel.defaults.array(forKey: stars.key) as? [String] ?? []
        let titles = ids.compactMap { campus.conversation($0)?.title }
        let written = String(describing: raw)
        report("Campus stars: settings hold only the addresses, in order (no title, no text), and a relaunch reads them back",
               raw == stars.list.entries.map(\.text) && raw.allSatisfy { CampusAddress.parse($0) != nil } && !titles.isEmpty && titles.allSatisfy { !written.contains($0) } && CampusStarStore(defaults: AppModel.defaults, key: stars.key).list.ids == stars.list.ids,
               "written=\(raw)")

        // 3. The starred row: a click on a chip opens the conversation by the Watch rule. Watch off: the centre and the Reader column.
        model.campusSelectedID = nil
        model.openCampusStar("ses_fakeSprint03")
        let centre = await until(8) { model.campusSelectedID == "ses_fakeSprint03" }
        report("Campus stars: a click on a Campus chip with Watch off shows that conversation in the centre and the Reader column", centre && !model.watchOn, "selected=\(model.campusSelectedID ?? "nil")")
        await wait(0.8)
        await shot("campus-14-starred-row.png")

        // 4. Watch on: the same click goes to a column by the column rule (the one on screen keeps its column, another takes a free one).
        watch.forgetEverything()
        model.watchOn = true
        _ = await until(20) { watch.layout.openCount >= 2 }
        model.openCampusStar("ses_fakeKpi06")
        let placed = await until(8) { columns().contains(CampusColumn.key("ses_fakeKpi06")) }
        let at = columns().firstIndex(of: CampusColumn.key("ses_fakeKpi06"))
        model.openCampusStar("ses_fakeKpi06"); await wait(0.3)
        report("Campus stars: with Watch on a chip puts the conversation in a column by the column rule, and a second click keeps that column", placed && at != nil && columns().filter { $0 == CampusColumn.key("ses_fakeKpi06") }.count == 1 && columns().firstIndex(of: CampusColumn.key("ses_fakeKpi06")) == at, "columns=\(columns().map { CampusColumn.isCampus($0) ? "C" + $0.suffix(4) : String($0.suffix(4)) })")

        // 5. "Open in a Watch Column" from a row with Watch off turns Watch on and places it.
        model.watchOn = false; await wait(0.5)
        model.showCampusInWatch("ses_fakeOffsite04")
        let turnedOn = await until(10) { model.watchOn && columns().contains(CampusColumn.key("ses_fakeOffsite04")) }
        report("Campus stars: Open in a Watch Column from a CAMPUS row turns Watch on and puts the conversation in a column", turnedOn, "watch=\(model.watchOn) columns=\(columns().map { CampusColumn.isCampus($0) ? "C" + $0.suffix(4) : String($0.suffix(4)) })")
        model.watchOn = false; await wait(0.5)

        // 6. Cmd+K: asks first, then the starred conversations in the row's order, then the rest.
        let rows = model.campusSwitcherRows.map(\.id)
        let asks = rows.prefix { campus.conversation($0)?.needsYou == true }
        let afterAsks = Array(rows.dropFirst(asks.count))
        report("Campus stars: the quick switcher lists asks first, then the starred conversations in the row's order, then the rest",
               !asks.isEmpty && Array(afterAsks.prefix(3)) == stars.list.ids && Set(rows).count == campus.conversations.count && afterAsks.dropFirst(3).allSatisfy { !stars.isStarred($0) },
               "rows=\(rows.map { String($0.suffix(6)) })")

        // 7. A star on a conversation Campus no longer lists keeps its place and does not break the row.
        let gone = CampusAddress(kind: "private", folder: "default", id: "ses_goneForever")
        stars.toggle(gone)
        campus.kick(); await wait(1.0)
        report("Campus stars: a star for a conversation Campus does not have stays in the row and opens nothing", stars.isStarred("ses_goneForever") && campus.conversation("ses_goneForever") == nil && !model.campusSwitcherRows.contains { $0.id == "ses_goneForever" }, "stars=\(stars.list.ids.count)")
        stars.unstar("ses_goneForever")

        // 8. The settings button clears the row.
        stars.clear()
        report("Campus stars: Remove All Stars empties the row and the settings", stars.entries.isEmpty && (AppModel.defaults.array(forKey: stars.key) as? [String] ?? ["x"]).isEmpty, "left=\(stars.entries.count)")
        model.campusSelectedID = nil
    }
}
