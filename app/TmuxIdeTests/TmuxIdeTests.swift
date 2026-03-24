import XCTest

final class TmuxIdeTests: XCTestCase {
    func testSessionModelDecoding() throws {
        let json = """
        {
            "sessions": [{
                "name": "test-project",
                "dir": "/tmp/test",
                "mission": null,
                "stats": { "totalTasks": 5, "doneTasks": 2, "agents": 3, "activeAgents": 1 },
                "goals": []
            }]
        }
        """
        let data = json.data(using: .utf8)!
        let response = try JSONDecoder().decode(SessionsResponse.self, from: data)
        XCTAssertEqual(response.sessions.count, 1)
        XCTAssertEqual(response.sessions[0].name, "test-project")
        XCTAssertEqual(response.sessions[0].stats.activeAgents, 1)
    }

    func testCanvasWorkspaceCreation() {
        let workspace = CanvasWorkspace(sessionName: "test", columns: [
            CanvasColumn(items: [
                CanvasItem(ref: .terminal(paneId: "%1")),
                CanvasItem(ref: .terminal(paneId: "%2")),
            ]),
            CanvasColumn(items: [
                CanvasItem(ref: .terminal(paneId: "%3")),
            ]),
        ])
        XCTAssertEqual(workspace.columns.count, 2)
        XCTAssertEqual(workspace.columns[0].items.count, 2)
        XCTAssertEqual(workspace.sessionName, "test")
    }

    func testTileRefEquality() {
        XCTAssertEqual(TileRef.terminal(paneId: "%1"), TileRef.terminal(paneId: "%1"))
        XCTAssertNotEqual(TileRef.terminal(paneId: "%1"), TileRef.terminal(paneId: "%2"))
        XCTAssertEqual(TileRef.dashboard, TileRef.dashboard)
    }
}
