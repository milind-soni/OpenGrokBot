package com.openmausbot.companion.core

/** A chat is a bot or a room. They share a thread, which is what every message is keyed by. */
sealed class Chat {
    abstract val id: String
    abstract val threadId: String
    abstract val name: String
    abstract val subtitle: String
    abstract val unread: Boolean
    abstract val busy: Boolean
    abstract val color: String

    data class BotChat(val bot: Bot) : Chat() {
        override val id: String get() = bot.id
        override val threadId: String get() = bot.threadId
        override val name: String get() = bot.name
        override val subtitle: String get() = bot.title
        override val unread: Boolean get() = bot.unread
        override val busy: Boolean get() = bot.busy == true
        override val color: String get() = bot.color
    }

    data class RoomChat(val room: Room) : Chat() {
        override val id: String get() = room.id
        override val threadId: String get() = room.threadId
        override val name: String get() = room.name
        override val subtitle: String get() = "${room.memberIds.size} bots"
        override val unread: Boolean get() = room.unread
        override val busy: Boolean get() = room.busyBotId != null
        override val color: String get() = "blue"
    }
}

sealed interface ChatTarget {
    val threadId: String

    data class Bot(
        val botId: String,
        override val threadId: String,
    ) : ChatTarget

    data class Room(
        val roomId: String,
        override val threadId: String,
    ) : ChatTarget
}

val Chat.target: ChatTarget
    get() = when (this) {
        is Chat.BotChat -> ChatTarget.Bot(bot.id, threadId)
        is Chat.RoomChat -> ChatTarget.Room(room.id, threadId)
    }

fun CompanionState.chat(target: ChatTarget): Chat? = when (target) {
    is ChatTarget.Bot -> bot(target.botId)?.let(Chat::BotChat)
    is ChatTarget.Room -> rooms.firstOrNull { it.id == target.roomId }?.let(Chat::RoomChat)
}

/**
 * A chat plus the two things a roster row shows that the record itself does not carry:
 * the preview line, and when the thread last moved.
 */
data class ChatSummary(
    val chat: Chat,
    val preview: String,
    val lastActivity: Double,
    val pinned: Boolean,
) {
    val id: String get() = chat.id
}

/**
 * Everything worth showing in the chat list: pinned first, then unread, then most
 * recently active. Hidden bots stay hidden. Rooms never pin.
 */
val CompanionState.chatSummaries: List<ChatSummary>
    get() {
        val chats = bots.filter { it.hidden != true }.map { Chat.BotChat(it) } +
            rooms.map { Chat.RoomChat(it) }
        return chats
            .map { chat ->
                val last = visibleTranscript(chat.threadId).lastOrNull()
                ChatSummary(
                    chat = chat,
                    preview = previewOf(last),
                    lastActivity = last?.at ?: 0.0,
                    pinned = pinned(chat),
                )
            }
            .sortedWith(
                compareByDescending<ChatSummary> { it.pinned }
                    .thenByDescending { it.chat.unread }
                    .thenByDescending { it.lastActivity },
            )
    }

private fun pinned(chat: Chat): Boolean = when (chat) {
    is Chat.BotChat -> chat.bot.pinned == true
    is Chat.RoomChat -> false
}

private fun previewOf(last: Message?): String {
    if (last == null) return ""
    return when (last.kind) {
        Message.Kind.TEXT -> last.text.orEmpty()
        Message.Kind.OPTIONS -> {
            val card = last.card ?: return ""
            if (card.isPending && card.subtitle.isNotEmpty()) card.subtitle else card.title
        }
        Message.Kind.ACTIVITY -> last.tool?.name.orEmpty()
        Message.Kind.SCREEN -> "Screenshot"
        Message.Kind.UNKNOWN -> last.text.orEmpty()
    }
}
