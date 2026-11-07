// The ask block on an agent row: what the agent asks, how long ago, and the reader's tags for it. A red bar leads the
// block (the colour of "needs you"), the ask is clamped to three lines, and the age and tags wrap under it.
import SwiftUI
import ConnCore

struct AskBlock: View {
    let ask: OpenAsk
    let privacy: Bool
    /// Already opened: shown only while "show read" is on, muted, with a grey bar.
    var read = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !ask.text.isEmpty {
                Text(ask.text)
                    .font(.system(size: 12)).lineLimit(3).truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            FlowLayout(spacing: 5, rowSpacing: 3) {
                // The age moves on without a new answer from the reader.
                TimelineView(.periodic(from: .now, by: 30)) { ctx in
                    Text(AskAge.text(ask.age(now: ctx.date))).font(.system(size: 10.5)).foregroundStyle(.secondary)
                }
                ForEach(Array(ask.tags.enumerated()), id: \.offset) { _, tag in AskTag(text: tag) }
            }
        }
        .redacted(reason: privacy ? .placeholder : [])
        .padding(.leading, 7).padding(.top, 1).padding(.bottom, 2)
        .overlay(alignment: .leading) { Rectangle().fill(read ? Color.secondary.opacity(0.5) : AgentState.blocked.color).frame(width: 2) }
        .opacity(read ? 0.55 : 1)
        .padding(.top, 4)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(read ? "agent-ask-read" : "agent-ask")
    }
}

/// One of the reader's tags. An answer sheet is the one the captain acts on, so it takes the accent colour.
struct AskTag: View {
    let text: String

    var body: some View {
        let sheet = text.lowercased().hasPrefix("answer sheet")
        Text(text)
            .font(.system(size: 10.5)).lineLimit(1)
            .foregroundStyle(sheet ? AgentState.working.color : Color.secondary)
            .padding(.horizontal, 6).padding(.vertical, 0.5)
            .overlay(Capsule().strokeBorder(sheet ? AgentState.working.color.opacity(0.7) : Color.primary.opacity(0.18), lineWidth: 1))
    }
}

/// Left to right, wrapping to the next line when the next item does not fit.
struct FlowLayout: Layout {
    var spacing: CGFloat = 5
    var rowSpacing: CGFloat = 3

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(width: proposal.width ?? .infinity, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let laid = arrange(width: bounds.width, subviews: subviews)
        for (i, origin) in laid.origins.enumerated() {
            subviews[i].place(at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y), proposal: .unspecified)
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> (size: CGSize, origins: [CGPoint]) {
        var origins: [CGPoint] = []
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width { x = 0; y += rowHeight + rowSpacing; rowHeight = 0 }
            origins.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return (CGSize(width: widest, height: y + rowHeight), origins)
    }
}
