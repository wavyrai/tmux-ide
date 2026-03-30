// Based on VibeTunnel (MIT) — github.com/amantus-ai/vibetunnel
import SwiftUI

/// Focus targets for keyboard navigation in the menu bar panel.
enum MenuFocusField: Hashable {
    case sessionRow(String)
    case newSessionButton
    case stopSessionButton
    case dashboardButton
    case settingsButton
}

/// Bottom quick actions: launch IDE, stop session, dashboard, settings.
struct MenuActionBar: View {
    let onNewSession: () -> Void
    let onStopSession: () -> Void
    let onOpenDashboard: () -> Void
    let onSettings: () -> Void

    @Binding var focusedField: MenuFocusField?
    let hasStartedKeyboardNavigation: Bool

    @Environment(\.colorScheme)
    private var colorScheme

    @State private var hoverNew = false
    @State private var hoverStop = false
    @State private var hoverDashboard = false
    @State private var hoverSettings = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                actionButton(
                    title: "New Session",
                    systemImage: "plus.circle",
                    isHovered: self.$hoverNew,
                    focus: .newSessionButton,
                    role: .primary,
                    action: self.onNewSession)
                actionButton(
                    title: "Stop Session",
                    systemImage: "stop.circle",
                    isHovered: self.$hoverStop,
                    focus: .stopSessionButton,
                    role: .destructive,
                    action: self.onStopSession)
            }
            HStack(spacing: 8) {
                actionButton(
                    title: "Open Dashboard",
                    systemImage: "safari",
                    isHovered: self.$hoverDashboard,
                    focus: .dashboardButton,
                    role: .standard,
                    action: self.onOpenDashboard)
                actionButton(
                    title: "Settings",
                    systemImage: "gearshape",
                    isHovered: self.$hoverSettings,
                    focus: .settingsButton,
                    role: .standard,
                    action: self.onSettings)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 12)
    }

    private enum ButtonRole {
        case primary
        case destructive
        case standard
    }

    private func actionButton(
        title: String,
        systemImage: String,
        isHovered: Binding<Bool>,
        focus: MenuFocusField,
        role: ButtonRole,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action, label: {
            Label(title, systemImage: systemImage)
                .font(.system(size: 12))
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .center)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(
                            isHovered.wrappedValue
                                ? AppColors.Fallback.controlBackground(for: self.colorScheme)
                                    .opacity(self.colorScheme == .light ? 0.6 : 0.7)
                                : Color.clear)
                        .animation(.easeInOut(duration: 0.15), value: isHovered.wrappedValue))
        })
        .buttonStyle(.plain)
        .foregroundColor(
            role == .destructive ? .red : (role == .primary ? .primary : .secondary))
        .onHover { isHovered.wrappedValue = $0 }
        .focusable()
        .overlay(
            RoundedRectangle(cornerRadius: 4)
                .strokeBorder(
                    self.focusedField == focus && self.hasStartedKeyboardNavigation
                        ? AppColors.Fallback.accentHover(for: self.colorScheme).opacity(2)
                        : Color.clear,
                    lineWidth: 1)
                .animation(.easeInOut(duration: 0.15), value: self.focusedField))
    }
}
