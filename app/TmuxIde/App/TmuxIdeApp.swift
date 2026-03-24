import SwiftUI

@main
struct TmuxIdeApp: App {
    @StateObject private var coordinator = AppCoordinator()

    var body: some Scene {
        WindowGroup {
            MainWindowView()
                .environmentObject(coordinator)
                .environmentObject(coordinator.discoveryService)
                .environmentObject(coordinator.canvasService)
                .environmentObject(coordinator.connectionManager)
                .frame(minWidth: 800, minHeight: 500)
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
                    coordinator.prepareForTermination()
                }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1400, height: 900)
    }
}
