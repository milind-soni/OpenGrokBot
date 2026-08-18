// Markdown, split into blocks.
//
// The desktop renders bot replies with react-markdown + GFM. The phone was
// showing the source: `**bold**`, `- ` bullets and `[text](url)` arriving as
// literal characters, which is worse than no markdown at all — it is the
// author's intent visible but not applied.
//
// Foundation can already do the *inline* half. `AttributedString(markdown:)`
// handles emphasis, code spans, strikethrough and links, and SwiftUI renders
// the links tappable for free. What it will not do is lay out blocks: with
// `.full` it records a presentation intent and leaves you to draw the bullet,
// the indent and the spacing yourself. So this splits the text into blocks
// and the view draws each one, handing the inline run back to Foundation.
//
// Deliberately not a full CommonMark implementation. It covers what a model
// actually emits into a chat bubble — paragraphs, lists, headings, fences,
// quotes, rules, GFM tables — and treats anything it does not recognise as
// text, which is the failure mode that loses nothing.
import Foundation

public enum MarkdownTableAlignment: Equatable, Sendable {
    case left
    case center
    case right
}

public enum MarkdownBlock: Equatable, Sendable {
    case paragraph(String)
    /// `indent` is nesting depth, 0 for a top-level item.
    case bullet(indent: Int, text: String)
    case ordered(indent: Int, number: Int, text: String)
    case heading(level: Int, text: String)
    /// A fenced block. `language` is whatever followed the opening fence.
    case code(language: String?, text: String)
    case quote(String)
    /// A GFM pipe table. Column count comes from the delimiter row, the
    /// same rule remark-gfm uses on the desktop.
    case table(headers: [String], alignments: [MarkdownTableAlignment], rows: [[String]])
    case rule
}

public enum Markdown {
    /// Split into blocks. Never throws and never drops input: an unparseable
    /// line ends up in a paragraph, which is what the reader wanted anyway.
    public static func blocks(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            // GFM: a single newline inside a paragraph is a soft break, which
            // renders as a space. The desktop does not enable `breaks`, so
            // neither does this — the two should wrap the same way.
            blocks.append(.paragraph(paragraph.joined(separator: " ")))
            paragraph.removeAll()
        }

        // Normalise the line endings before splitting, because
        // `CharacterSet.newlines` contains \r and \n *separately* and
        // `components(separatedBy:)` breaks on each of them: "a\r\nb" comes
        // back as ["a", "", "b"], one phantom empty line per CRLF. That empty
        // line is not cosmetic — it calls `flushParagraph`, so a paragraph
        // written across several lines arrives as one paragraph per line, and
        // a fenced block gains a blank line between every line of code. Tool
        // output and pasted text reach chat bubbles with CRLF intact, so this
        // is a path real messages take.
        let normalised = source.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        var lines = normalised.components(separatedBy: "\n")[...]
        while let line = lines.first {
            lines = lines.dropFirst()
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // A fence runs to its closing fence, or to the end — a reply still
            // streaming has an open one, and showing it as code beats showing
            // three backticks and waiting.
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushParagraph()
                let marker = String(trimmed.prefix(3))
                let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                while let next = lines.first {
                    lines = lines.dropFirst()
                    if next.trimmingCharacters(in: .whitespaces).hasPrefix(marker) { break }
                    body.append(next)
                }
                blocks.append(.code(language: language.isEmpty ? nil : language, text: body.joined(separator: "\n")))
                continue
            }

            if trimmed.isEmpty {
                flushParagraph()
                continue
            }

            // A GFM table is a header line plus a delimiter row of dashes.
            // Without the delimiter, a line that happens to contain `|` is
            // still prose — otherwise "use | as a pipe" becomes a one-cell
            // table the moment it wraps.
            if let table = takeTable(trimmed, remaining: &lines) {
                flushParagraph()
                blocks.append(table)
                continue
            }

            // --- or *** or ___, three or more, nothing else on the line
            if trimmed.count >= 3, "-*_".contains(trimmed.first!),
               trimmed.allSatisfy({ $0 == trimmed.first! }) {
                flushParagraph()
                blocks.append(.rule)
                continue
            }

            if let heading = heading(trimmed) {
                flushParagraph()
                blocks.append(heading)
                continue
            }

