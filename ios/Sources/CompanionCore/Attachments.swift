// Composer attachments, the half that has no photo library.
//
// The phone picks a file; the sidecar writes it onto this computer; the
// message the bot receives is the same tagged path the desktop composer
// already sends (`src/lib/composer-attachments.ts`). Drivers never see
// bytes from the phone — they open a path that now exists on the host.
import Foundation

public enum Attachment {
    public struct File: Equatable, Sendable {
        public var path: String
        public var name: String
        public var size: Int

        public init(path: String, name: String, size: Int) {
            self.path = path
            self.name = name
            self.size = size
        }

        /// Cheap, from the name. The view uses this to decide thumbnail vs chip.
        public var isImage: Bool {
            let ext = URL(fileURLWithPath: name).pathExtension.lowercased()
            return Self.imageExtensions.contains(ext)
        }

        /// Inbox files are stored as `timestamp-hex-original.jpg`. Show the
        /// original in a chip; the prefix is only uniqueness on disk.
        public var displayName: String {
            let base = URL(fileURLWithPath: name).lastPathComponent
            let parts = base.split(separator: "-", maxSplits: 2, omittingEmptySubsequences: false)
            guard parts.count == 3,
                  parts[0].allSatisfy(\.isNumber),
                  parts[1].count == 8,
                  parts[1].allSatisfy(\.isHexDigit)
            else { return base }
            return String(parts[2])
        }

        private static let imageExtensions: Set<String> = [
            "jpg", "jpeg", "png", "gif", "heic", "heif", "webp", "tif", "tiff",
        ]
    }

    /// What a person should see: the caption they typed, then the files, never
    /// the host path tag. That tag is for the agent.
    public struct Display: Equatable, Sendable {
        public var caption: String
        public var files: [File]
    }

    /// Combine typed composer text with host paths for attached files.
    ///
    /// Empty text is allowed when there is at least one file — a photo with
    /// no caption is still a message. Empty everything stays empty so the
    /// caller can refuse to send.
    public static func draft(text: String, files: [File]) -> String {
        var parts: [String] = []
        let typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !typed.isEmpty { parts.append(typed) }
        for file in files {
            parts.append("<attached-file path=\"\(escapeAttribute(file.path))\" />")
        }
        return parts.joined(separator: "\n\n")
    }

    /// File paths are untrusted prompt content. Keep them inside the quoted
    /// attribute even when a filename contains XML characters or line breaks.
    public static func escapeAttribute(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\t", with: "&#9;")
            .replacingOccurrences(of: "\r", with: "&#13;")
            .replacingOccurrences(of: "\n", with: "&#10;")
    }

    /// Inverse of `escapeAttribute`. `&amp;` last, so a path that encoded an
    /// ampersand does not get scanned for a second round of entities.
    public static func unescapeAttribute(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&#10;", with: "\n")
            .replacingOccurrences(of: "&#13;", with: "\r")
            .replacingOccurrences(of: "&#9;", with: "\t")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&amp;", with: "&")
    }

    /// Pull caption and files out of a stored user message. A message with
    /// no tags is unchanged; tags become files named from the path.
    public static func display(_ text: String) -> Display {
        let tag = #/<attached-file path="([^"]*)"\s*\/>/#
        let matches = text.matches(of: tag)
        guard !matches.isEmpty else {
            return Display(caption: text, files: [])
        }

        var files: [File] = []
        var parts: [String] = []
        var cursor = text.startIndex
        for match in matches {
            let before = String(text[cursor..<match.range.lowerBound])
            let trimmed = before.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { parts.append(trimmed) }
            let path = unescapeAttribute(String(match.output.1))
            let name = URL(fileURLWithPath: path).lastPathComponent
            files.append(File(path: path, name: name.isEmpty ? "file" : name, size: 0))
            cursor = match.range.upperBound
        }
        let after = String(text[cursor...]).trimmingCharacters(in: .whitespacesAndNewlines)
        if !after.isEmpty { parts.append(after) }
        return Display(caption: parts.joined(separator: "\n\n"), files: files)
    }
}
