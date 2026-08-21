package com.openmausbot.companion.core

import java.net.URI
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient

/**
 * Stream lifecycle, pairing restore, and actions — port of `ios/App/Session.swift`.
 *
 * Pure JVM: storage, device name, notifications, and HTTP are injected so the
 * state machine can be unit-tested with virtual time (`kotlinx-coroutines-test`).
 */
class Session(
    private val scope: CoroutineScope,
    private val connectionStore: ConnectionStore,
    private val tokenStore: TokenStore,
    private val deviceNameProvider: () -> String,
    private val notificationSink: NotificationSink = NoOpNotificationSink,
    private val httpClient: OkHttpClient = OkHttpClient(),
    private val clientFactory: (Connection, String?) -> CompanionClient = { connection, token ->
        CompanionClient(connection, token, httpClient)
    },
    private val pairFn: suspend (Connection, String, String) -> PairResponse = { connection, credential, deviceName ->
        CompanionClient.pair(connection, credential, deviceName, httpClient)
    },
    /** Test seam: override the SSE Flow without subclassing [CompanionClient]. */
    private val eventsFn: (CompanionClient, String?, Boolean) -> Flow<StreamFrame> = { client, since, screens ->
        client.events(since, screens)
    },
    /** Test seam: override fleet hydrate. */
    private val hydrateFn: suspend (CompanionClient, Int?) -> Fleet = { client, messages ->
        client.fleet(messages)
    },
) {
    sealed interface Status {
        data object Unpaired : Status
        data object Connecting : Status
        data object Live : Status
        data object Unauthorized : Status
        data class Offline(val message: String) : Status
    }

    sealed interface RestoreState {
        data object Pending : RestoreState
        data object Ready : RestoreState
        data object Unpaired : RestoreState
    }

    private val _state = MutableStateFlow(CompanionState())
    val state: StateFlow<CompanionState> = _state.asStateFlow()

    private val _connection = MutableStateFlow<Connection?>(null)
    val connection: StateFlow<Connection?> = _connection.asStateFlow()

    private val _status = MutableStateFlow<Status>(Status.Unpaired)
    val status: StateFlow<Status> = _status.asStateFlow()

    private val _restoreState = MutableStateFlow<RestoreState>(RestoreState.Pending)
    val restoreState: StateFlow<RestoreState> = _restoreState.asStateFlow()

    private val _actionError = MutableStateFlow<String?>(null)
    var actionError: String?
        get() = _actionError.value
        set(value) { _actionError.value = value }
    val actionErrorFlow: StateFlow<String?> = _actionError.asStateFlow()

    private val _focusedMessageId = MutableStateFlow<String?>(null)
    val focusedMessageId: StateFlow<String?> = _focusedMessageId.asStateFlow()

    private val _pairingInvite = MutableStateFlow<PairingInvite?>(null)
    val pairingInvite: StateFlow<PairingInvite?> = _pairingInvite.asStateFlow()

    private var client: CompanionClient? = null
    private var token: String? = null
    private var rotation = CandidateRotation(emptyList())
    private var streamJob: Job? = null
    private var streamGeneration = 0
    private var reconnectDelaySeconds: Long = 0
    private var screenWatchers = 0
    private val gate = Mutex()
    private val notificationGate = Mutex()
    private val restored = CompletableDeferred<Unit>()
    /** QR credentials that already failed a redeem — never replay (§6). */
    private val spentQrCredentials = mutableSetOf<String>()

    init {
        scope.launch {
            try {
                restore()
            } finally {
                restored.complete(Unit)
            }
        }
    }

    /** Wait until the launch-time restore attempt has finished (tests / connect). */
    suspend fun awaitRestored() {
        restored.await()
    }

    /** Rebuild the last connection at launch — three outcomes match iOS Keychain restore. */
    private suspend fun restore() = gate.withLock {
        restoreLocked()
    }

    /**
     * Redeem a one-time pairing credential. Persists only the long-lived device
     * token + connection — never the QR credential/code.
     *
     * Rejects when a pairing already exists (including a locked-token restore)
     * or when another [pair] is already in the redeem+persist critical section —
     * concurrent callers must not silently replace a pairing.
     *
     * High-entropy QR credentials are burned at the point of no return (before
     * the redeem request) so a successful remote redeem followed by a save
     * failure, or cancellation after the request may have been sent, cannot
     * leave a spent QR reusable. Six-digit codes remain retryable.
     */
    suspend fun pair(connection: Connection, credential: String) {
        awaitRestored()
        gate.withLock {
            if (isPairedLocked()) {
                _actionError.value = ALREADY_PAIRED_MESSAGE
                throw AlreadyPairedException()
            }
            if (isQrCredential(credential) && credential in spentQrCredentials) {
                _actionError.value = SPENT_QR_MESSAGE
                clearInviteIfCredential(credential)
                throw SpentPairingCredentialException()
            }

            // Point of no return for high-entropy QR: once redeem runs the
            // server may consume it regardless of later save/cancel outcomes.
            val qr = isQrCredential(credential)
            if (qr) burnQrCredential(credential)

            val deviceName = deviceNameProvider()
            val paired = try {
                pairFn(connection, credential, deviceName)
            } catch (error: Throwable) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                _actionError.value = if (qr) qrFailureMessage(error) else error.message
                throw error
            }
            var stored = connection
            if (paired.serverName.isNotEmpty()) stored = stored.copy(name = paired.serverName)
            if (!paired.hosts.isNullOrEmpty()) stored = stored.copy(hosts = paired.hosts)
            stored = stored.promoting(stored.host)

            try {
                tokenStore.save(stored.id, paired.token)
                connectionStore.save(stored)
            } catch (error: Throwable) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                _actionError.value = if (qr) qrFailureMessage(error) else error.message
                throw error
            }

            _connection.value = stored
            token = paired.token
            rotation = CandidateRotation(stored.orderedHosts)
            client = clientFactory(stored, paired.token)
            _state.value = CompanionState()
            _restoreState.value = RestoreState.Ready
            _pairingInvite.value = null
        }
        connect()
    }

    suspend fun pair(invite: PairingInvite) = pair(invite.connection, invite.credential)

    /**
     * Accept a deep-link invite only after restore has settled and only while
     * unpaired. Cold-start links wait for restore so they cannot overwrite a
     * pairing that is still loading.
     */
    fun receivePairingURL(url: String) {
        if (restored.isCompleted) {
            acceptPairingURL(url)
            return
        }
        scope.launch {
            restored.await()
            acceptPairingURL(url)
        }
    }

    fun receivePairingURI(uri: URI) = receivePairingURL(uri.toString())

    fun consumePairingInvite() {
        _pairingInvite.value = null
    }

    private fun acceptPairingURL(url: String) {
        if (isPairedLocked()) {
            _actionError.value = ALREADY_PAIRED_MESSAGE
            return
        }
        val invite = PairingInvite.parse(url)
        if (invite == null) {
            _actionError.value = "That pairing invitation is not valid. Start pairing again on your computer."
            return
        }
        if (isQrCredential(invite.credential) && invite.credential in spentQrCredentials) {
            _actionError.value = SPENT_QR_MESSAGE
            return
        }
        _pairingInvite.value = invite
    }

    /** True when a computer is already bound — including locked-token restore. */
    private fun isPairedLocked(): Boolean =
        _connection.value != null ||
            token != null ||
            client != null ||
            _restoreState.value is RestoreState.Pending ||
            _status.value !is Status.Unpaired

    private fun burnQrCredential(credential: String) {
        spentQrCredentials += credential
        clearInviteIfCredential(credential)
    }

    private fun clearInviteIfCredential(credential: String) {
        val current = _pairingInvite.value
        if (current?.credential == credential) {
            _pairingInvite.value = null
        }
    }

    private fun qrFailureMessage(error: Throwable): String {
        val base = error.message?.takeIf { it.isNotBlank() } ?: "Pairing failed."
        return "$base Start pairing again on your computer and rescan the new QR code."
    }

    fun signOut() {
        streamJob?.cancel()
        streamJob = null
        scope.launch {
            gate.withLock {
                _restoreState.value = RestoreState.Unpaired
                _connection.value?.id?.let { tokenStore.remove(it) }
                connectionStore.clear()
                _connection.value = null
                client = null
                token = null
                rotation = CandidateRotation(emptyList())
                _state.value = CompanionState()
                notificationSink.setBadge(0)
                _status.value = Status.Unpaired
            }
        }
    }

    /** Suspending unpair for tests / callers that need completion. */
    suspend fun signOutAndAwait() {
        streamJob?.cancel()
        streamJob = null
        gate.withLock {
            _restoreState.value = RestoreState.Unpaired
            _connection.value?.id?.let { tokenStore.remove(it) }
            connectionStore.clear()
            _connection.value = null
            client = null
            token = null
            rotation = CandidateRotation(emptyList())
            _state.value = CompanionState()
            notificationSink.setBadge(0)
            _status.value = Status.Unpaired
        }
    }

    /** Called when the app comes to the front, and once at launch. */
    fun connect() {
        scope.launch {
            restored.await()
            val generation = gate.withLock {
                if (client == null && _restoreState.value is RestoreState.Pending) {
                    restoreLocked()
                }
                if (client == null || streamJob != null) return@withLock null
                reconnectDelaySeconds = 0
                streamGeneration += 1
                streamGeneration
            } ?: return@launch
            val job = scope.launch {
                try {
                    runStream()
                } finally {
                    gate.withLock {
                        if (streamGeneration == generation) {
                            streamJob = null
                        }
                    }
                }
            }
            gate.withLock { streamJob = job }
        }
    }

    private suspend fun restoreLocked() {
        val saved = connectionStore.load()
        if (saved == null) {
            _restoreState.value = RestoreState.Unpaired
            return
        }
        when (val stored = tokenStore.read(saved.id)) {
            is TokenStore.ReadResult.Unavailable -> {
                _connection.value = saved
                _restoreState.value = RestoreState.Pending
                _status.value = Status.Offline(
                    if (stored.locked) {
                        "Unlock this phone to reach your computer."
                    } else {
                        stored.message
                    },
                )
            }
            TokenStore.ReadResult.Missing -> {
                _restoreState.value = RestoreState.Unpaired
            }
            is TokenStore.ReadResult.Found -> {
                _connection.value = saved
                token = stored.token
                rotation = CandidateRotation(saved.orderedHosts)
                client = clientFactory(saved, stored.token)
                _restoreState.value = RestoreState.Ready
                _status.value = Status.Connecting
            }
        }
    }

    /**
     * Pull-to-refresh: reopen the stream and wait until status leaves connecting
     * or 10s — so the spinner means what it appears to mean.
     *
     * Restarts under the session mutex (not a fire-and-forget enqueue) so a
     * caller on any dispatcher observes Connecting before the wait loop runs.
     */
    suspend fun refresh() {
        awaitRestored()
        gate.withLock {
            if (client == null && _restoreState.value is RestoreState.Pending) {
                restoreLocked()
            }
            if (client == null) return@withLock
            streamJob?.cancel()
            streamJob = null
            reconnectDelaySeconds = 0
            streamGeneration += 1
            val generation = streamGeneration
            _status.value = Status.Connecting
            val job = scope.launch {
                try {
                    runStream()
                } finally {
                    gate.withLock {
                        if (streamGeneration == generation) {
                            streamJob = null
                        }
                    }
                }
            }
            streamJob = job
        }
        withTimeoutOrNull(10_000) {
            while (_status.value is Status.Connecting && currentCoroutineContext().isActive) {
                delay(120)
            }
        }
    }

    fun watchScreen(ofBotId: String) {
        scope.launch {
            gate.withLock {
                screenWatchers += 1
                if (screenWatchers == 1) restartStreamLocked()
            }
        }
    }

    fun stopWatchingScreen(ofBotId: String) {
        scope.launch {
            gate.withLock {
                screenWatchers = maxOf(0, screenWatchers - 1)
                if (screenWatchers == 0) {
                    _state.update { it.clearScreen(ofBotId) }
                    restartStreamLocked()
                }
            }
        }
    }

    private fun restartStream() {
        scope.launch {
            gate.withLock { restartStreamLocked() }
        }
    }

    private fun restartStreamLocked() {
        if (streamJob == null) return
        streamJob?.cancel()
        streamJob = null
        if (client == null) return
        reconnectDelaySeconds = 0
        streamGeneration += 1
        val generation = streamGeneration
        // Launch without holding the mutex across runStream — the job handle is
        // published immediately so a concurrent connect() sees it.
        val job = scope.launch {
            try {
                runStream()
            } finally {
                gate.withLock {
                    if (streamGeneration == generation) {
                        streamJob = null
                    }
                }
            }
        }
        streamJob = job
    }

    /** Called when the app leaves the screen — deliberate disconnect so the cursor is known. */
    fun disconnect() {
        streamJob?.cancel()
        streamJob = null
    }

    private suspend fun runStream() {
        while (currentCoroutineContext().isActive) {
            val activeClient = client ?: return
            _status.value = Status.Connecting
            try {
                eventsFn(activeClient, _state.value.cursor, screenWatchers > 0)
                    .collect { frame ->
                        currentCoroutineContext().ensureActive()
                        reconnectDelaySeconds = 0

                        when (val payload = frame.frame) {
                            is Frame.Hello -> {
                                if (!payload.resumed) {
                                    hydrate()
                                    _state.update { it.resetCursor(payload.cursor) }
                                }
                                _status.value = Status.Live
                                promoteWorkingHost()
                            }
                            else -> {
                                _state.update { it.apply(frame) }
                                if (payload is Frame.Notify) {
                                    notificationSink.deliver(payload.notification, frame.seq)
                                }
                                notificationSink.setBadge(_state.value.unreadCount)
                                _state.update { it.advance(frame.seq) }
                            }
                        }
                    }
                // Clean stream end — harness went away
                _status.value = Status.Offline("Lost the connection.")
            } catch (error: Throwable) {
                if (!currentCoroutineContext().isActive || error is kotlinx.coroutines.CancellationException) {
                    return
                }
                val apiError = error as? APIError
                if (apiError?.isUnauthorized == true) {
                    _status.value = Status.Unauthorized
                    return
                }
                _status.value = Status.Offline(failureMessage(error))
            }

            if (!currentCoroutineContext().isActive) return
            reconnectDelaySeconds = if (reconnectDelaySeconds == 0L) 1L else minOf(reconnectDelaySeconds * 2, 15L)
            delay(reconnectDelaySeconds * 1_000)
        }
    }

    private suspend fun hydrate() {
        val activeClient = client ?: return
        val fleet = hydrateFn(activeClient, 50)
        _state.update { it.hydrate(fleet) }
        notificationSink.setBadge(_state.value.unreadCount)
    }

    private fun failureMessage(error: Throwable): String {
        val connection = _connection.value
            ?: return error.message?.takeIf { it.isNotBlank() } ?: "Could not reach the computer."
        val failure = ConnectionAdvice.classify(error)
        val failed = rotation.current.ifEmpty { connection.host }
        var next: String? = null
        if (ConnectionAdvice.shouldTryAnotherHost(failure) && rotation.count > 1) {
            val candidate = rotation.advance()
            val activeToken = token
            if (activeToken != null) {
                client = clientFactory(connection.dialing(candidate), activeToken)
            }
            next = candidate
        }
        return if (failure == ConnectionFailure.OTHER) {
            error.message?.takeIf { it.isNotBlank() }
                ?: ConnectionAdvice.message(failure, failed, connection.port, next)
        } else {
            ConnectionAdvice.message(failure, failed, connection.port, next)
        }
    }

    private suspend fun promoteWorkingHost() {
        val winner = rotation.current
        val updated = _connection.value ?: return
        if (winner.isEmpty() || updated.host == Connection.urlHost(winner)) return
        val promoted = updated.promoting(winner)
        _connection.value = promoted
        connectionStore.save(promoted)
    }

    /** Replace the stored address by hand, keeping the pairing and its token. */
    fun updateAddress(text: String): Boolean {
        val parsed = Connection.parse(text) ?: return false
        val current = _connection.value ?: return false
        val updated = current.copy(port = parsed.port).promoting(parsed.host)
        scope.launch {
            gate.withLock {
                _connection.value = updated
                connectionStore.save(updated)
                rotation = CandidateRotation(updated.orderedHosts)
                val activeToken = token
                if (activeToken != null) {
                    client = clientFactory(updated, activeToken)
                }
                restartStreamLocked()
            }
        }
        return true
    }

    suspend fun updateAddressAndAwait(text: String): Boolean {
        val parsed = Connection.parse(text) ?: return false
        val current = _connection.value ?: return false
        val updated = current.copy(port = parsed.port).promoting(parsed.host)
        gate.withLock {
            _connection.value = updated
            connectionStore.save(updated)
            rotation = CandidateRotation(updated.orderedHosts)
            val activeToken = token
            if (activeToken != null) {
                client = clientFactory(updated, activeToken)
            }
            restartStreamLocked()
        }
        return true
    }

    // MARK: - Actions

    suspend fun send(text: String, to: Chat) {
        perform {
            when (to) {
                is Chat.BotChat -> it.sendToBot(to.bot.id, text)
                is Chat.RoomChat -> it.sendToRoom(to.room.id, text)
            }
        }
    }

    suspend fun answer(
        chat: Chat,
        card: OptionCard,
        choice: String,
        rememberingPermission: Boolean = true,
    ) {
        val requestId = card.requestId ?: return
        if (
            rememberingPermission &&
            card.shouldRememberPermission(choice) &&
            chat is Chat.BotChat
        ) {
            alwaysAllow(chat.bot, card)
        }
        answer(chat.threadId, requestId, choice, card.isPermission)
    }

    /**
     * Answers [card] in [threadId] using the card's permission-aware response behavior.
     *
     * This overload cannot persist a standing permission grant because it has no [Chat], and thus no
     * bot. Call sites must migrate to the [answer] overload that accepts a [Chat].
     */
    @Deprecated(
        message = "Use the answer(Chat, OptionCard, String) overload so standing grants can be persisted.",
        level = DeprecationLevel.WARNING,
    )
    suspend fun answer(threadId: String, card: OptionCard, choice: String) {
        val requestId = card.requestId ?: return
        answer(threadId, requestId, choice, card.isPermission)
    }

    suspend fun answer(
        threadId: String,
        requestId: String,
        choice: String,
        isPermission: Boolean,
    ) {
        perform {
            val behavior = OptionCard.responseBehavior(choice, isPermission)
            it.respond(
                threadId = threadId,
                requestId = requestId,
                behavior = behavior,
                message = choice.takeIf { behavior == "answer" },
            )
        }
    }

    suspend fun alwaysAllow(bot: Bot, card: OptionCard) {
        val key = card.allowKey ?: return
        perform { it.alwaysAllow(bot.id, key) }
    }

    suspend fun createBot(): Bot? {
        val activeClient = client ?: return null
        return try {
            val bot = activeClient.createBot()
            _state.update { it.apply(Frame.Bot(bot)) }
            bot
        } catch (error: Throwable) {
            _actionError.value = error.message
            null
        }
    }

    suspend fun createRoom(name: String?, memberIds: List<String>): Room? {
        val activeClient = client ?: return null
        return try {
            val room = activeClient.createRoom(name, memberIds)
            _state.update { it.apply(Frame.Room(room)) }
            room
        } catch (error: Throwable) {
            _actionError.value = error.message
            null
        }
    }

    suspend fun interrupt(bot: Bot) {
        perform { it.interrupt(bot.id) }
    }

    suspend fun cloudDesktop(forBot: Bot): URI {
        val activeClient = client ?: throw APIError.Transport("This computer is offline.")
        return try {
            activeClient.cloudDesktop(forBot.id).url
        } catch (error: APIError) {
            if (error.isUnauthorized) _status.value = Status.Unauthorized
            throw error
        }
    }

    suspend fun markRead(chat: Chat) {
        perform(quietly = true) {
            when (chat) {
                is Chat.BotChat -> it.markBotRead(chat.bot.id)
                is Chat.RoomChat -> it.markRoomRead(chat.room.id)
            }
        }
    }

    suspend fun loadOlder(threadId: String) {
        val activeClient = client ?: return
        val oldest = _state.value.transcript(threadId).firstOrNull() ?: return
        try {
            val page = activeClient.messages(threadId, before = oldest.id, limit = 50)
            _state.update { it.prepend(page, threadId) }
        } catch (error: Throwable) {
            _actionError.value = error.message
        }
    }

    suspend fun image(threadId: String, messageId: String): ByteArray? =
        try {
            client?.image(threadId, messageId)
        } catch (_: Throwable) {
            null
        }

    suspend fun search(query: String): List<SearchHit> {
        val trimmed = query.trim()
        if (trimmed.length < 2) return emptyList()
        val activeClient = client ?: return emptyList()
        return try {
            activeClient.search(trimmed)
        } catch (error: Throwable) {
            _actionError.value = error.message
            emptyList()
        }
    }

    suspend fun open(hit: SearchHit): Chat? {
        val activeClient = client ?: return null
        return try {
            val botId = hit.botId
            if (botId != null) {
                var bot = _state.value.bot(botId) ?: return null
                if (bot.threadId != hit.threadId) {
                    bot = activeClient.switchTask(bot.id, hit.threadId)
                    _state.update { it.apply(Frame.Bot(bot)) }
                }
                if (!hit.onActivePath) {
                    val leaf = activeClient.setActiveBranch(bot.id, hit.messageId)
                    _state.update { it.apply(Frame.Thread(hit.threadId, leaf)) }
                }
                val page = activeClient.messagesAround(hit.threadId, hit.messageId)
                _state.update { it.merge(page, hit.threadId) }
                _focusedMessageId.value = hit.messageId
                return _state.value.bot(bot.id)?.let { Chat.BotChat(it) }
            }
            val groupId = hit.groupId
            if (groupId != null) {
                val room = _state.value.rooms.firstOrNull { it.id == groupId } ?: return null
                val page = activeClient.messagesAround(hit.threadId, hit.messageId)
                _state.update { it.merge(page, hit.threadId) }
                _focusedMessageId.value = hit.messageId
                return Chat.RoomChat(room)
            }
            null
        } catch (error: Throwable) {
            _actionError.value = error.message
            null
        }
    }

    suspend fun openNotification(target: NotificationTarget): Chat? {
        awaitRestored()
        return notificationGate.withLock {
            val activeClient = client
            if (activeClient == null) {
                _actionError.value = "Pair this phone with your computer to open that task."
                return@withLock null
            }

            try {
                _state.value.roomForThread(target.threadId)?.let {
                    return@withLock Chat.RoomChat(it)
                }

                var bot = _state.value.bot(target.botId)
                if (bot == null) {
                    val fleet = hydrateFn(activeClient, 50)
                    _state.update { it.hydrate(fleet) }
                    notificationSink.setBadge(_state.value.unreadCount)
                    _state.value.roomForThread(target.threadId)?.let {
                        return@withLock Chat.RoomChat(it)
                    }
                    bot = _state.value.bot(target.botId)
                }

                var selected = bot
                    ?: throw APIError.Status(404, "That agent no longer exists.")
                if (target.requiresTaskSwitch(selected.threadId)) {
                    try {
                        selected = activeClient.switchTask(selected.id, target.threadId)
                        _state.update { it.apply(Frame.Bot(selected)) }
                    } catch (error: Throwable) {
                        if (error is kotlinx.coroutines.CancellationException) throw error
                        // The requested task can disappear between notification delivery and the tap.
                    }
                }
                Chat.BotChat(selected)
            } catch (error: Throwable) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                _actionError.value = error.message
                null
            }
        }
    }

    fun consumeFocus(messageId: String) {
        if (_focusedMessageId.value == messageId) _focusedMessageId.value = null
    }

    suspend fun createTask(forBot: Bot, title: String?) {
        val activeClient = client ?: return
        try {
            _state.update { it.apply(Frame.Bot(activeClient.createTask(forBot.id, title))) }
        } catch (error: Throwable) {
            _actionError.value = error.message
        }
    }

    suspend fun switchTask(task: BotTask, forBot: Bot) {
        if (task.threadId == forBot.threadId) return
        val activeClient = client ?: return
        try {
            _state.update { it.apply(Frame.Bot(activeClient.switchTask(forBot.id, task.threadId))) }
        } catch (error: Throwable) {
            _actionError.value = error.message
        }
    }

    suspend fun renameTask(task: BotTask, forBot: Bot, title: String) {
        val activeClient = client ?: return
        try {
            activeClient.renameTask(forBot.id, task.threadId, title)
            refresh()
        } catch (error: Throwable) {
            _actionError.value = error.message
        }
    }

    suspend fun deleteTask(task: BotTask, forBot: Bot) {
        val activeClient = client ?: return
        try {
            _state.update { it.apply(Frame.Bot(activeClient.deleteTask(forBot.id, task.threadId))) }
        } catch (error: Throwable) {
            _actionError.value = error.message
        }
    }

    suspend fun updateProfile(patch: BotProfilePatch, forBot: Bot): Bot? {
        val activeClient = client ?: return null
        return try {
            val updated = activeClient.updateProfile(forBot.id, patch)
            currentCoroutineContext().ensureActive()
            _state.update { it.apply(Frame.Bot(updated)) }
            updated
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun uploadAvatar(
        data: ByteArray,
        mime: String,
        forBot: Bot,
        crop: AvatarCrop,
    ): Bot? {
        val activeClient = client ?: return null
        return try {
            val avatarUrl = activeClient.uploadAvatar(data, mime)
            currentCoroutineContext().ensureActive()
            val current = _state.value.bot(forBot.id) ?: forBot
            updateProfile(
                BotProfilePatch(
                    avatarUrl = BotProfilePatch.AvatarURL.Set(avatarUrl),
                    avatarCrop = crop,
                ),
                current,
            )
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun generateAvatar(prompt: String, forBot: Bot): Bot? {
        val activeClient = client ?: return null
        return try {
            val updated = activeClient.generateAvatar(forBot.id, prompt)
            currentCoroutineContext().ensureActive()
            _state.update { it.apply(Frame.Bot(updated)) }
            updated
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun avatarData(forBot: Bot): ByteArray? {
        val path = forBot.avatarUrl ?: return null
        return try {
            client?.avatar(path)
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            null
        }
    }

    suspend fun voiceOptions(): List<Voice> {
        val activeClient = client ?: return emptyList()
        return try {
            activeClient.voices()
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            emptyList()
        }
    }

    suspend fun previewVoice(voiceId: String, forBot: Bot): ByteArray? {
        val activeClient = client ?: return null
        return try {
            activeClient.previewVoice("Hello, I'm ${forBot.name}.", voiceId)
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun configStatus(): ConfigStatus? = try {
        client?.config()
    } catch (error: Throwable) {
        if (error is kotlinx.coroutines.CancellationException) throw error
        null
    }

    suspend fun loadRoutines(): RoutinesResponse {
        val activeClient = client ?: return RoutinesResponse(emptyList(), emptyList())
        return try {
            activeClient.routines()
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            RoutinesResponse(emptyList(), emptyList())
        }
    }

    suspend fun loadRoutineRunAvailability(): RoutineRunAvailability? {
        val activeClient = client ?: return null
        return try {
            coroutineScope {
                val config = async { activeClient.config() }
                val instances = async { activeClient.instances() }
                RoutineRunAvailability(config.await(), instances.await())
            }
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun saveRoutine(input: RoutineInput, id: String?): Routine? {
        val activeClient = client ?: return null
        return try {
            if (id == null) activeClient.createRoutine(input) else activeClient.updateRoutine(id, input)
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun setRoutineEnabled(routine: Routine, enabled: Boolean): Routine? {
        val activeClient = client ?: return null
        return try {
            activeClient.setRoutineEnabled(routine.id, enabled)
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun runRoutine(routine: Routine): RoutineRun? {
        val activeClient = client ?: return null
        return try {
            activeClient.runRoutine(routine.id)
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun deleteRoutine(routine: Routine): Boolean {
        val activeClient = client ?: return false
        return try {
            activeClient.deleteRoutine(routine.id)
            true
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            false
        }
    }

    suspend fun react(to: Message, inThreadId: String, emoji: String) {
        val activeClient = client ?: return
        try {
            val patched = activeClient.toggleReaction(inThreadId, to.id, emoji)
            _state.update { it.apply(Frame.MessagePatch(inThreadId, patched)) }
        } catch (error: Throwable) {
            _actionError.value = error.message
        }
    }

    suspend fun edit(message: Message, forBot: Bot, text: String) {
        perform { it.edit(forBot.id, message.id, text) }
    }

    suspend fun switchVersion(to: Message, forBot: Bot) {
        val activeClient = client ?: return
        try {
            val leaf = activeClient.setActiveBranch(forBot.id, to.id)
            _state.update { it.apply(Frame.Thread(forBot.threadId, leaf)) }
        } catch (error: Throwable) {
            _actionError.value = error.message
        }
    }

    suspend fun export(threadId: String, format: String): ExportedTranscript? {
        val activeClient = client ?: return null
        return try {
            val exported = activeClient.export(threadId, format)
            ExportedTranscript(exported.data, exported.filename, exported.contentType)
        } catch (error: Throwable) {
            _actionError.value = error.message
            null
        }
    }

    private suspend fun perform(quietly: Boolean = false, body: suspend (CompanionClient) -> Unit) {
        val activeClient = client ?: return
        try {
            body(activeClient)
        } catch (error: APIError) {
            if (error.isUnauthorized) {
                _status.value = Status.Unauthorized
            } else if (!quietly) {
                _actionError.value = error.message
            }
        } catch (error: Throwable) {
            if (!quietly) _actionError.value = error.message
        }
    }

    companion object {
        const val ALREADY_PAIRED_MESSAGE =
            "This phone is already paired. Unpair it in Settings before connecting it to another computer."
        const val SPENT_QR_MESSAGE =
            "That pairing code was already used. Start pairing again on your computer and rescan the new QR code."

        /** High-entropy QR token — distinct from a retryable six-digit code. */
        fun isQrCredential(credential: String): Boolean =
            credential.startsWith("omb_pair_") ||
                !(credential.length == 6 && credential.all { it in '0'..'9' })
    }
}

/** Thrown by [Session.pair] when a computer is already bound. */
class AlreadyPairedException : IllegalStateException(Session.ALREADY_PAIRED_MESSAGE)

/** Thrown when a burned QR credential is presented again. */
class SpentPairingCredentialException : IllegalStateException(Session.SPENT_QR_MESSAGE)
