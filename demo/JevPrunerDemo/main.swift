import AppKit
import AVFoundation
import CoreVideo
import ImageIO
import SwiftUI

enum Style {
    static let width = 1100.0
    static let height = 720.0
    static let frameCount = Int(ceil((Timing.done + 1.25) * 30))
    static let duration = Double(frameCount) / 30
    static let background = Color(red: 0.055, green: 0.055, blue: 0.07)
    static let panel = Color(red: 0.09, green: 0.09, blue: 0.11)
    static let text = Color(red: 0.91, green: 0.91, blue: 0.93)
    static let dim = Color(red: 0.53, green: 0.54, blue: 0.60)
    static let border = Color(red: 0.21, green: 0.22, blue: 0.26)
    static let orange = Color(red: 0.87, green: 0.49, blue: 0.28)
    static let cyan = Color(red: 0.40, green: 0.78, blue: 0.95)
    static let green = Color(red: 0.30, green: 0.85, blue: 0.48)
    static let red = Color(red: 0.96, green: 0.34, blue: 0.38)
    static let amber = Color(red: 0.98, green: 0.72, blue: 0.30)
    static func mono(_ size: Double) -> Font { .system(size: size, design: .monospaced) }
}

func progress(_ time: Double, from start: Double, to end: Double) -> Double {
    min(1, max(0, (time - start) / (end - start)))
}

func ease(_ value: Double) -> Double { value * value * (3 - 2 * value) }

struct OutputRow: Identifiable {
    let id: Int
    let text: String
    let appearedAt: Double
    let keep: Bool
    let reason: String
}

struct InstallEvent: Decodable {
    let time: Double
    let text: String
}

struct InstallRecording: Decodable {
    let duration: Double
    let events: [InstallEvent]
}

enum Timing {
    static let maximumOutputGap = 0.35
    static let installStart = 0.25
    static let installEnd = installStart + InstallExample.playbackTime(InstallExample.recording.duration)
    static let scanStart = installEnd + 0.1
    static let scanEnd = scanStart + 1.2
    static let pruneStart = scanEnd + 0.05
    static let pruneEnd = pruneStart + 0.75
    static let done = pruneEnd + 0.15
}

enum InstallExample {
    static let recording: InstallRecording = {
        guard let url = Bundle.main.url(forResource: "npm-install", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let recording = try? JSONDecoder().decode(InstallRecording.self, from: data) else {
            fatalError("Missing or invalid npm-install.json in the demo bundle")
        }
        return recording
    }()
    static let log = recording.events.map(\.text).joined(separator: "\n")
    static let marker = "[trimmed output; full log: .claude/fast-jev-output/bash-<id>.txt]"
    static let previewEvents: [InstallEvent] = {
        let events = recording.events
        return Array(events.prefix(1))
            + Array(events.filter { $0.text.hasPrefix("npm http fetch GET") }.prefix(9))
            + events.filter { $0.text.hasPrefix("added ") || $0.text.hasPrefix("found ") || $0.text == "npm info ok" }
    }()
    static let playbackEvents = recording.events.map {
        InstallEvent(time: playbackTime($0.time), text: $0.text)
    }
    static let rows: [OutputRow] = {
        return previewEvents.enumerated().map { index, event in
            let keep = !event.text.hasPrefix("npm http")
            return OutputRow(id: index, text: event.text, appearedAt: playbackTime(event.time), keep: keep, reason: keep ? "KEEP" : "DROP")
        }
    }()
    static let compactText = rows.filter(\.keep).map(\.text).joined(separator: "\n") + "\n" + marker
    static func tokens(_ text: String) -> Int { Int(ceil(Double(text.count) / 4)) }

    static func playbackTime(_ time: Double) -> Double {
        let checkpoints = [0] + previewEvents.map(\.time) + [recording.duration]
        return zip(checkpoints, checkpoints.dropFirst()).reduce(time) { result, interval in
            let removed = interval.1 - interval.0 - Timing.maximumOutputGap
            guard removed > 0 else { return result }
            return result - removed * progress(time, from: interval.0, to: interval.1)
        }
    }
}

struct DemoFrame: View {
    let time: Double

