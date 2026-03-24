import Foundation

// Matches the command-center REST API checkpoint/review shapes

struct Checkpoint: Codable, Identifiable {
    let id: String
    let taskId: String
    let title: String
    let description: String
    let status: String // "pending" | "approved" | "rejected"
    let createdBy: String
    let reviewedBy: String?
    let created: String
    let updated: String
    let diff: String?
    let files: [String]
    let comments: [String]
}

struct ReviewRequest: Codable, Identifiable {
    let id: String
    let taskId: String
    let checkpointId: String?
    let title: String
    let description: String
    let status: String // "open" | "approved" | "changes-requested" | "closed"
    let requestedBy: String
    let reviewer: String?
    let created: String
    let updated: String
    let comments: [ReviewComment]
}

struct ReviewComment: Codable {
    let author: String
    let body: String
    let created: String
}

struct CheckpointsResponse: Codable {
    let checkpoints: [Checkpoint]
}

struct ReviewsResponse: Codable {
    let reviews: [ReviewRequest]
}

struct CheckpointResponse: Codable {
    let checkpoint: Checkpoint
}

struct ReviewResponse: Codable {
    let review: ReviewRequest
}

struct WorkflowActionResponse: Codable {
    let ok: Bool
}