            if trimmed.hasPrefix(">") {
                flushParagraph()
                blocks.append(.quote(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces)))
                continue
            }

            if let item = listItem(line) {
                flushParagraph()
                blocks.append(item)
                continue
            }

            paragraph.append(trimmed)
        }
        flushParagraph()
        return blocks
    }

    private static func heading(_ trimmed: String) -> MarkdownBlock? {
        let hashes = trimmed.prefix(while: { $0 == "#" }).count
        guard hashes >= 1, hashes <= 6 else { return nil }
        let rest = String(trimmed.dropFirst(hashes))
        // "#hashtag" is not a heading; ATX requires the space
        guard rest.hasPrefix(" ") else { return nil }
        return .heading(level: hashes, text: rest.trimmingCharacters(in: .whitespaces))
    }

    private static func listItem(_ line: String) -> MarkdownBlock? {
        let leading = line.prefix(while: { $0 == " " || $0 == "\t" }).count
        // two spaces per level, which is what a model emits and what GFM
        // treats as nesting for a tight list
        let indent = min(leading / 2, 4)
        let trimmed = line.trimmingCharacters(in: .whitespaces)

        for marker in ["- ", "* ", "+ "] where trimmed.hasPrefix(marker) {
            return .bullet(indent: indent, text: String(trimmed.dropFirst(2)))
        }

        // "1. " / "12) "
        let digits = trimmed.prefix(while: \.isNumber)
        if !digits.isEmpty, digits.count <= 9 {
            let rest = trimmed.dropFirst(digits.count)
            if rest.hasPrefix(". ") || rest.hasPrefix(") ") {
                return .ordered(indent: indent, number: Int(digits) ?? 1, text: String(rest.dropFirst(2)))
            }
        }
        return nil
    }

    /// Header + delimiter, then body rows until a blank line or a line that
    /// is not a row. Column count is the delimiter's cell count, matching GFM.
    private static func takeTable(_ headerLine: String, remaining: inout ArraySlice<String>) -> MarkdownBlock? {
        guard looksLikeTableRow(headerLine),
              let delimiter = remaining.first,
              let alignments = delimiterAlignments(delimiter),
              !alignments.isEmpty
        else { return nil }

        remaining = remaining.dropFirst()
        let columns = alignments.count
        let headers = padded(cells(headerLine), to: columns, fill: "")
        var rows: [[String]] = []
        while let next = remaining.first {
            let trimmed = next.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty || !looksLikeTableRow(trimmed) || delimiterAlignments(trimmed) != nil {
                break
            }
            remaining = remaining.dropFirst()
            rows.append(padded(cells(trimmed), to: columns, fill: ""))
        }
        return .table(headers: headers, alignments: alignments, rows: rows)
    }

    private static func looksLikeTableRow(_ trimmed: String) -> Bool {
        trimmed.contains("|")
    }

    /// Split on `|`, dropping the empty ends a leading/trailing pipe creates.
    private static func cells(_ line: String) -> [String] {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        var parts = trimmed.split(separator: "|", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
        if trimmed.hasPrefix("|"), parts.first == "" { parts.removeFirst() }
        if trimmed.hasSuffix("|"), parts.last == "" { parts.removeLast() }
        return parts
    }

    /// Every cell must be `---` / `:---` / `---:` / `:---:`. A lone `---`
    /// with no pipe is a horizontal rule, not a delimiter — that path
    /// never calls this because `looksLikeTableRow` requires a `|`.
    private static func delimiterAlignments(_ line: String) -> [MarkdownTableAlignment]? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard looksLikeTableRow(trimmed) else { return nil }
        let parts = cells(trimmed)
        guard !parts.isEmpty else { return nil }
        var alignments: [MarkdownTableAlignment] = []
        alignments.reserveCapacity(parts.count)
        for part in parts {
            guard let alignment = alignment(from: part) else { return nil }
            alignments.append(alignment)
        }
        return alignments
    }

    private static func alignment(from cell: String) -> MarkdownTableAlignment? {
        let left = cell.hasPrefix(":")
        let right = cell.hasSuffix(":")
        let dashes = cell.dropFirst(left ? 1 : 0).dropLast(right ? 1 : 0)
        guard dashes.count >= 3, dashes.allSatisfy({ $0 == "-" }) else { return nil }
        if left && right { return .center }
        if right { return .right }
        return .left
    }

    private static func padded<T>(_ items: [T], to count: Int, fill: T) -> [T] {
        if items.count >= count { return Array(items.prefix(count)) }
        return items + Array(repeating: fill, count: count - items.count)
    }
}
