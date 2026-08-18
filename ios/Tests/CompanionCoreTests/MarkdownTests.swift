// The block splitter.
//
// The view half — fonts, bullets, the caret — needs a simulator to judge and
// is not tested here. The split is the part with decisions in it, and every
// decision below is one the desktop's react-markdown + remark-gfm already
// made, so the two clients wrap the same reply the same way.
//
// The streaming cases matter most. Every one of these strings is a state the
// phone renders for real, several times a second, on the way to a finished
// reply: half a fence, half a bold run, a bullet with nothing after it. A
// parser that throws away input in those states makes text flicker.
import XCTest
@testable import CompanionCore

final class MarkdownTests: XCTestCase {
    func testPlainTextIsOneParagraph() {
        XCTAssertEqual(Markdown.blocks("just a reply"), [.paragraph("just a reply")])
    }

    func testEmptyInputProducesNothing() {
        XCTAssertEqual(Markdown.blocks(""), [])
        XCTAssertEqual(Markdown.blocks("\n\n  \n"), [])
    }

    /// GFM without `breaks`, which is how the desktop is configured: a lone
    /// newline is a soft break and renders as a space. Joining with "\n"
    /// instead would wrap differently on the two clients for the same text.
    func testSoftBreaksBecomeSpaces() {
        XCTAssertEqual(
            Markdown.blocks("one line\nand its continuation"),
            [.paragraph("one line and its continuation")]
        )
    }

    func testBlankLineSeparatesParagraphs() {
        XCTAssertEqual(
            Markdown.blocks("first\n\nsecond"),
            [.paragraph("first"), .paragraph("second")]
        )
    }

    // MARK: - Headings

    func testHeadingLevels() {
        XCTAssertEqual(Markdown.blocks("# Title"), [.heading(level: 1, text: "Title")])
        XCTAssertEqual(Markdown.blocks("### Deeper"), [.heading(level: 3, text: "Deeper")])
    }

    /// ATX requires the space. Without this check every "#1 pick" and every
    /// "#hashtag" in a reply becomes a 21pt heading.
    func testHashWithoutSpaceIsNotAHeading() {
        XCTAssertEqual(Markdown.blocks("#hashtag"), [.paragraph("#hashtag")])
        XCTAssertEqual(Markdown.blocks("####### seven"), [.paragraph("####### seven")])
    }

    // MARK: - Lists

    func testBulletMarkers() {
        XCTAssertEqual(
            Markdown.blocks("- one\n* two\n+ three"),
            [
                .bullet(indent: 0, text: "one"),
                .bullet(indent: 0, text: "two"),
                .bullet(indent: 0, text: "three"),
            ]
        )
    }

    func testNestedBulletsCountIndent() {
        XCTAssertEqual(
            Markdown.blocks("- top\n  - nested\n    - deeper"),
            [
                .bullet(indent: 0, text: "top"),
                .bullet(indent: 1, text: "nested"),
                .bullet(indent: 2, text: "deeper"),
            ]
        )
    }

    func testOrderedListsKeepTheirNumbers() {
        XCTAssertEqual(
            Markdown.blocks("1. first\n2. second\n10) tenth"),
            [
                .ordered(indent: 0, number: 1, text: "first"),
                .ordered(indent: 0, number: 2, text: "second"),
                .ordered(indent: 0, number: 10, text: "tenth"),
            ]
        )
    }

    /// A year or a price at the start of a sentence is not a list. The
    /// delimiter is what makes it one.
    func testNumberWithoutDelimiterIsProse() {
        XCTAssertEqual(Markdown.blocks("2026 was the year"), [.paragraph("2026 was the year")])
        XCTAssertEqual(Markdown.blocks("3.14 is pi"), [.paragraph("3.14 is pi")])
    }

