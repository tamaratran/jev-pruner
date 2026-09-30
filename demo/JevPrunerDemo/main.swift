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
    static let background = Color(red: 0.975, green: 0.966, blue: 0.943)
    static let panel = Color(red: 0.945, green: 0.932, blue: 0.906)
    static let surface = Color(red: 1.0, green: 0.995, blue: 0.978)
    static let text = Color(red: 0.16, green: 0.21, blue: 0.22)
    static let dim = Color(red: 0.38, green: 0.42, blue: 0.42)
    static let border = Color(red: 0.82, green: 0.83, blue: 0.79)
    static let orange = Color(red: 0.62, green: 0.31, blue: 0.19)
    static let cyan = Color(red: 0.08, green: 0.42, blue: 0.39)
    static let green = Color(red: 0.10, green: 0.39, blue: 0.29)
    static let red = Color(red: 0.68, green: 0.24, blue: 0.20)
    static let amber = Color(red: 0.58, green: 0.36, blue: 0.13)
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
                    Circle().fill(color.opacity(0.65)).frame(width: 9, height: 9)
                }
                HStack(spacing: 8) {
                    Text("storefront")
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                    Text("/ terminal")
                        .font(Style.mono(11)).foregroundStyle(Style.dim)
                }
                .padding(.leading, 14)
                Spacer()
                tokenMeter
            }
            .padding(.horizontal, 24).frame(height: 60).background(Style.panel)
            Rectangle().fill(Style.border).frame(height: 1)
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 10) {
                    Text(">").foregroundStyle(Style.orange)
                    Text("Install the dependencies.")
                    Spacer()
                }
                .font(.system(size: 16, weight: .medium, design: .rounded))
                .frame(height: 35)
                .padding(.horizontal, 12)
                .background(RoundedRectangle(cornerRadius: 8).fill(Style.surface))
                HStack(spacing: 9) {
                    if time < Timing.installEnd {
                        Circle().trim(from: 0.1, to: 0.85)
                            .stroke(Style.dim, lineWidth: 1.5)
                            .frame(width: 9, height: 9)
                            .rotationEffect(.degrees(time * 180))
                    } else {
                        Circle().fill(Style.green).frame(width: 9, height: 9)
                    }
                    Text("BASH")
                        .font(Style.mono(10)).bold().foregroundStyle(Style.dim)
                        .padding(.horizontal, 6).padding(.vertical, 4)
                        .background(RoundedRectangle(cornerRadius: 4).fill(Style.panel))
                    Text("npm install").font(Style.mono(16)).fontWeight(.semibold)
                    Spacer()
                    Text(time < Timing.installEnd ? "RUNNING" : done ? "DELIVERED" : "INTERCEPTED")
                        .font(Style.mono(10))
                        .foregroundStyle(done ? Style.green : Style.dim)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(Capsule().fill(done ? Style.green.opacity(0.08) : Style.panel))
                }
                .font(Style.mono(16)).frame(height: 28)
                output
                    .frame(height: 405, alignment: .top)
                    .clipped()
                Spacer(minLength: 0)
                status
                    .frame(height: 52, alignment: .leading)
            }
            .padding(24)
        }
        .frame(width: Style.width, height: Style.height)
        .background(Style.background)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Style.border))
    }

    private var tokenMeter: some View {
        let color = done ? Style.green : tokens > 0 ? Style.amber : Style.dim
        return HStack(spacing: 10) {
            Text("OUTPUT TOKENS").font(Style.mono(10)).foregroundStyle(Style.dim)
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 3).fill(Style.border)
                RoundedRectangle(cornerRadius: 3).fill(color)
                    .frame(width: tokens == 0 ? 0 : max(3, 100 * Double(tokens) / Double(InstallExample.tokens(InstallExample.log))))
            }
            .frame(width: 100, height: 4)
            Text("~" + tokens.formatted())
                .font(Style.mono(18)).bold().monospacedDigit()
                .foregroundStyle(color)
                .frame(width: 78, alignment: .trailing)
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 9).fill(Style.surface))
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
                    LinearGradient(colors: [.clear, Style.cyan.opacity(0.10)], startPoint: .top, endPoint: .bottom)
                        .frame(height: 24)
                    Rectangle().fill(Style.cyan.opacity(0.65)).frame(height: 1)
                }
                .offset(y: -24 + progress(time, from: Timing.scanStart, to: Timing.scanEnd) * 377)
            }
        }
    }

    private func line(_ row: OutputRow, scanned: Bool) -> some View {
        let color = row.keep ? Style.green : Style.red
        return HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 1)
                .fill(scanned ? color : Style.border)
                .frame(width: 2, height: 15)
            Text(row.text).foregroundStyle(scanned && row.keep ? Style.text : Style.dim)
                .lineLimit(1)
            Spacer(minLength: 0)
            Text(row.reason)
                .font(Style.mono(9)).bold().foregroundStyle(color)
                .padding(.horizontal, 6).padding(.vertical, 3)
                .background(Capsule().fill(color.opacity(0.08)))
                .opacity(scanned ? 1 : 0)
        }
        .font(Style.mono(13))
        .padding(.horizontal, 9)
        .frame(height: 27)
        .background(RoundedRectangle(cornerRadius: 5).fill(scanned ? color.opacity(row.keep ? 0.06 : 0.035) : .clear))
    }

    private var archive: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                Image(systemName: "archivebox.fill").foregroundStyle(Style.cyan)
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
        .background(RoundedRectangle(cornerRadius: 10).fill(Style.surface))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Style.border))
        .shadow(color: Style.text.opacity(0.035), radius: 8, y: 2)
    }

    private var status: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                Image(systemName: done ? "checkmark.circle.fill" : "circle.dotted")
                    .font(.system(size: 12)).foregroundStyle(done ? Style.green : Style.cyan)
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
