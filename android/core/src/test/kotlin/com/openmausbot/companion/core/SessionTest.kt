package com.openmausbot.companion.core

import java.net.ConnectException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer

@OptIn(ExperimentalCoroutinesApi::class)
class SessionTest {
    @Test
    fun restoreWithMissingConnectionStaysUnpaired() = runTest {
        val session = session()
        session.awaitRestored()
        assertEquals(Session.Status.Unpaired, session.status.value)
        assertEquals(Session.RestoreState.Unpaired, session.restoreState.value)
        assertNull(session.connection.value)
    }

    @Test
    fun lockedTokenIsOfflineNotUnpaired() = runTest {
        val connection = Connection(id = "c1", name = "Mac", host = "192.168.1.2", port = 8810)
        val tokens = FakeTokenStore().apply {
            unavailable["c1"] = TokenStore.ReadResult.Unavailable(locked = true, message = "locked")
        }
        val session = session(
            connectionStore = FakeConnectionStore(connection),
            tokenStore = tokens,
            events = { _, _ -> emptyFlow() },
        )
        session.awaitRestored()
        assertEquals(connection, session.connection.value)
        assertEquals(Session.RestoreState.Pending, session.restoreState.value)
        val status = assertIs<Session.Status.Offline>(session.status.value)
        assertEquals("Unlock this phone to reach your computer.", status.message)
    }

    @Test
    fun unavailableTokenErrorRemainsPendingWithoutLockedCopy() = runTest {
        val connection = Connection(id = "c1", name = "Mac", host = "192.168.1.2", port = 8810)
        val tokens = FakeTokenStore().apply {
            unavailable["c1"] = TokenStore.ReadResult.Unavailable(
                locked = false,
                message = "Secure storage is temporarily unavailable.",
            )
        }
        val session = session(
            connectionStore = FakeConnectionStore(connection),
            tokenStore = tokens,
            events = { _, _ -> emptyFlow() },
        )

        session.awaitRestored()

        assertEquals(connection, session.connection.value)
        assertEquals(Session.RestoreState.Pending, session.restoreState.value)
        assertEquals(
            "Secure storage is temporarily unavailable.",
            assertIs<Session.Status.Offline>(session.status.value).message,
        )
    }

    @Test
    fun restoredTokenIsReady() = runTest {
        val connection = Connection(id = "c1", name = "Mac", host = "192.168.1.2", port = 8810)
        val session = session(
            connectionStore = FakeConnectionStore(connection),
            tokenStore = FakeTokenStore().apply { saved["c1"] = "device-token" },
            events = { _, _ -> emptyFlow() },
        )

        session.awaitRestored()

        assertEquals(Session.RestoreState.Ready, session.restoreState.value)
        assertEquals(Session.Status.Connecting, session.status.value)
    }

    @Test
    fun pairPersistsTokenAndConnectionNeverCredential() = runTest {
        val connections = FakeConnectionStore()
        val tokens = FakeTokenStore()
        var pairedCredential: String? = null
        val session = session(
            connectionStore = connections,
            tokenStore = tokens,
            pairFn = { _, credential, deviceName ->
                pairedCredential = credential
                assertEquals("Pixel", deviceName)
                PairResponse(
                    token = "device-token-abc",
                    device = PairedDevice("d1", "Pixel", 1.0, 1.0),
                    serverName = "Ada's Mac",
                    hosts = listOf("mac.ts.net", "192.168.1.2"),
                )
            },
            events = { _, _ -> emptyFlow() },
        )
        session.awaitRestored()

        session.pair(
            Connection(name = "invite", host = "192.168.1.2", port = 8810),
            "omb_pair_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM",
        )
        advanceUntilIdle()

        assertEquals("omb_pair_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM", pairedCredential)
        assertEquals("device-token-abc", tokens.saved[connections.saved!!.id])
        assertEquals("Ada's Mac", connections.saved!!.name)
        assertTrue(tokens.saved.values.none { it.startsWith("omb_pair_") })
    }

