import SwiftUI

// MARK: - Command Action

struct CommandAction: Identifiable {
    let id: String
    let title: String
    let subtitle: String
    let icon: String
    var shortcut: String?
    let isEnabled: Bool
    let handler: () -> Void

    init(
        id: String,
        title: String,
        subtitle: String = "",
        icon: String = "command",
        shortcut: String? = nil,
        isEnabled: Bool = true,
        handler: @escaping () -> Void
    ) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.icon = icon
        self.shortcut = shortcut
        self.isEnabled = isEnabled
        self.handler = handler
    }
}

// MARK: - Fuzzy Match

private enum FuzzyMatch {
    /// Case-insensitive substring match.
    static func matches(query: String, text: String) -> Bool {
        let lower = text.lowercased()
        var searchIndex = lower.startIndex
        for char in query.lowercased() {
            guard let found = lower[searchIndex...].firstIndex(of: char) else { return false }
            searchIndex = lower.index(after: found)
        }
        return true
    }

    /// Score: prefer prefix matches and consecutive matches.
    static func score(query: String, text: String) -> Int {
        let lower = text.lowercased()
        let q = query.lowercased()
        var score = 0

        // Prefix bonus
        if lower.hasPrefix(q) { score += 100 }
        // Substring bonus
        if lower.contains(q) { score += 50 }

        // Consecutive character bonus
        var searchIndex = lower.startIndex
        var consecutive = 0
        for char in q {
            guard let found = lower[searchIndex...].firstIndex(of: char) else { break }
            if found == searchIndex || (searchIndex != lower.startIndex && found == lower.index(after: searchIndex)) {
                consecutive += 1
            }
            searchIndex = lower.index(after: found)
        }
        score += consecutive * 10

        // Shorter text gets a small bonus (more specific match)
        score += max(0, 50 - text.count)

        return score
    }

    /// Return an AttributedString with matching characters bolded.
    static func highlight(query: String, in text: String) -> AttributedString {
        var result = AttributedString(text)
        let lower = text.lowercased()
        let q = query.lowercased()
        guard !q.isEmpty else { return result }

        var searchIndex = lower.startIndex
        for char in q {
            guard let found = lower[searchIndex...].firstIndex(of: char) else { break }
            let offset = lower.distance(from: lower.startIndex, to: found)
            let attrIndex = result.index(result.startIndex, offsetByCharacters: offset)
            let nextAttrIndex = result.index(attrIndex, offsetByCharacters: 1)
            result[attrIndex..<nextAttrIndex].font = .system(.callout, weight: .bold)
            result[attrIndex..<nextAttrIndex].foregroundColor = .purple
            searchIndex = lower.index(after: found)
        }
        return result
    }
}

// MARK: - Command Palette Overlay

struct CommandPaletteOverlay: View {
    @Binding var isPresented: Bool
    let actions: [CommandAction]

    @FocusState private var queryFocused: Bool
    @State private var query = ""
    @State private var selectedIndex = 0
    @Environment(\.themeColors) private var themeColors

