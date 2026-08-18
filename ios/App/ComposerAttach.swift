// Files waiting to go with the next message: a photo, a camera shot, or
// something from Files. The sidecar writes each onto the computer on send;
// until then they live only on the phone.
import SwiftUI
import UIKit
import CompanionCore

struct PendingAttachment: Identifiable {
    let id: UUID
    var name: String
    var data: Data
    var preview: UIImage?
    /// Set once the sidecar has the bytes. A failed send can retry without
    /// writing the file twice.
    var host: Attachment.File?

    init(
        id: UUID = UUID(),
        name: String,
        data: Data,
        preview: UIImage? = nil,
        host: Attachment.File? = nil
    ) {
        self.id = id
        self.name = name
        self.data = data
        self.preview = preview
        self.host = host
    }
}

enum PendingMedia {
    /// Matches `MAX_INBOX_BYTES` in companion/src/inbox.ts. Keep them in
    /// step: the phone should refuse before the sidecar does.
    static let maxBytes = 8 * 1024 * 1024
    /// Same ceiling as the photo picker. Files are held in memory until send.
    static let maxCount = 8

    static func jpegData(from image: UIImage) -> Data? {
        let longest = max(image.size.width, image.size.height)
        let scale = longest > 2048 ? 2048 / longest : 1
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: size)
        let scaled = renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        for quality in [CGFloat(0.85), 0.7, 0.55, 0.4] {
            if let data = scaled.jpegData(compressionQuality: quality), data.count <= maxBytes {
                return data
            }
        }
        guard let data = scaled.jpegData(compressionQuality: 0.3), data.count <= maxBytes else {
            return nil
        }
        return data
    }

    static func jpegAttachment(from image: UIImage, name: String) -> PendingAttachment? {
        guard let data = jpegData(from: image) else { return nil }
        return PendingAttachment(name: name, data: data, preview: image)
    }
}

struct ComposerAttachMenu: View {
    var enabled: Bool
    var onAttachImage: () -> Void
    var onTakePhoto: () -> Void
    var onChooseFile: () -> Void

    var body: some View {
        Menu {
            Button(action: onAttachImage) {
                Label("Attach Image", systemImage: "photo")
            }
            Button(action: onTakePhoto) {
                Label("Take Photo", systemImage: "camera")
            }
            Button(action: onChooseFile) {
                Label("Choose File", systemImage: "folder")
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Color.primary)
                .frame(width: 36, height: 36)
                .background(Circle().fill(Color.secondary.opacity(0.16)))
        }
        .disabled(!enabled)
        .accessibilityLabel("Attach")
    }
}

struct ComposerAttachBar: View {
    @Binding var items: [PendingAttachment]
    var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let error, !error.isEmpty {
                Text(error)
                    .font(.system(size: 13))
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 4)
            }
            if !items.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(items) { item in
                            chip(item)
                        }
                    }
                }
            }
        }
    }

    private func chip(_ item: PendingAttachment) -> some View {
        HStack(spacing: 6) {
            if let preview = item.preview {
                Image(uiImage: preview)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 28, height: 28)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            } else {
                Image(systemName: "doc")
                    .font(.system(size: 13, weight: .semibold))
                    .frame(width: 28, height: 28)
            }
            Text(item.name)
                .font(.system(size: 13))
                .lineLimit(1)
            Button {
                items.removeAll { $0.id == item.id }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Color.secondary)
            }
            .accessibilityLabel("Remove \(item.name)")
        }
        .padding(.leading, 4)
        .padding(.trailing, 8)
        .padding(.vertical, 4)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.secondary.opacity(0.16))
        )
    }
}

/// JPEG bytes for a photo this phone already uploaded, keyed by the inbox
/// filename. The bubble should not have to round-trip to the Mac to show
/// something it held a moment ago.
enum InboxCache {
    private static let folder: URL = {
        let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("OpenMausInbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    /// Inbox names are basename-only and already sanitised on the Mac.
    /// Anything else is not one of ours — including `..`, which
    /// `appendingPathComponent` would walk out of this folder.
    private static func storedName(from hostPath: String) -> String? {
        let name = URL(fileURLWithPath: hostPath).lastPathComponent
        guard name.range(
            of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$",
            options: .regularExpression
        ) != nil else { return nil }
        return name
    }

    static func save(_ data: Data, hostPath: String) {
        guard let name = storedName(from: hostPath) else { return }
        try? data.write(to: folder.appendingPathComponent(name), options: .atomic)
    }

    static func load(hostPath: String) -> Data? {
        guard let name = storedName(from: hostPath) else { return nil }
        return try? Data(contentsOf: folder.appendingPathComponent(name))
    }
}

/// A file that already went with a message: the photo if we can show it,
/// otherwise a chip with the name. The sidecar still has the bytes.
struct InboxAttachmentView: View {
    let file: Attachment.File
    var cached: UIImage?
    @EnvironmentObject private var session: Session
    @State private var loaded: UIImage?
    @State private var tried = false

    private var pixels: UIImage? { cached ?? loaded }

    var body: some View {
        Group {
            if file.isImage, let pixels {
                Image(uiImage: pixels)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 240)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            } else if file.isImage, !tried {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.secondary.opacity(0.16))
                    .frame(height: 160)
                    .overlay { ProgressView() }
            } else if file.isImage {
                Button {
                    tried = false
                    Task { await load() }
                } label: {
                    Label(file.displayName, systemImage: "photo")
                        .font(.system(size: 15))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .fill(Color.secondary.opacity(0.16))
                        )
                }
                .buttonStyle(.plain)
            } else {
                Label(file.displayName, systemImage: "doc")
                    .font(.system(size: 15))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(Color.secondary.opacity(0.16))
                    )
            }
        }
        .accessibilityLabel(file.displayName)
        .task(id: file.path) { await load() }
    }

    private func load() async {
        guard file.isImage, pixels == nil else { return }
        if let data = InboxCache.load(hostPath: file.path), let decoded = UIImage(data: data) {
            loaded = decoded
            return
        }
        let name = URL(fileURLWithPath: file.path).lastPathComponent
        if let data = await session.inboxFile(named: name), let decoded = UIImage(data: data) {
            InboxCache.save(data, hostPath: file.path)
            loaded = decoded
            return
        }
        tried = true
    }
}