    @Test
    fun alreadyPairedRejectsNewInvite() = runTest {
        val connection = Connection(id = "c1", name = "Mac", host = "192.168.1.2", port = 8810)
        val tokens = FakeTokenStore().apply { saved["c1"] = "tok" }
        val session = session(
            connectionStore = FakeConnectionStore(connection),
            tokenStore = tokens,
            events = { _, _ -> emptyFlow() },
        )
        session.awaitRestored()
        session.receivePairingURL("openmausbot://pair?address=10.0.0.1:8810&code=123456")
        assertNull(session.pairingInvite.value)
        assertTrue(session.actionError!!.contains("already paired"))
    }

    @Test
    fun pairItselfRejectsWhenAlreadyPaired() = runTest {
        val connection = Connection(id = "c1", name = "Mac", host = "192.168.1.2", port = 8810)
        val tokens = FakeTokenStore().apply { saved["c1"] = "tok" }
        var pairCalls = 0
        val session = session(
            connectionStore = FakeConnectionStore(connection),
            tokenStore = tokens,
            pairFn = { _, _, _ ->
                pairCalls++
                error("should not redeem")
            },
            events = { _, _ -> emptyFlow() },
        )
        session.awaitRestored()
        assertFailsWith<AlreadyPairedException> {
            session.pair(Connection(name = "other", host = "10.0.0.1", port = 8810), "123456")
        }
        assertEquals(0, pairCalls)
        assertEquals("tok", tokens.saved["c1"])
        assertTrue(session.actionError!!.contains("already paired"))
    }

    @Test
    fun coldStartDeepLinkWaitsForRestoreBeforeAccepting() = runTest {
        val connection = Connection(id = "c1", name = "Mac", host = "192.168.1.2", port = 8810)
        val restoreGate = CompletableDeferred<Unit>()
        val connections = object : ConnectionStore {
            override suspend fun load(): Connection? {
                restoreGate.await()
                return connection
            }
            override suspend fun save(connection: Connection) = Unit
            override suspend fun clear() = Unit
        }
        val session = session(
            connectionStore = connections,
            tokenStore = FakeTokenStore().apply { saved["c1"] = "tok" },
            events = { _, _ -> emptyFlow() },
        )
        // Deep link arrives while restore is still suspended.
        session.receivePairingURL(
            "openmausbot://pair?address=10.0.0.1:8810&token=omb_pair_" + "a".repeat(43),
        )
        runCurrent()
        assertNull(session.pairingInvite.value)

        restoreGate.complete(Unit)
        session.awaitRestored()
        advanceUntilIdle()
        assertNull(session.pairingInvite.value)
        assertTrue(session.actionError!!.contains("already paired"))
    }

    @Test
    fun failedQrRedeemBurnsInviteAndRejectsReplay() = runTest {
        val qr = "omb_pair_" + "b".repeat(43)
        var attempts = 0
        val session = session(
            pairFn = { _, _, _ ->
                attempts++
                throw APIError.Transport("redeem failed")
            },
            events = { _, _ -> emptyFlow() },
        )
        session.awaitRestored()
        session.receivePairingURL("openmausbot://pair?address=192.168.1.2:8810&token=$qr&code=123456")
        assertEquals(qr, session.pairingInvite.value?.credential)

        assertFailsWith<APIError.Transport> {
            session.pair(session.pairingInvite.value!!)
        }
        assertNull(session.pairingInvite.value)
        assertTrue(session.actionError!!.contains("rescan the new QR code"))

        assertFailsWith<SpentPairingCredentialException> {
            session.pair(Connection(name = "Mac", host = "192.168.1.2", port = 8810), qr)
        }
        assertEquals(1, attempts)

        session.receivePairingURL("openmausbot://pair?address=192.168.1.2:8810&token=$qr&code=123456")
        assertNull(session.pairingInvite.value)
        assertTrue(session.actionError!!.contains("already used") || session.actionError!!.contains("rescan"))
    }

    @Test
    fun failedCodeRedeemRemainsRetryable() = runTest {
        var attempts = 0
        val session = session(
            pairFn = { _, _, _ ->
                attempts++
                if (attempts == 1) throw APIError.Transport("wrong code")
                PairResponse(
                    token = "device-token",
                    device = PairedDevice("d1", "Pixel", 1.0, 1.0),
                    serverName = "Mac",
                    hosts = null,
                )
            },
            events = { _, _ -> emptyFlow() },
        )
        session.awaitRestored()
        assertFailsWith<APIError.Transport> {
            session.pair(Connection(name = "Mac", host = "192.168.1.2", port = 8810), "123456")
        }
        session.pair(Connection(name = "Mac", host = "192.168.1.2", port = 8810), "123456")
        advanceUntilIdle()
        assertEquals(2, attempts)
        assertTrue(session.connection.value != null)
    }

