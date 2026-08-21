package com.openmausbot.companion.core

import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class FailoverTest {
    @Test
    fun walksCandidatesInOrderAndWraps() {
        val rotation = CandidateRotation(listOf("mac.tail1234.ts.net", "192.168.1.42", "openmausbot-aa.local"))
        assertEquals("mac.tail1234.ts.net", rotation.current)
        assertEquals("192.168.1.42", rotation.advance())
        assertEquals("openmausbot-aa.local", rotation.advance())
        assertEquals("mac.tail1234.ts.net", rotation.advance())
    }

    @Test
    fun promotesTheWorkingCandidateToTheFront() {
        val rotation = CandidateRotation(listOf("mac.tail1234.ts.net", "192.168.1.42", "openmausbot-aa.local"))
        rotation.advance()
        assertEquals(
            listOf("192.168.1.42", "mac.tail1234.ts.net", "openmausbot-aa.local"),
            rotation.promoted(),
        )
    }

    @Test
    fun promotionWithoutAWalkChangesNothing() {
        val rotation = CandidateRotation(listOf("mac.tail1234.ts.net", "192.168.1.42"))
        assertEquals(listOf("mac.tail1234.ts.net", "192.168.1.42"), rotation.promoted())
    }

    @Test
    fun survivesAnEmptyCandidateList() {
        val rotation = CandidateRotation(emptyList())
        assertEquals("", rotation.current)
        assertEquals("", rotation.advance())
        assertEquals(emptyList(), rotation.promoted())
    }

    @Test
    fun rotatesOnAddressFailuresAndNothingElse() {
        listOf(
            ConnectionFailure.CANNOT_FIND_HOST,
            ConnectionFailure.CANNOT_CONNECT_TO_HOST,
            ConnectionFailure.TIMED_OUT,
            ConnectionFailure.SECURE_CONNECTION_FAILED,
        ).forEach { assertTrue(ConnectionAdvice.shouldTryAnotherHost(it)) }
        listOf(
            ConnectionFailure.NOT_CONNECTED_TO_INTERNET,
            ConnectionFailure.CANCELLED,
            ConnectionFailure.NETWORK_CONNECTION_LOST,
        ).forEach { assertFalse(ConnectionAdvice.shouldTryAnotherHost(it)) }

        assertTrue(ConnectionAdvice.shouldTryAnotherHost(UnknownHostException()))
        assertTrue(ConnectionAdvice.shouldTryAnotherHost(ConnectException()))
        assertTrue(ConnectionAdvice.shouldTryAnotherHost(SocketTimeoutException()))
        assertTrue(ConnectionAdvice.shouldTryAnotherHost(SSLException("TLS")))
        assertTrue(ConnectionAdvice.shouldTryAnotherHost(APIError.Transport("wrapped", UnknownHostException())))
        assertFalse(ConnectionAdvice.shouldTryAnotherHost(APIError.Status(401)))
    }

    @Test
    fun unresolvedHostNamesTheTailnetPossibility() {
        val message = ConnectionAdvice.message(
            ConnectionFailure.CANNOT_FIND_HOST,
            "mac.tail1234.ts.net",
            8810,
        )
        assertTrue(message.contains("mac.tail1234.ts.net"))
        assertTrue(message.contains("tailnet"))
        assertTrue(message.contains("retrying automatically"))
    }

    @Test
    fun refusedConnectionPointsAtTheCompanionToggle() {
        val message = ConnectionAdvice.message(
            ConnectionFailure.CANNOT_CONNECT_TO_HOST,
            "192.168.1.42",
            8810,
        )
        assertTrue(message.contains("port 8810"))
        assertTrue(message.contains("Settings → Companion"))
    }

    @Test
    fun timeoutBlamesTheRouteNotTheApp() {
        val message = ConnectionAdvice.message(ConnectionFailure.TIMED_OUT, "192.168.1.42", 8810)
        assertTrue(message.contains("No route"))
        assertTrue(message.contains("firewall"))
    }

    @Test
    fun offlineSaysOffline() {
        assertTrue(
            ConnectionAdvice.message(ConnectionFailure.NOT_CONNECTED_TO_INTERNET, "x", 8810)
                .contains("You're offline."),
        )
    }

    @Test
    fun adviceNamesTheCandidateBeingTriedNext() {
        val message = ConnectionAdvice.message(
            ConnectionFailure.CANNOT_FIND_HOST,
            "mac.tail1234.ts.net",
            8810,
            tryingNext = "192.168.1.42",
        )
        assertTrue(message.contains("Trying 192.168.1.42 next."))
    }

    @Test
    fun orderedHostsLeadsWithStoredHostAndDeduplicates() {
        val connection = Connection(
            name = "Mac",
            host = "192.168.1.42",
            port = 8810,
            hosts = listOf("mac.tail1234.ts.net", "192.168.1.42", "openmausbot-aa.local"),
        )
        assertEquals(
            listOf("192.168.1.42", "mac.tail1234.ts.net", "openmausbot-aa.local"),
            connection.orderedHosts,
        )
    }

    @Test
    fun orderedHostsFallsBackToSingleStoredHost() {
        val connection = Connection(name = "Mac", host = "mac.tail1234.ts.net", port = 8810)
        assertEquals(listOf("mac.tail1234.ts.net"), connection.orderedHosts)
    }

    @Test
    fun dialingSwapsHostWithoutTouchingStoredOrder() {
        val connection = Connection(
            name = "Mac",
            host = "mac.tail1234.ts.net",
            port = 8810,
            hosts = listOf("mac.tail1234.ts.net", "192.168.1.42"),
        )
        val dialed = connection.dialing("192.168.1.42")
        assertEquals("192.168.1.42", dialed.host)
        assertEquals("http://192.168.1.42:8810", dialed.baseUrl.toString())
        assertEquals(connection.hosts, dialed.hosts)
        assertEquals(connection.id, dialed.id)
    }

    @Test
    fun promoteReordersAndKeepsEveryCandidate() {
        val connection = Connection(
            name = "Mac",
            host = "mac.tail1234.ts.net",
            port = 8810,
            hosts = listOf("mac.tail1234.ts.net", "192.168.1.42", "openmausbot-aa.local"),
        ).promoting("192.168.1.42")
        assertEquals("192.168.1.42", connection.host)
        assertEquals(
            listOf("192.168.1.42", "mac.tail1234.ts.net", "openmausbot-aa.local"),
            connection.hosts,
        )
        val typed = connection.promoting("10.0.0.7")
        assertEquals("10.0.0.7", typed.hosts?.first())
        assertEquals(4, typed.hosts?.size)
    }
}