    /// Inline emphasis is Foundation's job, not this one — the splitter must
    /// hand the markers through untouched or the view has nothing to render.
    func testInlineSyntaxSurvivesTheSplit() {
        XCTAssertEqual(
            Markdown.blocks("- **bold** and `code` and [link](https://x.test)"),
            [.bullet(indent: 0, text: "**bold** and `code` and [link](https://x.test)")]
        )
    }

    // MARK: - Fences

    func testFencedCodeKeepsItsLanguageAndItsWhitespace() {
        XCTAssertEqual(
            Markdown.blocks("```swift\nlet x = 1\n    indented\n```"),
            [.code(language: "swift", text: "let x = 1\n    indented")]
        )
    }

    func testFenceWithoutLanguage() {
        XCTAssertEqual(Markdown.blocks("```\nplain\n```"), [.code(language: nil, text: "plain")])
    }

    /// Mid-stream, a fence is open for as long as the snippet takes to
    /// arrive. Rendering it as code from the first line means the block grows
    /// downward; waiting for the closing fence means three backticks sit on
    /// screen and then the whole thing reflows at once.
    func testUnclosedFenceRunsToTheEnd() {
        XCTAssertEqual(
            Markdown.blocks("here:\n```py\nprint(1)"),
            [.paragraph("here:"), .code(language: "py", text: "print(1)")]
        )
    }

    /// Markers inside a fence are code, not structure.
    func testFenceContentIsNotReparsed() {
        XCTAssertEqual(
            Markdown.blocks("```\n# not a heading\n- not a bullet\n```"),
            [.code(language: nil, text: "# not a heading\n- not a bullet")]
        )
    }

    // MARK: - Quotes and rules

    func testQuote() {
        XCTAssertEqual(Markdown.blocks("> quoted"), [.quote("quoted")])
    }

    func testHorizontalRules() {
        XCTAssertEqual(Markdown.blocks("---"), [.rule])
        XCTAssertEqual(Markdown.blocks("***"), [.rule])
        XCTAssertEqual(Markdown.blocks("___"), [.rule])
    }

    /// Two hyphens are not a rule, and "- " is a bullet regardless.
    func testRuleNeedsThreeAndNothingElse() {
        XCTAssertEqual(Markdown.blocks("--"), [.paragraph("--")])
        XCTAssertEqual(Markdown.blocks("-- dashes --"), [.paragraph("-- dashes --")])
    }

    // MARK: - Tables

    func testPipeTableKeepsHeadersRowsAndAlignment() {
        let source = """
        | # | Circuit | # | Circuit |
        |---|:-------:|---:|:--------|
        | 1 | Oven    | 2 | Dryer   |
        | 3 | A/C     | 4 | Kitchen Rec |
        """
        XCTAssertEqual(
            Markdown.blocks(source),
            [
                .table(
                    headers: ["#", "Circuit", "#", "Circuit"],
                    alignments: [.left, .center, .right, .left],
                    rows: [
                        ["1", "Oven", "2", "Dryer"],
                        ["3", "A/C", "4", "Kitchen Rec"],
                    ]
                ),
            ]
        )
    }

    /// The panel-directory shape models actually emit: two `#` / Circuit
    /// pairs with an empty spacer cell between them.
    func testABlankCellBetweenColumnPairsIsKept() {
        let source = """
        | # | Circuit | | # | Circuit |
        |---|----------|---|---|----------|
        | 1 | Oven | | 2 | Dryer |
        """
        XCTAssertEqual(
            Markdown.blocks(source),
            [
                .table(
                    headers: ["#", "Circuit", "", "#", "Circuit"],
                    alignments: [.left, .left, .left, .left, .left],
                    rows: [["1", "Oven", "", "2", "Dryer"]],
                ),
            ]
        )
    }

    /// Without a delimiter row this is prose that happens to contain pipes,
    /// which is how it rendered as a wall of `|` before tables existed here.
    func testPipesWithoutADelimiterStayAParagraph() {
        XCTAssertEqual(
            Markdown.blocks("| # | Circuit |\n| 1 | Oven |"),
            [.paragraph("| # | Circuit | | 1 | Oven |")]
        )
    }

