import Foundation

actor CommandCenterClient {
    let target: ConnectionTarget
    private let session: URLSession

    init(target: ConnectionTarget) {
        self.target = target
        self.session = URLSession(configuration: .default)
    }

    // MARK: - Session Discovery

    func fetchSessions() async throws -> [SessionOverview] {
        let url = target.baseURL.appendingPathComponent("api/sessions")
        let (data, _) = try await session.data(from: url)
        let response = try JSONDecoder().decode(SessionsResponse.self, from: data)
        return response.sessions
    }

    func fetchProjectDetail(name: String) async throws -> ProjectDetail {
        let url = target.baseURL.appendingPathComponent("api/project/\(name)")
        let (data, _) = try await session.data(from: url)
        return try JSONDecoder().decode(ProjectDetail.self, from: data)
    }

    func fetchPanes(session sessionName: String) async throws -> [TmuxIdePane] {
        let url = target.baseURL.appendingPathComponent("api/project/\(sessionName)/panes")
        let (data, _) = try await session.data(from: url)
        let response = try JSONDecoder().decode(PanesResponse.self, from: data)
        return response.panes
    }

    // MARK: - Remote Command Execution

    struct SendResult: Codable {
        let ok: Bool
        let session: String?
        let busyStatus: String?
        struct TargetInfo: Codable {
            let paneId: String
            let name: String?
            let title: String
            let role: String?
        }
        let target: TargetInfo?
    }

    struct SessionActionResult: Codable {
        let ok: Bool?
        let session: String?
        let status: String?
        let error: String?
    }

    /// Send a message to a pane by name/title/role/ID.
    func sendToPane(
        session sessionName: String,
        target: String,
        message: String,
        noEnter: Bool = false
    ) async throws -> SendResult {
        let url = self.target.baseURL.appendingPathComponent("api/project/\(sessionName)/send")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        struct SendBody: Encodable {
            let target: String
            let message: String
            let noEnter: Bool?
        }
        let body = SendBody(target: target, message: message, noEnter: noEnter ? true : nil)
        request.httpBody = try JSONEncoder().encode(body)

        let (data, _) = try await session.data(for: request)
        return try JSONDecoder().decode(SendResult.self, from: data)
    }

    /// Launch a tmux-ide session on the remote host.
    func launchSession(name: String) async throws -> SessionActionResult {
        let url = target.baseURL.appendingPathComponent("api/project/\(name)/launch")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        request.timeoutInterval = 35

        let (data, _) = try await session.data(for: request)
        return try JSONDecoder().decode(SessionActionResult.self, from: data)
    }

    /// Stop a tmux-ide session on the remote host.
    func stopSession(name: String) async throws -> SessionActionResult {
        let url = target.baseURL.appendingPathComponent("api/project/\(name)/stop")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)

        let (data, _) = try await session.data(for: request)
        return try JSONDecoder().decode(SessionActionResult.self, from: data)
    }

    // MARK: - Workflow (Checkpoints & Reviews)

    func fetchCheckpoints(session sessionName: String, taskId: String? = nil) async throws -> [Checkpoint] {
        var url = target.baseURL.appendingPathComponent("api/project/\(sessionName)/checkpoints")
        if let taskId {
            url = URL(string: url.absoluteString + "?task=\(taskId)")!
        }
        let (data, _) = try await session.data(from: url)
        return try JSONDecoder().decode(CheckpointsResponse.self, from: data).checkpoints
    }

    func fetchReviews(session sessionName: String, taskId: String? = nil) async throws -> [ReviewRequest] {
        var url = target.baseURL.appendingPathComponent("api/project/\(sessionName)/reviews")
        if let taskId {
            url = URL(string: url.absoluteString + "?task=\(taskId)")!
        }
        let (data, _) = try await session.data(from: url)
        return try JSONDecoder().decode(ReviewsResponse.self, from: data).reviews
    }

    func updateCheckpoint(session sessionName: String, id: String, status: String, reviewedBy: String) async throws -> Checkpoint {
        let url = target.baseURL.appendingPathComponent("api/project/\(sessionName)/checkpoints/\(id)")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: String] = ["status": status, "reviewedBy": reviewedBy]
        request.httpBody = try JSONEncoder().encode(body)
        let (data, _) = try await session.data(for: request)
        struct Wrapper: Codable { let checkpoint: Checkpoint }
        return try JSONDecoder().decode(Wrapper.self, from: data).checkpoint
    }

    func updateReview(session sessionName: String, id: String, status: String) async throws -> ReviewRequest {
        let url = target.baseURL.appendingPathComponent("api/project/\(sessionName)/reviews/\(id)")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: String] = ["status": status]
        request.httpBody = try JSONEncoder().encode(body)
        let (data, _) = try await session.data(for: request)
        struct Wrapper: Codable { let review: ReviewRequest }
        return try JSONDecoder().decode(Wrapper.self, from: data).review
    }

    // MARK: - Health Check

    func isReachable() async -> Bool {
        let url = target.baseURL
        do {
            let (_, response) = try await session.data(from: url)
            if let http = response as? HTTPURLResponse {
                return http.statusCode == 200
            }
            return false
        } catch {
            return false
        }
    }
}