    private var collapse: Double { ease(progress(time, from: Timing.pruneStart, to: Timing.pruneEnd)) }
    private var done: Bool { time >= Timing.done }
    private var tokens: Int {
        let received = InstallExample.playbackEvents
            .prefix { $0.time <= time - Timing.installStart }
            .map(\.text).joined(separator: "\n")
        let before = InstallExample.tokens(received)
        let after = InstallExample.tokens(InstallExample.compactText)
        return Int((Double(before) * (1 - collapse) + Double(after) * collapse).rounded())
    }
    private var stage: Int {
        time < Timing.installStart ? 0 : time < Timing.scanStart ? 1 : time < Timing.pruneStart ? 2 : time < Timing.done ? 3 : 4
    }

    var body: some View {
        terminal
            .foregroundStyle(Style.text)
    }

    private var terminal: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 7) {
                ForEach([Style.red, Style.amber, Style.green], id: \.self) { color in
                    Circle().fill(color.opacity(0.85)).frame(width: 10, height: 10)
                }
                Text("claude — storefront")
                    .font(Style.mono(12)).foregroundStyle(Style.dim)
                    .padding(.leading, 12)
                Spacer()
                tokenMeter
            }
            .padding(.horizontal, 20).frame(height: 48).background(Style.panel)
            Rectangle().fill(Style.border).frame(height: 1)
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 10) {
                    Text(">").foregroundStyle(Style.orange)
                    Text("Install the dependencies.")
                    Spacer()
                }
                .font(Style.mono(17))
                .frame(height: 35)
                .padding(.horizontal, 12)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Style.border))
                HStack(spacing: 9) {
                    if time < Timing.installEnd {
                        Circle().trim(from: 0.1, to: 0.85)
                            .stroke(Style.dim, lineWidth: 1.5)
                            .frame(width: 9, height: 9)
                            .rotationEffect(.degrees(time * 180))
                    } else {
                        Circle().fill(Style.green).frame(width: 9, height: 9)
                    }
                    Text("Bash").bold()
                    Text("(").foregroundStyle(Style.dim)
                    Text("npm install")
                    Text(")").foregroundStyle(Style.dim)
                    Spacer()
                    Text(time < Timing.installEnd ? "RUNNING" : done ? "DELIVERED" : "INTERCEPTED")
                        .font(Style.mono(10))
                        .foregroundStyle(done ? Style.green : Style.dim)
                }
                .font(Style.mono(16)).frame(height: 28)
                output
                    .frame(height: 405, alignment: .top)
                    .clipped()
                Spacer(minLength: 0)
                status
                    .frame(height: 52, alignment: .leading)
            }
            .padding(20)
        }
        .frame(width: Style.width, height: Style.height)
        .background(Style.background)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Style.border))
    }

    private var tokenMeter: some View {
        let color = done ? Style.green : tokens > 0 ? Style.amber : Style.dim
        return HStack(spacing: 10) {
            Text("Output tokens").font(Style.mono(12)).foregroundStyle(Style.dim)
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 3).fill(Style.border)
                RoundedRectangle(cornerRadius: 3).fill(color)
                    .frame(width: tokens == 0 ? 0 : max(3, 120 * Double(tokens) / Double(InstallExample.tokens(InstallExample.log))))
            }
            .frame(width: 120, height: 8)
            Text("~" + tokens.formatted())
                .font(Style.mono(18)).bold().monospacedDigit()
                .foregroundStyle(color)
                .frame(width: 78, alignment: .trailing)
        }
    }

    private var output: some View {
        ZStack(alignment: .topLeading) {
            if time >= Timing.installStart {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(InstallExample.rows.filter { $0.appearedAt <= time - Timing.installStart }) { row in
                        let remove = row.keep ? 0 : collapse
                        let scanned = time >= Timing.scanStart + Double(row.id) * (Timing.scanEnd - Timing.scanStart) / Double(InstallExample.rows.count)
                        line(row, scanned: scanned)
                            .opacity(1 - remove)
                            .offset(x: remove * 30)
                            .frame(height: 29 * (1 - remove), alignment: .top)
                            .clipped()
                        if row.id == 0 {
                            Text("  ⋯ [trimmed output · full log saved]")
                                .font(Style.mono(13))
                                .foregroundStyle(Style.dim)
                                .frame(height: 25 * collapse, alignment: .leading)
                                .opacity(collapse)
                                .clipped()
                        }
                    }
                    if time >= Timing.pruneEnd {
                        archive
                            .padding(.top, 18)
                            .opacity(ease(progress(time, from: Timing.pruneEnd, to: Timing.done)))
                    }
                }
            }
            if time >= Timing.scanStart && time <= Timing.scanEnd {
                VStack(spacing: 0) {
                    LinearGradient(colors: [.clear, Style.cyan.opacity(0.20)], startPoint: .top, endPoint: .bottom)
                        .frame(height: 24)
                    Rectangle().fill(Style.cyan).frame(height: 2)
                        .shadow(color: Style.cyan.opacity(0.8), radius: 10)
                }
                .offset(y: -24 + progress(time, from: Timing.scanStart, to: Timing.scanEnd) * 377)
            }
        }
    }

    private func line(_ row: OutputRow, scanned: Bool) -> some View {
        let color = row.keep ? Style.green : Style.red
        return HStack(spacing: 10) {
            Text("⎿").foregroundStyle(Style.dim)
            Text(row.text).foregroundStyle(scanned && row.keep ? Style.text : Style.dim)
                .lineLimit(1)
            Spacer(minLength: 0)
            Text(scanned ? row.reason : "")
                .font(Style.mono(10)).bold().foregroundStyle(color)
        }
        .font(Style.mono(12))
        .padding(.horizontal, 9)
        .frame(height: 27)
        .background(RoundedRectangle(cornerRadius: 4).fill(scanned ? color.opacity(row.keep ? 0.10 : 0.07) : .clear))
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(scanned ? color.opacity(0.3) : .clear))
    }

    private var archive: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                Image(systemName: "archivebox").foregroundStyle(Style.cyan)
                Text("FULL OUTPUT SAVED").font(Style.mono(11)).bold()
                Spacer()
                Text("READ / GREP").font(Style.mono(10)).foregroundStyle(Style.cyan)
            }
            Text(".claude/fast-jev-output/bash-<id>.txt")
                .font(Style.mono(12)).foregroundStyle(Style.dim)
            Text("Need a detail later? Read the original log.")
                .font(.system(size: 13)).foregroundStyle(Style.dim)
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 8).fill(Style.cyan.opacity(0.045)))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Style.cyan.opacity(0.22)))
    }

    private var status: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                Text(done ? "✓" : "✻").foregroundStyle(done ? Style.green : Style.cyan)
                Text([
                    "Ready to run Bash.",
                    "Installing dependencies…",
                    "Jev Pruner · checking the output…",
                    "Dropping repetitive chunks · kept text stays verbatim",
                    "Pruned. The model receives the compact tool result."
                ][stage])
                .font(Style.mono(12)).foregroundStyle(done ? Style.green : Style.cyan)
            }
            HStack {
                Text("Recorded output · shortened pauses · illustrative pruning · estimated tokens")
                Spacer()
                Text("Space to replay")
            }
            .font(Style.mono(11)).foregroundStyle(Style.dim)
        }
    }
}

