import SwiftUI

struct SettingsView: View {
    var body: some View {
        TabView {
            GeneralSettingsTab()
                .tabItem { Label("General", systemImage: "gear") }

            AppearanceSettingsTab()
                .tabItem { Label("Appearance", systemImage: "paintbrush") }

            ConnectionsSettingsTab()
                .tabItem { Label("Connections", systemImage: "network") }
        }
        .frame(width: 480, height: 400)
    }
}

// MARK: - General Tab

private struct GeneralSettingsTab: View {
    @AppStorage("pollInterval") private var pollInterval: Double = 3.0
    @AppStorage("autoConnectOnLaunch") private var autoConnect: Bool = true
    @AppStorage("showSessionMission") private var showMission: Bool = true
    @AppStorage("commandCenterPort") private var port: Int = 4000
    @AppStorage("tmuxTileWidth") private var tmuxTileWidth: Double = 5120

    var body: some View {
        Form {
            Section("Session Discovery") {
                Toggle("Auto-connect on launch", isOn: $autoConnect)
                    .help("Automatically connect to the local command center when the app starts")

                HStack {
                    Text("Poll interval")
                    Spacer()
                    Text("\(pollInterval, specifier: "%.0f")s")
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                Slider(value: $pollInterval, in: 1...30, step: 1)

                HStack {
                    Text("Command center port")
                    Spacer()
                    TextField("Port", value: $port, format: .number)
                        .frame(width: 80)
                        .textFieldStyle(.roundedBorder)
                        .multilineTextAlignment(.trailing)
                }
            }

            Section("Display") {
                Toggle("Show mission in sidebar", isOn: $showMission)
                    .help("Display the mission title under each session in the sidebar")
            }

            Section("Canvas") {
                HStack {
                    Text("Terminal tile width")
                    Spacer()
                    Text("\(tmuxTileWidth, specifier: "%.0f") pt")
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                Slider(value: $tmuxTileWidth, in: 1000...8000, step: 100)
                    .help("Width of the tmux terminal tile on the canvas. 5120 = Apple 5K display width.")
            }
        }
        .formStyle(.grouped)
        .padding(10)
    }
}

// MARK: - Appearance Tab

private struct AppearanceSettingsTab: View {
    @AppStorage("accentColorHex") private var accentHex: String = "#7c6cf0"
    @AppStorage("sidebarWidth") private var sidebarWidth: Double = 220

    @State private var accentColor: Color = Color(hex: "#7c6cf0")

    var body: some View {
        Form {
            Section("Theme") {
                themePreview

                ColorPicker("Accent color", selection: $accentColor, supportsOpacity: false)
                    .onChange(of: accentColor) { _, newColor in
                        accentHex = newColor.hexString
                    }
            }

            Section("Layout") {
                HStack {
                    Text("Sidebar width")
                    Spacer()
                    Text("\(sidebarWidth, specifier: "%.0f") pt")
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                Slider(value: $sidebarWidth, in: 160...360, step: 10)
            }
        }
        .formStyle(.grouped)
        .padding(10)
        .onAppear {
            accentColor = Color(hex: accentHex)
        }
    }

    @ViewBuilder
    private var themePreview: some View {
        let tc = AppThemeColors.default

        VStack(spacing: 0) {
            // Mock title bar
            HStack(spacing: 6) {
                Circle().fill(.red.opacity(0.8)).frame(width: 8, height: 8)
                Circle().fill(.yellow.opacity(0.8)).frame(width: 8, height: 8)
                Circle().fill(.green.opacity(0.8)).frame(width: 8, height: 8)
                Spacer()
                Text("tmux-ide")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(tc.primaryText)
                Spacer()
                Color.clear.frame(width: 36, height: 8)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(tc.surface0)

            HStack(spacing: 0) {
                // Mock sidebar
                VStack(alignment: .leading, spacing: 4) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(tc.surface1)
                        .frame(height: 20)
                    RoundedRectangle(cornerRadius: 3)
                        .fill(tc.surface0.opacity(0.5))
                        .frame(height: 20)
                    Spacer()
                }
                .padding(6)
                .frame(width: 70)
                .background(tc.sidebarBackground)

                // Mock terminal
                VStack(alignment: .leading, spacing: 3) {
                    Text("$ tmux-ide")
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(tc.primaryText)
                    Text("Session running: 3 panes, 2 agents")
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(tc.secondaryText)
                    HStack(spacing: 4) {
                        Circle().fill(accentColor).frame(width: 6, height: 6)
                        Text("accent")
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundStyle(accentColor)
                    }
                    Spacer()
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(tc.surface0)
            }
            .frame(height: 80)
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.primary.opacity(0.1), lineWidth: 1)
        )
    }
}

// MARK: - Connections Tab

private struct ConnectionsSettingsTab: View {
    @EnvironmentObject var connectionManager: ConnectionManager

    @State private var showAddForm = false

    var body: some View {
        VStack(spacing: 0) {
            // Connection list
            List {
                ForEach(connectionManager.targets) { target in
                    ConnectionRow(
                        target: target,
                        health: connectionManager.health[target.id] ?? .unknown
                    )
                }
                .onDelete { indexSet in
                    for index in indexSet {
                        let target = connectionManager.targets[index]
                        if !target.isLocal {
                            connectionManager.removeTarget(target)
                        }
                    }
                }
            }
            .listStyle(.inset)

            Divider()

            // Bottom toolbar
            HStack {
                Button {
                    showAddForm = true
                } label: {
                    Label("Add Connection", systemImage: "plus")
                }
                .buttonStyle(.borderless)

                Spacer()

                Text("\(connectionManager.targets.count) endpoint\(connectionManager.targets.count == 1 ? "" : "s")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .sheet(isPresented: $showAddForm) {
            AddConnectionForm { target in
                connectionManager.addTarget(target)
                showAddForm = false
            }
        }
    }
}

// MARK: - Connection Row

private struct ConnectionRow: View {
    let target: ConnectionTarget
    let health: ConnectionManager.EndpointHealth

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(healthColor)
                .frame(width: 8, height: 8)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(target.label)
                        .font(.system(size: 12, weight: .medium))
                    if target.isLocal {
                        Text("LOCAL")
                            .font(.system(size: 8, weight: .bold, design: .rounded))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(.quaternary)
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                    }
                }
                Text("\(target.host):\(target.port)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Text(healthLabel)
                .font(.system(size: 10))
                .foregroundStyle(healthColor)
        }
        .padding(.vertical, 2)
    }

    private var healthColor: Color {
        switch health {
        case .reachable: return .green
        case .unreachable: return .red
        case .tailscalePeerOffline: return .orange
        case .unknown: return .gray
        @unknown default: return .gray
        }
    }

    private var healthLabel: String {
        switch health {
        case .reachable: return "Connected"
        case .unreachable: return "Unreachable"
        case .tailscalePeerOffline: return "Peer Offline"
        case .unknown: return "Unknown"
        @unknown default: return "Unknown"
        }
    }
}

// MARK: - Add Connection Form

private struct AddConnectionForm: View {
    @Environment(\.dismiss) private var dismiss

    @State private var label = ""
    @State private var host = ""
    @State private var port = "4000"

    let onAdd: (ConnectionTarget) -> Void

    var body: some View {
        VStack(spacing: 16) {
            Text("Add Connection")
                .font(.headline)

            Form {
                TextField("Label", text: $label, prompt: Text("My Server"))
                TextField("Host", text: $host, prompt: Text("192.168.1.100"))
                TextField("Port", text: $port, prompt: Text("4000"))
            }
            .formStyle(.grouped)

            HStack {
                Button("Cancel") {
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)

                Spacer()

                Button("Add") {
                    let portNum = Int(port) ?? 4000
                    let target = ConnectionTarget(
                        label: label.isEmpty ? host : label,
                        host: host,
                        port: portNum,
                        connectionMethod: .directHTTP,
                        isLocal: false
                    )
                    onAdd(target)
                }
                .keyboardShortcut(.defaultAction)
                .disabled(host.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 340)
    }
}

// MARK: - Color Hex Extension

extension Color {
    var hexString: String {
        guard let components = NSColor(self).usingColorSpace(.sRGB) else {
            return "#7c6cf0"
        }
        let r = Int(components.redComponent * 255)
        let g = Int(components.greenComponent * 255)
        let b = Int(components.blueComponent * 255)
        return String(format: "#%02x%02x%02x", r, g, b)
    }
}