    @Test
    fun concurrentPairOnlyOneWins() = runTest {
        val connections = FakeConnectionStore()
        val tokens = FakeTokenStore()
        val firstEntered = CompletableDeferred<Unit>()
        val releaseFirst = CompletableDeferred<Unit>()
        var pairCalls = 0
        val session = session(
            connectionStore = connections,
            tokenStore = tokens,
            pairFn = { _, credential, _ ->
                pairCalls++
                if (pairCalls == 1) {
                    firstEntered.complete(Unit)
                    releaseFirst.await()
                }
                PairResponse(
                    token = "tok-$credential",
                    device = PairedDevice("d1", "Pixel", 1.0, 1.0),
                    serverName = "Mac-$credential",
                    hosts = null,
                )
            },
            events = { _, _ -> emptyFlow() },
        )
        session.awaitRestored()

        var firstResult: Result<Unit>? = null
        var secondResult: Result<Unit>? = null
        val first = launch {
            firstResult = runCatching {
                session.pair(Connection(name = "a", host = "10.0.0.1", port = 8810), "111111")
            }
        }
        firstEntered.await()
        val second = launch {
            secondResult = runCatching {
                session.pair(Connection(name = "b", host = "10.0.0.2", port = 8810), "222222")
            }
        }
        runCurrent()
        assertTrue(second.isActive)
        releaseFirst.complete(Unit)
        advanceUntilIdle()
        first.join()
        second.join()

        assertEquals(1, pairCalls)
        assertTrue(firstResult!!.isSuccess)
        assertTrue(secondResult!!.exceptionOrNull() is AlreadyPairedException)
        assertEquals("tok-111111", tokens.saved.values.single())
        assertEquals("Mac-111111", connections.saved!!.name)
        assertTrue(session.actionError!!.contains("already paired"))
    }

    @Test
    fun qrBurnedWhenSaveFailsAfterSuccessfulRedeem() = runTest {
        val qr = "omb_pair_" + "c".repeat(43)
        var attempts = 0
        val tokens = object : TokenStore by FakeTokenStore() {
            override suspend fun save(connectionId: String, token: String) {
                error("disk full")
            }
        }
        val session = session(
            tokenStore = tokens,
            pairFn = { _, _, _ ->
                attempts++
                PairResponse(
                    token = "device-token",
                    device = PairedDevice("d1", "Pixel", 1.0, 1.0),
                    serverName = "Mac",
                    hosts = null,
                )
            },
            events = { _, _ -> emptyFlow() },
        )
        session.awaitRestored()

        assertFailsWith<IllegalStateException> {
            session.pair(Connection(name = "Mac", host = "192.168.1.2", port = 8810), qr)
        }
        assertNull(session.connection.value)
        assertTrue(session.actionError!!.contains("rescan the new QR code"))

        assertFailsWith<SpentPairingCredentialException> {
            session.pair(Connection(name = "Mac", host = "192.168.1.2", port = 8810), qr)
        }
        assertEquals(1, attempts)
    }

    @Test
    fun qrBurnedWhenCancelledAfterRedeemStarts() = runTest {
        val qr = "omb_pair_" + "d".repeat(43)
        var attempts = 0
        val redeemStarted = CompletableDeferred<Unit>()
        val blockRedeem = CompletableDeferred<Unit>()
        val session = session(
            pairFn = { _, _, _ ->
                attempts++
                redeemStarted.complete(Unit)
                blockRedeem.await()
                PairResponse(
                    token = "device-token",
                    device = PairedDevice("d1", "Pixel", 1.0, 1.0),
                    serverName = "Mac",
                    hosts = null,
                )
            },
            events = { _, _ -> emptyFlow() },
        )
        session.awaitRestored()

        val job = launch {
            session.pair(Connection(name = "Mac", host = "192.168.1.2", port = 8810), qr)
        }
        redeemStarted.await()
        job.cancel()
        advanceUntilIdle()
        assertTrue(job.isCancelled)
        assertNull(session.connection.value)

        assertFailsWith<SpentPairingCredentialException> {
            session.pair(Connection(name = "Mac", host = "192.168.1.2", port = 8810), qr)
        }
        assertEquals(1, attempts)
    }

