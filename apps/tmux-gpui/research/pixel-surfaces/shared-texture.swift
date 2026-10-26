// Opt-in feasibility fixture, not an app transport. Never opens a personal session.
// A parent harness owns the private file and pipes; each frame needs a GPU ACK
// before the producer can modify shared bytes. No global IOSurface IDs are used.
import Darwin
import Foundation
import Metal

enum ProbeError: Error { case invalid(String) }
func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw ProbeError.invalid(message) }
}
let width = 1920
let height = 1200
let rowBytes = width * 4
let frameBytes = rowBytes * height
let pageSize = Int(getpagesize())
let mappedBytes = ((frameBytes + pageSize - 1) / pageSize) * pageSize
func emit(_ message: String) {
    FileHandle.standardOutput.write(Data((message + "\n").utf8))
}
func message() throws -> Int {
    // Fixture commands are bounded numeric counters, never terminal content.
    var bytes = [UInt8]()
    while true {
        let byte = FileHandle.standardInput.readData(ofLength: 1)
        try require(!byte.isEmpty, "unexpected command EOF")
        if byte[0] == 10 { break }
        try require(bytes.count < 16, "command too long")
        bytes.append(byte[0])
    }
    guard let value = Int(String(decoding: bytes, as: UTF8.self)) else {
        throw ProbeError.invalid("invalid counter")
    }
    return value
}
func run() throws {
    try require(CommandLine.arguments.count == 4, "usage: producer|consumer PRIVATE_FILE FRAMES")
    let producer = CommandLine.arguments[1] == "producer"
    try require(producer || CommandLine.arguments[1] == "consumer", "invalid mode")
    guard let frames = Int(CommandLine.arguments[3]), (1...120).contains(frames) else {
        throw ProbeError.invalid("invalid frame count")
    }
    let flags = O_RDWR | O_NOFOLLOW | O_CLOEXEC | (producer ? O_CREAT | O_EXCL : 0)
    let fd = open(CommandLine.arguments[2], flags, mode_t(0o600))
    try require(fd >= 0, "cannot open private mapping")
    defer { close(fd) }
    if producer { try require(ftruncate(fd, off_t(mappedBytes)) == 0, "cannot size mapping") }
    var info = stat()
    try require(fstat(fd, &info) == 0 && info.st_uid == getuid()
        && info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG)
        && info.st_mode & 0o777 == 0o600 && info.st_nlink == 1
        && info.st_size == mappedBytes, "unexpected mapping metadata")
    guard let pointer = mmap(nil, mappedBytes, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0),
          pointer != MAP_FAILED else { throw ProbeError.invalid("mmap failed") }
    // The mapping outlives all Metal resources and completed GPU commands below.
    defer { munmap(pointer, mappedBytes) }
    if producer {
        emit("ready")
        for frame in 1...frames {
            pointer.assumingMemoryBound(to: UInt8.self).update(repeating: UInt8(frame), count: frameBytes)
            emit(String(frame))
            try require(try message() == frame, "wrong completion acknowledgment")
        }
        return
    }
    guard let device = MTLCreateSystemDefaultDevice(), device.hasUnifiedMemory,
          let buffer = device.makeBuffer(bytesNoCopy: pointer, length: mappedBytes,
              options: .storageModeShared, deallocator: nil),
          let queue = device.makeCommandQueue(),
          let sums = device.makeBuffer(length: height * MemoryLayout<UInt32>.size,
              options: .storageModeShared) else { throw ProbeError.invalid("shared Metal buffer unavailable") }
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Uint,
        width: width, height: height, mipmapped: false)
    descriptor.storageMode = .shared
    descriptor.usage = .shaderRead
    guard let texture = buffer.makeTexture(descriptor: descriptor, offset: 0, bytesPerRow: rowBytes) else {
        throw ProbeError.invalid("shared texture unavailable")
    }
    let shader = """
    #include <metal_stdlib>
    using namespace metal;
    kernel void rows(texture2d<uint, access::read> image [[texture(0)]],
                     device uint *sums [[buffer(0)]], uint y [[thread_position_in_grid]]) {
        if (y >= image.get_height()) return;
        uint sum = 0;
        for (uint x = 0; x < image.get_width(); ++x) {
            uint4 pixel = image.read(uint2(x,y));
            sum += pixel.r + pixel.g + pixel.b + pixel.a;
        }
        sums[y] = sum;
    }
    """
    let library = try device.makeLibrary(source: shader, options: nil)
    guard let function = library.makeFunction(name: "rows") else { throw ProbeError.invalid("shader absent") }
    let pipeline = try device.makeComputePipelineState(function: function)
    emit("ready")
    for frame in 1...frames {
        try require(try message() == frame, "out-of-order frame")
        guard let command = queue.makeCommandBuffer(), let encoder = command.makeComputeCommandEncoder() else {
            throw ProbeError.invalid("GPU command unavailable")
        }
        encoder.setComputePipelineState(pipeline)
        encoder.setTexture(texture, index: 0)
        encoder.setBuffer(sums, offset: 0, index: 0)
        encoder.dispatchThreads(MTLSize(width: height, height: 1, depth: 1),
            threadsPerThreadgroup: MTLSize(width: min(64, pipeline.maxTotalThreadsPerThreadgroup), height: 1, depth: 1))
        encoder.endEncoding()
        command.commit()
        command.waitUntilCompleted()
        try require(command.status == .completed, "GPU command failed")
        let values = sums.contents().assumingMemoryBound(to: UInt32.self)
        for row in 0..<height {
            try require(values[row] == UInt32(width * 4 * frame), "GPU read incorrect shared pixels")
        }
        // The next write cannot begin until this GPU read has completed.
        emit(String(frame))
    }
}
do { try run() } catch {
    FileHandle.standardError.write(Data("Shared texture probe failed: \(error)\n".utf8))
    exit(1)
}
