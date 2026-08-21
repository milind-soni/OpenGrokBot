package com.openmausbot.companion.core

import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest

@OptIn(ExperimentalCoroutinesApi::class)
class SessionP1Test {
    private lateinit var server: MockWebServer

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @AfterTest
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun permissionAnswersUseTheSwiftBehaviorForOfferedProviderChoices() = runTest {
        val session = session()
        val chat = Chat.BotChat(bot("b1", "task-1", "task-1"))
        val choices = listOf("Approve", "Yes", "Always allow", "Deny", " \ndeny\t")
        val card = permissionCard(options = choices, allowKey = "Bash:git")
        repeat(choices.size) { server.enqueue(json("{}")) }

        choices.forEach { choice ->
            session.answer(chat, card, choice, rememberingPermission = false)
        }

        val requests = List(5) { server.takeRequest() }
        val bodies = requests.map(::body)
        assertEquals(
            listOf("allow", "allow", "allow", "deny", "deny"),
            bodies.map { it.getValue("behavior") },
        )
        assertEquals(
            List(5) { setOf("requestId", "behavior") },
            bodies.map { it.keys },
        )
        assertEquals(List(5) { "/api/threads/task-1/respond" }, requests.map { it.path })
    }

    @Test
    fun questionAnswersSendOnlyTheLiteralOptionsTheCardOffered() = runTest {
        val session = session()
        val chat = Chat.RoomChat(room("room-1", "room-thread"))
        val offered = listOf("Ship it", "Not yet\n")
        val card = OptionCard(
            title = "Release?",
            subtitle = "Choose",
            options = offered,
            requestId = "question-1",
        )
        repeat(offered.size) { server.enqueue(json("{}")) }

        session.answer(chat, card, "Ship it")
        session.answer(chat, card, "Not yet\n")

        val sent = List(2) { body(server.takeRequest()) }
        assertEquals(listOf("answer", "answer"), sent.map { it.getValue("behavior") })
        assertEquals(listOf("Ship it", "Not yet\n"), sent.map { it.getValue("message") })
        assertTrue(sent.all { it.keys == setOf("requestId", "behavior", "message") })
    }

    @Test
    fun failedStandingGrantUsesTheProviderKeyOnceAndStillAnswersOnce() = runTest {
        val session = session()
        val chat = Chat.BotChat(bot("b1", "task-1", "task-1"))
        val card = permissionCard(
            options = listOf("Always allow", "Deny"),
            allowKey = "Bash:git push",
        )
        server.enqueue(json("""{"error":"Could not save grant."}""", code = 500))
        server.enqueue(json("{}"))

        session.answer(chat, card, "Always allow")

        val grant = server.takeRequest()
        val answer = server.takeRequest()
        assertEquals("/api/bots/b1/always-allow", grant.path)
        assertEquals(mapOf("allowKey" to "Bash:git push"), body(grant))
        assertEquals("/api/threads/task-1/respond", answer.path)
        assertEquals(
            mapOf("requestId" to "request-1", "behavior" to "allow"),
            body(answer),
        )
        assertEquals(2, server.requestCount)
        assertEquals("Could not save grant.", session.actionError)
    }

    @Test
    fun missingKeyRoomAndDisabledMemoryNeverInventAStandingGrant() = runTest {
        val session = session()
        val bot = Chat.BotChat(bot("b1", "task-1", "task-1"))
        val room = Chat.RoomChat(room("room-1", "room-thread"))
        repeat(3) { server.enqueue(json("{}")) }

        session.answer(
            bot,
            permissionCard(options = listOf("Always allow", "Deny"), allowKey = null),
            "Always allow",
        )
        session.answer(
            bot,
            permissionCard(options = listOf("Always allow", "Deny"), allowKey = "Bash:git"),
            "Always allow",
            rememberingPermission = false,
        )
        session.answer(
            room,
            permissionCard(options = listOf("Always allow", "Deny"), allowKey = "Bash:git"),
            "Always allow",
        )

        val requests = List(3) { server.takeRequest() }
        assertEquals(
            listOf(
                "/api/threads/task-1/respond",
                "/api/threads/task-1/respond",
                "/api/threads/room-thread/respond",
            ),
            requests.map { it.path },
        )
        assertTrue(requests.all { body(it)["behavior"] == "allow" })
        assertEquals(3, server.requestCount)
    }