    @Test
    fun unpairClearsLocalStateOnly() = runTest {
        val connection = Connection(id = "c1", name = "Mac", host = "192.168.1.2", port = 8810)
        val connections = FakeConnectionStore(connection)
        val tokens = FakeTokenStore().apply { saved["c1"] = "tok" }
        val session = session(
            connectionStore = connections,
            tokenStore = tokens,
            events = { _, _ -> emptyFlow() },
        )
        session.awaitRestored()
        session.signOutAndAwait()
        assertEquals(Session.Status.Unpaired, session.status.value)
        assertNull(connections.saved)
        assertTrue(tokens.saved.isEmpty())
    }

    @Test
    fun createRoomFoldsTheResultAndSurfacesFailure() = runTest {
        val server = MockWebServer()
        server.start()
        try {
            val connection = requireNotNull(Connection.parse(server.url("/").toString()))
            val tokens = FakeTokenStore().apply { saved[connection.id] = "tok" }
            val session = session(
                connectionStore = FakeConnectionStore(connection),
                tokenStore = tokens,
            )
            session.awaitRestored()

            server.enqueue(MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"group":${roomJson()}}"""))
            val room = session.createRoom("Launch Team", listOf("b1", "b2"))

            assertEquals("g-new", room?.id)
            assertEquals(room, session.state.value.rooms.single())
            assertEquals(emptyList(), session.state.value.transcript("t-new"))
            assertNull(session.actionError)

            server.enqueue(MockResponse()
                .setResponseCode(403)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"error":"Room creation is not allowed."}"""))
            assertNull(session.createRoom(null, listOf("b1")))
            assertEquals("Room creation is not allowed.", session.actionError)
            assertEquals(listOf("g-new"), session.state.value.rooms.map(Room::id))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun helloNotResumedHydratesBeforeCommittingCursor() = runTest {
        var hydrateCalls = 0
        var opens = 0
        val hang = MutableSharedFlow<StreamFrame>(extraBufferCapacity = 1)
        val session = session(
            connectionStore = FakeConnectionStore(
                Connection(id = "c1", name = "Mac", host = "127.0.0.1", port = 8810),
            ),
            tokenStore = FakeTokenStore().apply { saved["c1"] = "tok" },
            events = { _, _ ->
                opens++
                hang
            },
            hydrate = {
                hydrateCalls++
                Fleet(
                    bots = listOf(sampleBot(id = "b1", threadId = "t1")),
                    groups = emptyList(),
                )
            },
        )
        session.awaitRestored()
        session.connect()
        runCurrent()
        assertEquals(1, opens)
        hang.tryEmit(StreamFrame(Frame.Hello(cursor = "stream:7", resumed = false), seq = 0))
        runCurrent()
        yield()
        runCurrent()

        assertEquals(1, hydrateCalls)
        assertEquals("stream:7", session.state.value.cursor)
        assertEquals(1, session.state.value.bots.size)
        assertEquals(Session.Status.Live, session.status.value)
    }

    @Test
    fun disconnectMidHydrateDoesNotCommitCursorAndReconnectRequestsGap() = runTest {
        val hang = MutableSharedFlow<StreamFrame>(extraBufferCapacity = 1)
        val hydrateStarted = CompletableDeferred<Unit>()
        val hydrateRelease = CompletableDeferred<Unit>()
        val opens = mutableListOf<String?>()
        val session = session(
            connectionStore = FakeConnectionStore(
                Connection(id = "c1", name = "Mac", host = "127.0.0.1", port = 8810),
            ),
            tokenStore = FakeTokenStore().apply { saved["c1"] = "tok" },
            events = { since, _ ->
                opens += since
                hang
            },
            hydrate = {
                hydrateStarted.complete(Unit)
                hydrateRelease.await()
                Fleet(
                    bots = listOf(sampleBot(id = "b1", threadId = "t1")),
                    groups = emptyList(),
                )
            },
        )
        session.awaitRestored()
        session.connect()
        runCurrent()
        hang.tryEmit(StreamFrame(Frame.Hello(cursor = "stream:9", resumed = false), seq = 0))
        runCurrent()
        hydrateStarted.await()
        assertNull(session.state.value.cursor)

        session.disconnect()
        runCurrent()
        // Unblock any cancelled waiter without committing through a successful hydrate.
        hydrateRelease.cancel()
        assertNull(session.state.value.cursor)
        assertEquals(listOf<String?>(null), opens)

        session.connect()
        runCurrent()
        assertEquals(listOf<String?>(null, null), opens)
        assertNull(session.state.value.cursor)
    }

