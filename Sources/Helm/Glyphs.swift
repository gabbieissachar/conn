import SwiftUI
import HelmCore

extension AgentState {
    var symbol: String {
        switch self {
        case .blocked: return "exclamationmark.circle.fill"
        case .done: return "checkmark.circle.fill"
        case .working: return "circle.lefthalf.filled"
        case .idle: return "circle"
        case .unknown: return "questionmark.circle"
        }
    }

    var color: Color {
        switch self {
        case .blocked: return Color(red: 0.93, green: 0.36, blue: 0.20)
        case .done: return Color(red: 0.20, green: 0.62, blue: 0.34)
        case .working: return Color(red: 0.16, green: 0.46, blue: 0.90)
        case .idle: return Color.secondary.opacity(0.75)
        case .unknown: return Color.gray
        }
    }
}

struct StateGlyph: View {
    let state: AgentState
    var size: CGFloat = 13
    var body: some View {
        Image(systemName: state.symbol)
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(state.color)
            .frame(width: size + 4)
            .accessibilityLabel(state.label)
    }
}

struct StateChip: View {
    let state: AgentState
    var body: some View {
        Text(state.label)
            .font(.system(size: 10.5, weight: .semibold))
            .foregroundStyle(state.color)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(state.color.opacity(0.14), in: Capsule())
    }
}
