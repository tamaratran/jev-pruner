import AppKit
import AVFoundation
import CoreVideo
import ImageIO
import SwiftUI

enum Style {
    static let width = 1440.0
    static let height = 900.0
    static let duration = 25.0
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

let outputRows: [OutputRow] = [
    .init(id: 0, text: "npm info using npm@10.8.2", keep: true, reason: "FIRST CHUNK"),
    .init(id: 1, text: "npm http fetch GET 200 registry.npmjs.org/react 42ms", keep: false, reason: "DROP 0.03"),
    .init(id: 2, text: "npm http fetch GET 200 registry.npmjs.org/typescript 38ms", keep: false, reason: "DROP 0.02"),
    .init(id: 3, text: "npm timing idealTree:node_modules/react Completed in 0ms", keep: false, reason: "DROP 0.01"),
    .init(id: 4, text: "npm timing idealTree:node_modules/vite Completed in 1ms", keep: false, reason: "DROP 0.01"),
    .init(id: 5, text: "npm WARN deprecated stable@0.1.8: use native Array#sort", keep: true, reason: "KEEP 0.98"),
    .init(id: 6, text: "npm http fetch GET 200 registry.npmjs.org/esbuild 31ms", keep: false, reason: "DROP 0.04"),
    .init(id: 7, text: "npm timing reify:unpack Completed in 842ms", keep: false, reason: "DROP 0.02"),
    .init(id: 8, text: "npm timing build:link:node_modules/vite Completed in 3ms", keep: false, reason: "DROP 0.01"),
    .init(id: 9, text: "npm timing reify:save Completed in 49ms", keep: false, reason: "DROP 0.03"),
    .init(id: 10, text: "npm timing command:install Completed in 12048ms", keep: false, reason: "DROP 0.02"),
    .init(id: 11, text: "added 1,284 packages, and audited 1,285 packages in 12s", keep: true, reason: "LAST CHUNK"),
    .init(id: 12, text: "found 0 vulnerabilities", keep: true, reason: "LAST CHUNK"),
]

struct DemoFrame: View {
    let time: Double