    @Test
    fun screenWatcherTurnsScreensOnAndLastCloseClears() = runTest {
        val hang = MutableSharedFlow<StreamFrame>(extraBufferCapacity = 4)
        val opens = mutableListOf<Pair<String?, Boolean>>()
        val session = session(
            connectionStore = FakeConnectionStore(
                Connection(id = "c1", name = "Mac", host = "127.0.0.1", port = 8810),
            ),
            tokenStore = FakeTokenStore().apply { saved["c1"] = "tok" },
            events = { since, screens ->
                opens += since to screens
                hang
            },
            hydrate = {
                Fleet(
                    bots = listOf(sampleBot(id = "b1", threadId = "t1")),
                    groups = emptyList(),
                )
            },
        )
        session.awaitRestored()
        session.connect()
        runCurrent()
        // Cold hello commits the cursor so a later screens reconnect can prove
        // the gap request keeps `since=` rather than resetting.
        hang.tryEmit(StreamFrame(Frame.Hello(cursor = "stream:1", resumed = false), seq = 0))
        runCurrent()
        yield()
        runCurrent()
        hang.tryEmit(
            StreamFrame(
                Frame.Screen(botId = "b1", png = "AA==", mime = "image/png"),
                seq = 2,
            ),
        )
        runCurrent()
        assertEquals(listOf<Pair<String?, Boolean>>(null to false), opens)
        assertTrue(session.state.value.screens.containsKey("b1"))
        // Screen frame advances the committed hello cursor — reconnect must
        // request this gap, not reset to null.
        assertEquals("stream:2", session.state.value.cursor)

        session.watchScreen("b1")
        advanceUntilIdle()
        runCurrent()
        assertEquals(
            listOf<Pair<String?, Boolean>>(null to false, "stream:2" to true),
            opens,
        )

        session.watchScreen("b1")
        advanceUntilIdle()
        assertEquals(2, opens.size)

        session.stopWatchingScreen("b1")
        advanceUntilIdle()
        assertEquals(2, opens.size)
        assertTrue(session.state.value.screens.containsKey("b1"))

        session.stopWatchingScreen("b1")
        advanceUntilIdle()
        runCurrent()
        assertEquals(
            listOf<Pair<String?, Boolean>>(
                null to false,
                "stream:2" to true,
                "stream:2" to false,
            ),
            opens,
        )
        assertTrue(session.state.value.screens.isEmpty())
    }

    @Test
    fun cleanStreamEndBacksOffOneTwoFourCappedAtFifteen() = runTest {
        var opens = 0
        val session = session(
            connectionStore = FakeConnectionStore(
                Connection(id = "c1", name = "Mac", host = "127.0.0.1", port = 8810),
            ),
            tokenStore = FakeTokenStore().apply { saved["c1"] = "tok" },
            events = { _, _ ->
                opens++
                emptyFlow() // clean end immediately
            },
        )
        session.awaitRestored()
        session.connect()
        runCurrent()
        assertEquals(1, opens)
        assertEquals(Session.Status.Offline("Lost the connection."), session.status.value)

        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(2, opens)

        advanceTimeBy(2_000)
        runCurrent()
        assertEquals(3, opens)

        advanceTimeBy(4_000)
        runCurrent()
        assertEquals(4, opens)

        advanceTimeBy(8_000)
        runCurrent()
        assertEquals(5, opens)

        advanceTimeBy(15_000)
        runCurrent()
        assertEquals(6, opens)
    }

