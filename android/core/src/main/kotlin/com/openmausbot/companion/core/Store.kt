package com.openmausbot.companion.core

data class PendingApproval(val threadId: String, val message: Message)

data class CompanionState(
    val bots: List<Bot> = emptyList(),
    val rooms: List<Room> = emptyList(),
    val messages: Map<String, List<Message>> = emptyMap(),
    val hasMore: Map<String, Boolean> = emptyMap(),
    val cursor: String? = null,
    val notifications: List<NotificationFrame> = emptyList(),
    val streaming: Map<String, String> = emptyMap(),
    val reasoning: Map<String, String> = emptyMap(),
    val screens: Map<String, ScreenFrame> = emptyMap(),
) {
    fun transcript(threadId: String): List<Message> = messages[threadId].orEmpty()

    fun visibleTranscript(threadId: String): List<Message> {
        val all = transcript(threadId)
        val leafId = botForThread(threadId)?.activeLeafId ?: return all
        val byId = all.associateBy(Message::id)
        var current = byId[leafId] ?: return all
        val visible = mutableListOf<Message>()
        val visited = mutableSetOf<String>()
        while (visited.add(current.id)) {
            visible += current
            val parentId = current.parentId ?: break
            current = byId[parentId] ?: break
        }
        return visible.asReversed()
    }

    fun bot(id: String): Bot? = bots.firstOrNull { it.id == id }
    fun botForThread(threadId: String): Bot? = bots.firstOrNull { it.threadId == threadId }
    fun roomForThread(threadId: String): Room? = rooms.firstOrNull { it.threadId == threadId }

    val pendingApprovals: List<PendingApproval>
        get() = (bots.map(Bot::threadId) + rooms.map(Room::threadId))
            .flatMap { threadId ->
                visibleTranscript(threadId)
                    .filter { it.card?.isPending == true }
                    .map { PendingApproval(threadId, it) }
            }
            .sortedByDescending { it.message.at }

    val unreadCount: Int
        get() = bots.count { it.unread && it.hidden != true } + rooms.count(Room::unread)

    fun hydrate(fleet: Fleet): CompanionState {
        val hydratedMessages = buildMap {
            fleet.bots.forEach { put(it.threadId, it.messages.orEmpty()) }
            fleet.groups.forEach { put(it.threadId, it.messages.orEmpty()) }
        }
        val hydratedHasMore = buildMap {
            fleet.bots.forEach { put(it.threadId, it.hasMore ?: false) }
            fleet.groups.forEach { put(it.threadId, it.hasMore ?: false) }
        }
        return copy(
            bots = fleet.bots,
            rooms = fleet.groups,
            messages = hydratedMessages,
            hasMore = hydratedHasMore,
        )
    }

    fun prepend(page: ThreadPage, threadId: String): CompanionState {
        val existing = messages[threadId].orEmpty()
        val known = existing.mapTo(mutableSetOf(), Message::id)
        return copy(
            messages = messages + (threadId to (page.messages.filterNot { it.id in known } + existing)),
            hasMore = hasMore + (threadId to (page.hasMore ?: false)),
        )
    }

    fun merge(page: ThreadPage, threadId: String): CompanionState {
        val byId = transcript(threadId).associateByTo(linkedMapOf(), Message::id)
        page.messages.forEach { byId[it.id] = it }
        val merged = byId.values.sortedWith(compareBy<Message> { it.at }.thenBy { it.id })
        return copy(
            messages = messages + (threadId to merged),
            hasMore = page.hasMore?.let { hasMore + (threadId to it) } ?: hasMore,
        )
    }

    fun versions(message: Message, threadId: String): List<Message> {
        if (message.role != Message.Role.USER || message.kind != Message.Kind.TEXT) return emptyList()
        return transcript(threadId)
            .filter {
                it.role == Message.Role.USER && it.kind == Message.Kind.TEXT && it.parentId == message.parentId
            }
            .sortedWith(compareBy<Message> { it.at }.thenBy { it.id })
    }

    fun apply(streamFrame: StreamFrame): CompanionState = apply(streamFrame.frame)

    fun apply(frame: Frame): CompanionState = when (frame) {
        is Frame.Hello -> this

        is Frame.Message -> {
            var result = copy(
                messages = append(messages, frame.threadId, frame.message),
                bots = bots.map {
                    if (it.threadId == frame.threadId) it.copy(activeLeafId = frame.message.id) else it
                },
            )
            if (frame.message.role == Message.Role.BOT && frame.message.kind == Message.Kind.TEXT) {
                result = result.clearStream(frame.threadId)
            }
            result
        }

        is Frame.MessagePatch -> {
            val existing = transcript(frame.threadId)
            val index = existing.indexOfFirst { it.id == frame.message.id }
            val patched = if (index >= 0) {
                existing.toMutableList().also { it[index] = frame.message }
            } else {
                append(messages, frame.threadId, frame.message).getValue(frame.threadId)
            }
            copy(messages = messages + (frame.threadId to patched))
        }

        is Frame.Thread -> copy(
            bots = bots.map {
                if (it.threadId == frame.threadId) it.copy(activeLeafId = frame.activeLeafId) else it
            },
        ).clearStream(frame.threadId)

        is Frame.Bot -> applyBot(frame.bot)
        is Frame.BotDeleted -> deleteBot(frame.botId)
        is Frame.Room -> applyRoom(frame.room)
        is Frame.RoomDeleted -> deleteRoom(frame.groupId)

        is Frame.Notify -> copy(notifications = (notifications + frame.notification).takeLast(100))
        is Frame.Runtime -> applyRuntime(frame.event)
        is Frame.Screen -> copy(screens = screens + (frame.botId to ScreenFrame(frame.png, frame.mime)))

        is Frame.Computer, Frame.Config, is Frame.Unknown -> this
    }

    fun clearScreen(botId: String): CompanionState = copy(screens = screens - botId)

    fun clearStream(threadId: String): CompanionState = copy(
        streaming = streaming - threadId,
        reasoning = reasoning - threadId,
    )

    fun resetCursor(cursor: String): CompanionState = copy(cursor = cursor)

    fun advance(seq: Int?): CompanionState {
        val current = cursor ?: return this
        if (seq == null || ':' !in current) return this
        return copy(cursor = "${current.substringBefore(':')}:$seq")
    }

    private fun applyBot(bot: Bot): CompanionState {
        val index = bots.indexOfFirst { it.id == bot.id }
        if (index < 0) {
            val nextMessages = if (messages.containsKey(bot.threadId)) {
                messages
            } else {
                messages + (bot.threadId to bot.messages.orEmpty())
            }
            return copy(bots = bots + bot, messages = nextMessages)
        }

        val previous = bots[index]
        if (bot.messages == null) {
            val merged = bot.copy(
                messages = previous.messages,
                activeLeafId = bot.activeLeafId ?: previous.activeLeafId,
            )
            return copy(bots = bots.replacing(index, merged))
        }

        var result = copy(
            bots = bots.replacing(index, bot.copy(messages = bot.messages)),
            messages = messages + (bot.threadId to bot.messages),
            hasMore = hasMore + (bot.threadId to (bot.hasMore ?: false)),
        ).clearStream(previous.threadId)
        if (previous.threadId != bot.threadId) result = result.clearStream(bot.threadId)
        return result
    }

    private fun deleteBot(botId: String): CompanionState {
        val bot = bots.firstOrNull { it.id == botId } ?: return this
        return copy(
            bots = bots.filterNot { it.id == botId },
            messages = messages - bot.threadId,
            hasMore = hasMore - bot.threadId,
            streaming = streaming - bot.threadId,
            reasoning = reasoning - bot.threadId,
            screens = screens - botId,
        )
    }

    private fun applyRoom(room: Room): CompanionState {
        val index = rooms.indexOfFirst { it.id == room.id }
        if (index < 0) {
            val nextMessages = if (messages.containsKey(room.threadId)) {
                messages
            } else {
                messages + (room.threadId to room.messages.orEmpty())
            }
            return copy(rooms = rooms + room, messages = nextMessages)
        }
        return copy(rooms = rooms.replacing(index, room.copy(messages = rooms[index].messages)))
    }

    private fun deleteRoom(groupId: String): CompanionState {
        val room = rooms.firstOrNull { it.id == groupId } ?: return this
        return copy(
            rooms = rooms.filterNot { it.id == groupId },
            messages = messages - room.threadId,
            hasMore = hasMore - room.threadId,
            streaming = streaming - room.threadId,
            reasoning = reasoning - room.threadId,
        )
    }

    private fun applyRuntime(event: RuntimeEvent): CompanionState {
        return when (event.type) {
            "content.delta" -> {
                val delta = event.delta
                if (delta.isNullOrEmpty()) {
                    this
                } else {
                    when (event.streamKind) {
                        "assistant_text" -> copy(
                            streaming = streaming + (event.threadId to (streaming[event.threadId].orEmpty() + delta)),
                        )
                        "reasoning_text" -> copy(
                            reasoning = reasoning + (event.threadId to (reasoning[event.threadId].orEmpty() + delta)),
                        )
                        else -> this
                    }
                }
            }
            "turn.completed", "turn.failed", "turn.aborted" -> clearStream(event.threadId)
            else -> this
        }
    }

    private companion object {
        fun append(
            messages: Map<String, List<Message>>,
            threadId: String,
            message: Message,
        ): Map<String, List<Message>> {
            val thread = messages[threadId].orEmpty()
            val index = thread.indexOfFirst { it.id == message.id }
            val next = if (index >= 0) thread.replacing(index, message) else thread + message
            return messages + (threadId to next)
        }

        fun <T> List<T>.replacing(index: Int, value: T): List<T> =
            toMutableList().also { it[index] = value }
    }
}