    @Test
    fun taskActionsApplyDesktopBotsAndTheStableTargetFollowsEveryTransition() = runTest {
        val initial = bot("b1", "task-1", "task-1", "old-inactive")
        val created = bot("b1", "task-2", "task-1", "old-inactive", "task-2")
        val switched = bot("b1", "task-1", "task-1", "old-inactive", "task-2")
        val inactiveDeleted = bot("b1", "task-1", "task-1", "task-2")
        val activeDeleted = bot("b1", "task-2", "task-2")
        val session = session { Fleet(listOf(initial), emptyList()) }
        val stableTarget = assertIs<Chat.BotChat>(
            session.openNotification(target("b1", "task-1")),
        ).target
        listOf(created, switched, inactiveDeleted, activeDeleted).forEach { returned ->
            server.enqueue(json("""{"bot":${CompanionJson.encodeToString(returned)}}"""))
        }

        session.createTask(initial, null)
        assertEquals("task-2", assertIs<Chat.BotChat>(session.state.value.chat(stableTarget)).threadId)

        session.switchTask(BotTask("task-1", "Task 1", 1.0), created)
        assertEquals("task-1", assertIs<Chat.BotChat>(session.state.value.chat(stableTarget)).threadId)

        session.deleteTask(BotTask("old-inactive", "Old", 0.0), switched)
        assertEquals("task-1", assertIs<Chat.BotChat>(session.state.value.chat(stableTarget)).threadId)

        session.deleteTask(BotTask("task-1", "Task 1", 1.0), inactiveDeleted)
        assertEquals("task-2", assertIs<Chat.BotChat>(session.state.value.chat(stableTarget)).threadId)
        assertEquals(
            listOf(
                "POST /api/bots/b1/tasks",
                "POST /api/bots/b1/tasks/task-1",
                "DELETE /api/bots/b1/tasks/old-inactive",
                "DELETE /api/bots/b1/tasks/task-1",
            ),
            List(4) { server.takeRequest().let { "${it.method} ${it.path}" } },
        )
    }

