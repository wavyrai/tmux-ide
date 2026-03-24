import SwiftUI

struct ConnectionSheet: View {
    @EnvironmentObject var connectionManager: ConnectionManager
    @Environment(\.dismiss) private var dismiss

    @State private var showAddForm = false

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            targetList
            Divider()
            footer
        }
        .frame(width: 440, height: 460)
        .sheet(isPresented: $showAddForm) {
            ConnectionFormSheet(
                tailscaleAvailable: connectionManager.tailscaleAvailable
            ) { target in
                connectionManager.addTarget(target)
                showAddForm = false
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            Text("Connections")
                .font(.headline)
            Spacer()
            if connectionManager.tailscaleAvailable {
                TailscaleBadge()
            }
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
        .padding()
    }

    // MARK: - Target List

    private var targetList: some View {
        List {
            // Configured targets
            Section {
                ForEach(connectionManager.targets) { target in
                    ConnectionTargetRow(
                        target: target,
                        health: connectionManager.health[target.id] ?? .unknown,
                        tailscaleStatus: connectionManager.tailscaleStatus[target.id],
                        tunnelStatus: connectionManager.sshTunnelService.statuses[target.id]
                    )
                    .swipeActions(edge: .trailing) {
                        if !target.isLocal {
                            Button(role: .destructive) {
                                connectionManager.removeTarget(target)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                }
            }

            // Bonjour discovered services
            if !discoveredServices.isEmpty {
                Section("Discovered on Network") {
                    ForEach(discoveredServices) { service in
                        BonjourServiceRow(service: service) {
                            connectionManager.addFromBonjour(service)
                        }
                    }
                }
            }
        }
        .listStyle(.inset)
    }

    /// Bonjour services not already in the target list.
    private var discoveredServices: [BonjourService] {
        connectionManager.bonjourBrowser.services.filter { service in
            !connectionManager.targets.contains { $0.host == service.host && $0.port == service.port }
        }
    }

    // MARK: - Footer

    private var footer: some View {
        HStack {
            Button {
                showAddForm = true
            } label: {
                Label("Add Remote", systemImage: "plus")
            }
            .buttonStyle(.bordered)
            Spacer()
            Button("Done") {
                dismiss()
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(.defaultAction)
        }
        .padding()
    }
}

// MARK: - Tailscale Badge

struct TailscaleBadge: View {
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "lock.shield")
                .font(.caption2)
            Text("Tailscale")
                .font(.caption2)
                .fontWeight(.semibold)
        }
        .foregroundStyle(.blue)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(.blue.opacity(0.1))
        .clipShape(Capsule())
    }
}

// MARK: - Target Row

struct ConnectionTargetRow: View {
    let target: ConnectionTarget
    let health: ConnectionManager.EndpointHealth
    var tailscaleStatus: ConnectionManager.TailscalePeerStatus?
    var tunnelStatus: TunnelStatus?

    var body: some View {
        HStack(spacing: 12) {
            // Status indicator
            Circle()
                .fill(healthColor)
                .frame(width: 10, height: 10)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(target.label)
                        .font(.body)
                        .fontWeight(.medium)
                    methodBadge
                }
                HStack(spacing: 4) {
                    Text("\(target.host):\(target.port)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let ts = tailscaleStatus, let ip = ts.resolvedIP, ip != target.host {
                        Text("\u{2192} \(ip)")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }

                // SSH tunnel status line
                if target.connectionMethod == .sshTunnel, let tunnel = tunnelStatus {
                    HStack(spacing: 4) {
                        Image(systemName: tunnelIcon(tunnel))
                            .font(.system(size: 8))
                        Text(tunnel.displayLabel)
                    }
                    .font(.caption2)
                    .foregroundStyle(tunnelColor(tunnel))
                }
            }

            Spacer()

            Text(healthLabel)
                .font(.caption)
                .foregroundStyle(healthColor)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var methodBadge: some View {
        switch target.connectionMethod {
        case .tailscale:
            HStack(spacing: 2) {
                Image(systemName: "lock.shield")
                    .font(.caption2)
                Text("TS")
                    .font(.caption2)
                    .fontWeight(.semibold)
            }
            .foregroundStyle(.blue)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(.blue.opacity(0.1))
            .clipShape(Capsule())
        case .sshTunnel:
            Text("SSH")
                .font(.caption2)
                .fontWeight(.semibold)
                .foregroundStyle(.orange)
                .padding(.horizontal, 4)
                .padding(.vertical, 1)
                .background(.orange.opacity(0.1))
                .clipShape(Capsule())
        case .directHTTP:
            if target.isLocal {
                Text("LOCAL")
                    .font(.caption2)
                    .fontWeight(.semibold)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(.quaternary)
                    .clipShape(Capsule())
            }
        }
    }

    private var healthColor: Color {
        switch health {
        case .reachable: .green
        case .unreachable: .red
        case .tailscalePeerOffline: .orange
        case .unknown: .gray
        }
    }

    private var healthLabel: String {
        switch health {
        case .reachable: "Connected"
        case .unreachable: "Unreachable"
        case .tailscalePeerOffline: "Peer Offline"
        case .unknown: "Checking..."
        }
    }

    private func tunnelIcon(_ status: TunnelStatus) -> String {
        switch status {
        case .idle: "circle"
        case .connecting: "arrow.triangle.2.circlepath"
        case .connected: "lock.fill"
        case .error: "exclamationmark.triangle.fill"
        }
    }

    private func tunnelColor(_ status: TunnelStatus) -> Color {
        switch status {
        case .idle: .secondary
        case .connecting: .orange
        case .connected: .green
        case .error: .red
        }
    }
}

// MARK: - Bonjour Service Row

struct BonjourServiceRow: View {
    let service: BonjourService
    let onAdd: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "bonjour")
                .foregroundStyle(.blue)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 2) {
                Text(service.name)
                    .font(.body)
                    .fontWeight(.medium)
                Text("\(service.host):\(service.port)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Button("Add") {
                onAdd()
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Add Remote Form

struct ConnectionFormSheet: View {
    var tailscaleAvailable: Bool = false
    let onSave: (ConnectionTarget) -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var label = ""
    @State private var host = ""
    @State private var port = "4000"
    @State private var method: ConnectionMethod = .directHTTP

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Add Remote Endpoint")
                    .font(.headline)
                Spacer()
            }
            .padding()

            Divider()

            // Form fields
            Form {
                TextField("Label", text: $label, prompt: Text("e.g. Mac Mini"))
                    .textFieldStyle(.roundedBorder)
                TextField("Host", text: $host, prompt: Text(hostPlaceholder))
                    .textFieldStyle(.roundedBorder)
                TextField("Port", text: $port, prompt: Text("4000"))
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 100)
                Picker("Method", selection: $method) {
                    ForEach(ConnectionMethod.allCases, id: \.self) { m in
                        HStack {
                            Text(m.displayName)
                            if m == .tailscale && !tailscaleAvailable {
                                Text("(CLI not found)")
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .tag(m)
                    }
                }

                if method == .sshTunnel {
                    Label("Uses your ~/.ssh/config for auth. Host can be an SSH alias (e.g. \"mini\").",
                          systemImage: "terminal")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if method == .tailscale {
                    if tailscaleAvailable {
                        Label("Tailscale provides direct encrypted connectivity. No tunnel needed.",
                              systemImage: "checkmark.shield")
                            .font(.caption)
                            .foregroundStyle(.green)
                    } else {
                        Label("Install Tailscale CLI: brew install tailscale",
                              systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }
            }
            .formStyle(.grouped)

            Divider()

            // Actions
            HStack {
                Button("Cancel") {
                    dismiss()
                }
                .buttonStyle(.bordered)
                .keyboardShortcut(.cancelAction)
                Spacer()
                Button("Add") {
                    let target = ConnectionTarget(
                        label: label.trimmingCharacters(in: .whitespaces),
                        host: host.trimmingCharacters(in: .whitespaces),
                        port: Int(port) ?? 4000,
                        connectionMethod: method
                    )
                    onSave(target)
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(!isValid)
            }
            .padding()
        }
        .frame(width: 400, height: 380)
    }

    private var hostPlaceholder: String {
        switch method {
        case .tailscale: "e.g. mini or mini.tail12345.ts.net"
        case .sshTunnel: "e.g. user@192.168.1.50"
        case .directHTTP: "e.g. 192.168.1.50"
        }
    }

    private var isValid: Bool {
        !label.trimmingCharacters(in: .whitespaces).isEmpty
            && !host.trimmingCharacters(in: .whitespaces).isEmpty
            && (Int(port) ?? 0) > 0
    }
}