struct DemoPlayer: View {
    @State private var start = Date()
    @State private var keyMonitor: NSObjectProtocol?

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
            DemoFrame(time: min(Style.duration, max(0, context.date.timeIntervalSince(start))))
        }
        .onAppear {
            keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                if event.keyCode == 49 {
                    start = Date()
                    return nil
                }
                return event
            } as? NSObjectProtocol
        }
        .onDisappear {
            if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        }
    }
}

enum ExportError: Error {
    case invalidArguments
    case cannotRender
    case cannotCreateBuffer
    case cannotWriteFrame
    case cannotCreateImage
    case cannotAddInput
}

@MainActor
enum Export {
    static func image(at time: Double) throws -> CGImage {
        let renderer = ImageRenderer(content: DemoFrame(time: time))
        renderer.scale = 1
        guard let image = renderer.cgImage else { throw ExportError.cannotRender }
        return image
    }

    static func png(at time: Double, to url: URL) throws {
        let image = try image(at: time)
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
            throw ExportError.cannotCreateImage
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw ExportError.cannotCreateImage }
    }

    static func movie(to url: URL) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Int(Style.width),
            AVVideoHeightKey: Int(Style.height),
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 5_000_000,
                AVVideoMaxKeyFrameIntervalKey: 60
            ]
        ])
        input.expectsMediaDataInRealTime = false
        let adapter = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
            kCVPixelBufferWidthKey as String: Int(Style.width),
            kCVPixelBufferHeightKey as String: Int(Style.height),
            kCVPixelBufferCGImageCompatibilityKey as String: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey as String: true
        ])
        guard writer.canAdd(input) else { throw ExportError.cannotAddInput }
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? ExportError.cannotWriteFrame }
        writer.startSession(atSourceTime: .zero)
        do {
            let frameCount = Style.frameCount
            for frame in 0..<frameCount {
                while !input.isReadyForMoreMediaData {
                    guard writer.status == .writing else { throw writer.error ?? ExportError.cannotWriteFrame }
                    try await Task.sleep(for: .milliseconds(5))
                }
                try autoreleasepool {
                    let image = try image(at: Double(frame) / 30)
                    guard let pool = adapter.pixelBufferPool else { throw ExportError.cannotCreateBuffer }
                    var buffer: CVPixelBuffer?
                    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess,
                          let buffer else { throw ExportError.cannotCreateBuffer }
                    CVPixelBufferLockBaseAddress(buffer, [])
                    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
                    guard let context = CGContext(
                        data: CVPixelBufferGetBaseAddress(buffer),
                        width: Int(Style.width), height: Int(Style.height),
                        bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                        space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
                    ) else { throw ExportError.cannotCreateBuffer }
                    context.draw(image, in: CGRect(x: 0, y: 0, width: Style.width, height: Style.height))
                    guard adapter.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 30)) else {
                        throw writer.error ?? ExportError.cannotWriteFrame
                    }
                }
                if frame % 150 == 0 { print("Rendered \(frame)/\(frameCount) frames") }
            }
            input.markAsFinished()
            writer.endSession(atSourceTime: CMTime(seconds: Style.duration, preferredTimescale: 30))
            await writer.finishWriting()
            guard writer.status == .completed else { throw writer.error ?? ExportError.cannotWriteFrame }
        } catch {
            writer.cancelWriting()
            throw error
        }
        print("Exported \(url.path)")
    }
}

