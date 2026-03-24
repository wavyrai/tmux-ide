import Foundation

struct FileSystemPaths {
    let appSupportDirectory: URL
    let settingsFile: URL
    let connectionsFile: URL
    let runDirectory: URL
    let layoutsDirectory: URL

    init(fileManager: FileManager = .default) throws {
        let appSupport = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        appSupportDirectory = appSupport.appendingPathComponent("tmux-ide-app", isDirectory: true)
        settingsFile = appSupportDirectory.appendingPathComponent("settings.json", isDirectory: false)
        connectionsFile = appSupportDirectory.appendingPathComponent("connections.json", isDirectory: false)
        runDirectory = appSupportDirectory.appendingPathComponent("run", isDirectory: true)
        layoutsDirectory = appSupportDirectory.appendingPathComponent("layouts", isDirectory: true)
    }

    init(appSupportDirectory: URL, settingsFile: URL, connectionsFile: URL, runDirectory: URL, layoutsDirectory: URL) {
        self.appSupportDirectory = appSupportDirectory
        self.settingsFile = settingsFile
        self.connectionsFile = connectionsFile
        self.runDirectory = runDirectory
        self.layoutsDirectory = layoutsDirectory
    }

    func ensureDirectories(fileManager: FileManager = .default) throws {
        for dir in [appSupportDirectory, runDirectory, layoutsDirectory] {
            if !fileManager.fileExists(atPath: dir.path) {
                try fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
            }
        }
    }
}

enum BootstrapCoordinator {
    static func makePaths(fileManager: FileManager = .default) throws -> FileSystemPaths {
        let paths = try FileSystemPaths(fileManager: fileManager)
        try paths.ensureDirectories(fileManager: fileManager)
        return paths
    }
}