    @Test
    fun roomNotificationHydratesAndPrefersTheRoomThread() = runTest {
        var hydrates = 0
        val asker = bot("asker", "bot-task", "bot-task")
        val room = room("room-1", "room-thread")
        val session = session {
            hydrates++
            Fleet(listOf(asker), listOf(room))
        }

        val opened = session.openNotification(target("asker", "room-thread"))

        assertEquals("room-1", assertIs<Chat.RoomChat>(opened).id)
        assertEquals(1, hydrates)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun activeTaskNotificationHydratesWithoutSwitching() = runTest {
        var hydrates = 0
        val session = session {
            hydrates++
            Fleet(listOf(bot("b1", "task-1", "task-1", "task-2")), emptyList())
        }

        val opened = session.openNotification(target("b1", "task-1"))

        assertEquals("task-1", assertIs<Chat.BotChat>(opened).threadId)
        assertEquals(1, hydrates)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun inactiveTaskNotificationSwitchesOnceAndRepeatedOpenIsIdempotent() = runTest {
        var hydrates = 0
        val switched = bot("b1", "task-2", "task-1", "task-2")
        val session = session {
            hydrates++
            Fleet(listOf(bot("b1", "task-1", "task-1", "task-2")), emptyList())
        }
        server.enqueue(json("""{"bot":${CompanionJson.encodeToString(switched)}}"""))
        val target = target("b1", "task-2")

        val first = session.openNotification(target)
        val second = session.openNotification(target)

        assertEquals("task-2", assertIs<Chat.BotChat>(first).threadId)
        assertEquals("task-2", assertIs<Chat.BotChat>(second).threadId)
        assertEquals("task-2", session.state.value.bot("b1")?.threadId)
        assertEquals(1, hydrates)
        assertEquals(1, server.requestCount)
        assertEquals("POST /api/bots/b1/tasks/task-2", server.takeRequest().let { "${it.method} ${it.path}" })
    }

    @Test
    fun deletedTaskNotificationFallsBackToTheBotsCurrentChat() = runTest {
        val session = session {
            Fleet(listOf(bot("b1", "task-1", "task-1")), emptyList())
        }
        server.enqueue(json("""{"error":"Task not found."}""", code = 404))

        val opened = session.openNotification(target("b1", "deleted-task"))

        assertEquals("task-1", assertIs<Chat.BotChat>(opened).threadId)
        assertNull(session.actionError)
        assertEquals(1, server.requestCount)
        assertEquals("/api/bots/b1/tasks/deleted-task", server.takeRequest().path)
    }

    @Test
    fun deletedBotNotificationDoesNotChooseAnotherBotsMatchingTask() = runTest {
        val session = session {
            Fleet(
                listOf(bot("other", "other-active", "deleted-task", "other-active")),
                emptyList(),
            )
        }

        val opened = session.openNotification(target("deleted", "deleted-task"))

        assertNull(opened)
        assertEquals("That agent no longer exists.", session.actionError)
        assertEquals(0, server.requestCount)
    }

    private suspend fun TestScope.session(
        hydrate: suspend () -> Fleet = { Fleet(emptyList(), emptyList()) },
    ): Session {
        val connection = requireNotNull(Connection.parse(server.url("/").toString()))
        return Session(
            scope = backgroundScope,
            connectionStore = object : ConnectionStore {
                override suspend fun load(): Connection = connection
                override suspend fun save(connection: Connection) = Unit
                override suspend fun clear() = Unit
            },
            tokenStore = object : TokenStore {
                override suspend fun save(connectionId: String, token: String) = Unit
                override suspend fun read(connectionId: String): TokenStore.ReadResult =
                    TokenStore.ReadResult.Found("device-token")
                override suspend fun remove(connectionId: String) = Unit
            },
            deviceNameProvider = { "Pixel" },
            eventsFn = { _, _, _ -> emptyFlow() },
            hydrateFn = { _, _ -> hydrate() },
        ).also { it.awaitRestored() }
    }

    private fun target(botId: String, threadId: String): NotificationTarget =
        requireNotNull(NotificationTarget.from(botId, threadId))

    private fun permissionCard(options: List<String>, allowKey: String?): OptionCard = OptionCard(
        title = "Approval needed",
        subtitle = "git push",
        options = options,
        requestId = "request-1",
        tool = "Bash",
        allowKey = allowKey,
    )

    private fun bot(id: String, active: String, vararg tasks: String): Bot = Bot(
        id = id,
        threadId = active,
        name = id,
        title = "",
        description = "",
        notifications = true,
        color = "green",
        unread = false,
        modelSelection = ModelSelection("instance", "model"),
        createdAt = 1.0,
        tasks = tasks.mapIndexed { index, threadId ->
            BotTask(threadId, "Task ${index + 1}", index.toDouble())
        },
    )

    private fun room(id: String, threadId: String): Room = Room(
        id = id,
        threadId = threadId,
        name = id,
        memberIds = emptyList(),
        defaultResponder = GroupResponder("mentions"),
        bulletin = "",
        unread = false,
        createdAt = 1.0,
    )

    private fun json(body: String, code: Int = 200): MockResponse = MockResponse()
        .setResponseCode(code)
        .setHeader("Content-Type", "application/json")
        .setBody(body)

    private fun body(request: RecordedRequest): Map<String, String> =
        CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
            .mapValues { it.value.jsonPrimitive.content }
}
