// Based on VibeTunnel (MIT) — github.com/amantus-ai/vibetunnel
import AppKit
import SwiftUI

/// Main menu view for the tmux-ide menu bar launchpad: sessions, orchestrator, tunnels, quick actions.
struct TmuxIdeMenuView: View {
    @Environment(SessionMonitor.self)
    var sessionMonitor
    @Environment(ServerManager.self)
    var serverManager
    @Environment(\.colorScheme)
    private var colorScheme

    @State private var hoveredSessionId: String?
    @State private var hasStartedKeyboardNavigation = false
    @FocusState private var focusedField: MenuFocusField?

    var body: some View {
        VStack(spacing: 0) {
            header

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    self.runningSessionsSection

                    if let agg = sessionMonitor.orchestratorAggregate {
                        self.orchestratorSection(agg)
                    }

                    if let tunnel = self.activeTunnel {
                        self.tunnelSection(tunnel)
                    }
                }
            }
            .frame(maxHeight: 560)

            Divider()

            MenuActionBar(
                onNewSession: self.launchNewSession,
                onStopSession: self.stopPrimarySession,
                onOpenDashboard: self.openDashboard,
                onSettings: self.openSettings,
                focusedField: Binding(
                    get: { self.focusedField },
                    set: { self.focusedField = $0 }),
                hasStartedKeyboardNavigation: self.hasStartedKeyboardNavigation)
        }
        .frame(width: MenuStyles.menuWidth)
        .background(Color.clear)
        .focusable()
        .focusEffectDisabled()
        .onKeyPress { keyPress in
            if keyPress.key == .tab && !self.hasStartedKeyboardNavigation {
                self.hasStartedKeyboardNavigation = true
                return .ignored
            }
            if keyPress.key == .upArrow || keyPress.key == .downArrow {
                self.hasStartedKeyboardNavigation = true
                return self.handleArrowKeyNavigation(keyPress.key == .upArrow)
            }
            if keyPress.key == .return {
                return self.handleEnterKey()
            }
            return .ignored
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .center, spacing: 8) {
            Image(systemName: serverManager.isRunning ? "circle.fill" : "circle")
                .foregroundColor(serverManager.isRunning ? .green : .secondary)
                .font(.system(size: 8))
            VStack(alignment: .leading, spacing: 2) {
                Text(serverManager.isRunning ? "Daemon running" : "Daemon stopped")
                    .font(.system(size: 12, weight: .semibold))
                if serverManager.isRunning {
                    Text("Command center · port \(serverManager.port)")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if sessionMonitor.orchestratorStatus {
                Text("orch")
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(.blue.opacity(0.2)))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(
            LinearGradient(
                colors: self.colorScheme == .dark ? MenuStyles.headerGradientDark : MenuStyles.headerGradientLight,
                startPoint: .top,
                endPoint: .bottom))
    }

    // MARK: - Sessions

    private var runningSessionsSection: some View {
        Group {
            sectionHeader("Running IDE sessions")
            let rows = self.sortedSessions
            if rows.isEmpty {
                Text("No tmux sessions — use New Session to launch tmux-ide.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 16)
            } else {
                ForEach(rows, id: \.key) { entry in
                    sessionRow(name: entry.key, info: entry.value)
                }
            }
        }
    }

    private func sessionRow(name: String, info: SessionInfo) -> some View {
        Button {
            self.attachSession(name: name)
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Circle()
                        .fill(info.attached ? Color.green : Color.secondary.opacity(0.5))
                        .frame(width: 6, height: 6)
                    Text(name)
                        .font(.system(size: 13, weight: .semibold, design: .monospaced))
                        .foregroundStyle(.primary)
                    Spacer()
                    Text("Attach")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 6) {
                    Label("\(info.paneCount) panes", systemImage: "square.split.2x1")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                    Text("·")
                        .foregroundStyle(.tertiary)
                    Text("\(info.agentPanesIdle) idle / \(info.agentPanesBusy) busy")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                if let mission = info.missionTitle, !mission.isEmpty {
                    Text(mission)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(self.hoveredSessionId == name
                        ? AppColors.Fallback.controlBackground(for: colorScheme).opacity(0.5)
                        : Color.clear))
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            self.hoveredSessionId = hovering ? name : nil
        }
    }

    // MARK: - Orchestrator

    private func orchestratorSection(
        _ agg: (dispatchMode: String, activeTasks: Int, queuedTasks: Int, stalledAgents: Int)
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Orchestrator")
            VStack(alignment: .leading, spacing: 6) {
                LabeledContent("Dispatch mode") {
                    Text(agg.dispatchMode)
                        .font(.system(size: 12, design: .monospaced))
                }
                LabeledContent("Active tasks") {
                    Text("\(agg.activeTasks)")
                        .font(.system(size: 12, design: .monospaced))
                }
                LabeledContent("Queued tasks") {
                    Text("\(agg.queuedTasks)")
                        .font(.system(size: 12, design: .monospaced))
                }
                LabeledContent("Stalled agents") {
                    Text("\(agg.stalledAgents)")
                        .font(.system(size: 12, design: .monospaced))
                }
            }
            .font(.system(size: 12))
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
        }
    }

    // MARK: - Tunnel

    private struct TunnelInfo {
        let provider: String
        let url: String
    }

    private var activeTunnel: TunnelInfo? {
        let ngrok = NgrokService.shared
        if ngrok.isActive, let u = ngrok.publicUrl, !u.isEmpty {
            return TunnelInfo(provider: "ngrok", url: u)
        }
        let cf = CloudflareService.shared
        if cf.isRunning, let u = cf.publicUrl, !u.isEmpty {
            return TunnelInfo(provider: "Cloudflare", url: u)
        }
        return nil
    }

    private func tunnelSection(_ tunnel: TunnelInfo) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Tunnel")
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(tunnel.provider)
                        .font(.system(size: 12, weight: .semibold))
                    Text(tunnel.url)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(tunnel.url, forType: .string)
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .help("Copy URL")
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
        }
    }

    // MARK: - Chrome

    private func sectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 6)
    }

    // MARK: - Data

    private var sortedSessions: [(key: String, value: SessionInfo)] {
        self.sessionMonitor.sessions
            .filter { $0.value.isRunning }
            .sorted { $0.key.localizedCaseInsensitiveCompare($1.key) == .orderedAscending }
    }

    // MARK: - Actions

    private func attachSession(name: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["tmux-ide", "attach", name]
        try? process.run()
        self.dismissMenuWindow()
    }

    private func launchNewSession() {
        try? TerminalLauncher.shared.launchCommand("tmux-ide")
        self.dismissMenuWindow()
    }

    private func stopPrimarySession() {
        let rows = self.sortedSessions
        guard let first = rows.first?.value else { return }
        if let dir = first.projectDirectory, !dir.isEmpty {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            p.arguments = ["tmux-ide", "stop"]
            p.currentDirectoryURL = URL(fileURLWithPath: dir)
            try? p.run()
        } else {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            p.arguments = ["tmux", "kill-session", "-t", first.name]
            try? p.run()
        }
        self.dismissMenuWindow()
    }

    private func openDashboard() {
        if let url = serverManager.buildURL(path: "/") {
            NSWorkspace.shared.open(url)
        }
        self.dismissMenuWindow()
    }

    private func openSettings() {
        SettingsOpener.openSettings()
        self.dismissMenuWindow()
    }

    private func dismissMenuWindow() {
        NSApp.keyWindow?.close()
    }

    // MARK: - Keyboard Navigation

    private func handleArrowKeyNavigation(_ isUpArrow: Bool) -> KeyPress.Result {
        let sessions = self.sortedSessions.map(\.key)
        let focusableFields: [MenuFocusField] = sessions.map { .sessionRow($0) } + [
            .newSessionButton, .stopSessionButton, .dashboardButton, .settingsButton,
        ]

        guard let currentFocus = focusedField,
              let currentIndex = focusableFields.firstIndex(of: currentFocus)
        else {
            if !focusableFields.isEmpty {
                self.focusedField = focusableFields[0]
            }
            return .handled
        }

        let newIndex: Int = if isUpArrow {
            currentIndex > 0 ? currentIndex - 1 : focusableFields.count - 1
        } else {
            currentIndex < focusableFields.count - 1 ? currentIndex + 1 : 0
        }

        self.focusedField = focusableFields[newIndex]
        return .handled
    }

    private func handleEnterKey() -> KeyPress.Result {
        guard let currentFocus = focusedField else { return .ignored }

        switch currentFocus {
        case let .sessionRow(sessionId):
            if sessionMonitor.sessions[sessionId] != nil {
                self.attachSession(name: sessionId)
            }
            return .handled

        case .newSessionButton:
            self.launchNewSession()
            return .handled

        case .stopSessionButton:
            self.stopPrimarySession()
            return .handled

        case .dashboardButton:
            self.openDashboard()
            return .handled

        case .settingsButton:
            self.openSettings()
            return .handled
        }
    }
}
