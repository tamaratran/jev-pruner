import AppKit
import AVFoundation
import CoreVideo
import ImageIO
import SwiftUI

enum Style {
    static let width = 1100.0
    static let height = 720.0
    static let duration = 5.0
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
    let keep: Bool
    let reason: String
}

enum InstallExample {
    static let log: String = {
        guard let url = Bundle.main.url(forResource: "npm-install", withExtension: "txt"),
              let text = try? String(contentsOf: url, encoding: .utf8) else {
            fatalError("Missing npm-install.txt in the demo bundle")
        }
        return text
    }()
    static let lines = log.components(separatedBy: .newlines)
    static let marker = "[trimmed output; full log: .claude/fast-jev-output/bash-<id>.txt]"
    static let rows: [OutputRow] = {
        let samples = Array(lines.prefix(1))
            + Array(lines.filter { $0.hasPrefix("npm http fetch GET") }.prefix(9))
            + lines.filter { $0.hasPrefix("added ") || $0.hasPrefix("found ") || $0 == "npm info ok" }
        return samples.enumerated().map { index, text in
            let keep = !text.hasPrefix("npm http")
            return OutputRow(id: index, text: text, keep: keep, reason: keep ? "KEEP" : "DROP")
        }
    }()
    static let compactText = rows.filter(\.keep).map(\.text).joined(separator: "\n") + "\n" + marker
    static func tokens(_ text: String) -> Int { Int(ceil(Double(text.count) / 4)) }
}

struct DemoFrame: View {
    let time: Double

    private var flow: Double { progress(time, from: 0.35, to: 1.65) }
    private var revealedLines: Int { Int(Double(InstallExample.lines.count) * flow) }
    private var collapse: Double { ease(progress(time, from: 2.4, to: 3.1)) }
    private var done: Bool { time >= 3.2 }
    private var tokens: Int {
        let before = InstallExample.tokens(InstallExample.lines.prefix(revealedLines).joined(separator: "\n"))
        let after = InstallExample.tokens(InstallExample.compactText)
        return Int((Double(before) * (1 - collapse) + Double(after) * collapse).rounded())
    }
    private var stage: Int {
        time < 0.35 ? 0 : time < 1.75 ? 1 : time < 2.4 ? 2 : time < 3.2 ? 3 : 4
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
                    Circle().fill(Style.green).frame(width: 7, height: 7)
                    Text("Bash").bold()
                    Text("(").foregroundStyle(Style.dim)
                    Text(String("npm install".prefix(Int(11 * progress(time, from: 0.05, to: 0.3)))))
                    Text(")").foregroundStyle(Style.dim)
                    if time < 0.35 {
                        Rectangle().fill(Style.text).frame(width: 8, height: 18)
                            .opacity(Int(time * 3) % 2 == 0 ? 1 : 0)
                    }
                    Spacer()
                    Text(time < 1.65 ? "RUNNING" : done ? "DELIVERED" : "INTERCEPTED")
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
        let color = done ? Style.green : flow > 0.6 ? Style.amber : Style.dim
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
            if time >= 0.35 && time < 1.65 {
                installOutput
            } else if time >= 1.65 {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(InstallExample.rows) { row in
                        let remove = row.keep ? 0 : ease(progress(time, from: 2.4 + Double(row.id) * 0.025, to: 2.78 + Double(row.id) * 0.025))
                        let scanned = time >= 1.75 + Double(row.id) * 0.045
                        line(row, scanned: scanned)
                            .opacity(1 - remove)
                            .offset(x: remove * 130)
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
                    if time >= 2.9 {
                        archive
                            .padding(.top, 18)
                            .opacity(ease(progress(time, from: 2.9, to: 3.2)))
                            .offset(y: 12 * (1 - ease(progress(time, from: 2.9, to: 3.2))))
                    }
                }
            }
            if time >= 1.75 && time <= 2.35 {
                VStack(spacing: 0) {
                    LinearGradient(colors: [.clear, Style.cyan.opacity(0.20)], startPoint: .top, endPoint: .bottom)
                        .frame(height: 24)
                    Rectangle().fill(Style.cyan).frame(height: 2)
                        .shadow(color: Style.cyan.opacity(0.8), radius: 10)
                }
                .offset(y: -24 + progress(time, from: 1.75, to: 2.35) * 377)
            }
        }
    }

    private var installOutput: some View {
        let first = max(0, revealedLines - 14)
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(first..<revealedLines, id: \.self) { index in
                Text(InstallExample.lines[index])
                    .font(Style.mono(12))
                    .foregroundStyle(Style.dim)
                    .lineLimit(1)
                    .frame(height: 27, alignment: .leading)
            }
        }
        .frame(height: 405, alignment: .top)
        .clipped()
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
                    "Collecting the tool result…",
                    "Jev Pruner · checking the output…",
                    "Dropping repetitive chunks · kept text stays verbatim",
                    "Pruned. The model receives the compact tool result."
                ][stage])
                .font(Style.mono(12)).foregroundStyle(done ? Style.green : Style.cyan)
            }
            HStack {
                Text("Scripted demo · estimated tokens")
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
            let frameCount = Int(Style.duration * 30)
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
                    fputs("Demo export failed: \(error)\nUsage: --export movie.mp4 | --frame <0…\(Int(Style.duration))> image.png\n", stderr)
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
