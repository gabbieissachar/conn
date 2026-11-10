// A Campus tool call as a card (the live view's step and the native transcript's step list): the name, a short title, the input (code as code), the result
// (JSON already indented) and the state. A long input or result is clipped to a few lines with "Show all N lines" under it, so the card stays one glance tall
// until the person asks for the rest. The reader's embed page draws the same call in its own step sheet (`CampusEmbed.toolJSON` is what it gets).
import SwiftUI
import ConnCore

struct CampusToolCard: View {
    let item: CampusItem
    let privacy: Bool
    /// How many lines a block shows before "Show all".
    static let inputLines = 6, outputLines = 8
    @State private var inputAll = false
    @State private var outputAll = false

    private var mono: Font { .system(size: 11, design: .monospaced) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if !item.input.isEmpty { block(label: item.inputFormat == .code ? "Code" : "Input", text: item.input, limit: Self.inputLines, all: $inputAll, id: "input") }
            if !item.output.isEmpty { block(label: item.toolStatus == .failed ? "Error" : "Result", text: item.output, limit: Self.outputLines, all: $outputAll, id: "output") }
        }
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(item.toolStatus == .failed ? AgentState.blocked.color.opacity(0.5) : Color.primary.opacity(0.12)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("campus-tool-card")
    }

    private var header: some View {
        HStack(spacing: 6) {
            Text(item.tool.isEmpty ? "tool" : item.tool).font(.system(size: 12, design: .monospaced).weight(.semibold))
            if !item.title.isEmpty {
                Text(item.title).font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail).redacted(reason: privacy ? .placeholder : [])
            } else if item.input.isEmpty && !item.argument.isEmpty {
                Text(item.argument).font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle).redacted(reason: privacy ? .placeholder : [])
            }
            Spacer(minLength: 6)
            if !item.detail.isEmpty { Text(item.detail).font(.system(size: 11, design: .monospaced)).foregroundStyle(.tertiary) }
            stateLabel
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
    }

    @ViewBuilder private var stateLabel: some View {
        switch item.toolStatus {
        case .running: HStack(spacing: 4) { ProgressView().controlSize(.mini); Text("Running").font(.system(size: 11)).foregroundStyle(.secondary) }
        case .ok: Text("Done").font(.system(size: 11)).foregroundStyle(AgentState.done.color)
        case .failed: Text("Failed").font(.system(size: 11)).foregroundStyle(AgentState.blocked.color)
        case .aborted: Text("Stopped").font(.system(size: 11)).foregroundStyle(AgentState.blocked.color)
        }
    }

    private func block(label: String, text: String, limit: Int, all: Binding<Bool>, id: String) -> some View {
        let lines = Self.lineCount(text)
        let clipped = lines > limit && !all.wrappedValue
        return VStack(alignment: .leading, spacing: 3) {
            Divider()
            Text(label).font(.system(size: 10, weight: .semibold)).foregroundStyle(.tertiary).textCase(.uppercase).padding(.horizontal, 8).padding(.top, 2)
            Text(text).font(mono).foregroundStyle(.primary.opacity(0.85)).textSelection(.enabled)
                .lineLimit(clipped ? limit : nil).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 8)
                .redacted(reason: privacy ? .placeholder : [])
                .accessibilityIdentifier("campus-tool-\(id)")
            if lines > limit {
                Button(all.wrappedValue ? "Show less" : "Show all \(lines) lines") { all.wrappedValue.toggle() }
                    .buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(Color.accentColor).padding(.horizontal, 8)
                    .accessibilityIdentifier("campus-tool-\(id)-more")
            }
            Spacer().frame(height: 3)
        }
    }

    /// Lines in a text; a very long line counts for as many lines as it is likely to wrap to, so one long line is clipped too.
    static func lineCount(_ text: String) -> Int {
        text.split(separator: "\n", omittingEmptySubsequences: false).reduce(0) { $0 + max(1, ($1.count + 79) / 80) }
    }
}