    func testAHeaderWithoutADelimiterIsStillProse() {
        XCTAssertEqual(Markdown.blocks("| # | Circuit |"), [.paragraph("| # | Circuit |")])
    }

    /// GFM: the delimiter decides how many columns there are. Extra header
    /// cells are dropped; missing body cells are empty.
    func testDelimiterColumnCountWins() {
        let source = """
        | a | b | c |
        | --- | --- |
        | 1 | 2 | 3 |
        | only |
        """
        XCTAssertEqual(
            Markdown.blocks(source),
            [
                .table(
                    headers: ["a", "b"],
                    alignments: [.left, .left],
                    rows: [
                        ["1", "2"],
                        ["only", ""],
                    ]
                ),
            ]
        )
    }

    func testATableStopsAtABlankLine() {
        let source = """
        | a | b |
        | --- | --- |
        | 1 | 2 |

        after
        """
        XCTAssertEqual(
            Markdown.blocks(source),
            [
                .table(
                    headers: ["a", "b"],
                    alignments: [.left, .left],
                    rows: [["1", "2"]]
                ),
                .paragraph("after"),
            ]
        )
    }

    func testAPartialTableStillHasItsHeader() {
        XCTAssertEqual(
            Markdown.blocks("| a | b |\n| --- | --- |"),
            [
                .table(
                    headers: ["a", "b"],
                    alignments: [.left, .left],
                    rows: []
                ),
            ]
        )
    }

    func testInlineMarkupInCellsSurvivesTheSplit() {
        XCTAssertEqual(
            Markdown.blocks("| **Name** |\n| --- |\n| `Oven` |"),
            [
                .table(
                    headers: ["**Name**"],
                    alignments: [.left],
                    rows: [["`Oven`"]]
                ),
            ]
        )
    }

    // MARK: - Streaming

    /// The invariant that keeps the bubble from flickering: whatever arrives,
    /// something renders, and the characters the model has sent are in it.
    func testPartialInputAlwaysRendersSomething() {
        for prefix in ["#", "# ", "# Head", "- ", "- it", "**bo", "```", "```sw\nlet", "[link](htt", "| a |"] {
            XCTAssertFalse(
                Markdown.blocks(prefix).isEmpty,
                "dropped everything for \(prefix.debugDescription)"
            )
        }
    }

    /// Growing the source one character at a time must never lose text. This
    /// is the whole stream, replayed at the granularity the deltas arrive at.
    func testNoPrefixOfAReplyLosesCharacters() {
        let reply = "# Result\n\nRan **two** checks:\n\n- `pnpm test` passed\n- `pnpm lint` passed\n\n| check | ok |\n| --- | --- |\n| test | yes |\n\n```sh\npnpm test\n```\n\n> nothing else to report"
        for length in 1...reply.count {
            let partial = String(reply.prefix(length))
            let rendered = Markdown.blocks(partial).map(text).joined()
            // Compare on non-whitespace: the splitter deliberately drops
            // markers, indentation and blank lines, and it joins soft breaks
            // with a space. What it must not drop is content.
            let dropped: Set<Character> = ["#", "-", ">", "`", "*", "_", "|"]
            let sent = partial.filter { !$0.isWhitespace && !dropped.contains($0) }
            let shown = rendered.filter { !$0.isWhitespace && !dropped.contains($0) }
            XCTAssertEqual(shown, sent, "lost content at \(length) characters")
        }
    }

    private func text(_ block: MarkdownBlock) -> String {
        switch block {
        case let .paragraph(text): return text
        case let .bullet(_, text): return text
        case let .ordered(_, number, text): return "\(number)" + text
        case let .heading(_, text): return text
        case let .code(language, text): return (language ?? "") + text
        case let .quote(text): return text
        case let .table(headers, _, rows): return headers.joined() + rows.flatMap { $0 }.joined()
        case .rule: return ""
        }
    }
}