    private var flow: Double { progress(time, from: 3.2, to: 8.0) }
    private var collapse: Double { ease(progress(time, from: 13.0, to: 16.8)) }
    private var done: Bool { time >= 17.0 }
    private var tokens: Int {
        Int((10_000 * flow * (1 - collapse) + 100 * collapse).rounded())
    }
    private var stage: Int {
        time < 3.2 ? 0 : time < 8.8 ? 1 : time < 13 ? 2 : time < 17 ? 3 : 4
    }
    private var stageTitle: String {
        ["Run the command.", "Here comes the noise.", "Jev finds the signal.",
         "Prune before the model sees it.", "10,000 tokens. Only 100 sent."][stage]
    }
    private var stageDetail: String {
        ["The Bash tool runs normally.",
         "Verbose install logs pile up at the tool-result boundary.",
         "Score output chunks against the conversation and task.",
         "Keep useful chunks verbatim. Save the complete output.",
         "A smaller tool result, with the full log available when needed."][stage]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            header
            HStack(alignment: .top, spacing: 20) {
                terminal
                sidebar
            }
            footer
        }
        .padding(36)
        .frame(width: Style.width, height: Style.height)
        .background(Style.background)
        .foregroundStyle(Style.text)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Text("✻").font(.system(size: 27)).foregroundStyle(Style.orange)
                Text("jev-pruner").font(Style.mono(20)).bold()
                Text("/").foregroundStyle(Style.border).padding(.horizontal, 5)
                Text("CLAUDE CODE PLUGIN").font(Style.mono(12)).foregroundStyle(Style.dim)
                Spacer()
                Text(String(format: "%02d / 05", stage + 1))
                    .font(Style.mono(13)).foregroundStyle(Style.dim)
            }
            Text(stageTitle).font(.system(size: 34, weight: .semibold))
            Text(stageDetail).font(.system(size: 17)).foregroundStyle(Style.dim)
        }
        .frame(height: 116, alignment: .top)
    }

    private var terminal: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 7) {
                ForEach([Style.red, Style.amber, Style.green], id: \.self) { color in
                    Circle().fill(color.opacity(0.85)).frame(width: 10, height: 10)
                }
                Spacer()
                Text("claude — storefront").font(Style.mono(12)).foregroundStyle(Style.dim)
                Spacer()
                Text("Bash").font(Style.mono(11)).foregroundStyle(Style.dim)
            }
            .padding(.horizontal, 20).frame(height: 42).background(Style.panel)
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 10) {
                    Text(">").foregroundStyle(Style.orange)
                    Text(String("Install the dependencies.".prefix(Int(26 * progress(time, from: 0.4, to: 1.8)))))
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
                    Text(String("npm install".prefix(Int(11 * progress(time, from: 2.0, to: 3.0)))))
                    Text(")").foregroundStyle(Style.dim)
                    if time < 3.2 {
                        Rectangle().fill(Style.text).frame(width: 8, height: 18)
                            .opacity(Int(time * 3) % 2 == 0 ? 1 : 0)
                    }
                    Spacer()
                    Text(time < 8 ? "RUNNING" : done ? "DELIVERED" : "INTERCEPTED")
                        .font(Style.mono(10))
                        .foregroundStyle(done ? Style.green : Style.dim)
                }
                .font(Style.mono(16)).frame(height: 28)
                output
                    .frame(height: 405, alignment: .top)
                    .clipped()
                status
                    .frame(height: 52, alignment: .leading)
            }
            .padding(20)
        }
        .frame(width: 992, height: 650)
        .background(Style.panel.opacity(0.50))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Style.border))
    }

    private var output: some View {
        ZStack(alignment: .topLeading) {
            if time >= 3.2 && time < 8 {
                flood
            } else if time >= 8 {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(outputRows) { row in
                        let remove = row.keep ? 0 : ease(progress(time, from: 13 + Double(row.id) * 0.09, to: 14.1 + Double(row.id) * 0.09))
                        let scanned = time >= 9.1 + Double(row.id) * 0.22
                        line(row, scanned: scanned)
                            .opacity(1 - remove)
                            .offset(x: remove * 130)
                            .frame(height: 29 * (1 - remove), alignment: .top)
                            .clipped()
                        if row.id == 0 || row.id == 5 {
                            Text("  ⋯ [trimmed output · full log saved]")
                                .font(Style.mono(13))
                                .foregroundStyle(Style.dim)
                                .frame(height: 25 * collapse, alignment: .leading)
                                .opacity(collapse)
                                .clipped()
                        }
                    }
                    if time >= 15.5 {
                        archive
                            .padding(.top, 18)
                            .opacity(ease(progress(time, from: 15.5, to: 17)))
                            .offset(y: 12 * (1 - ease(progress(time, from: 15.5, to: 17))))
                    }
                }
            }
            if time >= 8.9 && time <= 12.3 {
                VStack(spacing: 0) {
                    LinearGradient(colors: [.clear, Style.cyan.opacity(0.20)], startPoint: .top, endPoint: .bottom)
                        .frame(height: 24)
                    Rectangle().fill(Style.cyan).frame(height: 2)
                        .shadow(color: Style.cyan.opacity(0.8), radius: 10)
                }
                .offset(y: -24 + progress(time, from: 8.9, to: 12.3) * 401)
            }
        }
    }

    private var flood: some View {
        let offset = flow * 360
        let first = Int(offset)
        let packages = ["react", "typescript", "vite", "esbuild", "@types/node", "rollup", "postcss", "picocolors"]
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(0..<16, id: \.self) { i in
                let index = first + i
                let package = packages[index % packages.count]
                Text(index % 3 == 0
                     ? "npm timing idealTree:node_modules/\(package) Completed in \(index % 7)ms"
                     : "npm http fetch GET 200 registry.npmjs.org/\(package) \(24 + index % 52)ms (cache hit)")
                    .font(Style.mono(14))
                    .foregroundStyle(Style.dim.opacity(0.35 + Double(i) / 24))
                    .frame(height: 27, alignment: .leading)
            }
        }
        .offset(y: -(offset - Double(first)) * 27)
        .frame(height: 405, alignment: .top)
        .clipped()
        .overlay(alignment: .bottomTrailing) {
            Text("… hundreds more lines")
                .font(Style.mono(11)).foregroundStyle(Style.amber)
                .padding(8).background(Style.panel)
        }
    }

    private func line(_ row: OutputRow, scanned: Bool) -> some View {
        let color = row.keep ? Style.green : Style.red
        return HStack(spacing: 10) {
            Text("⎿").foregroundStyle(Style.dim)
            Text(row.text).foregroundStyle(scanned && row.keep ? Style.text : Style.dim)
            Spacer(minLength: 0)
            Text(scanned ? row.reason : "")
                .font(Style.mono(10)).bold().foregroundStyle(color)
        }
        .font(Style.mono(13.5))
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
                    "jev-latest · which output chunks must stay visible?",
                    "Dropping repetitive chunks · kept text stays verbatim",
                    "Pruned. The model receives the compact tool result."
                ][stage])
                .font(Style.mono(12)).foregroundStyle(done ? Style.green : Style.cyan)
            }
            Text(done ? "Warnings + final result kept · original log available" : "No text rewriting. No generated summary.")
                .font(Style.mono(11)).foregroundStyle(Style.dim)
        }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 14) {
                Text("TOOL-RESULT TOKENS").font(Style.mono(11)).foregroundStyle(Style.dim)
                Text(tokens.formatted())
                    .font(.system(size: 53, weight: .medium, design: .monospaced))
                    .foregroundStyle(done ? Style.green : flow > 0.6 ? Style.amber : Style.text)
                    .monospacedDigit()
                tokenBlocks
                Text(done ? "99% less in this example" : "Before entering model context")
                    .font(.system(size: 12)).foregroundStyle(done ? Style.green : Style.dim)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10).fill(Style.panel))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Style.border))
            VStack(alignment: .leading, spacing: 13) {
                pipelineItem("01", "Bash output", detail: "10,000 tokens", active: stage >= 1, color: Style.amber)
                Rectangle().fill(Style.border).frame(width: 1, height: 23).padding(.leading, 12)
                pipelineItem("02", "Jev Pruner", detail: stage >= 2 ? "Score → keep → prune" : "Waiting for output", active: stage >= 2, color: Style.cyan)
                Rectangle().fill(Style.border).frame(width: 1, height: 23).padding(.leading, 12)
                pipelineItem("03", "Model context", detail: done ? "100 tokens delivered" : "Nothing delivered yet", active: done, color: Style.green)
            }
            .padding(.horizontal, 10).padding(.vertical, 10)
            Spacer(minLength: 0)
            VStack(alignment: .leading, spacing: 8) {
                Text(done ? "10,000 → 100" : "Noise stays out.")
                    .font(Style.mono(20)).foregroundStyle(done ? Style.green : Style.text)
                Text(done ? "Same retained text.\nMore room for the task." : "The command still runs.\nThe useful output stays.")
                    .font(.system(size: 14)).foregroundStyle(Style.dim)
                    .lineSpacing(4)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(done ? Style.green.opacity(0.35) : Style.border))
        }
        .frame(width: 356, height: 650, alignment: .top)
    }

    private var tokenBlocks: some View {
        VStack(spacing: 4) {
            ForEach(0..<4, id: \.self) { row in
                HStack(spacing: 4) {
                    ForEach(0..<20, id: \.self) { column in
                        let lit = row * 20 + column < max(tokens > 0 ? 1 : 0, Int(Double(tokens) / 125))
                        RoundedRectangle(cornerRadius: 2)
                            .fill(lit ? (done ? Style.green : Style.amber) : Style.border.opacity(0.4))
                            .frame(height: 8)
                    }
                }
            }
        }
    }

    private func pipelineItem(_ index: String, _ name: String, detail: String, active: Bool, color: Color) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(index).font(Style.mono(11))
                .foregroundStyle(active ? color : Style.dim)
                .frame(width: 26, height: 26)
                .background(Circle().fill(active ? color.opacity(0.12) : Style.border.opacity(0.4)))
            VStack(alignment: .leading, spacing: 6) {
                Text(name).font(.system(size: 17, weight: .medium))
                Text(detail).font(Style.mono(11)).foregroundStyle(active ? color : Style.dim)
            }
        }
        .opacity(active ? 1 : 0.5)
    }

    private var footer: some View {
        HStack {
            Text("ILLUSTRATIVE ANIMATION")
                .font(Style.mono(10)).foregroundStyle(Style.orange)
            Text("Scripted output, scores and token counts · not a benchmark")
                .font(.system(size: 12)).foregroundStyle(Style.dim)
            Spacer()
            Text("SPACE TO REPLAY").font(Style.mono(10)).foregroundStyle(Style.dim)
        }
        .frame(height: 14)
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
            for frame in 0..<Int(Style.duration * 30) {
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
                if frame % 150 == 0 { print("Rendered \(frame)/750 frames") }
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
                    fputs("Demo export failed: \(error)\nUsage: --export movie.mp4 | --frame <0…25> image.png\n", stderr)
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