@main
@MainActor
enum JevPrunerDemo {
    static func main() {
        let app = NSApplication.shared
        let arguments = Array(CommandLine.arguments.dropFirst())
        if !arguments.isEmpty {
            app.setActivationPolicy(.prohibited)
            Task {
                do {
                    if arguments.count == 2 && arguments[0] == "--export" {
                        try await Export.movie(to: URL(fileURLWithPath: arguments[1]))
                    } else if arguments.count == 3 && arguments[0] == "--frame",
                              let time = Double(arguments[1]), time.isFinite, (0...Style.duration).contains(time) {
                        try Export.png(at: time, to: URL(fileURLWithPath: arguments[2]))
                    } else {
                        throw ExportError.invalidArguments
                    }
                    exit(0)
                } catch {
                    fputs("Demo export failed: \(error)\nUsage: --export movie.mp4 | --frame <0…\(Style.duration)> image.png\n", stderr)
                    exit(1)
                }
            }
            app.run()
            return
        }
        app.setActivationPolicy(.regular)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: Style.width, height: Style.height),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered, defer: false
        )
        window.title = "Jev Pruner — npm install"
        window.contentView = NSHostingView(rootView: DemoPlayer())
        window.center()
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        withExtendedLifetime(window) { app.run() }
    }
}