    @Test
    fun unauthorizedDoesNotRetry() = runTest {
        var opens = 0
        val session = session(
            connectionStore = FakeConnectionStore(
                Connection(id = "c1", name = "Mac", host = "127.0.0.1", port = 8810),
            ),
            tokenStore = FakeTokenStore().apply { saved["c1"] = "tok" },
            events = { _, _ ->
                opens++
                flow { throw APIError.Status(401, "revoked") }
            },
        )
        session.awaitRestored()
        session.connect()
        advanceUntilIdle()
        advanceTimeBy(60_000)
        advanceUntilIdle()
        assertEquals(Session.Status.Unauthorized, session.status.value)
        assertEquals(1, opens)
    }

    @Test
    fun deliberateDisconnectIsNotRetried() = runTest {
        val hang = MutableSharedFlow<StreamFrame>(extraBufferCapacity = 1)
        var opens = 0
        val session = session(
            connectionStore = FakeConnectionStore(
                Connection(id = "c1", name = "Mac", host = "127.0.0.1", port = 8810),
            ),
            tokenStore = FakeTokenStore().apply { saved["c1"] = "tok" },
            events = { _, _ ->
                opens++
                hang
            },
        )
        session.awaitRestored()
        session.connect()
        runCurrent()
        hang.tryEmit(StreamFrame(Frame.Hello(cursor = "s:1", resumed = true), seq = 1))
        runCurrent()
        assertEquals(Session.Status.Live, session.status.value)

        session.disconnect()
        advanceTimeBy(60_000)
        advanceUntilIdle()
        assertEquals(1, opens)
    }

    @Test
    fun refreshWaitsUntilLeavingConnectingOrTenSeconds() = runTest {
        val hang = MutableSharedFlow<StreamFrame>()
        val session = session(
            connectionStore = FakeConnectionStore(
                Connection(id = "c1", name = "Mac", host = "127.0.0.1", port = 8810),
            ),
            tokenStore = FakeTokenStore().apply { saved["c1"] = "tok" },
            events = { _, _ -> hang },
        )
        session.awaitRestored()
        val job = launch { session.refresh() }
        runCurrent()
        assertEquals(Session.Status.Connecting, session.status.value)
        advanceTimeBy(9_999)
        assertTrue(job.isActive)
        advanceTimeBy(2)
        advanceUntilIdle()
        assertTrue(job.isCompleted)
    }

    @Test
    fun refreshWhileLiveRestartsAndWaitsForSettlement() = runTest {
        val hang = MutableSharedFlow<StreamFrame>(extraBufferCapacity = 2)
        var opens = 0
        val session = session(
            connectionStore = FakeConnectionStore(
                Connection(id = "c1", name = "Mac", host = "127.0.0.1", port = 8810),
            ),
            tokenStore = FakeTokenStore().apply { saved["c1"] = "tok" },
            events = { _, _ ->
                opens++
                hang
            },
        )
        session.awaitRestored()
        session.connect()
        runCurrent()
        hang.tryEmit(StreamFrame(Frame.Hello(cursor = "s:1", resumed = true), seq = 1))
        runCurrent()
        assertEquals(Session.Status.Live, session.status.value)
        assertEquals(1, opens)

        val job = launch { session.refresh() }
        runCurrent()
        assertEquals(Session.Status.Connecting, session.status.value)
        assertTrue(job.isActive)
        assertEquals(2, opens)

        hang.tryEmit(StreamFrame(Frame.Hello(cursor = "s:1", resumed = true), seq = 2))
        runCurrent()
        advanceUntilIdle()
        assertEquals(Session.Status.Live, session.status.value)
        assertTrue(job.isCompleted)
    }

