import XCTest
@testable import CompanionCore

final class ConnectionTests: XCTestCase {
    func testParsesHostnamesAndPorts() {
        let implicit = Connection.parse("macbook.tailnet.ts.net")
        XCTAssertEqual(implicit?.host, "macbook.tailnet.ts.net")
        XCTAssertEqual(implicit?.port, 8810)

        let explicit = Connection.parse("http://192.168.1.42:9910/")
        XCTAssertEqual(explicit?.host, "192.168.1.42")
        XCTAssertEqual(explicit?.port, 9910)
    }

    func testParsesIPv6WithAndWithoutAnExplicitPort() {
        let bare = Connection.parse("2001:db8::1")
        XCTAssertEqual(bare?.host, "[2001:db8::1]")
        XCTAssertEqual(bare?.port, 8810)
        XCTAssertEqual(bare?.baseURL?.absoluteString, "http://[2001:db8::1]:8810")

        let explicit = Connection.parse("[2001:db8::1]:9910")
        XCTAssertEqual(explicit?.host, "[2001:db8::1]")
        XCTAssertEqual(explicit?.port, 9910)
        XCTAssertEqual(explicit?.baseURL?.absoluteString, "http://[2001:db8::1]:9910")
    }

    func testRetainsTheScopeZoneOnLinkLocalIPv6() {
        let connection = Connection.parse("[fe80::1%en0]:8810")
        XCTAssertEqual(connection?.host, "[fe80::1%en0]")
        XCTAssertEqual(connection?.baseURL?.absoluteString, "http://[fe80::1%25en0]:8810")
    }

    func testAnOlderSavedIPv6ConnectionIsNormalizedWhenUsed() throws {
        let data = Data(#"{"id":"saved","name":"Mac","host":"::1","port":8810}"#.utf8)
        let saved = try JSONDecoder().decode(Connection.self, from: data)
        XCTAssertEqual(saved.baseURL?.absoluteString, "http://[::1]:8810")
    }

    func testRejectsAmbiguousOrUnsafeAddresses() {
        XCTAssertNil(Connection.parse("host:not-a-port"))
        XCTAssertNil(Connection.parse("[::1]:not-a-port"))
        XCTAssertNil(Connection.parse("[::1]:70000"))
        XCTAssertNil(Connection.parse("host/path"))
        XCTAssertNil(Connection.parse("host name"))
    }
}