    var body: some View {
        ZStack {
            // Backdrop
            Rectangle()
                .fill(.ultraThinMaterial)
                .ignoresSafeArea()
                .onTapGesture { dismiss() }

            VStack(spacing: 0) {
                // Search field
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(.callout)
                        .foregroundStyle(.tertiary)

                    TextField("Search commands...", text: $query)
                        .textFieldStyle(.plain)
                        .font(.body)
                        .focused($queryFocused)
                        .onSubmit { executeSelected() }
                        .onChange(of: query) { _, _ in selectedIndex = 0 }
                }
                .padding(12)
                .background(themeColors.surface1)

                Divider()

                // Results
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 2) {
                            ForEach(
                                Array(filteredActions.prefix(12).enumerated()),
                                id: \.element.id
                            ) { index, action in
                                paletteRow(action: action, isSelected: index == selectedIndex)
                                    .id(action.id)
                                    .onTapGesture {
                                        guard action.isEnabled else { return }
                                        selectedIndex = index
                                        executeSelected()
                                    }
                            }
                        }
                        .padding(6)
                    }
                    .frame(maxHeight: 360)
                    .onChange(of: selectedIndex) { _, newValue in
                        if let action = filteredActions.prefix(12).dropFirst(newValue).first {
                            proxy.scrollTo(action.id, anchor: .center)
                        }
                    }
                }

                if filteredActions.isEmpty {
                    Text("No matching commands")
                        .font(.callout)
                        .foregroundStyle(.tertiary)
                        .padding(16)
                }

                Divider()

                // Footer with keyboard hints
                HStack(spacing: 16) {
                    keyHint("↑↓", label: "navigate")
                    keyHint("↵", label: "run")
                    keyHint("esc", label: "close")
                    Spacer()
                }
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(themeColors.surface0)
            }
            .frame(width: 520)
            .background(
                themeColors.surface0,
                in: RoundedRectangle(cornerRadius: 12)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(Color.gray.opacity(0.3), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.5), radius: 30, y: 10)
            .padding(.top, 60)
            .frame(maxHeight: .infinity, alignment: .top)
        }
        .onAppear { queryFocused = true }
        .onKeyPress(.escape) { dismiss(); return .handled }
        .onKeyPress(.downArrow) { moveSelection(1); return .handled }
        .onKeyPress(.upArrow) { moveSelection(-1); return .handled }
    }

    // MARK: - Row

    @ViewBuilder
    private func paletteRow(action: CommandAction, isSelected: Bool) -> some View {
        HStack(spacing: 10) {
            Image(systemName: action.icon)
                .font(.callout)
                .foregroundStyle(action.isEnabled ? .secondary : .quaternary)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 2) {
                Text(FuzzyMatch.highlight(query: query, in: action.title))
                    .font(.callout)
                    .foregroundStyle(action.isEnabled ? .primary : .tertiary)

                if !action.subtitle.isEmpty {
                    Text(action.subtitle)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 0)

            if let shortcut = action.shortcut {
                Text(shortcut)
                    .font(.caption).monospaced()
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(
                        themeColors.surface2,
                        in: RoundedRectangle(cornerRadius: 4)
                    )
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            isSelected
                ? Color.accentColor.opacity(0.15)
                : Color.clear,
            in: RoundedRectangle(cornerRadius: 6)
        )
        .contentShape(Rectangle())
    }

    // MARK: - Key hint badge

    @ViewBuilder
    private func keyHint(_ key: String, label: String) -> some View {
        HStack(spacing: 4) {
            Text(key)
                .font(.caption).monospaced()
                .padding(.horizontal, 4)
                .padding(.vertical, 2)
                .background(
                    themeColors.surface2,
                    in: RoundedRectangle(cornerRadius: 3)
                )
            Text(label)
                .font(.caption2)
        }
    }

    // MARK: - Logic

    private var filteredActions: [CommandAction] {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else { return actions }
        let searchText = { (action: CommandAction) in
            "\(action.title) \(action.subtitle)".lowercased()
        }
        return actions
            .filter { FuzzyMatch.matches(query: normalized, text: searchText($0)) }
            .sorted {
                FuzzyMatch.score(query: normalized, text: searchText($0))
                    > FuzzyMatch.score(query: normalized, text: searchText($1))
            }
    }

    private func moveSelection(_ delta: Int) {
        let maxIndex = min(filteredActions.count, 12) - 1
        guard maxIndex >= 0 else { return }
        selectedIndex = min(maxIndex, max(0, selectedIndex + delta))
    }

    private func executeSelected() {
        let visible = Array(filteredActions.prefix(12))
        guard selectedIndex < visible.count else { return }
        let action = visible[selectedIndex]
        guard action.isEnabled else { return }
        dismiss()
        DispatchQueue.main.async { action.handler() }
    }

    private func dismiss() {
        isPresented = false
    }
}