    @Test
    fun notifyFramesUseDedupeContractViaSink() = runTest {
        val notifications = RecordingNotifications()
        val hang = MutableSharedFlow<StreamFrame>(extraBufferCapacity = 2)
        val session = session(
            connectionStore = FakeConnectionStore(
                Connection(id = "c1", name = "Mac", host = "127.0.0.1", port = 8810),
            ),
            tokenStore = FakeTokenStore().apply { saved["c1"] = "tok" },
            notifications = notifications,
            events = { _, _ -> hang },
        )
        session.awaitRestored()
        session.connect()
        runCurrent()
        hang.tryEmit(StreamFrame(Frame.Hello(cursor = "s:1", resumed = true), seq = 1))
        hang.tryEmit(
            StreamFrame(
                Frame.Notify(
                    NotificationFrame(
                        kind = "approval",
                        botId = "b1",
                        botName = "Scout",
                        threadId = "t1",
                        title = "Allow?",
                        body = "rm -rf",
                    ),
                ),
                seq = 42,
            ),
        )
        runCurrent()
        assertEquals(1, notifications.delivered.size)
        assertEquals(42, notifications.delivered.single().second)
    }

    @Test
    fun addressFailureWalksCandidates() {
        val failure = ConnectionAdvice.classify(ConnectException("refused"))
        assertEquals(ConnectionFailure.CANNOT_CONNECT_TO_HOST, failure)
        assertTrue(ConnectionAdvice.shouldTryAnotherHost(failure))
        val message = ConnectionAdvice.message(failure, "192.168.1.2", 8810, tryingNext = "mac.ts.net")
        assertTrue(message.contains("Trying mac.ts.net next."))
        assertTrue(message.contains("port 8810"))
    }

    private fun kotlinx.coroutines.test.TestScope.session(
        connectionStore: ConnectionStore = FakeConnectionStore(),
        tokenStore: TokenStore = FakeTokenStore(),
        pairFn: suspend (Connection, String, String) -> PairResponse = { _, _, _ -> error("pair not expected") },
        events: (String?, Boolean) -> Flow<StreamFrame> = { _, _ -> emptyFlow() },
        hydrate: suspend () -> Fleet = { Fleet(emptyList(), emptyList()) },
        notifications: NotificationSink = RecordingNotifications(),
    ): Session = Session(
        scope = backgroundScope,
        connectionStore = connectionStore,
        tokenStore = tokenStore,
        deviceNameProvider = { "Pixel" },
        notificationSink = notifications,
        clientFactory = { connection, token -> CompanionClient(connection, token) },
        pairFn = pairFn,
        eventsFn = { _, since, screens -> events(since, screens) },
        hydrateFn = { _, _ -> hydrate() },
    )

    private fun roomJson(): String = """{
        "id":"g-new",
        "threadId":"t-new",
        "name":"Launch Team",
        "memberIds":["b1","b2"],
        "defaultResponder":{"kind":"mentions"},
        "bulletin":"",
        "unread":false,
        "createdAt":3
    }""".trimIndent()
}

private fun sampleBot(id: String, threadId: String) = Bot(
    id = id,
    threadId = threadId,
    name = "Scout",
    title = "coder",
    description = "",
    notifications = true,
    color = "green",
    unread = false,
    modelSelection = ModelSelection("i", "m"),
    createdAt = 1.0,
)

private class FakeConnectionStore(
    initial: Connection? = null,
) : ConnectionStore {
    var saved: Connection? = initial
    override suspend fun load(): Connection? = saved
    override suspend fun save(connection: Connection) {
        saved = connection
    }
    override suspend fun clear() {
        saved = null
    }
}

private class FakeTokenStore : TokenStore {
    val saved = linkedMapOf<String, String>()
    val unavailable = linkedMapOf<String, TokenStore.ReadResult.Unavailable>()

    override suspend fun save(connectionId: String, token: String) {
        saved[connectionId] = token
        unavailable.remove(connectionId)
    }

    override suspend fun read(connectionId: String): TokenStore.ReadResult {
        unavailable[connectionId]?.let { return it }
        val token = saved[connectionId] ?: return TokenStore.ReadResult.Missing
        return TokenStore.ReadResult.Found(token)
    }

    override suspend fun remove(connectionId: String) {
        saved.remove(connectionId)
        unavailable.remove(connectionId)
    }
}

private class RecordingNotifications : NotificationSink {
    val delivered = mutableListOf<Pair<NotificationFrame, Int?>>()
    var lastBadge = 0
        private set
    override fun deliver(notification: NotificationFrame, sequence: Int?) {
        delivered += notification to sequence
    }
    override fun setBadge(count: Int) {
        lastBadge = count
    }
}
